import { createHash } from 'node:crypto';
import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  notInArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type {
  CheckRun,
  CiStatus,
  CommitDetail,
  DerivedState,
  DismissedItem,
  DismissedMyTurnResponse,
  EventType,
  FeedEvent,
  FeedResponse,
  Label,
  RequestedReviewer,
  Mergeable,
  MergeStateStatus,
  MyTurnDismissKind,
  MyTurnResponse,
  NewSinceLastViewed,
  PrCommentDetail,
  PrDetail,
  PrFileChange,
  PrState,
  AnalyticsBin,
  InsightsOpenPr,
  InsightsResponse,
  InsightsTimePoint,
  RepoAnalytics,
  ReviewerLoadSeries,
  SizeCyclePoint,
  SizeCycleBucket,
  PrStatus,
  ReasonTag,
  Repo,
  RepoInsights,
  RepoMergers,
  ReviewDetail,
  ReviewState,
  ThreadAwaitingItem,
  ThreadDetail,
  ThreadStateCounts,
  TimelineEvent,
  TimelinePr,
  TimelineResponse,
  User,
  ClaudeReview,
  ClaudeFinding,
  ClaudeReviewSummary,
  ClaudeReviewListItem,
  ClaudeReviewToAction,
} from '@pierre-review/shared';

// Local copy of the shared `REASON_PRIORITY` value constant. `@pierre-review/shared`
// is a types-only workspace package that is NOT shipped in the published tarball,
// so the backend must only `import type` from it. Keep in sync with packages/shared.
const REASON_PRIORITY: ReasonTag[] = [
  'awaiting_your_review',
  'your_pr_new_comments',
  'ci_failing',
  'merge_conflicts',
  'approved_ready',
  'stalled',
  'untouched_threads',
  'in_progress',
];
import { db, schema, isPg } from './client.js';
import { runTransaction } from './client.js';
import { config } from '../config.js';
import { computeTriage, type TriageResult } from './triage.js';
import { getAccountUserId } from '../auth/account.js';

// Bind a JS Date into a raw-`sql` epoch comparison portably: Postgres columns are
// timestamptz (drizzle binds the Date through the codec), whereas SQLite columns
// are integer unix-epoch seconds (`mode:'timestamp'`), so we hand it the int.
const tsBound = (d: Date): Date | number =>
  isPg ? d : Math.floor(d.getTime() / 1000);

const {
  repos,
  users,
  pullRequests,
  reviewThreads,
  reviewComments,
  prComments,
  reviews,
  commits,
  events,
  syncState,
  prViews,
  myTurnDismissals,
  claudeReviews,
  claudeReviewFindings,
} = schema;

function iso(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}

function emptyCounts(): ThreadStateCounts {
  return { resolved: 0, likely_addressed: 0, replied_unresolved: 0, untouched: 0 };
}

function mapUser(u: typeof users.$inferSelect): User {
  return {
    id: u.id,
    githubLogin: u.githubLogin,
    displayName: u.displayName,
    avatarUrl: u.avatarUrl,
    isBot: u.isBot,
  };
}

export async function listRepos(accountId: number): Promise<Repo[]> {
  const rows = await db
    .select()
    .from(repos)
    .leftJoin(syncState, eq(syncState.repoId, repos.id))
    .where(eq(repos.accountId, accountId))
    .orderBy(asc(repos.owner), asc(repos.name))
    .execute();

  return rows.map((r) => ({
    id: r.repos.id,
    owner: r.repos.owner,
    name: r.repos.name,
    fullName: `${r.repos.owner}/${r.repos.name}`,
    createdAt: r.repos.createdAt.toISOString(),
    lastFullSyncAt: iso(r.sync_state?.lastFullSyncAt ?? null),
    lastIncrementalSyncAt: iso(r.sync_state?.lastIncrementalSyncAt ?? null),
    lastSyncStatus: r.sync_state?.lastSyncStatus ?? null,
    lastSyncError: r.sync_state?.lastSyncError ?? null,
    inboxWatch: r.repos.inboxWatch,
  }));
}

export async function getRepo(id: number, accountId: number): Promise<Repo | null> {
  return (await listRepos(accountId)).find((r) => r.id === id) ?? null;
}

// Node IDs of every watched repo. Used to drop already-tracked repos from live
// search results (a GitHub search hit exposes the same GraphQL `id`).
export async function getWatchedRepoNodeIds(accountId: number): Promise<Set<string>> {
  const rows = await db
    .select({ nodeId: repos.githubNodeId })
    .from(repos)
    .where(eq(repos.accountId, accountId))
    .execute();
  return new Set(rows.map((r) => r.nodeId));
}

export async function listUsers(): Promise<User[]> {
  const rows = await db
    .select()
    .from(users)
    .orderBy(asc(users.githubLogin))
    .execute();
  return rows.map(mapUser);
}

export async function setUserBot(id: number, isBot: boolean): Promise<User | null> {
  const rows = await db
    .update(users)
    .set({ isBot, isBotOverridden: true })
    .where(eq(users.id, id))
    .returning()
    .execute();
  const row = rows[0] ?? null;
  return row ? mapUser(row) : null;
}

export interface TimelineFilters {
  accountId: number;
  from: Date;
  to: Date;
  repoIds: number[] | null;
  userIds: number[] | null;
  types: EventType[] | null;
  // null = no status filter (all); otherwise the selected PR statuses (an empty
  // array shows nothing). A status maps to (state, isDraft) on pullRequests.
  statuses: PrStatus[] | null;
  // null = no review-verdict filter (all); otherwise the selected review states
  // (an empty array hides every review marker). Only filters review_submitted
  // events — by the verdict of the review they reference.
  reviewStates: ReviewState[] | null;
  excludeBots: boolean;
  // true → hide "stale" open PRs (no commit/comment/review in [from, to]).
  excludeStale: boolean;
}

// Event types that count as "touching" a PR for the stale filter: code pushes and
// any human discussion (inline review comments, issue-level comments, reviews).
// Lifecycle events (opened/merged/…) are NOT activity — a quiet open PR that was
// merely opened long ago is exactly what "stale" targets.
const ACTIVITY_EVENT_TYPES: EventType[] = [
  'commit_pushed',
  'review_comment',
  'pr_comment',
  'review_submitted',
];

// Open PRs (from `prRows`) with no activity event inside [from, to] — the "stale"
// set. Only open PRs are eligible (merged/closed are historical, never stale).
async function staleOpenPrIds(
  prRows: PrRow[],
  from: Date,
  to: Date,
): Promise<Set<number>> {
  const openIds = prRows.filter((p) => p.state === 'open').map((p) => p.id);
  if (openIds.length === 0) return new Set();
  const activeRows = await db
    .select({ prId: events.prId })
    .from(events)
    .where(
      and(
        inArray(events.prId, openIds),
        inArray(events.type, ACTIVITY_EVENT_TYPES),
        gte(events.occurredAt, from),
        lte(events.occurredAt, to),
      ),
    )
    .execute();
  const active = new Set<number>();
  for (const r of activeRows) if (r.prId != null) active.add(r.prId);
  return new Set(openIds.filter((id) => !active.has(id)));
}

// SQL predicate (on the pullRequests table) for "the PR is one of these
// statuses". Reused directly on the PR query and inside an EXISTS on the events
// query, so events whose PR is filtered out drop too — letting a contributor's
// row disappear when their only PR is excluded. Empty selection → matches none.
function prStatusWhere(statuses: PrStatus[]): SQL {
  if (statuses.length === 0) return sql`1 = 0`;
  const parts = statuses.map((st) =>
    st === 'draft'
      ? and(eq(pullRequests.state, 'open'), eq(pullRequests.isDraft, true))
      : st === 'open'
        ? and(eq(pullRequests.state, 'open'), eq(pullRequests.isDraft, false))
        : st === 'merged'
          ? eq(pullRequests.state, 'merged')
          : eq(pullRequests.state, 'closed'),
  );
  return or(...parts)!;
}

async function botUserIds(): Promise<number[]> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.isBot, true))
    .execute();
  return rows.map((r) => r.id);
}

async function buildThreadCounts(
  prIds: number[],
): Promise<Map<number, ThreadStateCounts>> {
  const map = new Map<number, ThreadStateCounts>();
  if (prIds.length === 0) return map;
  const rows = await db
    .select({
      prId: reviewThreads.prId,
      state: reviewThreads.derivedState,
      c: count(),
    })
    .from(reviewThreads)
    .where(inArray(reviewThreads.prId, prIds))
    .groupBy(reviewThreads.prId, reviewThreads.derivedState)
    .execute();
  for (const r of rows) {
    const entry = map.get(r.prId) ?? emptyCounts();
    entry[r.state] = r.c;
    map.set(r.prId, entry);
  }
  return map;
}

function isStalled(pr: { state: PrState; lastCommitAt: Date | null }, counts: ThreadStateCounts): boolean {
  if (pr.state !== 'open') return false;
  const openThreads = counts.untouched + counts.replied_unresolved;
  if (openThreads < 1) return false;
  const ref = pr.lastCommitAt ?? null;
  if (!ref) return false;
  const ageMs = Date.now() - ref.getTime();
  return ageMs > config.stallThresholdDays * 24 * 60 * 60 * 1000;
}

type PrRow = typeof pullRequests.$inferSelect;

/** Build full TimelinePr objects (incl. triage fields) for a set of PR rows. */
async function buildTimelinePrs(
  prRows: PrRow[],
  accountId: number,
): Promise<TimelinePr[]> {
  const counts = await buildThreadCounts(prRows.map((p) => p.id));
  const triage = await computeTriage(
    prRows.map((p) => {
      const c = counts.get(p.id) ?? emptyCounts();
      return {
        id: p.id,
        state: p.state,
        authorId: p.authorId,
        ciStatus: (p.ciStatus ?? 'unknown') as CiStatus,
        mergeable: (p.mergeable ?? 'unknown') as Mergeable,
        mergeStateStatus: (p.mergeStateStatus ?? 'unknown') as MergeStateStatus,
        isStalled: isStalled(p, c),
        threadCounts: c,
      };
    }),
    accountId,
  );
  return prRows.map((p) => {
    const c = counts.get(p.id) ?? emptyCounts();
    const tr = triage.get(p.id);
    return mapTimelinePr(p, c, tr);
  });
}

function mapTimelinePr(
  p: PrRow,
  counts: ThreadStateCounts,
  tr: TriageResult | undefined,
): TimelinePr {
  return {
    id: p.id,
    repoId: p.repoId,
    number: p.number,
    title: p.title,
    authorId: p.authorId,
    state: p.state,
    isDraft: p.isDraft,
    isStalled: isStalled(p, counts),
    openedAt: p.openedAt.toISOString(),
    firstReviewAt: iso(p.firstReviewAt),
    lastCommitAt: iso(p.lastCommitAt),
    mergedAt: iso(p.mergedAt),
    closedAt: iso(p.closedAt),
    updatedAt: p.updatedAt.toISOString(),
    threadCounts: counts,
    ciStatus: (p.ciStatus ?? 'unknown') as CiStatus,
    mergeable: (p.mergeable ?? 'unknown') as Mergeable,
    mergeStateStatus: (p.mergeStateStatus ?? 'unknown') as MergeStateStatus,
    labels: (p.labels ?? []) as Label[],
    reasonTag: tr?.reasonTag ?? 'in_progress',
    reviewRequestedFromMe: tr?.reviewRequestedFromMe ?? false,
    newSinceLastViewed: tr?.newSinceLastViewed ?? null,
  };
}

