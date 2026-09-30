import { readFile } from "node:fs/promises";
import { createTask } from "../src/tasks/create-task.js";
import { taskSpecSchema } from "../src/tasks/task-spec.js";
import { boss } from "../src/queue/boss.js";
import { pool } from "../src/db/index.js";

try {
  const inputFile = process.argv[2];
  if (!inputFile || process.argv.length !== 3) {
    throw new Error("Usage: npx tsx examples/create-task.ts <task.json>");
  }
  const spec = taskSpecSchema.parse(JSON.parse(await readFile(inputFile, "utf8")));
  const task = await createTask(spec);
  console.log(JSON.stringify({ id: task.id, status: task.status }, null, 2));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  try { await boss.stop({ graceful: true }); }
  finally { await pool.end(); }
}
