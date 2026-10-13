import { and, eq, inArray } from 'drizzle-orm';
import {
  parseTicketLinkBlockers,
  type JiraStatusCategory,
  type KnownTicket,
  type StoryIssueInput,
  type StoryIssueLabel,
  type TicketLinkBlocker,
  type TrackerProvider,
} from '@pierre-review/shared';

// THE ONE STORY-ISSUE INPUT BUILDER (shared `story-issues.ts` folds it). Every surface that raises or
// counts a story issue — the story
// report (db/story-selection.ts) and the label run (db/story-health.ts) — hands the fold the same four
// things, built here:
//
//   • the ticket's numbered criteria (the ONE extractor, the caller's),
//   • its CURRENT label (rubric + text hash match — the caller's comparison) or null,
//   • its stored TRACKER LINKS (`blocked_by_json`; `linksOfRow`), null = never read,
//   • the stored tickets a label's named keys point at (`knownTicketsFor`), so "BMD-568" is shown with
//     its title and status, and a finished one is resolved rather than raised.
//
// ⚠ Every read predicates on accountId. A named key resolves only on the SAME tracker site.
// ⚠ PURE AT IMPORT: pure folds import this file, so the DB client is reached
// LAZILY inside `knownTicketsFor` — a pure test must never open a database.

const CHUNK = 400;

export function buildStoryIssueInput(args: {
  criteria: readonly string[];
  label: StoryIssueLabel | null;
  links: readonly TicketLinkBlocker[] | null;
  knownTickets: ReadonlyMap<string, KnownTicket> | null;
}): StoryIssueInput {
  return { criteria: args.criteria, label: args.label, links: args.links, knownTickets: args.knownTickets };
}

/** A stored row's links (`blocked_by_json`), tolerant: anything malformed is dropped; absent = null. */
export function linksOfRow(row: object | null | undefined): TicketLinkBlocker[] | null {
  if (row == null || !('blockedByJson' in row)) return null;
  return parseTicketLinkBlockers((row as { blockedByJson: unknown }).blockedByJson);
}

/** The ticket keys a label names — its dependencies' keys and (rubric 4) its references — upper-cased,
 *  deduped. */
export function namedTicketKeys(labels: Iterable<StoryIssueLabel | null | undefined>): string[] {
  const out = new Set<string>();
  for (const l of labels) {
    for (const d of l?.story.dependencies ?? []) {
      if (d.ticketKey != null && d.ticketKey.trim() !== '') out.add(d.ticketKey.trim().toUpperCase());
    }
    for (const r of l?.story.references ?? []) {
      if (r.ticketKey.trim() !== '') out.add(r.ticketKey.trim().toUpperCase());
    }
  }
  return [...out];
}

const CATEGORIES: readonly string[] = ['new', 'indeterminate', 'done'];
const categoryOf = (v: string | null): JiraStatusCategory | null =>
  v != null && CATEGORIES.includes(v) ? (v as JiraStatusCategory) : null;
