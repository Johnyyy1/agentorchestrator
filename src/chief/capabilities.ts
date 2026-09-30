import { z } from "zod";

export const capabilityNames = [
  "local-utility", "local-coding", "strong-coding", "strong-general",
  "research", "independent-review",
] as const;
export const capabilitySchema = z.enum(capabilityNames);
export type Capability = z.infer<typeof capabilitySchema>;
export const capabilities: Record<Capability, string> = {
  "local-utility": "Small local reasoning or text transformation.",
  "local-coding": "Easy, low-risk coding suitable for a local worker.",
  "strong-coding": "Complex repository coding work.",
  "strong-general": "Complex planning or reasoning.",
  research: "External or general research.",
  "independent-review": "Review through a separate execution path.",
};
