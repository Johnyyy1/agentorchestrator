import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { z } from 'zod';
import { projectDetail, repositoryOptions, load } from '../../../lib/server.js';
import { ProjectEditor, MemoryInspector } from '../../../components/project-editor.js';
import { PageHeader, Section, SystemError } from '../../../components/primitives.js';
import { LocalTime } from '../../../components/live.js';
export default async function ProjectPage({params,searchParams}:{params:Promise<{key:string}>;searchParams:Promise<{page?:string}>}) {
  const {key}=await params;
  if (/^[a-f0-9]{24}$/.test(key)) redirect(`/repositories/${key}`);
  if (!z.uuid().safeParse(key).success) notFound();
  const page=z.coerce.number().int().min(1).max(100000).catch(1).parse((await searchParams).page ?? 1);
  const result=await load(async () => ({ detail:await projectDetail(key,page),repositories:await repositoryOptions() }));
  if (!result.ok) return <SystemError />; if (!result.data.detail) notFound();
  const {project:p,memories}=result.data.detail;
  return <><Link href="/projects" className="back-link">← All projects</Link><PageHeader eyebrow={`PROJECT / ${p.status.toUpperCase()}`} title={p.name} description={p.description ?? 'Persistent project context'} />
    <dl className="detail-fields">{(['currentMilestone','goals','constraints','instructions'] as const).map(k => <div key={k}><dt>{k === 'currentMilestone' ? 'Current milestone' : k}</dt><dd className="prose">{p[k] ?? 'Not set'}</dd></div>)}</dl>
    <Section title="Repositories">{p.repositories.length ? p.repositories.map(r => <p key={r.repositoryId}><Link href={`/repositories/${r.key}`}>{r.name}</Link>{r.isPrimary ? ' · primary' : ''}{r.role ? ` · ${r.role}` : ''}</p>) : <p className="muted">No repository bound.</p>}</Section>
    <ProjectEditor project={p} repositories={result.data.repositories} /><MemoryInspector projectId={p.id} memories={memories.items} />
    <div className="pagination">{page>1 && <Link href={`/projects/${p.id}?page=${page-1}`}>← Previous memories</Link>}{memories.hasMore && <Link href={`/projects/${p.id}?page=${page+1}`}>Next memories →</Link>}</div>
    <Section title="Recent tasks">{p.recentTasks.length ? p.recentTasks.map(t => <p key={t.id}><Link href={`/tasks/${t.id}`}>{t.title}</Link> · {t.status} · <LocalTime value={t.updatedAt} /></p>) : <p className="muted">No project tasks yet.</p>}</Section><Link className="button" href="/">Delegate a project goal →</Link></>;
}
