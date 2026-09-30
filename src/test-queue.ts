import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mock } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { SendOptions } from "pg-boss";
import { eq } from "drizzle-orm";
import { db, pool } from "./db/index.js";
import { runs, tasks } from "./db/schema.js";
import { boss, startQueue, TASK_QUEUE_NAME } from "./queue/boss.js";
import { processTaskJob } from "./queue/task-worker.js";
import { createTask } from "./tasks/create-task.js";
import { taskRowToSpec } from "./tasks/task-spec.js";
import type { TaskSpec } from "./workers/types.js";

const queueName = `${TASK_QUEUE_NAME}.test.${randomUUID()}`;
const taskIds: string[] = [];
let worker: ChildProcess | undefined;
let workerOutput = "";
let createdQueue = false;
const deadline = Date.now() + 45_000;

// Last-resort bound also covers startup/shutdown I/O rather than just polling.
const watchdog = setTimeout(() => {
  console.error("Queue test exceeded its 60-second timeout.", workerOutput);
  worker?.kill("SIGKILL");
  process.exit(1);
}, 60_000);

async function waitUntil(description: string, check: () => Promise<boolean>): Promise<void> {
  while (Date.now() < deadline) {
    if (await check()) return;
    if (worker && worker.exitCode !== null) {
      throw new Error(`Worker exited while waiting for ${description}: ${workerOutput}`);
    }
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${description}: ${workerOutput}`);
}

function spec(title: string): TaskSpec {
  return {
    title,
    objective: "Verify durable queue execution using a fake executor.",
    category: "coding",
    difficulty: 1,
    risk: "low",
    context: ["Temporary queue test task. Never call an AI worker."],
    acceptanceCriteria: ["Result is persisted and temporary data is cleaned up."],
    maxAttempts: 1,
  };
}

async function create(title: string) {
  const row = await createTask(spec(title), queueName);
  taskIds.push(row.id);
  assert.equal(row.status, "queued");
  return row;
}

async function waitForTask(id: string, status: string): Promise<void> {
  await waitUntil(`task ${id} to become ${status}`, async () => {
    const [row] = await db.select().from(tasks).where(eq(tasks.id, id));
    return row?.status === status;
  });
}

async function stopWorker(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
  const child = worker;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const stopped = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Worker did not stop cleanly: ${workerOutput}`));
    }, 8000);
    child.once("exit", (code, exitSignal) => {
      clearTimeout(timeout);
      if (code === 0 && exitSignal === null) resolve();
      else reject(new Error(`Worker exit ${code}/${exitSignal}: ${workerOutput}`));
    });
  });
  child.kill(signal);
  await stopped;
  worker = undefined;
}

