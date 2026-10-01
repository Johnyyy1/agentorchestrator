import { join } from "node:path";
import { loopbackGuardFilename } from "./loopback-guard.js";

// Apple's shipped /usr/share/sandbox/com.apple.smbd.sb uses local tcp filters.
// Seatbelt accepts only * or localhost hosts; localhost inbound includes host
// interfaces/wildcard binds. Node's guard narrows normal test-server binding.
// This is NOT a kernel guarantee against LAN listeners from other runtimes.
export function verifierSandboxProfile(worktree: string, runtime: string): string {
  const quote = (value: string) => JSON.stringify(value);
  return `(version 1)
(deny default)
(allow process-exec)
(allow process-fork)
(allow process-info* (target same-sandbox))
(allow signal (target same-sandbox))
(allow sysctl-read)
(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo") (global-name "com.apple.PowerManagement.control"))
(allow file-read*)
(allow file-write* (subpath ${quote(worktree)}) (subpath ${quote(runtime)}) (literal "/dev/null"))
(deny file-write* ${[".git", ".codex", ".agents"].map(name => `(subpath ${quote(join(worktree, name))})`).join(" ")} (literal ${quote(join(runtime, loopbackGuardFilename))}))
(allow network-bind (local unix-socket (subpath ${quote(runtime)})))
(allow network-outbound (remote unix-socket (subpath ${quote(runtime)})))
(allow network-bind (local tcp "localhost:*"))
(allow network-inbound (local tcp "localhost:*"))
(allow network-outbound (remote tcp "localhost:*"))`;
}

export function verifierSandboxCommand(worktree: string, runtime: string, command: string[]) {
  if (process.platform !== "darwin") throw new Error("Verifier loopback OS boundary requires macOS Seatbelt.");
  return { binary: "/usr/bin/sandbox-exec", args: ["-p", verifierSandboxProfile(worktree, runtime), ...command] };
}

export function verifierEnvironment(runtime: string): Record<string, string> {
  return { PATH: process.env.PATH ?? "", HOME: runtime, TMPDIR: runtime, TMP: runtime, TEMP: runtime,
    NODE_OPTIONS: `--require=${join(runtime, loopbackGuardFilename)}`,
    CI: "true", npm_config_cache: join(runtime, "npm-cache"), npm_config_update_notifier: "false",
    npm_config_audit: "false", npm_config_fund: "false", npm_config_yes: "false",
    COREPACK_ENABLE_NETWORK: "0", COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" };
}

// Fixed code owned by Jonas OS, before any application script is invoked.
// Structured failure evidence comes from known operations, not application log matching.
export const runtimeProbe = `
const fs = require('node:fs');
const http = require('node:http');
const report = process.argv[1];
const save = value => fs.writeFileSync(report, JSON.stringify(value));
(async () => {
  try { fs.writeFileSync(process.env.TMPDIR + '/probe-temp', 'ok'); }
  catch (e) { save({ stage: 'setup', message: 'Verifier temporary storage failed: ' + e.code }); process.exitCode = 1; return; }
  for (const host of ['127.0.0.1', '::1']) {
    const server = http.createServer((req, res) => res.end('verifier-ready'));
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, host, resolve); });
      const response = await fetch('http://' + (host === '::1' ? '[::1]' : host) + ':' + server.address().port);
      if (await response.text() !== 'verifier-ready') throw new Error('Unexpected probe response.');
    } catch (e) {
      save({ stage: 'sandbox', message: 'Local test server could not start or respond inside verifier sandbox. ' + e.message });
      process.exitCode = 1; return;
    } finally { if (server.listening) await new Promise(resolve => server.close(resolve)); }
  }
  save({ ready: true });
})().catch(() => { process.exitCode = 1; });
`;

// The package manager's spawn event is the explicit launcher/application boundary.
export const checkLauncher = `
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const [report, binary, ...args] = process.argv.slice(1);
const save = value => fs.writeFileSync(report, JSON.stringify(value));
const child = spawn(binary, args, { stdio: ['ignore', 'inherit', 'inherit'] });
child.once('spawn', () => save({ started: true }));
child.once('error', e => { save({ stage: 'launcher', message: 'Verifier check process could not start: ' + e.code }); process.exitCode = 1; });
child.once('exit', (code, signal) => { process.exitCode = code ?? 1; });
`;
