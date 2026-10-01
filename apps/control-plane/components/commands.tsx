'use client';
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowRight, Check, CornerDownLeft, LoaderCircle } from 'lucide-react';
import type { EscalationDto, ProjectDto, DelegateResultDto } from '../../../src/control-plane/contracts.js';
import { delegateResultSchema } from '../../../src/control-plane/contracts.js';
import { Status } from './primitives.js';

async function post(operation: string, value: unknown, key: string) {
  const response = await fetch(`/api/commands/${operation}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Request-ID': key }, body: JSON.stringify(value) });
  const data = await response.json();
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : 'The request could not complete.');
  return data;
}
function Busy() { return <LoaderCircle size={15} className="busy-icon" aria-hidden="true" />; }
export function CommandBar({ projects }: { projects: ProjectDto[] }) {
  const router = useRouter(), lock = useRef(false), requestKey = useRef<string | null>(null);
  const [goal, setGoal] = useState(''), [project, setProject] = useState(''), [pending, setPending] = useState(false);
  const [result, setResult] = useState<DelegateResultDto | null>(null), [error, setError] = useState('');
  async function submit() {
    if (lock.current || !goal.trim()) return;
    lock.current = true; setPending(true); setError(''); setResult(null);
    requestKey.current ??= crypto.randomUUID();
    try {
      const data = delegateResultSchema.parse(await post('delegate', { goal, ...(project ? { projectKey: project } : {}) }, requestKey.current));
      setResult(data); router.refresh();
      if (data.action === 'create_task') { setGoal(''); requestKey.current = null; }
    } catch (e) { setError(e instanceof Error ? e.message : 'The connection was interrupted. Check Tasks before retrying.'); }
    finally { lock.current = false; setPending(false); }
  }
  return <section className="command" aria-label="Delegate a goal"><form onSubmit={e => { e.preventDefault(); void submit(); }}>
    <label htmlFor="goal">What should Jonas OS do?</label><textarea id="goal" name="goal" rows={2} maxLength={4000} required disabled={pending} placeholder="Describe the next goal…" value={goal}
      onChange={e => { setGoal(e.target.value); requestKey.current = null; }} onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submit(); } }} />
    <div className="command-footer"><div><label className="sr-only" htmlFor="repository">Repository context</label><select id="repository" value={project} disabled={pending} onChange={e => { setProject(e.target.value); requestKey.current = null; }}><option value="">No repository context</option>{projects.map(p => <option key={p.key} value={p.key}>{p.name}</option>)}</select><span className="command-hint">Local Chief plans · existing worker executes</span></div><button className="button primary" disabled={pending || !goal.trim()}>{pending ? <Busy /> : <ArrowRight size={15} />}{pending ? 'Chief is planning…' : 'Delegate'}{!pending && <CornerDownLeft size={12} className="key-icon" />}</button></div>
  </form>{error && <p role="alert" className="form-error">{error}</p>}{result && <div role="status" className="command-result">{result.action === 'create_task' ? <><Check size={17} /><div><strong>Task queued · {result.title}</strong><p className="mono">{result.capability} · {result.taskId}</p><Link href={`/tasks/${result.taskId}`}>Inspect task <ArrowRight size={13} /></Link></div></> : result.action === 'ask_human' ? <div><strong>Chief needs clarification</strong><p>{result.question}</p><span className="muted">Add the answer to your goal and delegate again.</span></div> : <div><strong>No action needed</strong><p>{result.reason}</p></div>}</div>}</section>;
}
export function DecisionPanel({ entry }: { entry: EscalationDto }) {
  const router = useRouter(), lock = useRef(false), key = useRef<string | null>(null);
  const [answer, setAnswer] = useState(''), [pending, setPending] = useState(false), [error, setError] = useState('');
  const [confirm, setConfirm] = useState(false), [outcome, setOutcome] = useState<'queued' | 'failed' | null>(null);
  async function mutate(abandon = false) {
    if (lock.current) return;
    lock.current = true; setPending(true); setError(''); key.current ??= crypto.randomUUID();
    try {
      const data = await post(abandon ? 'abandon' : 'answer', abandon ? { taskId: entry.taskId, confirmed: true } : { id: entry.id, answer }, key.current);
      if (data.taskId !== entry.taskId || data.taskStatus !== (abandon ? 'failed' : 'queued')) throw new Error('Unexpected response. Reload to check the decision.');
      setOutcome(abandon ? 'failed' : 'queued'); setConfirm(false); router.refresh();
    } catch (e) { setError(e instanceof Error ? e.message : 'The request could not complete.'); }
    finally { lock.current = false; setPending(false); }
  }
  if (outcome || entry.status !== 'open') return <div className="decision-resolved" role="status"><Check size={18} /><div><strong>{outcome === 'queued' ? 'Answer saved. Task queued.' : outcome === 'failed' ? 'Task abandoned. Work retained.' : `Decision ${entry.status}.`}</strong>{entry.answer && <p className="prose">{entry.answer}</p>}<p><Status status={outcome ?? entry.taskStatus} /></p><Link href={`/tasks/${entry.taskId}`}>Return to task <ArrowRight size={14} /></Link></div></div>;
  return <section className="decision-panel"><form onSubmit={e => { e.preventDefault(); void mutate(); }}><label htmlFor="answer">Your answer</label><textarea id="answer" rows={6} maxLength={6000} value={answer} required disabled={pending} placeholder="Give the Chief clear guidance and the boundaries of the next attempt." onChange={e => { setAnswer(e.target.value); key.current = null; }} />
    <p className="muted">Your answer guides the Chief. The existing task returns to its queue; the attempt limit stays in place.</p><div className="decision-actions"><button className="button primary" disabled={pending || !answer.trim()}>{pending ? <Busy /> : <ArrowRight size={15} />}{pending ? 'Submitting…' : 'Save answer & resume'}</button><button className="text-button danger" type="button" disabled={pending} onClick={() => { setConfirm(true); key.current = null; }}>Abandon task</button></div></form>
    {confirm && <div className="confirm-abandon" role="alert"><strong>Abandon this task?</strong><p>The task will be marked failed and open decisions cancelled. Its worktree and history remain available.</p><div><button className="button danger-button" disabled={pending} onClick={() => void mutate(true)}>Confirm abandonment</button><button className="text-button" disabled={pending} onClick={() => { setConfirm(false); key.current = null; }}>Keep task</button></div></div>}
    {error && <p className="form-error" role="alert">{error}</p>}
  </section>;
}
