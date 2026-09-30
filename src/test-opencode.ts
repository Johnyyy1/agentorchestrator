import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execa } from "execa";
import { checkOpenCode } from "./local/opencode.js";
import { executeTask } from "./workers/execute.js";
import { removeTaskWorktree } from "./git/worktree.js";
import type { TaskWorktree } from "./git/worktree.js";
import type { OpenCodeResult } from "./workers/opencode.js";

// Refuse to silently exercise Codex if local readiness fails.
const ready = await checkOpenCode();
if (!ready.available) {
  console.error("Real OpenCode smoke test BLOCKED:", JSON.stringify(ready));
  process.exitCode = 1;
} else {
  const fixture = await realpath(await mkdtemp(join(tmpdir(), "jonas-opencode-smoke-")));
  const source = join(fixture, "source");
  const oldRoot = process.env.JONAS_OS_WORKTREE_DIR;
  const workspaces: TaskWorktree[] = [];
  process.env.JONAS_OS_WORKTREE_DIR = join(fixture, "worktrees");
  const git = (args: string[]) => execa("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: source, timeout: 10000 });
  try {
    await mkdir(source);
    await execa("git", ["init", "-b", "main", source]);
    await writeFile(join(source, "add.ts"), "export function add(a: number, b: number): number { return a - b; }\n");
    await writeFile(join(source, "add.test.mjs"), `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from './add.ts';\ntest('addition', () => { assert.equal(add(2, 3), 5); assert.equal(add(-2, 1), -1); });\n`);
    await writeFile(join(source, ".gitignore"), "dist/\n");
    // Explicit fixture-only provisioning: compiler already installed in Jonas OS.
    const tsc = `${JSON.stringify(process.execPath)} ${JSON.stringify(resolve("node_modules/typescript/bin/tsc"))}`;
    await writeFile(join(source, "package.json"), JSON.stringify({ name: "local-opencode-fixture", type: "module", scripts: {
      test: "node --test add.test.mjs", typecheck: `${tsc} --ignoreConfig --noEmit --target esnext add.ts`,
      lint: "node --check add.ts", build: `${tsc} --ignoreConfig --target esnext --outDir dist add.ts`,
    } }, null, 2));
    await git(["add", "."]);
    await git(["-c", "commit.gpgsign=false", "-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", "commit", "-m", "Fixture baseline"]);
    const before = await readFile(join(source, "add.ts"), "utf8");
    const baseline = (await git(["rev-parse", "HEAD"])).stdout;
    const result = await executeTask({ title: "Fix addition", objective: "Read add.ts and add.test.mjs. Fix add.ts so add performs addition. Change only add.ts. Do not run shell commands.",
      category: "coding", difficulty: 1, risk: "low", context: ["Disposable TypeScript fixture. Tests are already provided."],
      acceptanceCriteria: ["add(2,3) === 5 and add(-2,1) === -1; change only add.ts."], maxAttempts: 1, repository: { path: source } }, source, {
      recommendation: { capability: "local-coding", workerBrief: "Inspect the two files and replace the incorrect subtraction with addition. Keep the function signature and tests." },
      availability: { opencode: { available: true, model: `ollama/${ready.model}` }, codex: { available: false }, antigravity: { available: false } },
      codexExecutor: async () => { throw new Error("Smoke test must never invoke Codex."); },
      onWorkspaceCreated: async workspace => { workspaces.push(workspace); },
    });
    const worker = result.workerResult as OpenCodeResult;
    console.log("Real local worker:", JSON.stringify(worker));
    assert.equal(result.route.worker, "opencode");
    assert.equal(result.success, true, result.error ?? "Local smoke execution failed.");
    assert.ok(worker.sessionId);
    assert.equal(worker.model, ready.model);
    assert.ok(result.verification?.checks.every(check => !check.skipped && check.success));
    assert.deepEqual(result.git?.changedFiles, ["add.ts"]);
    assert.notEqual(await readFile(join(result.workspace!.path, "add.ts"), "utf8"), before);
    assert.equal(await readFile(join(source, "add.ts"), "utf8"), before);
    assert.equal((await git(["status", "--short"])).stdout, "");
    assert.equal((await git(["rev-parse", "HEAD"])).stdout, baseline);
    console.log(`Real OpenCode ${ready.version} + ${ready.model}: PASS; original unchanged; all four verifier checks pass.`);
  } finally {
    // Only disposable fixtures created by this test are removed.
    for (const workspace of workspaces) await removeTaskWorktree(workspace, { force: true });
    await rm(fixture, { recursive: true, force: true });
    if (oldRoot === undefined) delete process.env.JONAS_OS_WORKTREE_DIR; else process.env.JONAS_OS_WORKTREE_DIR = oldRoot;
    console.log("OpenCode smoke fixture cleanup: OK.");
  }
}
