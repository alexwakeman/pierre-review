import { and, desc, eq, gte, inArray, isNotNull, lt } from 'drizzle-orm';
import {
  STORIES_MAX,
  STORY_PR_REFS_MAX,
  trackerTicketIdent,
  type ClaudeReviewTicket,
  type StoriesResponse,
  type StoryPrRef,
  type StoryReviewSummary,
  type StoryRow,
  type TicketAssessment,
  type TrackerProvider,
} from '@pierre-review/shared';
import { db, schema } from './client.js';
import type { BotScope } from './queries.js';
import { measuredTo, type ReportingWindow } from './reporting-window.js';
import { getResolvedFlowSettings } from './flow-settings.js';
import { buildWorkingCalendar } from './working-hours.js';
import { textCriteriaCount } from './story-criteria.js';
import type { StoredTicketRow } from '../tracker/store.js';

// REPORTS → STORIES — the population fold (docs/API.md § GET /api/stories). ONE fold, two callers:
// `GET /api/stories` (the rows the SPA lists and charts, over the reporting window) and the story
// report's picks (db/story-selection.ts, over the window the reader chose), so the report and the
// lists read the SAME stories the same way.
//
//   • THE WORKSPACE'S TRACKER decides the site: its provider + canonical `api_root` (the adapter's
//     `siteRoot`, as tracker/merged.ts reads it). No reading tracker → `trackerOn: false`, no rows.
//   • THE POPULATION is every ticket on that site with at least one pull request in the WORKSPACE'S
//     repos MERGED in `[window.fromMs, min(window.toMs, now))` — two-sided, half-open, the reporting
//     window's own predicate (db/merged-prs.ts). Identity is the shared `trackerTicketIdent`, never
//     a second fold.
//   • MEMBERS of a ticket are the ticket review's (`tracker/peers.ts` `ticketMembers`): this account,
//     the same site, ANY workspace and repo, state 'ok', read at least once. Read here in ONE batched
//     scan rather than one call per ticket.
//   • THE STORY TEXT is the freshest stored row with content (`ticketStory`'s rule).
//   • WORKING TIME is first PR opened → last PR merged, through the workspace's working calendar
//     (`getResolvedFlowSettings` + `buildWorkingCalendar`, as Chronology does), and in clock hours.
//   • SIZE: Σ additions+deletions over MERGED members. ⚠ UNKNOWN IS NEVER ZERO — the size columns
//     are NOT NULL DEFAULT 0, so a merged PR with all three at 0 is UNSIZED (db/repo-activity.ts's
//     guard, verbatim) and makes the story's `linesChanged`/`files` null, with `unsizedPrs` saying
//     how many. Never a partial sum.
//   • CRITERIA: the latest succeeded ticket review's criteria count; else the text rule
//     (db/story-criteria.ts), the source labelled either way.
//
// ⚠ Every read predicates on accountId (ticket rows, PRs, repos, reviews, members). `scope.repoIds`
// is the resolved workspace's membership; `[]` is an empty population, never the whole account.
// COST: a handful of indexed scans bounded by the window's merged PRs and their tickets' members —
// no GitHub, no tracker, no model. The `read` tier.

const HOUR_MS = 3_600_000;
const CHUNK = 400;

/** Everything one story carries beyond its wire row — what the story report's `get_story` reads. */
export interface StoryInternals {
  row: StoryRow;
  /** Freshest stored ticket row with content (null when no row has content). */
  ticket: StoredTicketRow | null;
  /** Latest SUCCEEDED ticket review, if any. */
  review: {
    id: number;
    snapshot: ClaudeReviewTicket | null;
    assessment: TicketAssessment;
  } | null;
  /** Every PR on the ticket, keyed by PR id. */
  prs: Map<number, MemberPr>;
}

export interface MemberPr {
  id: number;
  repoId: number;
  repoFullName: string;
  number: number;
  title: string;
  state: 'open' | 'merged' | 'closed';
  openedAt: Date;
  mergedAt: Date | null;
  additions: number;
  deletions: number;
  changedFiles: number;
}

export interface StoriesFold extends Omit<StoriesResponse, 'workspaceId' | 'window'> {
  internals: Map<string, StoryInternals>;
}

const EMPTY = (trackerOn: boolean, workingDayHours: number): StoriesFold => ({
  trackerOn,
  workingDayHours,
  stories: [],
  shortfall: [],
  unchecked: [],
  truncated: false,
  internals: new Map(),
});

async function chunked<T, R>(items: readonly T[], read: (chunk: T[]) => Promise<R[]>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(...(await read(items.slice(i, i + CHUNK))));
  return out;
}

