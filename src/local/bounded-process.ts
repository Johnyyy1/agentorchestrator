import { execa } from "execa";

export async function boundedProcess(binary: string, args: string[], options: {
  cwd: string; env: Record<string, string>; timeoutMs: number; signal?: AbortSignal;
}) {
  options.signal?.throwIfAborted();
  const child = execa(binary, args, {
    cwd: options.cwd, env: options.env, extendEnv: false, stdin: "ignore", reject: false,
    timeout: options.timeoutMs, forceKillAfterDelay: 1000, maxBuffer: 2 * 1024 * 1024,
    detached: process.platform !== "win32",
    ...(options.signal ? { cancelSignal: options.signal } : {}),
  });
  let cleanupError: unknown;
  const killGroup = () => {
    if (child.pid && process.platform !== "win32") {
      try { process.kill(-child.pid, "SIGKILL"); }
      catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) cleanupError = error; }
    }
  };
  const timer = setTimeout(killGroup, options.timeoutMs + 1000);
  options.signal?.addEventListener("abort", killGroup, { once: true });
  try { return await child; }
  finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", killGroup);
    killGroup();
    if (cleanupError) throw cleanupError;
  }
}
