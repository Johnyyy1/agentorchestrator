import 'server-only';
import * as queries from '../../../src/control-plane/queries.js';
import { fixtureMode, fixtures } from '../../../src/control-plane/fixtures.js';
import { getProviderStatus } from '../../../src/control-plane/providers.js';
import type { TaskQuery } from '../../../src/control-plane/contracts.js';
export { parseTaskQuery } from '../../../src/control-plane/queries.js';
export { fixtureMode };
export const overview = () => fixtureMode() ? Promise.resolve(fixtures().overview()) : queries.getOverview();
export const tasks = (query: TaskQuery) => fixtureMode() ? Promise.resolve(fixtures().list(query)) : queries.getTasks(query);
export const task = (id: string) => fixtureMode() ? Promise.resolve(fixtures().detail(id)) : queries.getTaskDetail(id);
export const repositories = () => fixtureMode() ? Promise.resolve(fixtures().projects()) : queries.getRepositorySummaries();
export const decisions = (page = 1, project?: string) => {
  if (!fixtureMode()) return queries.getOpenEscalations({ page, all: true, ...(project ? { project } : {}) });
  const rows = fixtures().decisions().filter(e => !project || fixtures().detail(e.taskId)?.task.projectKey === project)
    .sort((a, b) => Number(b.status === 'open') - Number(a.status === 'open') || b.createdAt.localeCompare(a.createdAt));
  return Promise.resolve({ items: rows.slice((page - 1) * 30, page * 30), page, hasMore: rows.length > page * 30 });
};
export const decision = (id: string) => fixtureMode() ? Promise.resolve(fixtures().decisions().find(e => e.id === id) ?? null) : queries.getEscalation(id);
export const activity = (page = 1, project?: string) => {
  if (!fixtureMode()) return queries.getRecentActivity(page, project);
  const rows = fixtures().activity().filter(e => !project || fixtures().detail(e.taskId)?.task.projectKey === project);
  return Promise.resolve({ items: rows.slice((page - 1) * 50, page * 50), page, hasMore: rows.length > page * 50 });
};
export const providers = () => fixtureMode() ? Promise.resolve(fixtures().providers()) : getProviderStatus();
export async function load<T>(query: () => Promise<T>): Promise<{ ok: true; data: T } | { ok: false }> {
  try { return { ok: true, data: await query() }; }
  catch { return { ok: false }; }
}

export const projects = async () => fixtureMode() ? [] : (await import('../../../src/projects/store.js')).projectStore().then(s => s.listProjects());
export const projectDetail = async (id: string, page = 1) => {
  if (fixtureMode()) return null;
  const store = await (await import('../../../src/projects/store.js')).projectStore();
  const project = await store.getProject(id); if (!project) return null;
  return { project, memories: await store.listMemories(id, page) };
};
export const repositoryOptions = async () => fixtureMode() ? [] : (await import('../../../src/control-plane/repositories.js')).registeredRepositories().then(rows => rows.map(r => ({ id: r.id, name: r.name })));
