import { and, asc, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { tasks, runs, reviews, escalations, orchestrationEvents } from '../db/schema.js';
import { overviewSchema, taskListSchema, taskDetailSchema, escalationSchema, activityListSchema, projectSchema, taskQuerySchema } from './contracts.js';
import type { ProjectDto, TaskQuery } from './contracts.js';
import { buildTimeline, iso, mapActivity, mapEscalation, mapReview, mapRun, mapTask, overviewCounts, repositoryIdentity, safeText } from './mapping.js';
import type { TaskSummaryRow } from './mapping.js';
import { registeredRepositories, repositoryAvailability } from './repositories.js';

// Database imports are lazy: offline UI and production compilation do not need credentials.
async function database() { return (await import('../db/index.js')).db; }
export const taskColumns = {
  id: tasks.id, title: sql<string>`left(${tasks.title}, 300)`, status: tasks.status, category: tasks.category,
  repositoryPath: sql<string | null>`${tasks.repository}->>'path'`, capability: sql<string | null>`${tasks.chief}->>'capability'`,
  createdAt: tasks.createdAt, updatedAt: tasks.updatedAt,
};
const escapedSearch = (value: string) => `%${value.replace(/[\\%_]/g, '\\$&')}%`;
export function parseTaskQuery(input: Record<string, unknown>): TaskQuery {
  const clean = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== '' && value !== undefined));
  return taskQuerySchema.parse(clean);
}
// Normalize persisted strings in the shared identity mapper, never filesystem paths from a browser.
async function projectPaths(key: string): Promise<string[]> {
  const db = await database();
  const rows = await db.selectDistinct({ path: sql<string>`${tasks.repository}->>'path'` }).from(tasks)
    .where(sql`${tasks.repository}->>'path' is not null`).limit(2001);
  if (rows.length > 2000) throw new Error('Repository inventory exceeds the V1 limit.');
  return rows.filter(row => repositoryIdentity(row.path).key === key).map(row => row.path);
}
async function whereTasks(query: TaskQuery): Promise<SQL | undefined> {
  const filters: SQL[] = [];
  if (query.status) filters.push(query.status === 'active' ? inArray(tasks.status, ['running', 'repairing', 'reviewing'])
    : query.status === 'attention' ? inArray(tasks.status, ['failed', 'pending']) : eq(tasks.status, query.status));
  if (query.category) filters.push(eq(tasks.category, query.category));
  if (query.q) filters.push(or(ilike(tasks.title, escapedSearch(query.q)), ilike(tasks.objective, escapedSearch(query.q)),
    ilike(sql`${tasks.id}::text`, escapedSearch(query.q)))!);
  if (query.worker) filters.push(sql`${tasks.id} in (select ${runs.taskId} from ${runs} where ${runs.worker} = ${query.worker})`);
  if (query.project) {
    const paths = await projectPaths(query.project);
    filters.push(paths.length ? inArray(sql`${tasks.repository}->>'path'`, paths) : sql`false`);
  }
  return and(...filters);
}
async function withLatest(rows: TaskSummaryRow[]) {
  if (!rows.length) return [];
  const db = await database();
  const latest = await db.selectDistinctOn([runs.taskId], { taskId: runs.taskId, attempt: runs.attempt, worker: runs.worker, startedAt: runs.startedAt })
    .from(runs).where(inArray(runs.taskId, rows.map(row => row.id)))
    .orderBy(runs.taskId, desc(runs.attempt), desc(runs.startedAt), desc(runs.id));
  const byTask = new Map(latest.map(run => [run.taskId, run]));
  return rows.map(row => mapTask(row, byTask.get(row.id)));
}
export async function getTasks(input: TaskQuery) {
  const query = taskQuerySchema.parse(input), db = await database(), where = await whereTasks(query), pageSize = 30;
  const order = query.sort === 'newest' ? [desc(tasks.createdAt)] : query.sort === 'status' ? [asc(tasks.status), desc(tasks.updatedAt)] : [desc(tasks.updatedAt)];
  const [rows, count] = await Promise.all([
    db.select(taskColumns).from(tasks).where(where).orderBy(...order, desc(tasks.id)).limit(pageSize).offset((query.page - 1) * pageSize),
    db.select({ total: sql<number>`count(*)::int` }).from(tasks).where(where),
  ]);
  return taskListSchema.parse({ items: await withLatest(rows), total: count[0]?.total ?? 0, page: query.page, pageSize });
}
export async function getRepositorySummaries(): Promise<ProjectDto[]> {
  const db = await database();
  const rows = await db.select({ path: sql<string>`${tasks.repository}->>'path'`, status: tasks.status,
    count: sql<number>`count(*)::int`, updatedAt: sql<Date>`max(${tasks.updatedAt})` }).from(tasks)
    .where(sql`${tasks.repository}->>'path' is not null`).groupBy(sql`${tasks.repository}->>'path'`, tasks.status).limit(16001);
  if (rows.length > 16000) throw new Error('Repository inventory exceeds the V1 limit.');
  const groups = new Map<string, ProjectDto>();
  for (const row of await registeredRepositories()) {
    const identity = repositoryIdentity(row.path);
    groups.set(identity.key, { ...identity, name: safeText(row.name, 200), registered: true,
      ...await repositoryAvailability(row.path), running: 0, queued: 0, waiting: 0, failed: 0, completed: 0, total: 0,
      updatedAt: iso(row.updatedAt), latestStatus: 'No tasks' });
  }
  for (const row of rows) {
    const identity = repositoryIdentity(row.path);
    const group = groups.get(identity.key) ?? { ...identity, path: safeText(identity.path, 4096), registered: false, available: false, unavailableReason: 'Register this historical repository to delegate work.', running: 0, queued: 0, waiting: 0, failed: 0, completed: 0, total: 0, updatedAt: iso(row.updatedAt), latestStatus: row.status };
    group.total += row.count;
    if (['running', 'reviewing', 'repairing'].includes(row.status)) group.running += row.count;
    if (row.status === 'queued') group.queued += row.count;
    if (row.status === 'waiting_human') group.waiting += row.count;
    if (row.status === 'failed') group.failed += row.count;
    if (row.status === 'completed') group.completed += row.count;
    if (group.total === row.count || iso(row.updatedAt) > group.updatedAt) { group.updatedAt = iso(row.updatedAt); group.latestStatus = row.status; }
    groups.set(identity.key, group);
  }
  return [...groups.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(row => projectSchema.parse(row));
}
export async function getRepositoryContext(key: string) {
  const registered = (await registeredRepositories()).find(row => repositoryIdentity(row.path).key === key);
  if (!registered) return null;
  const availability = await repositoryAvailability(registered.path);
  if (!availability.available) return null;
  const paths = await projectPaths(key), db = await database();
  const [row] = paths.length ? await db.select({ baseBranch: sql<string | null>`${tasks.repository}->>'baseBranch'` })
    .from(tasks).where(inArray(sql`${tasks.repository}->>'path'`, paths)).orderBy(desc(tasks.updatedAt)).limit(1) : [];
  return { name: registered.name, repositoryPath: registered.path, ...(row?.baseBranch ? { baseBranch: row.baseBranch } : {}) };
}
export async function getOpenEscalations(options: { page?: number; all?: boolean; project?: string } = {}) {
  const db = await database(), page = options.page ?? 1;
  const filters: SQL[] = options.all ? [] : [eq(escalations.status, 'open')];
  if (options.project) {
    const paths = await projectPaths(options.project);
    filters.push(paths.length ? inArray(sql`${tasks.repository}->>'path'`, paths) : sql`false`);
  }
  const rows = await db.select({ escalation: { id: escalations.id, taskId: escalations.taskId, runId: escalations.runId, status: escalations.status,
    reasonType: escalations.reasonType, question: escalations.question, summary: escalations.summary, context: sql`null`,
    answer: escalations.answer, createdAt: escalations.createdAt, resolvedAt: escalations.resolvedAt }, task: taskColumns })
    .from(escalations).innerJoin(tasks, eq(escalations.taskId, tasks.id)).where(and(...filters))
    .orderBy(sql`case when ${escalations.status} = 'open' then 0 else 1 end`, desc(escalations.createdAt), desc(escalations.id)).limit(31).offset((page - 1) * 30);
  return { items: rows.slice(0, 30).map(row => escalationSchema.parse(mapEscalation(row.escalation, row.task))), page, hasMore: rows.length > 30 };
}
export async function getEscalation(id: string) {
  const db = await database();
  const [row] = await db.select({ escalation: { id: escalations.id, taskId: escalations.taskId, runId: escalations.runId, status: escalations.status,
    reasonType: escalations.reasonType, question: escalations.question, summary: escalations.summary, context: sql`null`,
    answer: escalations.answer, createdAt: escalations.createdAt, resolvedAt: escalations.resolvedAt }, task: taskColumns })
    .from(escalations).innerJoin(tasks, eq(escalations.taskId, tasks.id)).where(eq(escalations.id, id)).limit(1);
  return row ? escalationSchema.parse(mapEscalation(row.escalation, row.task)) : null;
}
export async function getRecentActivity(page = 1, project?: string) {
  const db = await database();
  let where: SQL = sql`true`;
  if (project) {
    const paths = await projectPaths(project);
    where = paths.length ? inArray(sql`${tasks.repository}->>'path'`, paths) : sql`false`;
  }
  // Merge persisted records for task creation and legacy flows lacking audit events.
  // Labels describe the record, never invent the actor, model or exact verifier start.
  const result = await db.execute<{
    id: string; taskId: string; runId: string | null; kind: string; data: unknown; createdAt: Date; title: string;
  }>(sql`
    with task_context as (
      select ${tasks.id} as id, left(${tasks.title}, 300) as title, ${tasks.createdAt} as created_at
      from ${tasks} where ${where}
    ), event_markers as (
      select e.run_id,
        bool_or(e.kind in ('worker_started', 'attempt_reserved')) as has_start,
        bool_or(e.kind = 'attempt_finished') as has_finish,
        bool_or(e.kind = 'review_finished') as has_review
      from ${orchestrationEvents} e join task_context t on t.id = e.task_id
      where e.run_id is not null group by e.run_id
    ), feed as (
      select e.id::text as id, e.task_id as "taskId", e.run_id as "runId", e.kind,
        jsonb_build_object('worker', r.worker, 'attempt', e.data->'attempt', 'verified', e.data->'verified',
          'enforcedCapability', left(e.data->>'enforcedCapability', 100), 'reason', left(e.data->>'reason', 1000),
          'reasonType', left(e.data->>'reasonType', 100), 'reviewer', left(e.data->>'reviewer', 100),
          'decision', case when jsonb_typeof(e.data->'decision') = 'object' then jsonb_build_object('summary', left(e.data->'decision'->>'summary', 1000)) else e.data->'decision' end) as data,
        e.created_at as "createdAt", t.title
      from ${orchestrationEvents} e join task_context t on t.id = e.task_id left join ${runs} r on r.id = e.run_id
      union all
      select 'task:' || t.id::text, t.id, null::uuid, 'task_created', '{}'::jsonb, t.created_at, t.title from task_context t
      union all
      select 'run-start:' || r.id::text, r.task_id, r.id, 'recorded_run_start',
        jsonb_build_object('worker', r.worker, 'attempt', r.attempt), r.started_at, t.title
      from ${runs} r join task_context t on t.id = r.task_id left join event_markers m on m.run_id = r.id
      where not coalesce(m.has_start, false)
      union all
      select 'run-finish:' || r.id::text, r.task_id, r.id, 'recorded_run_finish',
        jsonb_build_object('worker', r.worker, 'attempt', r.attempt, 'reason', r.status), r.finished_at, t.title
      from ${runs} r join task_context t on t.id = r.task_id left join event_markers m on m.run_id = r.id
      where r.finished_at is not null and not coalesce(m.has_finish, false)
      union all
      select 'review:' || v.id::text, v.task_id, v.run_id, 'recorded_review_finish',
        jsonb_build_object('reviewer', v.reviewer, 'reason', v.result->>'decision'), v.finished_at, t.title
      from ${reviews} v join task_context t on t.id = v.task_id left join event_markers m on m.run_id = v.run_id
      where v.finished_at is not null and not coalesce(m.has_review, false)
    ) select * from feed order by "createdAt" desc, id desc limit 51 offset ${(page - 1) * 50}
  `);
  return activityListSchema.parse({ items: result.rows.slice(0, 50).map(row => mapActivity(row, row.title)), page, hasMore: result.rows.length > 50 });
}
export async function getOverview() {
  const db = await database();
  const [counts, active, queued, failures, decisions, activity] = await Promise.all([
    db.select({ status: tasks.status, count: sql<number>`count(*)::int` }).from(tasks).groupBy(tasks.status),
    db.select(taskColumns).from(tasks).where(inArray(tasks.status, ['running', 'repairing', 'reviewing'])).orderBy(desc(tasks.updatedAt)).limit(20),
    db.select(taskColumns).from(tasks).where(eq(tasks.status, 'queued')).orderBy(desc(tasks.updatedAt)).limit(10),
    db.select(taskColumns).from(tasks).where(inArray(tasks.status, ['failed', 'pending'])).orderBy(desc(tasks.updatedAt)).limit(10),
    getOpenEscalations(), getRecentActivity(),
  ]);
  const mapped = await withLatest([...active, ...queued, ...failures]), byId = new Map(mapped.map(t => [t.id, t]));
  return overviewSchema.parse({ counts: overviewCounts(counts), active: active.map(t => byId.get(t.id)), queued: queued.map(t => byId.get(t.id)),
    failures: failures.map(t => byId.get(t.id)), decisions: decisions.items.slice(0, 8), activity: activity.items.slice(0, 15) });
}

// Clip log fields in PostgreSQL before transport. Overview/list queries never select run.result.
const boundedResult = sql`jsonb_build_object(
  'error', left(${runs.result}->>'error', 2000),
  'workerResult', jsonb_build_object('success', ${runs.result}->'workerResult'->'success', 'message', left(${runs.result}->'workerResult'->>'message', 8000), 'messageTruncated', length(${runs.result}->'workerResult'->>'message') > 8000),
  'git', case when ${runs.result}->'git' is null then null else jsonb_build_object(
    'countIsLowerBound', coalesce((${runs.result}->'git'->>'truncated')::boolean, false),
    'changedFileCount', jsonb_array_length(coalesce(${runs.result}->'git'->'changedFiles', '[]'::jsonb)),
    'statusShort', left(${runs.result}->'git'->>'statusShort', 8000), 'diffStat', left(${runs.result}->'git'->>'diffStat', 8000),
    'truncated', coalesce((${runs.result}->'git'->>'truncated')::boolean, false) or jsonb_array_length(coalesce(${runs.result}->'git'->'changedFiles', '[]'::jsonb)) > 100,
    'changedFiles', (select coalesce(jsonb_agg(left(f #>> '{}', 500)), '[]'::jsonb) from (select value as f from jsonb_array_elements(coalesce(${runs.result}->'git'->'changedFiles', '[]'::jsonb)) limit 100) files)) end,
  'verification', jsonb_build_object('checks', (select coalesce(jsonb_agg(jsonb_build_object(
    'name', c->>'name', 'command', left(c->>'command', 300), 'success', c->'success', 'skipped', c->'skipped', 'timedOut', c->'timedOut',
    'exitCode', c->'exitCode', 'durationMs', c->'durationMs', 'stdout', left(c->>'stdout', 8000), 'stderr', left(c->>'stderr', 8000),
    'outputTruncated', length(coalesce(c->>'stdout', '')) + length(coalesce(c->>'stderr', '')) > 8000)), '[]'::jsonb)
    from (select value as c from jsonb_array_elements(coalesce(${runs.result}->'verification'->'checks', '[]'::jsonb)) limit 20) checks)))`;
const boundedTextArray = (column: SQL, limit: number) => sql<string[]>`(
  select coalesce(jsonb_agg(left(v, 2000)), '[]'::jsonb)
  from (select value as v from jsonb_array_elements_text(${column}) limit ${limit}) entries
)`;
export async function getTaskDetail(id: string) {
  const db = await database();
  const [task] = await db.select({ ...taskColumns, objective: sql<string>`left(${tasks.objective}, 16000)`,
    acceptanceCriteria: boundedTextArray(sql`${tasks.acceptanceCriteria}`, 50), context: boundedTextArray(sql`${tasks.context}`, 20),
    textTruncated: sql<boolean>`length(${tasks.objective}) > 16000 or jsonb_array_length(${tasks.acceptanceCriteria}) > 50 or jsonb_array_length(${tasks.context}) > 20
      or exists (select 1 from jsonb_array_elements_text(${tasks.acceptanceCriteria} || ${tasks.context}) v where length(v) > 2000)`, risk: tasks.risk, difficulty: tasks.difficulty, maxAttempts: tasks.maxAttempts })
    .from(tasks).where(eq(tasks.id, id)).limit(1);
  if (!task) return null;
  const [rawRuns, rawReviews, rawDecisions, rawEvents] = await Promise.all([
    db.select({ id: runs.id, taskId: runs.taskId, attempt: runs.attempt, worker: runs.worker, tier: runs.tier, status: runs.status,
      result: boundedResult, workspace: runs.workspace, routing: runs.routing, parentRunId: runs.parentRunId, failureKind: runs.failureKind,
      error: sql<string | null>`left(${runs.error}, 2000)`, startedAt: runs.startedAt, finishedAt: runs.finishedAt })
      .from(runs).where(eq(runs.taskId, id)).orderBy(desc(runs.attempt), desc(runs.startedAt)).limit(101),
    db.select().from(reviews).where(eq(reviews.taskId, id)).orderBy(desc(reviews.createdAt)).limit(101),
    db.select({ id: escalations.id, taskId: escalations.taskId, runId: escalations.runId, status: escalations.status,
      reasonType: escalations.reasonType, question: escalations.question, summary: escalations.summary, context: sql`null`,
      answer: escalations.answer, createdAt: escalations.createdAt, resolvedAt: escalations.resolvedAt })
      .from(escalations).where(eq(escalations.taskId, id)).orderBy(desc(escalations.createdAt)).limit(101),
    db.select().from(orchestrationEvents).where(eq(orchestrationEvents.taskId, id)).orderBy(desc(orchestrationEvents.createdAt)).limit(501),
  ]);
  const item = mapTask(task, rawRuns[0]), mappedRuns = rawRuns.slice(0, 100).map(mapRun).reverse(), mappedReviews = rawReviews.slice(0, 100).map(mapReview).reverse();
  const decisions = rawDecisions.slice(0, 100).map(row => mapEscalation(row, task));
  return taskDetailSchema.parse({ task: { ...item, objective: safeText(task.objective, 16000),
    acceptanceCriteria: task.acceptanceCriteria.slice(0, 50).map(v => safeText(v, 2000)), context: task.context.slice(0, 20).map(v => safeText(v, 2000)),
    repository: task.repositoryPath ? safeText(repositoryIdentity(task.repositoryPath).path, 1000) : null,
    risk: task.risk, difficulty: task.difficulty, maxAttempts: task.maxAttempts, textTruncated: task.textTruncated },
    runs: mappedRuns, reviews: mappedReviews, decisions,
    timeline: buildTimeline(item, mappedRuns, mappedReviews, decisions, rawEvents.slice(0, 500).map(row => mapActivity(row, task.title))),
    historyTruncated: rawRuns.length > 100 || rawReviews.length > 100 || rawDecisions.length > 100 || rawEvents.length > 500 });
}
