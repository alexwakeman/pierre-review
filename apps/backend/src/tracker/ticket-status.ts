// BATCHED TICKET STATUS READS (docs/TRACKERS.md § Batched status reads) — the release scan and the
// release Refresh / Confirm read the STATUS of many tickets at once, with no PR in hand, into
// `tracker_ticket_status` (one row per (account, workspace, ident)). The release check
// (db/release-check.ts) reads those rows beside the PR rows and the sprint rows; the freshest
// successful read wins, and Done is decided by THE This Sprint stage resolver as everywhere.
//
//   • ONE credential path: the workspace's tracker access and `prepareTrackerCall` (the sealed token).
//   • A reader with `readStatuses` (Jira: one search per 100 keys) reads them in bulk; keys it could
//     not name (`missing`) and every key of a reader without one (Linear, GitHub Issues, Notion) are
//     read ONE BY ONE through the reader's `fetchTicket`, at most PER_TICKET_READS_MAX per call,
//     PER_TICKET_CONCURRENCY at a time — the rest wait for the next scan.
//   • not found / no access are statements about the ticket (listed for the reader, never a block); a
//     failure is retried and shown as checking until RELEASE_TICKET_FAILS_MAX reads in a row failed,
//     then listed as "could not be read" (it stops blocking).
//   • Read when the scan RECEIVES the range (or on a reader's press) — never when a page is viewed.
//   ⚠ NEVER INSIDE A TRANSACTION: every network call is awaited before its row is written.
import { and, eq, inArray } from 'drizzle-orm';
import { trackerTicketIdent, type TrackerProvider } from '@pierre-review/shared';
import type { TrackerContext } from './context.js';
import { githubAccessFor } from './context.js';
import { prepareTrackerCall } from './calls.js';
import { JiraFetchError } from './jira/fetch.js';
import { maybeAdapterFor } from './registry.js';
import { readWorkspaceTrackerRow, trackerAccessOf, trackerBaseUrl } from './settings.js';
import type { TicketStatusAnswer, TrackerCall, TrackerReader } from './types.js';

/** One-by-one reads per call (a reader with no bulk lookup, or keys the batch did not name). */
export const PER_TICKET_READS_MAX = 40;
const PER_TICKET_CONCURRENCY = 4;
/** Failed reads in a row before a ticket stops "checking" and is listed as "could not be read: the
 *  tracker did not answer" (it never blocks). */
export const RELEASE_TICKET_FAILS_MAX = 3;

export interface TicketStatusReadResult {
  /** Keys asked. */
  asked: number;
  /** Keys that got an answer (ok, not found, no access). */
  answered: Set<string>;
  /** Tracker requests made. */
  calls: number;
  /** Keys left for a later read (the one-by-one cap). */
  left: number;
  /** The workspace's tracker cannot read (no reader, no credential): nothing was asked. */
  unreadable: boolean;
}

/** A one-ticket read's failure → the stored state. Pure. */
export function stateOfError(err: unknown): 'not_found' | 'no_access' | 'failed' {
  const code = err instanceof JiraFetchError ? err.code : 'network';
  if (code === 'not_found') return 'not_found';
  if (code === 'no_access' || code === 'unauthorized' || code === 'forbidden') return 'no_access';
  return 'failed';
}

async function oneByOne(reader: TrackerReader, call: TrackerCall, keys: readonly string[], answers: Map<string, TicketStatusAnswer>): Promise<number> {
  let next = 0;
  let calls = 0;
  await Promise.all(
    Array.from({ length: Math.min(PER_TICKET_CONCURRENCY, keys.length) }, async () => {
      while (next < keys.length) {
        const key = keys[next++]!;
        calls += 1;
        try {
          const t = await reader.fetchTicket(call, key);
          answers.set(key, {
            state: 'ok',
            key,
            title: t.title,
            status: t.status == null ? null : { name: t.status.name, category: t.status.category },
            url: t.url ?? null,
            typeName: t.issueType?.name ?? null,
            assigneeName: t.assignee?.name ?? null,
          });
        } catch (err) {
          answers.set(key, { state: stateOfError(err), key });
        }
      }
    }),
  );
  return calls;
}

