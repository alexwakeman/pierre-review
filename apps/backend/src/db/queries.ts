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
  notInArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type {
  CheckRun,
  CiStatus,
  CommitDetail,
  EventType,
  Label,
  RequestedReviewer,
  Mergeable,
  MergeStateStatus,
  MyTurnDismissKind,
  MyTurnResponse,
  NewSinceLastViewed,
  PrCommentDetail,
  PrDetail,
  PrState,
  PrStatus,
  ReasonTag,
  Repo,
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

  const timelineEvents: TimelineEvent[] = evRows.map((e) => ({
    id: e.id,
    repoId: e.repoId,
    actorId: e.actorId,
    prId: e.prId,
    type: e.type,
    occurredAt: e.occurredAt.toISOString(),
    threadId:
      e.type === 'review_comment' && e.refTable === 'review_threads'
        ? e.refId
        : null,
    refId: e.refId,
    reviewState:
      e.type === 'review_submitted' && e.refTable === 'reviews' && e.refId != null
        ? (reviewStateById.get(e.refId) ?? null)
        : null,
  }));

  return { prs, events: timelineEvents };
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

// ---- my turn ----

export async function dismissMyTurn(
  accountId: number,
  kind: MyTurnDismissKind,
  refId: number,
): Promise<void> {
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

export async function getMyTurn(accountId: number): Promise<MyTurnResponse> {
  const localUserId = await getAccountUserId(accountId);
  const empty: MyTurnResponse = {
    awaitingReview: [],
    yourPrs: [],
    threadsAwaiting: [],
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
  for (const d of dismissals) {
    if (d.kind === 'review_request') reviewDismissedAt.set(d.refId, d.dismissedAt);
    else if (d.kind === 'thread') threadDismissedAt.set(d.refId, d.dismissedAt);
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

  return { awaitingReview, yourPrs, threadsAwaiting, users };
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
    requestedReviewers,
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
