import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { execa } from "execa";
import { eq } from "drizzle-orm";
import { db, pool } from "./db/index.js";
import { runs, tasks } from "./db/schema.js";
import { createTaskWorktree, inspectTaskWorktree, removeTaskWorktree } from "./git/worktree.js";
import type { TaskWorktree } from "./git/worktree.js";
import { boss, startQueue, TASK_QUEUE_NAME } from "./queue/boss.js";
import { registerTaskWorker } from "./queue/task-worker.js";
import { createTask } from "./tasks/create-task.js";
import { taskRowToSpec } from "./tasks/task-spec.js";
import { verifyWorktree } from "./verification/verifier.js";
import { runCodex } from "./workers/codex.js";
import { executeTask } from "./workers/execute.js";
import type { ExecutionResult } from "./workers/execute.js";
import type { TaskSpec } from "./workers/types.js";
import type { runOpenCode } from "./workers/opencode.js";
import type { ProviderAvailability } from "./router/capability-router.js";

const fixture = await realpath(await mkdtemp(join(tmpdir(), "jonas-worktree-test-")));
const repositoryPath = join(fixture, "repository");
const worktreeDirectory = join(fixture, "worktrees");
const queueName = `${TASK_QUEUE_NAME}.test.${randomUUID()}`;
const oldRoot = process.env.JONAS_OS_WORKTREE_DIR;
process.env.JONAS_OS_WORKTREE_DIR = worktreeDirectory;
const workspaces: TaskWorktree[] = [];
const taskIds: string[] = [];
const calls = new Map<string, number>();
let queueCreated = false;
const failures: unknown[] = [];
const deadline = Date.now() + 60_000;
const watchdog = setTimeout(() => {
  console.error("Worktree integration test exceeded its 90-second timeout.");
  process.exit(1);
}, 90_000);

async function git(args: string[]) {
  return execa("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
    cwd: repositoryPath, timeout: 10_000, stdin: "ignore",
  });
}

