import assert from "node:assert/strict";
import { test } from "node:test";
import { assertCodingCompletion } from "./completion.js";
import type { ExecutionResult } from "../workers/execute.js";
import type { TaskSpec } from "../workers/types.js";

const task: TaskSpec = { title: "Smoke", objective: "Create docs/smoke.md", category: "coding", difficulty: 1,
  risk: "low", context: [], acceptanceCriteria: ["File exists"], maxAttempts: 1, repository: { path: "/fixture/repo" } };
const workspace = { taskId: "task", repositoryPath: "/fixture/repo", path: "/fixture/worktree", branch: "task-branch", baseBranch: "main", baseCommit: "commit" };
const result: ExecutionResult = { task, success: true, workerStarted: true, route: { worker: "opencode", reason: "Local coding" },
  workerResult: { success: true, message: "Created docs/smoke.md" }, workspace, git: { changedFiles: ["docs/smoke.md"], statusShort: "?? docs/smoke.md", diffStat: "", dirty: true, truncated: false },
  verification: { success: true, packageManager: "npm", checks: [{ name: "test", command: "npm test", success: true,
    skipped: false, exitCode: 0, stdout: "", stderr: "", durationMs: 1, timedOut: false }] } };
const run = { id: "run", taskId: "task", worker: "opencode", status: "completed", workspace, result };
const review = { taskId: "task", runId: "run", reviewer: "antigravity", providerFamily: "google", status: "completed",
  result: { decision: "approve", severity: "none", summary: "Meets objective", findings: [] } };

test("successful final coding attempt with verifier PASS and independent APPROVE can complete", () => {
  assert.doesNotThrow(() => assertCodingCompletion("task", task, run, review));
});
test("repository coding cannot complete with missing/failed verifier, worker, workspace or inspection evidence", () => {
  for (const patch of [{ verification: undefined }, { verification: { ...result.verification!, success: false } },
    { verification: { ...result.verification!, checks: [] } }, { workspace: undefined }, { git: undefined },
    { workerStarted: false }, { workerResult: { success: false } }, { route: { worker: "antigravity" as const, reason: "General" } }]) {
    assert.throws(() => assertCodingCompletion("task", task, { ...run, result: { ...result, ...patch } }, review), /Execution incomplete/);
  }
  assert.throws(() => assertCodingCompletion("task", task, { ...run, workspace: null }, review), /Execution incomplete/);
});
test("verifier PASS cannot complete without matching independent final approval", () => {
  assert.throws(() => assertCodingCompletion("task", task, run), /Independent approval/);
  for (const patch of [{ runId: "previous" }, { taskId: "other" }, { status: "running" },
    { reviewer: "opencode", providerFamily: "qwen" }, { providerFamily: "openai" },
    { result: { ...review.result, decision: "request_changes" } }]) {
    assert.throws(() => assertCodingCompletion("task", task, run, { ...review, ...patch }), /Execution incomplete/);
  }
  assert.throws(() => assertCodingCompletion("task", task, { ...run, workspace: { ...workspace, baseCommit: "other" } }, review), /Execution incomplete/);
});

test("verified coding may complete without a worker summary", () => {
  for (const message of [undefined, null, ""]) assert.doesNotThrow(() =>
    assertCodingCompletion("task", task, { ...run, result: { ...result, workerResult: { success: true, message } } }, review));
});
