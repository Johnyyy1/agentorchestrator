import { desc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { tasks, runs, reviews, orchestrationEvents } from "../db/schema.js";
import { realpath } from "node:fs/promises";
import { assertTaskWorktree } from "../git/worktree.js";
import { taskRowToSpec } from "../tasks/task-spec.js";
import { assertCodingCompletion, CompletionInvariantError } from "./completion.js";
import { assertTransition } from "./state.js";
import type { OrchestrationState, TaskStatus } from "./state.js";

export async function saveState(taskId: string, status: TaskStatus, state: OrchestrationState,
  kind: string, data: unknown = {}): Promise<void> {
  await db.transaction(async tx => {
    const [row] = await tx.select().from(tasks).where(eq(tasks.id, taskId)).for("update");
    if (!row) throw new Error("Task disappeared.");
    assertTransition(row.status, status);
    if (status === "completed") await assertTaskCompletion(tx, row, state.latestRunId);
    await tx.update(tasks).set({ status, orchestration: state, updatedAt: new Date() }).where(eq(tasks.id, taskId));
    await tx.insert(orchestrationEvents).values({ taskId, runId: state.latestRunId ?? null, kind, data });
  });
  console.info("Orchestration:", JSON.stringify({ taskId, status, phase: state.phase, event: kind }));
}

// Both completion writers call this while holding the task row lock.
export async function assertTaskCompletion(tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  row: typeof tasks.$inferSelect, runId?: string): Promise<void> {
  const spec = taskRowToSpec(row);
  if (spec.category !== "coding") return;
  const [run] = await tx.select().from(runs).where(eq(runs.taskId, row.id)).orderBy(desc(runs.attempt), desc(runs.startedAt)).limit(1);
  if (!run || run.id !== runId) throw new CompletionInvariantError("Final attempt identity is missing or stale.");
  const [review] = await tx.select().from(reviews).where(eq(reviews.runId, run.id));
  assertCodingCompletion(row.id, spec, run, review);
  if (run.workspace!.repositoryPath !== await realpath(spec.repository!.path)) {
    throw new CompletionInvariantError("Retained worktree belongs to another repository.");
  }
  try { await assertTaskWorktree(run.workspace!); }
  catch { throw new CompletionInvariantError("Retained worktree is unavailable or invalid."); }
}
