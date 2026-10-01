import { realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, normalize } from 'node:path';
import { execa } from 'execa';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { repositories } from '../db/schema.js';
import { registeredRepositorySchema, registerRepositoryInputSchema } from './contracts.js';
import { repositoryIdentity } from './mapping.js';
import { RequestError } from './security.js';

async function database() { return (await import('../db/index.js')).db; }
export async function validateRepositoryPath(candidate: string): Promise<string> {
  if (!isAbsolute(candidate) || candidate.includes('\0')) throw new RequestError(400, 'Repository path must be absolute.');
  if (candidate.split(/[\\/]/).includes('.git')) throw new RequestError(400, 'Register the working tree, not its .git directory.');
  let path: string;
  try {
    path = await realpath(normalize(candidate));
    if (!(await stat(path)).isDirectory()) throw new RequestError(400, 'Repository path must be a directory.');
  } catch (error) {
    if (error instanceof RequestError) throw error;
    throw new RequestError(400, 'Repository path does not exist or is not accessible.');
  }
  if (path.split(/[\\/]/).includes('.git')) throw new RequestError(400, 'Register the working tree, not its .git directory.');
  try {
    // No shell, inherited Git directory overrides, hooks, optional locks or filesystem crawling.
    const options = { cwd: path, timeout: 5000, reject: false, stdin: 'ignore' as const,
      extendEnv: false, env: { PATH: process.env.PATH, GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' } };
    const inside = await execa('git', ['rev-parse', '--is-inside-work-tree'], options);
    if (inside.exitCode !== 0 || inside.stdout.trim() !== 'true') throw new Error('Not a working tree');
    const root = await execa('git', ['rev-parse', '--show-toplevel'], options);
    if (root.exitCode !== 0) throw new Error('No root');
    return await realpath(root.stdout.trim());
  } catch { throw new RequestError(400, 'Path must be a valid Git working tree.'); }
}

export function configuredRepositoryPaths(value = process.env.JONAS_OS_REPOSITORIES): string[] {
  if (!value?.trim()) return [];
  // A single absolute path or a JSON array supports spaces and platform separators safely.
  return z.array(z.string().trim().min(1).max(4096)).max(100).parse(value.trim().startsWith('[') ? JSON.parse(value) : [value.trim()]);
}
export async function registerRepository(value: unknown, ensure = false) {
  const input = registerRepositoryInputSchema.parse(value), path = await validateRepositoryPath(input.path), db = await database();
  const [created] = await db.insert(repositories).values({ path, name: basename(path) || path }).onConflictDoNothing().returning();
  if (!created && !ensure) throw new RequestError(409, 'Repository is already registered.');
  const row = created ?? (await db.select().from(repositories).where(eq(repositories.path, path)))[0];
  if (!row) throw new Error('Repository registration did not persist.');
  return registeredRepositorySchema.parse({ id: row.id, ...repositoryIdentity(row.path), name: row.name });
}
export async function registeredRepositories() {
  for (const path of configuredRepositoryPaths()) {
    try { await registerRepository({ path }, true); }
    catch (error) {
      // Invalid configured entries never hide existing inventory; SQL failures must remain visible.
      if (!(error instanceof RequestError)) throw error;
      console.warn(`Configured repository was not registered: ${error.message}`);
    }
  }
  const db = await database(), rows = await db.select().from(repositories).limit(2001);
  if (rows.length > 2000) throw new Error('Repository registry exceeds the V1 limit.');
  return rows;
}
export async function repositoryAvailability(path: string) {
  try {
    if (await validateRepositoryPath(path) !== path) return { available: false, unavailableReason: 'Repository path now resolves to a different working tree.' };
    return { available: true, unavailableReason: null };
  } catch (error) {
    return { available: false, unavailableReason: error instanceof RequestError ? error.message : 'Repository validation failed.' };
  }
}
