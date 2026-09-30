import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db, pool } from "../src/db/index.js";
import { runs, tasks, reviews, escalations, orchestrationEvents } from "../src/db/schema.js";

try {
  const taskId = z.uuid().parse(process.argv[2]);
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!task) throw new Error(`Task ${taskId} does not exist.`);
  const taskRuns = await db.select().from(runs).where(eq(runs.taskId, taskId)).orderBy(desc(runs.startedAt));
  const [taskReviews, taskEscalations, events] = await Promise.all([
    db.select().from(reviews).where(eq(reviews.taskId, taskId)),
    db.select().from(escalations).where(eq(escalations.taskId, taskId)),
    db.select().from(orchestrationEvents).where(eq(orchestrationEvents.taskId, taskId)).orderBy(orchestrationEvents.createdAt),
  ]);
  console.log(JSON.stringify({ task, runs: taskRuns, reviews: taskReviews, escalations: taskEscalations, events }, null, 2));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
