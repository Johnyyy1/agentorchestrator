import assert from "node:assert/strict";
import { test } from "node:test";
import { buildChiefJsonSchema, chiefDecisionSchema, chiefInputSchema, chiefJsonSchema, parseChiefOutput, validateDecision, validateGrounding } from "./schema.js";
import { ChiefError } from "./errors.js";
import { submitDecision } from "./submit-decision.js";
import { buildChiefMessages, chiefSystemPrompt } from "./prompt.js";
import { taskSpecSchema } from "../tasks/task-spec.js";

const task = {
  title: "Add clamp", objective: "Implement a pure numeric clamp function.",
  category: "coding", difficulty: 1, risk: "low", context: ["TypeScript ESM"],
  acceptanceCriteria: ["Unit tests cover bounds."], maxAttempts: 1,
  repository: { path: "/tmp/project", baseBranch: "main" },
};
const create = { action: "create_task", summary: "Add clamp", reason: "Small next feature",
  capability: "local-coding", task, workerBrief: "Implement clamp, test bounds, preserve unrelated files." };
const ask = { action: "ask_human", summary: "Clarification", reason: "Missing target", humanQuestion: "Which target?" };
const noop = { action: "no_action", summary: "No work", reason: "Acknowledgement only" };

test("strict union accepts each action and rejects inconsistent or unknown fields", () => {
  for (const value of [create, ask, noop]) assert.equal(chiefDecisionSchema.safeParse(value).success, true);
  const { task: _task, ...missingTask } = create;
  const { capability: _capability, ...missingCapability } = create;
  const { humanQuestion: _question, ...missingQuestion } = ask;
  const { workerBrief: _brief, ...missingBrief } = create;
  for (const value of [missingTask, missingCapability, missingQuestion, missingBrief,
    { ...create, humanQuestion: "Wrong" }, { ...ask, task }, { ...noop, task },
    { ...create, shell: "echo unauthorized" }, { ...create, task: { ...task, shell: "bad" } },
    { ...create, task: { ...task, repository: { path: "/tmp/project", unsafe: true } } },
    { ...create, capability: "concrete-provider" }, { ...ask, humanQuestion: "" }]) {
    assert.equal(chiefDecisionSchema.safeParse(value).success, false);
  }
  assert.ok(JSON.stringify(chiefJsonSchema).includes('"additionalProperties":false'));
  assert.ok(!JSON.stringify(chiefJsonSchema).includes('"maxLength"'));
});
test("TaskSpec invalid difficulty/category/risk/attempts and empty criteria are rejected", () => {
  for (const patch of [{ difficulty: 0 }, { difficulty: 6 }, { difficulty: 1.5 },
    { category: "deploy" }, { risk: "critical" }, { maxAttempts: 0 }, { maxAttempts: 4 }, { acceptanceCriteria: [] }]) {
    assert.throws(() => validateDecision({ ...create, task: { ...task, ...patch } }), ChiefError);
  }
  assert.throws(() => validateDecision({ ...create, workerBrief: "  " }), ChiefError);
  assert.throws(() => validateDecision({ ...create, workerBrief: "x".repeat(6001) }), ChiefError);
});
test("malformed output is rejected without Markdown stripping or regex recovery", () => {
  for (const content of ["not JSON", '```json\n{"action":"no_action"}\n```', JSON.stringify({ action: "create_task" })]) {
    assert.throws(() => parseChiefOutput(content), ChiefError);
  }
  assert.deepEqual(parseChiefOutput(JSON.stringify(create)), create);
});
test("input remains compact and repository grounding uses only caller context", () => {
  assert.equal(chiefInputSchema.safeParse({ userGoal: "  " }).success, false);
  assert.equal(chiefInputSchema.safeParse({ userGoal: "x".repeat(4001) }).success, false);
  assert.equal(chiefInputSchema.safeParse({ userGoal: "Code", project: { repositoryPath: "relative" } }).success, false);
  const decision = validateDecision(create);
  validateGrounding(decision, { userGoal: "Code", project: { repositoryPath: "/tmp/project", baseBranch: "main" } });
  for (const project of [undefined, { repositoryPath: "/tmp/other", baseBranch: "main" }, { repositoryPath: "/tmp/project" }]) {
    assert.throws(() => validateGrounding(decision, { userGoal: "Code", ...(project ? { project } : {}) }), ChiefError);
  }
  assert.ok(!/Codex|Antigravity/.test(chiefSystemPrompt));
  assert.equal(buildChiefMessages({ userGoal: "Code" }).length, 2);
});
test("generation schema grounds repository constants and omits unsupplied repository fields", () => {
  const at = (value: unknown, ...keys: string[]): unknown => keys.reduce<unknown>((item, key) =>
    item !== null && typeof item === "object" ? (item as Record<string, unknown>)[key] : undefined, value);
  const repositoryKeys = ["oneOf", "0", "properties", "task", "properties", "repository", "properties"];
  const schema = buildChiefJsonSchema({ userGoal: "Code", project: { repositoryPath: "/tmp/project", baseBranch: "main" } });
  assert.equal(at(schema, ...repositoryKeys, "path", "const"), "/tmp/project");
  assert.equal(at(schema, ...repositoryKeys, "baseBranch", "const"), "main");
  const noBranch = buildChiefJsonSchema({ userGoal: "Code", project: { repositoryPath: "/tmp/project" } });
  assert.equal(at(noBranch, ...repositoryKeys, "baseBranch"), undefined);
  const noRepository = buildChiefJsonSchema({ userGoal: "Code" });
  assert.equal(at(noRepository, ...repositoryKeys.slice(0, -1)), undefined);
});
test("submission revalidates, maps TaskSpec, reports recommendations, and never submits clarification/noop", async () => {
  let calls = 0;
  const createTask = async (spec: Parameters<typeof taskSpecSchema.parse>[0], queueName?: string, recommendation?: { capability: string; workerBrief: string }) => {
    calls++;
    assert.deepEqual(taskSpecSchema.parse(spec), task);
    assert.equal(queueName, "isolated");
    assert.deepEqual(recommendation, { capability: create.capability, workerBrief: create.workerBrief });
    return { ...taskSpecSchema.parse(spec), chief: { capability: "local-coding" as const, workerBrief: create.workerBrief }, repository: task.repository, id: "fake", status: "queued", createdAt: new Date(), updatedAt: new Date() };
  };
  const options = { createTask, queueName: "isolated" };
  assert.deepEqual(await submitDecision(ask, options), { action: "ask_human", humanQuestion: ask.humanQuestion });
  assert.deepEqual(await submitDecision(noop, options), { action: "no_action" });
  await assert.rejects(submitDecision({ ...create, task: { ...task, difficulty: 6 } }, options), ChiefError);
  assert.equal(calls, 0);
  const result = await submitDecision(create, options);
  assert.equal(result.action, "create_task");
  if (result.action === "create_task") {
    assert.equal(result.capability, create.capability);
    assert.equal(result.workerBrief, create.workerBrief);
  }
  assert.equal(calls, 1);
  await assert.rejects(submitDecision(create, { createTask: async () => { throw new Error("secret backend details"); } }),
    (error: unknown) => error instanceof ChiefError && error.code === "submission_failed" && !error.message.includes("secret"));
});
