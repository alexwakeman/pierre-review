// The header sync button's tooltip lines about freshness (components/SyncStatus.tsx).
//
// Two different facts, never merged:
//   • "Last checked" — when GitHub last answered for any repo (`Repo.lastCheckedAt`: a free change
//     probe, a scheduled walk or a settle read). The server checks active repos every ~20s and
//     walks a repo only when something changed, so this is what says the data is current.
//   • "Last synced" — when new data was last pulled (the newest walk). On a quiet workspace it can
//     be hours old while the repos were checked seconds ago, which is why it is not the only line.
// No countdown: each repo has its own cadence, so there is no single "next sync" to promise.
import type { Repo } from '@pierre-review/shared';

/** The newest of an ISO field across repos, or null. ISO strings sort as times. */
function newest(repos: readonly Repo[], pick: (r: Repo) => string | null | undefined): string | null {
  let latest: string | null = null;
  for (const r of repos) {
    const t = pick(r);
    if (t && (!latest || t > latest)) latest = t;
  }
  return latest;
}

/** The newest completed walk across repos (incremental, else the first full sync). */
export function mostRecentSync(repos: readonly Repo[]): string | null {
  return newest(repos, (r) => r.lastIncrementalSyncAt ?? r.lastFullSyncAt);
}

/** The newest time GitHub answered for any repo, or null (a restarted server, the demo). */
export function mostRecentCheck(repos: readonly Repo[]): string | null {
  return newest(repos, (r) => r.lastCheckedAt);
}

const hhmm = (d: Date): string =>
  d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** The freshness lines of the tooltip. */
export function syncTooltip(lastSync: string | null, lastCheck: string | null): string {
  const lines: string[] = [];
  if (lastCheck) lines.push(`Last checked ${hhmm(new Date(lastCheck))}`);
  if (lastSync) lines.push(`Last synced ${hhmm(new Date(lastSync))}`);
  lines.push('Checks GitHub for changes automatically');
  return lines.join('\n');
}
