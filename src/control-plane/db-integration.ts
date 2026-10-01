import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { registerRepository, repositoryAvailability, registeredRepositories } from './repositories.js';
import { taskOutcome } from './outcome.js';
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { db, pool } from '../db/index.js';
import { tasks, runs, reviews, escalations, orchestrationEvents, repositories } from '../db/schema.js';
import { getOverview, getTasks, getTaskDetail, getRepositorySummaries, getOpenEscalations, getRecentActivity, getRepositoryContext, parseTaskQuery } from './queries.js';
import { repositoryIdentity } from './mapping.js';

// Only inserts its own test records. No queue consumer, real planner or AI adapters.
const ids = [randomUUID(), randomUUID()], marker = `control-plane.test.${randomUUID()}`;
const directory = await mkdtemp(join(tmpdir(), 'control-plane-db-')), path = await realpath(directory);
let registryId: string | undefined;
const configured = process.env.JONAS_OS_REPOSITORIES;
try {
  await execa('git', ['init', '-b', 'main', path]);
  process.env.JONAS_OS_REPOSITORIES = JSON.stringify([path]);
  const entries = await registeredRepositories(), registered = entries.find(row => row.path === path)!;
  registryId = registered.id;
  if (configured === undefined) delete process.env.JONAS_OS_REPOSITORIES; else process.env.JONAS_OS_REPOSITORIES = configured;
  const registeredKey = repositoryIdentity(registered.path).key;
  const empty = (await getRepositorySummaries()).find(p => p.key === registeredKey);
  assert.equal(empty?.total, 0); assert.equal(empty?.available, true); assert.equal(empty?.registered, true);
  assert.equal((await getRepositoryContext(registeredKey))?.repositoryPath, path);
  await assert.rejects(registerRepository({ path: `${path}/` }), /already registered/);
  const created = await db.insert(tasks).values(ids.map((id, i) => ({ id, title: `${marker} ${i === 0 ? 'repair' : 'decision'}`, objective: 'Verify the control-plane SQL read model without provider execution.',
    category: 'coding', difficulty: 2, risk: 'low', context: ['Explicit test data.'], acceptanceCriteria: ['Read model works.'], maxAttempts: 2,
    repository: { path: i === 0 ? `${path}/` : path, baseBranch: 'main' }, chief: { capability: 'local-coding' as const, workerBrief: 'Never execute this test record.' },
    queueName: marker, status: i === 0 ? 'reviewing' : 'waiting_human' }))).returning();
  assert.equal(created.length, 2);
  const [run] = await db.insert(runs).values({ taskId: ids[0]!, attempt: 2, worker: 'codex', status: 'completed', finishedAt: new Date(),
    routing: { requestedCapability: 'strong-coding', selectedWorker: 'codex', fallbackReason: null, model: null, reason: 'Test route.' },
    result: { workerResult: { message: `API_KEY=test-secret ${'x'.repeat(12000)}` }, verification: { checks: [{ name: 'test', success: true, skipped: false, timedOut: false, durationMs: 10, stdout: 'x'.repeat(16000), stderr: '', exitCode: 0 }, { name: 'lint', success: true, skipped: true, timedOut: false, durationMs: 0, stderr: 'Script not defined.' }] },
      git: { statusShort: ' M src/test.ts', changedFiles: Array.from({ length: 150 }, (_, i) => `src/test-${i}.ts`), diffStat: '150 files changed', truncated: false } } }).returning();
  assert.ok(run);
  await db.insert(reviews).values({ taskId: ids[0]!, runId: run.id, reviewer: 'antigravity', providerFamily: 'google', status: 'completed',
    result: { decision: 'approve', severity: 'none', summary: 'Explicit DB fixture.', findings: [] }, finishedAt: new Date() });
  await db.insert(escalations).values({ taskId: ids[1]!, reasonType: 'clarification', question: 'Test question', summary: 'Explicit test escalation.', context: {} });
  await db.insert(orchestrationEvents).values({ taskId: ids[0]!, runId: run.id, kind: 'repair_authorized', data: { enforcedCapability: 'strong-coding' } });
  const projectKey = repositoryIdentity(path).key;
  const list = await getTasks(parseTaskQuery({ q: marker, project: projectKey }));
  assert.equal(list.total, 2); assert.equal(list.items.length, 2);
  assert.equal((await getTasks(parseTaskQuery({ q: marker, worker: 'codex' }))).total, 1);
  assert.equal((await getTasks(parseTaskQuery({ q: marker, status: 'waiting_human' }))).total, 1);
  const detail = await getTaskDetail(ids[0]!); assert.ok(detail);
  assert.equal(detail.runs[0]?.checks[1]?.status, 'skipped');
  assert.equal(detail.runs[0]?.git?.changedFileCount, 150);
  assert.equal(detail.runs[0]?.git?.changedFiles.length, 100); assert.equal(detail.runs[0]?.git?.truncated, true);
  assert.equal(detail.runs[0]?.checks[0]?.outputTruncated, true); assert.equal(detail.runs[0]?.messageTruncated, true);
  assert.ok(!detail.runs[0]?.message.includes('test-secret')); assert.ok(detail.runs[0]!.message.length <= 8000);
  assert.equal(detail.reviews[0]?.decision, 'approve'); assert.equal(taskOutcome(detail).run?.id, run.id); assert.ok(detail.timeline.some(e => e.kind === 'repair_authorized'));
  const project = (await getRepositorySummaries()).find(p => p.key === projectKey); assert.equal(project?.total, 2); assert.equal(project?.waiting, 1);
  assert.equal((await getRepositoryContext(projectKey))?.baseBranch, 'main');
  assert.equal((await getOpenEscalations({ project: projectKey })).items[0]?.taskId, ids[1]);
  assert.equal((await getRecentActivity(1, projectKey)).items[0]?.kind, 'repair_authorized');
  assert.ok((await getOverview()).active.some(t => t.id === ids[0]));
  assert.equal(await getTaskDetail(randomUUID()), null);
  const historyIds = Array.from({ length: 3000 }, () => randomUUID());
  ids.push(...historyIds);
  await db.insert(tasks).values(historyIds.map(id => ({ id, title: `Historical ${marker}`, objective: 'Explicit performance fixture; never execute.',
    category: 'utility', difficulty: 1, risk: 'low', context: [], acceptanceCriteria: [], maxAttempts: 1, queueName: marker, status: 'completed' })));
  const historyRuns = await db.insert(runs).values(historyIds.map(taskId => ({ taskId, worker: 'codex', status: 'completed', finishedAt: new Date() }))).returning({ id: runs.id, taskId: runs.taskId });
  await db.insert(orchestrationEvents).values(historyRuns.map(r => ({ taskId: r.taskId, runId: r.id, kind: 'attempt_finished', data: { attempt: 1, worker: 'codex', verified: true } })));
  const started = performance.now();
  const [boundedOverview, boundedActivity, boundedList] = await Promise.all([getOverview(), getRecentActivity(), getTasks(parseTaskQuery({ q: marker }))]);
  assert.ok(boundedOverview.active.length <= 20); assert.ok(boundedActivity.items.length <= 50); assert.equal(boundedList.items.length, 30); assert.equal(boundedList.total, 3002);
  const elapsed = Math.round(performance.now() - started);
  assert.ok(elapsed < 10000, '3000 historical runs should not stall the local read model.');
  await rm(join(path, '.git'), { recursive: true });
  assert.equal((await repositoryAvailability(path)).available, false);
  assert.equal(await getRepositoryContext(projectKey), null);
  const unavailable = (await getRepositorySummaries()).find(p => p.key === projectKey);
  assert.equal(unavailable?.registered, true); assert.equal(unavailable?.available, false);
  assert.equal(await getRepositoryContext(repositoryIdentity('/unregistered/arbitrary').key), null);
  console.log(`Control Plane SQL read model: OK; 3000 historical tasks/runs, bounded overview/activity/list in ${elapsed}ms. Owned fixture cleanup follows.`);
} finally {
  await db.delete(tasks).where(inArray(tasks.id, ids));
  const remaining = await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.queueName, marker)); assert.equal(remaining.length, 0);
  if (configured === undefined) delete process.env.JONAS_OS_REPOSITORIES; else process.env.JONAS_OS_REPOSITORIES = configured;
  if (registryId) await db.delete(repositories).where(eq(repositories.id, registryId));
  await rm(directory, { recursive: true, force: true });
  await pool.end();
}