export async function getTimeline(
  filters: TimelineFilters,
): Promise<TimelineResponse> {
  const {
    accountId,
    from,
    to,
    repoIds,
    userIds,
    types,
    statuses,
    reviewStates,
    excludeBots,
    excludeStale,
  } = filters;

  // ---- PRs that overlap the window ----
  const prConds = [
    eq(pullRequests.accountId, accountId),
    lte(pullRequests.openedAt, to),
    or(
      eq(pullRequests.state, 'open'),
      gte(
        sql`coalesce(${pullRequests.mergedAt}, ${pullRequests.closedAt}, ${pullRequests.openedAt})`,
        tsBound(from),
      ),
    ),
  ];
  if (repoIds) prConds.push(inArray(pullRequests.repoId, repoIds));

  // PR-status filter: keep only PRs whose (state, isDraft) is a selected status.
  if (statuses) prConds.push(prStatusWhere(statuses));

  // Member filter: PRs the user authored OR acted on within the window.
  if (userIds && userIds.length > 0) {
    prConds.push(
      or(
        inArray(pullRequests.authorId, userIds),
        exists(
          db
            .select({ x: sql`1` })
            .from(events)
            .where(
              and(
                eq(events.prId, pullRequests.id),
                inArray(events.actorId, userIds),
              ),
            ),
        ),
      )!,
    );
  }
  // Resolve the bot set once (used by both the PR and events branches below).
  const bots = excludeBots ? await botUserIds() : [];
  if (excludeBots && bots.length > 0) {
    prConds.push(
      or(
        sql`${pullRequests.authorId} is null`,
        sql`${pullRequests.authorId} not in (${sql.join(bots, sql`, `)})`,
      )!,
    );
  }

  let prRows = await db
    .select()
    .from(pullRequests)
    .where(and(...prConds))
    .execute();

  // Stale filter: drop open PRs with no activity in the window. Computed before
  // building the lean PRs so their events can be dropped too (below).
  const staleIds = excludeStale
    ? await staleOpenPrIds(prRows, from, to)
    : new Set<number>();
  if (staleIds.size > 0) prRows = prRows.filter((p) => !staleIds.has(p.id));

  const prs: TimelinePr[] = await buildTimelinePrs(prRows, accountId);

  // ---- events in the window ----
  const evConds = [
    eq(events.accountId, accountId),
    gte(events.occurredAt, from),
    lte(events.occurredAt, to),
  ];
  if (repoIds) evConds.push(inArray(events.repoId, repoIds));
  if (types) evConds.push(inArray(events.type, types));
  if (userIds && userIds.length > 0) {
    evConds.push(inArray(events.actorId, userIds));
  }
  // Drop events whose PR is filtered out by status — so a contributor with only
  // a (e.g.) closed PR keeps neither a bar nor any markers, and loses their row.
  if (statuses) {
    evConds.push(
      exists(
        db
          .select({ x: sql`1` })
          .from(pullRequests)
          .where(and(eq(pullRequests.id, events.prId), prStatusWhere(statuses))),
      ),
    );
  }
  // Review-verdict filter: keep every NON-review event; for review_submitted events,
  // keep only those whose referenced review's state is selected. An empty selection
  // drops all review markers (the review row exists but no verdict matches). null =
  // no filter. Pure-reviewer rows vanish when their verdict is deselected because the
  // event is removed here (not just hidden client-side), so no empty row lingers.
  if (reviewStates) {
    evConds.push(
      reviewStates.length === 0
        ? ne(events.type, 'review_submitted')
        : or(
            ne(events.type, 'review_submitted'),
            exists(
              db
                .select({ x: sql`1` })
                .from(reviews)
                .where(
                  and(
                    eq(reviews.id, events.refId),
                    eq(events.refTable, 'reviews'),
                    inArray(reviews.state, reviewStates),
                  ),
                ),
            ),
          )!,
    );
  }
  // Likewise drop a stale open PR's own events (only ever lifecycle markers, since
  // by definition it has no activity events in-window) so its contributor row can
  // disappear instead of lingering empty. Keep events with no PR (defensive).
  if (staleIds.size > 0) {
    evConds.push(or(isNull(events.prId), notInArray(events.prId, [...staleIds]))!);
  }
  if (excludeBots && bots.length > 0) {
    evConds.push(
      or(
        sql`${events.actorId} is null`,
        sql`${events.actorId} not in (${sql.join(bots, sql`, `)})`,
      )!,
    );
  }

  const evRows = await db
    .select()
    .from(events)
    .where(and(...evConds))
    .orderBy(asc(events.occurredAt))
    .execute();

  // Batch-load review outcomes for the review_submitted events in view, so
  // markers can show approve/changes/comment without per-marker fetches.
  const reviewRefIds = evRows
    .filter((e) => e.type === 'review_submitted' && e.refTable === 'reviews' && e.refId != null)
    .map((e) => e.refId as number);
  const reviewStateById = new Map<number, ReviewState>();
  if (reviewRefIds.length > 0) {
    const rows = await db
      .select({ id: reviews.id, state: reviews.state })
      .from(reviews)
      .where(inArray(reviews.id, reviewRefIds))
      .execute();
    for (const r of rows) reviewStateById.set(r.id, r.state as ReviewState);
  }

  // Batch-load the derived state of each review_comment event's thread, so the
  // timeline's "Threads" filter can narrow markers to a specific thread state
  // (e.g. only resolved) instead of every comment on a PR that has a matching
  // thread. A single keyed lookup; the thread's id is the event's refId.
  const threadRefIds = evRows
    .filter(
      (e) =>
        e.type === 'review_comment' && e.refTable === 'review_threads' && e.refId != null,
    )
    .map((e) => e.refId as number);
  const threadStateById = new Map<number, DerivedState>();
  if (threadRefIds.length > 0) {
    const rows = await db
      .select({ id: reviewThreads.id, state: reviewThreads.derivedState })
      .from(reviewThreads)
      .where(inArray(reviewThreads.id, threadRefIds))
      .execute();
    for (const r of rows) threadStateById.set(r.id, r.state as DerivedState);
  }

  const timelineEvents: TimelineEvent[] = evRows.map((e) => {
    const threadId =
      e.type === 'review_comment' && e.refTable === 'review_threads' ? e.refId : null;
    return {
      id: e.id,
      repoId: e.repoId,
      actorId: e.actorId,
      prId: e.prId,
      type: e.type,
      occurredAt: e.occurredAt.toISOString(),
      threadId,
      derivedState: threadId != null ? (threadStateById.get(threadId) ?? null) : null,
      refId: e.refId,
      reviewState:
        e.type === 'review_submitted' && e.refTable === 'reviews' && e.refId != null
          ? (reviewStateById.get(e.refId) ?? null)
          : null,
    };
  });

  return { prs, events: timelineEvents };
}

// ---- watched-repo activity Feed (My Turn panel) ----

// Recent activity across the account's WATCHED repos (inboxWatch=true), newest first,
// over the last `daysBefore` days. Commit pushes are excluded (too noisy); draft→ready
// and reopened are included (emitted during sync). Each row is denormalized into a
// render-ready FeedEvent (repo name, PR number/title/state, review verdict, comment
// excerpt). The frontend mirrors these into an append-only IndexedDB store.
// accountId-scoped throughout (events + repos both carry accountId).
export async function getFeed(
  accountId: number,
  daysBefore = 14,
): Promise<FeedResponse> {
  const since = new Date(Date.now() - daysBefore * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({
      id: events.id,
      type: events.type,
      occurredAt: events.occurredAt,
      repoId: events.repoId,
      repoOwner: repos.owner,
      repoName: repos.name,
      actorId: events.actorId,
      prId: events.prId,
      refId: events.refId,
      refTable: events.refTable,
      prNumber: pullRequests.number,
      prTitle: pullRequests.title,
      prState: pullRequests.state,
    })
    .from(events)
    .innerJoin(repos, eq(repos.id, events.repoId))
    .leftJoin(pullRequests, eq(pullRequests.id, events.prId))
    .where(
      and(
        eq(events.accountId, accountId),
        eq(repos.inboxWatch, true),
        gte(events.occurredAt, since),
        ne(events.type, 'commit_pushed'),
      ),
    )
    .orderBy(desc(events.occurredAt))
    .execute();
  if (rows.length === 0) return { events: [], users: [] };

  // Verdicts for review_submitted events (refId → reviews.state).
  const reviewIds = rows
    .filter((r) => r.type === 'review_submitted' && r.refTable === 'reviews' && r.refId != null)
    .map((r) => r.refId as number);
  const reviewStateById = new Map<number, ReviewState>();
  if (reviewIds.length > 0) {
    for (const r of await db
      .select({ id: reviews.id, state: reviews.state })
      .from(reviews)
      .where(inArray(reviews.id, reviewIds))
      .execute())
      reviewStateById.set(r.id, r.state as ReviewState);
  }

  // review_comment events reference their THREAD (refId); match the specific comment
  // by (threadId, createdAt, authorId) to pull its excerpt.
  const threadIds = [
    ...new Set(
      rows
        .filter((r) => r.type === 'review_comment' && r.refTable === 'review_threads' && r.refId != null)
        .map((r) => r.refId as number),
    ),
  ];
  type CommentRow = { createdAt: Date; authorId: number | null; excerpt: string | null; body: string | null };
  const commentsByThread = new Map<number, CommentRow[]>();
  if (threadIds.length > 0) {
    const cs = await db
      .select({
        threadId: reviewComments.threadId,
        createdAt: reviewComments.createdAt,
        authorId: reviewComments.authorId,
        excerpt: reviewComments.excerpt,
        body: reviewComments.body,
      })
      .from(reviewComments)
      .where(inArray(reviewComments.threadId, threadIds))
      .execute();
    for (const c of cs) {
      const arr = commentsByThread.get(c.threadId) ?? [];
      arr.push(c);
      commentsByThread.set(c.threadId, arr);
    }
  }

  // pr_comment events reference the pr_comments row directly (refId → body; no excerpt
  // column, so truncate the body — present in local mode, null under lean storage).
  const prCommentIds = rows
    .filter((r) => r.type === 'pr_comment' && r.refTable === 'pr_comments' && r.refId != null)
    .map((r) => r.refId as number);
  const prCommentBodyById = new Map<number, string | null>();
  if (prCommentIds.length > 0) {
    for (const c of await db
      .select({ id: prComments.id, body: prComments.body })
      .from(prComments)
      .where(inArray(prComments.id, prCommentIds))
      .execute())
      prCommentBodyById.set(c.id, c.body);
  }

  const referencedUsers = new Set<number>();
  const feedEvents: FeedEvent[] = rows.map((r) => {
    if (r.actorId != null) referencedUsers.add(r.actorId);
    let excerpt: string | null = null;
    if (r.type === 'review_comment' && r.refId != null) {
      const arr = commentsByThread.get(r.refId) ?? [];
      const match =
        arr.find(
          (c) => c.createdAt.getTime() === r.occurredAt.getTime() && c.authorId === r.actorId,
        ) ?? arr.find((c) => c.createdAt.getTime() === r.occurredAt.getTime());
      excerpt = match?.excerpt ?? (match?.body ? truncate(match.body, 160) : null);
    } else if (r.type === 'pr_comment' && r.refId != null) {
      const body = prCommentBodyById.get(r.refId) ?? null;
      excerpt = body ? truncate(body, 160) : null;
    }
    return {
      id: r.id,
      type: r.type as EventType,
      occurredAt: r.occurredAt.toISOString(),
      repoId: r.repoId,
      repoFullName: `${r.repoOwner}/${r.repoName}`,
      prId: r.prId,
      prNumber: r.prNumber ?? null,
      prTitle: r.prTitle ?? null,
      prState: (r.prState as PrState | null) ?? null,
      actorId: r.actorId,
      refId: r.refId,
      reviewState:
        r.type === 'review_submitted' && r.refId != null
          ? (reviewStateById.get(r.refId) ?? null)
          : null,
      excerpt,
    };
  });

  const users =
    referencedUsers.size > 0
      ? (
          await db
            .select()
            .from(schema.users)
            .where(inArray(schema.users.id, [...referencedUsers]))
            .execute()
        ).map(mapUser)
      : [];

  return { events: feedEvents, users };
}

// ---- open PRs strip ----

export interface OpenPrsFilters {
  accountId: number;
  repoIds: number[] | null;
  userIds: number[] | null;
}

export async function getOpenPrs(filters: OpenPrsFilters): Promise<TimelinePr[]> {
  const conds = [
    eq(pullRequests.accountId, filters.accountId),
    eq(pullRequests.state, 'open'),
  ];
  if (filters.repoIds) conds.push(inArray(pullRequests.repoId, filters.repoIds));
  if (filters.userIds && filters.userIds.length > 0) {
    conds.push(inArray(pullRequests.authorId, filters.userIds));
  }
  const prRows = await db
    .select()
    .from(pullRequests)
    .where(and(...conds))
    .execute();

  const prs = await buildTimelinePrs(prRows, filters.accountId);
  const rank = (t: TimelinePr): number => REASON_PRIORITY.indexOf(t.reasonTag);
  return prs.sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    return a.openedAt.localeCompare(b.openedAt); // oldest first
  });
}

// ---- insights (per-repo sprint/team stats) ----

export interface InsightsFilters {
  accountId: number;
  repoIds: number[] | null;
}

const INSIGHTS_MERGED_WINDOW_DAYS = 7;
const INSIGHTS_REVIEW_WINDOW_DAYS = 30;
// The "avg time a PR stays open" trend spans this many days back from now, in
// weekly buckets (84 / 7 = 12 points).
const INSIGHTS_CHART_WINDOW_DAYS = 84;
const WEEK_MS = 7 * 86_400_000;

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

// Bucket PR cycle times (openMs→closeMs) into weekly points over the chart window,
// oldest first. Each point is the MEAN open-hours of the PRs that CLOSED that week;
// a week with no closed PRs yields a null average (a gap in the trend line).
function buildOpenDurationTrend(
  rows: { openMs: number; closeMs: number }[],
  windowStartMs: number,
  nowMs: number,
): InsightsTimePoint[] {
  const buckets = Math.round((nowMs - windowStartMs) / WEEK_MS);
  const sums = new Array<number>(buckets).fill(0);
  const counts = new Array<number>(buckets).fill(0);
  for (const r of rows) {
    if (r.closeMs < windowStartMs || r.closeMs > nowMs) continue;
    const hrs = (r.closeMs - r.openMs) / 3_600_000;
    if (hrs < 0) continue;
    const idx = Math.min(buckets - 1, Math.floor((r.closeMs - windowStartMs) / WEEK_MS));
    sums[idx]! += hrs;
    counts[idx]! += 1;
  }
  const out: InsightsTimePoint[] = [];
  for (let i = 0; i < buckets; i++) {
    const c = counts[i]!;
    out.push({
      bucketStart: new Date(windowStartMs + i * WEEK_MS).toISOString(),
      avgOpenHours: c > 0 ? Math.round((sums[i]! / c) * 10) / 10 : null,
      count: c,
    });
  }
  return out;
}

/**
 * Per-repo snapshot for the Insights panel. Counts (open/draft/stalled) are current
 * state; merged is a 7-day window; time-to-first-review is a median over PRs opened
 * in the last 30 days that got a review. Per-repo only — no team aggregation yet.
 * Scoped to the account; `repoIds` narrows to the watched-repo selection.
 */
