'use client';
import type { ProjectDto as ProjectModelDto } from '../../../src/projects/contracts.js';
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowRight, Check, CornerDownLeft, LoaderCircle } from 'lucide-react';
import type { EscalationDto, ProjectDto, DelegateResultDto } from '../../../src/control-plane/contracts.js';
import { delegateResultSchema, registeredRepositorySchema } from '../../../src/control-plane/contracts.js';
import { Status } from './primitives.js';

async function post(operation: string, value: unknown, key: string) {
  const response = await fetch(`/api/commands/${operation}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Request-ID': key }, body: JSON.stringify(value) });
  const data = await response.json();
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : 'The request could not complete.');
  return data;
}
function Busy() { return <LoaderCircle size={15} className="busy-icon" aria-hidden="true" />; }
export function CommandBar({ projects, models = [] }: { projects: ProjectDto[]; models?: ProjectModelDto[] }) {
  const router = useRouter(), lock = useRef(false), requestKey = useRef<string | null>(null);
  const [modelId, setModelId] = useState('');
  const model = models.find(m => m.id === modelId);
  const [goal, setGoal] = useState(''), [project, setProject] = useState(''), [pending, setPending] = useState(false);
  const [added, setAdded] = useState<ProjectDto | null>(null);
  const all = added && !projects.some(p => p.key === added.key) ? [...projects, added] : projects;
  const inventory = model ? all.filter(r => model.repositories.some(b => b.key === r.key)) : all;
  const selected = inventory.find(p => p.key === project);
  const [result, setResult] = useState<DelegateResultDto | null>(null), [error, setError] = useState('');
  async function submit() {
    if (lock.current || !goal.trim() || (project && !selected?.available)) return;
    lock.current = true; setPending(true); setError(''); setResult(null);
    requestKey.current ??= crypto.randomUUID();
    try {
      const data = delegateResultSchema.parse(await post('delegate', { goal, ...(model ? { projectId: model.id, ...(project ? { repositoryId: model.repositories.find(r => r.key === project)?.repositoryId } : {}) } : project ? { projectKey: project } : {}) }, requestKey.current));
      setResult(data); router.refresh();
      if (data.action === 'create_task') { setGoal(''); requestKey.current = null; }
    } catch (e) { setError(e instanceof Error ? e.message : 'The connection was interrupted. Check Tasks before retrying.'); }
    finally { lock.current = false; setPending(false); }
  }
  return <section className="command" aria-label="Delegate a goal"><form onSubmit={e => { e.preventDefault(); void submit(); }}>
    <label htmlFor="goal">What should Jonas OS do?</label><textarea id="goal" name="goal" rows={2} maxLength={4000} required disabled={pending} placeholder="Describe the next goal…" value={goal}
      onChange={e => { setGoal(e.target.value); requestKey.current = null; }} onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submit(); } }} />
    <div className="command-footer"><div><label htmlFor="project-model">Project</label><select id="project-model" value={modelId} disabled={pending} onChange={e => { setModelId(e.target.value); const next = models.find(m => m.id === e.target.value); setProject(next?.repositories.find(r => r.isPrimary)?.key ?? (next?.repositories.length === 1 ? next.repositories[0]!.key : '')); requestKey.current = null; }}><option value="">No project context</option>{models.map(m => <option key={m.id} value={m.id} disabled={m.status !== 'active'}>{m.name} · {m.status}</option>)}</select><label className="sr-only" htmlFor="repository">Repository context</label><select id="repository" value={project} disabled={pending} onChange={e => { setProject(e.target.value); requestKey.current = null; }}><option value="">No repository context</option>{inventory.map(p => <option key={p.key} value={p.key} disabled={!p.available} title={p.path}>{p.name} · {p.path.length > 50 ? `…${p.path.slice(-49)}` : p.path}{!p.available ? p.registered ? " · unavailable" : " · register to use" : ""}</option>)}</select><span className="repository-context-path mono" title={selected?.path}>{selected?.path}</span><span className="command-hint">Local Chief plans · existing worker executes</span></div><button className="button primary" disabled={pending || !goal.trim() || Boolean(project && !selected?.available)}>{pending ? <Busy /> : <ArrowRight size={15} />}{pending ? 'Chief is planning…' : 'Delegate'}{!pending && <CornerDownLeft size={12} className="key-icon" />}</button></div>
  </form><RepositoryRegistration disabled={pending || Boolean(modelId)} onAdded={entry => { setAdded(entry); setProject(entry.key); requestKey.current = null; }} />{selected && !selected.available && <p className="form-error">{selected.unavailableReason}</p>}{error && <p role="alert" className="form-error">{error}</p>}{result && <div role="status" className="command-result">{result.action === 'create_task' ? <><Check size={17} /><div><strong>Task queued · {result.title}</strong><p className="mono">{result.capability} · {result.taskId}</p><Link href={`/tasks/${result.taskId}`}>Inspect task <ArrowRight size={13} /></Link></div></> : result.action === 'ask_human' ? <div><strong>Chief needs clarification</strong><p>{result.question}</p><span className="muted">Add the answer to your goal and delegate again.</span></div> : <div><strong>No action needed</strong><p>{result.reason}</p></div>}</div>}</section>;
}
export function RepositoryRegistration({ disabled = false, onAdded }: { disabled?: boolean; onAdded?: (entry: ProjectDto) => void }) {
  const router = useRouter(), lock = useRef(false), requestKey = useRef<string | null>(null);
  const [open, setOpen] = useState(false), [path, setPath] = useState(''), [pending, setPending] = useState(false);
  const [error, setError] = useState(''), [success, setSuccess] = useState('');
  async function register() {
    if (lock.current || !path.trim()) return;
    lock.current = true; setPending(true); setError(''); setSuccess(''); requestKey.current ??= crypto.randomUUID();
    try {
      const row = registeredRepositorySchema.parse(await post('repository', { path }, requestKey.current));
      onAdded?.({ key: row.key, name: row.name, path: row.path, registered: true, available: true, unavailableReason: null,
        running: 0, queued: 0, waiting: 0, failed: 0, completed: 0, total: 0, updatedAt: new Date().toISOString(), latestStatus: 'No tasks' });
      setSuccess(`Registered ${row.name}`); setOpen(false); setPath(''); requestKey.current = null; router.refresh();
    } catch (e) { setError(e instanceof Error ? e.message : 'Repository registration failed.'); }
    finally { lock.current = false; setPending(false); }
  }
  return <div className="repository-registration"><button type="button" className="text-button" disabled={disabled || pending} aria-expanded={open} onClick={() => { setOpen(!open); setError(''); setSuccess(''); }}>+ Add repository</button>
    {open && <form onSubmit={e => { e.preventDefault(); void register(); }}><label>Repository path<input name="repositoryPath" placeholder="/absolute/path/to/repository" maxLength={4096} required value={path} disabled={pending} onChange={e => { setPath(e.target.value); requestKey.current = null; }} /></label><p className="muted">Enter the Git working tree path. The server validates it; no directory browser is available.</p><button className="button primary" disabled={pending || !path.trim()}>{pending ? 'Validating…' : 'Add repository'}</button></form>}
    {error && <p role="alert" className="form-error">{error}</p>}{success && <p role="status">{success}</p>}
  </div>;
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