async function waitForTask(id: string, status: string) {
  while (Date.now() < deadline) {
    const [task] = await db.select().from(tasks).where(eq(tasks.id, id));
    if (task?.status === status) {
      const jobs = await boss.findJobs(queueName, { data: { taskId: id } });
      if (jobs[0]?.state === status) return task;
    }
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${id} to become ${status}. ${JSON.stringify(await db.select().from(runs).where(eq(runs.taskId, id)))}`);
}

function spec(title: string): TaskSpec {
  return { title, objective: "Change value.txt only in an isolated task worktree.", category: "coding", difficulty: 1,
    risk: "low", context: [], acceptanceCriteria: ["All four deterministic checks pass."], maxAttempts: 2,
    repository: { path: repositoryPath } };
}

async function persistedRun(id: string) {
  const rows = await db.select().from(runs).where(eq(runs.taskId, id));
  assert.equal(rows.length, 1);
  const run = rows[0];
  assert.ok(run?.workspace);
  if (!workspaces.some(item => item.path === run.workspace?.path)) workspaces.push(run.workspace);
  return run;
}

const workerCalls: string[] = [];
const fakeCodex: typeof runCodex = async (prompt, cwd, options = {}) => {
  workerCalls.push("codex");
  if (options.mode !== "workspace-write") throw new Error("Repository coding must explicitly request workspace-write.");
  assert.notEqual(cwd, repositoryPath);
  assert.equal(cwd, options.workspace.path);
  assert.equal(await realpath(cwd), cwd);
  calls.set(options.workspace.taskId, (calls.get(options.workspace.taskId) ?? 0) + 1);
  // Workspace information must already be durable before any code is changed.
  const [run] = await db.select().from(runs).where(eq(runs.taskId, options.workspace.taskId));
  assert.equal(run?.status, "running");
  assert.equal(run?.workspace?.path, cwd);
  await writeFile(join(cwd, "value.txt"), prompt.includes("Verification failure fixture") || prompt.includes("OpenCode verification failure") ? "bad" : "ok");
  await writeFile(join(cwd, "new file.txt"), "Temporary worktree-only change.\n");
  return { success: true, exitCode: 0, message: "FAKE_CODEX_OK", threadId: null, usage: null, stderr: "" };
};

const fakeOpenCode: typeof runOpenCode = async (prompt, cwd, options) => {
  workerCalls.push("opencode");
  assert.equal(cwd, options.workspace.path);
  const [run] = await db.select().from(runs).where(eq(runs.taskId, options.workspace.taskId));
  assert.equal(run?.worker, "opencode");
  assert.equal(run?.routing?.requestedCapability, "local-coding");
  assert.equal(run?.workspace?.path, cwd);
  assert.match(prompt, /Inspect existing code/);
  assert.match(prompt, /dynamic brief fixture/);
  calls.set(options.workspace.taskId, (calls.get(options.workspace.taskId) ?? 0) + 1);
  await writeFile(join(cwd, "value.txt"), prompt.includes("OpenCode verification failure") ? "bad" : "ok");
  await writeFile(join(cwd, "new file.txt"), "Temporary worktree-only change.\n");
  if (prompt.includes("OpenCode thrown failure")) throw new Error("FAKE_OPENCODE_THROWN_AFTER_EDIT");
  return { success: !prompt.includes("OpenCode execution failure"), exitCode: prompt.includes("OpenCode execution failure") ? 1 : 0,
    message: "FAKE_OPENCODE_OK", sessionId: "ses_fixture", usage: null, model: "ollama/fixture",
    durationMs: 1, stderr: "", timedOut: false, error: null };
};
const availability: ProviderAvailability = { opencode: { available: true, model: "ollama/fixture" },
  codex: { available: true }, antigravity: { available: true } };

try {
  await mkdir(repositoryPath);
  await execa("git", ["init", "-b", "main", repositoryPath], { timeout: 10_000 });
  await writeFile(join(repositoryPath, "value.txt"), "baseline");
  await writeFile(join(repositoryPath, "verify.cjs"), `const assert = require('node:assert/strict');\nconst fs = require('node:fs');\nassert.equal(fs.readFileSync('value.txt', 'utf8'), 'ok');\nconsole.log(process.argv[2] + ': OK');\n`);
  await writeFile(join(repositoryPath, "package.json"), JSON.stringify({
    name: "jonas-worktree-fixture", version: "1.0.0", scripts: Object.fromEntries(
      ["test", "typecheck", "lint", "build"].map(name => [name, `node verify.cjs ${name}`])),
  }, null, 2));
  await git(["add", "--", "."]);
  // Only this disposable fixture gets a baseline commit; the Jonas OS project is not committed.
  await git(["-c", "user.name=Jonas OS fixture", "-c", "user.email=fixture@localhost", "commit", "-m", "Fixture baseline"]);
  const baseline = (await git(["rev-parse", "HEAD"])).stdout;

  await startQueue(queueName);
  queueCreated = true;
  await registerTaskWorker({ queueName, executor: (task, cwd, options) => executeTask(task, cwd, { ...options,
    codexExecutor: fakeCodex, opencodeExecutor: fakeOpenCode,
    availability: task.title.includes("Unavailable local fallback")
      ? { ...availability, opencode: { available: false, reason: "fixture model unavailable" } } : availability,
  }) });
  for (const [title, expected, worker] of [
    ["Verification success fixture", "completed", "codex"], ["Verification failure fixture", "failed", "codex"],
    ["OpenCode success fixture", "completed", "opencode"], ["OpenCode verification failure", "failed", "opencode"],
    ["OpenCode execution failure", "failed", "opencode"], ["OpenCode thrown failure", "failed", "opencode"],
    ["Unavailable local fallback", "completed", "codex"],
  ] as const) {
    const previousCalls = workerCalls.length;
    const recommended = title.startsWith("OpenCode") || title.startsWith("Unavailable");
    const task = await createTask(spec(title), queueName, recommended ? { capability: "local-coding", workerBrief: "dynamic brief fixture" } : undefined);
    taskIds.push(task.id);
    assert.deepEqual(taskRowToSpec(task).repository, { path: repositoryPath });
    await waitForTask(task.id, expected);
    const run = await persistedRun(task.id);
    const result = run.result as ExecutionResult;
    assert.equal(run.status, expected);
    assert.equal(run.worker, worker);
    assert.deepEqual(workerCalls.slice(previousCalls), [worker], "Never execute a second worker after local execution starts.");
    assert.equal(run.routing?.selectedWorker, worker);
    assert.equal(run.routing?.requestedCapability, recommended ? "local-coding" : null);
    assert.deepEqual(result.routing, run.routing);
    if (title.startsWith("Unavailable")) assert.match(run.routing?.fallbackReason ?? "", /fixture model unavailable/);
    assert.ok(run.finishedAt);
    assert.equal(result.success, expected === "completed");
    if (!title.includes("thrown failure")) assert.equal(result.verification?.success,
      !title.includes("Verification failure") && !title.includes("verification failure"));
    if (!title.includes("thrown failure")) {
      assert.equal(result.verification?.packageManager, "npm");
      assert.deepEqual(result.verification?.checks.map(check => check.name), ["test", "typecheck", "lint", "build"]);
      assert.ok(result.verification?.checks.every(check => !check.skipped));
    }
    assert.equal(result.workspace?.path, run.workspace?.path);
    assert.equal(result.workspace?.repositoryPath, repositoryPath);
    assert.equal(result.workspace?.baseBranch, "main");
    assert.equal(result.workspace?.baseCommit, baseline);
    assert.equal(result.workspace?.branch, `jonas-os/task-${task.id}`);
    assert.equal(result.workspace?.path, join(worktreeDirectory, task.id));
    assert.ok(result.git?.dirty);
    assert.ok(result.git?.changedFiles.includes("value.txt"));
    assert.ok(result.git?.changedFiles.includes("new file.txt"));
    assert.match(result.git?.diffStat ?? "", /value.txt/);
    assert.match(result.git?.statusShort ?? "", /value.txt/);
    assert.equal((await readFile(join(repositoryPath, "value.txt"), "utf8")), "baseline");
    assert.equal((await git(["status", "--short"])).stdout, "");
    assert.equal((await git(["branch", "--show-current"])).stdout, "main");
    assert.equal((await git(["rev-parse", "HEAD"])).stdout, baseline);
    await git(["show-ref", "--verify", `refs/heads/jonas-os/task-${task.id}`]);
    assert.ok((await lstat(result.workspace!.path)).isDirectory());
    assert.equal(calls.get(task.id), 1);
    const [job] = await boss.findJobs(queueName, { data: { taskId: task.id } });
    assert.equal(job?.retryLimit, 0, "Repository coding failure must not automatically call Codex again.");
    if (title.includes("Verification failure") || title.includes("verification failure")) assert.ok(result.verification?.checks.some(check => !check.success && check.exitCode !== 0));
    console.log(`${title}: ${expected}; workspace, available verification, diff and DB result persisted; original checkout unchanged`);
  }

  const workspace = workspaces[0];
  assert.ok(workspace);
  await assert.rejects(removeTaskWorktree(workspace), /modified|untracked/);
  await assert.rejects(removeTaskWorktree({ ...workspace, path: repositoryPath }), /controlled/);
  await assert.rejects(removeTaskWorktree({ ...workspace, branch: "main" }), /controlled/);
  const maliciousId = randomUUID();
  const link = join(worktreeDirectory, maliciousId);
  await symlink(repositoryPath, link);
  try {
    await assert.rejects(removeTaskWorktree({ ...workspace, taskId: maliciousId, path: link, branch: `jonas-os/task-${maliciousId}` }, { force: true }), /symlink/);
  } finally { await unlink(link); }
  await assert.rejects(createTaskWorktree({ path: join(fixture, "missing") }, randomUUID()), /ENOENT/);
  await assert.rejects(createTaskWorktree({ path: repositoryPath, baseBranch: "missing" }, randomUUID()), /Base branch.*does not exist/);
  await git(["config", "filter.fixture.clean", "cat"]);
  try { await assert.rejects(createTaskWorktree({ path: repositoryPath }, randomUUID()), /external Git/); }
  finally { await git(["config", "--unset", "filter.fixture.clean"]); }
  process.env.JONAS_OS_WORKTREE_DIR = join(repositoryPath, "unsafe-worktrees");
  try { await assert.rejects(createTaskWorktree({ path: repositoryPath }, randomUUID()), /outside/); }
  finally { process.env.JONAS_OS_WORKTREE_DIR = worktreeDirectory; }
  await writeFile(join(repositoryPath, "value.txt"), "dirty");
  try { await assert.rejects(createTaskWorktree({ path: repositoryPath }, randomUUID()), /dirty/); }
  finally { await writeFile(join(repositoryPath, "value.txt"), "baseline"); }
  await assert.rejects(runCodex("Never reach the CLI", repositoryPath, { mode: "workspace-write", workspace }), /isolated/);
  console.log("SAFETY: missing/dirty repositories, invalid branches, original cwd and unsafe cleanup rejected");

  // Exercise Codex's argument construction and parser using an entirely fake executable.
  const bin = join(fixture, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "codex"), `#!/usr/bin/env node\nconst assert = require('node:assert/strict');\nconst args = process.argv.slice(2);\nassert.equal(args[0], 'exec');\nconst mode = args[args.indexOf('--sandbox') + 1];\nif (mode === 'workspace-write') {\n  assert.ok(args.includes('--ignore-user-config'));\n  assert.ok(args.includes('sandbox_workspace_write.writable_roots=[]'));\n} else { assert.equal(mode, 'read-only'); }\nassert.ok(!args.includes('--dangerously-bypass-approvals-and-sandbox'));\nconsole.log(JSON.stringify({type:'thread.started',thread_id:'fake'}));\nconsole.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'FAKE_CLI_OK'}}));\nconsole.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:0,output_tokens:0}}));\n`);
  await chmod(join(bin, "codex"), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath ?? ""}`;
  try {
    const result = await runCodex("Fake CLI only", workspace.path, { mode: "workspace-write", workspace });
    assert.equal(result.success, true);
    assert.equal(result.message, "FAKE_CLI_OK");
    const legacy = await executeTask({ ...spec("Legacy read-only fixture"), repository: undefined }, repositoryPath);
    assert.equal(legacy.route.worker, "codex");
    assert.equal(legacy.workspace, undefined);
    assert.equal((legacy.workerResult as { success: boolean }).success, true);
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
  }
  console.log("CODEX PERMISSION FLAGS, OUTPUT PARSING AND LEGACY READ-ONLY EXECUTION: OK (fake CLI)");

  const verifierWorkspace = await createTaskWorktree({ path: repositoryPath }, randomUUID());
  workspaces.push(verifierWorkspace);
  await writeFile(join(verifierWorkspace.path, "package.json"), JSON.stringify({ scripts: { typecheck: "node -e \"console.log('TYPECHECK_OK')\"" } }));
  const partial = await verifyWorktree(verifierWorkspace);
  assert.equal(partial.success, true);
  assert.equal(partial.checks.filter(check => check.skipped).length, 3);
  assert.match(partial.checks[1]?.stdout ?? "", /TYPECHECK_OK/);
  await writeFile(join(verifierWorkspace.path, "package.json"), JSON.stringify({ scripts: { test: "node -e \"setInterval(() => {}, 1000)\"" } }));
  const timeout = await verifyWorktree(verifierWorkspace, { timeoutMs: 500 });
  assert.equal(timeout.success, false);
  assert.equal(timeout.checks[0]?.timedOut, true);
  await writeFile(join(verifierWorkspace.path, "guard.cjs"), `require('node:fs').writeFileSync(${JSON.stringify(join(repositoryPath, "value.txt"))}, 'UNSAFE');`);
  await writeFile(join(verifierWorkspace.path, "package.json"), JSON.stringify({ scripts: { test: "node guard.cjs" } }));
  const blocked = await verifyWorktree(verifierWorkspace);
  assert.equal(blocked.success, false);
  assert.match(blocked.checks[0]?.stderr ?? "", /EPERM|EACCES|permitted/);
  assert.equal(await readFile(join(repositoryPath, "value.txt"), "utf8"), "baseline");
  await inspectTaskWorktree(verifierWorkspace);
  console.log("VERIFIER: absent scripts skipped, timeout bounded, writes to original repository denied");
} finally {
  try {
    await boss.stop({ graceful: true, timeout: 10_000 });
    if (queueCreated) {
      await startQueue(queueName);
      await boss.deleteQueue(queueName);
      await boss.stop();
    }
    for (const id of taskIds) {
      const rows = await db.select().from(runs).where(eq(runs.taskId, id));
      for (const row of rows) if (row.workspace && !workspaces.some(workspace => workspace.path === row.workspace?.path)) workspaces.push(row.workspace);
    }
    for (const workspace of workspaces) {
      try { await removeTaskWorktree(workspace, { force: true }); }
      catch (error) { failures.push(error); }
    }
    for (const id of taskIds) await db.delete(tasks).where(eq(tasks.id, id));
    if (failures.length === 0) await rm(fixture, { recursive: true, force: true });
    else throw new AggregateError(failures, `Worktree cleanup failed; fixture retained at ${fixture}`);
    console.log("WORKTREE CLEANUP: OK");
  } finally {
    try { await boss.stop(); }
    finally {
      await pool.end();
      clearTimeout(watchdog);
      if (oldRoot === undefined) delete process.env.JONAS_OS_WORKTREE_DIR;
      else process.env.JONAS_OS_WORKTREE_DIR = oldRoot;
    }
  }
}
