import Link from 'next/link';
import { RepositoryRegistration } from '../../components/commands.js';
import { ArrowUpRight } from 'lucide-react';
import { repositories, load } from '../../lib/server.js';
import { PageHeader, Empty, Status, SystemError } from '../../components/primitives.js';
import { LiveRefresh, LocalTime } from '../../components/live.js';
export const metadata = { title: 'Repositories' };
export default async function ProjectsPage() {
  const result = await load(repositories);
  if (!result.ok) return <><LiveRefresh /><SystemError /></>;
  return <><PageHeader eyebrow="REPOSITORIES / 02" title="Repositories" description="Registered repositories and historical task context."><LiveRefresh /></PageHeader>
    <RepositoryRegistration />
    {!result.data.length ? <Empty title="No repositories recorded yet." detail="Add a Git repository to delegate your first coding task." />
      : <div className="table-scroll" tabIndex={0} role="region" aria-label="Repositories"><table className="data-table project-table"><thead><tr><th>Repository</th><th>Tasks</th><th>Active</th><th>Queued</th><th>Waiting</th><th>Latest task state</th><th>Updated</th><th><span className="sr-only">Open</span></th></tr></thead><tbody>{result.data.map(p => <tr key={p.key}><td><Link href={`/repositories/${p.key}`} className="project-name">{p.name}</Link><span className="mono table-sub path" title={p.path}>{p.path}</span></td><td className="mono">{p.total}</td><td className="mono">{p.running}</td><td className="mono">{p.queued}</td><td className={`mono ${p.waiting ? 'attention-text' : ''}`}>{p.waiting}</td><td><Status status={p.latestStatus} />{!p.available && <span className="table-sub attention-text" title={p.unavailableReason ?? undefined}>{p.registered ? "Unavailable" : "Registration required"}</span>}</td><td><LocalTime value={p.updatedAt} /></td><td><Link href={`/repositories/${p.key}`} aria-label={`Open ${p.name}`}><ArrowUpRight size={16} /></Link></td></tr>)}</tbody></table></div>}
    <p className="page-note">Repository Registry owns validated Git paths. Bind these repositories to a project for persistent context.</p></>;
}
