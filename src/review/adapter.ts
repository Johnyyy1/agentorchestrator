import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { boundedProcess } from "../local/bounded-process.js";
import { resolveBinary } from "../local/opencode.js";
import type { RepairContext } from "../orchestration/context.js";
import { reviewJsonSchema, antigravityReviewJsonSchema } from "./schema.js";
import { initialDiagnostics, parsePublicReview, normalizeReviewProcess, ReviewFailure, type ReviewDiagnostics } from "./diagnostics.js";
import { reviewSystemPrompt } from "./prompt.js";
import type { ReviewerId } from "./policy.js";

export type ReviewerAvailability = Partial<Record<ReviewerId, { available: boolean; model?: string; reason?: string }>>;
// OS enforcement complements CLI plan/read-only modes. Snapshot mode has no workspace attachment.
export function reviewSandboxProfile(runtime: string, binary: string, reviewer?: ReviewerId): string {
  const roots = [runtime, "/System", "/usr", "/bin", "/sbin", "/private/etc", "/private/var/db/timezone", "/dev", "/Library/Apple", "/opt/homebrew"];
  return `(version 1)
(deny default)
(allow process-fork)
(allow process-info*)
(allow sysctl-read)
(allow mach-lookup)
(allow file-read-metadata)
(allow file-read* (literal "/") (literal ${JSON.stringify(binary)}) ${roots.map(path => `(subpath ${JSON.stringify(path)})`).join(" ")})
(allow network-outbound)
${reviewer === "antigravity" ? '(allow network-inbound (local ip "localhost:*"))' : ""}
(allow file-write* (subpath ${JSON.stringify(runtime)}) (literal "/dev/null"))
${reviewer === "antigravity" ? `(deny file-write* (literal ${JSON.stringify(join(runtime, ".gemini/antigravity-cli/antigravity-oauth-token"))}))` : ""}
(allow process-exec (literal ${JSON.stringify(binary)}))`;
}
// CLI 1.2.14 stores its consumer OAuth record under this exact Keychain identity.
// Only the host adapter reads it; security, user HOME and Keychain stay outside the reviewer boundary.
async function loadAntigravityAuth(): Promise<string | undefined> {
  let serialized: string | undefined;
  if (process.platform === "darwin") {
    const output = await boundedProcess("/usr/bin/security", ["find-generic-password", "-s", "gemini", "-a", "antigravity", "-w"], {
      cwd: homedir(), env: { PATH: "/usr/bin:/bin", HOME: homedir() }, timeoutMs: 5000,
    });
    if (!output.failed && output.exitCode === 0) {
      const stored = output.stdout.trim();
      if (stored.length > 32000) throw new Error("Reviewer authentication record is too large.");
      serialized = stored.startsWith("go-keyring-base64:")
        ? Buffer.from(stored.slice("go-keyring-base64:".length), "base64").toString("utf8") : stored;
    } else if (output.exitCode !== 44) throw new Error("Reviewer Keychain authentication is unavailable.");
  }
  serialized ??= await readFile(join(homedir(), ".gemini/antigravity-cli/antigravity-oauth-token"), "utf8").catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw new Error("Reviewer authentication file is unavailable.");
  });
  return serialized;
}
async function copyAntigravityAuth(runtime: string, load: () => Promise<string | undefined>): Promise<void> {
  const serialized = await load();
  if (!serialized) return;
  if (serialized.length > 32000) throw new Error("Reviewer authentication record is too large.");
  let record;
  try { record = JSON.parse(serialized); } catch { throw new Error("Reviewer authentication record is invalid."); }
  if (!record || record.auth_method !== "consumer" || !record.token || typeof record.token.access_token !== "string"
    || typeof record.token.refresh_token !== "string" || typeof record.id_token !== "string") {
    throw new Error("Reviewer requires a supported consumer OAuth record.");
  }
  const token = Object.fromEntries(["access_token", "refresh_token", "token_type", "expiry"]
    .filter(key => typeof record.token[key] === "string").map(key => [key, record.token[key]]));
  await writeFile(join(runtime, ".gemini/antigravity-cli/antigravity-oauth-token"),
    JSON.stringify({ token, auth_method: "consumer", id_token: record.id_token }), { mode: 0o600 });
}
export async function createReviewRuntime(reviewer: ReviewerId, options: { antigravityAuth?: () => Promise<string | undefined> } = {}): Promise<string> {
  const runtime = await realpath(await mkdtemp(join(tmpdir(), "jonas-review-")));
  try {
    const relative = ".codex/auth.json";
    const credential = join(runtime, relative);
    await mkdir(join(runtime, reviewer === "codex" ? ".codex" : ".gemini"), { mode: 0o700 });
    const source = process.env.CODEX_HOME
      ? join(process.env.CODEX_HOME, "auth.json") : join(homedir(), relative);
    if (reviewer === "codex") await copyFile(source, credential).catch((error: unknown) => {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    });
    if (reviewer === "codex") await chmod(credential, 0o600).catch((error: unknown) => {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    });
    if (reviewer === "antigravity") {
      await mkdir(join(runtime, ".gemini/antigravity-cli"), { mode: 0o700 });
      await copyAntigravityAuth(runtime, options.antigravityAuth ?? loadAntigravityAuth);
      await mkdir(join(runtime, ".gemini/config"), { mode: 0o700 });
      await writeFile(join(runtime, ".gemini/config/config.json"), "{}", { mode: 0o600 });
      await writeFile(join(runtime, ".gemini/config/mcp_config.json"), '{"mcpServers":{}}', { mode: 0o600 });
    }
    return runtime;
  } catch (error) { await rm(runtime, { recursive: true, force: true }); throw error; }
}
export function reviewEnvironment(runtime: string): Record<string, string> {
  return { PATH: process.env.PATH ?? "", HOME: runtime, CODEX_HOME: join(runtime, ".codex"),
    TMPDIR: runtime, TMP: runtime, TEMP: runtime, CI: "true", NO_COLOR: "1" };
}
async function availableReviewer(reviewer: ReviewerId, runtimeFactory: typeof createReviewRuntime): Promise<boolean> {
  const binary = await resolveBinary(reviewer === "codex" ? "codex" : "agy");
  if (!binary) return false;
  let runtime: string | undefined;
  try {
    runtime = await runtimeFactory(reviewer);
    const result = await boundedProcess("/usr/bin/sandbox-exec", ["-p", reviewSandboxProfile(runtime, binary, reviewer), binary,
      ...(reviewer === "codex" ? ["exec", "--help"] : ["--help"])], { cwd: runtime, env: reviewEnvironment(runtime), timeoutMs: 5000 });
    if (result.failed) return false;
    const help = `${result.stdout}\n${result.stderr}`;
    return (reviewer === "codex" ? ["--json", "--sandbox", "--ignore-user-config", "--ignore-rules"]
      : ["--json-schema", "--mode", "--sandbox", "--disable-slash-commands"]).every(flag => help.includes(flag));
  } catch { return false; }
  finally { if (runtime) await rm(runtime, { recursive: true, force: true }); }
}
export async function reviewerAvailability(runtimeFactory = createReviewRuntime): Promise<ReviewerAvailability> {
  if (process.platform !== "darwin" || !await resolveBinary("/usr/bin/sandbox-exec")) return {};
  const [agy, codex] = await Promise.all([availableReviewer("antigravity", runtimeFactory), availableReviewer("codex", runtimeFactory)]);
  return { antigravity: { available: !!agy, ...(process.env.AGY_PRO_MODEL ? { model: process.env.AGY_PRO_MODEL } : {}) },
    codex: { available: !!codex } };
}
export function parseReviewOutput(stdout: string, reviewer: ReviewerId) {
  return parsePublicReview(stdout, reviewer, initialDiagnostics(null, reviewer));
}
export { antigravityReviewJsonSchema } from "./schema.js";
export async function runReview(reviewer: ReviewerId, context: RepairContext, signal: AbortSignal, options: { onDiagnostics?: (diagnostics: ReviewDiagnostics) => void; timeoutMs?: number; runtimeFactory?: typeof createReviewRuntime } = {}) {
  signal.throwIfAborted();
  const started = Date.now();
  const diagnostics = initialDiagnostics(null, reviewer);
  let runtime: string | undefined;
  try {
    if (process.platform !== "darwin") throw new Error("Read-only reviewer OS boundary requires macOS.");
    const binary = await resolveBinary(reviewer === "codex" ? "codex" : "agy");
    if (!binary) throw new Error("Reviewer binary unavailable.");
    diagnostics.executable = binary;
    if (context.omitted || JSON.stringify(context).length > 32000) {
      diagnostics.failureKind = "result";
      throw new ReviewFailure(diagnostics, "snapshot incomplete or oversized");
    }
    const timeoutMs = options.timeoutMs ?? (reviewer === "codex" ? 90000 : 120000);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > (reviewer === "codex" ? 90000 : 120000)) {
      throw new Error("Reviewer timeout is invalid.");
    }
    runtime = await (options.runtimeFactory ?? createReviewRuntime)(reviewer);
    const prompt = `${reviewSystemPrompt}\n\nREVIEW SCHEMA\n${JSON.stringify(reviewJsonSchema)}\n\nTASK DATA\n${JSON.stringify(context)}`;
    const args = reviewer === "codex"
      ? ["exec", "--json", "--sandbox", "read-only", "--ignore-user-config", "--ignore-rules", "-c", 'approval_policy="never"',
          "--skip-git-repo-check", "--", prompt]
      : ["-p", prompt, "--mode", "plan", "--sandbox", "--disable-slash-commands", "--output-format", "json",
          "--json-schema", JSON.stringify(antigravityReviewJsonSchema), "--log-file", join(runtime, "review.log"), "--print-timeout", "2m",
          ...(process.env.AGY_PRO_MODEL ? ["--model", process.env.AGY_PRO_MODEL] : [])];
    const output = await boundedProcess("/usr/bin/sandbox-exec", ["-p", reviewSandboxProfile(runtime, binary, reviewer), binary, ...args], {
      cwd: runtime, timeoutMs, signal,
      // Only a private auth copy is provided; global/project configuration and MCP are absent.
      env: reviewEnvironment(runtime),
    });
    return normalizeReviewProcess(output, reviewer, diagnostics, Date.now() - started);
  } catch (error) {
    if (error instanceof ReviewFailure) throw error;
    diagnostics.failureKind = "infrastructure";
    throw new ReviewFailure(diagnostics, !diagnostics.executable ? "executable or OS boundary unavailable" : !runtime ? "private authentication/runtime setup failed" : "process startup or cleanup failed");
  } finally {
    diagnostics.durationMs = Date.now() - started;
    try { if (runtime) await rm(runtime, { recursive: true, force: true }); }
    catch { diagnostics.failureKind = "infrastructure"; throw new ReviewFailure(diagnostics, "private runtime cleanup failed"); }
    finally { options.onDiagnostics?.({ ...diagnostics }); }
  }
}
