import Link from 'next/link';
import { ArrowRight, ArrowUpRight, Inbox, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import type { ActivityEventDto, EscalationDto, TaskListItemDto } from '../../../src/control-plane/contracts.js';
import { statusLabel } from '../../../src/control-plane/format.js';
import { Elapsed, LocalTime } from './live.js';
export function PageHeader({ eyebrow, title, description, children }: { eyebrow: string; title: string; description?: string; children?: ReactNode }) {
  return <header className="page-header"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1>{description && <p>{description}</p>}</div>{children}</header>;
}
export function Section({ title, count, href, children, className = '' }: { title: string; count?: number; href?: string; children: ReactNode; className?: string }) {
  return <section className={`section ${className}`}><div className="section-heading"><h2>{title}{count !== undefined && <span className="section-count">{count}</span>}</h2>{href && <Link href={href}>View all <ArrowUpRight size={14} /></Link>}</div>{children}</section>;
}
export function Status({ status }: { status: string }) { return <span className="task-status"><span className={`dot ${status}`} />{statusLabel(status)}</span>; }
export function Empty({ title, detail }: { title: string; detail?: string }) {
  return <div className="empty"><Inbox size={20} strokeWidth={1.2} /><div><p>{title}</p>{detail && <span>{detail}</span>}</div></div>;
}
export function SystemError() {
  return <div role="alert" className="system-error"><TriangleAlert size={22} /><div><h1>Database unavailable</h1><p>Check PostgreSQL, DATABASE_URL and the applied migrations. The page will retry on its next refresh.</p><code>docker compose exec postgres pg_isready -U jonas -d jonas_os</code></div></div>;
}
export function TaskRows({ items, empty = 'Nothing is running.' }: { items: TaskListItemDto[]; empty?: string }) {
  if (!items.length) return <Empty title={empty} />;
  return <ul className="task-rows">{items.map(t => <li key={t.id}><Link href={`/tasks/${t.id}`} className="task-row"><div className="task-row-main"><span className="row-project">{t.projectName ?? 'No repository'}</span><strong>{t.title}</strong><span className="row-meta mono">{t.category} <span>·</span> {t.capability ?? 'category route'}</span></div><div className="task-row-end"><Status status={t.status} /><span className="mono row-worker">{t.worker ?? 'Awaiting worker'}{t.attempt > 0 && ` · ${t.attempt}`}</span>{t.startedAt && ['running', 'repairing', 'reviewing'].includes(t.status) && <Elapsed start={t.startedAt} />}</div><ArrowUpRight size={16} className="row-arrow" /></Link></li>)}</ul>;
}
export function DecisionRows({ items }: { items: EscalationDto[] }) {
  if (!items.length) return <Empty title="Nothing needs your attention." detail="Open human escalations will appear here." />;
  return <ul className="decision-rows">{items.map(e => <li key={e.id}><Link href={`/decisions/${e.id}`} className="decision-row"><div className="eyebrow decision-label">{e.projectName ?? 'No repository'} <span> / {e.reasonType.replaceAll('_', ' ')}</span></div><strong>{e.question}</strong><p>{e.taskTitle}</p><span className="decision-time"><LocalTime value={e.createdAt} /><ArrowRight size={15} /></span></Link></li>)}</ul>;
}
export function ActivityRows({ items }: { items: ActivityEventDto[] }) {
  if (!items.length) return <Empty title="No activity recorded." detail="Delegate a goal to begin a recorded task lifecycle." />;
  return <ol className="activity-rows">{items.map(e => <li key={e.id}><span className="activity-time mono"><LocalTime value={e.at} timeOnly /></span><span className={`activity-tick ${e.kind === 'completed' ? 'completed' : e.kind === 'escalation_opened' ? 'waiting_human' : ''}`} /><div><Link href={`/tasks/${e.taskId}`}>{e.title}</Link>{e.detail && <p>{e.detail}</p>}</div><Link href={`/tasks/${e.taskId}`} className="activity-task">{e.taskTitle}</Link></li>)}</ol>;
}
export function TaskTable({ items }: { items: TaskListItemDto[] }) {
  if (!items.length) return <Empty title="No tasks match this view." detail="Try a broader search or delegate a goal from Overview." />;
  return <div className="table-scroll" tabIndex={0} role="region" aria-label="Task table"><table className="data-table"><thead><tr><th>Status</th><th>Task</th><th>Project</th><th>Category / capability</th><th>Worker</th><th>Attempt</th><th>Updated</th></tr></thead><tbody>{items.map(t => <tr key={t.id}><td><Status status={t.status} /></td><td className="table-title"><Link href={`/tasks/${t.id}`}>{t.title}</Link><span className="mono short-id">{t.id.slice(0, 8)}</span></td><td>{t.projectKey ? <Link href={`/projects/${t.projectKey}`}>{t.projectName}</Link> : <span className="muted">—</span>}</td><td><span>{t.category}</span><span className="mono table-sub">{t.capability ?? 'category route'}</span></td><td className="mono">{t.worker ?? '—'}</td><td className="mono">{t.attempt || '—'}</td><td className="table-date"><LocalTime value={t.updatedAt} /></td></tr>)}</tbody></table></div>;
}
export function Pagination({ page, hasMore, base, params = {} }: { page: number; hasMore: boolean; base: string; params?: Record<string, string | undefined> }) {
  const url = (p: number) => { const q = new URLSearchParams(Object.entries(params).filter((pair): pair is [string, string] => !!pair[1])); q.set('page', String(p)); return `${base}?${q}`; };
  return <nav className="pagination" aria-label="Pagination"><span className="mono">Page {page}</span><div>{page > 1 ? <Link href={url(page - 1)}>Previous</Link> : <span aria-disabled="true">Previous</span>}{hasMore ? <Link href={url(page + 1)}>Next <ArrowRight size={13} /></Link> : <span aria-disabled="true">Next</span>}</div></nav>;
}
