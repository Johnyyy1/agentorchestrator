import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db, pool } from "../src/db/index.js";
import { runs, tasks } from "../src/db/schema.js";

try {
  const taskId = z.uuid().parse(process.argv[2]);
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!task) throw new Error(`Task ${taskId} does not exist.`);
  const taskRuns = await db.select().from(runs).where(eq(runs.taskId, taskId)).orderBy(desc(runs.startedAt));
  console.log(JSON.stringify({ task, runs: taskRuns }, null, 2));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
