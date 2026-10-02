import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { RequestError } from '../control-plane/security.js';
import { iso, repositoryIdentity, safeText } from '../control-plane/mapping.js';
import { createProjectSchema, updateProjectSchema, memoryInputSchema, manualMemorySchema, projectDtoSchema, memoryDtoSchema, searchMemorySchema } from './contracts.js';
import type { ProjectDto, MemoryDto } from './contracts.js';
import { OllamaEmbeddingAdapter, EmbeddingError, validateVector } from '../memory/embedding.js';
import type { EmbeddingAdapter } from '../memory/embedding.js';
import { rankMemories } from '../memory/retrieval.js';
import { RETRIEVAL_CANDIDATES } from '../memory/constants.js';

type Client = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;
const projectColumns = `id,slug,name,description,status,current_milestone as "currentMilestone",goals,constraints,instructions,created_at as "createdAt",updated_at as "updatedAt"`;
// No vector is ever selected by UI/read APIs.
const memoryColumns = `id,project_id as "projectId",kind,title,content,importance,source_type as "sourceType",source_id as "sourceId",source_metadata as "sourceMetadata",content_hash as "contentHash",embedding_model as "embeddingModel",embedding is not null as indexed,embedding_error as "embeddingError",created_at as "createdAt",updated_at as "updatedAt"`;
export function memoryHash(input: z.infer<typeof memoryInputSchema>) {
  // Provenance is part of identity: different source records remain independently explainable.
  return createHash('sha256').update(JSON.stringify([input.kind, input.title ?? null, input.content, input.sourceId ?? null])).digest('hex');
}
function redactMetadata(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[bounded]';
  if (typeof value === 'string') return safeText(value,2000);
  if (Array.isArray(value)) return value.slice(0,30).map(v => redactMetadata(v,depth+1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0,30).map(([key,v]) => [safeText(key,100), /key|token|secret|password|credential/i.test(key) ? '[REDACTED]' : redactMetadata(v,depth+1)]));
  return value;
}
function memoryDto(row: Record<string, unknown>): MemoryDto {
  return memoryDtoSchema.parse({ ...row, title: row.title === null ? null : safeText(row.title, 200), content: safeText(row.content, 8000),
    sourceId: row.sourceId === null ? null : safeText(row.sourceId,200), sourceMetadata: row.sourceMetadata ? redactMetadata(row.sourceMetadata) : null,
    createdAt: iso(row.createdAt as Date), updatedAt: iso(row.updatedAt as Date) });
}
function sqlConflict(error: unknown): never {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
  if (code === '23505') throw new RequestError(409, 'Project slug or primary repository already exists.');
  if (code === '23503') throw new RequestError(409, 'Repository or project is no longer available.');
  throw error;
}
export class ProjectStore {
  constructor(public readonly pool: Pool, private adapter: EmbeddingAdapter = new OllamaEmbeddingAdapter()) {}
  private async transaction<T>(run: (client: PoolClient) => Promise<T>) {
    const client = await this.pool.connect();
    try { await client.query('begin'); const result = await run(client); await client.query('commit'); return result; }
    catch (error) { await client.query('rollback'); return sqlConflict(error); }
    finally { client.release(); }
  }
  private async replaceBindings(client: Client, projectId: string, bindings: z.infer<typeof createProjectSchema>['repositories']) {
    // Registry owns paths and validation. Projects never register filesystem identities.
    const ids = bindings.map(b => b.repositoryId);
    if (ids.length) {
      const rows = await client.query('select id from repositories where id = any($1::uuid[]) for key share', [ids]);
      if (rows.rowCount !== ids.length) throw new RequestError(400, 'Select registered repositories only.');
    }
    await client.query('delete from project_repositories where project_id=$1', [projectId]);
    for (const b of bindings) await client.query('insert into project_repositories(project_id,repository_id,role,is_primary) values($1,$2,$3,$4)', [projectId, b.repositoryId, b.role ?? null, b.isPrimary]);
  }
  async createProject(value: unknown): Promise<ProjectDto> {
    const v = createProjectSchema.parse(value);
    const slug = v.slug ?? v.name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 100).replace(/-$/, '');
    if (!slug) throw new RequestError(400, 'Supply a slug with ASCII letters or numbers.');
    const id = await this.transaction(async client => {
      const row = await client.query(`insert into projects(slug,name,description,status,current_milestone,goals,constraints,instructions) values($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
        [slug, v.name, v.description ?? null, v.status, v.currentMilestone ?? null, v.goals ?? null, v.constraints ?? null, v.instructions ?? null]);
      const id = row.rows[0].id as string; await this.replaceBindings(client, id, v.repositories); return id;
    });
    return (await this.getProject(id))!;
  }
  async updateProject(id: string, value: unknown): Promise<ProjectDto> {
    z.uuid().parse(id); const v = updateProjectSchema.parse(value);
    const names: Record<string, string> = { name: 'name', description: 'description', status: 'status', currentMilestone: 'current_milestone', goals: 'goals', constraints: 'constraints', instructions: 'instructions' };
    await this.transaction(async client => {
      const row = await client.query('select id from projects where id=$1 for update', [id]);
      if (!row.rowCount) throw new RequestError(404, 'Project does not exist.');
      const entries = Object.entries(v).filter(([key, value]) => key !== 'repositories' && value !== undefined);
      await client.query(`update projects set ${entries.map(([key], i) => `${names[key]}=$${i + 2}`).concat('updated_at=clock_timestamp()').join(',')} where id=$1`, [id, ...entries.map(([, value]) => value)]);
      if (v.repositories !== undefined) await this.replaceBindings(client, id, v.repositories);
    }); return (await this.getProject(id))!;
  }
  async getProject(id: string, client: Client = this.pool): Promise<ProjectDto | null> {
    z.uuid().parse(id);
    const rows = await client.query(`select ${projectColumns} from projects where id=$1`, [id]);
    if (!rows.rowCount) return null;
    const row = rows.rows[0];
    const [bindings, recent] = await Promise.all([
      client.query(`select r.id as "repositoryId", r.name,r.path,b.role,b.is_primary as "isPrimary" from project_repositories b join repositories r on r.id=b.repository_id where b.project_id=$1 order by b.is_primary desc,r.name,r.id limit 20`, [id]),
      client.query(`select id,left(title,300) as title,status,updated_at as "updatedAt" from tasks where project_id=$1 order by updated_at desc,id desc limit 5`, [id]),
    ]);
    return projectDtoSchema.parse({ ...row, ...Object.fromEntries(['name','description','goals','constraints','instructions','currentMilestone'].map(k => [k, row[k] === null ? null : safeText(row[k], 3000)])),
      createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt),
      repositories: bindings.rows.map(b => ({ repositoryId: b.repositoryId, key: repositoryIdentity(b.path).key, name: safeText(b.name, 200), role: b.role === null ? null : safeText(b.role, 100), isPrimary: b.isPrimary })),
      recentTasks: recent.rows.map(t => ({ ...t, title: safeText(t.title, 300), updatedAt: iso(t.updatedAt) })) });
  }
  async listProjects(): Promise<ProjectDto[]> {
    const rows = await this.pool.query('select id from projects order by updated_at desc,id desc limit 101');
    if (rows.rows.length > 100) throw new RequestError(409, 'Project inventory exceeds the V1 limit of 100.');
    const result: ProjectDto[] = [];
    for (const { id } of rows.rows) { const p = await this.getProject(id); if (p) result.push(p); } return result;
  }
  async requireProject(id: string) { const p = await this.getProject(id); if (!p) throw new RequestError(404, 'Project does not exist.'); return p; }
  async listMemories(projectId: string, page = 1) {
    await this.requireProject(projectId); z.number().int().min(1).max(100000).parse(page);
    const rows = await this.pool.query(`select ${memoryColumns} from project_memories where project_id=$1 and archived_at is null order by created_at desc,id desc limit 51 offset $2`, [projectId, (page - 1) * 50]);
    return { items: rows.rows.slice(0, 50).map(memoryDto), page, hasMore: rows.rows.length > 50 };
  }
  async insertMemory(projectId: string, value: unknown) {
    await this.requireProject(projectId); const v = memoryInputSchema.parse(value), hash = memoryHash(v);
    const row = await this.pool.query(`insert into project_memories(project_id,kind,title,content,importance,source_type,source_id,source_metadata,content_hash)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict do nothing returning ${memoryColumns}`,
      [projectId, v.kind, v.title ?? null, v.content, v.importance, v.sourceType, v.sourceId ?? null, v.sourceMetadata ?? null, hash]);
    const existing = row.rows[0] ?? (await this.pool.query(`select ${memoryColumns},archived_at as "archivedAt" from project_memories where project_id=$1 and source_type=$2 and
      (content_hash=$3 or ($2='task_outcome_sync' and source_id=$4)) order by id limit 1`, [projectId, v.sourceType, hash, v.sourceId ?? null])).rows[0];
    if (!existing) throw new Error('Memory did not persist.');
    if (existing.archivedAt) throw new RequestError(409, 'This exact manual memory is archived. Supply updated content to create a new entry.');
    return { memory: memoryDto(existing), created: Boolean(row.rowCount) };
  }
  async createManualMemory(projectId: string, value: unknown) {
    const input = manualMemorySchema.parse(value), result = await this.insertMemory(projectId, { ...input, sourceType: 'manual', sourceMetadata: { input: 'explicit_human' } });
    const index = result.memory.indexed ? { indexed: true, error: null } : await this.indexMemory(projectId, result.memory.id);
    return { ...result, indexing: index };
  }
  async archiveManualMemory(projectId: string, memoryId: string) {
    z.uuid().parse(projectId); z.uuid().parse(memoryId);
    const row = await this.pool.query(`update project_memories set archived_at=coalesce(archived_at,now()),updated_at=now() where project_id=$1 and id=$2 and source_type='manual' returning id`, [projectId, memoryId]);
    if (!row.rowCount) throw new RequestError(409, 'Only an existing manual memory can be archived.');
    return { archived: true };
  }
  async indexMemory(projectId: string, id: string): Promise<{ indexed: boolean; error: string | null }> {
    z.uuid().parse(projectId); z.uuid().parse(id);
    const row = await this.pool.query(`select title,content from project_memories where project_id=$1 and id=$2 and archived_at is null`, [projectId, id]);
    if (!row.rowCount) return { indexed: false, error: 'not_available' };
    try {
      const embedding = await this.adapter.embed([row.rows[0].title, row.rows[0].content].filter(Boolean).join('\n'));
      validateVector(embedding.vector);
      const result = await this.pool.query(`update project_memories set embedding=$3::vector,embedding_model=$4,embedding_error=null,updated_at=now() where project_id=$1 and id=$2 and archived_at is null`, [projectId, id, JSON.stringify(embedding.vector), embedding.model]);
      return { indexed: Boolean(result.rowCount), error: result.rowCount ? null : 'not_available' };
    } catch (error) {
      const code = error instanceof EmbeddingError ? error.code : 'indexing_failed';
      await this.pool.query('update project_memories set embedding_error=$3 where project_id=$1 and id=$2', [projectId, id, code]);
      return { indexed: false, error: code };
    }
  }
  async indexPending(projectId: string) {
    await this.requireProject(projectId);
    const rows = await this.pool.query('select id from project_memories where project_id=$1 and embedding is null and archived_at is null order by created_at,id limit 30', [projectId]);
    let indexed = 0; for (const row of rows.rows) if ((await this.indexMemory(projectId, row.id)).indexed) indexed++;
    return { scanned: rows.rows.length, indexed, embeddingFailures: rows.rows.length - indexed };
  }
  async retrieve(projectId: string, value: unknown) {
    await this.requireProject(projectId); const v = searchMemorySchema.parse(value), embedding = await this.adapter.embed(v.query, true); validateVector(embedding.vector);
    const rows = await this.pool.query(`select ${memoryColumns}, 1 - (embedding <=> $2::vector) as similarity from project_memories
      where project_id=$1 and archived_at is null and embedding is not null and embedding_model=$3
      order by embedding <=> $2::vector, id limit $4`, [projectId, JSON.stringify(embedding.vector), embedding.model, RETRIEVAL_CANDIDATES]);
    return rankMemories(projectId, rows.rows.map(r => ({ ...memoryDto(r), similarity: Number(r.similarity) })), v.limit);
  }
}
export async function projectStore() { const { pool } = await import('../db/index.js'); return new ProjectStore(pool); }
