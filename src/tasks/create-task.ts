import type { ProjectSubmissionContext } from '../projects/contracts.js';
import { validateProjectSubmission } from '../projects/submission.js';
import { eq, sql } from "drizzle-orm";
import { fromDrizzle } from "pg-boss";
import { db, pool } from "../db/index.js";
import { drizzle } from "drizzle-orm/node-postgres";
import { tasks } from "../db/schema.js";
import { boss, startQueue, TASK_QUEUE_NAME } from "../queue/boss.js";
import type { TaskJob } from "../queue/boss.js";
import type { TaskSpec } from "../workers/types.js";
import { normalizeTaskSemantics } from "./semantics.js";
import { taskSpecSchema } from "./task-spec.js";
import { recommendationSchema } from "../router/recommendation.js";
import type { Recommendation } from "../router/recommendation.js";

export async function createTask(
  task: TaskSpec,
  queueName = TASK_QUEUE_NAME,
  recommendation?: Recommendation,
  projectContext?: ProjectSubmissionContext,
): Promise<typeof tasks.$inferSelect> {
  const parsed = taskSpecSchema.parse(task);
  const chief = recommendation === undefined ? null : recommendationSchema.parse(recommendation);
  const spec = normalizeTaskSemantics(parsed, chief?.capability);
  const insert = async () => {
    if (!projectContext) return db.insert(tasks).values({ ...spec, chief, queueName, status: 'pending' }).returning();
    const client = await pool.connect();
    try {
      await client.query('begin');
      const context = await validateProjectSubmission(client, projectContext, spec);
      const rows = await drizzle(client).insert(tasks).values({ ...spec, chief, queueName, status: 'pending', ...context }).returning();
      await client.query('commit'); return rows;
    } catch (error) { await client.query('rollback'); throw error; }
    finally { client.release(); }
  };
  const [created] = await insert();
  if (!created) throw new Error("Task insert did not return a row.");

  try {
    await startQueue(queueName);
    const { queued, jobId } = await db.transaction(async (tx) => {
      const jobId = await boss.send(queueName, { taskId: created.id } satisfies TaskJob, {
        db: fromDrizzle(tx, sql),
        // Application orchestration owns coding repairs, never pg-boss retries.
        ...(spec.category === "coding" && spec.repository ? { retryLimit: 0, expireInSeconds: 3600 } : {}),
      });
      if (!jobId) throw new Error("pg-boss did not return a job ID.");

      const [queued] = await tx.update(tasks)
        .set({ status: "queued", updatedAt: new Date() })
        .where(eq(tasks.id, created.id))
        .returning();
      if (!queued) throw new Error("Persisted task disappeared before queueing.");
      return { queued, jobId };
    });
    console.log(`Task ${created.id} queued as job ${jobId}`);
    return queued;
  } catch (cause) {
    throw new Error(
      `Task ${created.id} was persisted, but queueing failed. Its pending row is retained for diagnosis and recovery.`,
      { cause },
    );
  }
}