/** A merged PR whose three size columns are all 0 was never sized (the columns default to 0). */
export function isSized(p: Pick<MemberPr, 'additions' | 'deletions' | 'changedFiles'>): boolean {
  return p.changedFiles > 0 || p.additions > 0 || p.deletions > 0;
}

/** Counts of the review's assessment, folded for the wire. */
export function reviewSummaryOf(
  id: number,
  a: TicketAssessment,
  completedAt: Date | null,
): StoryReviewSummary {
  const count = (s: string) => a.criteria.filter((c) => c.status === s).length;
  return {
    id,
    alignment: a.alignment,
    met: count('met'),
    partlyMet: count('partly_met'),
    notMet: count('not_met'),
    unclear: count('unclear'),
    notChecked: count('not_checked'),
    total: a.criteria.length,
    missing: a.missing.length,
    checkedAt: completedAt != null ? completedAt.toISOString() : null,
  };
}

export async function workspaceSite(
  accountId: number,
  workspaceId: number,
): Promise<{ provider: TrackerProvider; apiRoot: string } | null> {
  // LAZY: tracker/runtime.ts builds the process's TrackerContext over this same db client.
  const [{ trackerContext }, { readWorkspaceTrackerRow, issueOf }, { maybeAdapterFor }] = await Promise.all([
    import('../tracker/runtime.js'),
    import('../tracker/settings.js'),
    import('../tracker/registry.js'),
  ]);
  const issue = issueOf(await readWorkspaceTrackerRow(trackerContext(), accountId, workspaceId));
  const adapter = maybeAdapterFor(issue.provider);
  if (issue.provider == null || adapter?.reader == null) return null;
  const apiRoot = adapter.siteRoot(issue.baseUrl);
  return apiRoot == null ? null : { provider: issue.provider, apiRoot };
}

