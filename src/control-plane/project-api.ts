import { fixtureMode } from './fixtures.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { createMutationGate, publicError, readJson, RequestError, validateLocalRequest } from './security.js';
import { createProjectSchema, updateProjectSchema, manualMemorySchema, searchMemorySchema } from '../projects/contracts.js';
import { projectStore } from '../projects/store.js';
import type { ProjectStore } from '../projects/store.js';
import { syncProjectTaskMemories } from '../memory/outcome-sync.js';
const globalGate = globalThis as typeof globalThis & { jonasProjectGate?: ReturnType<typeof createMutationGate> };
globalGate.jonasProjectGate ??= createMutationGate();
export const archiveMemorySchema = z.strictObject({ memoryId: z.uuid() });
export const syncInputSchema = z.strictObject({ afterTaskId: z.uuid().optional() });
export async function projectApi(request: Request, route: { id?: string; operation?: string } = {}, options: { store?: ProjectStore; sync?: typeof syncProjectTaskMemories } = {}) {
  const operation = route.operation ?? (route.id ? 'project' : 'projects');
  try {
    validateLocalRequest(request, request.method !== 'GET');
    if (route.id) z.uuid().parse(route.id);
    if (fixtureMode()) throw new RequestError(409, 'Project Model requires real database mode; repository fixtures never write project data.');
    const store = options.store ?? await projectStore();
    if (request.method === 'GET') {
      if (route.operation) throw new RequestError(405, 'Use POST for this operation.');
      const result = route.id ? { project: await store.requireProject(route.id), memories: await store.listMemories(route.id, z.coerce.number().int().min(1).max(100000).parse(new URL(request.url).searchParams.get('page') ?? 1)) } : await store.listProjects();
      return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
    }
    const body = await readJson(request);
    let value: unknown;
    if (!route.id && request.method === 'POST') value = createProjectSchema.parse(body);
    else if (route.id && !route.operation && request.method === 'PATCH') value = updateProjectSchema.parse(body);
    else if (route.id && request.method === 'POST') {
      switch (route.operation) {
        case 'memories': value = manualMemorySchema.parse(body); break;
        case 'archive-memory': value = archiveMemorySchema.parse(body); break;
        case 'search': value = searchMemorySchema.parse(body); break;
        case 'sync': value = syncInputSchema.parse(body); break;
        case 'index': value = z.strictObject({}).parse(body); break;
        default: throw new RequestError(404, 'Unknown project operation.');
      }
    } else throw new RequestError(405, 'Unsupported method.');
    const fingerprint = createHash('sha256').update(`${request.method}:${route.id ?? ''}:${operation}:${JSON.stringify(value)}`).digest('hex');
    const result = await globalGate.jonasProjectGate!(request.headers.get('x-request-id') ?? '', fingerprint, operation, async () => {
      if (!route.id) return store.createProject(value);
      if (!route.operation) return store.updateProject(route.id, value);
      if (operation === 'memories') return store.createManualMemory(route.id, value);
      if (operation === 'archive-memory') return store.archiveManualMemory(route.id, archiveMemorySchema.parse(value).memoryId);
      if (operation === 'search') return store.retrieve(route.id, value);
      if (operation === 'index') return store.indexPending(route.id);
      const sync = syncInputSchema.parse(value);
      return (options.sync ?? syncProjectTaskMemories)(route.id, { store, ...(sync.afterTaskId ? { afterTaskId: sync.afterTaskId } : {}) });
    });
    return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const failure = publicError(error, `project-${operation}`);
    return Response.json({ error: failure.error }, { status: failure.status, headers: { 'Cache-Control': 'no-store' } });
  }
}
