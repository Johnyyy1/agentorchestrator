import { checkOpenCode } from "../local/opencode.js";
import type { ProviderAvailability } from "./capability-router.js";

// Cloud workers retain their existing execution-time checks. No inference here.
export async function providerAvailability(checkLocal: boolean): Promise<ProviderAvailability> {
  const local = checkLocal ? await checkOpenCode() : null;
  return {
    opencode: local ? { available: local.available, model: `ollama/${local.model}`,
      ...(local.error && ["context_mismatch", "configuration", "unsupported_cli", "sandbox_unavailable"].includes(local.error.code) ? { infrastructure: true } : {}),
      ...(local.error ? { reason: `${local.error.code}: ${local.error.message}` } : {}) } :
      { available: false, reason: "Local readiness was not needed." },
    codex: { available: true }, antigravity: { available: true },
  };
}
