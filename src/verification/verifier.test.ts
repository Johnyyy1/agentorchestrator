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
test("real tsx HTTP loopback works in a long worktree; temp, Node bind and OS outbound access stay scoped", { timeout: 30000 }, async t => {
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
import { createServer, connect } from 'node:net';
import { createServer as httpServer } from 'node:http';
import { networkInterfaces } from 'node:os';
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
for (const host of ['127.0.0.1', '::1', 'localhost']) {
 const server = httpServer((req, res) => res.end('local fixture'));
 await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, host, resolve); });
 const address = server.address();
 assert.ok(address.port > 0);
 const response = await fetch('http://' + (host === '::1' ? '[::1]' : '127.0.0.1') + ':' + address.port);
 assert.equal(await response.text(), 'local fixture');
 await new Promise(resolve => server.close(resolve));
}
// These are Node guard assertions, not kernel address confinement claims.
const localLan = Object.values(networkInterfaces()).flat().filter(i => i && !i.internal).map(i => i.address);
for (const host of ['0.0.0.0', '::', '192.168.1.1', ...localLan]) {
 assert.throws(() => createServer().listen(0, host), { code: 'EPERM' });
 assert.throws(() => createServer().listen({ port: 0, host }), { code: 'EPERM' });
}
assert.throws(() => createServer().listen(0), { code: 'EPERM' });
assert.throws(() => writeFileSync(join(temp, 'loopback-guard.cjs'), 'unsafe'));
// Real OS outbound denial: no DNS, routing timeout or application fake needed.
for (const host of ['192.0.2.1', '192.168.1.1', '1.1.1.1']) {
 await assert.rejects(new Promise((resolve, reject) => {
  const socket = connect({ host, port: 80 }); socket.once('error', reject);
  socket.once('connect', () => { socket.destroy(); resolve(); });
  socket.setTimeout(1000, () => { socket.destroy(); reject(new Error('Expected immediate EPERM, not a timeout')); });
 }), { code: 'EPERM' });
}
console.log('HTTP_LOOPBACK_OK');

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
    const result = await verifyWorktree(workspace!);
    assert.equal(result.success, true, JSON.stringify(result));
    const check = result.checks.find(c => c.name === "test")!;
    assert.equal(check.skipped, false);
    assert.match(check.stdout, /TSX_IPC_OK/);
    assert.match(check.stdout, /HTTP_LOOPBACK_OK/);
    assert.equal(result.checks.find(c => c.name === "lint")?.skipped, true);
    assert.equal(result.checks.find(c => c.name === "build")?.skipped, true);
    assert.equal(result.failureKind, null);
    runtime = check.stdout.match(/VERIFIER_RUNTIME=(.+)/)?.[1];
    assert.ok(runtime);
    await assert.rejects(access(runtime), { code: "ENOENT" });
    assert.equal(await readFile(outside, "utf8"), "preserved");
    await t.test('C: real assertion failure mentioning EPERM remains application verification failure', async () => {
      await writeFile(join(workspace!.path, 'package.json'), JSON.stringify({ scripts: { test: `node --test assertion.cjs` } }));
      await writeFile(join(workspace!.path, 'assertion.cjs'), `const {test}=require('node:test'); const assert=require('node:assert/strict'); test('real failure mentioning EPERM',()=>assert.equal('listen EPERM 127.0.0.1','expected'));`);
      const assertion = await verifyWorktree(workspace!);
      assert.equal(assertion.success, false);
      assert.equal(assertion.failureKind, 'verification');
      assert.equal(assertion.infrastructureFailure, undefined);
      assert.match(assertion.checks[0]!.stdout, /AssertionError/);
    });
    await t.test('D: requested package-manager spawn failure is infrastructure', async () => {
      const missingManagerPath = join(fixture, 'bin');
      await mkdir(missingManagerPath);
      await symlink('/usr/bin/git', join(missingManagerPath, 'git'));
      await symlink(process.execPath, join(missingManagerPath, 'node'));
      const previousPath = process.env.PATH;
      try {
        process.env.PATH = missingManagerPath;
        const missingLauncher = await verifyWorktree(workspace!);
        assert.equal(missingLauncher.failureKind, 'infrastructure');
        assert.equal(missingLauncher.infrastructureFailure?.stage, 'launcher');
        assert.match(missingLauncher.infrastructureFailure!.message, /ENOENT/);
      } finally { process.env.PATH = previousPath; }
    });
    await t.test('D: real sandbox startup failure is infrastructure, not a code failure', async () => {
      const previousExecPath = process.execPath;
      try {
        process.execPath = join(fixture, 'missing-node');
        const startup = await verifyWorktree(workspace!);
        assert.equal(startup.failureKind, 'infrastructure');
        assert.equal(startup.infrastructureFailure?.stage, 'sandbox');
        assert.equal(startup.checks.length, 1, 'No application check after failed startup');
      } finally { process.execPath = previousExecPath; }
    });
    await t.test('absent scripts retain explicit skipped policy', async () => {
      await writeFile(join(workspace!.path, 'package.json'), JSON.stringify({ scripts: {} }));
      const absent = await verifyWorktree(workspace!);
      assert.equal(absent.success, true);
      assert.ok(absent.checks.every(check => check.skipped), 'Absent scripts stay SKIPPED');
    });
  } finally {
    if (workspace) await removeTaskWorktree(workspace, { force: true });
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
