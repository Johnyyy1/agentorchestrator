import { createHash } from 'node:crypto';
import { basename, normalize } from 'node:path';
import { redact } from '../orchestration/context.js';
import type { tasks, runs, reviews, escalations, orchestrationEvents } from '../db/schema.js';
import type { ActivityEventDto, EscalationDto, RunDto, ReviewDto, TaskListItemDto, TimelineEventDto } from './contracts.js';

export function safeText(value: unknown, max = 2000): string {
  if (typeof value !== 'string') return '';
  let redacted = value;
  for (const [key, secret] of Object.entries(process.env)) {
    if (/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|DATABASE_URL)$/i.test(key) && secret && secret.length >= 8) redacted = redacted.replaceAll(secret, '[REDACTED]');
  }
  return redact(redacted)
    .replace(/\b(?:sk-[\w-]+|gh[pousr]_[\w]+|github_pat_[\w]+|AIza[\w-]{20,})\b/g, '[REDACTED]')
    .replace(/\b[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)\s*[=:]\s*[^\s,;]+/g, '[REDACTED]')
    .replace(/\b(?:postgres(?:ql)?|redis|mongodb):\/\/[^\s/@]+:[^\s/@]+@/gi, '[REDACTED CONNECTION]@')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, max);
}
export const record = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const list = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
const optionalText = (v: unknown, max = 2000) => typeof v === 'string' ? safeText(v, max) : null;
const number = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : 0;
export const iso = (value: Date | string) => new Date(value).toISOString();
export function repositoryIdentity(path: string) {
  const normalized = normalize(path).replace(/\/$/, '') || '/';
  return { key: createHash('sha256').update(normalized).digest('hex').slice(0, 24), name: safeText(basename(normalized) || normalized, 200), path: normalized };
}
export type TaskSummaryRow = Pick<typeof tasks.$inferSelect, 'id' | 'title' | 'status' | 'category' | 'createdAt' | 'updatedAt'> & {
  repositoryPath: string | null; capability: string | null;
};
export type LatestRunRow = Pick<typeof runs.$inferSelect, 'taskId' | 'attempt' | 'worker' | 'startedAt'>;
export function mapTask(row: TaskSummaryRow, latest?: LatestRunRow): TaskListItemDto {
  const project = row.repositoryPath ? repositoryIdentity(row.repositoryPath) : null;
  return { id: row.id, title: safeText(row.title, 300), status: safeText(row.status, 50), category: safeText(row.category, 50),
    projectKey: project?.key ?? null, projectName: project?.name ?? null, capability: optionalText(row.capability, 100),
    worker: latest?.worker ?? null, attempt: latest?.attempt ?? 0, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt),
    startedAt: latest ? iso(latest.startedAt) : null };
}
export function mapEscalation(row: typeof escalations.$inferSelect, task: TaskSummaryRow): EscalationDto {
  return { id: row.id, taskId: row.taskId, runId: row.runId, taskTitle: safeText(task.title, 300), taskStatus: task.status,
    projectName: task.repositoryPath ? repositoryIdentity(task.repositoryPath).name : null,
    status: row.status, reasonType: row.reasonType, question: safeText(row.question, 2000), summary: safeText(row.summary, 2000),
    answer: optionalText(row.answer, 6000), createdAt: iso(row.createdAt), resolvedAt: row.resolvedAt ? iso(row.resolvedAt) : null };
}
export function mapRun(row: typeof runs.$inferSelect): RunDto {
  const result = record(row.result), worker = record(result.workerResult), git = record(result.git), verification = record(result.verification);
  const route = row.routing ?? record(result.routing), workspace = row.workspace;
  return { id: row.id, attempt: row.attempt, worker: row.worker, tier: row.tier, status: row.status,
    capability: optionalText(route.requestedCapability, 100), selectedWorker: optionalText(route.selectedWorker, 100),
    model: optionalText(route.model, 200), fallbackReason: optionalText(route.fallbackReason), routeReason: optionalText(route.reason),
    failureKind: optionalText(row.failureKind, 200), parentRunId: row.parentRunId, startedAt: iso(row.startedAt), finishedAt: row.finishedAt ? iso(row.finishedAt) : null,
    workerSucceeded: typeof worker.success === 'boolean' ? worker.success : null,
    error: optionalText(row.error ?? result.error), message: safeText(worker.message, 8000), messageTruncated: worker.messageTruncated === true || (typeof worker.message === 'string' && worker.message.length > 8000),
    workspace: workspace ? { path: safeText(workspace.path, 1000), branch: safeText(workspace.branch, 300), baseBranch: safeText(workspace.baseBranch, 300), baseCommit: safeText(workspace.baseCommit, 100) } : null,
    git: result.git ? { changedFiles: list(git.changedFiles).slice(0, 100).map(p => safeText(p, 500)),
      countIsLowerBound: typeof git.countIsLowerBound === 'boolean' ? git.countIsLowerBound : git.truncated === true,
      changedFileCount: typeof git.changedFileCount === 'number' ? git.changedFileCount : list(git.changedFiles).length,
      statusShort: safeText(git.statusShort, 8000), diffStat: safeText(git.diffStat, 8000), truncated: git.truncated === true || list(git.changedFiles).length > 100 } : null,
    checks: list(verification.checks).slice(0, 20).map(value => {
      const c = record(value), output = `${safeText(c.stdout, 8000)}${c.stderr ? `\n${safeText(c.stderr, 8000)}` : ''}`.trim();
      return { name: safeText(c.name, 100), command: optionalText(c.command, 300),
        status: c.skipped === true ? 'skipped' as const : c.timedOut === true ? 'timeout' as const : c.success === true ? 'pass' as const : 'fail' as const,
        durationMs: number(c.durationMs), output: output.slice(0, 8000), outputTruncated: c.outputTruncated === true || output.length > 8000 || [c.stdout, c.stderr].some(v => typeof v === 'string' && v.length > 8000),
        exitCode: typeof c.exitCode === 'number' ? c.exitCode : null };
    }) };
}
export function mapReview(row: typeof reviews.$inferSelect): ReviewDto {
  const result = row.result;
  return { id: row.id, runId: row.runId, reviewer: row.reviewer, provider: row.providerFamily, model: optionalText(row.model, 200),
    status: row.status, decision: result?.decision ?? null, severity: result?.severity ?? null, summary: safeText(result?.summary),
    error: optionalText(row.error), createdAt: iso(row.createdAt), finishedAt: row.finishedAt ? iso(row.finishedAt) : null,
    findings: (result?.findings ?? []).slice(0, 20).map(f => ({ file: optionalText(f.file, 500), line: f.line ?? null, category: f.category,
      description: safeText(f.description, 1000), reason: safeText(f.reason, 1000), suggestedFix: optionalText(f.suggestedFix) })) };
}
const workerNames: Record<string, string> = { opencode: 'OpenCode', codex: 'Codex', antigravity: 'Antigravity' };
export const workerName = (worker: unknown) => typeof worker === 'string' ? workerNames[worker] ?? safeText(worker, 100) : 'Worker';
export function formatActivity(kind: string, data: unknown): { title: string; detail: string } {
  const d = record(data), decision = record(d.decision);
  const attempt = typeof d.attempt === 'number' ? `attempt ${d.attempt}` : 'attempt';
  const names: Record<string, string> = {
    task_created: 'Task created', recorded_run_start: `Recorded ${workerName(d.worker)} ${attempt}`,
    recorded_run_finish: `${workerName(d.worker)} finished ${attempt}`,
    recorded_review_finish: `${workerName(d.reviewer)} review recorded`,
    verification_decided: d.verified === true ? 'Verification accepted · review next' : 'Verification requires attention · Chief next',
    attempt_reserved: `Reserved ${attempt}`, worker_started: `${workerName(d.worker)} started ${attempt}`,
    attempt_finished: `${workerName(d.worker)} finished ${attempt}`,
    repair_started: 'Chief is considering a repair', repair_decided: 'Chief made a repair decision',
    repair_authorized: `Chief requested ${safeText(d.enforcedCapability, 100) || 'a repair'}`,
    review_started: `${workerName(d.reviewer)} started review`, review_finished: `${workerName(d.reviewer)} ${d.decision === 'approve' ? 'approved the change' : d.decision === 'request_changes' ? 'requested changes' : 'requested human input'}`,
    review_changes_requested: 'Review requires changes', escalation_opened: 'Needs your decision', human_answered: 'Human answered · task queued',
    human_abandoned: 'Human abandoned task', completed: 'Task completed', invalid_state: 'Task stopped · invalid state',
  };
  return { title: names[kind] ?? safeText(kind.replaceAll('_', ' ').replaceAll('.', ' '), 150),
    detail: safeText(decision.summary ?? d.reason ?? d.reasonType ?? d.error ?? (kind === 'attempt_finished' ? d.verified === true ? 'Verification recorded as successful' : 'Attempt requires attention' : ''), 1000) };
}
export function mapActivity(row: typeof orchestrationEvents.$inferSelect, title: string, worker?: string | null): ActivityEventDto {
  return { id: row.id, taskId: row.taskId, runId: row.runId, taskTitle: safeText(title, 300), kind: row.kind,
    ...formatActivity(row.kind, worker ? { ...record(row.data), worker } : row.data), at: iso(row.createdAt) };
}
export function buildTimeline(task: TaskListItemDto, runs: RunDto[], reviews: ReviewDto[], decisions: EscalationDto[], events: ActivityEventDto[]): TimelineEventDto[] {
  const timeline: TimelineEventDto[] = [{ id: `created-${task.id}`, kind: 'created', title: 'Task created',
    detail: task.capability ? `Requested ${task.capability}` : 'No Chief recommendation recorded', at: task.createdAt, ref: null }];
  for (const run of runs) {
    timeline.push({ id: `run-${run.id}`, kind: 'attempt', title: `Attempt ${run.attempt} · ${workerName(run.worker)}`,
      detail: `${run.model ?? 'Model not recorded'} · ${run.status}`, at: run.startedAt, ref: `run-${run.id}` });
    if (run.checks.length && run.finishedAt) timeline.push({ id: `verification-${run.id}`, kind: 'verification', title: 'Verification recorded',
      detail: run.checks.map(c => `${c.name}: ${c.status}`).join(' · '), at: run.finishedAt, ref: `run-${run.id}` });
  }
  for (const review of reviews) timeline.push({ id: `review-${review.id}`, kind: 'review', title: `${workerName(review.reviewer)} review`,
    detail: review.decision ?? review.status, at: review.finishedAt ?? review.createdAt, ref: `review-${review.id}` });
  for (const decision of decisions) timeline.push({ id: `decision-${decision.id}`, kind: 'decision', title: 'Human escalation opened',
    detail: decision.question, at: decision.createdAt, ref: `decision-${decision.id}` });
  const duplicates = new Set(['attempt_reserved', 'worker_started', 'attempt_finished', 'review_started', 'review_finished', 'escalation_opened']);
  for (const event of events) if (!duplicates.has(event.kind)) timeline.push({ id: event.id, kind: event.kind,
    title: event.title, detail: event.detail, at: event.at, ref: null });
  return timeline.sort((a, b) => a.at.localeCompare(b.at));
}
export function overviewCounts(rows: Array<{ status: string; count: number }>) {
  const counts = Object.fromEntries(rows.map(row => [row.status, row.count]));
  return { running: (counts.running ?? 0) + (counts.repairing ?? 0) + (counts.reviewing ?? 0), queued: counts.queued ?? 0,
    waiting: counts.waiting_human ?? 0, failed: counts.failed ?? 0, pending: counts.pending ?? 0 };
}