export async function getInsights(filters: InsightsFilters): Promise<InsightsResponse> {
  const { accountId, repoIds } = filters;
  const now = Date.now();
  const mergedCutoff = new Date(now - INSIGHTS_MERGED_WINDOW_DAYS * 86_400_000);
  const reviewCutoff = new Date(now - INSIGHTS_REVIEW_WINDOW_DAYS * 86_400_000);
  const chartWindowStartMs = now - INSIGHTS_CHART_WINDOW_DAYS * 86_400_000;
  const base: Omit<InsightsResponse, 'repos'> = {
    mergedWindowDays: INSIGHTS_MERGED_WINDOW_DAYS,
    reviewWindowDays: INSIGHTS_REVIEW_WINDOW_DAYS,
    stallThresholdDays: config.stallThresholdDays,
    chartWindowDays: INSIGHTS_CHART_WINDOW_DAYS,
    generatedAt: new Date().toISOString(),
  };

  const reposAll = await listRepos(accountId);
  const repos = repoIds ? reposAll.filter((r) => repoIds.includes(r.id)) : reposAll;
  if (repos.length === 0) return { ...base, repos: [] };
  const repoIdSet = new Set(repos.map((r) => r.id));

  // Open PRs for these repos (one query → open/draft/stalled/oldest-unreviewed).
  const openConds = [eq(pullRequests.accountId, accountId), eq(pullRequests.state, 'open')];
  if (repoIds) openConds.push(inArray(pullRequests.repoId, repoIds));
  const openRows = await db.select().from(pullRequests).where(and(...openConds)).execute();
  const counts = await buildThreadCounts(openRows.map((p) => p.id));

  // Merged in the window (count per repo).
  const mergedConds = [
    eq(pullRequests.accountId, accountId),
    eq(pullRequests.state, 'merged'),
    gte(pullRequests.mergedAt, mergedCutoff),
  ];
  if (repoIds) mergedConds.push(inArray(pullRequests.repoId, repoIds));
  const mergedRows = await db
    .select({ repoId: pullRequests.repoId })
    .from(pullRequests)
    .where(and(...mergedConds))
    .execute();
  const mergedByRepo = new Map<number, number>();
  for (const r of mergedRows) mergedByRepo.set(r.repoId, (mergedByRepo.get(r.repoId) ?? 0) + 1);

  // PRs closed/merged within the chart window, for the per-repo "avg time open"
  // trend. A merged PR's close instant is mergedAt; a plain-closed one's is closedAt.
  const chartCutoff = new Date(chartWindowStartMs);
  const closedConds = [
    eq(pullRequests.accountId, accountId),
    inArray(pullRequests.state, ['merged', 'closed']),
    or(gte(pullRequests.mergedAt, chartCutoff), gte(pullRequests.closedAt, chartCutoff)),
  ];
  if (repoIds) closedConds.push(inArray(pullRequests.repoId, repoIds));
  const closedRows = await db
    .select({
      repoId: pullRequests.repoId,
      openedAt: pullRequests.openedAt,
      mergedAt: pullRequests.mergedAt,
      closedAt: pullRequests.closedAt,
    })
    .from(pullRequests)
    .where(and(...closedConds))
    .execute();
  const closedByRepo = new Map<number, { openMs: number; closeMs: number }[]>();
  for (const r of closedRows) {
    const close = r.mergedAt ?? r.closedAt;
    if (!close) continue;
    const arr = closedByRepo.get(r.repoId) ?? [];
    arr.push({ openMs: r.openedAt.getTime(), closeMs: close.getTime() });
    closedByRepo.set(r.repoId, arr);
  }

  // Time-to-first-review samples: PRs opened in the review window with a first review.
  const ttfrConds = [
    eq(pullRequests.accountId, accountId),
    gte(pullRequests.openedAt, reviewCutoff),
    isNotNull(pullRequests.firstReviewAt),
  ];
  if (repoIds) ttfrConds.push(inArray(pullRequests.repoId, repoIds));
  const ttfrRows = await db
    .select({
      repoId: pullRequests.repoId,
      openedAt: pullRequests.openedAt,
      firstReviewAt: pullRequests.firstReviewAt,
    })
    .from(pullRequests)
    .where(and(...ttfrConds))
    .execute();
  const ttfrByRepo = new Map<number, number[]>();
  for (const r of ttfrRows) {
    if (!r.firstReviewAt) continue;
    const hrs = (r.firstReviewAt.getTime() - r.openedAt.getTime()) / 3_600_000;
    if (hrs < 0) continue;
    const arr = ttfrByRepo.get(r.repoId) ?? [];
    arr.push(hrs);
    ttfrByRepo.set(r.repoId, arr);
  }

  // Pending review-requests per reviewer, for OPEN PRs only (the review-load signal).
  const rrRows = await db
    .select({ repoId: pullRequests.repoId, userId: schema.reviewRequests.userId })
    .from(schema.reviewRequests)
    .innerJoin(pullRequests, eq(pullRequests.id, schema.reviewRequests.prId))
    .where(
      and(
        eq(pullRequests.accountId, accountId),
        eq(pullRequests.state, 'open'),
        isNotNull(schema.reviewRequests.userId),
      ),
    )
    .execute();
  const reviewLoadByRepo = new Map<number, Map<number, number>>();
  for (const r of rrRows) {
    if (r.userId == null || !repoIdSet.has(r.repoId)) continue;
    const m = reviewLoadByRepo.get(r.repoId) ?? new Map<number, number>();
    m.set(r.userId, (m.get(r.userId) ?? 0) + 1);
    reviewLoadByRepo.set(r.repoId, m);
  }

  const OPEN_LIST_CAP = 100; // bound the payload for a pathologically busy repo
  const repoInsights: RepoInsights[] = repos.map((repo) => {
    const repoOpen = openRows.filter((p) => p.repoId === repo.id);
    const [owner, name] = repo.fullName.split('/');
    const stalledOf = (p: (typeof repoOpen)[number]): boolean =>
      isStalled(
        { state: p.state as PrState, lastCommitAt: p.lastCommitAt },
        counts.get(p.id) ?? emptyCounts(),
      );
    const unreviewed = repoOpen
      .filter((p) => !p.isDraft && p.firstReviewAt == null)
      .sort((a, b) => a.openedAt.getTime() - b.openedAt.getTime());
    const oldest = unreviewed[0];
    // The full open-PR list (oldest first), independent of timeline filters; the
    // client toggles stale visibility off the per-row flag.
    const openPrList: InsightsOpenPr[] = [...repoOpen]
      .sort((a, b) => a.openedAt.getTime() - b.openedAt.getTime())
      .slice(0, OPEN_LIST_CAP)
      .map((p) => ({
        prId: p.id,
        number: p.number,
        title: p.title,
        authorId: p.authorId,
        isDraft: p.isDraft,
        isStalled: stalledOf(p),
        openedAt: p.openedAt.toISOString(),
        githubUrl: `https://github.com/${owner}/${name}/pull/${p.number}`,
      }));
    const med = median(ttfrByRepo.get(repo.id) ?? []);
    const reviewLoad = [...(reviewLoadByRepo.get(repo.id) ?? new Map<number, number>()).entries()]
      .map(([userId, pending]) => ({ userId, pending }))
      .sort((a, b) => b.pending - a.pending)
      .slice(0, 5);
    return {
      repoId: repo.id,
      repoFullName: repo.fullName,
      openPrs: repoOpen.filter((p) => !p.isDraft).length,
      draftPrs: repoOpen.filter((p) => p.isDraft).length,
      mergedLast7d: mergedByRepo.get(repo.id) ?? 0,
      stalledPrs: repoOpen.filter(stalledOf).length,
      medianHoursToFirstReview: med == null ? null : Math.round(med * 10) / 10,
      oldestUnreviewed: oldest
        ? {
            prId: oldest.id,
            number: oldest.number,
            title: oldest.title,
            openedAt: oldest.openedAt.toISOString(),
            githubUrl: `https://github.com/${owner}/${name}/pull/${oldest.number}`,
          }
        : null,
      reviewLoad,
      openPrList,
      openDurationTrend: buildOpenDurationTrend(
        closedByRepo.get(repo.id) ?? [],
        chartWindowStartMs,
        now,
      ),
    };
  });

  return { ...base, repos: repoInsights };
}

// Heavier per-repo analytics for the drill-down panel — computed on demand (only
// when the panel opens). All series cover the last INSIGHTS_CHART_WINDOW_DAYS in
// weekly buckets, except the distributions (categorical), the size/cycle scatter,
// and the weekday×hour heatmap. Scoped to the account; returns null when the repo
// isn't owned by the account (→ 404 at the route).
export async function getRepoAnalytics(
  accountId: number,
  repoId: number,
): Promise<RepoAnalytics | null> {
  const repo = await getRepo(repoId, accountId);
  if (!repo) return null;

  const now = Date.now();
  const windowDays = INSIGHTS_CHART_WINDOW_DAYS;
  const windowStartMs = now - windowDays * 86_400_000;
  const windowStart = new Date(windowStartMs);
  const nBuckets = Math.round((now - windowStartMs) / WEEK_MS);
  const weekBuckets: string[] = [];
  for (let i = 0; i < nBuckets; i++) {
    weekBuckets.push(new Date(windowStartMs + i * WEEK_MS).toISOString());
  }
  const zeros = (): number[] => new Array<number>(nBuckets).fill(0);
  const bi = (ms: number): number =>
    Math.max(0, Math.min(nBuckets - 1, Math.floor((ms - windowStartMs) / WEEK_MS)));
  const inWin = (ms: number): boolean => ms >= windowStartMs && ms <= now;
  const inc = (arr: number[], i: number): void => {
    arr[i] = (arr[i] ?? 0) + 1;
  };
  const addv = (arr: number[], i: number, v: number): void => {
    arr[i] = (arr[i] ?? 0) + v;
  };

  // ---- PRs relevant to the window: opened/closed in window, or still open ----
  const prRows = await db
    .select({
      number: pullRequests.number,
      openedAt: pullRequests.openedAt,
      firstReviewAt: pullRequests.firstReviewAt,
      mergedAt: pullRequests.mergedAt,
      closedAt: pullRequests.closedAt,
      lastCommitAt: pullRequests.lastCommitAt,
      additions: pullRequests.additions,
      deletions: pullRequests.deletions,
    })
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.accountId, accountId),
        eq(pullRequests.repoId, repoId),
        or(
          and(isNull(pullRequests.mergedAt), isNull(pullRequests.closedAt)),
          gte(pullRequests.openedAt, windowStart),
          gte(pullRequests.mergedAt, windowStart),
          gte(pullRequests.closedAt, windowStart),
        ),
      ),
    )
    .execute();

  const opened = zeros();
  const mergedSeries = zeros();
  const closedSeries = zeros();
  const open = zeros();
  const stalled = zeros();
  const stallMs = config.stallThresholdDays * 86_400_000;
  const ttfrByBucket: number[][] = Array.from({ length: nBuckets }, () => []);
  const cbA = zeros();
  const cbB = zeros();
  const cbN = zeros();
  const LAT_BINS = [
    { label: '<1h', max: 1 },
    { label: '1–4h', max: 4 },
    { label: '4–24h', max: 24 },
    { label: '1–3d', max: 72 },
    { label: '>3d', max: Infinity },
  ];
  const latCounts = new Array<number>(LAT_BINS.length).fill(0);
  const SIZE_BINS = [
    { label: 'XS <10', max: 10 },
    { label: 'S <50', max: 50 },
    { label: 'M <200', max: 200 },
    { label: 'L <500', max: 500 },
    { label: 'XL 500+', max: Infinity },
  ];
  const sizeCounts = new Array<number>(SIZE_BINS.length).fill(0);
  const binOf = (bins: { max: number }[], v: number): number => {
    for (let b = 0; b < bins.length; b++) if (v < bins[b]!.max) return b;
    return bins.length - 1;
  };
  const sizeVsCycle: SizeCyclePoint[] = [];
  // Time-open samples per LOC bucket, over ALL PRs closed in the window (uncapped,
  // unlike sizeVsCycle), for the median-by-size view.
  const sizeBucketDur: number[][] = SIZE_BINS.map(() => []);

  for (const p of prRows) {
    const oMs = p.openedAt.getTime();
    const closeDate = p.mergedAt ?? p.closedAt;
    const cMs = closeDate ? closeDate.getTime() : null;

    if (inWin(oMs)) inc(opened, bi(oMs));
    if (p.mergedAt && inWin(p.mergedAt.getTime())) inc(mergedSeries, bi(p.mergedAt.getTime()));
    if (!p.mergedAt && p.closedAt && inWin(p.closedAt.getTime())) {
      inc(closedSeries, bi(p.closedAt.getTime()));
    }

    // Backlog: was this PR open at each week's end, and stalled (no recent commit)?
    for (let i = 0; i < nBuckets; i++) {
      const snap = Math.min(windowStartMs + (i + 1) * WEEK_MS, now);
      if (oMs <= snap && (cMs == null || cMs > snap)) {
        inc(open, i);
        const lastAct = p.lastCommitAt ? p.lastCommitAt.getTime() : oMs;
        if (lastAct < snap - stallMs) inc(stalled, i);
      }
    }

    if (p.firstReviewAt && inWin(oMs)) {
      const hrs = (p.firstReviewAt.getTime() - oMs) / 3_600_000;
      if (hrs >= 0) ttfrByBucket[bi(oMs)]!.push(hrs);
    }
    if (p.firstReviewAt && inWin(p.firstReviewAt.getTime())) {
      const hrs = (p.firstReviewAt.getTime() - oMs) / 3_600_000;
      if (hrs >= 0) latCounts[binOf(LAT_BINS, hrs)]!++;
    }
    if (cMs != null && inWin(cMs)) {
      const total = (cMs - oMs) / 3_600_000;
      if (total >= 0) {
        const idx = bi(cMs);
        inc(cbN, idx);
        if (p.firstReviewAt) {
          addv(cbA, idx, Math.max(0, (p.firstReviewAt.getTime() - oMs) / 3_600_000));
          addv(cbB, idx, Math.max(0, (cMs - p.firstReviewAt.getTime()) / 3_600_000));
        } else {
          addv(cbA, idx, total);
        }
        const loc = p.additions + p.deletions;
        sizeVsCycle.push({
          prNumber: p.number,
          loc,
          hoursOpen: Math.round(total * 10) / 10,
          merged: p.mergedAt != null,
        });
        sizeBucketDur[binOf(SIZE_BINS, loc)]!.push(total);
      }
    }
    if (inWin(oMs)) sizeCounts[binOf(SIZE_BINS, p.additions + p.deletions)]!++;
  }

  // ---- reviews in window: verdict mix + per-reviewer load ----
  const reviewRows = await db
    .select({
      reviewerId: reviews.authorId,
      state: reviews.state,
      submittedAt: reviews.submittedAt,
    })
    .from(reviews)
    .innerJoin(pullRequests, eq(pullRequests.id, reviews.prId))
    .where(
      and(
        eq(pullRequests.accountId, accountId),
        eq(pullRequests.repoId, repoId),
        gte(reviews.submittedAt, windowStart),
      ),
    )
    .execute();
  const verdicts = {
    approved: zeros(),
    changes_requested: zeros(),
    commented: zeros(),
    dismissed: zeros(),
  };
  const reviewerWeekly = new Map<number, number[]>();
  for (const r of reviewRows) {
    const ms = r.submittedAt.getTime();
    if (!inWin(ms)) continue;
    const idx = bi(ms);
    if (r.state === 'approved') inc(verdicts.approved, idx);
    else if (r.state === 'changes_requested') inc(verdicts.changes_requested, idx);
    else if (r.state === 'commented') inc(verdicts.commented, idx);
    else if (r.state === 'dismissed') inc(verdicts.dismissed, idx);
    if (r.reviewerId != null) {
      const arr = reviewerWeekly.get(r.reviewerId) ?? zeros();
      inc(arr, idx);
      reviewerWeekly.set(r.reviewerId, arr);
    }
  }
  const reviewerEntries = [...reviewerWeekly.entries()]
    .map(([userId, weekly]) => ({ userId, weekly, total: weekly.reduce((a, b) => a + b, 0) }))
    .sort((a, b) => b.total - a.total);
  const TOP_REVIEWERS = 6;
  const reviewerLoad: ReviewerLoadSeries[] = reviewerEntries
    .slice(0, TOP_REVIEWERS)
    .map((e) => ({ userId: e.userId, total: e.total, weekly: e.weekly }));
  const rest = reviewerEntries.slice(TOP_REVIEWERS);
  if (rest.length > 0) {
    const otherWeekly = zeros();
    for (const e of rest) for (let i = 0; i < nBuckets; i++) addv(otherWeekly, i, e.weekly[i] ?? 0);
    reviewerLoad.push({
      userId: -1,
      total: otherWeekly.reduce((a, b) => a + b, 0),
      weekly: otherWeekly,
    });
  }

  // ---- review threads in window: derived-state mix by createdAt week ----
  const threadRows = await db
    .select({ state: reviewThreads.derivedState, createdAt: reviewThreads.createdAt })
    .from(reviewThreads)
    .innerJoin(pullRequests, eq(pullRequests.id, reviewThreads.prId))
    .where(
      and(
        eq(pullRequests.accountId, accountId),
        eq(pullRequests.repoId, repoId),
        gte(reviewThreads.createdAt, windowStart),
      ),
    )
    .execute();
  const threadMix = {
    resolved: zeros(),
    likely_addressed: zeros(),
    replied_unresolved: zeros(),
    untouched: zeros(),
  };
  for (const t of threadRows) {
    const ms = t.createdAt.getTime();
    if (!inWin(ms)) continue;
    inc(threadMix[t.state], bi(ms));
  }

  // ---- activity heatmap: events by weekday×hour (UTC) ----
  const eventRows = await db
    .select({ occurredAt: events.occurredAt })
    .from(events)
    .where(
      and(
        eq(events.accountId, accountId),
        eq(events.repoId, repoId),
        gte(events.occurredAt, windowStart),
      ),
    )
    .execute();
  const activityHeatmap = new Array<number>(168).fill(0);
  for (const e of eventRows) {
    const d = e.occurredAt;
    if (!inWin(d.getTime())) continue;
    activityHeatmap[d.getUTCDay() * 24 + d.getUTCHours()]!++;
  }

  const round1 = (x: number): number => Math.round(x * 10) / 10;
  return {
    repoId: repo.id,
    repoFullName: repo.fullName,
    windowDays,
    stallThresholdDays: config.stallThresholdDays,
    generatedAt: new Date().toISOString(),
    weekBuckets,
    throughput: { opened, merged: mergedSeries, closed: closedSeries },
    backlog: { open, stalled },
    reviewLatencyTrend: {
      medianHours: ttfrByBucket.map((a) => {
        const m = median(a);
        return m == null ? null : round1(m);
      }),
      count: ttfrByBucket.map((a) => a.length),
    },
    cycleBreakdown: {
      toFirstReview: cbA.map((s, i) => (cbN[i] ? round1(s / cbN[i]!) : 0)),
      reviewToMerge: cbB.map((s, i) => (cbN[i] ? round1(s / cbN[i]!) : 0)),
      count: cbN,
    },
    reviewLatencyDist: LAT_BINS.map((b, i): AnalyticsBin => ({ label: b.label, count: latCounts[i]! })),
    threadMix,
    reviewVerdicts: verdicts,
    reviewerLoad,
    sizeDist: SIZE_BINS.map((b, i): AnalyticsBin => ({ label: b.label, count: sizeCounts[i]! })),
    sizeVsCycle: sizeVsCycle.slice(0, 500),
    sizeCycleByBucket: SIZE_BINS.map((b, i): SizeCycleBucket => {
      const arr = sizeBucketDur[i]!;
      const m = median(arr);
      return { label: b.label, medianHours: m == null ? null : round1(m), count: arr.length };
    }),
    activityHeatmap,
  };
}

