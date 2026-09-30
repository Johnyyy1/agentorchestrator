import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { planGoal } from "./chief/chief.js";
import { ChiefError } from "./chief/errors.js";
import { submitDecision } from "./chief/submit-decision.js";
import { chiefDecisionSchema } from "./chief/schema.js";
import { getOllamaConfig, OllamaError } from "./local/ollama.js";
import { db, pool } from "./db/index.js";
import { tasks } from "./db/schema.js";
import { boss, startQueue, TASK_QUEUE_NAME } from "./queue/boss.js";

const config = getOllamaConfig();
const queueName = `${TASK_QUEUE_NAME}.chief-test.${randomUUID()}`;
let taskId: string | undefined;
let title: string | undefined;
let queueCreated = false;
const watchdog = setTimeout(() => {
  console.error("Chief smoke test exceeded its bounded deadline.");
  process.exit(1);
}, 2 * config.timeoutMs + 45000);

try {
  const decision = await planGoal({
    userGoal: "Implement a small TypeScript feature: add a pure clamp(value, min, max) utility that returns the nearest bound when value is outside the range, returns value inside the range, and throws RangeError when min > max. Add node:test unit tests. Keep the change isolated and do not modify unrelated files.",
    project: {
      name: "Jonas OS", repositoryPath: process.cwd(),
      summary: "TypeScript ESM project using tsx and node:test. Existing orchestration has TaskSpec, deterministic routing, durable pg-boss queue and managed Git worktrees. This is a proposed feature; no implementation is claimed. Add the utility as src/utils/clamp.ts and its tests as src/utils/clamp.test.ts.",
    },
  }, { config });
  assert.equal(chiefDecisionSchema.safeParse(decision).success, true);
  assert.equal(decision.action, "create_task");
  if (decision.action !== "create_task") throw new Error("Expected actionable coding decision.");
  assert.equal(decision.task.category, "coding");
  assert.ok(decision.task.acceptanceCriteria.length > 0);
  assert.ok(decision.workerBrief.trim());
  console.log(`Real Qwen coding: OK (${decision.capability}, difficulty ${decision.task.difficulty}, risk ${decision.task.risk}).`);

  // A unique queue has no consumer. Nothing reaches the production worker or either provider.
  await startQueue(queueName);
  queueCreated = true;
  title = `${decision.task.title} [chief-smoke ${randomUUID()}]`;
  const submitted = await submitDecision({ ...decision, task: { ...decision.task, title } }, { queueName });
  assert.equal(submitted.action, "create_task");
  if (submitted.action !== "create_task") throw new Error("Expected queued task.");
  taskId = submitted.task.id;
  const [stored] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  assert.ok(stored);
  assert.equal(stored.status, "queued");
  assert.equal(stored.category, "coding");
  assert.deepEqual(stored.acceptanceCriteria, decision.task.acceptanceCriteria);
  assert.deepEqual(stored.chief, { capability: decision.capability, workerBrief: decision.workerBrief });
  const jobs = await boss.fetch<{ taskId: string }>(queueName);
  assert.equal(jobs.length, 1);
  assert.deepEqual(jobs[0]?.data, { taskId });
  console.log("Chief → createTask → PostgreSQL → isolated durable queue: OK (no worker execution).");

  const clarification = await planGoal({ userGoal: "Deploy this to production." }, { config });
  assert.equal(clarification.action, "ask_human");
  const result = await submitDecision(clarification);
  assert.equal(result.action, "ask_human");
  console.log("Real Qwen deployment clarification: OK (no task created).");
} catch (error) {
  console.error(error instanceof OllamaError || error instanceof ChiefError ? `${error.code}: ${error.message}` : error);
  process.exitCode = 1;
} finally {
  try {
    if (queueCreated) await boss.deleteQueue(queueName);
    // Also handles createTask's intentionally retained pending row if queue submission failed.
    if (title) await db.delete(tasks).where(eq(tasks.title, title));
    if (taskId) assert.equal((await db.select().from(tasks).where(eq(tasks.id, taskId))).length, 0);
    if (queueCreated) assert.equal(await boss.getQueue(queueName), null);
    console.log("Chief smoke cleanup: OK.");
  } finally {
    await boss.stop({ graceful: true });
    await pool.end();
    clearTimeout(watchdog);
  }
}
