import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { containsOpenCodeConfig, detectOpenCodeInterface } from "./opencode.js";
import { openCodeConfig } from "./opencode-config.js";
import { parseOpenCodeOutput, parseOpenCodeText } from "../workers/opencode.js";

const events = [
  { type: "step_start", sessionID: "ses_fixture", part: { type: "step-start" } },
  { type: "reasoning", part: { text: "PRIVATE TRACE" } },
  { type: "tool_use", part: { state: { input: "SECRET TOOL INPUT" } } },
  { type: "text", sessionID: "ses_fixture", part: { type: "text", text: "Function updated." } },
  { type: "step_finish", part: { reason: "stop", tokens: { input: 10, output: 5, reasoning: 2 } } },
].map(event => JSON.stringify(event)).join("\n");

test("JSONL parser preserves public result/totals and rejects incomplete/error/malformed output", () => {
  const parsed = parseOpenCodeOutput(events, 0, "ollama/fixture", 50, "\u001b[31m warning \u001b[0m");
  assert.equal(parsed.success, true);
  assert.equal(parsed.sessionId, "ses_fixture");
  assert.deepEqual(parsed.usage, { inputTokens: 10, outputTokens: 5, reasoningTokens: 2 });
  assert.equal(parsed.stderr, "warning");
  assert.ok(!JSON.stringify(parsed).includes("PRIVATE"));
  assert.ok(!JSON.stringify(parsed).includes("SECRET"));
  for (const output of ["", "not json", events + '\n{"type":"error"}', '{"type":"text","part":{"text":"partial"}}',
    events.replace('"stop"', '"length"')]) assert.equal(parseOpenCodeOutput(output, 0, "fixture", 1).success, false);
  assert.equal(parseOpenCodeOutput(events, 0, "fixture", 1, "", true, true).success, false);
});

test("valid terminal execution needs no public report; reasoning never substitutes for one", () => {
  const withoutText = events.split("\n").filter(line => JSON.parse(line).type !== "text").join("\n");
  const parsed = parseOpenCodeOutput(withoutText, 0, "fixture", 1);
  assert.equal(parsed.success, true);
  assert.equal(parsed.message, null);
  assert.equal(parsed.error, null);
  assert.equal(parsed.sessionId, "ses_fixture");
  assert.deepEqual(parsed.usage, { inputTokens: 10, outputTokens: 5, reasoningTokens: 2 });
  assert.equal(parsed.eventTypes?.reasoning, 1);
  assert.ok(!JSON.stringify(parsed).includes("PRIVATE TRACE"));
  assert.equal(parseOpenCodeText("", 0, "fixture", 1).success, true);
  assert.equal(parseOpenCodeText("", 0, "fixture", 1).message, null);
});
test("parser bounds streams and rejects explicit incomplete state, later starts and failed exits", () => {
  for (const output of [events + '\n{"type":"incomplete"}', events + '\n{"type":"step_start"}',
    events + '\n{"type":"step_finish","part":{"reason":"length"}}', 'x'.repeat(2 * 1024 * 1024 + 1),
    '\n'.repeat(4097), JSON.stringify({ type: "reasoning", part: { text: 'x'.repeat(256000) } })]) {
    assert.equal(parseOpenCodeOutput(output, 0, "fixture", 1).success, false);
  }
  assert.equal(parseOpenCodeOutput(events, 1, "fixture", 1).success, false);
  assert.equal(parseOpenCodeOutput(events, 0, "fixture", 1, "", false, true).success, false);
  const unrelated = parseOpenCodeOutput(events + '\n{"type":"unrelated"}', 0, "fixture", 1);
  assert.equal(unrelated.success, true);
  assert.equal(unrelated.message, "Function updated.");
});

// Exact relevant step envelopes captured from the one real repository E2E.
// OpenCode 1.18.33 emitted no public text event in that execution.
test("observed OpenCode 1.18.33 terminal envelopes succeed without a public summary", async () => {
  const observed = await readFile(new URL("./fixtures/opencode-1.18.33-no-summary.jsonl", import.meta.url), "utf8");
  const parsed = parseOpenCodeOutput(observed, 0, "ollama/qwen3.5:9b-q4_K_M", 1);
  assert.equal(parsed.success, true);
  assert.equal(parsed.message, null);
  assert.equal(parsed.sessionId, "ses_f0906717affeOZNWUI1MZFNE4N");
  assert.deepEqual(parsed.usage, { inputTokens: 9013, outputTokens: 518, reasoningTokens: 0 });
  assert.equal(parsed.eventTypes?.step_finish, 3);
  const truncated = observed.trim().split("\n").slice(0, -1).join("\n");
  assert.equal(parseOpenCodeOutput(truncated, 0, "fixture", 1).success, false);
});