// ---- merge-rights inference ----

// Distinct users who have merged a PR INTO THE DEFAULT BRANCH per repo (across
// ALL synced history, not the timeline window). We treat "has merged into the
// repo's default branch" as a good-enough proxy for "is a maintainer" — merges
// into feature/integration branches don't count, since write access to a side
// branch isn't the same signal as landing changes on main.
//
// Backward-compat: mergedById / baseRefName / defaultBranch are only populated by
// syncs that ran after they were added, so older rows have nulls. We count a
// merge UNLESS we positively know it targeted a non-default branch (i.e. both the
// repo's default branch and the PR's base branch are known and differ). This
// keeps already-synced repos populated and tightens to default-only as they
// re-sync. Repos never (deep-)re-synced for mergedById stay empty regardless.
export async function getMergers(accountId: number): Promise<RepoMergers[]> {
  const rows = await db
    .selectDistinct({ repoId: pullRequests.repoId, userId: pullRequests.mergedById })
    .from(pullRequests)
    .innerJoin(repos, eq(repos.id, pullRequests.repoId))
    .where(
      and(
        eq(repos.accountId, accountId),
        eq(pullRequests.state, 'merged'),
        isNotNull(pullRequests.mergedById),
        or(
          isNull(repos.defaultBranch),
          isNull(pullRequests.baseRefName),
          eq(pullRequests.baseRefName, repos.defaultBranch),
        ),
      ),
    )
    .execute();
  const byRepo = new Map<number, number[]>();
  for (const r of rows) {
    if (r.userId == null) continue;
    const arr = byRepo.get(r.repoId);
    if (arr) arr.push(r.userId);
    else byRepo.set(r.repoId, [r.userId]);
  }
  return [...byRepo.entries()].map(([repoId, userIds]) => ({ repoId, userIds }));
}

// ---- incremental review: pr_views ----

export async function markPrViewed(
  prId: number,
  accountId: number,
  sha?: string,
): Promise<boolean> {
  const prRows = await db
    .select({ id: pullRequests.id, headSha: pullRequests.headSha })
    .from(pullRequests)
    .where(
      and(eq(pullRequests.id, prId), eq(pullRequests.accountId, accountId)),
    )
    .limit(1)
    .execute();
  const pr = prRows[0] ?? null;
  if (!pr) return false;
  const viewedSha = sha ?? pr.headSha ?? null;
  const now = new Date();
  await db
    .insert(prViews)
    .values({ prId, lastViewedSha: viewedSha, lastViewedAt: now })
    .onConflictDoUpdate({
      target: prViews.prId,
      set: { lastViewedSha: viewedSha, lastViewedAt: now },
    })
    .execute();
  return true;
}

// Mark every currently-open PR (optionally repo-scoped) viewed at its head — the
// bulk "mark all seen" that clears all new-since badges at once. Account-scoped;
// returns how many PRs were stamped. Closed/merged PRs carry no new-since badge,
// so open is the set that matters. One transaction, one upsert per PR (portable
// across dialects; the open-PR set is bounded in practice).
export async function markAllViewed(
  accountId: number,
  repoIds: number[] | null,
): Promise<number> {
  const conds = [eq(pullRequests.accountId, accountId), eq(pullRequests.state, 'open')];
  if (repoIds) conds.push(inArray(pullRequests.repoId, repoIds));
  const rows = await db
    .select({ id: pullRequests.id, headSha: pullRequests.headSha })
    .from(pullRequests)
    .where(and(...conds))
    .execute();
  if (rows.length === 0) return 0;
  const now = new Date();
  await runTransaction(async (tx) => {
    for (const r of rows) {
      await tx
        .insert(prViews)
        .values({ prId: r.id, lastViewedSha: r.headSha ?? null, lastViewedAt: now })
        .onConflictDoUpdate({
          target: prViews.prId,
          set: { lastViewedSha: r.headSha ?? null, lastViewedAt: now },
        })
        .execute();
    }
  });
  return rows.length;
}

// ---- my turn ----

// Does this (kind, refId) actually belong to the account? Guards the dismiss
// insert so a buggy/hostile client can't seed orphan dismissal rows for ids it
// doesn't own (refId is a local PR/thread id). Defense-in-depth; the read path is
// already account-scoped.
async function ownsDismissRef(
  accountId: number,
  kind: MyTurnDismissKind,
  refId: number,
): Promise<boolean> {
  if (kind === 'review_request' || kind === 'watched_repo_pr') {
    // Both reference a PR id directly.
    const rows = await db
      .select({ id: pullRequests.id })
      .from(pullRequests)
      .where(and(eq(pullRequests.id, refId), eq(pullRequests.accountId, accountId)))
      .limit(1)
      .execute();
    return rows.length > 0;
  }
  if (kind === 'claude_review') {
    const rows = await db
      .select({ id: claudeReviews.id })
      .from(claudeReviews)
      .where(and(eq(claudeReviews.id, refId), eq(claudeReviews.accountId, accountId)))
      .limit(1)
      .execute();
    return rows.length > 0;
  }
  const rows = await db
    .select({ id: reviewThreads.id })
    .from(reviewThreads)
    .innerJoin(pullRequests, eq(pullRequests.id, reviewThreads.prId))
    .where(and(eq(reviewThreads.id, refId), eq(pullRequests.accountId, accountId)))
    .limit(1)
    .execute();
  return rows.length > 0;
}

export async function dismissMyTurn(
  accountId: number,
  kind: MyTurnDismissKind,
  refId: number,
): Promise<void> {
  // Skip silently if the ref isn't owned by this account (no-op anyway downstream).
  if (!(await ownsDismissRef(accountId, kind, refId))) return;
  const now = new Date();
  await db
    .insert(myTurnDismissals)
    .values({ accountId, kind, refId, dismissedAt: now })
    .onConflictDoUpdate({
      target: [myTurnDismissals.kind, myTurnDismissals.refId],
      set: { dismissedAt: now },
    })
    .execute();
}

// Un-dismiss a "Done" entry: delete its dismissal so it returns to the inbox.
// Scoped by accountId (defence-in-depth; refId is already account-unique).
export async function undismissMyTurn(
  accountId: number,
  kind: MyTurnDismissKind,
  refId: number,
): Promise<void> {
  await db
    .delete(myTurnDismissals)
    .where(
      and(
        eq(myTurnDismissals.accountId, accountId),
        eq(myTurnDismissals.kind, kind),
        eq(myTurnDismissals.refId, refId),
      ),
    )
    .execute();
}

