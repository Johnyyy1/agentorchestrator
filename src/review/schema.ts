import { z } from "zod";
const text = (max: number) => z.string().trim().min(1).max(max);
export const findingSchema = z.strictObject({
  file: text(500).optional(), line: z.number().int().positive().optional(),
  category: z.enum(["correctness", "security", "architecture", "maintainability", "requirements", "testing", "other"]),
  description: text(1000), reason: text(1000), suggestedFix: text(2000).optional(),
});
const common = { summary: text(2000), severity: z.enum(["none", "low", "medium", "high", "critical"]) };
export const reviewSchema = z.discriminatedUnion("decision", [
  z.strictObject({ decision: z.literal("approve"), ...common, severity: z.enum(["none", "low"]), findings: z.array(findingSchema).max(20) }),
  z.strictObject({ decision: z.literal("request_changes"), ...common, severity: z.enum(["low", "medium", "high", "critical"]), findings: z.array(findingSchema).min(1).max(20) }),
  z.strictObject({ decision: z.literal("needs_human"), ...common, findings: z.array(findingSchema).max(20), humanQuestion: text(2000) }),
]);
export type ReviewResult = z.infer<typeof reviewSchema>;
export const reviewJsonSchema = z.toJSONSchema(reviewSchema, { target: "draft-07" });
// AGY's schema enforcement consumes root properties, rather than the root oneOf emitted for a union.
// The wire schema constrains common fields; reviewSchema still validates decision-specific requirements.
export const antigravityReviewJsonSchema = z.toJSONSchema(z.strictObject({
  decision: z.enum(["approve", "request_changes", "needs_human"]), ...common,
  findings: z.array(findingSchema).max(20), humanQuestion: text(2000).optional(),
}), { target: "draft-07" });
