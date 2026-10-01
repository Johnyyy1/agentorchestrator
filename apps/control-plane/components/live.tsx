'use client';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { duration } from '../../../src/control-plane/format.js';
import { providerSchema } from '../../../src/control-plane/contracts.js';
import { z } from 'zod';

const subscribeToHydration = () => () => {};
export function LocalTime({ value, timeOnly = false }: { value: string; timeOnly?: boolean }) {
  const hydrated = useSyncExternalStore(subscribeToHydration, () => true, () => false);
  const date = new Date(value);
  const label = hydrated ? new Intl.DateTimeFormat(undefined, timeOnly
    ? { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }
    : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date) : '—';
  return <time dateTime={value} title={date.toISOString()}>{label}</time>;
}
export function Elapsed({ start, end }: { start: string; end?: string | null }) {
  const [now, setNow] = useState(() => end ? new Date(end).getTime() : new Date(start).getTime());
  useEffect(() => {
    if (end) return;
    const tick = () => { if (!document.hidden) setNow(Date.now()); };
    tick(); const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [end]);
  return <span className="mono">{duration((end ? new Date(end).getTime() : now) - new Date(start).getTime())}</span>;
}
export function LiveRefresh({ active = false }: { active?: boolean }) {
  const router = useRouter();
  useEffect(() => {
    const refresh = () => {
      if (document.hidden || ['TEXTAREA', 'INPUT', 'SELECT'].includes(document.activeElement?.tagName ?? '')) return;
      router.refresh();
    };
    const timer = window.setInterval(refresh, active ? 4000 : 15000);
    document.addEventListener('visibilitychange', refresh);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', refresh); };
  }, [active, router]);
  return <span className="live-note"><span className="dot" />Live · {active ? '4' : '15'}s</span>;
}
const healthSchema = z.object({ dbAvailable: z.boolean(), providers: z.array(providerSchema) });
export function SystemStatus() {
  const [status, setStatus] = useState({ label: 'Checking system', tone: 'unknown' });
  useEffect(() => {
    let stopped = false, controller: AbortController | undefined;
    const check = async () => {
      if (document.hidden || controller) return;
      controller = new AbortController();
      const timeout = window.setTimeout(() => controller?.abort(), 45000);
      try {
        const response = await fetch('/api/providers', { signal: controller.signal, cache: 'no-store' });
        const health = healthSchema.parse(await response.json());
        const missing = health.providers.filter(p => p.status === 'unavailable').length;
        const unknown = health.providers.filter(p => p.status === 'unknown').length;
        if (!stopped) setStatus(!health.dbAvailable ? { label: 'Database offline', tone: 'failed' }
          : missing ? { label: `${missing} provider${missing > 1 ? 's' : ''} unavailable`, tone: 'waiting_human' }
          : unknown ? { label: `${unknown} provider${unknown > 1 ? 's' : ''} unverified`, tone: 'unknown' }
          : { label: 'Operational', tone: 'completed' });
      } catch { if (!stopped) setStatus({ label: 'System status unknown', tone: 'unknown' }); }
      finally { window.clearTimeout(timeout); controller = undefined; }
    };
    void check(); const timer = window.setInterval(() => void check(), 20000);
    return () => { stopped = true; controller?.abort(); window.clearInterval(timer); };
  }, []);
  return <Link href="/agents" className="system-status"><span className={`dot ${status.tone}`} />{status.label}</Link>;
}
