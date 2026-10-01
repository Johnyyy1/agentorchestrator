import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { execa } from "execa";
import { assertTaskWorktree, type TaskWorktree } from "../git/worktree.js";
import { boundedProcess } from "./bounded-process.js";

export class OpenCodeInfrastructureError extends Error {}
export async function inspectOpenCodeWorkspace(cwd: string, workspace: TaskWorktree) {
  try {
    await assertTaskWorktree(workspace);
    const canonicalCwd = await realpath(cwd);
    if (canonicalCwd !== workspace.path) throw new Error("OpenCode requires the isolated task worktree as cwd.");
    const git = async (args: string[]) => (await execa("git", ["-c", "core.hooksPath=/dev/null", ...args], {
      cwd: canonicalCwd, timeout: 5000, stdin: "ignore", extendEnv: false,
      env: { PATH: process.env.PATH ?? "", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    })).stdout;
    const repositoryRoot = await realpath(await git(["rev-parse", "--show-toplevel"]));
    const branch = await git(["branch", "--show-current"]);
    if (repositoryRoot !== workspace.path || branch !== workspace.branch) throw new Error("OpenCode worktree root/branch mismatch.");
    await access(canonicalCwd, constants.W_OK);
    return { suppliedCwd: cwd, canonicalCwd, expectedWorktree: workspace.path, repositoryRoot, branch, writable: true };
  } catch (cause) {
    throw new OpenCodeInfrastructureError("OpenCode workspace preflight rejected cwd/root/branch or access assumptions.", { cause });
  }
}
export async function probeOpenCodeSandbox(cwd: string, profile: string, env: Record<string, string>) {
  // The worker boundary itself must support read + exclusive temporary write/delete.
  const script = `const fs = require('node:fs'); const path = require('node:path');
fs.readFileSync('.git');
const directory = fs.mkdtempSync(path.join(process.cwd(), '.jonas-preflight-'));
try { const file = path.join(directory, 'probe'); fs.writeFileSync(file, 'probe', {flag:'wx',mode:0o600}); fs.readFileSync(file); fs.unlinkSync(file); }
finally { fs.rmdirSync(directory); }
console.log('OPENCODE_PREFLIGHT_OK');`;
  const result = await boundedProcess("/usr/bin/sandbox-exec", ["-p", profile, process.execPath, "-e", script], { cwd, env, timeoutMs: 5000 });
  if (result.failed || result.stdout.trim() !== "OPENCODE_PREFLIGHT_OK") {
    throw new OpenCodeInfrastructureError("OpenCode sandbox preflight could not read or write/delete inside the worktree.");
  }
  return { repositoryRead: true, temporaryWriteDelete: true };
}
