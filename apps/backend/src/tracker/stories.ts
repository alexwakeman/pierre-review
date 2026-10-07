import { and, eq } from 'drizzle-orm';
import {
  CLAUDE_REVIEW_MAX_TICKETS,
  CLAUDE_REVIEW_TICKET_LIMITS,
  checkClaudeReviewTicket,
  type ClaudeReviewTicket,
  type TrackerProvider,
} from '@pierre-review/shared';
import type { TrackerContext } from './context.js';
import { detectPrTickets } from './enricher.js';
import { ticketUrl } from './registry.js';
import { prepareTrackerCall } from './calls.js';
import { githubAccessFor } from './context.js';
import { prLinkColumns, withParsedLinks } from './enricher.js';
import { trackerBaseUrl } from './settings.js';
import type { JiraTransport } from './jira/fetch.js';
import { hasContent, readStoredTickets, type StoredTicketRow } from './store.js';
import { syncOnePrNow } from './worker.js';

// A PR's tickets AS REVIEW STORIES — the stored rows (./store.ts) turned into the clipped, validated
// `ClaudeReviewTicket` the ticket review judges. Moved from the plugin (jira/resolve-ticket.ts) at
// apiVersion 23. (The plugin's `resolveAutoReviewTicket` — the AUTO PR review's story fill — is NOT
// here: since the ticket review split a PR review checks no story and nothing called it.)
//
//   - EVERY key detection found, in its order, up to CLAUDE_REVIEW_MAX_TICKETS, through the ONE
//     detection path (`detectPrTickets`), so a saved token still reads only tickets this
//     workspace's PRs name. One ticket failing skips that ticket only;
//   - each field CUT to its review cap rather than refused (nobody is there to trim for a server-side
//     reader); characters the validator refuses (C0 controls, lone surrogates) are dropped.
//
// ⚠ IT NEVER THROWS. Any failure is `null` / an empty list. Logs carry account + workspace + the
// error CODE only: never the tracker's body, the URL or the token.

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const LONE_SURROGATES = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Trim, drop unstorable characters, then cut to `cap` without splitting a surrogate pair. */
export function clipTicketField(value: string, cap: number): string {
  let s = value.replace(CONTROL_CHARS, '').replace(LONE_SURROGATES, '').trim();
  if (s.length > cap) {
    s = s.slice(0, cap);
    if (/[\uD800-\uDBFF]$/.test(s)) s = s.slice(0, -1);
    s = s.trimEnd();
  }
  return s;
}

/** One readable detected ticket of a PR, with the site it was read from. */
export interface ResolvedPrTicket {
  provider: TrackerProvider;
  key: string;
  apiRoot: string;
  ticket: ClaudeReviewTicket;
}

/** One stored row as a clipped, validated review story (the ONE recipe every caller shares). */
export function storyFromRow(
  row: StoredTicketRow,
  url: string | undefined,
  fallbackFetchedAt: string,
): ReturnType<typeof checkClaudeReviewTicket> {
  const L = CLAUDE_REVIEW_TICKET_LIMITS;
  return checkClaudeReviewTicket({
    title: clipTicketField(row.title ?? '', L.titleChars),
    description: clipTicketField(row.description ?? '', L.descriptionChars),
    acceptanceCriteria: clipTicketField(row.acceptanceCriteria ?? '', L.acceptanceCriteriaChars),
    // `ClaudeReviewTicketSource` 'jira' means "read from the TRACKER" (key + link + read time), for
    // every reading provider — GitHub Issues included; the key and link say which tracker. Widening
    // the union would move a wire type the plugin and the SPA both read for no behaviour change.
    source: 'jira',
    key: row.issueKey,
    url,
    fetchedAt: row.fetchedAt != null ? new Date(row.fetchedAt).toISOString() : fallbackFetchedAt,
  });
}

interface PrRow {
  id: number;
  repoId: number;
  title: string | null;
  headRefName: string | null;
  closingIssues: string[] | null;
  linearLinks: string[] | null;
  linearLinksRoot: string | null;
}

/** This account's PR, or null (another tenant's id → null → 404 at the route). */
export async function ownedPr(ctx: TrackerContext, accountId: number, prId: number): Promise<PrRow | null> {
  const t = ctx.schema.pullRequests;
  const rows = (await ctx.db
    .select({ id: t.id, repoId: t.repoId, title: t.title, headRefName: t.headRefName, ...prLinkColumns(t) })
    .from(t)
    .where(and(eq(t.id, prId), eq(t.accountId, accountId)))
    .limit(1)
    .execute()) as PrRow[];
  const row = rows[0];
  return row != null ? withParsedLinks(row) : null;
}

