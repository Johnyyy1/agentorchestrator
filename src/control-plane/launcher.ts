import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { config } from 'dotenv';

// Load the root .env into the environment before starting Next. Passing Node's
// --env-file flag directly breaks Next dev child processes via NODE_OPTIONS.
const root = fileURLToPath(new URL('../../', import.meta.url));
const env = config({ path: join(root, '.env'), quiet: true });
if (env.error && (!('code' in env.error) || env.error.code !== 'ENOENT')) throw new Error('Could not read the root .env file.');
const [mode, ...extra] = process.argv.slice(2);
if (!['dev', 'start', 'fixtures'].includes(mode ?? '') ||
  (extra.length > 0 && (extra.length !== 2 || extra[0] !== '--port' || !/^\d+$/.test(extra[1] ?? '') || Number(extra[1]) < 1 || Number(extra[1]) > 65535))) {
  throw new Error('Use dev, start or fixtures with an optional --port <1–65535>.');
}
const child = spawn(process.execPath, [join(root, 'node_modules/next/dist/bin/next'), mode === 'start' ? 'start' : 'dev',
  join(root, 'apps/control-plane'), ...(mode === 'start' ? [] : ['--webpack']), '--hostname', '127.0.0.1', ...extra], {
  cwd: root, stdio: 'inherit', env: { ...process.env, ...(mode === 'fixtures' ? { CONTROL_PLANE_FIXTURES: '1' } : {}) },
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => child.kill(signal));
child.once('error', () => { console.error('Control Plane could not start. Run npm ci and check the local setup.'); process.exitCode = 1; });
child.once('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGTERM' ? 143 : 130); });
