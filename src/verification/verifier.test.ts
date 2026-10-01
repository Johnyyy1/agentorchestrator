import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { createTaskWorktree, removeTaskWorktree } from "../git/worktree.js";
import type { TaskWorktree } from "../git/worktree.js";
import { createVerifierRuntime } from "./runtime.js";
import { verifyWorktree } from "./verifier.js";

// No AI: real Git, tsx IPC and the production verifier OS boundary.
test("real tsx starts with a short owned socket path despite a long worktree; temp access stays scoped", { timeout: 30000 }, async () => {
  const fixture = await realpath(await mkdtemp(join(tmpdir(), "jo-verifier-test-")));
  const source = join(fixture, "source");
  const oldRoot = process.env.JONAS_OS_WORKTREE_DIR;
  let workspace: TaskWorktree | undefined;
  let runtime: string | undefined;
  try {
    await mkdir(source);
    const outside = join(fixture, "outside.txt");
    await writeFile(outside, "preserved");
    const tsx = fileURLToPath(new URL("../../node_modules/tsx/dist/cli.mjs", import.meta.url));
    await writeFile(join(source, "package.json"), JSON.stringify({ type: "module", scripts: { test: `node ${JSON.stringify(tsx)} probe.ts` } }));
    await writeFile(join(source, "probe.ts"), `
import assert from 'node:assert/strict';
import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
assert.ok(Buffer.byteLength(process.cwd()) > 140);
const temp = tmpdir();
assert.ok(Buffer.byteLength(temp) <= 40);
assert.equal(temp, process.env.TMP);
assert.equal(temp, process.env.TEMP);
const ipc = join(temp, 'tsx-' + process.geteuid());
const pipes = readdirSync(ipc).filter(name => name.endsWith('.pipe'));
assert.ok(pipes.length > 0, 'real tsx IPC socket exists');
for (const name of pipes) {
 assert.ok(Buffer.byteLength(join(ipc, name)) < 104);
 assert.ok(statSync(join(ipc, name)).isSocket());
}
assert.throws(() => writeFileSync(${JSON.stringify(outside)}, 'unsafe'));
assert.throws(() => writeFileSync(${JSON.stringify(join(source, 'package.json'))}, 'unsafe'));
writeFileSync(join(temp, 'owned.txt'), 'ok');
await assert.rejects(new Promise((resolve, reject) => {
 const server = createServer(); server.once('error', reject);
 server.listen(0, '127.0.0.1', () => server.close(resolve));
}));
await assert.rejects(new Promise((resolve, reject) => {
 const server = createServer(); server.once('error', reject);
 server.listen(${JSON.stringify('/tmp/jo-denied-' + randomUUID() + '.pipe')}, () => server.close(resolve));
}), { code: 'EPERM' });
console.log('VERIFIER_RUNTIME=' + temp);
console.log('TSX_IPC_OK');
`);
    await execa("git", ["init", "-b", "main", source]);
    await execa("git", ["add", "."], { cwd: source });
    await execa("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", "commit", "-m", "Verifier fixture"], { cwd: source });
    process.env.JONAS_OS_WORKTREE_DIR = join(fixture, "deliberately-long-worktree-" + "x".repeat(100));
    workspace = await createTaskWorktree({ path: source }, randomUUID());
    const result = await verifyWorktree(workspace);
    assert.equal(result.success, true, JSON.stringify(result));
    const check = result.checks.find(c => c.name === "test")!;
    assert.equal(check.skipped, false);
    assert.match(check.stdout, /TSX_IPC_OK/);
    runtime = check.stdout.match(/VERIFIER_RUNTIME=(.+)/)?.[1];
    assert.ok(runtime);
    await assert.rejects(access(runtime), { code: "ENOENT" });
    assert.equal(await readFile(outside, "utf8"), "preserved");
  } finally {
    if (workspace) await removeTaskWorktree(workspace);
    await rm(fixture, { recursive: true, force: true });
    if (oldRoot === undefined) delete process.env.JONAS_OS_WORKTREE_DIR; else process.env.JONAS_OS_WORKTREE_DIR = oldRoot;
  }
});

test("runtime cleanup refuses a replaced directory or symlink", async () => {
  const runtime = await createVerifierRuntime();
  const original = runtime.path + "-owned";
  const target = await realpath(await mkdtemp(join(tmpdir(), "jo-preserved-")));
  try {
    await writeFile(join(target, "keep"), "preserved");
    await rename(runtime.path, original);
    await symlink(target, runtime.path);
    await assert.rejects(runtime.cleanup(), /ownership changed/);
    assert.equal(await readFile(join(target, "keep"), "utf8"), "preserved");
  } finally {
    await rm(runtime.path);
    await rm(original, { recursive: true });
    await rm(target, { recursive: true });
  }
});