const httpsOrNull = (u: string | null): string | null => (u != null && /^https:\/\//i.test(u) ? u : null);

/**
 * Stored tickets on this site by UPPER-CASED key: the freshest `sprint_tickets` row (any workspace of
 * the account) wins, else the freshest read `tracker_tickets` row (state 'ok'), else (unless
 * `refs: false`) the freshest `sprint_ref_tickets` row — the sprint read's status lookup of tickets
 * the sprint's text names (tracker/sprint/ref-status.ts). Keys with no stored ticket are absent.
 * GitHub keys (`owner/repo#12`) compare upper-cased too — the map is only a lookup.
 */
export async function knownTicketsFor(
  accountId: number,
  provider: TrackerProvider,
  apiRoot: string,
  keys: readonly string[],
  opts: { refs?: boolean } = {},
): Promise<Map<string, KnownTicket>> {
  const out = new Map<string, KnownTicket>();
  const wanted = [...new Set(keys.map((k) => k.trim()).filter((k) => k !== ''))];
  if (wanted.length === 0) return out;
  const { db, schema } = await import('./client.js');
  // Stored keys are canonical (Jira/Linear upper-case); ask for both spellings so a lower-cased
  // label key still matches.
  const asked = [...new Set(wanted.flatMap((k) => [k, k.toUpperCase()]))];
  const st = schema.sprintTickets;
  const tt = schema.trackerTickets;
  const fresh = new Map<string, { at: number; t: KnownTicket }>();
  const offer = (key: string, at: number, t: KnownTicket, map: Map<string, { at: number; t: KnownTicket }>) => {
    const k = key.toUpperCase();
    const prev = map.get(k);
    if (prev == null || at > prev.at) map.set(k, { at, t });
  };
  for (let i = 0; i < asked.length; i += CHUNK) {
    const chunk = asked.slice(i, i + CHUNK);
    const rows = await db
      .select({
        issueKey: st.issueKey,
        title: st.title,
        statusName: st.statusName,
        statusCategory: st.statusCategory,
        url: st.url,
        fetchedAt: st.fetchedAt,
      })
      .from(st)
      .where(and(eq(st.accountId, accountId), eq(st.provider, provider), eq(st.apiRoot, apiRoot), inArray(st.issueKey, chunk)))
      .execute();
    for (const r of rows) {
      offer(r.issueKey, r.fetchedAt.getTime(), {
        title: r.title.trim() === '' ? null : r.title,
        status: r.statusName,
        category: categoryOf(r.statusCategory),
        url: httpsOrNull(r.url),
      }, fresh);
    }
  }
  const fromTracker = new Map<string, { at: number; t: KnownTicket }>();
  const missing = asked.filter((k) => !fresh.has(k.toUpperCase()));
  for (let i = 0; i < missing.length; i += CHUNK) {
    const chunk = missing.slice(i, i + CHUNK);
    const rows = await db
      .select({
        issueKey: tt.issueKey,
        title: tt.title,
        statusName: tt.statusName,
        statusCategory: tt.statusCategory,
        url: tt.url,
        fetchedAt: tt.fetchedAt,
      })
      .from(tt)
      .where(
        and(
          eq(tt.accountId, accountId),
          eq(tt.provider, provider),
          eq(tt.apiRoot, apiRoot),
          eq(tt.state, 'ok'),
          inArray(tt.issueKey, chunk),
        ),
      )
      .execute();
    for (const r of rows) {
      if (r.fetchedAt == null) continue;
      offer(r.issueKey, r.fetchedAt.getTime(), {
        title: r.title,
        status: r.statusName,
        category: categoryOf(r.statusCategory),
        url: httpsOrNull(r.url),
      }, fromTracker);
    }
  }
  const fromRefs = new Map<string, { at: number; t: KnownTicket }>();
  const rt = schema.sprintRefTickets;
  const stillMissing = opts.refs === false ? [] : missing.filter((k) => !fromTracker.has(k.toUpperCase()));
  for (let i = 0; i < stillMissing.length; i += CHUNK) {
    const chunk = stillMissing.slice(i, i + CHUNK);
    const rows = await db
      .select({
        issueKey: rt.issueKey,
        title: rt.title,
        statusName: rt.statusName,
        statusCategory: rt.statusCategory,
        url: rt.url,
        readAt: rt.readAt,
      })
      .from(rt)
      .where(and(eq(rt.accountId, accountId), eq(rt.provider, provider), eq(rt.apiRoot, apiRoot), inArray(rt.issueKey, chunk)))
      .execute();
    for (const r of rows) {
      offer(r.issueKey, r.readAt.getTime(), {
        title: r.title != null && r.title.trim() !== '' ? r.title : null,
        status: r.statusName,
        category: categoryOf(r.statusCategory),
        url: httpsOrNull(r.url),
      }, fromRefs);
    }
  }
  for (const [k, v] of fromRefs) out.set(k, v.t);
  for (const [k, v] of fromTracker) out.set(k, v.t);
  for (const [k, v] of fresh) out.set(k, v.t);
  return out;
}
