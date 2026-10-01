import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { boundedProcess } from "../local/bounded-process.js";
import { assertTaskWorktree } from "../git/worktree.js";
import type { TaskWorktree } from "../git/worktree.js";
import { createVerifierRuntime } from "./runtime.js";
import { verifierSandboxCommand, verifierEnvironment, runtimeProbe, checkLauncher } from "./launcher.js";
import { loopbackGuard, loopbackGuardFilename } from "./loopback-guard.js";
import { infrastructureFailure } from "./infrastructure.js";
import type { VerifierInfrastructureFailure } from "./infrastructure.js";

export type VerificationCheck = {
  name: string;
  command: string | null;
  success: boolean;
  skipped: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
};

export type VerificationResult = {
  success: boolean;
  failureKind?: "verification" | "infrastructure" | null;
  infrastructureFailure?: VerifierInfrastructureFailure;
  packageManager: "npm" | "pnpm" | "yarn" | null;
  checks: VerificationCheck[];
};

const checkNames = ["test", "typecheck", "lint", "build"] as const;
const outputLimit = 64_000;

function skipped(name: string, reason: string): VerificationCheck {
  return { name, command: null, success: true, skipped: true, exitCode: null, stdout: "", stderr: reason, durationMs: 0, timedOut: false };
}

async function exists(path: string): Promise<boolean> {
  return readFile(path).then(() => true, (error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  });
}

export async function verifyWorktree(workspace: TaskWorktree, options: {
  timeoutMs?: number;
  signal?: AbortSignal;
} = {}): Promise<VerificationResult> {
  try { await assertTaskWorktree(workspace); }
  catch { return infrastructureFailure("setup", "Verifier worktree validation failed; inspect retained workspace."); }
  const timeout = options.timeoutMs ?? 60_000;
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 60_000) {
    throw new Error("Verification timeout must be between 1 and 60000 milliseconds.");
  }
  let manifest: { scripts?: Record<string, unknown>; packageManager?: unknown };
  try {
    manifest = JSON.parse(await readFile(join(workspace.path, "package.json"), "utf8"));
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("package.json must contain an object.");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { success: true, packageManager: null, checks: checkNames.map(name => skipped(name, "No package.json; script discovery skipped.")) };
    }
    return { success: false, failureKind: "verification", packageManager: null, checks: [{ ...skipped("package.json", ""), skipped: false, success: false, stderr: String(error) }] };
  }

  let packageManager: "npm" | "pnpm" | "yarn" = "npm";
  if (typeof manifest.packageManager === "string") {
    const declared = manifest.packageManager.split("@")[0];
    if (declared !== "npm" && declared !== "pnpm" && declared !== "yarn") {
      return { success: false, failureKind: "verification", packageManager: null, checks: [{ ...skipped("package manager", ""), skipped: false, success: false, stderr: `Unsupported package manager: ${manifest.packageManager}` }] };
    }
    packageManager = declared;
  } else if (await exists(join(workspace.path, "pnpm-lock.yaml"))) packageManager = "pnpm";
  else if (await exists(join(workspace.path, "yarn.lock"))) packageManager = "yarn";

  const checks: VerificationCheck[] = [];
  let ownedRuntime: Awaited<ReturnType<typeof createVerifierRuntime>>;
  try { ownedRuntime = await createVerifierRuntime(); }
  catch { return infrastructureFailure("setup", "Verifier private temporary runtime could not be created."); }
  const runtime = ownedRuntime.path;
  let failure: VerificationResult | undefined;
  const launch = (command: string[], timeoutMs: number) => {
    const sandbox = verifierSandboxCommand(workspace.path, runtime, command);
    return boundedProcess(sandbox.binary, sandbox.args, { cwd: workspace.path, env: verifierEnvironment(runtime),
      timeoutMs, ...(options.signal ? { signal: options.signal } : {}) });
  };
  // Only these known verifier-owned operations can signal an infrastructure error.
  const readBoundary = async (path: string): Promise<{ ready?: boolean; started?: boolean; stage?: VerifierInfrastructureFailure["stage"]; message?: string }> => {
    try {
      const value = JSON.parse(await readFile(path, "utf8"));
      if (!value || typeof value !== "object") return {};
      return { ready: value.ready === true, started: value.started === true,
        ...(["setup", "sandbox", "launcher"].includes(value.stage) && typeof value.message === "string"
          ? { stage: value.stage, message: value.message.slice(0, 500) } : {}) };
    } catch { return {}; }
  };
  try {
    await writeFile(join(runtime, loopbackGuardFilename), loopbackGuard, { mode: 0o400, flag: "wx" });
    if (checkNames.some(name => typeof manifest.scripts?.[name] === "string")) {
      const path = join(runtime, "preflight.json");
      const probe = await launch([process.execPath, "-e", runtimeProbe, path], Math.min(timeout, 5000));
      const boundary = await readBoundary(path);
      if (probe.failed || !boundary.ready) failure = infrastructureFailure(boundary.stage ?? "sandbox",
        boundary.message ?? "Verifier sandbox/startup probe could not execute correctly.");
    }
    for (const name of checkNames) {
      if (failure) break;
      if (typeof manifest.scripts?.[name] !== "string") {
        checks.push(skipped(name, "Script is not defined."));
        continue;
      }
      options.signal?.throwIfAborted();
      const args = ["run", name];
      const started = performance.now();
      const path = join(runtime, `${name}-launcher.json`);
      try {
        const result = await launch([process.execPath, "-e", checkLauncher, path, packageManager, ...args], timeout);
        const boundary = await readBoundary(path);
        if (!boundary.started) {
          failure = infrastructureFailure(boundary.stage ?? "launcher",
            boundary.message ?? "Verifier check launcher could not execute the requested check.");
          break;
        }
        checks.push({ name, command: [packageManager, ...args].join(" "), success: !result.failed && result.exitCode === 0,
          skipped: false, exitCode: result.exitCode ?? null, stdout: result.stdout.slice(0, outputLimit),
          stderr: result.stderr.slice(0, outputLimit) || (result.failed ? result.shortMessage?.slice(0, outputLimit) ?? "Verification command failed." : ""),
          durationMs: Math.round(performance.now() - started), timedOut: result.timedOut ?? false });
      } catch {
        failure = infrastructureFailure("launcher", "Verifier process execution or process-group cleanup failed.");
      }
    }
  } catch {
    failure = infrastructureFailure("setup", "Verifier sandbox/runtime setup failed before checks could execute.");
  } finally {
    try { await ownedRuntime.cleanup(); }
    catch { failure = infrastructureFailure("cleanup", "Verifier private runtime cleanup failed; retained worktree is preserved."); }
  }
  options.signal?.throwIfAborted();
  if (failure) return { ...failure, packageManager, checks: [...checks, ...failure.checks] };
  const success = checks.every(check => check.success);
  return { success, failureKind: success ? null : "verification", packageManager, checks };
}
