import { taskSpecSchema } from "../tasks/task-spec.js";
import type { TaskSpec } from "../workers/types.js";
import type { tasks } from "../db/schema.js";
import type { Capability } from "./capabilities.js";
import { ChiefError } from "./errors.js";
import { validateDecision } from "./schema.js";
import type { Recommendation } from "../router/recommendation.js";

type TaskCreator = (task: TaskSpec, queueName?: string, recommendation?: Recommendation) => Promise<typeof tasks.$inferSelect>;
export type SubmissionResult =
  | { action: "create_task"; task: typeof tasks.$inferSelect; capability: Capability; workerBrief: string }
  | { action: "ask_human"; humanQuestion: string }
  | { action: "no_action" };

export async function submitDecision(
  value: unknown, options: { queueName?: string; createTask?: TaskCreator } = {},
): Promise<SubmissionResult> {
  const decision = validateDecision(value); // Revalidate even if the caller says it was validated.
  if (decision.action === "ask_human") return { action: decision.action, humanQuestion: decision.humanQuestion };
  if (decision.action === "no_action") return { action: decision.action };
  const spec = taskSpecSchema.parse(decision.task);
  // Lazy loading keeps pure planning/clarification independent of PostgreSQL configuration.
  try {
    const create = options.createTask ?? (await import("../tasks/create-task.js")).createTask;
    const task = await create(spec, options.queueName, { capability: decision.capability, workerBrief: decision.workerBrief });
    return { action: "create_task", task, capability: decision.capability, workerBrief: decision.workerBrief };
  } catch {
    throw new ChiefError("submission_failed", "Chief task submission failed. Check task persistence and queue health; createTask may retain a pending row. Do not retry blindly.");
  }
}
