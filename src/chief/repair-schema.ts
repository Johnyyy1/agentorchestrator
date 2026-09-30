import { z } from "zod";
const text = (max: number) => z.string().trim().min(1).max(max);
const common = { summary: text(1000), reason: text(2000) };
export const repairDecisionSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("repair"), ...common, capability: z.enum(["local-coding", "strong-coding"]), repairBrief: text(6000) }),
  z.strictObject({ action: z.literal("ask_human"), ...common, humanQuestion: text(2000) }),
  z.strictObject({ action: z.literal("give_up"), ...common }),
]);
export type RepairDecision = z.infer<typeof repairDecisionSchema>;
export const repairJsonSchema = z.toJSONSchema(repairDecisionSchema, { target: "draft-07", override: ({ jsonSchema }) => { delete jsonSchema.maxLength; } });
