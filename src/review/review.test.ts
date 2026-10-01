import assert from "node:assert/strict";
import { test } from "node:test";
import { assertIndependent, reviewerCandidates } from "./policy.js";
import { reviewSchema } from "./schema.js";
import { parseReviewOutput } from "./adapter.js";
const approve = { decision: "approve", summary: "Meets criteria", severity: "none", findings: [] };
const finding = { category: "correctness", description: "Wrong value", reason: "Violates expected result", suggestedFix: "Return 4" };
test("provider independence and fallback policy", () => {
  assert.deepEqual(reviewerCandidates("opencode"), ["antigravity", "codex"]);
  assert.deepEqual(reviewerCandidates("codex"), ["antigravity"]);
  assertIndependent("opencode", "antigravity"); assertIndependent("opencode", "codex");
  assert.throws(() => assertIndependent("opencode", "opencode")); assert.throws(() => assertIndependent("codex", "codex"));
});
test("review discriminated union enforces findings/questions/severity and strict fields", () => {
  for (const value of [approve, { decision: "request_changes", summary: "Fix", severity: "medium", findings: [finding] },
    { decision: "needs_human", summary: "Ambiguous", severity: "high", findings: [], humanQuestion: "Which contract?" }]) assert.ok(reviewSchema.safeParse(value).success);
  for (const value of [{ ...approve, severity: "critical" }, { ...approve, tool: "shell" },
    { decision: "request_changes", summary: "Fix", severity: "low", findings: [] },
    { decision: "needs_human", summary: "Ask", severity: "high", findings: [] },
    { ...approve, humanQuestion: "Wrong" }]) assert.equal(reviewSchema.safeParse(value).success, false);
});
test("only strict public structured results leave reviewer adapters", () => {
  assert.deepEqual(parseReviewOutput(JSON.stringify({ structured_output: approve, thinking: "PRIVATE" }), "antigravity"), approve);
  const events = [{ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(approve) } }, { type: "turn.completed" }];
  assert.deepEqual(parseReviewOutput(events.map(e => JSON.stringify(e)).join("\n"), "codex"), approve);
  assert.throws(() => parseReviewOutput("not JSON", "antigravity"));
  assert.throws(() => parseReviewOutput(JSON.stringify({ result: "```json\n{}\n```" }), "antigravity"));
});