/**
 * Read these tickets' statuses for one workspace and store them. Never throws (a failure is stored per
 * ticket). `keys` are the tracker's keys as detection gives them.
 */
export async function readTicketStatuses(
  ctx: TrackerContext,
  accountId: number,
  workspaceId: number,
  keys: readonly string[],
  opts: { now?: () => number; perTicketMax?: number } = {},
): Promise<TicketStatusReadResult> {
  const uniq = [...new Set(keys)];
  const result: TicketStatusReadResult = { asked: uniq.length, answered: new Set(), calls: 0, left: 0, unreadable: false };
  if (uniq.length === 0) return result;
  const access = trackerAccessOf(ctx.host, await readWorkspaceTrackerRow(ctx, accountId, workspaceId));
  const provider = access.issue.provider as TrackerProvider | null;
  const adapter = maybeAdapterFor(provider);
  const prep = prepareTrackerCall(access, { github: githubAccessFor(ctx, accountId) });
  if (provider == null || adapter?.reader == null || !prep.ok) return { ...result, unreadable: true };
  const reader = adapter.reader;
  const call = prep.call;
  const baseUrl = trackerBaseUrl(access.issue);

  const answers = new Map<string, TicketStatusAnswer>();
  let single = uniq;
  if (reader.readStatuses != null) {
    try {
      const bulk = await reader.readStatuses(call, uniq);
      result.calls += bulk.calls;
      for (const [k, a] of bulk.answers) answers.set(k, a);
      single = uniq.filter((k) => (answers.get(k)?.state ?? 'missing') === 'missing');
    } catch {
      for (const k of uniq) answers.set(k, { state: 'failed', key: k });
      single = [];
    }
  }
  const cap = opts.perTicketMax ?? PER_TICKET_READS_MAX;
  const now1 = single.slice(0, cap);
  result.left = single.length - now1.length;
  for (const k of single.slice(cap)) answers.delete(k);
  result.calls += await oneByOne(reader, call, now1, answers);

  // Store: one statement per ticket, outside any transaction (the reads are done).
  const t = ctx.schema.trackerTicketStatus;
  const idents = [...answers.keys()].map((k) => trackerTicketIdent(provider, call.apiRoot, k));
  const prior = new Map<string, number>();
  for (let i = 0; i < idents.length; i += 400) {
    const rows = (await ctx.db
      .select({ ident: t.ident, attempts: t.attempts })
      .from(t)
      .where(and(eq(t.accountId, accountId), eq(t.workspaceId, workspaceId), inArray(t.ident, idents.slice(i, i + 400))))
      .execute()) as Array<{ ident: string; attempts: number }>;
    for (const r of rows) prior.set(r.ident, r.attempts);
  }
  const now = new Date(opts.now?.() ?? Date.now());
  for (const [key, a] of answers) {
    if (a.state === 'missing') continue;
    const ident = trackerTicketIdent(provider, call.apiRoot, key);
    const ok = a.state === 'ok';
    const url = ok && a.url != null && a.url.startsWith('https://') ? a.url : baseUrl != null ? adapter.browseUrl(baseUrl, key) : null;
    const values = ok
      ? {
          state: 'ok' as const,
          statusName: a.status?.name ?? null,
          statusCategory: a.status?.category ?? null,
          title: a.title,
          url,
          issueTypeName: a.typeName ?? null,
          assigneeName: a.assigneeName ?? null,
          attempts: 0,
          fetchedAt: now,
          checkedAt: now,
        }
      : { state: a.state, attempts: a.state === 'failed' ? (prior.get(ident) ?? 0) + 1 : 0, checkedAt: now };
    await ctx.db
      .insert(t)
      .values({ accountId, workspaceId, provider, apiRoot: call.apiRoot, issueKey: key, ident, url, ...values })
      .onConflictDoUpdate({ target: [t.accountId, t.workspaceId, t.ident], set: { issueKey: key, ...values } })
      .execute();
    if (a.state !== 'failed') result.answered.add(key);
  }
  return result;
}
