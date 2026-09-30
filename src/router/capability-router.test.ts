import assert from "node:assert/strict";
import { test } from "node:test";
import { routeCapability, eligibleForLocalCoding } from "./capability-router.js";
import type { ProviderAvailability } from "./capability-router.js";
import { routeTask } from "./router.js";
import type { TaskSpec } from "../workers/types.js";

const task: TaskSpec = { title: "Small change", objective: "Add a function", category: "coding", difficulty: 1,
  risk: "low", context: [], acceptanceCriteria: ["Tests pass"], maxAttempts: 1, repository: { path: "/fixture" } };
const available: ProviderAvailability = { opencode: { available: true, model: "ollama/fixture" }, codex: { available: true }, antigravity: { available: true } };

test("eligible low/medium coding uses OpenCode with model and requested capability metadata", () => {
  for (const risk of ["low", "medium"] as const) {
    const selected = routeCapability({ ...task, risk }, "local-coding", available, 2);
    assert.equal(selected.route.worker, "opencode");
    assert.equal(selected.metadata.requestedCapability, "local-coding");
    assert.equal(selected.metadata.model, "ollama/fixture");
    assert.equal(selected.metadata.fallbackReason, null);
  }
});
test("difficulty/risk overrides and strong-coding use Codex", () => {
  for (const patch of [{ difficulty: 5 as const }, { risk: "high" as const }, { difficulty: 3 as const }]) {
    const selected = routeCapability({ ...task, ...patch }, "local-coding", available, 2);
    assert.equal(selected.route.worker, "codex");
    assert.match(selected.metadata.fallbackReason!, /risk\/difficulty/);
  }
  assert.equal(routeCapability(task, "strong-coding", available, 2).route.worker, "codex");
  assert.equal(routeCapability({ ...task, difficulty: 3 }, "local-coding", available, 3).route.worker, "opencode");
});
test("research and strong-general route to Antigravity", () => {
  assert.equal(routeCapability({ ...task, category: "research" }, "research", available).route.worker, "antigravity");
  assert.equal(routeCapability({ ...task, category: "planning" }, "strong-general", available).route.tier, "pro");
});
test("non-coding recommendation and missing repository cannot select OpenCode", () => {
  const research = routeCapability({ ...task, category: "research" }, "local-coding", available);
  assert.equal(research.route.worker, "antigravity");
  assert.match(research.metadata.fallbackReason!, /Non-coding/);
  assert.equal(routeCapability({ ...task, repository: undefined }, "local-coding", available).route.worker, "codex");
  assert.equal(eligibleForLocalCoding(task, "strong-coding"), false);
});
test("local unavailability safely falls back with reason and actual worker", () => {
  const selected = routeCapability(task, "local-coding", { ...available, opencode: { available: false, reason: "model missing" } });
  assert.equal(selected.route.worker, "codex");
  assert.equal(selected.metadata.selectedWorker, "codex");
  assert.equal(selected.metadata.model, null);
  assert.match(selected.metadata.fallbackReason!, /model missing/);
  assert.throws(() => routeCapability(task, "strong-coding", { ...available, codex: { available: false } }), /unavailable/);
});
test("tasks without recommendations exactly preserve existing category routes", () => {
  for (const category of ["coding", "research", "planning", "review", "utility"] as const) {
    for (const difficulty of [1, 5] as const) {
      const spec = { ...task, category, difficulty };
      assert.deepEqual(routeCapability(spec, undefined, available).route, routeTask(spec));
    }
  }
});
test("unused local policy configuration cannot break legacy category execution", () => {
  const previous = process.env.LOCAL_CODING_MAX_DIFFICULTY;
  process.env.LOCAL_CODING_MAX_DIFFICULTY = "invalid";
  try {
    assert.deepEqual(routeCapability(task, undefined, available).route, routeTask(task));
    assert.equal(eligibleForLocalCoding(task, undefined), false);
    assert.equal(routeCapability(task, "strong-coding", available).route.worker, "codex");
    assert.throws(() => routeCapability(task, "local-coding", available), /LOCAL_CODING_MAX_DIFFICULTY/);
  } finally {
    if (previous === undefined) delete process.env.LOCAL_CODING_MAX_DIFFICULTY; else process.env.LOCAL_CODING_MAX_DIFFICULTY = previous;
  }
});
test("deferred capabilities remain recorded and never create independent review", () => {
  for (const capability of ["local-utility", "independent-review"] as const) {
    const selected = routeCapability({ ...task, category: "review" }, capability, available);
    assert.deepEqual(selected.route, routeTask({ ...task, category: "review" }));
    assert.equal(selected.metadata.requestedCapability, capability);
    assert.ok(selected.metadata.fallbackReason);
  }
  assert.throws(() => routeCapability(task, "local-coding", available, 5), /policy/);
});
