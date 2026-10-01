import Link from 'next/link';
import type { TaskDetailDto } from '../../../src/control-plane/contracts.js';
import { taskOutcome } from '../../../src/control-plane/outcome.js';
const names: Record<string, string> = { codex: 'Codex', opencode: 'OpenCode', antigravity: 'Antigravity' };

export function TaskOutcome({ detail }: { detail: TaskDetailDto }) {
  const state = detail.task.status;
  if (!['completed', 'waiting_human', 'failed'].includes(state)) return null;
  const { run, reportRun, review, decision, reason, summary } = taskOutcome(detail);
  return <section className={`task-outcome ${state}`} aria-labelledby="outcome-title">
    <h2 id="outcome-title">{state === 'completed' ? 'FINAL RESULT' : state === 'waiting_human' ? 'WAITING FOR YOU' : 'FAILED'}</h2>
    {reason && <p className="outcome-reason">{reason}</p>}
    {decision && state === 'waiting_human' && <div className="outcome-question"><h3>Current question</h3><p className="prose">{decision.question}</p><Link className="button primary" href={`/decisions/${decision.id}`}>Answer & resume</Link></div>}
    <h3>{state === 'completed' ? 'Worker summary · What changed' : state === 'waiting_human' ? 'Work completed so far · last worker report' : 'Last worker result'}</h3>
    {summary ? <><p className="outcome-report prose">{summary}</p><p className="muted">Reported by {names[reportRun!.worker] ?? reportRun!.worker} · attempt {reportRun!.attempt}</p></>
      : <p className="muted">No final worker summary was captured. {state === 'completed' ? 'The task is recorded as completed.' : 'Persisted execution metadata is shown below.'}</p>}
    {run && reportRun?.id !== run.id && <p className="muted">System metadata below is from the latest attempt {run.attempt}; its worker report was not captured.</p>}
    <div className="outcome-metadata"><div><h3>Verification</h3>{run?.checks.length ? <ul className="outcome-checks">{run.checks.map((check, i) => <li key={i}><span className={`check-label ${check.status}`}>{check.status === 'pass' ? '✓' : check.status === 'fail' ? '✕' : '—'} {check.name} · {check.status}</span></li>)}</ul> : <p className="muted">No verification outcome recorded.</p>}</div>
      <div><h3>Independent review</h3>{review ? <><p>{review.decision === 'approve' ? '✓ Approved' : review.decision?.replaceAll('_', ' ') ?? review.status} by {names[review.reviewer] ?? review.reviewer}</p>{review.summary && <p className="prose">{review.summary}</p>}{review.error && <p className="form-error">{review.error}</p>}</> : <p className="muted">No independent review recorded for this attempt.</p>}</div></div>
    <h3>Files changed</h3>{run?.git ? <><p>{run.git.countIsLowerBound ? 'At least ' : ''}{run.git.changedFileCount} files</p><details><summary>Changed-file list{run.git.changedFileCount > run.git.changedFiles.length ? ` · showing ${run.git.changedFiles.length}` : ''}</summary><ul className="changed-files">{run.git.changedFiles.map((file, i) => <li key={i} className="mono">{file}</li>)}</ul>{run.git.diffStat && <pre>{run.git.diffStat}</pre>}</details></> : <p className="muted">No changed-file metadata captured.</p>}
    <h3>Notes / limitations</h3><p className="muted">Implementation notes are included in the worker report above. Verification and review shown here come from persisted system records.</p>
    {run?.checks.some(c => c.status === 'skipped') && <p className="muted">Skipped checks were not run and do not count as passing.</p>}
    {reportRun?.messageTruncated && <p className="muted">The worker report is truncated by the display limit.</p>}
    {run?.git?.truncated && <p className="muted">Git evidence is bounded; the list or diff may be incomplete.</p>}
    {run?.git?.countIsLowerBound && <p className="muted">The persisted file count is a lower bound.</p>}
    {detail.historyTruncated && <p className="muted">Some older execution history is omitted by the display limit.</p>}
  </section>;
}
