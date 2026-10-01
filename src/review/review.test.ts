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
import { initialDiagnostics, normalizeReviewProcess, publicStderr, ReviewFailure } from "./diagnostics.js";
import { antigravityReviewJsonSchema } from "./adapter.js";

test("real CLI-compatible object schema has explicit fields; local validation stays strict", () => {
  assert.equal(antigravityReviewJsonSchema.type, "object");
  assert.ok(antigravityReviewJsonSchema.properties);
  assert.deepEqual(antigravityReviewJsonSchema.required, ["decision", "summary", "severity", "findings"]);
});
test("actual AGY SUCCESS/response envelope normalizes all verdicts and excludes private metadata", () => {
  for (const result of [approve, { decision: "request_changes", summary: "Subtracts", severity: "medium", findings: [finding] },
    { decision: "needs_human", summary: "Missing evidence", severity: "low", findings: [], humanQuestion: "Can you provide the contract?" }]) {
    const diagnostics = initialDiagnostics("/fake/agy", "antigravity");
    const normalized = normalizeReviewProcess({ exitCode: 0, stdout: JSON.stringify({ status: "SUCCESS", response: JSON.stringify(result),
      conversation_id: "private-session", duration_seconds: 0.1, num_turns: 1, usage: { thinking_tokens: 123 }, thinking: "PRIVATE" }), stderr: "" }, "antigravity", diagnostics, 100);
    assert.deepEqual(normalized, result); assert.equal(diagnostics.terminalStatus, "SUCCESS");
    assert.equal(diagnostics.resultField, "response"); assert.equal(diagnostics.modelOutputReceived, true);
    assert.equal(JSON.stringify(diagnostics).includes("PRIVATE"), false); assert.equal(JSON.stringify(diagnostics).includes("private-session"), false);
  }
});
test("nonzero exits, timeout, signals, empty/malformed output and schema failures reject with bounded safe categories", () => {
  const cases = [
    { stdout: JSON.stringify({ status: "SUCCESS", response: JSON.stringify(approve) }), exitCode: 1, kind: "infrastructure", parse: null },
    { stdout: "", exitCode: undefined, timedOut: true, signal: "SIGTERM", kind: "infrastructure", parse: "empty_output" },
    { stdout: "garbage PRIVATE", exitCode: 0, kind: "result", parse: "envelope_json" },
    { stdout: "", exitCode: 0, kind: "result", parse: "empty_output" },
    { stdout: JSON.stringify({ status: "SUCCESS", response: "{ malformed PRIVATE" }), exitCode: 0, kind: "result", parse: "result_json" },
    { stdout: JSON.stringify({ status: "SUCCESS", response: JSON.stringify({ ...approve, severity: "critical" }) }), exitCode: 0, kind: "result", parse: null },
    { stdout: JSON.stringify({ status: "ERROR", response: JSON.stringify(approve), error: "PRIVATE token=xyz" }), exitCode: 0, kind: "infrastructure", parse: null },
    { stdout: JSON.stringify({ status: "INTERRUPTED", response: JSON.stringify(approve) }), exitCode: 0, kind: "infrastructure", parse: null },
    { stdout: JSON.stringify({ status: "unknown", response: JSON.stringify(approve) }), exitCode: 0, kind: "infrastructure", parse: null },
    { stdout: "x".repeat(128001), exitCode: 0, kind: "result", parse: "output_too_large" },
  ];
  for (const fixture of cases) {
    const diagnostics = initialDiagnostics("/fake/agy", "antigravity");
    const output = { stdout: fixture.stdout, stderr: "Error: unavailable token=supersecret", ...(fixture.exitCode == null ? {} : { exitCode: fixture.exitCode }),
      ...("timedOut" in fixture ? { timedOut: fixture.timedOut, signal: fixture.signal } : {}) };
    assert.throws(() => normalizeReviewProcess(output, "antigravity", diagnostics, 42), error => {
      assert.ok(error instanceof ReviewFailure); assert.equal(error.diagnostics.failureKind, fixture.kind);
      assert.equal(error.diagnostics.jsonParseError, fixture.parse); assert.equal(error.diagnostics.durationMs, 42);
      assert.equal(JSON.stringify(error.diagnostics).includes("PRIVATE"), false); assert.equal(JSON.stringify(error.diagnostics).includes("supersecret"), false);
      if ("timedOut" in fixture) { assert.equal(error.diagnostics.timedOut, true); assert.equal(error.diagnostics.signal, "SIGTERM"); }
      return true;
    });
  }
});
test("stderr keeps only bounded public errors with obvious secrets redacted", () => {
  const value = publicStderr('DEBUG raw environment\n<think>\nError: PRIVATE reasoning\n</think>\nError: auth {"access_token":"ya29.secret","id_token":"eyJfoo.bar.baz"} Bearer abc123 password=abc\n' + 'Error: retry\n'.repeat(300));
  assert.ok(value.length <= 1000); assert.match(value, /auth/);
  for (const secret of ["PRIVATE", "environment", "ya29.secret", "eyJfoo.bar.baz", "abc123", "password=abc"]) assert.equal(value.includes(secret), false);
  assert.equal(publicStderr("just arbitrary model text"), "");
});
