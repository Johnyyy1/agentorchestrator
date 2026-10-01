import assert from "node:assert/strict";
import { test } from "node:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { execa } from "execa";
import { checkOpenCode, containsOpenCodeConfig, detectOpenCodeInterface, getOpenCodeConfig } from "./opencode.js";
import { openCodeConfig } from "./opencode-config.js";
import { parseOpenCodeOutput, parseOpenCodeText, runOpenCode } from "../workers/opencode.js";
import { createTaskWorktree, removeTaskWorktree } from "../git/worktree.js";
import type { TaskWorktree } from "../git/worktree.js";

const events = [
  { type: "step_start", sessionID: "ses_fixture", part: { type: "step-start" } },
  { type: "reasoning", part: { text: "PRIVATE TRACE" } },
  { type: "tool_use", part: { state: { input: "SECRET TOOL INPUT" } } },
  { type: "text", sessionID: "ses_fixture", part: { type: "text", text: "Function updated." } },
  { type: "step_finish", part: { reason: "stop", tokens: { input: 10, output: 5, reasoning: 2 } } },
].map(event => JSON.stringify(event)).join("\n");

test("fake CLI readiness and real OS boundary: controlled cwd, external reads/writes and symlink escapes denied", { timeout: 30000 }, async () => {
  const fixture = await realpath(await mkdtemp(join(tmpdir(), "jonas-opencode-unit-")));
  const source = join(fixture, "source");
  const bin = join(fixture, "bin");
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(req.url === "/api/tags" ? { models: [{ name: "fixture:local" }] } : { capabilities: ["completion"] }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const keys = ["OPENCODE_BIN", "LOCAL_CODING_MODEL", "OLLAMA_BASE_URL", "JONAS_OS_WORKTREE_DIR", "LOCAL_CODING_CONTEXT", "LOCAL_CODING_TIMEOUT_MS"];
  const old = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  let workspace: TaskWorktree | undefined;
  try {
    await mkdir(source); await mkdir(bin);
    await writeFile(join(source, "value.txt"), "baseline");
    await execa("git", ["init", "-b", "main", source]);
    await execa("git", ["add", "."], { cwd: source });
    await execa("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", "commit", "-m", "Fixture"], { cwd: source });
    process.env.JONAS_OS_WORKTREE_DIR = join(fixture, "worktrees");
    process.env.LOCAL_CODING_MODEL = "fixture:local";
    process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${address.port}`;
    process.env.OPENCODE_BIN = join(bin, "opencode");
    process.env.LOCAL_CODING_CONTEXT = "16384";
    process.env.LOCAL_CODING_TIMEOUT_MS = "1000";
    await writeFile(process.env.OPENCODE_BIN, `#!${process.execPath}\nconst fs = require('node:fs');\nconst assert = require('node:assert/strict');\nconst args = process.argv.slice(2);\nif(args[0] === '--version') { console.log('1.2.27'); process.exit(0); }\nif(args.includes('--help')) { console.error('--model --format json --agent'); process.exit(0); }\nif(args[0] === 'debug') { console.log(process.env.OPENCODE_CONFIG_CONTENT); process.exit(0); }\nif(args[0] === 'models') { console.log('ollama/fixture:local'); process.exit(0); }\nassert.equal(args[0], 'run');\nassert.ok(args.includes('ollama/fixture:local'));\nassert.ok(args.includes('jonas-local-coding') || JSON.parse(process.env.OPENCODE_CONFIG_CONTENT).default_agent === 'jonas-local-coding');\nassert.ok(!args.includes('--auto'));\nassert.equal(process.env.OPENCODE_DISABLE_PROJECT_CONFIG, 'true');\nconst config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);\nassert.equal(config.permission.bash, 'deny');\nassert.equal(process.env.DATABASE_URL, undefined);\nassert.equal(args.at(-1), 'literal $(touch NEVER) \\u0060test\\u0060');\nassert.throws(() => fs.writeFileSync(${JSON.stringify(join(source, 'value.txt'))}, 'unsafe'));\nassert.throws(() => fs.readFileSync(${JSON.stringify(join(source, 'value.txt'))}));\nassert.throws(() => fs.writeFileSync('escape/value.txt', 'unsafe'));\nassert.throws(() => fs.writeFileSync('.git', 'unsafe'));\nfs.writeFileSync('value.txt', 'ok');\nfetch(config.provider.ollama.options.baseURL.replace('/v1', '') + '/api/tags').then(async response => { assert.equal(response.status, 200); const body = await response.json(); assert.equal(body.models[0].name, 'fixture:local'); console.log(args.includes('--format') ? ${JSON.stringify(events)} : 'Function updated.'); }).catch(error => { console.error(error.code || error.cause?.code || 'network error'); process.exitCode = 1; });\n`);
    await chmod(process.env.OPENCODE_BIN, 0o700);
    assert.equal((await checkOpenCode()).available, true);
    workspace = await createTaskWorktree({ path: source }, randomUUID());
    await symlink(source, join(workspace.path, "escape"));
    await assert.rejects(runOpenCode("never run", source, { workspace }), /isolated/);
    const result = await runOpenCode("literal $(touch NEVER) `test`", workspace.path, { workspace });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(await readFile(join(workspace.path, "value.txt"), "utf8"), "ok");
    assert.equal(await readFile(join(source, "value.txt"), "utf8"), "baseline");
    const installedFake = process.env.OPENCODE_BIN;
    const script = await readFile(installedFake, "utf8");
    await writeFile(installedFake, script.replace("1.2.27", "2.0.0"));
    assert.equal((await checkOpenCode()).available, true, "Version alone does not determine config compatibility.");
    await writeFile(installedFake, script.replace("--model --format json --agent", "--model"));
    assert.equal((await checkOpenCode()).outputFormat, "text");
    const textResult = await runOpenCode("literal $(touch NEVER) `test`", workspace.path, { workspace });
    assert.equal(textResult.success, true);
    assert.equal(textResult.message, "Function updated.");
    assert.equal(textResult.sessionId, null);
    await writeFile(installedFake, script.replace("--model --format json --agent", "--models"));
    assert.equal((await checkOpenCode()).error?.code, "unsupported_cli");
    await writeFile(installedFake, script.replace("console.log(process.env.OPENCODE_CONFIG_CONTENT)", "console.log('{}')"));
    assert.equal((await checkOpenCode()).error?.code, "unsupported_cli");
    await writeFile(installedFake, script.replace("console.log('ollama/fixture:local')", "console.log('ollama/other:local')"));
    assert.equal((await checkOpenCode()).error?.code, "model_missing");
    await writeFile(installedFake, script);
    const reachableUrl = process.env.OLLAMA_BASE_URL;
    process.env.OLLAMA_BASE_URL = "http://127.0.0.1:1";
    assert.equal((await checkOpenCode()).error?.code, "ollama_unavailable");
    process.env.OLLAMA_BASE_URL = reachableUrl;
    await writeFile(installedFake, script.replace("assert.equal(args[0], 'run');", "setInterval(() => {}, 1000); return;"));
    const timeout = await runOpenCode("bounded timeout", workspace.path, { workspace });
    assert.equal(timeout.success, false);
    assert.equal(timeout.timedOut, true);
    assert.ok(timeout.durationMs < 3000);
    process.env.OPENCODE_BIN = join(bin, "missing");
    assert.equal((await checkOpenCode()).error?.code, "binary_missing");
    process.env.LOCAL_CODING_CONTEXT = "128000";
    assert.throws(getOpenCodeConfig, /configuration/);
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    if (workspace) await removeTaskWorktree(workspace, { force: true });
    await rm(fixture, { recursive: true, force: true });
    for (const key of keys) { if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key]; }
  }
});
