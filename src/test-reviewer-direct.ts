// Explicit opt-in: two tiny real cloud reviews. No Chief, worker, queue or verifier invocation.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { runReview } from "./review/adapter.js";
import { ReviewFailure, type ReviewDiagnostics } from "./review/diagnostics.js";
import { reviewSchema } from "./review/schema.js";
import type { RepairContext } from "./orchestration/context.js";

const root = await realpath(await mkdtemp(join(tmpdir(), "jonas-review-direct-")));
let passed = false;
try {
  const git = (args: string[]) => execa("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: root });
  await git(["init", "-b", "main"]);
  const file = join(root, "add.js");
  const original = "export function add(a, b) {\n  return a + b;\n}\n";
  await writeFile(file, original); await git(["add", "add.js"]);
  await git(["-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", "-c", "commit.gpgsign=false", "commit", "-m", "Review fixture"]);
  for (const kind of ["GOOD", "BAD"] as const) {
    await writeFile(file, original.replace("a + b;", kind === "GOOD" ? "(a + b);" : "a - b;"));
    const diff = (await git(["diff", "--", "add.js"])).stdout;
    const hash = async () => createHash("sha256").update(await readFile(file)).digest("hex");
    const before = await hash(); const headBefore = (await git(["rev-parse", "HEAD"])).stdout;
    const statusBefore = (await git(["status", "--porcelain=v1"])).stdout;
    const context: RepairContext = { title: "Addition review", objective: "Function must add the two numbers.",
      taskContext: ["Disposable direct snapshot review fixture. No orchestration or verifier is invoked. Evaluate the supplied full diff."],
      acceptanceCriteria: ["add(2, 3) returns 5", "add(-2, 3) returns 1", "Only add.js changes"],
      originalWorkerBrief: "Preserve addition behavior", attempt: 1, maxAttempts: 1, worker: "opencode", workerSummary: "",
      error: "", verification: [], changedFiles: ["add.js"], diffStat: (await git(["diff", "--stat"])).stdout,
      diff, omitted: false, previousDecisions: [], review: null, humanAnswers: [] };
    let diagnostics: ReviewDiagnostics | undefined;
    let result;
    try {
      result = reviewSchema.parse(await runReview("antigravity", context, new AbortController().signal,
        { onDiagnostics: value => { diagnostics = value; } }));
    } finally {
      const after = await hash();
      assert.equal(after, before); assert.equal((await git(["rev-parse", "HEAD"])).stdout, headBefore);
      assert.equal((await git(["status", "--porcelain=v1"])).stdout, statusBefore);
      console.log(JSON.stringify({ fixture: kind, diagnostics, readOnly: { before, after, headUnchanged: true, statusUnchanged: true } }));
    }
    console.log(JSON.stringify({ fixture: kind, result }));
    if (kind === "BAD") assert.notEqual(result.decision, "approve", "Contradictory subtraction must never approve");
  }
  passed = true;
} catch (error) {
  console.error(error instanceof ReviewFailure ? error.message : "Direct fixture assertion failed.");
  process.exitCode = 1;
} finally {
  await rm(root, { recursive: true, force: true });
  console.log(JSON.stringify({ directReviewGatePassed: passed, fixtureDeleted: true }));
}