test("capability detection and bounded text fallback fail safely", () => {
  assert.deepEqual(detectOpenCodeInterface(" -m, --model VALUE\n --agent AGENT\n --format [choices: default, json]"),
    { outputFormat: "json", agentFlag: true, titleFlag: false });
  assert.equal(detectOpenCodeInterface("--model VALUE").outputFormat, "text");
  assert.throws(() => detectOpenCodeInterface("--models VALUE"));
  const config = openCodeConfig("fixture", "http://127.0.0.1:11434", 16384);
  assert.equal(containsOpenCodeConfig({ ...config, username: "fixture" }, config), true);
  assert.equal(containsOpenCodeConfig({ ...config, permission: { ...config.permission, bash: "allow" } }, config), false);
  assert.equal(containsOpenCodeConfig({ ...config, enabled_providers: ["ollama", "cloud"] }, config), false);
  assert.equal(containsOpenCodeConfig({ ...config, mcp: { unexpected: { command: ["sh"] } } }, config), false);
  assert.equal(parseOpenCodeText("LOCAL_OPENCODE_OK", 0, "fixture", 1).success, true);
  for (const text of ["x".repeat(64001)]) assert.equal(parseOpenCodeText(text, 0, "fixture", 1).success, false);
  assert.equal(parseOpenCodeText("partial", 1, "fixture", 1).success, false);
  assert.equal(parseOpenCodeText("partial", 0, "fixture", 1, "", true, true).success, false);
});

test("agent denies shell, external paths, network tools, subagents, LSP and config edits", () => {
  const config = openCodeConfig("fixture", "http://127.0.0.1:11434", 16384);
  assert.equal(config.permission.bash, "deny");
  assert.equal(config.permission.external_directory, "deny");
  assert.equal(config.permission.task, "deny");
  assert.equal(config.permission.webfetch, "deny");
  assert.equal(config.lsp, false);
  assert.equal(config.formatter, false);
  assert.deepEqual(config.enabled_providers, ["ollama"]);
});

test("bounded safe tool diagnostics omit arbitrary errors, payloads, paths and hidden reasoning", () => {
  const output = [
    { type: "reasoning", part: { text: "SECRET REASONING" } },
    ...["read", "glob", "write", "edit"].map(tool => ({ type: "tool_use", part: { tool, state: { status: "completed", input: { filePath: "/repo/src/index.ts", content: "SECRET INPUT" }, output: "SECRET FILE CONTENT" } } })),
    { type: "tool_use", part: { tool: "read", state: { status: "error", input: { filePath: "/outside/credentials" }, error: "EACCES permission denied /outside/credentials SECRET TOKEN" } } },
    { type: "step_finish", part: { reason: "length" } },
  ].map(event => JSON.stringify(event)).join("\n");
  const result = parseOpenCodeOutput(output, 0, "fixture", 1, "", false, false, "/repo");
  assert.equal(result.success, false); assert.equal(result.failureKind, "execution");
  assert.match(result.error!, /read: Tool operation was denied access/);
  assert.equal(result.toolDiagnostics?.[0]?.path, "src/index.ts");
  assert.equal(result.toolDiagnostics?.at(-1)?.pathScope, "external");
  assert.equal(result.toolDiagnostics?.at(-1)?.code, "EACCES");
  for (const secret of ["SECRET", "credentials", "/outside", "FILE CONTENT"]) assert.ok(!JSON.stringify(result).includes(secret));
  assert.ok(result.toolDiagnostics!.every(item => (item.message?.length ?? 0) <= 500));
  const many = Array.from({ length: 100 }, () => JSON.stringify({ type: "tool_use", part: { tool: "read", state: { status: "error", error: "SECRET".repeat(1000) } } })).join("\n");
  assert.equal(parseOpenCodeOutput(many, 0, "fixture", 1).toolDiagnostics?.length, 32);
  assert.ok(!JSON.stringify(parseOpenCodeOutput(many, 0, "fixture", 1)).includes("SECRET"));
});

test("only explicit search executable failures classify infrastructure; tool/model mistakes retain repair semantics", () => {
  const output = (error: string, tool = "glob") => JSON.stringify({ type: "tool_use", part: { tool, state: { status: "error", error } } }) + '\n{"type":"step_finish","part":{"reason":"length"}}';
  assert.equal(parseOpenCodeOutput(output("ripgrep execution failed"), 0, "fixture", 1).failureKind, "infrastructure");
  for (const error of ["File not found", "permission rejected", "Invalid arguments", "invalid regex rg", "EACCES"]) {
    assert.equal(parseOpenCodeOutput(output(error), 0, "fixture", 1).failureKind, "execution");
  }
  assert.equal(parseOpenCodeOutput(output("ripgrep execution failed", "read"), 0, "fixture", 1).failureKind, "execution");
});

test("public terminal length reason is reported without inventing a tool failure", () => {
  const result = parseOpenCodeOutput('{"type":"step_finish","part":{"reason":"length"}}', 0, "fixture", 1);
  assert.equal(result.success, false); assert.match(result.error!, /Step reason: length/);
  assert.ok(!result.error!.includes("tool error"));
});

test("a recovered infrastructure tool failure cannot misclassify later model truncation", () => {
  const events = [
    { type: "tool_use", part: { tool: "glob", state: { status: "error", error: "ripgrep execution failed" } } },
    ...Array.from({ length: 35 }, () => ({ type: "tool_use", part: { tool: "read", state: { status: "completed" } } })),
    { type: "tool_use", part: { tool: "glob", state: { status: "completed" } } },
    { type: "step_finish", part: { reason: "length" } },
  ].map(event => JSON.stringify(event)).join("\n");
  const result = parseOpenCodeOutput(events, 0, "fixture", 1);
  assert.equal(result.success, false); assert.equal(result.failureKind, "execution");
  assert.equal(result.toolDiagnostics?.length, 32);
});
