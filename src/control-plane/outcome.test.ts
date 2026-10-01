import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFixtureStore, fixtureTaskId } from './fixtures.js';
import { taskOutcome } from './outcome.js';
import { finalReportInstructions } from '../workers/final-report.js';
import { buildLocalCodingPrompt } from '../workers/local-coding-prompt.js';

test('completed outcome uses latest successful coding worker, matching review and deterministic metadata', () => {
  const detail = createFixtureStore().detail(fixtureTaskId)!;
  const result = taskOutcome(detail);
  assert.equal(result.run?.worker, 'codex'); assert.ok(result.summary?.includes('settlement currency'));
  assert.equal(result.run?.git?.changedFileCount, 3);
  assert.equal(result.run?.checks.find(c => c.name === 'lint')?.status, 'skipped');
  assert.equal(result.review?.decision, 'approve'); assert.equal(result.reason, null);
  const newerFailed = { ...detail.runs[1]!, id: 'failed-newer', attempt: 3, status: 'failed', workerSucceeded: false, message: 'Failed attempt' };
  detail.runs.push(newerFailed); detail.runs.reverse();
  assert.equal(taskOutcome(detail).run?.attempt, 2); assert.match(taskOutcome(detail).reason!, /Execution incomplete/); // Independent of transport order.
  detail.runs.find(r => r.attempt === 2)!.message = '';
  assert.equal(taskOutcome(detail).summary, null); // Do not substitute an older worker report.
  assert.equal(detail.task.status, 'completed'); // Presentation cannot affect completion.
});
test('legacy completion and missing evidence are explicit, plain text needs no Markdown parsing', () => {
  const detail = createFixtureStore().detail(fixtureTaskId)!;
  detail.runs[1]!.workerSucceeded = null; detail.runs[1]!.message = 'Delivered an ordinary sentence without headings.';
  assert.equal(taskOutcome(detail).summary, detail.runs[1]!.message);
  detail.runs = []; detail.reviews = [];
  assert.equal(taskOutcome(detail).run, null); assert.equal(taskOutcome(detail).summary, null);
  assert.match(taskOutcome(detail).reason!, /Execution incomplete/);
});
test('waiting and failed summaries show current question, partial work and failed verification/review context', () => {
  const store = createFixtureStore(), waiting = store.detail('10000000-0000-4000-8000-000000000004')!;
  assert.ok(taskOutcome(waiting).decision?.question); assert.ok(taskOutcome(waiting).summary);
  const failed = store.detail('10000000-0000-4000-8000-000000000005')!;
  assert.equal(taskOutcome(failed).reason, 'Deterministic verification failed.');
  failed.runs[0]!.error = null; assert.match(taskOutcome(failed).reason!, /Verification failed: test/);
  const detail = store.detail(fixtureTaskId)!;
  detail.task.status = 'failed'; detail.reviews[0]!.error = 'Review invocation failed';
  assert.equal(taskOutcome(detail).reason, 'Review invocation failed');
  detail.reviews[0]!.runId = 'different-attempt'; assert.equal(taskOutcome(detail).review, null);
  detail.runs[1]!.message = '';
  assert.equal(taskOutcome(detail).reportRun?.attempt, 1);
  detail.timeline.push({ id: 'abandon', kind: 'human_abandoned', title: 'Human abandoned task', detail: '', at: '2099-01-01T00:00:00.000Z', ref: null });
  assert.equal(taskOutcome(detail).reason, 'Human abandoned task');
});
test('local worker prompt requests operator-facing report without exact parsing or reasoning traces', () => {
  const prompt = buildLocalCodingPrompt({ title: 'Repair', objective: 'Fix regression', category: 'coding', risk: 'low', difficulty: 1,
    acceptanceCriteria: ['Regression fixed'], context: ['Repair attempt'], maxAttempts: 2 });
  assert.ok(prompt.includes(finalReportInstructions));
  for (const heading of ['Summary', 'What changed', 'Files changed', 'Notes / limitations']) assert.ok(prompt.includes(heading));
  assert.ok(prompt.includes('exact formatting is not required')); assert.ok(prompt.includes('Do not include hidden reasoning'));
});

test('historical utility/local-coding repository completion exposes missing evidence without fabricating data', () => {
  const detail = createFixtureStore().detail(fixtureTaskId)!;
  detail.task.category = 'utility'; detail.task.capability = 'local-coding';
  detail.runs = [{ ...detail.runs[1]!, worker: 'antigravity', workspace: null, git: null, checks: [] }];
  detail.reviews = [];
  const outcome = taskOutcome(detail);
  assert.match(outcome.reason!, /Execution incomplete: repository mutation was not verified/);
  assert.equal(outcome.run, null); assert.equal(outcome.summary, null);
  assert.equal(detail.task.status, 'completed', 'Read model warns without rewriting historical database state.');
});
