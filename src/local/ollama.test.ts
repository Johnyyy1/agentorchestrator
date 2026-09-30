import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { test } from "node:test";
import { checkOllama, generateStructured, OllamaError } from "./ollama.js";
import type { OllamaConfig } from "./ollama.js";
import { planGoal } from "../chief/chief.js";
import type { ChiefMetadata } from "../chief/chief.js";
import { ChiefError } from "../chief/errors.js";
import { chiefJsonSchema, buildChiefJsonSchema } from "../chief/schema.js";

const model = "fixture:local";
async function fixture(handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>, run: (config: OllamaConfig) => Promise<void>) {
  const server = createServer((req, res) => { void handler(req, res); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try { await run({ baseUrl: `http://127.0.0.1:${address.port}`, model, context: 16384, timeoutMs: 1000 }); }
  finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}
function send(res: ServerResponse, data: unknown) { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(data)); }
function ready(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.url === "/api/tags") { send(res, { models: [{ name: model }] }); return true; }
  if (req.url === "/api/show") { send(res, { capabilities: ["completion", "thinking"] }); return true; }
  return false;
}
const isCode = (code: string) => (error: unknown) => error instanceof OllamaError && error.code === code;

test("native local chat sends schema, resource limits, no tools; drops thinking and captures usage", async () => {
  let chatCalls = 0;
  await fixture(async (req, res) => {
    if (ready(req, res)) return;
    assert.equal(req.url, "/api/chat");
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(body.model, model);
    assert.equal(body.stream, false);
    assert.equal(body.think, false);
    assert.equal(body.tools, undefined);
    assert.deepEqual(body.options, { temperature: 0, num_ctx: 16384, num_predict: 3072 });
    assert.deepEqual(body.format, buildChiefJsonSchema({ userGoal: "Deploy this to production." }));
    chatCalls++;
    send(res, { model, done: true, done_reason: "stop", prompt_eval_count: 50, eval_count: 20,
      total_duration: 123000000, load_duration: 1000000,
      message: { content: JSON.stringify({ action: "ask_human", summary: "Deployment", reason: "Missing details", humanQuestion: "Which target and approval?" }), thinking: "PRIVATE TRACE" } });
  }, async (config) => {
    const metadata: ChiefMetadata[] = [];
    const decision = await planGoal({ userGoal: "Deploy this to production." }, { config, onMetadata: (item) => metadata.push(item) });
    assert.equal(decision.action, "ask_human");
    assert.equal(metadata[0]?.success, true);
    assert.equal(metadata[0]?.inputTokens, 50);
    assert.equal(metadata[0]?.outputTokens, 20);
    assert.ok(!JSON.stringify([decision, metadata]).includes("PRIVATE TRACE"));
    assert.equal(chatCalls, 1);
  });
});
test("readiness diagnoses missing, remote, embedding models and malformed inventory without generation", async () => {
  for (const mode of ["missing", "remote", "embedding", "malformed"] as const) {
    await fixture((req, res) => {
      if (req.url === "/api/tags") return send(res, mode === "malformed" ? {} : { models: mode === "missing" ? [] : [{ name: model }] });
      assert.equal(req.url, "/api/show");
      send(res, { capabilities: mode === "embedding" ? ["embedding"] : ["completion"], ...(mode === "remote" ? { remote_host: "remote" } : {}) });
    }, async (config) => {
      await assert.rejects(checkOllama(config), isCode({ missing: "model_missing", remote: "remote_model", embedding: "configuration", malformed: "bad_response" }[mode]));
    });
  }
});
test("offline, HTTP, malformed envelope, timeout and redirects have sanitized typed errors", async () => {
  for (const mode of ["http", "malformed", "timeout", "redirect", "truncated", "tool"] as const) {
    await fixture((req, res) => {
      if (ready(req, res)) return;
      if (mode === "timeout") return;
      if (mode === "http") { res.statusCode = 500; res.end("SECRET"); return; }
      if (mode === "redirect") { res.statusCode = 302; res.setHeader("Location", "https://example.com"); res.end(); return; }
      send(res, mode === "malformed" ? { error: "SECRET" } : { model, done: true,
        done_reason: mode === "truncated" ? "length" : "stop", message: { content: "{}", ...(mode === "tool" ? { tool_calls: [{}] } : {}) } });
    }, async (config) => {
      await assert.rejects(generateStructured([], chiefJsonSchema, config), (error: unknown) => {
        assert.ok(error instanceof OllamaError);
        assert.equal(error.code, mode === "http" ? "http" : mode === "timeout" ? "timeout" : mode === "redirect" ? "offline" : "bad_response");
        assert.ok(!error.message.includes("SECRET"));
        return true;
      });
    });
  }
  let closedConfig: OllamaConfig | undefined;
  await fixture((_req, res) => { res.end(); }, async (config) => { closedConfig = config; });
  assert.ok(closedConfig);
  await assert.rejects(checkOllama(closedConfig), isCode("offline"));
});
test("planner rejects invalid input before inference and malformed decisions without retries", async () => {
  for (const content of ["not JSON", JSON.stringify({ action: "create_task" })]) {
    let calls = 0;
    await fixture((req, res) => {
      if (ready(req, res)) return;
      calls++;
      send(res, { model, done: true, message: { content } });
    }, async (config) => {
      await assert.rejects(planGoal({ userGoal: "" }, { config }), (error: unknown) => error instanceof ChiefError && error.code === "invalid_input");
      assert.equal(calls, 0);
      const metadata: ChiefMetadata[] = [];
      await assert.rejects(planGoal({ userGoal: "Code" }, { config, onMetadata: (item) => metadata.push(item) }), ChiefError);
      assert.equal(calls, 1);
      assert.equal(metadata[0]?.success, false);
    });
  }
});
test("remote endpoint and cloud model configuration rejected before network access", async () => {
  const config: OllamaConfig = { baseUrl: "http://127.0.0.1:11434", model, context: 16384, timeoutMs: 1000 };
  for (const patch of [{ baseUrl: "https://ollama.com" }, { baseUrl: "http://user:secret@localhost:11434" },
    { model: "qwen:cloud" }, { context: 262144 }, { timeoutMs: 0 }]) {
    await assert.rejects(checkOllama({ ...config, ...patch }), isCode("configuration"));
  }
});
