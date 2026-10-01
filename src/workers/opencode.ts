import { realpath, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { execa } from "execa";
import { assertTaskWorktree } from "../git/worktree.js";
import type { TaskWorktree } from "../git/worktree.js";
import { boundedProcess } from "../local/bounded-process.js";
import { createOpenCodeRuntime, getOpenCodeConfig, inspectOpenCodeInterface, openCodeEnvironment, resolveBinary } from "../local/opencode.js";
import { localAgentName } from "../local/opencode-config.js";
import { openCodeSandboxProfile } from "../local/opencode-sandbox.js";

export type OpenCodeResult = {
  success: boolean; exitCode: number; message: string | null; sessionId: string | null;
  model: string; usage: { inputTokens?: number; outputTokens?: number; reasoningTokens?: number } | null;
  durationMs: number; stderr: string; error: string | null; timedOut: boolean;
  eventTypes?: Record<string, number>;
};
export function normalizedStderr(stderr: string): string {
  return stderr.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").trim().slice(0, 64000);
}

// Keep only public text parts and token counts. Diagnostics contain event type
// counts only, never tool payloads, reasoning, or the raw JSONL stream.
export function parseOpenCodeOutput(stdout: string, exitCode: number, model: string,
  durationMs: number, stderr = "", failed = false, timedOut = false): OpenCodeResult {
  let message: string | null = null;
  let sessionId: string | null = null;
  let error: string | null = null;
  let completed = false;
  let usage: OpenCodeResult["usage"] = null;
  const eventTypes: Record<string, number> = Object.create(null);
  const lines = stdout.length <= 2 * 1024 * 1024 ? stdout.split(/\r?\n/) : [];
  if (stdout.length > 2 * 1024 * 1024 || lines.length > 4096) error = "OpenCode JSON event stream exceeds parsing limits.";
  for (const line of error ? [] : lines) {
    if (!line.trim()) continue;
    if (line.length > 256000) { error = "OpenCode JSON event exceeds parsing limits."; break; }
    let event;
    try { event = JSON.parse(line); }
    catch { error = "Malformed OpenCode JSON event stream."; break; }
    if (!event || typeof event !== "object" || Array.isArray(event) || typeof event.type !== "string") {
      error = "Invalid OpenCode event envelope."; break;
    }
    const kind = /^[a-z][a-z0-9_.-]{0,63}$/.test(event.type) ? event.type : "other";
    if (Object.hasOwn(eventTypes, kind) || Object.keys(eventTypes).length < 16) eventTypes[kind] = (eventTypes[kind] ?? 0) + 1;
    if (typeof event.sessionID === "string") sessionId = event.sessionID.slice(0, 256);
    if (event.type === "step_start") { completed = false; message = null; }
    if (event.type === "text" && (event.part?.type === undefined || event.part.type === "text") &&
        typeof event.part?.text === "string" && event.part.text.trim()) {
      message = (message ? `${message}\n${event.part.text}` : event.part.text).slice(0, 64000);
    }
    if (event.type === "error") error = "OpenCode reported a session error.";
    if (event.type === "incomplete" || event.type === "abort" || event.type === "aborted") error = "OpenCode reported an incomplete session.";
    if (event.type === "step_finish") {
      completed = event.part?.reason === "stop";
      if (!completed && event.part?.reason !== "tool-calls") error = "OpenCode reported an incomplete step.";
      const tokens = event.part?.tokens;
      for (const [source, target] of [["input", "inputTokens"], ["output", "outputTokens"], ["reasoning", "reasoningTokens"]] as const) {
        if (typeof tokens?.[source] === "number" && Number.isSafeInteger(tokens[source]) && tokens[source] >= 0) {
          usage ??= {};
          const total = (usage[target] ?? 0) + tokens[source];
          if (!Number.isSafeInteger(total)) { error = "OpenCode token totals exceed parsing limits."; break; }
          usage[target] = total;
        }
      }
    }
  }
  const success = exitCode === 0 && !failed && !timedOut && !error && completed;
  if (!success && !error) error = timedOut ? "OpenCode execution timed out." : "OpenCode did not complete successfully.";
  return { success, exitCode, message, sessionId, model, usage, durationMs,
    stderr: normalizedStderr(stderr), error, timedOut,
    ...(message === null ? { eventTypes } : {}) };
}

// Normal non-TTY output is public text; reasoning is never requested. Without
// structured events, session IDs/token usage are unknown and verification is authoritative.
export function parseOpenCodeText(stdout: string, exitCode: number, model: string,
  durationMs: number, stderr = "", failed = false, timedOut = false): OpenCodeResult {
  const message = normalizedStderr(stdout);
  const success = exitCode === 0 && !failed && !timedOut && stdout.length <= 64000;
  return { success, exitCode, message: message || null, sessionId: null, usage: null, model, durationMs,
    stderr: normalizedStderr(stderr), timedOut,
    error: success ? null : timedOut ? "OpenCode execution timed out." : "OpenCode text execution did not complete successfully." };
}

export async function runOpenCode(prompt: string, cwd: string, options: {
  workspace: TaskWorktree; signal?: AbortSignal;
}): Promise<OpenCodeResult> {
  await assertTaskWorktree(options.workspace);
  if (await realpath(cwd) !== options.workspace.path) throw new Error("OpenCode requires the isolated task worktree as cwd.");
  const started = performance.now();
  const config = getOpenCodeConfig();
  const binary = await resolveBinary(config.binary);
  if (!binary) throw new Error("OpenCode binary disappeared after readiness; execution failed without fallback.");
  if (process.platform !== "darwin") throw new Error("OpenCode requires the validated macOS OS boundary.");
  const runtime = await createOpenCodeRuntime();
  try {
    const cli = await inspectOpenCodeInterface(binary, runtime, config);
    const git = await execa("git", ["-c", "core.hooksPath=/dev/null", "rev-parse", "--git-common-dir"], {
      cwd: options.workspace.path, timeout: 5000, stdin: "ignore", extendEnv: false,
      env: { PATH: process.env.PATH ?? "", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    });
    const gitMetadata = await realpath(resolve(options.workspace.path, git.stdout));
    const result = await boundedProcess("/usr/bin/sandbox-exec", [
      "-p", openCodeSandboxProfile(options.workspace.path, runtime, binary, config.baseUrl, gitMetadata), binary,
      "run", "--model", `ollama/${config.model}`,
      ...(cli.agentFlag ? ["--agent", localAgentName] : []),
      ...(cli.outputFormat === "json" ? ["--format", "json"] : []),
      ...(cli.titleFlag ? ["--title", `Jonas OS task ${options.workspace.taskId}`] : []), "--", prompt,
    ], { cwd: options.workspace.path, env: openCodeEnvironment(runtime, config), timeoutMs: config.timeoutMs,
      ...(options.signal ? { signal: options.signal } : {}) });
    return (cli.outputFormat === "json" ? parseOpenCodeOutput : parseOpenCodeText)(result.stdout, result.exitCode ?? 1, config.model,
      Math.round(performance.now() - started), result.stderr || (result.failed ? `OpenCode process failed (${result.signal ?? result.exitCode ?? "spawn error"}).` : ""), result.failed, result.timedOut ?? false);
  } catch {
    return parseOpenCodeOutput("", 1, config.model, Math.round(performance.now() - started), "Bounded OpenCode subprocess failed.", true);
  } finally { await rm(runtime, { recursive: true, force: true }); }
}
