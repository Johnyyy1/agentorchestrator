import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Job } from "pg-boss";
import { db } from "../db/index.js";
import { runs, tasks } from "../db/schema.js";
import { routeTask } from "../router/router.js";
import { recommendationSchema } from "../router/recommendation.js";
import { taskRowToSpec } from "../tasks/task-spec.js";
import { executeTask } from "../workers/execute.js";
import type { ExecutionOptions } from "../workers/execute.js";
import type { TaskSpec } from "../workers/types.js";
import { boss, startQueue, TASK_QUEUE_NAME } from "./boss.js";

type Executor = (task: TaskSpec, cwd: string, options?: ExecutionOptions) => Promise<unknown>;
const taskJobSchema = z.object({ taskId: z.uuid() }).strict();

function errorText(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

function reportedFailure(result: unknown): boolean {
  if (typeof result !== "object" || result === null) return false;
  if ("success" in result && result.success === false) return true;
  return "workerResult" in result && reportedFailure(result.workerResult);
}

export async function processTaskJob(
  job: Job<unknown>,
  executor: Executor = executeTask,
  cwd = process.cwd(),
): Promise<void> {
  let taskId: string | undefined;
  let runId: string | undefined;
  let ownsTask = false;
  let result: unknown;
  let abortExecution: (() => void) | undefined;

  try {
    ({ taskId } = taskJobSchema.parse(job.data));
    const id = taskId;
    job.signal.throwIfAborted();

    const task = await db.transaction(async (tx) => {
      const [row] = await tx.select().from(tasks).where(eq(tasks.id, id)).for("update");
      if (!row) throw new Error(`Task ${taskId} does not exist.`);
      // A completed task need not execute again if queue settlement was interrupted.
      if (row.status === "completed") return undefined;
      if (row.status === "running" && job.retryCount === 0) {
        throw new Error(`Task ${taskId} is already running.`);
      }
      ownsTask = true;
      const spec = taskRowToSpec(row);
      const recommendation = row.chief === null ? undefined : recommendationSchema.parse(row.chief);
      const route = routeTask(spec);

      // A queue retry after process termination closes the previous interrupted run.
      await tx.update(runs)
        .set({ status: "failed", error: "Previous execution was interrupted before queue retry.", finishedAt: new Date() })
        .where(and(eq(runs.taskId, row.id), eq(runs.status, "running")));
      await tx.update(tasks).set({ status: "running", updatedAt: new Date() }).where(eq(tasks.id, row.id));
      const [run] = await tx.insert(runs).values({
        taskId: row.id,
        attempt: job.retryCount + 1,
        worker: route.worker,
        tier: route.tier ?? null,
        status: "running",
      }).returning();
      if (!run) throw new Error(`Run insert failed for task ${row.id}.`);
      console.log(`Task ${row.id} job ${job.id}: preparing (attempt ${run.attempt}; category route ${route.worker})`);
      return { spec, recommendation, runId: run.id };
    });
    if (!task) {
      console.log(`Task ${taskId} job ${job.id}: already completed`);
      return;
    }

    runId = task.runId;
    job.signal.throwIfAborted();
    const aborted = new Promise<never>((_resolve, reject) => {
      abortExecution = () => reject(new Error(`Job ${job.id} was interrupted or lost its queue claim.`, { cause: job.signal.reason }));
      job.signal.addEventListener("abort", abortExecution, { once: true });
    });
    const output = await Promise.race([executor(task.spec, cwd, {
      taskId: id,
      signal: job.signal,
      ...(task.recommendation ? { recommendation: task.recommendation } : {}),
      onRouteSelected: async (routing, route) => {
        const [saved] = await db.update(runs).set({ routing, worker: route.worker, tier: route.tier ?? null })
          .where(eq(runs.id, task.runId)).returning({ id: runs.id });
        if (!saved) throw new Error("Run disappeared before routing metadata could be saved.");
      },
      onWorkspaceCreated: async (workspace) => {
        const [saved] = await db.update(runs).set({ workspace }).where(eq(runs.id, task.runId)).returning({ id: runs.id });
        if (!saved) throw new Error("Run disappeared before workspace metadata could be saved.");
      },
    }), aborted]);
    // Fail clearly on a result that cannot be stored as JSON.
    result = JSON.parse(JSON.stringify(output));
    if (reportedFailure(result)) {
      const detail = typeof result === "object" && result !== null && "error" in result && typeof result.error === "string"
        ? result.error : JSON.stringify(result).slice(0, 4000);
      throw new Error(`Worker reported an unsuccessful execution: ${detail}`);
    }

    await db.transaction(async (tx) => {
      await tx.update(runs).set({ status: "completed", result, finishedAt: new Date() }).where(eq(runs.id, task.runId));
      await tx.update(tasks).set({ status: "completed", updatedAt: new Date() }).where(eq(tasks.id, id));
    });
    console.log(`Task ${taskId} job ${job.id}: completed`);
  } catch (error) {
    console.error(`Task ${taskId ?? "unknown"} job ${job.id}: failed`, error);
    if (ownsTask && taskId) {
      const failedTaskId = taskId;
      try {
        await db.transaction(async (tx) => {
          if (runId) {
            await tx.update(runs).set({ status: "failed", result, error: errorText(error), finishedAt: new Date() }).where(eq(runs.id, runId));
          }
          await tx.update(tasks).set({ status: "failed", updatedAt: new Date() }).where(eq(tasks.id, failedTaskId));
        });
      } catch (persistenceError) {
        throw new AggregateError([error, persistenceError], `Task ${taskId} failed and its failure state could not be persisted.`);
      }
    }
    throw error;
  } finally {
    if (abortExecution) job.signal.removeEventListener("abort", abortExecution);
  }
}

export async function registerTaskWorker(options: {
  executor?: Executor;
  cwd?: string;
  queueName?: string;
} = {}): Promise<string> {
  const queueName = options.queueName ?? TASK_QUEUE_NAME;
  await startQueue(queueName);
  return boss.work<unknown>(queueName, { batchSize: 1, pollingIntervalSeconds: 0.5 }, async (jobs) => {
    for (const job of jobs) {
      await processTaskJob(job, options.executor ?? executeTask, options.cwd ?? process.cwd());
    }
  });
}
