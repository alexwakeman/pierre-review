// REFRESH (docs/RELEASES.md § Releases tab 1, acceptance 6) — POST /api/releases/refresh.
//
// The READER'S PRESS that reads the check's tickets again NOW, not on the scan's TTL: every ticket the
// check holds by its OWN state (not Done, or unreadable) or is still waiting for (not read yet), at most
// REFRESH_TICKETS_MAX, in ONE batch (tracker/ticket-status.ts — Jira: one search per 100 keys; as Confirm
// does). Then the check is read again and returned.
// ⚠ The documented exception to "read when RECEIVED, never when VIEWED" (docs/TRACKERS.md § Releases):
// a button press, never a view or a mount. Rate-limit tier `search` (the customer's tracker quota).
import type { ReleaseCheckResult, ReleasesRefreshResponse } from '@pierre-review/shared';
import { getReleases } from '../db/release-check.js';
import { defaultReleaseWriteDeps, type ReleaseWriteDeps } from './create.js';

export const REFRESH_TICKETS_MAX = 500;

/** The tickets Refresh reads again: held by their own state or not read yet, by key, capped. Pure. */
export function ticketsToRefresh(result: ReleaseCheckResult, cap = REFRESH_TICKETS_MAX): Array<{ ident: string; key: string }> {
  const out: Array<{ ident: string; key: string }> = [];
  for (const t of [...result.tickets].sort((a, b) => a.key.localeCompare(b.key))) {
    if (out.length >= cap) break;
    if (t.blocker == null && !t.pending) continue;
    out.push({ ident: t.ident, key: t.key });
  }
  return out;
}

export async function refreshReleases(
  accountId: number,
  rawWorkspace: string | number | undefined | null,
  deps: Pick<ReleaseWriteDeps, 'rereadTickets'> = defaultReleaseWriteDeps(),
): Promise<ReleasesRefreshResponse> {
  const before = await getReleases(accountId, rawWorkspace);
  if (before.check == null) return { ...before, reread: 0, unread: [] };
  const todo = ticketsToRefresh(before.check);
  const answered = todo.length > 0 ? await deps.rereadTickets(accountId, before.workspaceId, todo) : new Set<string>();
  const unread = todo.filter((t) => !answered.has(t.ident)).map((t) => t.key);
  const after = await getReleases(accountId, before.workspaceId);
  return { ...after, reread: todo.length - unread.length, unread: unread.sort() };
}