// The My Turn "Done" tab: entries the user dismissed within the past `daysBefore`
// days (default 90), newest-dismissed first. Covers the dismissal-backed kinds
// (review_request + thread + claude_review); "Your PRs" are cleared via mark-viewed,
// not a restorable dismissal. Rebuilds each entry by joining the dismissal's refId
// back to its PR / thread / Claude-review run. accountId-scoped throughout.
export async function getCompletedDismissals(
  accountId: number,
  daysBefore = 90,
): Promise<DismissedMyTurnResponse> {
  const cutoff = new Date(Date.now() - daysBefore * 24 * 60 * 60 * 1000);
  const dismissals = await db
    .select()
    .from(myTurnDismissals)
    .where(
      and(
        eq(myTurnDismissals.accountId, accountId),
        gte(myTurnDismissals.dismissedAt, cutoff),
      ),
    )
    .execute();
  if (dismissals.length === 0) return { items: [], users: [] };

  // The currently-actionable inbox (ignoring dismissals) — the source of truth for
  // whether each Done entry can actually be restored. An entry whose ref is no longer
  // in the matching set (PR merged/closed, thread resolved, Claude run superseded)
  // can't return to the inbox, so the UI shows a static reason instead of "To do".
  const actionable = await getActionableInboxIds(accountId);
  const prClosedReason = (state: PrState): string | null =>
    state === 'merged' ? 'PR merged' : state === 'closed' ? 'PR closed' : null;

  const reviewDismissals = dismissals.filter((d) => d.kind === 'review_request');
  const threadDismissals = dismissals.filter((d) => d.kind === 'thread');
  const watchedDismissals = dismissals.filter((d) => d.kind === 'watched_repo_pr');
  const claudeDismissals = dismissals.filter((d) => d.kind === 'claude_review');
  const items: DismissedItem[] = [];
  const referencedUsers = new Set<number>();

  // review_request dismissals → their PRs (account-scoped).
  if (reviewDismissals.length > 0) {
    const prRows = await db
      .select()
      .from(pullRequests)
      .innerJoin(repos, eq(repos.id, pullRequests.repoId))
      .where(
        and(
          eq(pullRequests.accountId, accountId),
          inArray(
            pullRequests.id,
            reviewDismissals.map((d) => d.refId),
          ),
        ),
      )
      .execute();
    const byId = new Map(prRows.map((r) => [r.pull_requests.id, r]));
    for (const d of reviewDismissals) {
      const row = byId.get(d.refId);
      if (!row) continue;
      const { pull_requests: pr, repos: repo } = row;
      if (pr.authorId != null) referencedUsers.add(pr.authorId);
      const restorable = actionable.reviewRequestPrIds.has(pr.id);
      items.push({
        kind: 'review_request',
        prId: pr.id,
        repoFullName: `${repo.owner}/${repo.name}`,
        number: pr.number,
        title: pr.title,
        authorId: pr.authorId,
        state: pr.state as PrState,
        openedAt: pr.openedAt.toISOString(),
        githubUrl: `https://github.com/${repo.owner}/${repo.name}/pull/${pr.number}`,
        dismissedAt: d.dismissedAt.toISOString(),
        restorable,
        ...(restorable
          ? {}
          : { reason: prClosedReason(pr.state as PrState) ?? 'No longer requested' }),
      });
    }
  }

  // watched_repo_pr dismissals → their PRs (account-scoped). Same shape as a
  // review_request dismissal, just a different kind tag.
  if (watchedDismissals.length > 0) {
    const prRows = await db
      .select()
      .from(pullRequests)
      .innerJoin(repos, eq(repos.id, pullRequests.repoId))
      .where(
        and(
          eq(pullRequests.accountId, accountId),
          inArray(
            pullRequests.id,
            watchedDismissals.map((d) => d.refId),
          ),
        ),
      )
      .execute();
    const byId = new Map(prRows.map((r) => [r.pull_requests.id, r]));
    for (const d of watchedDismissals) {
      const row = byId.get(d.refId);
      if (!row) continue;
      const { pull_requests: pr, repos: repo } = row;
      if (pr.authorId != null) referencedUsers.add(pr.authorId);
      // Restorable if still eligible for the watched section, OR if it has since
      // become a review request (restoring then surfaces it under "Awaiting review").
      const restorable =
        actionable.watchedPrIds.has(pr.id) ||
        actionable.reviewRequestPrIds.has(pr.id);
      items.push({
        kind: 'watched_repo_pr',
        prId: pr.id,
        repoFullName: `${repo.owner}/${repo.name}`,
        number: pr.number,
        title: pr.title,
        authorId: pr.authorId,
        state: pr.state as PrState,
        openedAt: pr.openedAt.toISOString(),
        githubUrl: `https://github.com/${repo.owner}/${repo.name}/pull/${pr.number}`,
        dismissedAt: d.dismissedAt.toISOString(),
        restorable,
        ...(restorable
          ? {}
          : { reason: prClosedReason(pr.state as PrState) ?? 'No longer new' }),
      });
    }
  }

  // thread dismissals → their review threads + parent PR + last reply.
  if (threadDismissals.length > 0) {
    const threadIds = threadDismissals.map((d) => d.refId);
    const threadRows = await db
      .select({ thread: reviewThreads, pr: pullRequests, repo: repos })
      .from(reviewThreads)
      .innerJoin(pullRequests, eq(pullRequests.id, reviewThreads.prId))
      .innerJoin(repos, eq(repos.id, pullRequests.repoId))
      .where(
        and(
          eq(pullRequests.accountId, accountId),
          inArray(reviewThreads.id, threadIds),
        ),
      )
      .execute();
    const byId = new Map(threadRows.map((r) => [r.thread.id, r]));
    const commentRows = await db
      .select()
      .from(reviewComments)
      .where(inArray(reviewComments.threadId, threadIds))
      .orderBy(asc(reviewComments.createdAt))
      .execute();
    const lastComment = new Map<number, (typeof commentRows)[number]>();
    for (const c of commentRows) lastComment.set(c.threadId, c); // asc → last wins
    for (const d of threadDismissals) {
      const row = byId.get(d.refId);
      if (!row) continue;
      const { thread, pr, repo } = row;
      const last = lastComment.get(thread.id);
      if (last?.authorId != null) referencedUsers.add(last.authorId);
      const restorable = actionable.threadIds.has(thread.id);
      const reason =
        (thread.derivedState as DerivedState) === 'resolved'
          ? 'Thread resolved'
          : (prClosedReason(pr.state as PrState) ?? 'No longer awaiting you');
      items.push({
        kind: 'thread',
        threadId: thread.id,
        prId: pr.id,
        repoFullName: `${repo.owner}/${repo.name}`,
        prNumber: pr.number,
        path: thread.path,
        line: thread.line,
        derivedState: thread.derivedState as DerivedState,
        lastReplyExcerpt:
          last?.excerpt ?? (last?.body ? truncate(last.body, 140) : ''),
        lastReplyAt: (last?.createdAt ?? thread.createdAt).toISOString(),
        lastReplyAuthorId: last?.authorId ?? null,
        githubUrl: `https://github.com/${repo.owner}/${repo.name}/pull/${pr.number}`,
        dismissedAt: d.dismissedAt.toISOString(),
        restorable,
        ...(restorable ? {} : { reason }),
      });
    }
  }

  // claude_review dismissals → their run + parent PR (account-scoped). History is
  // kept, so an old run still resolves even after a newer run superseded it.
  if (claudeDismissals.length > 0) {
    const reviewIds = claudeDismissals.map((d) => d.refId);
    const runRows = await db
      .select({
        reviewId: claudeReviews.id,
        prId: claudeReviews.prId,
        owner: repos.owner,
        name: repos.name,
        prNumber: pullRequests.number,
        prTitle: pullRequests.title,
        prState: pullRequests.state,
        verdict: claudeReviews.verdict,
      })
      .from(claudeReviews)
      .innerJoin(pullRequests, eq(pullRequests.id, claudeReviews.prId))
      .innerJoin(repos, eq(repos.id, pullRequests.repoId))
      .where(
        and(
          eq(claudeReviews.accountId, accountId),
          inArray(claudeReviews.id, reviewIds),
        ),
      )
      .execute();
    const byId = new Map(runRows.map((r) => [r.reviewId, r]));
    for (const d of claudeDismissals) {
      const r = byId.get(d.refId);
      if (!r) continue;
      const restorable = actionable.claudeReviewIds.has(r.reviewId);
      items.push({
        kind: 'claude_review',
        reviewId: r.reviewId,
        prId: r.prId,
        repoFullName: `${r.owner}/${r.name}`,
        prNumber: r.prNumber,
        prTitle: r.prTitle,
        verdict: r.verdict,
        githubUrl: `https://github.com/${r.owner}/${r.name}/pull/${r.prNumber}`,
        dismissedAt: d.dismissedAt.toISOString(),
        restorable,
        ...(restorable
          ? {}
          : { reason: prClosedReason(r.prState as PrState) ?? 'Superseded' }),
      });
    }
  }

  // Newest-dismissed first.
  items.sort((a, b) => b.dismissedAt.localeCompare(a.dismissedAt));

  const usersList =
    referencedUsers.size > 0
      ? (
          await db
            .select()
            .from(users)
            .where(inArray(users.id, [...referencedUsers]))
            .execute()
        ).map(mapUser)
      : [];
  return { items, users: usersList };
}

function truncate(s: string, n: number): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > n ? `${oneLine.slice(0, n - 1)}…` : oneLine;
}

function summariseNew(n: NewSinceLastViewed): string {
  const parts: string[] = [];
  if (n.comments > 0)
    parts.push(`${n.comments} new comment${n.comments === 1 ? '' : 's'}`);
  if (n.reviews > 0)
    parts.push(`${n.reviews} new review${n.reviews === 1 ? '' : 's'}`);
  if (n.commits > 0)
    parts.push(`${n.commits} new commit${n.commits === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

// Watched-repo inbox eligibility, IGNORING dismissals and the cross-section dedupe:
// the set of open-PR ids that qualify for the "New PRs in watched repos" section
// (repo watched, opened on/after the watch began, authored by a non-bot human other
// than you, non-draft). Shared by getMyTurn (which then layers dismissals + dedupe)
// and getActionableInboxIds (restorability of a Done entry).
async function getWatchedActionablePrIds(
  accountId: number,
  localUserId: number,
  open: TimelinePr[],
  openRows: PrRow[],
): Promise<Set<number>> {
  const watchedRepos = await db
    .select({ repoId: repos.id, startedAt: repos.inboxWatchStartedAt })
    .from(repos)
    .where(and(eq(repos.accountId, accountId), eq(repos.inboxWatch, true)))
    .execute();
  const watchStartByRepo = new Map<number, Date>();
  for (const w of watchedRepos) {
    // A watched row should always carry a start; if it somehow doesn't, treat the
    // repo as not-watched (show nothing) rather than flooding the inbox.
    if (w.startedAt != null) watchStartByRepo.set(w.repoId, w.startedAt);
  }
  const out = new Set<number>();
  if (watchStartByRepo.size === 0) return out;
  const botUserIds = new Set(
    (
      await db
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.isBot, true))
        .execute()
    ).map((u) => u.id),
  );
  const rowById = new Map(openRows.map((p) => [p.id, p]));
  for (const t of open) {
    const startedAt = watchStartByRepo.get(t.repoId);
    if (startedAt == null) continue;
    if (t.authorId == null || t.authorId === localUserId) continue;
    if (botUserIds.has(t.authorId)) continue;
    const m = rowById.get(t.id);
    if (!m || m.isDraft) continue;
    if (m.openedAt.getTime() >= startedAt.getTime()) out.add(t.id);
  }
  return out;
}

// The inbox's actionable ids per kind, IGNORING dismissals — i.e. everything that
// COULD be in "My Turn" if nothing were dismissed. The single source of truth for
// whether a dismissed "Done" entry is restorable: removing its dismissal returns it
// to the inbox iff its ref is still in the matching set here. Reuses the same
// building blocks getMyTurn does (reviewRequestedFromMe, getWatchedActionablePrIds,
// getThreadsAwaiting, getUnactionedClaudeReviews) so the two never drift.
async function getActionableInboxIds(accountId: number): Promise<{
  reviewRequestPrIds: Set<number>;
  watchedPrIds: Set<number>;
  threadIds: Set<number>;
  claudeReviewIds: Set<number>;
}> {
  const localUserId = await getAccountUserId(accountId);
  const empty = {
    reviewRequestPrIds: new Set<number>(),
    watchedPrIds: new Set<number>(),
    threadIds: new Set<number>(),
    claudeReviewIds: new Set<number>(),
  };
  if (localUserId == null) return empty;

  const openRows = await db
    .select()
    .from(pullRequests)
    .where(and(eq(pullRequests.accountId, accountId), eq(pullRequests.state, 'open')))
    .execute();
  const open = await buildTimelinePrs(openRows, accountId);

  const reviewRequestPrIds = new Set(
    open.filter((t) => t.reviewRequestedFromMe).map((t) => t.id),
  );
  const watchedPrIds = await getWatchedActionablePrIds(
    accountId,
    localUserId,
    open,
    openRows,
  );

  const repoNameById = new Map<number, string>();
  for (const r of await listRepos(accountId)) repoNameById.set(r.id, r.fullName);
  const threadIds = new Set(
    (await getThreadsAwaiting(localUserId, accountId, repoNameById)).map(
      (ta) => ta.threadId,
    ),
  );

  const claudeReviewIds = config.claudeReviewEnabled
    ? new Set((await getUnactionedClaudeReviews(accountId)).map((c) => c.reviewId))
    : new Set<number>();

  return { reviewRequestPrIds, watchedPrIds, threadIds, claudeReviewIds };
}

export async function getMyTurn(accountId: number): Promise<MyTurnResponse> {
  const localUserId = await getAccountUserId(accountId);
  const empty: MyTurnResponse = {
    awaitingReview: [],
    yourPrs: [],
    threadsAwaiting: [],
    watchedRepoPrs: [],
    claudeReviewsToAction: [],
    users: [],
  };
  if (localUserId == null) return empty;

  const referencedUsers = new Set<number>();

  // Open PRs, enriched with triage, are the basis for sections 1 & 2.
  const openRows = await db
    .select()
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.accountId, accountId),
        eq(pullRequests.state, 'open'),
      ),
    )
    .execute();
  const open = await buildTimelinePrs(openRows, accountId);
  const repoNameById = new Map<number, string>();
  for (const r of await listRepos(accountId)) repoNameById.set(r.id, r.fullName);

  // Manual dismissals, honoured only until newer activity supersedes them.
  const dismissals = await db
    .select()
    .from(myTurnDismissals)
    .where(eq(myTurnDismissals.accountId, accountId))
    .execute();
  const reviewDismissedAt = new Map<number, Date>();
  const threadDismissedAt = new Map<number, Date>();
  // Dismissed Claude-review run ids. Keyed by run id (not PR id): a fresh run gets
  // a new id, so it naturally re-appears without a timestamp comparison.
  const claudeDismissedIds = new Set<number>();
  // Dismissed watched-repo PR ids. Sticky: a dismissal removes that PR from the
  // watched section for good (no timestamp comparison — acknowledging a new PR).
  const watchedDismissedIds = new Set<number>();
  for (const d of dismissals) {
    if (d.kind === 'review_request') reviewDismissedAt.set(d.refId, d.dismissedAt);
    else if (d.kind === 'thread') threadDismissedAt.set(d.refId, d.dismissedAt);
    else if (d.kind === 'claude_review') claudeDismissedIds.add(d.refId);
    else if (d.kind === 'watched_repo_pr') watchedDismissedIds.add(d.refId);
  }

  const meta = (prId: number) =>
    openRows.find((p) => p.id === prId)!;

  const toMyTurnPr = (t: TimelinePr) => {
    const m = meta(t.id);
    const repoFullName = repoNameById.get(t.repoId) ?? `repo ${t.repoId}`;
    const [owner, name] = repoFullName.split('/');
    if (t.authorId != null) referencedUsers.add(t.authorId);
    return {
      prId: t.id,
      repoFullName,
      number: t.number,
      title: t.title,
      authorId: t.authorId,
      state: t.state,
      openedAt: t.openedAt,
      githubUrl: `https://github.com/${owner}/${name}/pull/${m.number}`,
    };
  };

  // 1. Awaiting your review. A dismissal sticks until the PR is updated again
  //    (e.g. new commits → re-review warranted).
  const awaitingReview = await Promise.all(
    open
      .filter((t) => t.reviewRequestedFromMe)
      .filter((t) => {
        const d = reviewDismissedAt.get(t.id);
        return !d || meta(t.id).updatedAt.getTime() > d.getTime();
      })
      .map(async (t) => {
        // otherReviewersRequested is recomputed via triage map; re-derive count.
        const others = await countOtherReviewers(t.id, localUserId);
        return { ...toMyTurnPr(t), alsoRequested: others };
      }),
  );

  // 2. Your PRs with new activity since you last looked.
  const yourPrs = open
    .filter(
      (t) =>
        t.authorId === localUserId &&
        t.newSinceLastViewed != null &&
        (t.newSinceLastViewed.comments > 0 ||
          t.newSinceLastViewed.reviews > 0 ||
          t.newSinceLastViewed.commits > 0),
    )
    .map((t) => ({
      ...toMyTurnPr(t),
      newSinceLastViewed: t.newSinceLastViewed!,
      summary: summariseNew(t.newSinceLastViewed!),
    }));

  // 2b. New open PRs in repos you've Watched. Built AFTER awaitingReview + yourPrs
  //     so those PRs aren't shown twice. Eligibility (opened on/after the watch
  //     began, by a non-bot human other than you, non-draft) is the shared
  //     getWatchedActionablePrIds; here we layer the cross-section dedupe + sticky
  //     dismissals on top.
  const watchedEligible = await getWatchedActionablePrIds(
    accountId,
    localUserId,
    open,
    openRows,
  );
  const inOtherSections = new Set<number>([
    ...awaitingReview.map((i) => i.prId),
    ...yourPrs.map((i) => i.prId),
  ]);
  const watchedRepoPrs = open
    .filter(
      (t) =>
        watchedEligible.has(t.id) &&
        !inOtherSections.has(t.id) &&
        !watchedDismissedIds.has(t.id),
    )
    .map((t) => toMyTurnPr(t))
    .sort((a, b) => b.openedAt.localeCompare(a.openedAt));

  // 3. Threads awaiting your response: you opened the thread, someone replied
  //    after you, and it isn't resolved. A dismissal sticks until a newer reply.
  const threadsAwaiting = (
    await getThreadsAwaiting(localUserId, accountId, repoNameById)
  ).filter((ta) => {
    const d = threadDismissedAt.get(ta.threadId);
    return !d || Date.parse(ta.lastReplyAt) > d.getTime();
  });
  for (const ta of threadsAwaiting) {
    if (ta.lastReplyAuthorId != null) referencedUsers.add(ta.lastReplyAuthorId);
  }

  // Completed-but-unactioned Claude reviews (local-only feature; empty otherwise).
  // A manual "Done" hides the run until a newer run finishes (see claudeDismissedIds).
  const claudeReviewsToAction = config.claudeReviewEnabled
    ? (await getUnactionedClaudeReviews(accountId)).filter(
        (c) => !claudeDismissedIds.has(c.reviewId),
      )
    : [];

  const users =
    referencedUsers.size > 0
      ? (
          await db
            .select()
            .from(schema.users)
            .where(inArray(schema.users.id, [...referencedUsers]))
            .execute()
        ).map(mapUser)
      : [];

  return {
    awaitingReview,
    yourPrs,
    threadsAwaiting,
    watchedRepoPrs,
    claudeReviewsToAction,
    users,
  };
}

