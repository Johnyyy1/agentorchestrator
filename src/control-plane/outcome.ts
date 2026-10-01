import { normalizeTaskSemantics } from '../tasks/semantics.js';
import { capabilitySchema } from '../chief/capabilities.js';
import { assertIndependent, providerFamily } from '../review/policy.js';
import type { TaskSpec, WorkerId } from '../workers/types.js';
import type { TaskDetailDto } from './contracts.js';

// Uses only the sanitized, persisted read model. No model call or completion policy.
export function taskOutcome(detail: TaskDetailDto) {
  const { task } = detail;
  const runs = [...detail.runs].sort((a, b) => a.attempt - b.attempt || a.startedAt.localeCompare(b.startedAt));
  const capability = capabilitySchema.safeParse(task.capability);
  let repositoryCoding = false;
  try {
    repositoryCoding = normalizeTaskSemantics({ title: task.title, objective: task.objective,
      category: task.category as TaskSpec['category'], difficulty: task.difficulty as TaskSpec['difficulty'],
      risk: task.risk as TaskSpec['risk'], context: task.context, acceptanceCriteria: task.acceptanceCriteria,
      maxAttempts: task.maxAttempts, ...(task.repository ? { repository: { path: task.repository } } : {}) },
      capability.success ? capability.data : undefined).category === 'coding';
  } catch { repositoryCoding = task.category === 'coding' || task.capability === 'local-coding' || task.capability === 'strong-coding'; }
  const codingRuns = repositoryCoding ? runs.filter(r => r.worker === 'codex' || r.worker === 'opencode') : runs;
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
  let incomplete = false;
  if (task.status === 'completed' && repositoryCoding) {
    incomplete = !run || run.id !== runs.at(-1)?.id || run.status !== 'completed' || run.workerSucceeded !== true ||
      !run.message.trim() || !run.workspace || !run.git || !run.checks.length ||
      run.checks.some(c => c.status === 'fail' || c.status === 'timeout') ||
      !review || review.status !== 'completed' || review.decision !== 'approve';
    if (run && review) {
      try { assertIndependent(run.worker as WorkerId, review.reviewer as WorkerId); }
      catch { incomplete = true; }
      if (review.provider !== providerFamily[review.reviewer as WorkerId]) incomplete = true;
    }
  }
  const reason = incomplete ? 'Execution incomplete: repository mutation was not verified. Historical completion lacks final coding, workspace, verification or independent approval evidence.' : task.status === 'waiting_human'
    ? decision?.summary || decision?.reasonType || 'Execution is waiting for human input. No question was captured.'
    : task.status === 'failed'
      ? terminalEvent?.detail || terminalEvent?.title || run?.error || review?.error || (review?.decision && review.decision !== 'approve' ? review.summary : null)
        || (failedChecks.length ? `Verification failed: ${failedChecks.map(c => c.name).join(', ')}.` : null)
        || closedDecision?.summary || 'Task failed. No failure reason was captured.'
      : null;
  return { run, reportRun, review, decision, reason, summary: reportRun?.message.trim() || null };
}
