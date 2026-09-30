import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, realpath, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { assertIndependent, reviewerCandidates } from "./policy.js";
import { reviewSchema } from "./schema.js";
import { parseReviewOutput, reviewSandboxProfile, runReview, reviewerAvailability } from "./adapter.js";
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
test("review OS boundary denies worktree/original writes, symlink escapes and subprocess execution", { timeout: 10000 }, async () => {
  assert.equal(process.platform, "darwin", "Reviewer enforcement fixture requires macOS.");
  const root = await realpath(await mkdtemp(join(tmpdir(), "jonas-review-test-")));
  const runtime = join(root, "runtime"); await mkdir(runtime);
  const target = join(root, "code.ts"); await writeFile(target, "baseline");
  try {
    const output = await execa("/usr/bin/sandbox-exec", ["-p", reviewSandboxProfile(runtime, await realpath(process.execPath)), process.execPath, "-e", `
      const assert = require('node:assert/strict'); const fs = require('node:fs');
      assert.throws(() => fs.writeFileSync(${JSON.stringify(target)}, 'unsafe'));
      assert.throws(() => fs.readFileSync(${JSON.stringify(target)}));
      fs.symlinkSync(${JSON.stringify(target)}, 'escape');
      assert.throws(() => fs.writeFileSync('escape', 'unsafe'));
      const child = require('node:child_process').spawnSync('/bin/sh', ['-c', 'echo unsafe']);
      assert.ok(child.error || child.status !== 0);
      console.log('REVIEW_BOUNDARY_OK');
    `], { cwd: runtime, timeout: 5000 });
    assert.match(output.stdout, /REVIEW_BOUNDARY_OK/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("native fake reviewer CLIs use isolated snapshot mode, fixed flags and strict parsing without inference", { timeout: 20000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "jonas-review-cli-test-")));
  const previousPath = process.env.PATH;
  const target = join(root, "original.ts");
  await writeFile(target, "baseline");
  const code = `#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
int has(int n, char** args, const char* value) { for(int i=1;i<n;i++) if(!strcmp(args[i],value)) return 1; return 0; }
int main(int n, char** args) {
 if(has(n,args,"--help")) { puts("--json --sandbox --ignore-user-config --ignore-rules --json-schema --mode --disable-slash-commands"); return 0; }
 assert(getenv("DATABASE_URL") == NULL);
 assert(strstr(getenv("HOME"), "jonas-review-") != NULL);
 assert(fopen(${JSON.stringify(target)}, "r") == NULL);
 assert(fopen(${JSON.stringify(target)}, "w") == NULL);
 if(has(n,args,"exec")) {
  assert(has(n,args,"read-only") && has(n,args,"--ignore-user-config") && has(n,args,"--ignore-rules"));
  puts(${JSON.stringify(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(approve) } }))});
  puts(${JSON.stringify(JSON.stringify({ type: "turn.completed" }))});
 } else {
  assert(has(n,args,"plan") && has(n,args,"--sandbox") && has(n,args,"--json-schema") && has(n,args,"--disable-slash-commands"));
  puts(${JSON.stringify(JSON.stringify({ structured_output: approve, thinking: "PRIVATE" }))});
 }
 return 0;
}`;
  try {
    await writeFile(join(root, "fixture.c"), code);
    await execa("/usr/bin/cc", [join(root, "fixture.c"), "-o", join(root, "agy")], { timeout: 10000 });
    await execa("/usr/bin/cc", [join(root, "fixture.c"), "-o", join(root, "codex")], { timeout: 10000 });
    process.env.PATH = `${root}:${previousPath ?? ""}`;
    const available = await reviewerAvailability();
    assert.equal(available.antigravity?.available, true); assert.equal(available.codex?.available, true);
    const context = { title: "Snapshot", objective: "Keep behavior", taskContext: [], acceptanceCriteria: [], originalWorkerBrief: "",
      attempt: 1, maxAttempts: 2, worker: "opencode" as const, workerSummary: "", error: "", verification: [], changedFiles: [],
      diffStat: "", diff: "code snapshot", omitted: false, previousDecisions: [], review: null, humanAnswers: [] };
    for (const reviewer of ["antigravity", "codex"] as const) assert.deepEqual(await runReview(reviewer, context, new AbortController().signal), approve);
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
});