async function countOtherReviewers(
  prId: number,
  localUserId: number,
): Promise<number> {
  const rows = await db
    .select({ userId: schema.reviewRequests.userId })
    .from(schema.reviewRequests)
    .where(eq(schema.reviewRequests.prId, prId))
    .execute();
  return rows.filter((r) => r.userId != null && r.userId !== localUserId).length;
}

async function getThreadsAwaiting(
  localUserId: number,
  accountId: number,
  repoNameById: Map<number, string>,
): Promise<ThreadAwaitingItem[]> {
  // Scope to the account by joining the thread → its PR → repo.
  const threadJoinRows = await db
    .select({
      id: reviewThreads.id,
      prId: reviewThreads.prId,
      path: reviewThreads.path,
      line: reviewThreads.line,
      derivedState: reviewThreads.derivedState,
    })
    .from(reviewThreads)
    .innerJoin(pullRequests, eq(pullRequests.id, reviewThreads.prId))
    .innerJoin(repos, eq(repos.id, pullRequests.repoId))
    .where(
      and(
        eq(repos.accountId, accountId),
        eq(reviewThreads.originalCommenterId, localUserId),
        sql`${reviewThreads.derivedState} != 'resolved'`,
      ),
    )
    .execute();
  const threads = threadJoinRows;
  if (threads.length === 0) return [];

  const prIds = [...new Set(threads.map((t) => t.prId))];
  const prRows = await db
    .select({ id: pullRequests.id, repoId: pullRequests.repoId, number: pullRequests.number })
    .from(pullRequests)
    .where(inArray(pullRequests.id, prIds))
    .execute();
  const prById = new Map(prRows.map((p) => [p.id, p]));

  // Batch-load the comments for every candidate thread in one query, ordered so
  // the last entry per thread is the most recent reply (avoids an N+1 loop).
  const threadIds = threads.map((t) => t.id);
  const allComments = await db
    .select()
    .from(reviewComments)
    .where(inArray(reviewComments.threadId, threadIds))
    .orderBy(asc(reviewComments.createdAt))
    .execute();
  const commentsByThread = new Map<number, typeof allComments>();
  for (const c of allComments) {
    const arr = commentsByThread.get(c.threadId) ?? [];
    arr.push(c);
    commentsByThread.set(c.threadId, arr);
  }

  const out: ThreadAwaitingItem[] = [];
  for (const t of threads) {
    const comments = commentsByThread.get(t.id) ?? [];
    const last = comments.at(-1);
    if (!last) continue;
    // Someone other than you must have had the last word.
    if (last.authorId === localUserId) continue;
    const pr = prById.get(t.prId);
    if (!pr) continue;
    const repoFullName = repoNameById.get(pr.repoId) ?? `repo ${pr.repoId}`;
    const [owner, name] = repoFullName.split('/');
    out.push({
      threadId: t.id,
      prId: t.prId,
      repoFullName,
      prNumber: pr.number,
      path: t.path,
      line: t.line,
      derivedState: t.derivedState,
      // Prefer the stored excerpt (always present, incl. lean mode); fall back to
      // truncating the full body for rows synced before the excerpt column existed.
      lastReplyExcerpt: last.excerpt ?? truncate(last.body ?? '', 140),
      lastReplyAt: last.createdAt.toISOString(),
      lastReplyAuthorId: last.authorId,
      githubUrl: `https://github.com/${owner}/${name}/pull/${pr.number}`,
    });
  }
  out.sort((a, b) => b.lastReplyAt.localeCompare(a.lastReplyAt));
  return out;
}

export async function getPrDetail(
  id: number,
  accountId: number,
): Promise<PrDetail | null> {
  const rows = await db
    .select()
    .from(pullRequests)
    .innerJoin(repos, eq(repos.id, pullRequests.repoId))
    .where(and(eq(pullRequests.id, id), eq(repos.accountId, accountId)))
    .limit(1)
    .execute();
  const row = rows[0] ?? null;
  if (!row) return null;
  const pr = row.pull_requests;
  const repo = row.repos;
  // Base for activity deep links; per-item anchors are appended below.
  const prUrl = `https://github.com/${repo.owner}/${repo.name}/pull/${pr.number}`;

  const threadRows = await db
    .select()
    .from(reviewThreads)
    .where(eq(reviewThreads.prId, id))
    .execute();
  const commentRows = await db
    .select()
    .from(reviewComments)
    .where(eq(reviewComments.prId, id))
    .orderBy(asc(reviewComments.createdAt))
    .execute();
  const reviewRows = await db
    .select()
    .from(reviews)
    .where(eq(reviews.prId, id))
    .orderBy(asc(reviews.submittedAt))
    .execute();
  const prCommentRows = await db
    .select()
    .from(prComments)
    .where(eq(prComments.prId, id))
    .orderBy(asc(prComments.createdAt))
    .execute();
  const commitRows = await db
    .select()
    .from(commits)
    .where(eq(commits.prId, id))
    .orderBy(asc(commits.committedAt))
    .execute();

  const commentsByThread = new Map<number, typeof commentRows>();
  for (const c of commentRows) {
    const arr = commentsByThread.get(c.threadId) ?? [];
    arr.push(c);
    commentsByThread.set(c.threadId, arr);
  }

  const threads: ThreadDetail[] = threadRows.map((t) => {
    const tComments = commentsByThread.get(t.id) ?? [];
    return {
      id: t.id,
      prId: t.prId,
      path: t.path,
      line: t.line,
      isResolved: t.isResolved,
      isOutdated: t.isOutdated,
      derivedState: t.derivedState,
      originalCommenterId: t.originalCommenterId,
      createdAt: t.createdAt.toISOString(),
      comments: tComments.map((c) => ({
        id: c.id,
        authorId: c.authorId,
        // Lean mode (cloud): full body is null until hydrated on demand; fall back
        // to the stored excerpt so the UI degrades gracefully.
        body: c.body ?? c.excerpt ?? '',
        diffHunk: c.diffHunk,
        createdAt: c.createdAt.toISOString(),
        url: c.databaseId ? `${prUrl}#discussion_r${c.databaseId}` : null,
      })),
      // Thread anchor = its first comment's #discussion_r.
      url: tComments[0]?.databaseId
        ? `${prUrl}#discussion_r${tComments[0].databaseId}`
        : null,
    };
  });

  const reviewsOut: ReviewDetail[] = reviewRows.map((r) => ({
    id: r.id,
    authorId: r.authorId,
    state: r.state as ReviewState,
    body: r.body,
    submittedAt: r.submittedAt.toISOString(),
    url: r.databaseId ? `${prUrl}#pullrequestreview-${r.databaseId}` : null,
  }));

  const commentsOut: PrCommentDetail[] = prCommentRows.map((c) => ({
    id: c.id,
    authorId: c.authorId,
    // Lean mode: null until hydrated on demand (no excerpt kept for PR comments).
    body: c.body ?? '',
    createdAt: c.createdAt.toISOString(),
    url: c.databaseId ? `${prUrl}#issuecomment-${c.databaseId}` : null,
  }));

  const commitsOut: CommitDetail[] = commitRows.map((c) => ({
    id: c.id,
    sha: c.sha,
    authorId: c.authorId,
    committerId: c.committerId,
    message: c.message,
    committedAt: c.committedAt.toISOString(),
  }));

  // Per-file diff breakdown for the "Changes" tab. Each links to the file's diff
  // in the PR's "Files changed" view (GitHub anchors by sha256(path)).
  const filesOut: PrFileChange[] = (pr.files ?? []).map((f) => ({
    path: f.path,
    additions: f.additions,
    deletions: f.deletions,
    githubUrl: `${prUrl}/files#diff-${diffAnchorId(f.path)}`,
  }));

  // Outstanding review requests (for the Checks/Overview tab).
  const reviewerRows = await db
    .select()
    .from(schema.reviewRequests)
    .where(eq(schema.reviewRequests.prId, id))
    .execute();
  const requestedReviewers: RequestedReviewer[] = reviewerRows.map((r) => ({
    userId: r.userId,
    teamName: r.teamName,
  }));

  // Gather referenced users for client-side lookup.
  const userIds = new Set<number>();
  if (pr.authorId) userIds.add(pr.authorId);
  for (const t of threads) if (t.originalCommenterId) userIds.add(t.originalCommenterId);
  for (const c of commentRows) if (c.authorId) userIds.add(c.authorId);
  for (const r of reviewRows) if (r.authorId) userIds.add(r.authorId);
  for (const c of prCommentRows) if (c.authorId) userIds.add(c.authorId);
  for (const c of commitRows) {
    if (c.authorId) userIds.add(c.authorId);
    if (c.committerId) userIds.add(c.committerId);
  }
  for (const r of reviewerRows) if (r.userId) userIds.add(r.userId);
  // A maintainer who only merged the PR (never authored/reviewed/commented) is
  // otherwise absent from userList, leaving "Merged by" unresolved.
  if (pr.mergedById) userIds.add(pr.mergedById);
  const userList =
    userIds.size > 0
      ? (
          await db
            .select()
            .from(users)
            .where(inArray(users.id, [...userIds]))
            .execute()
        ).map(mapUser)
      : [];

  const counts = (await buildThreadCounts([id])).get(id) ?? emptyCounts();

  // Incremental review: capture the last-viewed instant and what's happened
  // since. No "new" once a PR is closed/merged.
  const viewRows = await db
    .select()
    .from(prViews)
    .where(eq(prViews.prId, id))
    .limit(1)
    .execute();
  const view = viewRows[0] ?? null;
  const lastViewedAt = view?.lastViewedAt ?? null;
  let newSinceLastViewed: NewSinceLastViewed | null = null;
  if (pr.state === 'open' && lastViewedAt) {
    const since = await db
      .select({ type: events.type, occurredAt: events.occurredAt })
      .from(events)
      .where(and(eq(events.prId, id), gt(events.occurredAt, lastViewedAt)))
      .execute();
    const n: NewSinceLastViewed = { commits: 0, comments: 0, reviews: 0 };
    for (const e of since) {
      if (e.type === 'commit_pushed') n.commits += 1;
      else if (e.type === 'pr_comment' || e.type === 'review_comment') n.comments += 1;
      else if (e.type === 'review_submitted') n.reviews += 1;
    }
    newSinceLastViewed = n;
  }

  // Whether the viewer may approve this PR: WRITE+ permission on the repo AND not
  // the author. The approve route re-checks this server-side before posting.
  const viewerUserId = await getAccountUserId(accountId);
  const viewerCanApprove =
    viewerUserId != null &&
    viewerUserId !== pr.authorId &&
    ['WRITE', 'MAINTAIN', 'ADMIN'].includes(repo.viewerPermission ?? '');

  return {
    id: pr.id,
    repoId: pr.repoId,
    repoFullName: `${repo.owner}/${repo.name}`,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    authorId: pr.authorId,
    state: pr.state,
    isDraft: pr.isDraft,
    isStalled: isStalled(pr, counts),
    openedAt: pr.openedAt.toISOString(),
    firstReviewAt: iso(pr.firstReviewAt),
    lastCommitAt: iso(pr.lastCommitAt),
    mergedAt: iso(pr.mergedAt),
    mergedById: pr.mergedById,
    closedAt: iso(pr.closedAt),
    updatedAt: pr.updatedAt.toISOString(),
    githubUrl: prUrl,
    headSha: pr.headSha,
    ciStatus: (pr.ciStatus ?? 'unknown') as CiStatus,
    mergeable: (pr.mergeable ?? 'unknown') as Mergeable,
    mergeStateStatus: (pr.mergeStateStatus ?? 'unknown') as MergeStateStatus,
    labels: (pr.labels ?? []) as Label[],
    checkRuns: (pr.checkRuns ?? []) as CheckRun[],
    additions: pr.additions,
    deletions: pr.deletions,
    changedFilesCount: pr.changedFiles,
    files: filesOut,
    requestedReviewers,
    viewerCanApprove,
    threads,
    reviews: reviewsOut,
    comments: commentsOut,
    commits: commitsOut,
    users: userList,
    lastViewedAt: iso(lastViewedAt),
    newSinceLastViewed,
  };
}

export async function getThreadDetail(
  id: number,
  accountId: number,
): Promise<ThreadDetail | null> {
  const rows = await db
    .select()
    .from(reviewThreads)
    .innerJoin(pullRequests, eq(pullRequests.id, reviewThreads.prId))
    .innerJoin(repos, eq(repos.id, pullRequests.repoId))
    .where(and(eq(reviewThreads.id, id), eq(repos.accountId, accountId)))
    .limit(1)
    .execute();
  const row = rows[0] ?? null;
  if (!row) return null;
  const t = row.review_threads;
  const prUrl = `https://github.com/${row.repos.owner}/${row.repos.name}/pull/${row.pull_requests.number}`;
  const comments = await db
    .select()
    .from(reviewComments)
    .where(eq(reviewComments.threadId, id))
    .orderBy(asc(reviewComments.createdAt))
    .execute();
  return {
    id: t.id,
    prId: t.prId,
    path: t.path,
    line: t.line,
    isResolved: t.isResolved,
    isOutdated: t.isOutdated,
    derivedState: t.derivedState,
    originalCommenterId: t.originalCommenterId,
    createdAt: t.createdAt.toISOString(),
    comments: comments.map((c) => ({
      id: c.id,
      authorId: c.authorId,
      // Lean mode: null until hydrated; fall back to the stored excerpt.
      body: c.body ?? c.excerpt ?? '',
      diffHunk: c.diffHunk,
      createdAt: c.createdAt.toISOString(),
      url: c.databaseId ? `${prUrl}#discussion_r${c.databaseId}` : null,
    })),
    url: comments[0]?.databaseId
      ? `${prUrl}#discussion_r${comments[0].databaseId}`
      : null,
  };
}

