import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';
import { projects, load } from '../../lib/server.js';
import { PageHeader, Empty, Status, SystemError } from '../../components/primitives.js';
import { LiveRefresh, LocalTime } from '../../components/live.js';
export const metadata = { title: 'Projects' };
export default async function ProjectsPage() {
  const result = await load(projects);
  if (!result.ok) return <><LiveRefresh /><SystemError /></>;
  return <><PageHeader eyebrow="REPOSITORIES / 02" title="Projects" description="A view of work grouped by repository. Derived from task context."><LiveRefresh /></PageHeader>
    {!result.data.length ? <Empty title="No repositories recorded yet." detail="A repository appears here when a task includes repository context. V1 does not maintain a project registry." />
      : <div className="table-scroll" tabIndex={0} role="region" aria-label="Repositories"><table className="data-table project-table"><thead><tr><th>Repository</th><th>Active</th><th>Queued</th><th>Waiting</th><th>Latest task state</th><th>Updated</th><th><span className="sr-only">Open</span></th></tr></thead><tbody>{result.data.map(p => <tr key={p.key}><td><Link href={`/projects/${p.key}`} className="project-name">{p.name}</Link><span className="mono table-sub path" title={p.path}>{p.path}</span></td><td className="mono">{p.running}</td><td className="mono">{p.queued}</td><td className={`mono ${p.waiting ? 'attention-text' : ''}`}>{p.waiting}</td><td><Status status={p.latestStatus} /></td><td><LocalTime value={p.updatedAt} /></td><td><Link href={`/projects/${p.key}`} aria-label={`Open ${p.name}`}><ArrowUpRight size={16} /></Link></td></tr>)}</tbody></table></div>}
    <p className="page-note">Repository paths define these groups. Roadmaps and semantic project memory are reserved for a future milestone.</p></>;
}
