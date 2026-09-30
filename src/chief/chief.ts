import { generateStructured, getOllamaConfig, OllamaError } from "../local/ollama.js";
import type { OllamaConfig, OllamaUsage } from "../local/ollama.js";
import { ChiefError } from "./errors.js";
import { buildChiefMessages } from "./prompt.js";
import { chiefInputSchema, buildChiefJsonSchema, parseChiefOutput, validateGrounding } from "./schema.js";
import type { ChiefInput, ChiefDecision } from "./schema.js";

export type ChiefMetadata = OllamaUsage & { success: boolean; action?: ChiefDecision["action"]; errorCode?: string };
export type ChiefOptions = { config?: OllamaConfig; onMetadata?: (metadata: ChiefMetadata) => void };

export async function planGoal(input: ChiefInput, options: ChiefOptions = {}): Promise<ChiefDecision> {
  const started = performance.now();
  let usage: OllamaUsage | undefined;
  let config: OllamaConfig | undefined;
  const report = (metadata: ChiefMetadata) => {
    console.info("Local Chief:", JSON.stringify(metadata));
    // Observers must not change the planning outcome or trigger a second inference.
    try { options.onMetadata?.(metadata); } catch { /* Observer failure is isolated. */ }
  };
  try {
    const parsed = chiefInputSchema.safeParse(input);
    if (!parsed.success) throw new ChiefError("invalid_input", "Chief input is invalid or too large; supply a goal and compact explicit context.");
    config = options.config ?? getOllamaConfig();
    const generated = await generateStructured(buildChiefMessages(parsed.data), buildChiefJsonSchema(parsed.data), config);
    usage = generated.usage;
    const decision = parseChiefOutput(generated.content);
    validateGrounding(decision, parsed.data);
    report({ ...usage, durationMs: Math.round(performance.now() - started), success: true, action: decision.action });
    return decision;
  } catch (error) {
    report({ ...(usage ?? { model: config?.model ?? "unconfigured" }), durationMs: Math.round(performance.now() - started),
      success: false, errorCode: error instanceof ChiefError || error instanceof OllamaError ? error.code : "internal" });
    if (error instanceof ChiefError || error instanceof OllamaError) throw error;
    throw new ChiefError("invalid_decision", "Chief planning failed; nothing was submitted.");
  }
}