export async function deleteRepo(id: number, accountId: number): Promise<boolean> {
  const repoRows = await db
    .select()
    .from(repos)
    .where(and(eq(repos.id, id), eq(repos.accountId, accountId)))
    .limit(1)
    .execute();
  if (!repoRows[0]) return false;

  // Remove dependents in FK-safe order.
  const prIdRows = await db
    .select({ id: pullRequests.id })
    .from(pullRequests)
    .where(eq(pullRequests.repoId, id))
    .execute();
  const prIds = prIdRows.map((r) => r.id);

  await runTransaction(async (tx) => {
    await tx.delete(events).where(eq(events.repoId, id)).execute();
    if (prIds.length > 0) {
      await tx.delete(reviewComments).where(inArray(reviewComments.prId, prIds)).execute();
      await tx.delete(reviewThreads).where(inArray(reviewThreads.prId, prIds)).execute();
      await tx.delete(prComments).where(inArray(prComments.prId, prIds)).execute();
      await tx.delete(reviews).where(inArray(reviews.prId, prIds)).execute();
      await tx.delete(commits).where(inArray(commits.prId, prIds)).execute();
      await tx
        .delete(schema.reviewRequests)
        .where(inArray(schema.reviewRequests.prId, prIds))
        .execute();
      await tx.delete(prViews).where(inArray(prViews.prId, prIds)).execute();
      // PR-keyed my-turn dismissals (review_request + watched_repo_pr) would otherwise
      // be left as inert orphans pointing at deleted PR ids — clear them. (thread /
      // claude_review dismissals key off other id spaces, so they are scoped out.)
      await tx
        .delete(myTurnDismissals)
        .where(
          and(
            eq(myTurnDismissals.accountId, accountId),
            inArray(myTurnDismissals.kind, ['review_request', 'watched_repo_pr']),
            inArray(myTurnDismissals.refId, prIds),
          ),
        )
        .execute();
      // Claude review runs + findings reference these PRs (FKs are ON), so clear
      // them before the PRs.
      const reviewIdRows = await tx
        .select({ id: claudeReviews.id })
        .from(claudeReviews)
        .where(inArray(claudeReviews.prId, prIds))
        .execute();
      const reviewIds = reviewIdRows.map((r) => r.id);
      if (reviewIds.length > 0) {
        await tx
          .delete(claudeReviewFindings)
          .where(inArray(claudeReviewFindings.reviewId, reviewIds))
          .execute();
      }
      await tx.delete(claudeReviews).where(inArray(claudeReviews.prId, prIds)).execute();
      await tx.delete(pullRequests).where(eq(pullRequests.repoId, id)).execute();
    }
    await tx.delete(syncState).where(eq(syncState.repoId, id)).execute();
    await tx.delete(repos).where(eq(repos.id, id)).execute();
  });
  return true;
}

// Toggle a repo's "Watch for inbox" flag (account-scoped → false/404 if not owned).
// First watch stamps inboxWatchStartedAt = now; unwatch keeps it; re-watch keeps the
// original (so the same PR window is restored). Returns false if the repo isn't found.
export async function setRepoInboxWatch(
  accountId: number,
  repoId: number,
  watch: boolean,
): Promise<boolean> {
  // Single atomic UPDATE (no read-then-write). On watch, COALESCE stamps the start
  // only when it's currently unset, so concurrent toggles can't overwrite the
  // original watch window; on unwatch, started_at is left untouched. Scoped by
  // accountId → returns false (→ 404) for a repo this account doesn't own.
  const updated = await db
    .update(repos)
    .set(
      watch
        ? {
            inboxWatch: true,
            inboxWatchStartedAt: sql`coalesce(${repos.inboxWatchStartedAt}, ${tsBound(new Date())})`,
          }
        : { inboxWatch: false },
    )
    .where(and(eq(repos.id, repoId), eq(repos.accountId, accountId)))
    .returning({ id: repos.id })
    .execute();
  return updated.length > 0;
}

// ---- Claude Review reads ----

type ClaudeReviewRow = typeof claudeReviews.$inferSelect;
type ClaudeFindingRow = typeof claudeReviewFindings.$inferSelect;

// GitHub anchors a file in the PR "Files changed" diff by the SHA-256 of its
// path; we expose it so a finding can deep-link into the PR diff.
function diffAnchorId(path: string): string {
  return createHash('sha256').update(path, 'utf8').digest('hex');
}

function mapFinding(r: ClaudeFindingRow): ClaudeFinding {
  return {
    id: r.id,
    reviewId: r.reviewId,
    path: r.path,
    line: r.line,
    side: r.side,
    diffAnchorId: diffAnchorId(r.path),
    severity: r.severity,
    title: r.title,
    body: r.body,
    editedBody: r.editedBody,
    suggestion: r.suggestion,
    diffHunk: r.diffHunk,
    anchored: r.anchored,
    included: r.included,
    postedAt: iso(r.postedAt),
    githubCommentId: r.githubCommentId,
    createdAt: r.createdAt.toISOString(),
  };
}

function mapReview(r: ClaudeReviewRow, findings: ClaudeFindingRow[]): ClaudeReview {
  return {
    id: r.id,
    prId: r.prId,
    headSha: r.headSha,
    status: r.status,
    model: r.model,
    scope: r.scope,
    reviewMode: r.reviewMode,
    routeReason: r.routeReason,
    summary: r.summary,
    verdict: r.verdict,
    userBody: r.userBody,
    userVerdict: r.userVerdict,
    costUsd: r.costUsd,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    numTurns: r.numTurns,
    error: r.error,
    excludedFiles: r.excludedFiles ?? [],
    postedReviewId: r.postedReviewId,
    postedAt: iso(r.postedAt),
    createdAt: r.createdAt.toISOString(),
    finishedAt: iso(r.finishedAt),
    findings: findings.map(mapFinding),
  };
}

export async function getClaudeReviewById(
  reviewId: number,
  accountId: number,
): Promise<ClaudeReview | null> {
  const rows = await db
    .select({ review: claudeReviews })
    .from(claudeReviews)
    .innerJoin(pullRequests, eq(pullRequests.id, claudeReviews.prId))
    .innerJoin(repos, eq(repos.id, pullRequests.repoId))
    .where(and(eq(claudeReviews.id, reviewId), eq(repos.accountId, accountId)))
    .limit(1)
    .execute();
  const row = rows[0]?.review ?? null;
  if (!row) return null;
  const findings = await db
    .select()
    .from(claudeReviewFindings)
    .where(eq(claudeReviewFindings.reviewId, reviewId))
    .orderBy(asc(claudeReviewFindings.id))
    .execute();
  return mapReview(row, findings);
}

// The most recent run for a PR (with findings), or null if never run.
export async function getLatestClaudeReview(
  prId: number,
  accountId: number,
): Promise<ClaudeReview | null> {
  const rows = await db
    .select({ id: claudeReviews.id })
    .from(claudeReviews)
    .innerJoin(pullRequests, eq(pullRequests.id, claudeReviews.prId))
    .innerJoin(repos, eq(repos.id, pullRequests.repoId))
    .where(and(eq(claudeReviews.prId, prId), eq(repos.accountId, accountId)))
    .orderBy(desc(claudeReviews.id))
    .limit(1)
    .execute();
  const row = rows[0] ?? null;
  if (!row) return null;
  return getClaudeReviewById(row.id, accountId);
}

// All runs for a PR (newest first), lighter shape for the history selector.
export async function listClaudeReviewHistory(
  prId: number,
  accountId: number,
): Promise<ClaudeReviewSummary[]> {
  const rows = await db
    .select({ review: claudeReviews })
    .from(claudeReviews)
    .innerJoin(pullRequests, eq(pullRequests.id, claudeReviews.prId))
    .innerJoin(repos, eq(repos.id, pullRequests.repoId))
    .where(and(eq(claudeReviews.prId, prId), eq(repos.accountId, accountId)))
    .orderBy(desc(claudeReviews.id))
    .execute();
  return rows.map(({ review: r }) => ({
    id: r.id,
    headSha: r.headSha,
    status: r.status,
    model: r.model,
    scope: r.scope,
    reviewMode: r.reviewMode,
    verdict: r.verdict,
    userVerdict: r.userVerdict,
    costUsd: r.costUsd,
    postedAt: iso(r.postedAt),
    createdAt: r.createdAt.toISOString(),
    finishedAt: iso(r.finishedAt),
  }));
}

// Cross-PR list of prior Claude reviews: ONE entry per PR = that PR's most-recent
// SUCCEEDED run, accountId-scoped, restricted to PRs still within the timeline
// window (open, or last touched within `backfillDays`), newest-first by finish
// time. Used by GET /api/claude-reviews to populate the "prior reviews" view.
export async function listAllClaudeReviews(
  accountId: number,
): Promise<ClaudeReviewListItem[]> {
  // Same window cutoff getTimeline uses for its overlap predicate (now − backfillDays).
  const cutoff = new Date(Date.now() - config.backfillDays * 24 * 60 * 60 * 1000);

  const rows = await db
    .select({
      reviewId: claudeReviews.id,
      prId: claudeReviews.prId,
      owner: repos.owner,
      name: repos.name,
      prNumber: pullRequests.number,
      prTitle: pullRequests.title,
      prState: pullRequests.state,
      summary: claudeReviews.summary,
      verdict: claudeReviews.verdict,
      headSha: claudeReviews.headSha,
      status: claudeReviews.status,
      createdAt: claudeReviews.createdAt,
      finishedAt: claudeReviews.finishedAt,
    })
    .from(claudeReviews)
    .innerJoin(pullRequests, eq(pullRequests.id, claudeReviews.prId))
    .innerJoin(repos, eq(repos.id, pullRequests.repoId))
    .where(
      and(
        eq(repos.accountId, accountId),
        eq(claudeReviews.status, 'succeeded'),
        or(
          eq(pullRequests.state, 'open'),
          gte(
            sql`coalesce(${pullRequests.mergedAt}, ${pullRequests.closedAt}, ${pullRequests.openedAt})`,
            tsBound(cutoff),
          ),
        ),
      ),
    )
    .orderBy(desc(claudeReviews.finishedAt), desc(claudeReviews.createdAt))
    .execute();

  // Keep the first (most-recent) succeeded run per PR. N is small (single local
  // user), so a JS pass is simpler and portable across both dialects.
  const seen = new Set<number>();
  const items: ClaudeReviewListItem[] = [];
  for (const r of rows) {
    if (seen.has(r.prId)) continue;
    seen.add(r.prId);
    items.push({
      reviewId: r.reviewId,
      prId: r.prId,
      repoFullName: `${r.owner}/${r.name}`,
      prNumber: r.prNumber,
      prTitle: r.prTitle,
      prState: r.prState,
      summary: r.summary,
      verdict: r.verdict,
      headSha: r.headSha,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
      finishedAt: iso(r.finishedAt),
    });
  }
  return items;
}

// Completed Claude reviews on OPEN PRs that haven't been actioned: each PR's
// MOST-RECENT succeeded run, kept only when it was never posted (postedAt null).
// Account-scoped. Feeds the My Turn "Claude reviews to action" section so finished
// reviews don't fall through the cracks.
export async function getUnactionedClaudeReviews(
  accountId: number,
): Promise<ClaudeReviewToAction[]> {
  const rows = await db
    .select({
      reviewId: claudeReviews.id,
      prId: claudeReviews.prId,
      owner: repos.owner,
      name: repos.name,
      prNumber: pullRequests.number,
      prTitle: pullRequests.title,
      verdict: claudeReviews.verdict,
      finishedAt: claudeReviews.finishedAt,
      postedAt: claudeReviews.postedAt,
      reviewHead: claudeReviews.headSha,
      prHead: pullRequests.headSha,
    })
    .from(claudeReviews)
    .innerJoin(pullRequests, eq(pullRequests.id, claudeReviews.prId))
    .innerJoin(repos, eq(repos.id, pullRequests.repoId))
    .where(
      and(
        eq(repos.accountId, accountId),
        eq(claudeReviews.status, 'succeeded'),
        eq(pullRequests.state, 'open'),
      ),
    )
    .orderBy(desc(claudeReviews.finishedAt), desc(claudeReviews.createdAt))
    .execute();

  const seen = new Set<number>(); // most-recent succeeded run per PR only
  const out: ClaudeReviewToAction[] = [];
  for (const r of rows) {
    if (seen.has(r.prId)) continue;
    seen.add(r.prId);
    if (r.postedAt != null) continue; // that latest run was already posted → actioned
    out.push({
      reviewId: r.reviewId,
      prId: r.prId,
      repoFullName: `${r.owner}/${r.name}`,
      prNumber: r.prNumber,
      prTitle: r.prTitle,
      verdict: r.verdict,
      finishedAt: iso(r.finishedAt),
      headStale: r.reviewHead !== r.prHead,
      githubUrl: `https://github.com/${r.owner}/${r.name}/pull/${r.prNumber}`,
    });
  }
  return out;
}

// Resolve a run to its repo/PR coordinates for posting. Returns the raw run row
// (with the un-serialized fields the post flow needs: headSha, status, userBody,
// userVerdict).
export interface ClaudeReviewContext {
  review: ClaudeReviewRow;
  owner: string;
  name: string;
  prNumber: number;
}

// A single finding plus its review's head SHA and PR coordinates, for posting it
// as a standalone inline comment.
export interface FindingPostContext {
  finding: ClaudeFindingRow;
  reviewId: number;
  reviewHeadSha: string;
  owner: string;
  name: string;
  prNumber: number;
}

