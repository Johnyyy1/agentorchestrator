import { execa } from "execa";
import { realpath } from "node:fs/promises";
import { assertTaskWorktree } from "../git/worktree.js";
import type { TaskWorktree } from "../git/worktree.js";

export const workspaceSandboxArgs = [
  "-c", "sandbox_workspace_write.writable_roots=[]",
  "-c", "sandbox_workspace_write.network_access=false",
  "-c", "sandbox_workspace_write.exclude_slash_tmp=true",
  "-c", "sandbox_workspace_write.exclude_tmpdir_env_var=true",
];

export type CodexExecutionOptions = (
  | { mode?: "read-only"; workspace?: never }
  | { mode: "workspace-write"; workspace: TaskWorktree }
) & { signal?: AbortSignal };

type CodexUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
};

export type CodexResult = {
  success: boolean;
  exitCode: number;
  message: string | null;
  threadId: string | null;
  usage: CodexUsage | null;
  stderr: string;
};

function parseCodexOutput(
  stdout: string,
  exitCode: number,
  stderr: string,
): CodexResult {
  const events = stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  const thread = events.find(
    (event) => event.type === "thread.started",
  );

  const agentMessages = events.filter(
    (event) =>
      event.type === "item.completed" &&
      event.item?.type === "agent_message",
  );

  const completed = events.find(
    (event) => event.type === "turn.completed",
  );

  const lastMessage =
    agentMessages.at(-1)?.item?.text ?? null;

  return {
    success: exitCode === 0,
    exitCode,
    message: lastMessage,
    threadId: thread?.thread_id ?? null,
    usage: completed?.usage
      ? {
          inputTokens:
            completed.usage.input_tokens ?? 0,
          cachedInputTokens:
            completed.usage.cached_input_tokens ?? 0,
          outputTokens:
            completed.usage.output_tokens ?? 0,
        }
      : null,
    stderr,
  };
}

export async function runCodex(
  prompt: string,
  cwd: string,
  options: CodexExecutionOptions = {},
): Promise<CodexResult> {
  if (options.mode === "workspace-write") {
    await assertTaskWorktree(options.workspace);
    if (await realpath(cwd) !== options.workspace.path) {
      throw new Error("Codex workspace-write requires the isolated task worktree as cwd.");
    }
  }
  const result = await execa(
    "codex",
    [
      "exec",
      "--json",
      "--sandbox",
      options.mode ?? "read-only",
      ...(options.mode === "workspace-write" ? [
        "--ignore-user-config",
        "--ignore-rules",
        "-c", 'approval_policy="never"',
        ...workspaceSandboxArgs,
      ] : []),
      "--skip-git-repo-check",
      "--",
      prompt,
    ],
    {
      cwd,
      reject: false,
      stdin: "ignore",
      timeout: 90_000,
      ...(options.signal ? { cancelSignal: options.signal } : {}),
    },
  );

  const cleanStderr = result.stderr
    .replace("Reading additional input from stdin...", "")
    .trim();

  return parseCodexOutput(
    result.stdout,
    result.exitCode ?? 1,
    cleanStderr,
  );
}
