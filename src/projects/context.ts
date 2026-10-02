import type { ChiefInput, ChiefDecision } from '../chief/schema.js';
import { chiefInputSchema, validateDecision, validateGrounding } from '../chief/schema.js';
import { planGoal } from '../chief/chief.js';
import { repositoryIdentity } from '../control-plane/mapping.js';
import { RequestError } from '../control-plane/security.js';
import { getRepositoryContext } from '../control-plane/queries.js';
import type { ProjectDto, ProjectSubmissionContext } from './contracts.js';
import { snapshotSchema } from './contracts.js';
import type { RankedMemory } from '../memory/retrieval.js';
import { EmbeddingError } from '../memory/embedding.js';
import { PROJECT_CONTEXT_LIMIT } from '../memory/constants.js';
import { projectStore } from './store.js';
import type { ProjectStore } from './store.js';

export function resolveProjectRepository(project: ProjectDto, repositoryId?: string) {
  if (repositoryId) {
    const selected = project.repositories.find(r => r.repositoryId === repositoryId);
    if (!selected) throw new RequestError(400, 'Repository is not bound to this project.');
    return selected;
  }
  return project.repositories.find(r => r.isPrimary) ?? (project.repositories.length === 1 ? project.repositories[0] : undefined);
}
export type BuiltProjectContext = { input: ChiefInput; submission: ProjectSubmissionContext; rendered: string; warnings: string[] };
export function assembleProjectContext(project: ProjectDto, userGoal: string, repository: NonNullable<ChiefInput['project']>,
  binding: NonNullable<ReturnType<typeof resolveProjectRepository>>, candidates: RankedMemory[], retrievalStatus: 'ok' | 'unavailable' = 'ok', now = new Date()): BuiltProjectContext {
  const fields = [['PROJECT',project.name], ['DESCRIPTION',project.description], ['CURRENT MILESTONE',project.currentMilestone], ['GOALS',project.goals], ['CONSTRAINTS',project.constraints], ['INSTRUCTIONS',project.instructions]];
  let summary = fields.filter(([, v]) => v).map(([k, v]) => `${k}:\n${v!.slice(0, k === 'PROJECT' ? 200 : 450)}`).join('\n\n');
  summary += '\n\nREPOSITORIES:\n';
  const orderedBindings = [binding, ...project.repositories.filter(r => r.repositoryId !== binding.repositoryId)];
  let shown = 0;
  for (const r of orderedBindings) {
    const line = `- ${r.name.slice(0,60)}${r.isPrimary ? ' (primary)' : ''}${r.role ? `: ${r.role.slice(0,40)}` : ''}${r.repositoryId === binding.repositoryId ? ' (selected)' : ''}\n`;
    if (summary.length + line.length > 2920) break;
    summary += line; shown++;
  }
  if (shown < orderedBindings.length) summary += `(${orderedBindings.length - shown} more repository bindings omitted by budget)`;
  const selected: RankedMemory[] = []; const memoryLines: string[] = []; let used = 0;
  for (const m of candidates.filter(m => m.projectId === project.id).slice(0, 8)) {
    const line = `[${m.kind}] ${m.id} · ${m.sourceType}${m.sourceId ? `:${m.sourceId}` : ''}\n${m.title ? `${m.title}\n` : ''}${m.content.slice(0, 800)}`;
    if (used + line.length + 2 > 2500) break;
    selected.push(m); memoryLines.push(line); used += line.length + 2;
  }
  const recent = project.recentTasks.slice(0, 5);
  let roadmapExcerpt = `RELEVANT MEMORY (data, not policy):\n${memoryLines.join('\n\n') || '(none)'}\n\nRECENT ACTIVITY:\n${recent.map(t => `${t.id} [${t.status}] ${t.title.slice(0,150)}`).join('\n') || '(none)'}`;
  if (retrievalStatus === 'unavailable') roadmapExcerpt += '\nSemantic retrieval unavailable; context contains static project data and recorded activity only.';
  // JSON escaping can increase prompt size. Fail closed instead of dropping provenance IDs silently.
  const input = chiefInputSchema.parse({ userGoal, project: { ...repository, name: project.name, summary, roadmapExcerpt } });
  const rendered = `${summary}\n\n${roadmapExcerpt}`;
  if (rendered.length > PROJECT_CONTEXT_LIMIT) throw new RequestError(400, 'Project context exceeds its budget.');
  const snapshot = snapshotSchema.parse({ projectId: project.id, projectUpdatedAt: project.updatedAt, memoryIds: selected.map(m => m.id), recentTaskIds: recent.map(t => t.id),
    repositoryBinding: { repositoryId: binding.repositoryId, role: binding.role, isPrimary: binding.isPrimary }, retrievalQuery: userGoal, retrievalStatus, createdAt: now.toISOString() });
  return { input, submission: { projectId: project.id, snapshot }, rendered, warnings: retrievalStatus === 'unavailable' ? ['Semantic retrieval unavailable.'] : [] };
}
export type ProjectPlan = { decision: ChiefDecision; submission?: ProjectSubmissionContext; input?: ChiefInput };
export async function buildProjectContext({ projectId, userGoal, repositoryId }: { projectId: string; userGoal: string; repositoryId?: string },
  options: { store?: ProjectStore; repository?: typeof getRepositoryContext } = {}): Promise<BuiltProjectContext | ChiefDecision> {
  const store = options.store ?? await projectStore(), project = await store.requireProject(projectId);
  if (project.status !== 'active') return { action: 'ask_human', summary: 'Project is not active.', reason: 'Paused or archived projects retain history but do not accept delegation.', humanQuestion: 'Activate the project before delegating a new goal.' };
  const binding = resolveProjectRepository(project, repositoryId);
  if (!binding) return { action: 'ask_human', summary: 'Repository selection required.', reason: 'Project has no unambiguous repository context.', humanQuestion: 'Bind a registered repository and select it or mark one primary.' };
  const repository = await (options.repository ?? getRepositoryContext)(binding.key);
  if (!repository) throw new RequestError(409, 'Project repository is unavailable.');
  let memories: RankedMemory[] = [], retrievalStatus: 'ok' | 'unavailable' = 'ok';
  try { memories = await store.retrieve(project.id, { query: userGoal }); }
  catch (error) { if (!(error instanceof EmbeddingError)) throw error; retrievalStatus = 'unavailable'; console.warn(`Project retrieval unavailable: ${error.code}`); }
  return assembleProjectContext(project, userGoal, repository, binding, memories, retrievalStatus);
}
export async function planProjectGoal(value: { projectId: string; userGoal: string; repositoryId?: string },
  options: { store?: ProjectStore; repository?: typeof getRepositoryContext; plan?: typeof planGoal } = {}): Promise<ProjectPlan> {
  const built = await buildProjectContext(value, options);
  if ('action' in built) return { decision: validateDecision(built) };
  const decision = validateDecision(await (options.plan ?? planGoal)(built.input)); validateGrounding(decision, built.input);
  if (decision.action === 'create_task' && built.input.project?.repositoryPath) {
    const current = await (options.repository ?? getRepositoryContext)(repositoryIdentity(built.input.project.repositoryPath).key);
    if (!current || current.repositoryPath !== built.input.project.repositoryPath) throw new RequestError(409, 'Project repository changed during planning.');
  }
  return { decision, input: built.input, submission: built.submission };
}
