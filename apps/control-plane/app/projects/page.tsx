import Link from 'next/link';
import { projects, repositoryOptions, load, fixtureMode } from '../../lib/server.js';
import { ProjectEditor } from '../../components/project-editor.js';
import { PageHeader, Empty, SystemError } from '../../components/primitives.js';
import { LiveRefresh, LocalTime } from '../../components/live.js';
export const metadata = { title: 'Projects' };
export default async function ProjectsPage() {
  const result=await load(async () => ({projects:await projects(),repositories:await repositoryOptions()}));
  if (!result.ok) return <><LiveRefresh /><SystemError /></>;
  return <><PageHeader eyebrow="PROJECTS / 02" title="Projects" description="Persistent goals, constraints and project knowledge."><LiveRefresh /></PageHeader>{fixtureMode() ? <p className="muted">Project Model uses real database mode. These fixtures cover repository-only workflows.</p> : <ProjectEditor repositories={result.data.repositories} />}
    {result.data.projects.length ? <div className="table-scroll" role="region" aria-label="Projects" tabIndex={0}><table className="data-table"><thead><tr><th>Project</th><th>Status</th><th>Milestone</th><th>Primary repository</th><th>Recent task</th><th>Updated</th></tr></thead><tbody>{result.data.projects.map(p => <tr key={p.id}><td><Link className="project-name" href={`/projects/${p.id}`}>{p.name}</Link></td><td>{p.status}</td><td>{p.currentMilestone ?? 'Not set'}</td><td>{p.repositories.find(r => r.isPrimary)?.name ?? 'Not set'}</td><td>{p.recentTasks[0] ? <Link href={`/tasks/${p.recentTasks[0].id}`}>{p.recentTasks[0].title} · {p.recentTasks[0].status}</Link> : 'No tasks'}</td><td><LocalTime value={p.updatedAt} /></td></tr>)}</tbody></table></div> : <Empty title="No projects yet." detail="Create a project and bind registered repositories." />}
    <p className="page-note"><Link href="/repositories">Manage Repository Registry →</Link></p></>;
}
