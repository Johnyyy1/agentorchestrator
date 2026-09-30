import assert from "node:assert/strict";
import { decideRepair } from "./chief/repair.js";
import { repairDecisionSchema } from "./chief/repair-schema.js";
import { getOllamaConfig } from "./local/ollama.js";
const config = getOllamaConfig();
const watchdog = setTimeout(() => { console.error("Local repair smoke exceeded its deadline."); process.exit(1); }, config.timeoutMs + 15000);
try {
  const decision = await decideRepair({ title: "Fix value calculation", objective: "value() must return the integer 4.",
    taskContext: [], acceptanceCriteria: ["Existing node:test assertion value() === 4 passes; preserve tests."], originalWorkerBrief: "Implement value() in value.ts; no other changes.",
    attempt: 1, maxAttempts: 2, worker: "opencode", workerSummary: "Implemented value() returning 3.", error: "Deterministic test failed.",
    verification: [{ name: "test", success: false, skipped: false, stdout: "expected 4 but received 3", stderr: "AssertionError: 3 !== 4" }],
    changedFiles: ["value.ts"], diffStat: "value.ts | 1 +", diff: "+export function value(): number { return 3; }", omitted: false,
    previousDecisions: [], review: null, humanAnswers: [],
  }, { config });
  assert.ok(repairDecisionSchema.safeParse(decision).success);
  console.log(JSON.stringify({ smoke: "LOCAL_REPAIR_OK", action: decision.action, ...(decision.action === "repair" ? { capability: decision.capability } : {}), model: config.model }));
} catch (error) { console.error(error instanceof Error ? error.message : "Local repair smoke failed."); process.exitCode = 1; }
finally { clearTimeout(watchdog); }