export async function getFindingPostContext(
  findingId: number,
  accountId: number,
): Promise<FindingPostContext | null> {
  const rows = await db
    .select({
      finding: claudeReviewFindings,
      reviewId: claudeReviews.id,
      reviewHeadSha: claudeReviews.headSha,
      owner: repos.owner,
      name: repos.name,
      prNumber: pullRequests.number,
    })
    .from(claudeReviewFindings)
    .innerJoin(claudeReviews, eq(claudeReviews.id, claudeReviewFindings.reviewId))
    .innerJoin(pullRequests, eq(pullRequests.id, claudeReviews.prId))
    .innerJoin(repos, eq(repos.id, pullRequests.repoId))
    .where(and(eq(claudeReviewFindings.id, findingId), eq(repos.accountId, accountId)))
    .limit(1)
    .execute();
  const row = rows[0] ?? null;
  if (!row) return null;
  return {
    finding: row.finding,
    reviewId: row.reviewId,
    reviewHeadSha: row.reviewHeadSha,
    owner: row.owner,
    name: row.name,
    prNumber: row.prNumber,
  };
}

export async function getClaudeReviewContext(
  reviewId: number,
  accountId: number,
): Promise<ClaudeReviewContext | null> {
  const rows = await db
    .select({
      review: claudeReviews,
      owner: repos.owner,
      name: repos.name,
      prNumber: pullRequests.number,
    })
    .from(claudeReviews)
    .innerJoin(pullRequests, eq(pullRequests.id, claudeReviews.prId))
    .innerJoin(repos, eq(repos.id, pullRequests.repoId))
    .where(and(eq(claudeReviews.id, reviewId), eq(repos.accountId, accountId)))
    .limit(1)
    .execute();
  const row = rows[0] ?? null;
  if (!row) return null;
  return {
    review: row.review,
    owner: row.owner,
    name: row.name,
    prNumber: row.prNumber,
  };
}

// PR coordinates needed to run a review (owner/name/number/headSha/title/body).
export interface ReviewPrContext {
  prId: number;
  owner: string;
  name: string;
  repoFullName: string;
  number: number;
  title: string;
  body: string | null;
  baseRefName: string | null;
  headSha: string | null;
}

export async function getReviewPrContext(
  prId: number,
  accountId: number,
): Promise<ReviewPrContext | null> {
  const rows = await db
    .select({
      prId: pullRequests.id,
      owner: repos.owner,
      name: repos.name,
      number: pullRequests.number,
      title: pullRequests.title,
      body: pullRequests.body,
      baseRefName: pullRequests.baseRefName,
      headSha: pullRequests.headSha,
    })
    .from(pullRequests)
    .innerJoin(repos, eq(repos.id, pullRequests.repoId))
    .where(and(eq(pullRequests.id, prId), eq(repos.accountId, accountId)))
    .limit(1)
    .execute();
  const row = rows[0] ?? null;
  if (!row) return null;
  return {
    prId: row.prId,
    owner: row.owner,
    name: row.name,
    repoFullName: `${row.owner}/${row.name}`,
    number: row.number,
    title: row.title,
    body: row.body,
    baseRefName: row.baseRefName,
    headSha: row.headSha,
  };
}

// ---- PR write-action contexts (reply / resolve / comment / approve / inline) ----
// Each resolves a target (thread / PR) to the GitHub coordinates the corresponding
// mutation needs, account-scoped via the innerJoin-up-to-repos ownership shape
// (returns null → the route 404s for a target this account doesn't own). The
// mutations themselves live in github/mutations.ts (phase 2); the routes (phase 4)
// thread the per-account token through them.

export interface ThreadWriteContext {
  threadNodeId: string;
  prId: number;
  owner: string;
  name: string;
  number: number;
}

// Resolve a review thread to its GitHub node id + parent-PR coordinates, for a
// reply (addPullRequestReviewThreadReply) or resolve/unresolve mutation. The
// thread's GitHub node id is the GraphQL `pullRequestReviewThreadId` / `threadId`.
export async function getThreadWriteContext(
  threadId: number,
  accountId: number,
): Promise<ThreadWriteContext | null> {
  const rows = await db
    .select({
      threadNodeId: reviewThreads.githubNodeId,
      prId: reviewThreads.prId,
      owner: repos.owner,
      name: repos.name,
      number: pullRequests.number,
    })
    .from(reviewThreads)
    .innerJoin(pullRequests, eq(pullRequests.id, reviewThreads.prId))
    .innerJoin(repos, eq(repos.id, pullRequests.repoId))
    .where(and(eq(reviewThreads.id, threadId), eq(repos.accountId, accountId)))
    .limit(1)
    .execute();
  const row = rows[0] ?? null;
  if (!row) return null;
  return {
    threadNodeId: row.threadNodeId,
    prId: row.prId,
    owner: row.owner,
    name: row.name,
    number: row.number,
  };
}

export interface PrWriteContext {
  prId: number;
  prNodeId: string;
  owner: string;
  name: string;
  number: number;
  headSha: string | null;
  authorId: number | null;
  viewerPermission: string | null;
  prUrl: string;
}

// Resolve a PR to the coordinates the write actions need: GitHub node id, repo
// owner/name, number, head SHA (for pinning an inline comment / review to a
// commit), author id + the synced repo viewerPermission (so the approve route can
// re-check write+ permission server-side), and the canonical PR URL.
export async function getPrWriteContext(
  prId: number,
  accountId: number,
): Promise<PrWriteContext | null> {
  const rows = await db
    .select({
      prId: pullRequests.id,
      prNodeId: pullRequests.githubNodeId,
      owner: repos.owner,
      name: repos.name,
      number: pullRequests.number,
      headSha: pullRequests.headSha,
      authorId: pullRequests.authorId,
      viewerPermission: repos.viewerPermission,
    })
    .from(pullRequests)
    .innerJoin(repos, eq(repos.id, pullRequests.repoId))
    .where(and(eq(pullRequests.id, prId), eq(repos.accountId, accountId)))
    .limit(1)
    .execute();
  const row = rows[0] ?? null;
  if (!row) return null;
  return {
    prId: row.prId,
    prNodeId: row.prNodeId,
    owner: row.owner,
    name: row.name,
    number: row.number,
    headSha: row.headSha,
    authorId: row.authorId,
    viewerPermission: row.viewerPermission,
    prUrl: `https://github.com/${row.owner}/${row.name}/pull/${row.number}`,
  };
}

export interface PrFilesContext {
  owner: string;
  name: string;
  number: number;
  prUrl: string;
}

// Subset of getPrWriteContext for the Changes-tab files fetch (owner/name/number
// + the PR URL for building per-file deep links). Reuses getPrWriteContext so the
// account-scoped ownership check stays in one place.
export async function getPrFilesContext(
  prId: number,
  accountId: number,
): Promise<PrFilesContext | null> {
  const ctx = await getPrWriteContext(prId, accountId);
  if (!ctx) return null;
  return { owner: ctx.owner, name: ctx.name, number: ctx.number, prUrl: ctx.prUrl };
}

// ---- optimistic local stamps (write actions) ----
// After a GitHub mutation succeeds, stamp the new/changed entity into the local DB
// so the UI reflects it before the next 5-min sync. Idempotent: each upserts on the
// same composite unique the sync uses, so the next sync overwrites (never
// duplicates) the row. authorId is the VIEWER's local user id (from
// getAccountUserId), passed in by the route.

// Local copy of upsert.ts's excerptOf (the `excerpt` column is set even in lean
// mode so triage + graceful UI degradation work without re-hydrating). Kept in
// sync with sync/upsert.ts by hand.
function stampExcerpt(body: string | null | undefined): string | null {
  if (!body) return null;
  const oneLine = body.replace(/\s+/g, ' ').trim();
  if (!oneLine) return null;
  return oneLine.length > 160 ? `${oneLine.slice(0, 159)}…` : oneLine;
}

// Update a thread's resolved flag (+ its derivedState) after a resolve/unresolve
// mutation. On resolve → 'resolved'. On unresolve we re-derive simply (the full
// commit-aware heuristic needs per-commit changed-file data not loaded here):
// 'replied_unresolved' if the thread has more than one comment (someone replied),
// else 'untouched'. Returns the new derivedState. account-scoped (no-op → null if
// the thread isn't owned). Idempotent — the next sync re-derives authoritatively.
export async function stampThreadResolved(
  threadId: number,
  resolved: boolean,
  accountId: number,
): Promise<DerivedState | null> {
  // Confirm ownership (and read the comment count for unresolve re-derivation).
  const rows = await db
    .select({ id: reviewThreads.id })
    .from(reviewThreads)
    .innerJoin(pullRequests, eq(pullRequests.id, reviewThreads.prId))
    .innerJoin(repos, eq(repos.id, pullRequests.repoId))
    .where(and(eq(reviewThreads.id, threadId), eq(repos.accountId, accountId)))
    .limit(1)
    .execute();
  if (!rows[0]) return null;

  let derivedState: DerivedState;
  if (resolved) {
    derivedState = 'resolved';
  } else {
    const cnt = await db
      .select({ c: count() })
      .from(reviewComments)
      .where(eq(reviewComments.threadId, threadId))
      .execute();
    const commentCount = cnt[0]?.c ?? 0;
    derivedState = commentCount > 1 ? 'replied_unresolved' : 'untouched';
  }

  await db
    .update(reviewThreads)
    .set({ isResolved: resolved, derivedState })
    .where(eq(reviewThreads.id, threadId))
    .execute();
  return derivedState;
}

// After the viewer posts a reply, bump the thread's derivedState off 'untouched'
// so its badge reflects the reply before the next sync re-derives. Conservative:
// only an unresolved thread currently 'untouched'/'replied_unresolved' is moved
// to 'replied_unresolved' — never downgrades 'likely_addressed' (a later commit
// already advanced it) nor touches 'resolved'. Ownership is already confirmed by
// the route's getThreadWriteContext. Idempotent; the next sync re-derives.
export async function stampThreadRepliedState(threadId: number): Promise<void> {
  const rows = await db
    .select({
      isResolved: reviewThreads.isResolved,
      derivedState: reviewThreads.derivedState,
    })
    .from(reviewThreads)
    .where(eq(reviewThreads.id, threadId))
    .limit(1)
    .execute();
  const t = rows[0];
  if (!t || t.isResolved) return;
  if (t.derivedState !== 'untouched' && t.derivedState !== 'replied_unresolved') {
    return;
  }
  await db
    .update(reviewThreads)
    .set({ derivedState: 'replied_unresolved' })
    .where(eq(reviewThreads.id, threadId))
    .execute();
}

// GitHub mutation payload shared by the comment/reply stamps (the new entity's
// node id, numeric database id, body, and ISO timestamp).
export interface StampGithubComment {
  nodeId: string;
  databaseId: number | null;
  body: string;
  createdAt: string;
}

// Insert a freshly-posted thread reply into review_comments (so it shows in the
// thread immediately). Upserts on (prId, githubNodeId) — the sync's conflict
// target — so the next sync updates rather than duplicates it. Stores the excerpt
// for lean mode; `body` follows config.persistBodies. Returns the local row id.
export async function upsertLocalReply(
  prId: number,
  threadId: number,
  authorId: number | null,
  gh: StampGithubComment,
): Promise<number> {
  const createdAt = new Date(gh.createdAt);
  const row = (
    await db
      .insert(reviewComments)
      .values({
        githubNodeId: gh.nodeId,
        threadId,
        prId,
        authorId,
        body: config.persistBodies ? gh.body : null,
        excerpt: stampExcerpt(gh.body),
        diffHunk: null,
        databaseId: gh.databaseId != null ? String(gh.databaseId) : null,
        createdAt,
      })
      .onConflictDoUpdate({
        target: [reviewComments.prId, reviewComments.githubNodeId],
        set: {
          body: config.persistBodies ? gh.body : null,
          excerpt: stampExcerpt(gh.body),
          databaseId: gh.databaseId != null ? String(gh.databaseId) : null,
        },
      })
      .returning({ id: reviewComments.id })
      .execute()
  )[0]!;
  return row.id;
}

// Insert a freshly-posted issue-level PR comment into pr_comments. Upserts on
// (prId, githubNodeId). Returns the local row id.
export async function upsertLocalPrComment(
  prId: number,
  authorId: number | null,
  gh: StampGithubComment,
): Promise<number> {
  const createdAt = new Date(gh.createdAt);
  const row = (
    await db
      .insert(prComments)
      .values({
        githubNodeId: gh.nodeId,
        prId,
        authorId,
        body: config.persistBodies ? gh.body : null,
        databaseId: gh.databaseId != null ? String(gh.databaseId) : null,
        createdAt,
      })
      .onConflictDoUpdate({
        target: [prComments.prId, prComments.githubNodeId],
        set: {
          body: config.persistBodies ? gh.body : null,
          databaseId: gh.databaseId != null ? String(gh.databaseId) : null,
        },
      })
      .returning({ id: prComments.id })
      .execute()
  )[0]!;
  return row.id;
}

// GitHub mutation payload for a freshly-submitted review (the approve stamp).
export interface StampGithubReview {
  nodeId: string | null;
  databaseId: number;
  body: string | null;
  submittedAt: string;
  state: string;
}

// Insert a freshly-submitted review into reviews after an approve. Forces
// state='approved' (the approve route only ever submits an APPROVE), upserts on
// (prId, githubNodeId) — falling back to the databaseId string when GitHub omits
// the node id — so the next sync reconciles it. Returns the local row id.
export async function upsertLocalReview(
  prId: number,
  authorId: number | null,
  gh: StampGithubReview,
): Promise<number> {
  // The conflict target is the GitHub node id; if GitHub didn't return one, fall
  // back to the numeric id so the row is still keyed stably for the next sync.
  const nodeId = gh.nodeId ?? `review:${gh.databaseId}`;
  const submittedAt = new Date(gh.submittedAt);
  const row = (
    await db
      .insert(reviews)
      .values({
        githubNodeId: nodeId,
        prId,
        authorId,
        state: 'approved',
        body: config.persistBodies ? gh.body : null,
        databaseId: String(gh.databaseId),
        submittedAt,
      })
      .onConflictDoUpdate({
        target: [reviews.prId, reviews.githubNodeId],
        set: {
          state: 'approved',
          body: config.persistBodies ? gh.body : null,
          databaseId: String(gh.databaseId),
          submittedAt,
        },
      })
      .returning({ id: reviews.id })
      .execute()
  )[0]!;
  return row.id;
}
