import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { taskSpecSchema } from "../tasks/task-spec.js";
import { capabilitySchema } from "./capabilities.js";
import { ChiefError } from "./errors.js";

const text = (max: number) => z.string().min(1).max(max).refine((s) => s.trim().length > 0);
const stateItems = z.array(text(1000)).max(10).optional();
export const chiefInputSchema = z.strictObject({
  userGoal: text(4000),
  project: z.strictObject({
    name: text(200).optional(),
    repositoryPath: text(1000).refine(isAbsolute, "Use an absolute repository path.").optional(),
    baseBranch: text(200).optional(),
    summary: text(4000).optional(),
    roadmapExcerpt: text(4000).optional(),
  }).optional(),
  recentState: z.strictObject({
    completedTasks: stateItems, failedTasks: stateItems, openTasks: stateItems, decisions: stateItems,
  }).optional(),
}).refine((input) => JSON.stringify(input).length <= 16000, "Chief context must be compact (at most 16000 characters).");
export type ChiefInput = z.infer<typeof chiefInputSchema>;

// Derive the domain fields, then tighten only the planner boundary and output size.
const chiefTaskSchema = taskSpecSchema.extend({
  title: z.string().min(1).max(300),
  objective: z.string().min(1).max(4000),
  context: z.array(z.string().min(1).max(2000)).max(20),
  acceptanceCriteria: z.array(z.string().min(1).max(1000)).min(1).max(15),
  maxAttempts: taskSpecSchema.shape.maxAttempts.max(3),
  repository: taskSpecSchema.shape.repository.unwrap().strict().optional(),
}).strict();
const common = { summary: z.string().min(1).max(1000), reason: z.string().min(1).max(1000) };
export const chiefDecisionSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("create_task"), ...common, capability: capabilitySchema,
    task: chiefTaskSchema, workerBrief: z.string().min(1).max(6000),
  }),
  z.strictObject({ action: z.literal("ask_human"), ...common, humanQuestion: z.string().min(1).max(2000) }),
  z.strictObject({ action: z.literal("no_action"), ...common }),
]);
export type ChiefDecision = z.infer<typeof chiefDecisionSchema>;
const toGenerationSchema = (schema: z.ZodType) => z.toJSONSchema(schema, {
  target: "draft-07",
  // Ollama 0.32.14 rejects grammar compilation for large maxLength repetitions.
  // Preserve the union/required fields/enums/minima in constrained generation;
  // all size maxima remain mandatory in the authoritative Zod validation below.
  override: ({ jsonSchema }) => { delete jsonSchema.maxLength; },
});
export const chiefJsonSchema = toGenerationSchema(chiefDecisionSchema);

export function buildChiefJsonSchema(input: ChiefInput) {
  const repositoryPath = input.project?.repositoryPath;
  const baseBranch = input.project?.baseBranch;
  // Ground optional repository fields during generation as well as after parsing.
  const repositorySchema = z.strictObject({
    path: z.literal(repositoryPath ?? ""),
    ...(baseBranch === undefined ? {} : { baseBranch: z.literal(baseBranch).optional() }),
  });
  const task = repositoryPath === undefined
    ? chiefTaskSchema.omit({ repository: true })
    : chiefTaskSchema.extend({ repository: repositorySchema.optional() });
  return toGenerationSchema(z.discriminatedUnion("action", [
    chiefDecisionSchema.options[0].extend({ task }),
    chiefDecisionSchema.options[1], chiefDecisionSchema.options[2],
  ]));
}

export function validateDecision(value: unknown): ChiefDecision {
  const parsed = chiefDecisionSchema.safeParse(value);
  if (!parsed.success) throw new ChiefError("invalid_decision", "Chief output does not match the decision schema; nothing was submitted.");
  // JSON Schema cannot express whitespace-only strings; enforce this again in code.
  if (JSON.stringify(parsed.data).length > 30000 || containsBlank(parsed.data)) {
    throw new ChiefError("invalid_decision", "Chief output contains blank fields or exceeds the size limit; nothing was submitted.");
  }
  return parsed.data;
}
function containsBlank(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length === 0;
  if (Array.isArray(value)) return value.some(containsBlank);
  return value !== null && typeof value === "object" && Object.values(value).some(containsBlank);
}
export function parseChiefOutput(content: string): ChiefDecision {
  let value: unknown;
  try { value = JSON.parse(content); }
  catch { throw new ChiefError("invalid_json", "Chief returned malformed JSON; nothing was submitted."); }
  return validateDecision(value);
}
export function validateGrounding(decision: ChiefDecision, input: ChiefInput): void {
  if (decision.action !== "create_task" || !decision.task.repository) return;
  const repository = decision.task.repository;
  if (!isAbsolute(repository.path) || !input.project?.repositoryPath ||
      resolve(repository.path) !== resolve(input.project.repositoryPath) ||
      (repository.baseBranch !== undefined && repository.baseBranch !== input.project.baseBranch)) {
    throw new ChiefError("ungrounded_repository", "Chief supplied repository context that was not provided by the caller; nothing was submitted.");
  }
}
