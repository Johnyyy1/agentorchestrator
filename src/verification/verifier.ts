import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { execa } from "execa";
import { assertTaskWorktree } from "../git/worktree.js";
import type { TaskWorktree } from "../git/worktree.js";
import { createVerifierRuntime } from "./runtime.js";
import { workspaceSandboxArgs } from "../workers/codex.js";

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
  await assertTaskWorktree(workspace);
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
    return { success: false, packageManager: null, checks: [{ ...skipped("package.json", ""), skipped: false, success: false, stderr: String(error) }] };
  }

  let packageManager: "npm" | "pnpm" | "yarn" = "npm";
  if (typeof manifest.packageManager === "string") {
    const declared = manifest.packageManager.split("@")[0];
    if (declared !== "npm" && declared !== "pnpm" && declared !== "yarn") {
      return { success: false, packageManager: null, checks: [{ ...skipped("package manager", ""), skipped: false, success: false, stderr: `Unsupported package manager: ${manifest.packageManager}` }] };
    }
    packageManager = declared;
  } else if (await exists(join(workspace.path, "pnpm-lock.yaml"))) packageManager = "pnpm";
  else if (await exists(join(workspace.path, "yarn.lock"))) packageManager = "yarn";

  const checks: VerificationCheck[] = [];
  // Private short HOME/cache/tmp for this verifier only. No host secrets are inherited.
  const ownedRuntime = await createVerifierRuntime();
  const runtime = ownedRuntime.path;
  try {
    for (const name of checkNames) {
      if (typeof manifest.scripts?.[name] !== "string") {
        checks.push(skipped(name, "Script is not defined."));
        continue;
      }
      options.signal?.throwIfAborted();
      const args = ["run", name];
      const started = performance.now();
      try {
        // `codex sandbox` is a local OS sandbox launcher, not an AI invocation.
        const child = execa("codex", [
          "sandbox", "-c", 'sandbox_mode="workspace-write"',
          ...workspaceSandboxArgs,
          "-c", `sandbox_workspace_write.writable_roots=${JSON.stringify([runtime])}`,
          "--allow-unix-socket", runtime,
          "--", packageManager, ...args,
        ], {
          cwd: workspace.path,
          stdin: "ignore",
          reject: false,
          timeout,
          forceKillAfterDelay: 1000,
          maxBuffer: 1024 * 1024,
          detached: process.platform !== "win32",
          ...(options.signal ? { cancelSignal: options.signal } : {}),
          extendEnv: false,
          env: {
            PATH: process.env.PATH ?? "",
            HOME: runtime,
            TMPDIR: runtime,
            TMP: runtime,
            TEMP: runtime,
            CI: "true",
            npm_config_cache: join(runtime, "npm-cache"),
            npm_config_update_notifier: "false",
            npm_config_audit: "false",
            npm_config_fund: "false",
            npm_config_yes: "false",
            COREPACK_ENABLE_NETWORK: "0",
            COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
          },
        });
        let cleanupError: unknown;
        const killGroup = () => {
          if (child.pid && process.platform !== "win32") {
            try { process.kill(-child.pid, "SIGKILL"); }
            catch (error) {
              if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) cleanupError = error;
            }
          }
        };
        // Kill the whole group before awaiting drained stdio: descendants may hold the pipes open.
        const groupTimeout = setTimeout(killGroup, timeout + 1000);
        options.signal?.addEventListener("abort", killGroup, { once: true });
        let result;
        try { result = await child; }
        finally {
          clearTimeout(groupTimeout);
          options.signal?.removeEventListener("abort", killGroup);
          killGroup();
          if (cleanupError) throw cleanupError;
        }
        checks.push({ name, command: [packageManager, ...args].join(" "), success: !result.failed && result.exitCode === 0,
          skipped: false, exitCode: result.exitCode ?? null, stdout: result.stdout.slice(0, outputLimit),
          stderr: result.stderr.slice(0, outputLimit) || (result.failed ? result.shortMessage?.slice(0, outputLimit) ?? "Verification command failed." : ""),
          durationMs: Math.round(performance.now() - started), timedOut: result.timedOut ?? false });
      } catch (error) {
        checks.push({ ...skipped(name, ""), skipped: false, success: false, command: [packageManager, ...args].join(" "),
          stderr: String(error).slice(0, outputLimit), durationMs: Math.round(performance.now() - started) });
      }
    }
  } finally {
    // Only this freshly generated temporary directory is removed; the worktree is preserved.
    await ownedRuntime.cleanup();
  }
  return { success: checks.every(check => check.success), packageManager, checks };
}
