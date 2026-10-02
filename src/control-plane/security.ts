import { z } from 'zod';
export class RequestError extends Error {
  readonly name = 'ControlPlaneRequestError';
  constructor(public status: number, message: string) { super(message); }
}
export function isRequestError(error: unknown): error is RequestError {
  // Next server-component and route bundles can share fixture closures through globalThis
  // while loading separate class instances. Preserve the code-owned HTTP error across them.
  return error instanceof Error && error.name === 'ControlPlaneRequestError'
    && 'status' in error && typeof error.status === 'number' && Number.isInteger(error.status)
    && error.status >= 400 && error.status <= 599;
}
export function validateLocalRequest(request: Request, mutation = false): void {
  const host = request.headers.get('host');
  if (!host || !/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/.test(host)) throw new RequestError(403, 'Local access only.');
  const origin = request.headers.get('origin');
  if (mutation && (!origin || origin !== `http://${host}`)) throw new RequestError(403, 'A same-origin local request is required.');
  const site = request.headers.get('sec-fetch-site');
  if (mutation && site && site !== 'same-origin' && site !== 'none') throw new RequestError(403, 'Cross-site requests are blocked.');
}
export async function readJson(request: Request): Promise<unknown> {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new RequestError(415, 'Use JSON.');
  const reader = request.body?.getReader();
  if (!reader) throw new RequestError(400, 'Request body is required.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 32000) throw new RequestError(413, 'Request is too large.');
      chunks.push(value);
    }
    const combined = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder().decode(combined)); }
    catch { throw new RequestError(400, 'Invalid JSON.'); }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export function publicError(error: unknown, operation: string): { status: number; error: string } {
  if (isRequestError(error)) return { status: error.status, error: error.message };
  if (error instanceof z.ZodError) return { status: 400, error: 'Check the submitted fields and their length.' };
  const message = error instanceof Error ? error.message : '';
  const known = ['Escalation is not open.', 'Task is not waiting for a human.', 'Only a waiting_human task can be abandoned.',
    'Project is no longer available.', 'Escalation does not exist.', 'Task does not exist.'];
  if (known.includes(message)) return { status: 409, error: message };
  if (operation.startsWith('project-')) return { status: 503, error: 'Project or memory operation failed. Check database migrations and local embedding readiness.' };
  if (operation === 'repository') return { status: 503, error: 'Repository registration failed. Check database availability and migrations.' };
  if (operation === 'delegate') return { status: 503, error: 'Chief planning or submission failed. Check Ollama, database and queue health. A pending task may have been retained; inspect Tasks before retrying.' };
  return { status: 503, error: 'The operation did not complete. Reload the decision to check its current state. If enqueue failed, the answer remains open.' };
}
// Coalesce retries and keep failures too: a failed submit may already have a pending DB row.
export function createMutationGate(now = Date.now) {
  const entries = new Map<string, { fingerprint: string; expires: number; promise: Promise<unknown> }>();
  let delegating = false;
  return async <T>(key: string, fingerprint: string, operation: string, run: () => Promise<T>): Promise<T> => {
    z.uuid().parse(key);
    for (const [id, entry] of entries) if (entry.expires <= now()) entries.delete(id);
    const existing = entries.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new RequestError(409, 'This request ID was already used with different input.');
      return existing.promise as Promise<T>;
    }
    if (entries.size >= 500) throw new RequestError(429, 'Too many recent submissions. Try again later.');
    if (operation === 'delegate' && delegating) throw new RequestError(409, 'Chief is already planning a goal. Wait for that request to finish.');
    if (operation === 'delegate') delegating = true;
    // Retain in-flight requests until completion, then start the expiry clock.
    const entry = { fingerprint, expires: Infinity, promise: Promise.resolve().then(run) as Promise<unknown> };
    entries.set(key, entry);
    try { return await entry.promise as T; }
    finally { entry.expires = now() + 15 * 60 * 1000; if (operation === 'delegate') delegating = false; }
  };
}
