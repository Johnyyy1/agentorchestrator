'use client';
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ProjectDto, MemoryDto } from '../../../src/projects/contracts.js';
import type { RankedMemory } from '../../../src/memory/retrieval.js';
import { memoryKindSchema, projectDtoSchema, memoryDtoSchema } from '../../../src/projects/contracts.js';
import { LocalTime, useHydrated } from './live.js';
export async function projectRequest(path: string, value: unknown, method = 'POST', key = crypto.randomUUID()) {
  const response = await fetch(`/api/projects${path}`, { method, headers: { 'Content-Type': 'application/json', 'X-Request-ID': key }, body: JSON.stringify(value) });
  const data = await response.json(); if (!response.ok) throw new Error(data.error ?? 'Project operation failed.'); return data;
}
export function ProjectEditor({ project, repositories }: { project?: ProjectDto; repositories: Array<{ id: string; name: string }> }) {
  const hydrated = useHydrated();
  const router = useRouter(), lock = useRef(false), key = useRef<string | null>(null);
  const [pending,setPending] = useState(false), [error,setError] = useState(''), [message,setMessage] = useState('');
  const [selected,setSelected] = useState(project?.repositories.map(r => r.repositoryId) ?? []);
  const [primary,setPrimary] = useState(project?.repositories.find(r => r.isPrimary)?.repositoryId ?? '');
  async function submit(form: HTMLFormElement) {
    if (lock.current) return; lock.current=true; setPending(true); setError(''); setMessage(''); key.current ??= crypto.randomUUID();
    const data = new FormData(form), fields = ['name','description','currentMilestone','goals','constraints','instructions'];
    const values = Object.fromEntries(fields.map(f => [f, String(data.get(f) ?? '').trim() || (f === 'name' ? '' : null)]));
    try {
      const result = projectDtoSchema.parse(await projectRequest(project ? `/${project.id}` : '', { ...values, ...(project ? { status: data.get('status') } : {}),
        repositories: selected.map(repositoryId => ({ repositoryId, isPrimary: repositoryId === primary, role: project?.repositories.find(r => r.repositoryId === repositoryId)?.role ?? null })) }, project ? 'PATCH' : 'POST', key.current));
      key.current=null; setMessage('Project saved.'); if (!project) router.push(`/projects/${result.id}`); else router.refresh();
    } catch (e) { setError(e instanceof Error ? e.message : 'Project could not be saved.'); }
    finally { lock.current=false; setPending(false); }
  }
  return <details className="project-editor" open={!project}><summary>{project ? 'Edit project & repository bindings' : 'Create project'}</summary><form onChange={() => { key.current=null; }} onSubmit={e => { e.preventDefault(); void submit(e.currentTarget); }}>
    <fieldset disabled={pending || !hydrated}><label>Name<input name="name" required maxLength={200} defaultValue={project?.name} /></label><label>Description<textarea name="description" rows={2} maxLength={2000} defaultValue={project?.description ?? ''} /></label>
    {project && <label>Status<select name="status" defaultValue={project.status}><option>active</option><option>paused</option><option>archived</option></select></label>}
    <label>Current milestone<input name="currentMilestone" maxLength={1000} defaultValue={project?.currentMilestone ?? ''} /></label>
    {(['goals','constraints','instructions'] as const).map(field => <label key={field}>{field[0].toUpperCase()+field.slice(1)}<textarea name={field} rows={3} maxLength={3000} defaultValue={project?.[field] ?? ''} /></label>)}
    <fieldset><legend>Registered repositories</legend>{repositories.length ? repositories.map(r => <label className="binding-option" key={r.id}><input type="checkbox" checked={selected.includes(r.id)} onChange={e => { setSelected(e.target.checked ? [...selected,r.id] : selected.filter(id => id !== r.id)); if (!e.target.checked && primary === r.id) setPrimary(''); }} />{r.name}</label>) : <p className="muted">Register repositories on the Repositories page first.</p>}</fieldset>
    <label>Primary repository<select value={primary} onChange={e => setPrimary(e.target.value)}><option value="">No primary repository</option>{repositories.filter(r => selected.includes(r.id)).map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
    <button className="button primary">{pending ? 'Saving…' : project ? 'Save project' : 'Create project'}</button></fieldset></form>{error && <p role="alert" className="form-error">{error}</p>}{message && <p role="status">{message}</p>}</details>;
}
export function MemoryInspector({ projectId, memories }: { projectId: string; memories: MemoryDto[] }) {
  const router=useRouter(), lock=useRef(false), key=useRef<string | null>(null), [pending,setPending]=useState(false), [error,setError]=useState(''), [message,setMessage]=useState('');
  const [query,setQuery]=useState(''), [results,setResults]=useState<RankedMemory[] | null>(null), [cursor,setCursor]=useState<string | null>(null);
  async function action(operation: string, value: unknown, success: (data: unknown) => void) {
    if (lock.current) return; lock.current=true; setPending(true); setError(''); setMessage(''); key.current ??= crypto.randomUUID();
    try { const data: unknown=await projectRequest(`/${projectId}/${operation}`,value,'POST',key.current); success(data); key.current=null; router.refresh(); }
    catch(e) { setError(e instanceof Error ? e.message : 'Memory operation failed.'); }
    finally { lock.current=false; setPending(false); }
  }
  return <section className="memory-inspector"><h2>Project memory</h2><p className="muted">Explicit knowledge and deterministic task outcomes. Every entry retains its source.</p>
    <details><summary>Add manual memory</summary><form onChange={() => { key.current=null; }} onSubmit={e => { e.preventDefault(); const form=e.currentTarget, data=new FormData(form); void action('memories',{ kind:data.get('kind'),title:String(data.get('title') ?? '') || null,content:data.get('content'),importance:Number(data.get('importance')) }, raw => { const d=raw as { memory: unknown; indexing: { indexed: boolean } }; memoryDtoSchema.parse(d.memory); form.reset(); setMessage(d.indexing.indexed ? 'Memory saved and indexed.' : 'Memory saved. Indexing unavailable; retry indexing when ready.'); }); }}><fieldset disabled={pending}>
      <label>Type<select name="kind">{memoryKindSchema.options.map(k => <option key={k}>{k}</option>)}</select></label><label>Title<input name="title" maxLength={200} /></label><label>Memory content<textarea name="content" rows={4} maxLength={8000} required /></label><label>Importance (0–5)<input name="importance" type="number" min={0} max={5} defaultValue={2} required /></label><button className="button primary">Save manual memory</button></fieldset></form></details>
    <form onSubmit={e => { e.preventDefault(); void action('search',{query},data => { setResults(data as RankedMemory[]); }); }}><label htmlFor="memory-search">Semantic search<input id="memory-search" maxLength={4000} required value={query} disabled={pending} onChange={e => { setQuery(e.target.value); key.current=null; }} placeholder="What do we know about market data?" /></label><button className="button" disabled={pending || !query.trim()}>Search project memory</button></form>
    {results && <div role="status"><h3>Search results · {results.length}</h3>{results.map(m => <article className="memory-entry" key={m.id}><strong>{m.title ?? m.kind}</strong><p className="prose">{m.content}</p><span className="mono">{m.kind} · {m.sourceType}{m.sourceId ? `:${m.sourceId}` : ''} · similarity {m.similarity.toFixed(3)} · relevance {m.score.toFixed(3)}</span></article>)}</div>}
    <div className="memory-actions"><button className="button" disabled={pending} onClick={() => { key.current=null; void action('sync', cursor ? {afterTaskId:cursor} : {}, data => { const d=data as {scanned:number;created:number;alreadyExisted:number;embeddingFailures:number;nextCursor:string|null}; setCursor(d.nextCursor);setMessage(`Scanned ${d.scanned} · created ${d.created} · already existed ${d.alreadyExisted} · embedding failures ${d.embeddingFailures}`); }); }}>{cursor ? 'Sync next outcome batch' : 'Sync completed task outcomes'}</button><button className="text-button" disabled={pending} onClick={() => { key.current=null; void action('index',{},data => { const d=data as {scanned:number;indexed:number;embeddingFailures:number};setMessage(`Scanned ${d.scanned} · indexed ${d.indexed} · embedding failures ${d.embeddingFailures}`); }); }}>Retry pending indexing</button></div>
    {error && <p role="alert" className="form-error">{error}</p>}{message && <p role="status">{message}</p>}{pending && <p role="status">Working…</p>}
    <div>{memories.length ? memories.map(m => <article className="memory-entry" key={m.id}><div className="eyebrow">{m.kind} · importance {m.importance} · {m.indexed ? 'indexed' : `unindexed${m.embeddingError ? `: ${m.embeddingError}` : ''}`}</div><h3>{m.title ?? m.kind}</h3><p className="prose">{m.content}</p><p className="mono">Source: {m.sourceType}{m.sourceId ? ` · ${m.sourceId}` : ''}</p><LocalTime value={m.createdAt} />{m.sourceMetadata && <details><summary>Provenance metadata</summary><pre>{JSON.stringify(m.sourceMetadata,null,2)}</pre></details>}{m.sourceType === 'manual' && <button className="text-button danger" disabled={pending} onClick={() => { key.current=null; void action('archive-memory',{memoryId:m.id},() => setMessage('Manual memory archived. Task snapshots retain its ID.')); }}>Archive manual memory</button>}</article>) : <p className="muted">No project memories yet.</p>}</div>
  </section>;
}
