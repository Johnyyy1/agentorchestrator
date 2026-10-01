import { sql } from 'drizzle-orm';
import { checkOllama, getOllamaConfig, OllamaError } from '../local/ollama.js';
import { checkOpenCode, resolveBinary } from '../local/opencode.js';
import { runs, orchestrationEvents } from '../db/schema.js';
import { providerSchema } from './contracts.js';
import type { ProviderStatusDto } from './contracts.js';
import { iso, safeText } from './mapping.js';

type Health = Pick<ProviderStatusDto, 'id' | 'name' | 'provider' | 'model' | 'status' | 'reason' | 'checkedAt'>;
export function mapLocalReadiness(available: boolean, reason?: string): Pick<Health, 'status' | 'reason'> {
  return { status: available ? 'available' : 'unavailable', reason: available ? 'Local model and execution prerequisites are ready.' : safeText(reason || 'Readiness failed.') };
}
export function mapBinaryReadiness(binary: string | null): Pick<Health, 'status' | 'reason'> {
  return binary ? { status: 'unknown', reason: 'CLI installed. Authentication and service availability have not been verified.' }
    : { status: 'unavailable', reason: 'CLI is not installed or is not executable in PATH.' };
}
export async function checkProviderHealth(): Promise<Health[]> {
  const checkedAt = new Date().toISOString();
  const chief = async (): Promise<Health> => {
    let model: string | null = null;
    try {
      const config = getOllamaConfig(); model = config.model;
      await checkOllama({ ...config, timeoutMs: Math.min(config.timeoutMs, 5000) });
      return { id: 'chief', name: 'Local Chief', provider: 'Ollama', model, checkedAt, status: 'available', reason: 'Local model installed. No inference performed.' };
    } catch (error) {
      return { id: 'chief', name: 'Local Chief', provider: 'Ollama', model, checkedAt, status: 'unavailable',
        reason: error instanceof OllamaError ? safeText(error.message) : 'Invalid Ollama configuration. Check local setup.' };
    }
  };
  const local = async (): Promise<Health> => {
    const ready = await checkOpenCode();
    return { id: 'opencode', name: 'Local coding', provider: 'OpenCode · Ollama', model: safeText(ready.model, 200), checkedAt,
      ...mapLocalReadiness(ready.available, ready.error?.message) };
  };
  const cloud = async (id: 'codex' | 'antigravity'): Promise<Health> => ({
    id, name: id === 'codex' ? 'Strong coding' : 'General / research', provider: id === 'codex' ? 'Codex' : 'Antigravity',
    model: id === 'codex' ? null : [process.env.AGY_FLASH_MODEL, process.env.AGY_PRO_MODEL].filter(Boolean).map(m => safeText(m, 200)).join(' / ') || null,
    checkedAt, ...mapBinaryReadiness(await resolveBinary(id === 'codex' ? 'codex' : 'agy')),
  });
  const checks = [chief, local, () => cloud('codex'), () => cloud('antigravity')];
  const result = await Promise.allSettled(checks.map(check => check()));
  return result.map((r, i) => r.status === 'fulfilled' ? r.value : {
    id: ['chief', 'opencode', 'codex', 'antigravity'][i]!, name: ['Local Chief', 'Local coding', 'Strong coding', 'General / research'][i]!,
    provider: ['Ollama', 'OpenCode', 'Codex', 'Antigravity'][i]!, model: null, checkedAt, status: 'unknown', reason: 'Readiness check could not complete.',
  });
}
export function createHealthCache(check: () => Promise<Health[]>, ttl = 20000, now = Date.now) {
  let promise: Promise<Health[]> | undefined, expires = 0;
  return () => {
    if (!promise || now() >= expires) {
      // Timestamp expiry after completion also coalesces long-running checks.
      expires = Infinity;
      promise = check().then(rows => { expires = now() + ttl; return rows; }, error => { promise = undefined; expires = 0; throw error; });
    }
    return promise;
  };
}
const globalCache = globalThis as typeof globalThis & { jonasControlPlaneHealth?: ReturnType<typeof createHealthCache> };
globalCache.jonasControlPlaneHealth ??= createHealthCache(checkProviderHealth);
export async function getProviderStatus() {
  const health = await globalCache.jonasControlPlaneHealth!();
  let dbAvailable = false;
  let stats: Array<{ worker: string; recentRuns: number; successes: number; failures: number; lastSuccess: Date | null; lastFailure: Date | null }> = [];
  let chiefStats: { recentRuns: number; lastSuccess: Date | null } | undefined;
  try {
    const { db } = await import('../db/index.js');
    const [runStats, repairStats] = await Promise.all([
      db.select({ worker: runs.worker, recentRuns: sql<number>`count(*) filter (where ${runs.startedAt} > now() - interval '7 days')::int`,
        successes: sql<number>`count(*) filter (where ${runs.status} = 'completed' and ${runs.startedAt} > now() - interval '7 days')::int`,
        failures: sql<number>`count(*) filter (where ${runs.status} = 'failed' and ${runs.startedAt} > now() - interval '7 days')::int`,
        lastSuccess: sql<Date | null>`max(${runs.finishedAt}) filter (where ${runs.status} = 'completed')`,
        lastFailure: sql<Date | null>`max(${runs.finishedAt}) filter (where ${runs.status} = 'failed')` }).from(runs).groupBy(runs.worker),
      db.select({ recentRuns: sql<number>`count(*) filter (where ${orchestrationEvents.createdAt} > now() - interval '7 days')::int`,
        lastSuccess: sql<Date | null>`max(${orchestrationEvents.createdAt})` }).from(orchestrationEvents).where(sql`${orchestrationEvents.kind} = 'repair_decided'`),
    ]);
    stats = runStats; chiefStats = repairStats[0]; dbAvailable = true;
  } catch { /* Database failure is an explicit global status, never fabricated statistics. */ }
  return { dbAvailable, providers: health.map(row => {
    const s = stats.find(s => s.worker === row.id);
    return providerSchema.parse({ ...row, recentRuns: row.id === 'chief' ? chiefStats?.recentRuns ?? 0 : s?.recentRuns ?? 0,
      successes: row.id === 'chief' ? chiefStats?.recentRuns ?? 0 : s?.successes ?? 0, failures: s?.failures ?? 0,
      lastSuccess: row.id === 'chief' ? chiefStats?.lastSuccess ? iso(chiefStats.lastSuccess) : null : s?.lastSuccess ? iso(s.lastSuccess) : null,
      lastFailure: s?.lastFailure ? iso(s.lastFailure) : null,
      statsNote: !dbAvailable ? 'Run statistics unavailable · database offline.' : row.id === 'chief'
        ? '7 days · persisted repair decisions only. Initial planning and failed planning calls are not stored.'
        : '7 days · execution attempts. Reviews are shown in task history; completed runs do not imply task completion.',
    });
  }) };
}
