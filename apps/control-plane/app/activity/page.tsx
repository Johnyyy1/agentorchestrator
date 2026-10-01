import Link from 'next/link';
import { z } from 'zod';
import { activity, load } from '../../lib/server.js';
import { PageHeader, ActivityRows, Pagination, SystemError } from '../../components/primitives.js';
import { LiveRefresh } from '../../components/live.js';
export const metadata = { title: 'Activity' };
export default async function ActivityPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const parsed = z.object({ page: z.coerce.number().int().min(1).max(100000).default(1), project: z.string().regex(/^[a-f0-9]{24}$/).optional() }).safeParse(await searchParams);
  if (!parsed.success) return <p role="alert">Invalid activity filters. <Link href="/activity">Reset view</Link></p>;
  const result = await load(() => activity(parsed.data.page, parsed.data.project));
  if (!result.ok) return <><LiveRefresh /><SystemError /></>;
  const d = result.data;
  return <><PageHeader eyebrow="AUDIT / 06" title="Activity" description="The recorded sequence of orchestration decisions and outcomes."><LiveRefresh /></PageHeader><ActivityRows items={d.items} /><Pagination page={d.page} hasMore={d.hasMore} base="/activity" params={{ project: parsed.data.project }} /><p className="page-note">Audit events and persisted task, run and review records appear here. Older flows without audit events use explicit record labels.</p></>;
}
