// Explicit development-only, in-memory fixtures. Never writes to PostgreSQL or starts a worker.
import { validateRepositoryPath } from './repositories.js';
import { registeredRepositorySchema, registerRepositoryInputSchema } from './contracts.js';
import { RequestError } from './security.js';
import { randomUUID } from 'node:crypto';
import type { tasks, runs, reviews, escalations, orchestrationEvents } from '../db/schema.js';
import { buildTimeline, mapActivity, mapEscalation, mapReview, mapRun, mapTask, overviewCounts, repositoryIdentity } from './mapping.js';
import { overviewSchema, taskDetailSchema, taskListSchema } from './contracts.js';
import type { ProjectDto, TaskQuery, ProviderStatusDto } from './contracts.js';
import type { MutationServices } from './mutations.js';
import { submitDecision } from '../chief/submit-decision.js';

const fixtureId = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const fixtureTaskId = fixtureId(3), fixtureDecisionId = fixtureId(501);
export function fixtureMode() {
  if (process.env.CONTROL_PLANE_FIXTURES !== '1') return false;
  if (process.env.NODE_ENV === 'production') throw new Error('Development fixtures are disabled in production.');
  return true;
}
export function createFixtureStore() {
  const now = Date.now(), at = (minutes: number) => new Date(now - minutes * 60000);
  const taskRows: Array<typeof tasks.$inferSelect> = [
    ['Implement portfolio benchmark comparison', 'running', 'Investi', 'coding', 'local-coding'],
    ['Export analytics as a CSV file', 'queued', 'Investi', 'coding', 'strong-coding'],
    ['Correct dividend currency conversion', 'completed', 'Investi', 'coding', 'local-coding'],
    ['Choose the account recovery policy', 'waiting_human', 'Atlas', 'coding', 'strong-coding'],
    ['Audit dependency update boundaries', 'failed', 'Atlas', 'research', 'research'],
    ['Tighten portfolio import validation', 'repairing', 'Investi', 'coding', 'strong-coding'],
  ].map(([title, status, project, category, capability], index) => ({
    id: fixtureId(index + 1), title: title!, status: status!, category: category!,
    objective: index === 2 ? 'Use the transaction settlement currency when computing dividend totals. Preserve the existing portfolio API and validate the conversion against historical rates.' : `Deliver: ${title}. Keep the change focused and verify the outcome against the stated criteria.`,
    difficulty: 2, risk: 'low', context: ['Development fixture · no real agent has executed this task.'],
    acceptanceCriteria: ['Existing behavior remains compatible.', 'Tests cover the changed behavior.', 'Typecheck completes without errors.'],
    maxAttempts: 3, repository: { path: `/development/fixtures/${project!.toLowerCase()}`, baseBranch: 'main' },
    chief: { capability: capability as 'local-coding', workerBrief: 'Explicit development fixture.' },
    queueName: 'control-plane.fixture.only', orchestration: null, createdAt: at(120 - index * 10), updatedAt: at(index === 0 ? 0 : index * 3),
  }));
  const registry = new Map([...new Set(taskRows.map(t => t.repository!.path))].map(path => [path, randomUUID()]));
  const runRows: Array<typeof runs.$inferSelect> = [];
  function run(task: number, attempt: number, worker: string, status: string, minutes: number, failed = false) {
    const row = taskRows[task - 1]!;
    const finishedAt = status === 'running' ? null : at(minutes - 3);
    const check = (name: string) => ({ name, command: `npm run ${name}`, success: !(failed && name === 'test'), skipped: name === 'lint', timedOut: false,
      exitCode: failed && name === 'test' ? 1 : 0, durationMs: name === 'build' ? 11240 : 1200,
      stdout: failed && name === 'test' ? 'AssertionError: expected converted amount 125.40, received 121.30\nDividend settlement currency should be EUR.' : '',
      stderr: name === 'lint' ? 'Script is not defined.' : '' });
    const id = fixtureId(100 + task * 10 + attempt);
    runRows.push({ id, taskId: row.id, attempt, worker, tier: null, status, startedAt: at(minutes), finishedAt,
      parentRunId: attempt > 1 ? fixtureId(100 + task * 10 + attempt - 1) : null, failureKind: failed ? 'verification_failed' : null,
      error: failed ? 'Deterministic verification failed.' : null,
      workspace: { taskId: row.id, repositoryPath: row.repository!.path, path: `/development/fixtures/worktrees/${row.id}`, branch: `jonas-os/task-${row.id}`, baseBranch: 'main', baseCommit: 'b819f3a8f2c061154a134455e9c0fa00920d7901' },
      routing: { requestedCapability: attempt === 1 ? 'local-coding' : 'strong-coding', selectedWorker: worker as 'opencode', model: worker === 'opencode' ? 'ollama/qwen3.5:9b-q4_K_M' : null,
        fallbackReason: null, reason: attempt === 1 ? 'Eligible local coding recommendation.' : 'Chief requested strong-coding repair.' },
      result: finishedAt ? { workerResult: { success: !failed, message: failed ? 'Implemented the conversion; one regression remains in historical rate lookup.' : 'Summary\nUpdated settlement currency conversion.\n\nWhat changed\n- Used settlement currency for dividend totals.\n- Added regression coverage and currency documentation.\n\nFiles changed\n3 files.\n\nNotes / limitations\nThe public API remains compatible.' },
        verification: { checks: ['test', 'typecheck', 'lint', 'build'].map(check) },
        git: { changedFiles: ['src/portfolio/dividends.ts', 'src/portfolio/dividends.test.ts', 'docs/currency.md'],
          statusShort: ' M src/portfolio/dividends.ts\n M src/portfolio/dividends.test.ts\n M docs/currency.md',
          diffStat: ' src/portfolio/dividends.ts      | 18 ++++++++++---\n src/portfolio/dividends.test.ts | 32 +++++++++++++++++++++\n docs/currency.md               |  4 +++\n 3 files changed, 48 insertions(+), 6 deletions(-)', truncated: false } } : null,
    });
  }
  run(1, 1, 'opencode', 'running', 4);
  run(3, 1, 'opencode', 'failed', 85, true); run(3, 2, 'codex', 'completed', 78);
  run(4, 1, 'codex', 'completed', 34); run(5, 1, 'antigravity', 'failed', 22, true);
  run(6, 1, 'opencode', 'failed', 17, true); run(6, 2, 'codex', 'running', 5);
  const reviewRows: Array<typeof reviews.$inferSelect> = [{
    id: fixtureId(401), taskId: fixtureTaskId, runId: fixtureId(132), reviewer: 'antigravity', providerFamily: 'google', model: 'fixture-review-model',
    status: 'completed', result: { decision: 'approve', severity: 'low', summary: 'Settlement currency conversion is correct and the regression case covers historical rates. No changes requested.', findings: [] },
    error: null, createdAt: at(74), finishedAt: at(72),
  }, {
    id: fixtureId(402), taskId: fixtureId(4), runId: fixtureId(141), reviewer: 'antigravity', providerFamily: 'google', model: null,
    status: 'completed', result: { decision: 'needs_human', severity: 'high', summary: 'The account recovery policy needs a product decision before implementation can continue.',
      humanQuestion: 'Should account recovery require a verified second factor?', findings: [{ file: 'src/auth/recovery.ts', line: 48, category: 'security', description: 'The recovery branch can bypass the second factor.',
        reason: 'Recovery should preserve the same identity assurance as the primary sign-in flow.', suggestedFix: 'Choose a recovery policy and cover both accepted and rejected recovery attempts.' }] },
    error: null, createdAt: at(30), finishedAt: at(28),
  }];
  const escalationRows: Array<typeof escalations.$inferSelect> = [{ id: fixtureDecisionId, taskId: fixtureId(4), runId: fixtureId(141), status: 'open',
    reasonType: 'security', question: 'Should account recovery require a verified second factor?',
    summary: 'The independent reviewer found a policy ambiguity. Your answer will guide the Chief before another bounded attempt.', context: {}, answer: null, createdAt: at(27), resolvedAt: null }];
  const eventRows: Array<typeof orchestrationEvents.$inferSelect> = [
    { id: fixtureId(601), taskId: fixtureTaskId, runId: fixtureId(131), kind: 'repair_decided', data: { decision: { summary: 'Correct historical rate lookup and preserve settlement currency.', capability: 'strong-coding' }, model: 'fixture-qwen' }, createdAt: at(81) },
    { id: fixtureId(602), taskId: fixtureTaskId, runId: fixtureId(131), kind: 'repair_authorized', data: { enforcedCapability: 'strong-coding' }, createdAt: at(80) },
    { id: fixtureId(603), taskId: fixtureTaskId, runId: fixtureId(132), kind: 'review_finished', data: { reviewer: 'antigravity', decision: 'approve' }, createdAt: at(72) },
    { id: fixtureId(604), taskId: fixtureTaskId, runId: fixtureId(132), kind: 'completed', data: {}, createdAt: at(71) },
    { id: fixtureId(605), taskId: fixtureId(4), runId: fixtureId(141), kind: 'escalation_opened', data: { reasonType: 'security' }, createdAt: at(27) },
    { id: fixtureId(606), taskId: fixtureId(6), runId: fixtureId(161), kind: 'repair_authorized', data: { enforcedCapability: 'strong-coding' }, createdAt: at(7) },
    { id: fixtureId(607), taskId: fixtureId(1), runId: fixtureId(111), kind: 'worker_started', data: { attempt: 1, worker: 'opencode' }, createdAt: at(4) },
  ];
  const summary = (t: typeof tasks.$inferSelect) => ({ ...t, repositoryPath: t.repository?.path ?? null, capability: t.chief?.capability ?? null });
  const item = (t: typeof tasks.$inferSelect) => mapTask(summary(t), runRows.filter(r => r.taskId === t.id).sort((a, b) => b.attempt - a.attempt)[0]);
  const decisions = () => escalationRows.map(e => mapEscalation(e, summary(taskRows.find(t => t.id === e.taskId)!)));
  const activity = () => eventRows.map(e => mapActivity(e, taskRows.find(t => t.id === e.taskId)!.title)).sort((a, b) => b.at.localeCompare(a.at));
  const projects = (): ProjectDto[] => [...new Set([...registry.keys(), ...taskRows.flatMap(t => t.repository ? [t.repository.path] : [])])].map(path => {
    const ts = taskRows.filter(t => t.repository?.path === path), latest = ts.slice().sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0]!;
    return { ...repositoryIdentity(path), registered: registry.has(path), available: registry.has(path), unavailableReason: null, running: ts.filter(t => ['running', 'repairing', 'reviewing'].includes(t.status)).length,
      queued: ts.filter(t => t.status === 'queued').length, waiting: ts.filter(t => t.status === 'waiting_human').length,
      failed: ts.filter(t => t.status === 'failed').length, completed: ts.filter(t => t.status === 'completed').length,
      total: ts.length, updatedAt: latest?.updatedAt.toISOString() ?? new Date(now).toISOString(), latestStatus: latest?.status ?? 'No tasks' };
  });
  const list = (query: TaskQuery) => {
    let items = taskRows.map(item).filter(t => (!query.status || (query.status === 'active' ? ['running', 'repairing', 'reviewing'].includes(t.status) : query.status === 'attention' ? ['failed', 'pending'].includes(t.status) : t.status === query.status)) && (!query.category || t.category === query.category)
      && (!query.project || t.projectKey === query.project) && (!query.worker || runRows.some(r => r.taskId === t.id && r.worker === query.worker))
      && (!query.q || `${t.id} ${t.title} ${taskRows.find(row => row.id === t.id)!.objective}`.toLowerCase().includes(query.q.toLowerCase())));
    items = items.sort((a, b) => query.sort === 'status' ? a.status.localeCompare(b.status) || b.updatedAt.localeCompare(a.updatedAt) : (query.sort === 'newest' ? b.createdAt.localeCompare(a.createdAt) : b.updatedAt.localeCompare(a.updatedAt)));
    return taskListSchema.parse({ items: items.slice((query.page - 1) * 30, query.page * 30), total: items.length, page: query.page, pageSize: 30 });
  };
  const services: MutationServices = {
    repository: async key => { const p = projects().find(p => p.key === key && p.registered && p.available); return p ? { name: p.name, repositoryPath: p.path, baseBranch: 'main' } : null; },
    plan: async input => /clarif/i.test(input.userGoal) ? { action: 'ask_human', summary: 'Development fixture', reason: 'More context is needed.', humanQuestion: 'Which behavior should remain compatible?' }
      : /no action/i.test(input.userGoal) ? { action: 'no_action', summary: 'Development fixture', reason: 'No change is needed for this fixture goal.' }
      : { action: 'create_task', summary: 'Development fixture · queued without execution.', reason: 'Explicit fixture goal.', capability: 'local-coding', workerBrief: 'Development fixture; never execute.',
        task: { title: input.userGoal.slice(0, 300), objective: input.userGoal, category: 'coding', difficulty: 1, risk: 'low', context: ['Development fixture'], acceptanceCriteria: ['Fixture created without inference.'], maxAttempts: 2,
          ...(input.project?.repositoryPath ? { repository: { path: input.project.repositoryPath, baseBranch: input.project.baseBranch } } : {}) } },
    submit: async decision => submitDecision(decision, { createTask: async (spec, _queue, chief) => {
      const row = { ...taskRows[0]!, ...spec, id: randomUUID(), status: 'queued', createdAt: new Date(), updatedAt: new Date(), repository: spec.repository ?? null, chief: chief ?? null };
      taskRows.push(row); return row;
    } }),
    answer: async (id, answer) => {
      const e = escalationRows.find(e => e.id === id); if (!e || e.status !== 'open') throw new Error('Escalation is not open.');
      const t = taskRows.find(t => t.id === e.taskId)!; if (t.status !== 'waiting_human') throw new Error('Task is not waiting for a human.');
      e.answer = answer; e.status = 'resolved'; e.resolvedAt = new Date(); t.status = 'queued'; t.updatedAt = new Date();
      eventRows.push({ id: randomUUID(), taskId: t.id, runId: e.runId, kind: 'human_answered', data: {}, createdAt: new Date() });
      return { taskId: t.id, taskStatus: 'queued', status: 'resolved' };
    },
    abandon: async id => {
      const t = taskRows.find(t => t.id === id); if (!t || t.status !== 'waiting_human') throw new Error('Only a waiting_human task can be abandoned.');
      t.status = 'failed'; t.updatedAt = new Date();
      for (const e of escalationRows.filter(e => e.taskId === id && e.status === 'open')) { e.status = 'cancelled'; e.resolvedAt = new Date(); }
      eventRows.push({ id: randomUUID(), taskId: id, runId: null, kind: 'human_abandoned', data: {}, createdAt: new Date() });
    },
  };
  return { services, projects, list, decisions, activity,
    registerRepository: async (value: unknown) => {
      const input = registerRepositoryInputSchema.parse(value), path = await validateRepositoryPath(input.path);
      if (registry.has(path)) throw new RequestError(409, 'Repository is already registered.');
      const id = randomUUID(); registry.set(path, id);
      return registeredRepositorySchema.parse({ id, ...repositoryIdentity(path) });
    },
    overview: () => overviewSchema.parse({ counts: overviewCounts([...new Set(taskRows.map(t => t.status))].map(status => ({ status, count: taskRows.filter(t => t.status === status).length }))),
      active: taskRows.filter(t => ['running', 'repairing', 'reviewing'].includes(t.status)).map(item), queued: taskRows.filter(t => t.status === 'queued').map(item),
      failures: taskRows.filter(t => t.status === 'failed').map(item), decisions: decisions().filter(e => e.status === 'open'), activity: activity() }),
    detail: (id: string) => {
      const t = taskRows.find(t => t.id === id); if (!t) return null;
      const rs = runRows.filter(r => r.taskId === id).map(mapRun), revs = reviewRows.filter(r => r.taskId === id).map(mapReview), es = decisions().filter(e => e.taskId === id);
      return taskDetailSchema.parse({ task: { ...item(t), objective: t.objective, acceptanceCriteria: t.acceptanceCriteria, context: t.context,
        repository: t.repository?.path ?? null, risk: t.risk, difficulty: t.difficulty, maxAttempts: t.maxAttempts, textTruncated: false },
        runs: rs, reviews: revs, decisions: es, timeline: buildTimeline(item(t), rs, revs, es, activity().filter(e => e.taskId === id)), historyTruncated: false });
    },
    providers: (): { dbAvailable: boolean; providers: ProviderStatusDto[] } => ({ dbAvailable: true, providers: [
      ['chief', 'Local Chief', 'Ollama', 'qwen3.5:9b-q4_K_M', 'available'],
      ['opencode', 'Local coding', 'OpenCode · Ollama', 'qwen3.5:9b-q4_K_M', 'available'],
      ['codex', 'Strong coding', 'Codex', null, 'unknown'], ['antigravity', 'General / research', 'Antigravity', null, 'unknown'],
    ].map(([id, name, provider, model, status]) => ({ id: id!, name: name!, provider: provider!, model: model ?? null, status: status as 'available',
      reason: status === 'available' ? 'Development fixture · readiness is simulated.' : 'Development fixture · CLI authentication is unknown.', checkedAt: new Date().toISOString(),
      recentRuns: runRows.filter(r => r.worker === id).length, successes: runRows.filter(r => r.worker === id && r.status === 'completed').length,
      failures: runRows.filter(r => r.worker === id && r.status === 'failed').length, lastSuccess: null, lastFailure: null, statsNote: 'Development fixture · no real provider calls.' })) }),
  };
}
const globals = globalThis as typeof globalThis & { jonasControlPlaneFixtures?: ReturnType<typeof createFixtureStore> };
export function fixtures() {
  if (!fixtureMode()) throw new Error('Fixtures require explicit development mode.');
  return globals.jonasControlPlaneFixtures ??= createFixtureStore();
}
