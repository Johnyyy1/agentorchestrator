import { chmod, copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { boundedProcess } from "../local/bounded-process.js";
import { resolveBinary } from "../local/opencode.js";
import type { RepairContext } from "../orchestration/context.js";
import { reviewJsonSchema, reviewSchema } from "./schema.js";
import { reviewSystemPrompt } from "./prompt.js";
import type { ReviewerId } from "./policy.js";

export type ReviewerAvailability = Partial<Record<ReviewerId, { available: boolean; model?: string; reason?: string }>>;
// OS enforcement complements CLI plan/read-only modes. Snapshot mode has no workspace attachment.
export function reviewSandboxProfile(runtime: string, binary: string): string {
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
(allow file-write* (subpath ${JSON.stringify(runtime)}) (literal "/dev/null"))
(allow process-exec (literal ${JSON.stringify(binary)}))`;
}
export async function createReviewRuntime(reviewer: ReviewerId): Promise<string> {
  const runtime = await realpath(await mkdtemp(join(tmpdir(), "jonas-review-")));
  try {
    const relative = reviewer === "codex" ? ".codex/auth.json" : ".gemini/jetski-standalone-oauth-token";
    const credential = join(runtime, relative);
    await mkdir(join(runtime, reviewer === "codex" ? ".codex" : ".gemini"), { mode: 0o700 });
    const source = reviewer === "codex" && process.env.CODEX_HOME
      ? join(process.env.CODEX_HOME, "auth.json") : join(homedir(), relative);
    await copyFile(source, credential).catch((error: unknown) => {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    });
    await chmod(credential, 0o600).catch((error: unknown) => {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    });
    if (reviewer === "antigravity") {
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
async function availableReviewer(reviewer: ReviewerId): Promise<boolean> {
  const binary = await resolveBinary(reviewer === "codex" ? "codex" : "agy");
  if (!binary) return false;
  let runtime: string | undefined;
  try {
    runtime = await createReviewRuntime(reviewer);
    const result = await boundedProcess("/usr/bin/sandbox-exec", ["-p", reviewSandboxProfile(runtime, binary), binary,
      ...(reviewer === "codex" ? ["exec", "--help"] : ["--help"])], { cwd: runtime, env: reviewEnvironment(runtime), timeoutMs: 5000 });
    if (result.failed) return false;
    const help = `${result.stdout}\n${result.stderr}`;
    return (reviewer === "codex" ? ["--json", "--sandbox", "--ignore-user-config", "--ignore-rules"]
      : ["--json-schema", "--mode", "--sandbox", "--disable-slash-commands"]).every(flag => help.includes(flag));
  } catch { return false; }
  finally { if (runtime) await rm(runtime, { recursive: true, force: true }); }
}
export async function reviewerAvailability(): Promise<ReviewerAvailability> {
  if (process.platform !== "darwin" || !await resolveBinary("/usr/bin/sandbox-exec")) return {};
  const [agy, codex] = await Promise.all([availableReviewer("antigravity"), availableReviewer("codex")]);
  return { antigravity: { available: !!agy, ...(process.env.AGY_PRO_MODEL ? { model: process.env.AGY_PRO_MODEL } : {}) },
    codex: { available: !!codex } };
}
export function parseReviewOutput(stdout: string, reviewer: ReviewerId) {
  if (stdout.length > 128000) throw new Error("Reviewer output is too large.");
  let value: unknown;
  if (reviewer === "codex") {
    const events: Array<{ type?: string; item?: { type?: string; text?: string } }> = stdout.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    const message = events.filter(e => e.type === "item.completed" && e.item?.type === "agent_message").at(-1)?.item?.text;
    if (!events.some(e => e.type === "turn.completed") || !message) throw new Error("Review did not finish.");
    value = JSON.parse(message);
  } else {
    const envelope = JSON.parse(stdout);
    if (!envelope || envelope.is_error === true || envelope.error) throw new Error("Reviewer reported an error.");
    // AGY print json uses structured_output or result. Do not persist the envelope/reasoning.
    value = envelope.structured_output ?? envelope.result ?? envelope;
    if (typeof value === "string") value = JSON.parse(value);
  }
  return reviewSchema.parse(value);
}
export async function runReview(reviewer: ReviewerId, context: RepairContext, signal: AbortSignal) {
  signal.throwIfAborted();
  if (process.platform !== "darwin") throw new Error("Read-only reviewer OS boundary requires macOS.");
  const binary = await resolveBinary(reviewer === "codex" ? "codex" : "agy");
  if (!binary) throw new Error("Reviewer binary unavailable.");
  const runtime = await createReviewRuntime(reviewer);
  try {
    const prompt = `${reviewSystemPrompt}\n\nREVIEW SCHEMA\n${JSON.stringify(reviewJsonSchema)}\n\nTASK DATA\n${JSON.stringify(context)}`;
    const args = reviewer === "codex"
      ? ["exec", "--json", "--sandbox", "read-only", "--ignore-user-config", "--ignore-rules", "-c", 'approval_policy="never"',
          "--skip-git-repo-check", "--", prompt]
      : ["-p", prompt, "--mode", "plan", "--sandbox", "--disable-slash-commands", "--output-format", "json",
          "--json-schema", JSON.stringify(reviewJsonSchema), "--log-file", join(runtime, "review.log"), "--print-timeout", "2m",
          ...(process.env.AGY_PRO_MODEL ? ["--model", process.env.AGY_PRO_MODEL] : [])];
    const output = await boundedProcess("/usr/bin/sandbox-exec", ["-p", reviewSandboxProfile(runtime, binary), binary, ...args], {
      cwd: runtime, timeoutMs: reviewer === "codex" ? 90000 : 120000, signal,
      // Only a private auth copy is provided; global/project configuration and MCP are absent.
      env: reviewEnvironment(runtime),
    });
    if (output.failed || output.exitCode !== 0) throw new Error("Read-only review invocation failed; inspect provider readiness/configuration.");
    return parseReviewOutput(output.stdout, reviewer);
  } finally { await rm(runtime, { recursive: true, force: true }); }
}
