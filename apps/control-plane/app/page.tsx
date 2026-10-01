import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';
import { overview, projects, load } from '../lib/server.js';
import { PageHeader, Section, TaskRows, DecisionRows, ActivityRows, SystemError } from '../components/primitives.js';
import { CommandBar } from '../components/commands.js';
import { LiveRefresh } from '../components/live.js';
export default async function OverviewPage() {
  const result = await load(async () => { const [data, repositories] = await Promise.all([overview(), projects()]); return { data, repositories }; });
  if (!result.ok) return <><LiveRefresh /><SystemError /></>;
  const { data, repositories } = result.data;
  return <><PageHeader eyebrow="CONTROL / 01" title="Overview" description="A clear view of the work in motion."><LiveRefresh active /></PageHeader><CommandBar projects={repositories} />
    <div className="metrics"><Link href="/tasks?status=active"><span>Running <span className="muted">/ repair / review</span></span><strong>{data.counts.running.toString().padStart(2, '0')}</strong></Link><Link href="/tasks?status=queued"><span>Queued</span><strong>{data.counts.queued.toString().padStart(2, '0')}</strong></Link><Link href="/decisions" className={data.counts.waiting ? 'metric-attention' : ''}><span>Waiting for you</span><strong>{data.counts.waiting.toString().padStart(2, '0')}</strong></Link><Link href="/tasks?status=failed"><span>Failed <span className="muted">/ retained history</span></span><strong>{data.counts.failed.toString().padStart(2, '0')}</strong></Link></div>
    {data.counts.pending > 0 && <p className="pending-note"><Link href="/tasks?status=pending">{data.counts.pending} task{data.counts.pending > 1 ? 's' : ''} persisted but awaiting enqueue. Inspect queue health <ArrowUpRight size={14} /></Link></p>}
    <div className="overview-columns"><div><Section title="Active" count={data.counts.running} href="/tasks"><TaskRows items={data.active} /></Section><Section title="Up next" count={data.counts.queued} href="/tasks?status=queued"><TaskRows items={data.queued} empty="The queue is clear." /></Section></div><div><Section title="Needs your decision" count={data.counts.waiting} href="/decisions" className="attention-section"><DecisionRows items={data.decisions} /></Section><div className="operator-note"><span className="eyebrow">YOU SET THE DIRECTION</span><p>Agents work within bounded attempts. Ambiguities and review findings come back to you.</p><Link href="/agents">Inspect providers <ArrowUpRight size={14} /></Link></div></div></div>
    {data.failures.length > 0 && <Section title="Requires attention" count={data.counts.failed + data.counts.pending} href="/tasks?status=attention"><TaskRows items={data.failures} /></Section>}
    <Section title="Recent activity" href="/activity"><ActivityRows items={data.activity} /></Section>
  </>;
}
