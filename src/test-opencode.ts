import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execa } from "execa";
import { checkOpenCode } from "./local/opencode.js";
import { executeTask } from "./workers/execute.js";
import { removeTaskWorktree } from "./git/worktree.js";
import type { TaskWorktree } from "./git/worktree.js";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { eq } from "drizzle-orm";
import { db, pool } from "./db/index.js";
import { runs, tasks } from "./db/schema.js";
import { boss, startQueue, TASK_QUEUE_NAME } from "./queue/boss.js";
import { registerTaskWorker } from "./queue/task-worker.js";
import { createTask } from "./tasks/create-task.js";
import { runOpenCode } from "./workers/opencode.js";
import type { ExecutionResult } from "./workers/execute.js";
import type { OpenCodeResult } from "./workers/opencode.js";

// Refuse to silently exercise Codex if local readiness fails.
const ready = await checkOpenCode();
if (!ready.available) {
  console.error("Real OpenCode smoke test BLOCKED:", JSON.stringify(ready));
  process.exitCode = 1;
  await pool.end();
} else {
  const fixture = await realpath(await mkdtemp(join(tmpdir(), "jonas-opencode-smoke-")));
  const source = join(fixture, "source");
  const oldRoot = process.env.JONAS_OS_WORKTREE_DIR;
  const workspaces: TaskWorktree[] = [];
  const queueName = `${TASK_QUEUE_NAME}.opencode-smoke.${randomUUID()}`;
  const title = `Fix addition ${randomUUID()}`;
  let queueCreated = false;
  let workerCalls = 0;
  process.env.JONAS_OS_WORKTREE_DIR = join(fixture, "worktrees");
  const git = (args: string[]) => execa("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: source, timeout: 10000 });
  try {
    await mkdir(source);
    await execa("git", ["init", "-b", "main", source]);
    await writeFile(join(source, "add.ts"), "export function add(a: number, b: number): number { return a - b; }\n");
    await writeFile(join(source, "add.test.mjs"), `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from './add.ts';\ntest('addition', () => { assert.equal(add(2, 3), 5); assert.equal(add(-2, 1), -1); });\n`);
    await writeFile(join(source, ".gitignore"), "dist/\n");
    // Explicit fixture-only provisioning: compiler already installed in Jonas OS.
    const tsc = `${JSON.stringify(process.execPath)} ${JSON.stringify(resolve("node_modules/typescript/bin/tsc"))}`;
    await writeFile(join(source, "package.json"), JSON.stringify({ name: "local-opencode-fixture", type: "module", scripts: {
      test: "node --test add.test.mjs", typecheck: `${tsc} --ignoreConfig --noEmit --target esnext add.ts`,
      lint: "node --check add.ts", build: `${tsc} --ignoreConfig --target esnext --outDir dist add.ts`,
    } }, null, 2));
    await git(["add", "."]);
    await git(["-c", "commit.gpgsign=false", "-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", "commit", "-m", "Fixture baseline"]);
    const before = await readFile(join(source, "add.ts"), "utf8");
    const baseline = (await git(["rev-parse", "HEAD"])).stdout;
    await startQueue(queueName);
    queueCreated = true;
    await registerTaskWorker({ queueName, cwd: source, orchestration: {
      reviewerAvailability: async () => ({}),
      repair: async () => { throw new Error("Local smoke must not invoke a repair Chief."); },
      review: async () => { throw new Error("Local smoke must not consume cloud review quota."); },
    }, executor: (task, cwd, options) => executeTask(task, cwd, {
      ...options,
      availability: { opencode: { available: true, model: `ollama/${ready.model}` }, codex: { available: false }, antigravity: { available: false } },
      codexExecutor: async () => { throw new Error("Smoke test must never invoke Codex."); },
      opencodeExecutor: async (prompt, cwd, workerOptions) => {
        workerCalls++;
        const [run] = await db.select().from(runs).where(eq(runs.taskId, workerOptions.workspace.taskId));
        assert.equal(run?.status, "running");
        assert.equal(run?.worker, "opencode");
        assert.equal(run?.routing?.requestedCapability, "local-coding");
        assert.equal(run?.routing?.selectedWorker, "opencode");
        assert.equal(run?.workspace?.path, cwd, "Workspace must be durable before inference.");
        return runOpenCode(prompt, cwd, workerOptions);
      },
      onWorkspaceCreated: async workspace => { workspaces.push(workspace); await options?.onWorkspaceCreated?.(workspace); },
    }) });
    const task = await createTask({ title, objective: "Read add.ts and add.test.mjs. Fix add.ts so add performs addition. Change only add.ts. Do not run shell commands.",
      category: "coding", difficulty: 1, risk: "low", context: ["Disposable TypeScript fixture. Tests are already provided."],
      acceptanceCriteria: ["add(2,3) === 5 and add(-2,1) === -1; change only add.ts."], maxAttempts: 1, repository: { path: source } }, queueName,
      { capability: "local-coding", workerBrief: "Inspect the two files and replace the incorrect subtraction with addition. Keep the function signature and tests." });
    const deadline = Date.now() + 360000;
    let persisted;
    while (Date.now() < deadline) {
      const [row] = await db.select().from(tasks).where(eq(tasks.id, task.id));
      if (row?.status === "completed" || row?.status === "failed" || row?.status === "waiting_human") {
        const [run] = await db.select().from(runs).where(eq(runs.taskId, task.id));
        const [job] = await boss.findJobs(queueName, { data: { taskId: task.id } });
        if (job?.state === "completed") { persisted = run; break; }
      }
      await delay(100);
    }
    assert.ok(persisted, "Real smoke exceeded its bounded queue/execution deadline.");
    const result = persisted.result as ExecutionResult;
    console.log("Persisted smoke:", JSON.stringify({ status: persisted.status, routing: persisted.routing, workspace: persisted.workspace, error: persisted.error }));
    assert.equal(persisted.status, "completed", persisted.error ?? "Local smoke failed.");
    assert.equal(workerCalls, 1, "Exactly one local invocation; no retries or cloud handoff.");
    assert.deepEqual(persisted.routing, result.routing);
    assert.deepEqual(persisted.workspace, result.workspace);
    assert.equal(persisted.routing?.model, `ollama/${ready.model}`);
    const worker = result.workerResult as OpenCodeResult;
    console.log("Real local worker:", JSON.stringify(worker));
    assert.equal(result.route.worker, "opencode");
    assert.equal(result.success, true, result.error ?? "Local smoke execution failed.");
    if (ready.outputFormat === "json") assert.ok(worker.sessionId);
    assert.ok(worker.message);
    assert.equal(worker.model, ready.model);
    assert.deepEqual(result.verification?.checks.map(check => check.name), ["test", "typecheck", "lint", "build"]);
    assert.ok(result.verification?.checks.every(check => !check.skipped && check.success));
    assert.deepEqual(result.git?.changedFiles, ["add.ts"]);
    assert.notEqual(await readFile(join(result.workspace!.path, "add.ts"), "utf8"), before);
    assert.equal(await readFile(join(source, "add.ts"), "utf8"), before);
    assert.equal((await git(["status", "--short"])).stdout, "");
    assert.equal((await git(["rev-parse", "HEAD"])).stdout, baseline);
    console.log(`Real OpenCode ${ready.version} + ${ready.model}: PASS; original unchanged; all four verifier checks pass; task waits for independent review (no cloud quota).`);
  } finally {
    const cleanupErrors: unknown[] = [];
    const cleanup = async (action: () => Promise<unknown>) => {
      try { await action(); } catch (error) { cleanupErrors.push(error); }
    };
    // Stop the unique test consumer before deleting its own fixture/data.
    await cleanup(() => boss.stop());
    await cleanup(async () => {
      if (queueCreated) {
        await startQueue(queueName);
        await boss.deleteQueue(queueName);
        assert.equal(await boss.getQueue(queueName), null);
      }
    });
    await cleanup(async () => {
      await db.delete(tasks).where(eq(tasks.title, title));
      assert.equal((await db.select().from(tasks).where(eq(tasks.title, title))).length, 0);
      for (const workspace of workspaces) assert.equal((await db.select().from(runs).where(eq(runs.taskId, workspace.taskId))).length, 0);
    });
    await cleanup(() => boss.stop());
    await cleanup(() => pool.end());
    // Only disposable fixtures created by this test are removed.
    for (const workspace of workspaces) await cleanup(() => removeTaskWorktree(workspace, { force: true }));
    await cleanup(() => rm(fixture, { recursive: true, force: true }));
    if (oldRoot === undefined) delete process.env.JONAS_OS_WORKTREE_DIR; else process.env.JONAS_OS_WORKTREE_DIR = oldRoot;
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "OpenCode smoke fixture cleanup failed.");
    console.log("OpenCode smoke fixture cleanup: OK.");
  }
}
