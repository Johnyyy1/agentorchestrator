import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createFixtureStore, fixtureTaskId, fixtureDecisionId, fixtureMode } from './fixtures.js';
import { parseTaskQuery } from './queries.js';
import { formatActivity, overviewCounts, repositoryIdentity, safeText } from './mapping.js';
import { delegate, answerDecision, abandonDecision } from './mutations.js';
import type { MutationServices } from './mutations.js';
import { createHealthCache, mapBinaryReadiness, mapLocalReadiness } from './providers.js';
import { createMutationGate, publicError, readJson, RequestError, validateLocalRequest } from './security.js';
import { duration } from './format.js';

test('overview read model counts real lifecycle states and exposes bounded attention views', () => {
  assert.deepEqual(overviewCounts([{ status: 'running', count: 2 }, { status: 'reviewing', count: 1 }, { status: 'repairing', count: 3 },
    { status: 'queued', count: 7 }, { status: 'waiting_human', count: 4 }, { status: 'pending', count: 1 }, { status: 'failed', count: 5 }]),
  { running: 6, queued: 7, waiting: 4, pending: 1, failed: 5 });
  const overview = createFixtureStore().overview();
  assert.equal(overview.active.length, 2); assert.equal(overview.decisions[0]?.id, fixtureDecisionId);
  assert.equal(overview.failures[0]?.status, 'failed');
});
test('timeline maps actual persisted attempts, checks, repair decision and independent review', () => {
  const detail = createFixtureStore().detail(fixtureTaskId)!;
  const timeline = detail.timeline;
  assert.equal(timeline[0]?.kind, 'created');
  assert.deepEqual(timeline.filter(e => e.kind === 'attempt').map(e => e.title), ['Attempt 1 · OpenCode', 'Attempt 2 · Codex']);
  assert.equal(timeline.filter(e => e.kind === 'verification').length, 2);
  assert.equal(timeline.find(e => e.kind === 'review')?.detail, 'approve');
  assert.equal(detail.runs[0]?.checks.find(c => c.name === 'lint')?.status, 'skipped');
  assert.equal(detail.runs[0]?.checks.find(c => c.name === 'test')?.status, 'fail');
  const queued = createFixtureStore().detail('10000000-0000-4000-8000-000000000002')!;
  assert.equal(queued.timeline.length, 1); assert.equal(queued.runs.length, 0); // Never invent a worker stage.
});
test('activity formats native event names without raw JSON', () => {
  assert.equal(formatActivity('repair_authorized', { enforcedCapability: 'strong-coding' }).title, 'Chief requested strong-coding');
  assert.equal(formatActivity('review_finished', { reviewer: 'antigravity', decision: 'approve' }).title, 'Antigravity approved the change');
  assert.equal(formatActivity('escalation_opened', { reasonType: 'security' }).title, 'Needs your decision');
  assert.equal(formatActivity('worker_started', { worker: 'opencode', attempt: 2 }).title, 'OpenCode started attempt 2');
  assert.equal(formatActivity('verification_decided', { verified: false }).title, 'Verification requires attention · Chief next');
  assert.equal(formatActivity('new_event', { apiKey: 'do-not-expose', raw: 'huge logs' }).detail, '');
});
test('query parser validates filters and pagination, repository keys normalize paths', () => {
  assert.deepEqual(parseTaskQuery({}), { page: 1, q: '', sort: 'updated' });
  assert.equal(parseTaskQuery({ status: '', page: '2', worker: 'opencode' }).page, 2);
  assert.equal(createFixtureStore().list(parseTaskQuery({ status: 'active' })).total, 2);
  for (const input of [{ status: 'deleted' }, { worker: 'shell' }, { page: '-1' }, { q: 'x'.repeat(201) }, { project: '/arbitrary/path' }, { page: ['1', '2'] }]) assert.throws(() => parseTaskQuery(input));
  assert.equal(repositoryIdentity('/repos//app/').key, repositoryIdentity('/repos/app').key);
  assert.equal(repositoryIdentity('/repos/other/../app').key, repositoryIdentity('/repos/app').key);
  const store = createFixtureStore();
  assert.equal(store.list(parseTaskQuery({ q: 'dividend' })).items.length, 1);
  assert.equal(store.list(parseTaskQuery({ worker: 'opencode', status: 'completed' })).items[0]?.id, fixtureTaskId); // Any recorded attempt, not just latest worker.
});
test('answer delegates to existing service, updates only on success, and keeps open state on failure', async () => {
  const store = createFixtureStore();
  let calls = 0;
  const services: MutationServices = { ...store.services, answer: async () => { calls++; throw new Error('enqueue failed'); } };
  await assert.rejects(answerDecision(fixtureDecisionId, { answer: 'Resume safely' }, services), /enqueue failed/);
  assert.equal(store.decisions()[0]?.status, 'open'); assert.equal(calls, 1);
  await assert.rejects(answerDecision(fixtureDecisionId, { answer: ' ' }, services)); assert.equal(calls, 1);
  const result = await answerDecision(fixtureDecisionId, { answer: ' Require second factor. ' }, store.services);
  assert.equal(result.taskStatus, 'queued'); assert.equal(store.decisions()[0]?.answer, 'Require second factor.');
  await assert.rejects(answerDecision(fixtureDecisionId, { answer: 'Duplicate' }, store.services));
});
test('abandon requires explicit confirmation and validated service semantics', async () => {
  const store = createFixtureStore(), taskId = store.decisions()[0]!.taskId;
  await assert.rejects(abandonDecision({ taskId, confirmed: false }, store.services));
  assert.equal(store.decisions()[0]?.status, 'open');
  await abandonDecision({ taskId, confirmed: true }, store.services);
  assert.equal(store.decisions()[0]?.status, 'cancelled'); assert.equal(store.detail(taskId)?.task.status, 'failed');
  assert.equal(store.detail(taskId)?.runs.length, 1);
  await assert.rejects(abandonDecision({ taskId: fixtureTaskId, confirmed: true }, store.services));
});
test('delegate uses fake Chief and real submitDecision bridge for every action, validates grounding', async () => {
  const store = createFixtureStore(), projectKey = store.projects()[0]!.key;
  const created = await delegate({ goal: 'Export portfolio', projectKey }, store.services);
  assert.equal(created.action, 'create_task');
  if (created.action === 'create_task') { assert.equal(store.detail(created.taskId)?.task.status, 'queued'); assert.equal(store.detail(created.taskId)?.task.projectKey, projectKey); }
  const count = store.list(parseTaskQuery({})).total;
  assert.equal((await delegate({ goal: 'Clarify this' }, store.services)).action, 'ask_human');
  assert.equal((await delegate({ goal: 'No action' }, store.services)).action, 'no_action');
  assert.equal(store.list(parseTaskQuery({})).total, count);
  await assert.rejects(delegate({ goal: 'Export', repositoryPath: '/arbitrary' }, store.services));
  await assert.rejects(delegate({ goal: 'Export', projectKey: 'f'.repeat(24) }, store.services));
  const evil: MutationServices = { ...store.services, plan: async input => {
    const result = await store.services.plan(input);
    if (result.action === 'create_task') result.task.repository = { path: '/unauthorized/path' };
    return result;
  } };
  await assert.rejects(delegate({ goal: 'Export', projectKey }, evil), /repository context/);
});
test('provider health does not equate binary presence with authentication; cache coalesces and expires', async () => {
  assert.equal(mapBinaryReadiness('/bin/codex').status, 'unknown'); assert.equal(mapBinaryReadiness(null).status, 'unavailable');
  assert.equal(mapLocalReadiness(true).status, 'available');
  let calls = 0, now = 0;
  const check = createHealthCache(async () => { calls++; return []; }, 20000, () => now);
  await Promise.all([check(), check(), check()]); assert.equal(calls, 1);
  now = 19000; await check(); assert.equal(calls, 1);
  now = 20001; await check(); assert.equal(calls, 2);
});
test('local host, origin, bounded JSON and safe error boundary', async () => {
  const request = (host: string, origin?: string) => new Request('http://127.0.0.1:3000/api', { headers: { host, ...(origin ? { origin } : {}) } });
  validateLocalRequest(request('127.0.0.1:3000', 'http://127.0.0.1:3000'), true);
  for (const r of [request('evil.local:3000'), request('127.0.0.1:3000', 'https://evil.local'), request('localhost.evil.local'), request('127.0.0.1:3000')]) assert.throws(() => validateLocalRequest(r, true));
  await assert.rejects(readJson(new Request('http://localhost', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(32001) })), (error: unknown) => error instanceof RequestError && error.status === 413);
  assert.deepEqual(await readJson(new Request('http://localhost', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"goal":"test"}' })), { goal: 'test' });
  assert.ok(!JSON.stringify(publicError(new Error('password=my-secret stack /auth.json'), 'answer')).includes('my-secret'));
});
test('mutation gate coalesces in-flight retries, preserves failed results and rejects changed bodies', async () => {
  const gate = createMutationGate(), id = randomUUID();
  let count = 0;
  const work = async () => { count++; return { status: 'queued' }; };
  assert.deepEqual(await Promise.all([gate(id, 'same', 'delegate', work), gate(id, 'same', 'delegate', work)]), [{ status: 'queued' }, { status: 'queued' }]);
  assert.equal(count, 1);
  await assert.rejects(gate(id, 'different', 'delegate', work));
  const failId = randomUUID(), fail = async () => { count++; throw new Error('already persisted'); };
  await assert.rejects(gate(failId, 'same', 'delegate', fail));
  await assert.rejects(gate(failId, 'same', 'delegate', fail)); assert.equal(count, 2);
});
test('sensitive persisted text is redacted and durations are consistent', () => {
  const text = safeText('API_KEY=top-secret sk-short github_pat_1234567890abcdef postgresql://u:p@localhost/db Bearer abcdef token=private');
  for (const secret of ['top-secret', 'sk-short', 'github_pat_1234567890abcdef', 'u:p@', 'abcdef', 'private']) assert.ok(!text.includes(secret));
  assert.equal(safeText('x'.repeat(10000), 300).length, 300);
  assert.equal(duration(4000), '4s'); assert.equal(duration(138000), '2m 18s'); assert.equal(duration(3840000), '1h 04m');
});
test('fixtures are rejected in local production mode', () => {
  const mode = process.env.NODE_ENV, flag = process.env.CONTROL_PLANE_FIXTURES;
  try { process.env.NODE_ENV = 'production'; process.env.CONTROL_PLANE_FIXTURES = '1'; assert.throws(fixtureMode, /disabled in production/); }
  finally { if (mode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = mode; if (flag === undefined) delete process.env.CONTROL_PLANE_FIXTURES; else process.env.CONTROL_PLANE_FIXTURES = flag; }
});
