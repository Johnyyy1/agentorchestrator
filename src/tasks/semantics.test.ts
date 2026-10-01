import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeTaskSemantics } from "./semantics.js";
import { routeCapability } from "../router/capability-router.js";
import { validateDecision } from "../chief/schema.js";
import { submitDecision } from "../chief/submit-decision.js";
import type { TaskSpec } from "../workers/types.js";

const regression: TaskSpec = { title: "Smoke", category: "utility", repository: { path: "/fixture/repo" },
  objective: "Create docs/smoke.md", acceptanceCriteria: ["docs/smoke.md exists", "No unrelated files changed"],
  difficulty: 1, risk: "low", context: [], maxAttempts: 1 };
const availability = { opencode: { available: true }, codex: { available: true }, antigravity: { available: true } };
const decision = { action: "create_task", summary: "Smoke", reason: "Create documentation", capability: "local-coding",
  workerBrief: "Inspect repository first; change only docs/smoke.md.", task: regression };

test("exact Chief regression is normalized before submission and routes to OpenCode", async () => {
  const parsed = validateDecision(decision);
  assert.equal(parsed.action === "create_task" && parsed.task.category, "coding");
  let calls = 0;
  await submitDecision(decision, { createTask: async (spec, queueName, recommendation) => {
    calls++;
    assert.equal(spec.category, "coding");
    assert.equal(routeCapability(spec, recommendation?.capability, availability).route.worker, "opencode");
    return { ...spec, id: "fixture", chief: recommendation!, repository: spec.repository!, queueName: queueName ?? "fixture",
      status: "queued", orchestration: null, createdAt: new Date(), updatedAt: new Date() };
  } });
  assert.equal(calls, 1);
  assert.equal(regression.category, "utility", "Normalization must not mutate caller data.");
  assert.equal(routeCapability(regression, "local-coding", availability).route.worker, "opencode");
  assert.equal(routeCapability({ ...regression, category: "planning" }, "strong-coding", availability).route.worker, "codex");
});

test("repository context preserves research, planning, review and utility without mutation", () => {
  for (const category of ["research", "planning", "review", "utility"] as const) {
    const task = { ...regression, category, objective: "Research how the repository currently handles auth",
      acceptanceCriteria: ["Describe existing code", "Do not modify README.md"] };
    assert.equal(normalizeTaskSemantics(task, "research").category, category);
    assert.equal(routeCapability(task, "research", availability).route.worker, "antigravity");
  }
  const planning = { ...regression, category: "planning" as const, objective: "Create a plan for improving README",
    acceptanceCriteria: ["Plan improvements to README without editing it"] };
  assert.equal(normalizeTaskSemantics(planning).category, "planning");
  assert.equal(routeCapability({ ...planning, repository: undefined }, undefined, availability).route.worker, "antigravity");
});

test("explicit file/code mutation in objective or criteria requires coding with a repository", () => {
  for (const objective of ["Add docs/foo.md", "Edit README according to this plan", "Fix a TypeScript test", "Refactor component", "Implement feature", "Update documentation"]) {
    assert.equal(normalizeTaskSemantics({ ...regression, objective }).category, "coding");
  }
  assert.equal(normalizeTaskSemantics({ ...regression, objective: "Follow the plan", acceptanceCriteria: ["Modify README.md"] }, "research").category, "coding");
});

test("coding category or capability without repository rejects before any task submission", async () => {
  for (const capability of ["local-coding", "strong-coding"] as const) {
    assert.throws(() => routeCapability({ ...regression, repository: undefined }, capability, availability), /require repository/);
    await assert.rejects(submitDecision({ ...decision, capability, task: { ...regression, repository: undefined } },
      { createTask: async () => { throw new Error("Must never submit"); } }), /require supplied repository/);
  }
  assert.throws(() => normalizeTaskSemantics({ ...regression, category: "coding", repository: undefined }), /require repository/);
});
