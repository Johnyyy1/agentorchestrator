import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execa } from "execa";
import { createTaskWorktree, inspectTaskWorktree } from "./git/worktree.js";
import { checkOpenCode } from "./local/opencode.js";
import { runOpenCode } from "./workers/opencode.js";

// Local inference only; retain this disposable fixture and safe results for diagnosis.
const ready = await checkOpenCode();
assert.ok(ready.available, JSON.stringify(ready));
const fixture = await realpath(await mkdtemp(join(tmpdir(), "jo-opencode-tools-")));
const source = join(fixture, "source");
await mkdir(source); await mkdir(join(source, "src")); await mkdir(join(source, "docs"));
await writeFile(join(source, "package.json"), '{"name":"jonas-tools-fixture","type":"module"}\n');
await writeFile(join(source, "src", "index.ts"), 'export const smoke = true;\n');
await writeFile(join(source, "docs", "README.md"), 'Fixture documentation.\n');
await execa("git", ["init", "-b", "main", source]);
await execa("git", ["add", "."], { cwd: source });
await execa("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", "commit", "-m", "Fixture"], { cwd: source });
process.env.JONAS_OS_WORKTREE_DIR = join(fixture, "worktrees");
const workspace = await createTaskWorktree({ path: source }, randomUUID());
console.log("Fixture:", JSON.stringify({ fixture, workspace, ready }));
const prompts = process.argv.includes("--primitives") ? [
  'Read package.json and report its name.',
  'List TypeScript files in src.',
  'Create docs/smoke.md with exactly one line: smoke',
  'Read docs/smoke.md and confirm contents.',
] : ['Inspect the repository, then create docs/smoke.md containing one line: smoke. Do not modify anything else.'];
const results = [];
for (const prompt of prompts) {
  const result = await runOpenCode(prompt, workspace.path, { workspace });
  // Public model summary can repeat input; only safe structured diagnostics are saved here.
  const { message: _message, stderr: _stderr, ...safe } = result;
  results.push({ prompt, ...safe });
  console.log("Adapter:", JSON.stringify(results.at(-1)));
}
const inspection = await inspectTaskWorktree(workspace);
const content = await readFile(join(workspace.path, "docs/smoke.md"), "utf8").catch(() => null);
const sourceStatus = (await execa("git", ["status", "--porcelain"], { cwd: source })).stdout;
await writeFile(join(fixture, "report.json"), JSON.stringify({ ready, workspace, results, inspection, contentMatches: content === "smoke" || content === "smoke\n", sourceStatus }, null, 2));
assert.equal(sourceStatus, "");
assert.ok(results.every(result => result.success), "Adapter did not complete; fixture retained.");
assert.deepEqual(inspection.changedFiles, ["docs/smoke.md"]);
assert.ok(content === "smoke" || content === "smoke\n");
if (process.argv.includes("--primitives")) {
  for (const [index, tool] of [[0, "read"], [1, "glob"], [2, "edit"], [3, "read"]] as const) {
    assert.ok(results[index]?.toolDiagnostics?.some(item => (item.tool === tool || (tool === "edit" && ["write", "apply_patch"].includes(item.tool))) && item.status === "completed"), `${tool} primitive missing`);
  }
} else {
  const tools = results[0]!.toolDiagnostics ?? [];
  const inspected = tools.findIndex(item => ["read", "glob"].includes(item.tool) && item.status === "completed");
  const edited = tools.findIndex(item => ["write", "edit", "apply_patch"].includes(item.tool) && item.status === "completed");
  assert.ok(inspected >= 0 && edited > inspected, "Repository inspection must precede the first edit.");
}
console.log("PASS; retained safe evidence:", join(fixture, "report.json"));