try {
  await startQueue(queueName);
  createdQueue = true;
  // Failure cases settle once; production retains pg-boss's basic retry mechanics.
  await boss.updateQueue(queueName, { retryLimit: 0 });

  // Fail after the real queue insert to verify the enqueue transaction rolls back.
  const originalSend = boss.send.bind(boss);
  const sendMock = mock.method(boss, "send", async (name: string, data: object, options: SendOptions) => {
    await originalSend(name, data, options);
    throw new Error("QUEUE_TEST_ENQUEUE_ERROR");
  });
  const pendingSpec = spec(`Queue enqueue failure ${randomUUID()}`);
  try {
    await assert.rejects(createTask(pendingSpec, queueName), /was persisted, but queueing failed/);
  } finally { sendMock.mock.restore(); }
  const [pending] = await db.select().from(tasks).where(eq(tasks.title, pendingSpec.title));
  assert.ok(pending);
  taskIds.push(pending.id);
  assert.equal(pending.status, "pending");
  assert.equal((await boss.findJobs(queueName)).length, 0);
  console.log("ENQUEUE FAILURE RETAINS PENDING TASK AND ROLLS BACK JOB: OK");

  const queued = await create("Queue success test");
  assert.equal((await db.select().from(tasks).where(eq(tasks.id, queued.id)))[0]?.status, "queued");
  const jobs = await boss.findJobs(queueName);
  assert.equal(jobs.length, 1);
  assert.deepEqual(jobs[0]?.data, { taskId: queued.id });

  // Shut down the producer before a separate worker process starts.
  await boss.stop();
  worker = spawn(process.execPath, ["--import", "tsx", "src/tests/queue-worker-fixture.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, QUEUE_TEST_NAME: queueName },
    stdio: ["ignore", "pipe", "pipe"],
  });
  worker.stdout?.on("data", (chunk: Buffer) => { workerOutput += chunk.toString(); });
  worker.stderr?.on("data", (chunk: Buffer) => { workerOutput += chunk.toString(); });
  let spawnError: Error | undefined;
  worker.on("error", (error: Error) => { spawnError = error; });
  await waitUntil("separate worker readiness", async () => {
    if (spawnError) throw spawnError;
    return workerOutput.includes("QUEUE_TEST_WORKER_READY");
  });
  await waitForTask(queued.id, "completed");
  const completedRuns = await db.select().from(runs).where(eq(runs.taskId, queued.id));
  assert.equal(completedRuns.length, 1);
  const run = completedRuns[0];
  assert.ok(run);
  assert.equal(run.worker, "codex");
  assert.equal(run.attempt, 1);
  assert.equal(run.status, "completed");
  assert.deepEqual(run.result, { success: true, message: "QUEUE_TEST_OK" });
  assert.ok(run.finishedAt instanceof Date);
  console.log("DURABILITY, PRODUCER/WORKER SEPARATION AND RESULT: OK");

  await startQueue(queueName);
  // Re-delivery after completion must not call the executor a second time.
  const duplicateId = await boss.send(queueName, { taskId: queued.id });
  assert.ok(duplicateId);
  await waitUntil("completed task re-delivery", async () =>
    (await boss.findJobs(queueName, { id: duplicateId }))[0]?.state === "completed");
  assert.equal((await db.select().from(runs).where(eq(runs.taskId, queued.id))).length, 1);

  for (const [title, expectedError] of [
    ["Queue thrown failure", "QUEUE_TEST_THROWN_ERROR"],
    ["Queue reported failure", "QUEUE_TEST_REPORTED_ERROR"],
  ] as const) {
    const failed = await create(title);
    await waitForTask(failed.id, "failed");
    await waitUntil("queue failure settlement", async () =>
      (await boss.findJobs(queueName)).some(job =>
        (job.data as { taskId?: unknown }).taskId === failed.id && job.state === "failed"));
    const failedRuns = await db.select().from(runs).where(eq(runs.taskId, failed.id));
    assert.equal(failedRuns.length, 1);
    assert.equal(failedRuns[0]?.status, "failed");
    assert.ok(failedRuns[0]?.finishedAt);
    assert.ok(failedRuns[0]?.error?.includes(expectedError));
    if (title === "Queue reported failure") assert.ok(failedRuns[0]?.result);
  }
  console.log("THROWN AND STRUCTURED EXECUTOR FAILURES: OK");

  const invalid = await db.insert(tasks).values({ ...spec("Invalid persisted task"), category: "unsupported" }).returning();
  const invalidTask = invalid[0];
  assert.ok(invalidTask);
  taskIds.push(invalidTask.id);
  assert.throws(() => taskRowToSpec(invalidTask));
  await boss.send(queueName, { taskId: invalidTask.id });
  await waitForTask(invalidTask.id, "failed");
  assert.equal((await db.select().from(runs).where(eq(runs.taskId, invalidTask.id))).length, 0);

  for (const payload of [{ taskId: randomUUID() }, { taskId: "invalid" }]) {
    const id = await boss.send(queueName, payload);
    assert.ok(id);
    await waitUntil("invalid job failure", async () =>
      (await boss.findJobs(queueName, { id }))[0]?.state === "failed");
  }
  console.log("INVALID DB VALUES, MISSING TASK AND MALFORMED PAYLOAD: OK");

  const [interrupted] = await db.insert(tasks).values(spec("Queue aborted execution")).returning();
  assert.ok(interrupted);
  taskIds.push(interrupted.id);
  const controller = new AbortController();
  await assert.rejects(processTaskJob({
    id: randomUUID(), name: queueName, data: { taskId: interrupted.id },
    retryCount: 0, expireInSeconds: 900, heartbeatSeconds: null, signal: controller.signal,
  }, async () => {
    controller.abort(new Error("QUEUE_TEST_ABORT"));
    return new Promise<never>(() => {});
  }), /was interrupted/);
  assert.equal((await db.select().from(tasks).where(eq(tasks.id, interrupted.id)))[0]?.status, "failed");
  const [interruptedRun] = await db.select().from(runs).where(eq(runs.taskId, interrupted.id));
  assert.equal(interruptedRun?.status, "failed");
  assert.ok(interruptedRun?.finishedAt);
  assert.ok(interruptedRun?.error?.includes("was interrupted"));
  console.log("ABORTED EXECUTION CLOSES ITS RUN: OK");

  const shutdownTask = await create("Queue shutdown test");
  await waitForTask(shutdownTask.id, "running");
  await stopWorker();
  assert.equal((await db.select().from(tasks).where(eq(tasks.id, shutdownTask.id)))[0]?.status, "completed");
  assert.equal((await db.select().from(runs).where(eq(runs.taskId, shutdownTask.id)))[0]?.status, "completed");
  console.log("GRACEFUL SHUTDOWN DURING EXECUTION: OK");
} finally {
  try {
    await stopWorker();
  } finally {
    try {
      if (createdQueue) {
        await startQueue(queueName);
        await boss.deleteQueue(queueName);
      }
      for (const id of taskIds) await db.delete(tasks).where(eq(tasks.id, id));
      for (const id of taskIds) {
        assert.equal((await db.select().from(tasks).where(eq(tasks.id, id))).length, 0);
        assert.equal((await db.select().from(runs).where(eq(runs.taskId, id))).length, 0);
      }
      console.log("QUEUE CLEANUP: OK");
    } finally {
      try { await boss.stop(); }
      finally { await pool.end(); clearTimeout(watchdog); }
    }
  }
}
