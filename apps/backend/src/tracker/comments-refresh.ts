import { isTrackerIdent, parseTicketIdent, trackerTicketRow } from '@pierre-review/shared';
import { githubAccessFor, type TrackerContext } from './context.js';
import { prepareTrackerCall } from './calls.js';
import { maybeAdapterFor } from './registry.js';
import { readWorkspaceTrackerRow, trackerAccessOf } from './settings.js';
import { writeTicketComments } from './comments.js';
import { accessFingerprint, isBackedOff } from './worker.js';
import type { JiraTransport } from './jira/fetch.js';

// THE COMMENTS-ONLY RE-READ AT A STORY CHECK (docs/TRACKERS.md § Ticket comments → Fresh at every
// check). Every story check (ticket review) — manual, automatic, sprint-refresh-started — reads the
// ticket from the tracker once before it runs and stores ONLY ITS COMMENTS (`writeTicketComments`).
// The run is the reader's, never a view: the same exception a PR review run's open-points re-read makes.
//
//   • COMMENTS ONLY. The answer's story text, status and fields are thrown away: a merged ticket's
//     story stays as it merged (it is in the fingerprint — moving it would re-bill), and an open
//     ticket's story is the worker's job. So a comment never moves `changed_at` or the story hash.
//   • ONE READ PER TICKET PER COMMENTS_FRESH_MS (in memory, per account + ticket): the halves of a run,
//     the sweeper's next check and a quick manual re-check share it.
//   • The workspace's tracker call: the first of `workspaceIds` whose tracker is THIS ticket's site.
//     A workspace in the worker's backoff is not read (its stored comments stand).
//   • ⚠ NEVER THROWS and never fatal: a failed read keeps the stored comments (`fresh: false`).
//   • ⚠ NO TRANSACTION: the network read happens before the one write, outside any.

export const COMMENTS_FRESH_MS = 2 * 60_000;

const lastRead = new Map<string, number>();

export function _resetCommentsRefreshForTest(): void {
  lastRead.clear();
}

export interface CommentsRefreshResult {
  /** The comments were read from the tracker now, or within COMMENTS_FRESH_MS. */
  fresh: boolean;
  /** Why not, in one word (logged, never shown): 'not_tracker' | 'no_call' | 'backed_off' | 'failed'. */
  skipped?: string;
}

export async function refreshTicketComments(
  ctx: TrackerContext,
  accountId: number,
  ident: string,
  workspaceIds: readonly number[],
  opts: { nowMs?: number; transport?: JiraTransport } = {},
): Promise<CommentsRefreshResult> {
  const parsed = parseTicketIdent(ident);
  if (!isTrackerIdent(parsed)) return { fresh: false, skipped: 'not_tracker' };
  const row = trackerTicketRow(parsed);
  const now = opts.nowMs ?? Date.now();
  const memo = `${accountId}|${ident}`;
  const prev = lastRead.get(memo);
  if (prev != null && now - prev < COMMENTS_FRESH_MS) return { fresh: true };
  let workspaceId: number | null = null;
  try {
    for (const ws of [...new Set(workspaceIds)]) {
      const access = trackerAccessOf(ctx.host, await readWorkspaceTrackerRow(ctx, accountId, ws));
      const reader = maybeAdapterFor(access.issue.provider)?.reader;
      if (reader == null) continue;
      const prepared = prepareTrackerCall(access, { transport: opts.transport, github: githubAccessFor(ctx, accountId) });
      if (!prepared.ok || prepared.call.provider !== row.provider || prepared.call.apiRoot !== row.apiRoot) continue;
      workspaceId = ws;
      if (isBackedOff(accountId, ws, accessFingerprint(prepared.call), now)) return { fresh: false, skipped: 'backed_off' };
      const issue = await reader.fetchTicket(prepared.call, row.issueKey);
      // `undefined` (the answer carried no comments) writes nothing: the stored ones stand.
      await writeTicketComments(ctx, accountId, row, issue.comments, new Date(now));
      lastRead.set(memo, now);
      return { fresh: issue.comments !== undefined };
    }
    return { fresh: false, skipped: 'no_call' };
  } catch (err) {
    const code = err instanceof Error && 'code' in err ? String((err as { code: unknown }).code) : 'unknown';
    // ⚠ NOT `{ err }` — never serialise the error object on a tracker path.
    ctx.log.warn({ accountId, workspaceId, code, route: 'ticket-comments-refresh' }, 'ticket comments not read again; using the stored copy');
    return { fresh: false, skipped: 'failed' };
  }
}
