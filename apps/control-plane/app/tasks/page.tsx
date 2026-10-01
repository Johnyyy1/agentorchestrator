import { tasks, projects, load, parseTaskQuery } from '../../lib/server.js';
import { categories, statuses, workers } from '../../../../src/control-plane/contracts.js';
import { statusLabel } from '../../../../src/control-plane/format.js';
import { PageHeader, TaskTable, Pagination, SystemError } from '../../components/primitives.js';
import { LiveRefresh } from '../../components/live.js';
import Link from 'next/link';
export const metadata = { title: 'Tasks' };
export default async function TasksPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const input = await searchParams;
  let query;
  try { query = parseTaskQuery(input); } catch { return <><PageHeader eyebrow="WORK / 03" title="Tasks" /><p role="alert">Invalid task filters. <Link href="/tasks">Reset filters</Link></p></>; }
  const result = await load(async () => { const [list, repositories] = await Promise.all([tasks(query), projects()]); return { list, repositories }; });
  if (!result.ok) return <><LiveRefresh /><SystemError /></>;
  const { list, repositories } = result.data;
  return <><PageHeader eyebrow="WORK / 03" title="Tasks" description={`${list.total} task${list.total === 1 ? '' : 's'} in this view. Every attempt leaves a trace.`}><LiveRefresh active={list.items.some(t => ['running', 'repairing', 'reviewing'].includes(t.status))} /></PageHeader>
    <form method="get" className="filters"><div className="search-field"><label htmlFor="q">Search tasks</label><input id="q" name="q" type="search" defaultValue={query.q} placeholder="Title, objective or task ID" maxLength={200} /></div>
      <div><label htmlFor="status">Status</label><select id="status" name="status" defaultValue={query.status ?? ''}><option value="">All statuses</option><option value="active">Active (run / repair / review)</option><option value="attention">Needs inspection (failed / pending)</option>{statuses.map(s => <option key={s} value={s}>{statusLabel(s)}</option>)}</select></div>
      <div><label htmlFor="category">Category</label><select id="category" name="category" defaultValue={query.category ?? ''}><option value="">All categories</option>{categories.map(s => <option key={s}>{s}</option>)}</select></div>
      <div><label htmlFor="worker">Worker</label><select id="worker" name="worker" defaultValue={query.worker ?? ''}><option value="">Any attempt</option>{workers.map(s => <option key={s}>{s}</option>)}</select></div>
      <div><label htmlFor="project">Repository</label><select id="project" name="project" defaultValue={query.project ?? ''}><option value="">All repositories</option>{repositories.map(p => <option key={p.key} value={p.key}>{p.name}</option>)}</select></div>
      <div><label htmlFor="sort">Sort</label><select id="sort" name="sort" defaultValue={query.sort}><option value="updated">Updated</option><option value="newest">Newest</option><option value="status">Status</option></select></div><button className="button" type="submit">Apply</button><Link href="/tasks" className="filter-reset">Reset</Link>
    </form><TaskTable items={list.items} /><Pagination page={list.page} hasMore={list.page * list.pageSize < list.total} base="/tasks" params={{ q: query.q, status: query.status, category: query.category, worker: query.worker, project: query.project, sort: query.sort }} /></>;
}
