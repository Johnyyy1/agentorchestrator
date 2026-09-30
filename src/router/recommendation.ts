import { z } from "zod";
import { capabilitySchema } from "../chief/capabilities.js";

// Execution metadata stays separate from TaskSpec and from the Chief's authority.
export const recommendationSchema = z.strictObject({
  capability: capabilitySchema,
  workerBrief: z.string().trim().min(1).max(6000),
});
export type Recommendation = z.infer<typeof recommendationSchema>;
