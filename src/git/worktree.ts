import { lstat, mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { execa } from "execa";
import type { TaskSpec } from "../workers/types.js";

export type TaskWorktree = {
  taskId: string;
  repositoryPath: string;
  path: string;
  branch: string;
  baseBranch: string;
  baseCommit: string;
};

export type WorktreeInspection = {
  statusShort: string;
  changedFiles: string[];
  diffStat: string;
  dirty: boolean;
  truncated: boolean;
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function taskBranch(taskId: string): string {
  if (!uuidPattern.test(taskId)) throw new Error("Worktree task ID must be a lowercase UUID.");
  return `jonas-os/task-${taskId}`;
}

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

// Resolve symlinked ancestors even when the controlled directory does not exist yet.
async function canonicalPath(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await canonicalPath(parent), relative(parent, path));
  }
}

async function worktreeRoot(): Promise<string> {
  const configured = process.env.JONAS_OS_WORKTREE_DIR ?? join(homedir(), ".jonas-os", "worktrees");
  if (!isAbsolute(configured)) throw new Error("JONAS_OS_WORKTREE_DIR must be an absolute path.");
  return canonicalPath(resolve(configured));
}

async function git(cwd: string, args: string[]) {
  // Do not inherit GIT_DIR/GIT_WORK_TREE or run checkout hooks from the source repository.
  return execa("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], {
    cwd,
    stdin: "ignore",
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
    extendEnv: false,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: homedir(),
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  });
}

async function repositoryRoot(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error("Repository path must be absolute.");
  const source = await realpath(path);
  if (!(await lstat(source)).isDirectory()) throw new Error(`Repository is not a directory: ${path}`);
  const { stdout } = await git(source, ["rev-parse", "--show-toplevel"]);
  const root = await realpath(stdout);
  if (source !== root) throw new Error("Repository path must point to its working tree root.");
  return root;
}

