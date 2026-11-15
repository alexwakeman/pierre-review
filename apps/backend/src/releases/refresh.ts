// REFRESH (docs/RELEASES.md § Releases tab 1, acceptance 6) — POST /api/releases/refresh.
//
// The tracker worker never re-reads a MERGED PR's ticket on a TTL (missing-only, tracker/worker.ts),
// so a ticket moved to Done after its PRs merged would hold its version tag for good. Refresh is the
// READER'S PRESS that reads those tickets again: every ticket the check holds by its OWN state (not
// Done, or unreadable) or is still waiting for (not read yet), at most REFRESH_TICKETS_MAX, through the worker's own
// path (`syncOnePrNow`, force: true — as Confirm does). Then the check is read again and returned.
// ⚠ The documented exception to "read when RECEIVED, never when VIEWED" (docs/TRACKERS.md § Releases):
// a button press, never a view or a mount. Rate-limit tier `search` (the customer's tracker quota).
import type { ReleaseCheckResult, ReleasesRefreshResponse } from '@pierre-review/shared';
import { getReleases } from '../db/release-check.js';
import { defaultReleaseWriteDeps, type ReleaseWriteDeps } from './create.js';

export const REFRESH_TICKETS_MAX = 30;
const REFRESH_CONCURRENCY = 4;

/** The tickets Refresh reads again: held by their own state or not read yet, by key, capped. Pure. */
export function ticketsToRefresh(result: ReleaseCheckResult, cap = REFRESH_TICKETS_MAX): Array<{ ident: string; key: string; prIds: number[] }> {
  const out: Array<{ ident: string; key: string; prIds: number[] }> = [];
  for (const t of [...result.tickets].sort((a, b) => a.key.localeCompare(b.key))) {
    if (out.length >= cap) break;
    if (t.blocker == null && !t.pending) continue;
    const prIds = [...new Set(t.repos.flatMap((r) => r.prIds))];
    for (const p of result.prs) if (p.ticketIdents.includes(t.ident) && !prIds.includes(p.id)) prIds.push(p.id);
    if (prIds.length === 0) continue;
    out.push({ ident: t.ident, key: t.key, prIds });
  }
  return out;
}

export async function refreshReleases(
  accountId: number,
  rawWorkspace: string | number | undefined | null,
  deps: Pick<ReleaseWriteDeps, 'rereadTicket'> = defaultReleaseWriteDeps(),
): Promise<ReleasesRefreshResponse> {
  const before = await getReleases(accountId, rawWorkspace);
  if (before.check == null) return { ...before, reread: 0, unread: [] };
  const todo = ticketsToRefresh(before.check);
  const unread: string[] = [];
  let reread = 0;
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(REFRESH_CONCURRENCY, todo.length) }, async () => {
      while (next < todo.length) {
        const t = todo[next++]!;
        if (await deps.rereadTicket(accountId, t)) reread += 1;
        else unread.push(t.key);
      }
    }),
  );
  const after = await getReleases(accountId, before.workspaceId);
  return { ...after, reread, unread: unread.sort() };
}
