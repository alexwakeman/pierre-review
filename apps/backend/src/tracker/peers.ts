import { createHash } from 'node:crypto';
import { and, desc, eq, gte, isNotNull } from 'drizzle-orm';
import {
  isTrackerIdent,
  parseTicketIdent,
  trackerTicketIdent,
  trackerTicketRow,
  type ClaudeReviewTicket,
  type ParsedTrackerIdent,
  type TrackerProvider,
} from '@pierre-review/shared';
import type { TrackerContext } from './context.js';
import { resolvePrTickets, storyFromRow } from './stories.js';
import { hasContent, type StoredTicketRow } from './store.js';

// TICKET PEERS — the tracker's half of core's TICKET REVIEW (one review per ticket, across every PR
// that names it; review/ticket-review/). Moved from the plugin (jira/ticket-peers.ts) at apiVersion
// 23; the review reads it through ./ticket-source.ts. Provider-NEUTRAL: membership is the stored
// rows sharing (provider, root, key), the ident is `<provider>:<root>#<KEY>`.
//
//   ticketsForPr(account, pr)          the PR's readable detected tickets as review stories. STORED
//                                      ROWS ONLY — callers are view paths (the PR pane, Open PRs'
//                                      states, the sweeper's tick).
//   ticketStory(account, ident)        THE story: the FRESHEST stored row across every PR on it
//                                      (newest `fetched_at`, then highest id). ⚠ ONE answer for every
//                                      caller — the run, the sweeper and the states route all hash
//                                      it. "The first member's row" gave each caller a different
//                                      text: the worker refreshes OPEN PRs only, so a merged PR's row
//                                      keeps the text it merged with.
//   ticketMembers(account, ident)      every PR on that ticket: this account, the SAME site, ANY
//                                      workspace, state 'ok'. Merged PRs stay; core decides open /
//                                      merged / closed from `pull_requests`.
//   listChangedTicketIdents(account, since)
//                                      tickets whose membership or story text moved since then
//                                      (`changed_at`, kept by ./store.ts).
//
// Every read predicates on accountId. ⚠ NEVER THROWS to its caller: a failure is "nothing known".

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/** sha256(title | description | criteria). Core recomputes it (fingerprint.ts); informational here. */
export function storyHash(t: Pick<ClaudeReviewTicket, 'title' | 'description' | 'acceptanceCriteria'>): string {
  return sha256([t.title ?? '', t.description ?? '', t.acceptanceCriteria ?? ''].join('\u0000'));
}

function codeOf(err: unknown): string {
  return err instanceof Error && 'code' in err ? String((err as { code: unknown }).code) : 'unknown';
}

export async function ticketsForPr(
  ctx: TrackerContext,
  accountId: number,
  prId: number,
): Promise<Array<{ ident: string; ticket: ClaudeReviewTicket; ticketHash: string }>> {
  const r = await resolvePrTickets(ctx, accountId, prId, { logLabel: 'ticket review', storedOnly: true });
  if (r == null) return [];
  return r.tickets.map((t) => ({
    ident: trackerTicketIdent(t.provider, t.apiRoot, t.key),
    ticket: t.ticket,
    ticketHash: storyHash(t.ticket),
  }));
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Readable rows of ONE ticket: this account, the same provider + site + key, state 'ok'. The
 *  ident → row identity goes through shared `trackerTicketRow` (a GitHub ident names its repository
 *  in the root; the row stores it in the key). */
function identWhere(t: any, accountId: number, parsed: ParsedTrackerIdent) {
  const row = trackerTicketRow(parsed);
  return and(
    eq(t.accountId, accountId),
    eq(t.provider, row.provider),
    eq(t.apiRoot, row.apiRoot),
    eq(t.issueKey, row.issueKey),
    eq(t.state, 'ok'),
    isNotNull(t.fetchedAt),
  );
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export async function ticketStory(
  ctx: TrackerContext,
  accountId: number,
  ident: string,
): Promise<ClaudeReviewTicket | null> {
  const parsed = parseTicketIdent(ident);
  if (!isTrackerIdent(parsed)) return null;
  try {
    const t = ctx.schema.trackerTickets;
    const rows = (await ctx.db
      .select()
      .from(t)
      .where(identWhere(t, accountId, parsed))
      .orderBy(desc(t.fetchedAt), desc(t.id))
      .execute()) as StoredTicketRow[];
    for (const row of rows) {
      if (!hasContent(row)) continue;
      const checked = storyFromRow(row, row.url !== '' ? row.url : undefined, new Date(0).toISOString());
      if (checked.ok && checked.ticket) return checked.ticket;
    }
    return null;
  } catch (err) {
    ctx.log.warn({ accountId, code: codeOf(err) }, 'ticket review: ticket story not read');
    return null;
  }
}

export async function ticketMembers(
  ctx: TrackerContext,
  accountId: number,
  ident: string,
): Promise<Array<{ prId: number; workspaceId: number }>> {
  const parsed = parseTicketIdent(ident);
  if (!isTrackerIdent(parsed)) return [];
  try {
    const t = ctx.schema.trackerTickets;
    const rows = (await ctx.db
      .select({ prId: t.prId, workspaceId: t.workspaceId })
      .from(t)
      .where(identWhere(t, accountId, parsed))
      .execute()) as Array<{ prId: number; workspaceId: number }>;
    const seen = new Set<number>();
    return rows
      .filter((r) => (seen.has(r.prId) ? false : (seen.add(r.prId), true)))
      .sort((a, b) => a.prId - b.prId);
  } catch (err) {
    ctx.log.warn({ accountId, code: codeOf(err) }, 'ticket review: ticket members not read');
    return [];
  }
}

export async function listChangedTicketIdents(
  ctx: TrackerContext,
  accountId: number,
  sinceMs: number,
): Promise<string[]> {
  try {
    const t = ctx.schema.trackerTickets;
    const rows = (await ctx.db
      .select({ provider: t.provider, apiRoot: t.apiRoot, issueKey: t.issueKey })
      .from(t)
      .where(and(eq(t.accountId, accountId), gte(t.changedAt, new Date(sinceMs))))
      .execute()) as Array<{ provider: TrackerProvider; apiRoot: string; issueKey: string }>;
    return [...new Set(rows.map((r) => trackerTicketIdent(r.provider, r.apiRoot, r.issueKey)))].sort();
  } catch (err) {
    ctx.log.warn({ accountId, code: codeOf(err) }, 'ticket review: changed tickets not read');
    return [];
  }
}
