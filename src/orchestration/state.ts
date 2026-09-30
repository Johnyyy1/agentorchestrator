import { z } from "zod";
import { recommendationSchema } from "../router/recommendation.js";
import { repairDecisionSchema } from "../chief/repair-schema.js";

export const taskStatuses = ["pending", "queued", "running", "repairing", "reviewing", "waiting_human", "completed", "failed"] as const;
export type TaskStatus = typeof taskStatuses[number];
const transitions: Record<TaskStatus, readonly TaskStatus[]> = {
  pending: ["queued", "running", "failed"], queued: ["running", "repairing", "reviewing", "waiting_human", "failed"],
  running: ["repairing", "reviewing", "waiting_human", "completed", "failed"],
  repairing: ["running", "waiting_human", "failed"], reviewing: ["repairing", "waiting_human", "completed", "failed"],
  waiting_human: ["queued", "failed"], completed: [], failed: [],
};
export function assertTransition(from: string, to: TaskStatus): void {
  if (from === to) return;
  if (!taskStatuses.includes(from as TaskStatus) || !transitions[from as TaskStatus].includes(to)) {
    throw new Error(`Illegal task transition: ${from} → ${to}`);
  }
}
export function effectiveAttempts(maxAttempts: number): number {
  const cap = Number(process.env.JONAS_OS_MAX_ATTEMPTS ?? 3);
  if (!Number.isInteger(cap) || cap < 1 || cap > 3) throw new Error("JONAS_OS_MAX_ATTEMPTS must be an integer from 1 to 3.");
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error("Invalid maxAttempts.");
  return Math.min(maxAttempts, cap);
}
export const orchestrationStateSchema = z.strictObject({
  phase: z.enum(["ready", "executing", "after_attempt", "decide", "deciding", "decision", "review", "reviewing", "reviewed", "human", "done"]),
  latestRunId: z.uuid().optional(), resumeEscalationId: z.uuid().optional(), recommendation: recommendationSchema.optional(), decision: repairDecisionSchema.optional(),
});
export type OrchestrationState = z.infer<typeof orchestrationStateSchema>;
