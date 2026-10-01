import Link from 'next/link';
import { z } from 'zod';
import { decisions, load } from '../../lib/server.js';
import { PageHeader, Section, DecisionRows, Empty, Pagination, SystemError } from '../../components/primitives.js';
import { LiveRefresh, LocalTime } from '../../components/live.js';
export const metadata = { title: 'Decisions' };
export default async function DecisionsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const parsed = z.coerce.number().int().min(1).max(100000).safeParse((await searchParams).page ?? 1);
  if (!parsed.success) return <p role="alert">Invalid page. <Link href="/decisions">Reset view</Link></p>;
  const result = await load(() => decisions(parsed.data));
  if (!result.ok) return <><LiveRefresh /><SystemError /></>;
  const d = result.data;
  return <><PageHeader eyebrow="HUMAN INPUT / 04" title="Decisions" description="Your guidance moves the work forward."><LiveRefresh active /></PageHeader><Section title="Open decisions"><DecisionRows items={d.items.filter(e => e.status === 'open')} /></Section>
    <Section title="Resolved / cancelled">{d.items.some(e => e.status !== 'open') ? <ul className="resolved-list">{d.items.filter(e => e.status !== 'open').map(e => <li key={e.id}><Link href={`/decisions/${e.id}`}><span className="mono muted">{e.status}</span><strong>{e.question}</strong><LocalTime value={e.resolvedAt ?? e.createdAt} /></Link></li>)}</ul> : <Empty title="No resolved decisions on this page." />}</Section><Pagination base="/decisions" page={d.page} hasMore={d.hasMore} /></>;
}
