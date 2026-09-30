import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { repairDecisionSchema } from "./repair-schema.js";
import { decideRepair } from "./repair.js";
import { repairSystemPrompt } from "./repair-prompt.js";
import { assertTransition, effectiveAttempts } from "../orchestration/state.js";
import { redact } from "../orchestration/context.js";
import type { RepairContext } from "../orchestration/context.js";
const repair = { action: "repair", summary: "Fix value", reason: "Off by one", capability: "local-coding", repairBrief: "Return 4; preserve tests." };
export const context: RepairContext = { title: "Fix calculation", objective: "Return 4", taskContext: [], acceptanceCriteria: ["Returns 4"], originalWorkerBrief: "Fix number",
  attempt: 1, maxAttempts: 2, worker: "opencode", workerSummary: "Returned 3", error: "Verification failed", verification: [], changedFiles: [],
  diffStat: "", diff: "", omitted: false, previousDecisions: [], review: null, humanAnswers: [] };
test("repair union rejects policy fields, missing briefs/capabilities and inconsistent actions", () => {
  assert.ok(repairDecisionSchema.safeParse(repair).success);
  assert.ok(repairDecisionSchema.safeParse({ action: "ask_human", summary: "Help", reason: "Ambiguity", humanQuestion: "Which behavior?" }).success);
  assert.ok(repairDecisionSchema.safeParse({ action: "give_up", summary: "Stop", reason: "Unrecoverable" }).success);
  for (const patch of [{ maxAttempts: 100 }, { capability: "codex" }, { humanQuestion: "Override" }, { repairBrief: " " },
    { action: "give_up" }, { repairBrief: undefined }, { capability: undefined }]) assert.equal(repairDecisionSchema.safeParse({ ...repair, ...patch }).success, false);
  assert.match(repairSystemPrompt, /Never weaken\/remove tests/);
});
test("attempt cap is immutable, defaults to 3; illegal transitions rejected", () => {
  const previous = process.env.JONAS_OS_MAX_ATTEMPTS;
  try {
    delete process.env.JONAS_OS_MAX_ATTEMPTS;
    assert.equal(effectiveAttempts(99), 3); assert.equal(effectiveAttempts(2), 2);
    process.env.JONAS_OS_MAX_ATTEMPTS = "2"; assert.equal(effectiveAttempts(3), 2);
    process.env.JONAS_OS_MAX_ATTEMPTS = "4"; assert.throws(() => effectiveAttempts(2));
    assertTransition("running", "reviewing"); assertTransition("waiting_human", "queued");
    assert.throws(() => assertTransition("waiting_human", "running")); assert.throws(() => assertTransition("completed", "queued"));
  } finally { if (previous === undefined) delete process.env.JONAS_OS_MAX_ATTEMPTS; else process.env.JONAS_OS_MAX_ATTEMPTS = previous; }
});
test("context redacts common credentials", () => {
  assert.ok(!redact('password=secret123 Bearer abcdefghijkl api_key=abc https://user:pass@host').includes("secret123"));
});
test("repair bridge validates native output, drops thinking and makes no generation retries", async () => {
  let calls = 0;
  let invalid = false;
  const server = createServer(async (req, res) => {
    let data;
    if (req.url === "/api/tags") data = { models: [{ name: "fixture:local" }] };
    else if (req.url === "/api/show") data = { capabilities: ["completion", "thinking"] };
    else {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(input.think, false); assert.equal(input.tools, undefined); calls++;
      data = { model: "fixture:local", done: true, message: { thinking: "PRIVATE", content: invalid ? "{}" : JSON.stringify(repair) } };
    }
    res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(data));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  try {
    const config = { model: "fixture:local", baseUrl: `http://127.0.0.1:${address.port}`, context: 16384, timeoutMs: 1000 };
    assert.deepEqual(await decideRepair(context, { config }), repair); assert.equal(calls, 1);
    invalid = true; await assert.rejects(decideRepair(context, { config })); assert.equal(calls, 2);
    await assert.rejects(decideRepair({ ...context, diff: "x".repeat(33000) }, { config })); assert.equal(calls, 2);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
