import { providers, load } from '../../lib/server.js';
import { PageHeader, Status, SystemError } from '../../components/primitives.js';
import { LiveRefresh, LocalTime } from '../../components/live.js';
import { ArrowUpRight } from 'lucide-react';
import Link from 'next/link';
export const metadata = { title: 'Agents' };
export default async function AgentsPage() {
  const result = await load(providers);
  if (!result.ok) return <><LiveRefresh /><SystemError /></>;
  const d = result.data;
  return <><PageHeader eyebrow="EXECUTION / 05" title="Agents" description="Configured lanes, readiness and recorded use."><LiveRefresh /></PageHeader>{!d.dbAvailable && <SystemError />}
    <div className="provider-list">{d.providers.map((p, i) => <section key={p.id} className="provider-row"><div className="provider-index mono">0{i + 1}</div><div className="provider-description"><div className="provider-heading"><h2>{p.name}</h2><Status status={p.status} /></div><div className="provider-model mono">{p.provider} <span>/</span> {p.model ?? 'Model not reported by readiness'}</div><p>{p.reason}</p><span className="provider-check">Checked <LocalTime value={p.checkedAt} /></span></div><div className="provider-stats"><div><span>Recent uses</span><strong className="mono">{d.dbAvailable ? p.recentRuns : '—'}</strong></div><div><span>Success / failure</span><strong className="mono">{d.dbAvailable ? `${p.successes} / ${p.failures}` : '—'}</strong></div><div><span>Last success</span>{p.lastSuccess ? <LocalTime value={p.lastSuccess} /> : <span className="muted">Not recorded</span>}</div><div><span>Last failure</span>{p.lastFailure ? <LocalTime value={p.lastFailure} /> : <span className="muted">Not recorded</span>}</div><p>{p.statsNote}</p></div></section>)}</div>
    <div className="health-notes"><span className="eyebrow">READINESS, WITHOUT INFERENCE</span><p>Local checks inspect the model inventory and execution prerequisites. Cloud lanes only check for an executable CLI; authentication stays unknown until an actual invocation.</p><p>Readiness is cached for 20 seconds. These checks never send a prompt, download a model or expose credentials.</p><Link href="/tasks">Inspect recorded runs <ArrowUpRight size={14} /></Link></div></>;
}
