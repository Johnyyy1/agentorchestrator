import assert from "node:assert/strict";
import { eq } from "drizzle-orm";

import { db, pool } from "./db/index.js";
import { tasks } from "./db/schema.js";

const testTask = {
  title: "Database smoke test",
  objective: "Verify Jonas OS persistence.",
  category: "utility",
  difficulty: 1,
  risk: "low",
  context: ["Temporary test task."],
  acceptanceCriteria: ["Task can be written and read."],
  maxAttempts: 1,
} satisfies typeof tasks.$inferInsert;

let taskId: typeof tasks.$inferSelect.id | undefined;

try {
  const [created] = await db.insert(tasks).values(testTask).returning();
  assert.ok(created, "Task insert did not return a row.");
  taskId = created.id;

  console.log("CREATED:");
  console.log(created);

  const [loaded] = await db
    .select()
    .from(tasks)
    .where(eq(tasks.id, taskId));

  console.log("\nLOADED:");
  console.log(loaded);

  assert.ok(loaded, "Inserted task could not be loaded.");
  assert.equal(loaded.id, created.id, "Loaded task ID does not match.");
  assert.equal(loaded.title, testTask.title, "Loaded task title does not match.");
  assert.equal(loaded.status, "pending", "Task status must default to pending.");
  assert.deepEqual(loaded.context, testTask.context);
  assert.deepEqual(loaded.acceptanceCriteria, testTask.acceptanceCriteria);

  const [deleted] = await db
    .delete(tasks)
    .where(eq(tasks.id, taskId))
    .returning({ id: tasks.id });
  assert.ok(deleted, "Temporary task was not deleted.");
  taskId = undefined;

  console.log("\nCLEANUP: OK");
} finally {
  try {
    // Remove the temporary row even if validation fails.
    if (taskId !== undefined) {
      await db.delete(tasks).where(eq(tasks.id, taskId));
    }
  } finally {
    await pool.end();
  }
}
