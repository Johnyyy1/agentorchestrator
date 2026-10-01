import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, realpath, rm, writeFile, mkdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { assertIndependent, reviewerCandidates } from "./policy.js";
import { reviewSchema } from "./schema.js";
import { parseReviewOutput, reviewSandboxProfile, runReview, reviewerAvailability, createReviewRuntime } from "./adapter.js";
const approve = { decision: "approve", summary: "Meets criteria", severity: "none", findings: [] };
const finding = { category: "correctness", description: "Wrong value", reason: "Violates expected result", suggestedFix: "Return 4" };
test("review OS boundary denies worktree/original writes, symlink escapes and subprocess execution", { timeout: 10000 }, async () => {
  assert.equal(process.platform, "darwin", "Reviewer enforcement fixture requires macOS.");
  const root = await realpath(await mkdtemp(join(tmpdir(), "jonas-review-test-")));
  const runtime = join(root, "runtime"); await mkdir(runtime);
  const target = join(root, "code.ts"); await writeFile(target, "baseline");
  try {
    const output = await execa("/usr/bin/sandbox-exec", ["-p", reviewSandboxProfile(runtime, await realpath(process.execPath), "antigravity"), process.execPath, "-e", `
      const assert = require('node:assert/strict'); const fs = require('node:fs');
      assert.throws(() => fs.writeFileSync(${JSON.stringify(target)}, 'unsafe'));
      assert.throws(() => fs.readFileSync(${JSON.stringify(target)}));
      fs.symlinkSync(${JSON.stringify(target)}, 'escape');
      assert.throws(() => fs.writeFileSync('escape', 'unsafe'));
      const child = require('node:child_process').spawnSync('/bin/sh', ['-c', 'echo unsafe']);
      assert.ok(child.error || child.status !== 0);
      const security = require('node:child_process').spawnSync('/usr/bin/security', ['find-generic-password', '-s', 'gemini', '-a', 'antigravity']);
      assert.ok(security.error || security.status !== 0);
      const net = require('node:net');
      const local = net.createServer(); local.listen(0, '127.0.0.1', () => local.close());
      local.on('close', () => console.log('REVIEW_BOUNDARY_OK'));
    `], { cwd: runtime, timeout: 5000 });
    assert.match(output.stdout, /REVIEW_BOUNDARY_OK/);
    assert.equal(await readFile(target, "utf8"), "baseline");
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
    const runtimeFactory = (reviewer: "codex" | "antigravity") => createReviewRuntime(reviewer, { antigravityAuth: async () => undefined });
    const available = await reviewerAvailability(runtimeFactory);
    assert.equal(available.antigravity?.available, true); assert.equal(available.codex?.available, true);
    const context = { title: "Snapshot", objective: "Keep behavior", taskContext: [], acceptanceCriteria: [], originalWorkerBrief: "",
      attempt: 1, maxAttempts: 2, worker: "opencode" as const, workerSummary: "", error: "", verification: [], changedFiles: [],
      diffStat: "", diff: "code snapshot", omitted: false, previousDecisions: [], review: null, humanAnswers: [] };
    for (const reviewer of ["antigravity", "codex"] as const) assert.deepEqual(await runReview(reviewer, context, new AbortController().signal, { runtimeFactory }), approve);
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
});

test("private runtime copies only exact consumer OAuth fields and keeps auth read-only", async () => {
  const auth = { auth_method: "consumer", id_token: "fake-id", token: { access_token: "fake-access", refresh_token: "fake-refresh", token_type: "Bearer", expiry: "2099-01-01T00:00:00Z", arbitrary: "private" }, hooks: "unsafe" };
  const runtime = await createReviewRuntime("antigravity", { antigravityAuth: async () => JSON.stringify(auth) });
  try {
    const credential = join(runtime, ".gemini/antigravity-cli/antigravity-oauth-token");
    const record = JSON.parse(await readFile(credential, "utf8"));
    assert.deepEqual(Object.keys(record).sort(), ["auth_method", "id_token", "token"]);
    assert.equal(record.token.arbitrary, undefined); assert.equal(record.hooks, undefined);
    assert.equal((await stat(credential)).mode & 0o777, 0o600);
    const output = await execa("/usr/bin/sandbox-exec", ["-p", reviewSandboxProfile(runtime, await realpath(process.execPath), "antigravity"), process.execPath, "-e", `
      const fs = require('node:fs'), assert = require('node:assert/strict');
      assert.throws(() => fs.writeFileSync(${JSON.stringify(credential)}, 'unsafe'));
      assert.throws(() => fs.unlinkSync(${JSON.stringify(credential)}));
      console.log('PRIVATE_AUTH_READ_ONLY');
    `], { cwd: runtime });
    assert.match(output.stdout, /PRIVATE_AUTH_READ_ONLY/);
  } finally { await rm(runtime, { recursive: true, force: true }); }
});

test("native fake timeout returns process diagnostics and deletes its isolated runtime", { timeout: 20000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "jonas-review-timeout-")));
  const previousPath = process.env.PATH;
  let runtime: string | undefined;
  try {
    await writeFile(join(root, "fixture.c"), '#include <unistd.h>\nint main() { sleep(5); return 0; }\n');
    await execa("/usr/bin/cc", [join(root, "fixture.c"), "-o", join(root, "agy")]);
    process.env.PATH = `${root}:${previousPath ?? ""}`;
    const context = { title: "Timeout fixture", objective: "Review", taskContext: [], acceptanceCriteria: [], originalWorkerBrief: "",
      attempt: 1, maxAttempts: 1, worker: "opencode" as const, workerSummary: "", error: "", verification: [], changedFiles: [],
      diffStat: "", diff: "", omitted: false, previousDecisions: [], review: null, humanAnswers: [] };
    await assert.rejects(runReview("antigravity", context, new AbortController().signal, { timeoutMs: 100,
      runtimeFactory: async reviewer => { runtime = await createReviewRuntime(reviewer, { antigravityAuth: async () => undefined }); return runtime; } }), error => {
      assert.ok(error instanceof ReviewFailure); assert.equal(error.diagnostics.timedOut, true);
      assert.equal(error.diagnostics.failureKind, "infrastructure"); assert.equal(error.diagnostics.modelOutputReceived, false);
      assert.ok(error.diagnostics.durationMs >= 100); return true;
    });
    assert.ok(runtime); await assert.rejects(stat(runtime), { code: "ENOENT" });
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
});
import { ReviewFailure } from "./diagnostics.js";
