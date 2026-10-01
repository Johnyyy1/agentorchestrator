import { z } from 'zod';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { decision, load } from '../../../lib/server.js';
import { PageHeader, Status, SystemError } from '../../../components/primitives.js';
import { DecisionPanel } from '../../../components/commands.js';
import { LiveRefresh, LocalTime } from '../../../components/live.js';
export default async function DecisionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const result = await load(() => decision(id));
  if (!result.ok) return <><LiveRefresh /><SystemError /></>;
  if (!result.data) notFound();
  const e = result.data;
  return <div className="decision-detail"><Link href="/decisions" className="back-link">← Decision inbox</Link><PageHeader eyebrow={`${e.projectName ?? 'NO REPOSITORY'} / ${e.reasonType.replaceAll('_', ' ')}`} title="Your decision is needed"><LiveRefresh active={e.status === 'open'} /></PageHeader>
    <div className="decision-context"><span className="eyebrow">{e.status.toUpperCase()} · <LocalTime value={e.createdAt} /></span><h2>{e.question}</h2><p>{e.summary}</p><Link href={`/tasks/${e.taskId}`}>{e.taskTitle}</Link><div className="decision-task-status"><Status status={e.taskStatus} /><span className="mono">{e.taskId.slice(0, 8)}</span></div></div><DecisionPanel entry={e} /></div>;
}
