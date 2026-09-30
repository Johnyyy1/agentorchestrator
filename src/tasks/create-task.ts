import { eq, sql } from "drizzle-orm";
import { fromDrizzle } from "pg-boss";
import { db } from "../db/index.js";
import { tasks } from "../db/schema.js";
import { boss, startQueue, TASK_QUEUE_NAME } from "../queue/boss.js";
import type { TaskJob } from "../queue/boss.js";
import type { TaskSpec } from "../workers/types.js";
import { taskSpecSchema } from "./task-spec.js";
import { recommendationSchema } from "../router/recommendation.js";
import type { Recommendation } from "../router/recommendation.js";

export async function createTask(
  task: TaskSpec,
  queueName = TASK_QUEUE_NAME,
  recommendation?: Recommendation,
): Promise<typeof tasks.$inferSelect> {
  const spec = taskSpecSchema.parse(task);
  const chief = recommendation === undefined ? null : recommendationSchema.parse(recommendation);
  const [created] = await db.insert(tasks).values({ ...spec, chief, status: "pending" }).returning();
  if (!created) throw new Error("Task insert did not return a row.");

  try {
    await startQueue(queueName);
    const { queued, jobId } = await db.transaction(async (tx) => {
      const jobId = await boss.send(queueName, { taskId: created.id } satisfies TaskJob, {
        db: fromDrizzle(tx, sql),
        // Verification failure is terminal for now; never call Codex again automatically.
        ...(spec.category === "coding" && spec.repository ? { retryLimit: 0 } : {}),
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