export async function foldStories(
  accountId: number,
  scope: BotScope,
  nowMs: number,
  window: ReportingWindow,
): Promise<StoriesFold> {
  const settings = await getResolvedFlowSettings(accountId, scope.workspaceId);
  const dayHours = buildWorkingCalendar(settings, nowMs - 7 * 86_400_000, nowMs).dayHours;
  const site = await workspaceSite(accountId, scope.workspaceId);
  if (site == null) return EMPTY(false, dayHours);
  if (scope.repoIds.length === 0) return EMPTY(true, dayHours);

  const { trackerTickets: tt, pullRequests: pr, repos, ticketReviews: tr } = schema;
  const fromMs = window.fromMs;
  const toMs = Math.max(fromMs, measuredTo(window, nowMs));
  const siteWhere = and(
    eq(tt.accountId, accountId),
    eq(tt.provider, site.provider),
    eq(tt.apiRoot, site.apiRoot),
    eq(tt.state, 'ok'),
    isNotNull(tt.fetchedAt),
  );

  // 1. The population: keys with a PR in the workspace's repos merged inside the window.
  const seeds = (await db
    .select({ issueKey: tt.issueKey })
    .from(tt)
    .innerJoin(pr, and(eq(pr.id, tt.prId), eq(pr.accountId, accountId)))
    .where(
      and(
        siteWhere,
        inArray(pr.repoId, scope.repoIds),
        eq(pr.state, 'merged'),
        gte(pr.mergedAt, new Date(fromMs)),
        lt(pr.mergedAt, new Date(toMs)),
      ),
    )
    .execute()) as Array<{ issueKey: string }>;
  const keys = [...new Set(seeds.map((s) => s.issueKey))];
  if (keys.length === 0) return EMPTY(true, dayHours);

  // 2. Every stored row of those tickets on the site (members, any workspace).
  const ticketRows = (await chunked(keys, async (chunk) =>
    db.select().from(tt).where(and(siteWhere, inArray(tt.issueKey, chunk))).execute(),
  )) as StoredTicketRow[];

  // 3. The member PRs (this account only) and their repos.
  const prIds = [...new Set(ticketRows.map((r) => r.prId))];
  const prRows = await chunked(prIds, async (chunk) =>
    db
      .select({
        id: pr.id,
        repoId: pr.repoId,
        number: pr.number,
        title: pr.title,
        state: pr.state,
        openedAt: pr.openedAt,
        mergedAt: pr.mergedAt,
        additions: pr.additions,
        deletions: pr.deletions,
        changedFiles: pr.changedFiles,
      })
      .from(pr)
      .where(and(eq(pr.accountId, accountId), inArray(pr.id, chunk)))
      .execute(),
  );
  const repoIds = [...new Set(prRows.map((p) => p.repoId))];
  const repoRows = await chunked(repoIds, async (chunk) =>
    db
      .select({ id: repos.id, owner: repos.owner, name: repos.name })
      .from(repos)
      .where(and(eq(repos.accountId, accountId), inArray(repos.id, chunk)))
      .execute(),
  );
  const repoName = new Map(repoRows.map((r) => [r.id, `${r.owner}/${r.name}`]));
  const prById = new Map<number, MemberPr>();
  for (const p of prRows) {
    const repoFullName = repoName.get(p.repoId);
    if (repoFullName == null) continue; // defence in depth: a repo that is not this account's
    const state = p.state === 'merged' ? 'merged' : p.state === 'closed' ? 'closed' : 'open';
    prById.set(p.id, { ...p, repoFullName, state, title: p.title ?? '' });
  }

  // 4. Group by ticket.
  const byKey = new Map<string, { rows: StoredTicketRow[]; prs: Map<number, MemberPr> }>();
  for (const r of ticketRows) {
    const m = prById.get(r.prId);
    let g = byKey.get(r.issueKey);
    if (g == null) byKey.set(r.issueKey, (g = { rows: [], prs: new Map() }));
    g.rows.push(r);
    if (m != null) g.prs.set(m.id, m);
  }

  // 5. The latest SUCCEEDED ticket review per ident (any workspace of this account).
  const identOf = (key: string) => trackerTicketIdent(site.provider, site.apiRoot, key);
  const idents = keys.map(identOf);
  const reviewRows = await chunked(idents, async (chunk) =>
    db
      .select({
        id: tr.id,
        ticketIdent: tr.ticketIdent,
        snapshot: tr.ticketSnapshot,
        assessment: tr.assessment,
        completedAt: tr.completedAt,
        createdAt: tr.createdAt,
      })
      .from(tr)
      .where(and(eq(tr.accountId, accountId), eq(tr.status, 'succeeded'), inArray(tr.ticketIdent, chunk)))
      .orderBy(desc(tr.createdAt), desc(tr.id))
      .execute(),
  );
  const latestReview = new Map<string, (typeof reviewRows)[number]>();
  for (const r of reviewRows) {
    if (r.assessment == null) continue;
    const prev = latestReview.get(r.ticketIdent);
    // Ordered by the query, but re-asserted here so heap order on Postgres cannot decide it.
    if (
      prev == null ||
      r.createdAt.getTime() > prev.createdAt.getTime() ||
      (r.createdAt.getTime() === prev.createdAt.getTime() && r.id > prev.id)
    ) {
      latestReview.set(r.ticketIdent, r);
    }
  }

  // 6. Build each story.
  type Draft = Omit<StoryRow, 'workingHours'> & { firstMs: number; lastMs: number };
  const drafts: Array<{ d: Draft; internals: Omit<StoryInternals, 'row'> }> = [];
  for (const key of keys) {
    const g = byKey.get(key);
    if (g == null) continue;
    const members = [...g.prs.values()];
    const merged = members.filter((m) => m.state === 'merged' && m.mergedAt != null);
    if (merged.length === 0) continue; // its window PR belonged to another account (cannot happen)
    const ident = identOf(key);

    const freshest =
      [...g.rows]
        .filter((r) => r.fetchedAt != null && r.title != null)
        .sort((a, b) => (b.fetchedAt!.getTime() - a.fetchedAt!.getTime()) || b.id - a.id)[0] ?? null;
    const anyRow = freshest ?? g.rows[0]!;

    const rev = latestReview.get(ident) ?? null;
    const review = rev != null ? reviewSummaryOf(rev.id, rev.assessment as TicketAssessment, rev.completedAt) : null;
    // A review with NO criteria list (a ticket whose criteria field is empty: the review judged the
    // description and reported only missing items) is not "0 criteria" — fall through to the
    // ticket's own text, else none.
    const criteria =
      review != null && review.total > 0
        ? { count: review.total, source: 'review' as const }
        : freshest != null
          ? textCriteriaCount(freshest, site.provider)
          : { count: null, source: 'none' as const };

    const unsized = merged.filter((m) => !isSized(m)).length;
    const linesChanged = unsized > 0 ? null : merged.reduce((n, m) => n + m.additions + m.deletions, 0);
    const files = unsized > 0 ? null : merged.reduce((n, m) => n + m.changedFiles, 0);

    const firstMs = Math.min(...members.map((m) => m.openedAt.getTime()));
    const lastMs = Math.max(...merged.map((m) => m.mergedAt!.getTime()));

    const refOf = (m: MemberPr): StoryPrRef => ({
      prId: m.id,
      repoFullName: m.repoFullName,
      number: m.number,
      title: m.title,
      state: m.state,
      mergedAt: m.mergedAt != null && m.state === 'merged' ? m.mergedAt.toISOString() : null,
      githubUrl: `https://github.com/${m.repoFullName}/pull/${m.number}`,
    });
    const rank = (m: MemberPr) => (m.state === 'merged' ? 0 : m.state === 'open' ? 1 : 2);
    const pullRequests = [...members]
      .sort(
        (a, b) =>
          rank(a) - rank(b) ||
          (b.mergedAt?.getTime() ?? 0) - (a.mergedAt?.getTime() ?? 0) ||
          b.openedAt.getTime() - a.openedAt.getTime() ||
          b.id - a.id,
      )
      .slice(0, STORY_PR_REFS_MAX)
      .map(refOf);

    const unmetCount = review != null ? review.notMet + review.partlyMet + review.missing : 0;
    drafts.push({
      d: {
        ident,
        key: anyRow.issueKey,
        title: freshest?.title ?? null,
        url: anyRow.url !== '' ? anyRow.url : null,
        provider: site.provider,
        prs: {
          total: members.length,
          open: members.filter((m) => m.state === 'open').length,
          merged: merged.length,
          closed: members.filter((m) => m.state === 'closed').length,
          // Every member merged inside the window — any repo, like the rest of `prs` (the seed scan
          // reads only the workspace's own repos, which is what ADMITS the story).
          mergedInWindow: merged.filter((m) => m.mergedAt!.getTime() >= fromMs && m.mergedAt!.getTime() < toMs).length,
        },
        pullRequests,
        firstOpenedAt: new Date(firstMs).toISOString(),
        lastMergedAt: new Date(lastMs).toISOString(),
        clockHours: Math.max(0, lastMs - firstMs) / HOUR_MS,
        linesChanged,
        files,
        unsizedPrs: unsized,
        criteria,
        review,
        unmetCount,
        firstMs,
        lastMs,
      },
      internals: {
        ticket: freshest,
        review:
          rev != null
            ? { id: rev.id, snapshot: (rev.snapshot as ClaudeReviewTicket | null) ?? null, assessment: rev.assessment as TicketAssessment }
            : null,
        prs: g.prs,
      },
    });
  }
  if (drafts.length === 0) return EMPTY(true, dayHours);

  // 7. Newest last merge first; cap.
  drafts.sort((a, b) => b.d.lastMs - a.d.lastMs || a.d.ident.localeCompare(b.d.ident));
  const truncated = drafts.length > STORIES_MAX;
  const kept = truncated ? drafts.slice(0, STORIES_MAX) : drafts;

  // 8. One working calendar over the whole span.
  const lo = Math.min(...kept.map((x) => x.d.firstMs));
  const hi = Math.max(...kept.map((x) => x.d.lastMs));
  const calendar = buildWorkingCalendar(settings, lo, hi);

  const stories: StoryRow[] = [];
  const internals = new Map<string, StoryInternals>();
  for (const { d, internals: inner } of kept) {
    const { firstMs, lastMs, ...rest } = d;
    const row: StoryRow = { ...rest, workingHours: calendar.between(firstMs, lastMs) };
    stories.push(row);
    internals.set(row.ident, { row, ...inner });
  }

  const lastOf = (s: StoryRow) => Date.parse(s.lastMergedAt);
  const shortfall = stories
    .filter((s) => s.review != null && (s.review.alignment !== 'aligned' || s.unmetCount > 0))
    .sort((a, b) => b.unmetCount - a.unmetCount || lastOf(b) - lastOf(a) || a.ident.localeCompare(b.ident))
    .map((s) => s.ident);
  const unchecked = stories
    .filter((s) => s.review == null)
    .sort((a, b) => lastOf(b) - lastOf(a) || a.ident.localeCompare(b.ident))
    .map((s) => s.ident);

  return {
    trackerOn: true,
    workingDayHours: calendar.dayHours,
    stories,
    shortfall,
    unchecked,
    truncated,
    internals,
  };
}

/** GET /api/stories' body (the route adds `workspaceId` + `window`). */
export async function getStories(
  accountId: number,
  scope: BotScope,
  nowMs: number,
  window: ReportingWindow,
): Promise<Omit<StoriesResponse, 'workspaceId' | 'window'>> {
  const { internals: _internals, ...wire } = await foldStories(accountId, scope, nowMs, window);
  return wire;
}
