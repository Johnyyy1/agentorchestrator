import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { tasks, orchestrationEvents } from "../db/schema.js";
import { assertTransition } from "./state.js";
import type { OrchestrationState, TaskStatus } from "./state.js";

export async function saveState(taskId: string, status: TaskStatus, state: OrchestrationState,
  kind: string, data: unknown = {}): Promise<void> {
  await db.transaction(async tx => {
    const [row] = await tx.select().from(tasks).where(eq(tasks.id, taskId)).for("update");
    if (!row) throw new Error("Task disappeared.");
    assertTransition(row.status, status);
    await tx.update(tasks).set({ status, orchestration: state, updatedAt: new Date() }).where(eq(tasks.id, taskId));
    await tx.insert(orchestrationEvents).values({ taskId, runId: state.latestRunId ?? null, kind, data });
  });
  console.info("Orchestration:", JSON.stringify({ taskId, status, phase: state.phase, event: kind }));
}
