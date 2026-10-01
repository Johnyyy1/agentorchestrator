import type { TaskDetailDto } from './contracts.js';

// Uses only the sanitized, persisted read model. No model call or completion policy.
export function taskOutcome(detail: TaskDetailDto) {
  const { task } = detail;
  const runs = [...detail.runs].sort((a, b) => a.attempt - b.attempt || a.startedAt.localeCompare(b.startedAt));
  const codingRuns = task.category === 'coding' ? runs.filter(r => r.worker === 'codex' || r.worker === 'opencode') : runs;
  const run = task.status === 'completed'
    ? codingRuns.filter(r => r.workerSucceeded === true || (r.workerSucceeded === null && r.status === 'completed')).at(-1) ?? null
    : runs.at(-1) ?? null;
  const review = run ? [...detail.reviews].filter(r => r.runId === run.id)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1) ?? null : null;
  const decision = [...detail.decisions].filter(d => d.status === 'open')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1) ?? null;
  const closedDecision = [...detail.decisions].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
  const terminalEvent = [...detail.timeline].filter(e => e.kind === 'human_abandoned' || e.kind === 'invalid_state')
    .sort((a, b) => a.at.localeCompare(b.at)).at(-1);
  const reportRun = task.status === 'completed' ? run : runs.filter(r => r.message.trim()).at(-1) ?? run;
  const failedChecks = run?.checks.filter(c => c.status === 'fail' || c.status === 'timeout') ?? [];
  const reason = task.status === 'waiting_human'
    ? decision?.summary || decision?.reasonType || 'Execution is waiting for human input. No question was captured.'
    : task.status === 'failed'
      ? terminalEvent?.detail || terminalEvent?.title || run?.error || review?.error || (review?.decision && review.decision !== 'approve' ? review.summary : null)
        || (failedChecks.length ? `Verification failed: ${failedChecks.map(c => c.name).join(', ')}.` : null)
        || closedDecision?.summary || 'Task failed. No failure reason was captured.'
      : null;
  return { run, reportRun, review, decision, reason, summary: reportRun?.message.trim() || null };
}
