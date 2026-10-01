import { notFound } from 'next/navigation';
import Link from 'next/link';
import { projects, tasks, activity, decisions, load, parseTaskQuery } from '../../../lib/server.js';
import { PageHeader, Section, TaskRows, DecisionRows, ActivityRows, SystemError } from '../../../components/primitives.js';
import { LiveRefresh } from '../../../components/live.js';
export default async function ProjectPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  if (!/^[a-f0-9]{24}$/.test(key)) notFound();
  const result = await load(async () => {
    const repositories = await projects(), project = repositories.find(p => p.key === key);
    if (!project) return null;
    const [recent, inbox] = await Promise.all([activity(1, key), decisions(1, key)]);
    const [active, queued, completed, failed] = await Promise.all([
      Promise.all(['running', 'repairing', 'reviewing'].map(status => tasks(parseTaskQuery({ project: key, status })))),
      tasks(parseTaskQuery({ project: key, status: 'queued' })), tasks(parseTaskQuery({ project: key, status: 'completed' })), tasks(parseTaskQuery({ project: key, status: 'failed' })),
    ]);
    return { project, recent, inbox, active: active.flatMap(l => l.items), queued, completed, failed };
  });
  if (!result.ok) return <><LiveRefresh /><SystemError /></>;
  if (!result.data) notFound();
  const d = result.data;
  return <><Link href="/projects" className="back-link">← All repositories</Link><PageHeader eyebrow="REPOSITORY" title={d.project.name} description={d.project.path}><LiveRefresh active={d.project.running > 0} /></PageHeader>
    <div className="project-summary mono">{d.project.total} tasks <span>·</span> {d.project.running} active <span>·</span> {d.project.queued} queued <span>·</span> {d.project.waiting} waiting</div>
    <Section title="Active" count={d.project.running}><TaskRows items={d.active} /></Section><Section title="Needs your decision" count={d.project.waiting}><DecisionRows items={d.inbox.items.filter(e => e.status === 'open')} /></Section>
    <Section title="Queued" count={d.project.queued}><TaskRows items={d.queued.items} empty="The queue is clear." /></Section><div className="overview-columns"><Section title="Recent completions" href={`/tasks?project=${key}&status=completed`}><TaskRows items={d.completed.items.slice(0, 8)} empty="No completed tasks yet." /></Section><Section title="Recent failures" href={`/tasks?project=${key}&status=failed`}><TaskRows items={d.failed.items.slice(0, 8)} empty="No failures recorded." /></Section></div><Section title="Recent activity" href={`/activity?project=${key}`}><ActivityRows items={d.recent.items.slice(0, 15)} /></Section><Link href={`/tasks?project=${key}`} className="button">Browse all repository tasks</Link></>;
}
