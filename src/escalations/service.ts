import { and, asc, eq, sql } from "drizzle-orm";
import { fromDrizzle } from "pg-boss";
import { z } from "zod";
import { db } from "../db/index.js";
import { escalations, orchestrationEvents, tasks } from "../db/schema.js";
import { boss, startQueue } from "../queue/boss.js";
import { assertTransition } from "../orchestration/state.js";
import { redact } from "../orchestration/context.js";
export const reasonTypeSchema = z.enum(["clarification", "max_attempts", "review", "security", "architecture", "product_decision", "infrastructure", "other"]);
export type EscalationReason = z.infer<typeof reasonTypeSchema>;
export async function openEscalation(taskId: string, runId: string | undefined, reasonType: EscalationReason,
  question: string, summary: string, context: unknown = {}) {
  reasonTypeSchema.parse(reasonType);
  return db.transaction(async tx => {
    const [task] = await tx.select().from(tasks).where(eq(tasks.id, taskId)).for("update");
    if (!task) throw new Error("Task does not exist.");
    const [existing] = await tx.select().from(escalations).where(and(eq(escalations.taskId, taskId), eq(escalations.status, "open")));
    if (existing) return existing;
    assertTransition(task.status, "waiting_human");
    const [created] = await tx.insert(escalations).values({ taskId, runId: runId ?? null, reasonType,
      question: redact(question).slice(0, 2000), summary: redact(summary).slice(0, 2000), context }).returning();
    await tx.update(tasks).set({ status: "waiting_human", orchestration: { ...task.orchestration, phase: "human" }, updatedAt: new Date() }).where(eq(tasks.id, taskId));
    await tx.insert(orchestrationEvents).values({ taskId, runId: runId ?? null, kind: "escalation_opened", data: { reasonType, escalationId: created?.id } });
    console.info("Human escalation:", JSON.stringify({ taskId, runId, reasonType, escalationId: created?.id }));
    return created!;
  });
}
export async function listOpenEscalations() {
  return db.select().from(escalations).where(eq(escalations.status, "open")).orderBy(asc(escalations.createdAt));
}
export async function answerEscalation(escalationId: string, answer: string) {
  z.uuid().parse(escalationId);
  answer = z.string().trim().min(1).max(6000).parse(answer);
  const [entry] = await db.select().from(escalations).where(eq(escalations.id, escalationId));
  if (!entry) throw new Error("Escalation does not exist.");
  const [task] = await db.select().from(tasks).where(eq(tasks.id, entry.taskId));
  if (!task) throw new Error("Task does not exist.");
  await startQueue(task.queueName);
  return db.transaction(async tx => {
    // Always lock task then escalation, consistent with open/abandon.
    const [lockedTask] = await tx.select().from(tasks).where(eq(tasks.id, entry.taskId)).for("update");
    const [locked] = await tx.select().from(escalations).where(eq(escalations.id, escalationId)).for("update");
    if (!locked || locked.status !== "open") throw new Error("Escalation is not open.");
    if (!lockedTask || lockedTask.status !== "waiting_human") throw new Error("Task is not waiting for a human.");
    assertTransition(lockedTask.status, "queued");
    const jobId = await boss.send(lockedTask.queueName, { taskId: entry.taskId }, { db: fromDrizzle(tx, sql), retryLimit: 0, expireInSeconds: 3600 });
    if (!jobId) throw new Error("Could not enqueue resumed task.");
    await tx.update(escalations).set({ status: "resolved", answer, resolvedAt: new Date() }).where(eq(escalations.id, escalationId));
    await tx.update(tasks).set({ status: "queued", orchestration: { ...lockedTask.orchestration, phase: "decide", resumeEscalationId: escalationId }, updatedAt: new Date() }).where(eq(tasks.id, entry.taskId));
    await tx.insert(orchestrationEvents).values({ taskId: entry.taskId, runId: entry.runId, kind: "human_answered", data: { escalationId, jobId } });
    return { escalationId, taskId: entry.taskId, status: "resolved" as const, taskStatus: "queued" as const, jobId };
  });
}
export async function abandonTask(taskId: string) {
  z.uuid().parse(taskId);
  await db.transaction(async tx => {
    const [task] = await tx.select().from(tasks).where(eq(tasks.id, taskId)).for("update");
    if (!task || task.status !== "waiting_human") throw new Error("Only a waiting_human task can be abandoned.");
    assertTransition(task.status, "failed");
    await tx.update(escalations).set({ status: "cancelled", resolvedAt: new Date() }).where(and(eq(escalations.taskId, taskId), eq(escalations.status, "open")));
    await tx.update(tasks).set({ status: "failed", updatedAt: new Date() }).where(eq(tasks.id, taskId));
    await tx.insert(orchestrationEvents).values({ taskId, kind: "human_abandoned", data: {} });
  });
}