/**
 * Every detected ticket of a PR that can be read, as a clipped, validated story, in detection
 * order, at most CLAUDE_REVIEW_MAX_TICKETS. `first` is the first DETECTED key, readable or not.
 * ⚠ NEVER THROWS — null on any failure.
 *
 * `storedOnly`: never read the tracker — a detected key with no stored row is skipped. Every VIEW
 * path (the ticket review's seam) passes it: a tracker is read when a PR is RECEIVED, never viewed.
 */
export async function resolvePrTickets(
  ctx: TrackerContext,
  accountId: number,
  prId: number,
  opts: { transport?: JiraTransport; nowMs?: number; logLabel?: string; storedOnly?: boolean } = {},
): Promise<{ first: string | null; tickets: ResolvedPrTicket[] } | null> {
  const label = opts.logLabel ?? 'ticket review';
  let workspaceId: number | null = null;
  try {
    const pr = await ownedPr(ctx, accountId, prId);
    if (pr == null) return null;
    const found = await detectPrTickets(ctx, accountId, pr);
    if (found == null) return null;
    workspaceId = found.workspaceId;
    const keys = found.keys.slice(0, CLAUDE_REVIEW_MAX_TICKETS);
    const first = keys[0] ?? null;
    if (first == null) return null;
    const prepared = prepareTrackerCall(found.access, {
      cloud: ctx.host.isCloud,
      transport: opts.transport,
      github: githubAccessFor(ctx, accountId),
    });
    if (!prepared.ok) {
      ctx.log.info({ accountId, workspaceId, prId, code: prepared.error }, `${label}: no ticket read`);
      return { first, tickets: [] };
    }
    const { provider, apiRoot } = prepared.call;
    const usable = async () =>
      (await readStoredTickets(ctx, accountId, [prId])).filter((r) => r.apiRoot === apiRoot && r.provider === provider);
    let rows = await usable();
    const unread = keys.filter((k) => !rows.some((r) => r.issueKey === k));
    if (unread.length > 0 && !opts.storedOnly) {
      await syncOnePrNow(ctx, accountId, prId, unread, {
        force: false,
        transport: opts.transport,
        now: opts.nowMs != null ? () => opts.nowMs! : undefined,
      });
      rows = await usable();
    }
    const trackerBase = trackerBaseUrl(found.access.issue);
    const trackerProvider = found.access.issue.provider;
    const fetchedAt = new Date(opts.nowMs ?? Date.now()).toISOString();
    const tickets: ResolvedPrTicket[] = [];
    for (const key of keys) {
      const row = rows.find((r) => r.issueKey === key);
      if (row == null || !hasContent(row)) {
        // ⚠ NOT `{ err }` — the stored CODE only, never the tracker's body.
        ctx.log.warn(
          { accountId, workspaceId, prId, code: row?.errorCode ?? 'not_read' },
          `${label}: ticket not readable`,
        );
        continue;
      }
      const checked = storyFromRow(
        row,
        trackerProvider && trackerBase ? ticketUrl(trackerProvider, trackerBase, row.issueKey) : undefined,
        fetchedAt,
      );
      if (!checked.ok) {
        ctx.log.warn({ accountId, workspaceId, prId, code: 'invalid_ticket', field: checked.field }, `${label}: ticket not usable`);
        continue;
      }
      // Two detected keys can answer as ONE issue (Jira follows a moved key): the stored rows are
      // then identical in content, and the story is kept once.
      const same = (t: ClaudeReviewTicket): boolean =>
        t.key === checked.ticket!.key ||
        (t.title === checked.ticket!.title &&
          t.description === checked.ticket!.description &&
          t.acceptanceCriteria === checked.ticket!.acceptanceCriteria);
      if (checked.ticket && !tickets.some((t) => same(t.ticket))) {
        tickets.push({ provider, key: row.issueKey, apiRoot, ticket: checked.ticket });
      }
    }
    return { first, tickets };
  } catch (err) {
    const code = err instanceof Error && 'code' in err ? String((err as { code: unknown }).code) : 'unknown';
    // ⚠ NOT `{ err }` — never serialise the error object on a tracker path.
    ctx.log.warn({ accountId, workspaceId, prId, code }, `${label}: tracker request failed`);
    return null;
  }
}
