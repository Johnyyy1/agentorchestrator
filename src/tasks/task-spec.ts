import { z } from "zod";
import type { tasks } from "../db/schema.js";
import type { TaskSpec } from "../workers/types.js";

export const taskSpecSchema = z.object({
  title: z.string().min(1),
  objective: z.string().min(1),
  category: z.enum(["coding", "research", "planning", "review", "utility"]),
  difficulty: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
  risk: z.enum(["low", "medium", "high"]),
  context: z.array(z.string()),
  acceptanceCriteria: z.array(z.string()),
  maxAttempts: z.number().int().min(1),
  repository: z.object({
    path: z.string().min(1),
    baseBranch: z.string().min(1).optional(),
  }).optional(),
}) satisfies z.ZodType<TaskSpec>;

export function taskRowToSpec(row: typeof tasks.$inferSelect): TaskSpec {
  return taskSpecSchema.parse({
    title: row.title,
    objective: row.objective,
    category: row.category,
    difficulty: row.difficulty,
    risk: row.risk,
    context: row.context,
    acceptanceCriteria: row.acceptanceCriteria,
    maxAttempts: row.maxAttempts,
    ...(row.repository === null ? {} : { repository: row.repository }),
  });
}