export async function createTaskWorktree(
  repository: NonNullable<TaskSpec["repository"]>,
  taskId: string,
): Promise<TaskWorktree> {
  const branch = taskBranch(taskId);
  const repositoryPath = await repositoryRoot(repository.path);
  const baseBranch = repository.baseBranch ?? "main";
  await git(repositoryPath, ["check-ref-format", `refs/heads/${baseBranch}`]);
  await git(repositoryPath, ["show-ref", "--verify", `refs/heads/${baseBranch}`]).catch((cause: unknown) => {
    throw new Error(`Base branch ${baseBranch} does not exist in ${repositoryPath}.`, { cause });
  });
  const filters = await git(repositoryPath, ["config", "--includes", "--get-regexp", "^filter\\..*\\.(clean|smudge|process)$"])
    .then(result => result.stdout, () => "");
  if (filters) throw new Error("Repositories with external Git clean/smudge/process filters are not supported for safe task checkout.");
  if ((await git(repositoryPath, ["status", "--porcelain", "--untracked-files=normal"])).stdout) {
    throw new Error("Source repository is dirty. Commit or stash its changes explicitly before creating a task worktree.");
  }
  const root = await worktreeRoot();
  const registered = (await git(repositoryPath, ["worktree", "list", "--porcelain", "-z"])).stdout.split("\0");
  if (registered.some(field => field.startsWith("worktree ") && inside(field.slice(9), root))) {
    throw new Error("Jonas OS worktrees must be outside every working tree of the source repository.");
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  const path = join(root, taskId);
  try {
    await lstat(path);
    throw new Error(`Worktree path already exists; retained work must be inspected first: ${path}`);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const existing = await git(repositoryPath, ["show-ref", "--verify", `refs/heads/${branch}`]).then(() => true, () => false);
  if (existing) throw new Error(`Task branch already exists; refusing to overwrite it: ${branch}`);
  const baseCommit = (await git(repositoryPath, ["rev-parse", "--verify", `refs/heads/${baseBranch}^{commit}`])).stdout;
  const workspace = { taskId, repositoryPath, path, branch, baseBranch, baseCommit };
  await git(repositoryPath, ["worktree", "add", "-b", branch, "--", path, baseCommit]).catch((cause: unknown) => {
    throw new Error(`Could not create task worktree ${path} on ${branch}; any partial workspace is retained.`, { cause });
  });
  await assertTaskWorktree(workspace);
  return workspace;
}

export async function assertTaskWorktree(workspace: TaskWorktree): Promise<void> {
  const branch = taskBranch(workspace.taskId);
  const root = await worktreeRoot();
  const expected = join(root, workspace.taskId);
  if (workspace.branch !== branch || workspace.path !== expected) {
    throw new Error("Worktree path/branch does not match the controlled Jonas OS task workspace.");
  }
  if ((await lstat(expected)).isSymbolicLink() || await realpath(expected) !== expected) {
    throw new Error("Refusing a symlinked task worktree.");
  }
  const source = await repositoryRoot(workspace.repositoryPath);
  if (inside(source, expected)) throw new Error("Task worktree cannot be inside the source repository.");
  const entries = (await git(source, ["worktree", "list", "--porcelain", "-z"])).stdout.split("\0\0");
  if (entries.some(entry => entry.split("\0").some(field =>
    field.startsWith("worktree ") && field.slice(9) !== expected && inside(field.slice(9), expected)))) {
    throw new Error("Task workspace cannot be nested in another checkout of the source repository.");
  }
  if (!entries.some(entry => {
    const fields = entry.split("\0");
    return fields.includes(`worktree ${expected}`) && fields.includes(`branch refs/heads/${branch}`);
  })) throw new Error("Task path is not registered with the expected Git repository and branch.");
  const gitFile = await lstat(join(expected, ".git"));
  if (!gitFile.isFile() || gitFile.isSymbolicLink()) throw new Error("Task workspace must be a linked Git worktree.");
  if (await realpath((await git(expected, ["rev-parse", "--show-toplevel"])).stdout) !== expected) {
    throw new Error("Task workspace Git root does not match its controlled path.");
  }
  const common = await realpath(resolve(source, (await git(source, ["rev-parse", "--git-common-dir"])).stdout));
  const worktreeCommon = await realpath(resolve(expected, (await git(expected, ["rev-parse", "--git-common-dir"])).stdout));
  if (common !== worktreeCommon) throw new Error("Task workspace belongs to another repository.");
  const gitDir = await realpath((await git(expected, ["rev-parse", "--absolute-git-dir"])).stdout);
  if (!inside(join(common, "worktrees"), gitDir)) throw new Error("Task workspace has an unexpected Git metadata directory.");
}

export async function inspectTaskWorktree(workspace: TaskWorktree): Promise<WorktreeInspection> {
  await assertTaskWorktree(workspace);
  if (!/^[0-9a-f]{40,64}$/.test(workspace.baseCommit)) throw new Error("Invalid workspace base commit.");
  const status = (await git(workspace.path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).stdout;
  const paths = new Set<string>();
  const records = status.split("\0");
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (!record) continue;
    paths.add(record.slice(3));
    if (/[RC]/.test(record.slice(0, 2))) {
      const original = records[++index];
      if (original) paths.add(original);
    }
  }
  const tracked = (await git(workspace.path, ["diff", "--no-ext-diff", "--no-textconv", "--name-only", "-z", workspace.baseCommit, "--"])).stdout;
  for (const path of tracked.split("\0")) if (path) paths.add(path);
  const statusShort = (await git(workspace.path, ["status", "--short", "--untracked-files=all"])).stdout;
  const diffStat = (await git(workspace.path, ["diff", "--no-ext-diff", "--no-textconv", "--stat", workspace.baseCommit, "--"])).stdout;
  return {
    statusShort: statusShort.slice(0, 64_000),
    changedFiles: [...paths].slice(0, 1000),
    diffStat: diffStat.slice(0, 64_000),
    dirty: status.length > 0,
    truncated: statusShort.length > 64_000 || diffStat.length > 64_000 || paths.size > 1000,
  };
}

export async function removeTaskWorktree(workspace: TaskWorktree, options: { force?: boolean } = {}): Promise<void> {
  await assertTaskWorktree(workspace);
  // Dirty work is discarded only when the caller explicitly requests force.
  await git(workspace.repositoryPath, ["worktree", "remove", ...(options.force ? ["--force"] : []), "--", workspace.path]);
  // Keep the branch; removing a workspace never deletes potentially useful commits.
}
