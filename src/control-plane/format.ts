// Shared pure formatting; timestamps are localized in client components only.
export function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}
export function statusLabel(status: string): string {
  return ({ waiting_human: 'Waiting for you', pending: 'Pending enqueue', repairing: 'Repairing', reviewing: 'Reviewing' } as Record<string, string>)[status]
    ?? status.charAt(0).toUpperCase() + status.slice(1).replaceAll('_', ' ');
}
