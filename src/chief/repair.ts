import { generateStructured } from "../local/ollama.js";
import type { OllamaConfig } from "../local/ollama.js";
import { repairDecisionSchema, repairJsonSchema } from "./repair-schema.js";
import { repairSystemPrompt } from "./repair-prompt.js";
import type { RepairContext } from "../orchestration/context.js";

export async function decideRepair(context: RepairContext, options: { config?: OllamaConfig; signal?: AbortSignal } = {}) {
  const content = JSON.stringify(context);
  if (content.length > 32000) throw new Error("Repair context exceeds its bound.");
  options.signal?.throwIfAborted();
  const generated = await generateStructured([
    { role: "system", content: repairSystemPrompt }, { role: "user", content },
  ], repairJsonSchema, options.config, options.signal);
  const decision = repairDecisionSchema.parse(JSON.parse(generated.content));
  console.info("Repair Chief:", JSON.stringify({ attempt: context.attempt, action: decision.action, model: generated.usage.model }));
  return decision;
}
