import Link from 'next/link';
import { z } from 'zod';
import { notFound } from 'next/navigation';
import { task, load } from '../../../lib/server.js';
import { PageHeader, Status, SystemError } from '../../../components/primitives.js';
import { TaskDetail } from '../../../components/task-detail.js';
import { LiveRefresh } from '../../../components/live.js';
export default async function TaskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const result = await load(() => task(id));
  if (!result.ok) return <><LiveRefresh /><SystemError /></>;
  if (!result.data) notFound();
  const d = result.data;
  return <><Link href="/tasks" className="back-link">← All tasks</Link><PageHeader eyebrow={`${d.task.projectName ?? 'NO REPOSITORY'} / TASK`} title={d.task.title}><div className="task-header-state"><Status status={d.task.status} /><LiveRefresh active={['running', 'repairing', 'reviewing', 'queued'].includes(d.task.status)} /></div></PageHeader><TaskDetail detail={d} /></>;
}
