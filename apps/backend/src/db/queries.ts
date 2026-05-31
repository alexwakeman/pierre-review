import {
  and,
  asc,
  count,
  eq,
  exists,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import {
  REASON_PRIORITY,
  type CheckRun,
  type CiStatus,
  type CommitDetail,
  type EventType,
  type Label,
  type RequestedReviewer,
  type Mergeable,
  type MergeStateStatus,
  type MyTurnDismissKind,
  type MyTurnResponse,
  type NewSinceLastViewed,
  type PrCommentDetail,
  type PrDetail,
  type PrState,
  type PrStatus,
  type Repo,
  type RepoMergers,
  type ReviewDetail,
  type ReviewState,
  type ThreadAwaitingItem,
  type ThreadDetail,
  type ThreadStateCounts,
  type TimelineEvent,
  type TimelinePr,
  type TimelineResponse,
  type User,
} from '@gh-team-monitor/shared';
import { db, schema } from './client.js';
import { config } from '../config.js';
import { computeTriage, type TriageResult } from './triage.js';
import { getLocalUserId } from '../github/local-user.js';

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

export function listRepos(): Repo[] {
  const rows = db
    .select()
    .from(repos)
    .leftJoin(syncState, eq(syncState.repoId, repos.id))
    .orderBy(asc(repos.owner), asc(repos.name))
    .all();

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

export function getRepo(id: number): Repo | null {
  return listRepos().find((r) => r.id === id) ?? null;
}

export function listUsers(): User[] {
  return db
    .select()
    .from(users)
    .orderBy(asc(users.githubLogin))
    .all()
    .map(mapUser);
}

export function setUserBot(id: number, isBot: boolean): User | null {
  const row = db
    .update(users)
    .set({ isBot, isBotOverridden: true })
    .where(eq(users.id, id))
    .returning()
    .get();
  return row ? mapUser(row) : null;
}

export interface TimelineFilters {
  from: Date;
  to: Date;
  repoIds: number[] | null;
  userIds: number[] | null;
  types: EventType[] | null;
  // null = no status filter (all); otherwise the selected PR statuses (an empty
  // array shows nothing). A status maps to (state, isDraft) on pullRequests.
  statuses: PrStatus[] | null;
  excludeBots: boolean;
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

function botUserIds(): number[] {
  return db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.isBot, true))
    .all()
    .map((r) => r.id);
}

function buildThreadCounts(prIds: number[]): Map<number, ThreadStateCounts> {
  const map = new Map<number, ThreadStateCounts>();
  if (prIds.length === 0) return map;
  const rows = db
    .select({
      prId: reviewThreads.prId,
      state: reviewThreads.derivedState,
      c: count(),
    })
    .from(reviewThreads)
    .where(inArray(reviewThreads.prId, prIds))
    .groupBy(reviewThreads.prId, reviewThreads.derivedState)
    .all();
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
function buildTimelinePrs(prRows: PrRow[]): TimelinePr[] {
  const counts = buildThreadCounts(prRows.map((p) => p.id));
  const triage = computeTriage(
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

export function getTimeline(filters: TimelineFilters): TimelineResponse {
  const { from, to, repoIds, userIds, types, statuses, excludeBots } = filters;

  // ---- PRs that overlap the window ----
  const prConds = [
    lte(pullRequests.openedAt, to),
    or(
      eq(pullRequests.state, 'open'),
      gte(
        sql`coalesce(${pullRequests.mergedAt}, ${pullRequests.closedAt}, ${pullRequests.openedAt})`,
        Math.floor(from.getTime() / 1000),
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
  if (excludeBots) {
    const bots = botUserIds();
    if (bots.length > 0) {
      prConds.push(
        or(
          sql`${pullRequests.authorId} is null`,
          sql`${pullRequests.authorId} not in (${sql.join(bots, sql`, `)})`,
        )!,
      );
    }
  }

  const prRows = db
    .select()
    .from(pullRequests)
    .where(and(...prConds))
    .all();

  const prs: TimelinePr[] = buildTimelinePrs(prRows);

  // ---- events in the window ----
  const evConds = [gte(events.occurredAt, from), lte(events.occurredAt, to)];
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
  if (excludeBots) {
    const bots = botUserIds();
    if (bots.length > 0) {
      evConds.push(
        or(
          sql`${events.actorId} is null`,
          sql`${events.actorId} not in (${sql.join(bots, sql`, `)})`,
        )!,
      );
    }
  }

  const evRows = db
    .select()
    .from(events)
    .where(and(...evConds))
    .orderBy(asc(events.occurredAt))
    .all();

  // Batch-load review outcomes for the review_submitted events in view, so
  // markers can show approve/changes/comment without per-marker fetches.
  const reviewRefIds = evRows
    .filter((e) => e.type === 'review_submitted' && e.refTable === 'reviews' && e.refId != null)
    .map((e) => e.refId as number);
  const reviewStateById = new Map<number, ReviewState>();
  if (reviewRefIds.length > 0) {
    const rows = db
      .select({ id: reviews.id, state: reviews.state })
      .from(reviews)
      .where(inArray(reviews.id, reviewRefIds))
      .all();
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
  repoIds: number[] | null;
  userIds: number[] | null;
}

export function getOpenPrs(filters: OpenPrsFilters): TimelinePr[] {
  const conds = [eq(pullRequests.state, 'open')];
  if (filters.repoIds) conds.push(inArray(pullRequests.repoId, filters.repoIds));
  if (filters.userIds && filters.userIds.length > 0) {
    conds.push(inArray(pullRequests.authorId, filters.userIds));
  }
  const prRows = db
    .select()
    .from(pullRequests)
    .where(and(...conds))
    .all();

  const prs = buildTimelinePrs(prRows);
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
export function getMergers(): RepoMergers[] {
  const rows = db
    .selectDistinct({ repoId: pullRequests.repoId, userId: pullRequests.mergedById })
    .from(pullRequests)
    .innerJoin(repos, eq(repos.id, pullRequests.repoId))
    .where(
      and(
        eq(pullRequests.state, 'merged'),
        isNotNull(pullRequests.mergedById),
        or(
          isNull(repos.defaultBranch),
          isNull(pullRequests.baseRefName),
          eq(pullRequests.baseRefName, repos.defaultBranch),
        ),
      ),
    )
    .all();
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

export function markPrViewed(prId: number, sha?: string): boolean {
  const pr = db
    .select({ id: pullRequests.id, headSha: pullRequests.headSha })
    .from(pullRequests)
    .where(eq(pullRequests.id, prId))
    .get();
  if (!pr) return false;
  const viewedSha = sha ?? pr.headSha ?? null;
  const now = new Date();
  db.insert(prViews)
    .values({ prId, lastViewedSha: viewedSha, lastViewedAt: now })
    .onConflictDoUpdate({
      target: prViews.prId,
      set: { lastViewedSha: viewedSha, lastViewedAt: now },
    })
    .run();
  return true;
}

// ---- my turn ----

export function dismissMyTurn(kind: MyTurnDismissKind, refId: number): void {
  const now = new Date();
  db.insert(myTurnDismissals)
    .values({ kind, refId, dismissedAt: now })
    .onConflictDoUpdate({
      target: [myTurnDismissals.kind, myTurnDismissals.refId],
      set: { dismissedAt: now },
    })
    .run();
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

export function getMyTurn(): MyTurnResponse {
  const localUserId = getLocalUserId();
  const empty: MyTurnResponse = {
    awaitingReview: [],
    yourPrs: [],
    threadsAwaiting: [],
    users: [],
  };
  if (localUserId == null) return empty;

  const referencedUsers = new Set<number>();

  // Open PRs, enriched with triage, are the basis for sections 1 & 2.
  const openRows = db
    .select()
    .from(pullRequests)
    .where(eq(pullRequests.state, 'open'))
    .all();
  const open = buildTimelinePrs(openRows);
  const repoNameById = new Map<number, string>();
  for (const r of listRepos()) repoNameById.set(r.id, r.fullName);

  // Manual dismissals, honoured only until newer activity supersedes them.
  const dismissals = db.select().from(myTurnDismissals).all();
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
  const awaitingReview = open
    .filter((t) => t.reviewRequestedFromMe)
    .filter((t) => {
      const d = reviewDismissedAt.get(t.id);
      return !d || meta(t.id).updatedAt.getTime() > d.getTime();
    })
    .map((t) => {
      // otherReviewersRequested is recomputed via triage map; re-derive count.
      const others = countOtherReviewers(t.id, localUserId);
      return { ...toMyTurnPr(t), alsoRequested: others };
    });

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
  const threadsAwaiting = getThreadsAwaiting(localUserId, repoNameById).filter(
    (ta) => {
      const d = threadDismissedAt.get(ta.threadId);
      return !d || Date.parse(ta.lastReplyAt) > d.getTime();
    },
  );
  for (const ta of threadsAwaiting) {
    if (ta.lastReplyAuthorId != null) referencedUsers.add(ta.lastReplyAuthorId);
  }

  const users =
    referencedUsers.size > 0
      ? db
          .select()
          .from(schema.users)
          .where(inArray(schema.users.id, [...referencedUsers]))
          .all()
          .map(mapUser)
      : [];

  return { awaitingReview, yourPrs, threadsAwaiting, users };
}

function countOtherReviewers(prId: number, localUserId: number): number {
  return db
    .select({ userId: schema.reviewRequests.userId })
    .from(schema.reviewRequests)
    .where(eq(schema.reviewRequests.prId, prId))
    .all()
    .filter((r) => r.userId != null && r.userId !== localUserId).length;
}

function getThreadsAwaiting(
  localUserId: number,
  repoNameById: Map<number, string>,
): ThreadAwaitingItem[] {
  const threads = db
    .select({
      id: reviewThreads.id,
      prId: reviewThreads.prId,
      path: reviewThreads.path,
      line: reviewThreads.line,
      derivedState: reviewThreads.derivedState,
    })
    .from(reviewThreads)
    .where(
      and(
        eq(reviewThreads.originalCommenterId, localUserId),
        sql`${reviewThreads.derivedState} != 'resolved'`,
      ),
    )
    .all();
  if (threads.length === 0) return [];

  const prIds = [...new Set(threads.map((t) => t.prId))];
  const prRows = db
    .select({ id: pullRequests.id, repoId: pullRequests.repoId, number: pullRequests.number })
    .from(pullRequests)
    .where(inArray(pullRequests.id, prIds))
    .all();
  const prById = new Map(prRows.map((p) => [p.id, p]));

  const out: ThreadAwaitingItem[] = [];
  for (const t of threads) {
    const comments = db
      .select()
      .from(reviewComments)
      .where(eq(reviewComments.threadId, t.id))
      .orderBy(asc(reviewComments.createdAt))
      .all();
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
      lastReplyExcerpt: truncate(last.body, 140),
      lastReplyAt: last.createdAt.toISOString(),
      lastReplyAuthorId: last.authorId,
      githubUrl: `https://github.com/${owner}/${name}/pull/${pr.number}`,
    });
  }
  out.sort((a, b) => b.lastReplyAt.localeCompare(a.lastReplyAt));
  return out;
}

export function getPrDetail(id: number): PrDetail | null {
  const row = db
    .select()
    .from(pullRequests)
    .innerJoin(repos, eq(repos.id, pullRequests.repoId))
    .where(eq(pullRequests.id, id))
    .get();
  if (!row) return null;
  const pr = row.pull_requests;
  const repo = row.repos;
  // Base for activity deep links; per-item anchors are appended below.
  const prUrl = `https://github.com/${repo.owner}/${repo.name}/pull/${pr.number}`;

  const threadRows = db
    .select()
    .from(reviewThreads)
    .where(eq(reviewThreads.prId, id))
    .all();
  const commentRows = db
    .select()
    .from(reviewComments)
    .where(eq(reviewComments.prId, id))
    .orderBy(asc(reviewComments.createdAt))
    .all();
  const reviewRows = db
    .select()
    .from(reviews)
    .where(eq(reviews.prId, id))
    .orderBy(asc(reviews.submittedAt))
    .all();
  const prCommentRows = db
    .select()
    .from(prComments)
    .where(eq(prComments.prId, id))
    .orderBy(asc(prComments.createdAt))
    .all();
  const commitRows = db
    .select()
    .from(commits)
    .where(eq(commits.prId, id))
    .orderBy(asc(commits.committedAt))
    .all();

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
        body: c.body,
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
    body: c.body,
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
  const reviewerRows = db
    .select()
    .from(schema.reviewRequests)
    .where(eq(schema.reviewRequests.prId, id))
    .all();
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
  const userList =
    userIds.size > 0
      ? db.select().from(users).where(inArray(users.id, [...userIds])).all().map(mapUser)
      : [];

  const counts = buildThreadCounts([id]).get(id) ?? emptyCounts();

  // Incremental review: capture the last-viewed instant and what's happened
  // since. No "new" once a PR is closed/merged.
  const view = db.select().from(prViews).where(eq(prViews.prId, id)).get();
  const lastViewedAt = view?.lastViewedAt ?? null;
  let newSinceLastViewed: NewSinceLastViewed | null = null;
  if (pr.state === 'open' && lastViewedAt) {
    const since = db
      .select({ type: events.type, occurredAt: events.occurredAt })
      .from(events)
      .where(and(eq(events.prId, id), gt(events.occurredAt, lastViewedAt)))
      .all();
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
    closedAt: iso(pr.closedAt),
    updatedAt: pr.updatedAt.toISOString(),
    githubUrl: prUrl,
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

export function getThreadDetail(id: number): ThreadDetail | null {
  const row = db
    .select()
    .from(reviewThreads)
    .innerJoin(pullRequests, eq(pullRequests.id, reviewThreads.prId))
    .innerJoin(repos, eq(repos.id, pullRequests.repoId))
    .where(eq(reviewThreads.id, id))
    .get();
  if (!row) return null;
  const t = row.review_threads;
  const prUrl = `https://github.com/${row.repos.owner}/${row.repos.name}/pull/${row.pull_requests.number}`;
  const comments = db
    .select()
    .from(reviewComments)
    .where(eq(reviewComments.threadId, id))
    .orderBy(asc(reviewComments.createdAt))
    .all();
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
      body: c.body,
      diffHunk: c.diffHunk,
      createdAt: c.createdAt.toISOString(),
      url: c.databaseId ? `${prUrl}#discussion_r${c.databaseId}` : null,
    })),
    url: comments[0]?.databaseId
      ? `${prUrl}#discussion_r${comments[0].databaseId}`
      : null,
  };
}

export function deleteRepo(id: number): boolean {
  const repo = db.select().from(repos).where(eq(repos.id, id)).get();
  if (!repo) return false;

  // Remove dependents in FK-safe order.
  const prIds = db
    .select({ id: pullRequests.id })
    .from(pullRequests)
    .where(eq(pullRequests.repoId, id))
    .all()
    .map((r) => r.id);

  db.transaction(() => {
    db.delete(events).where(eq(events.repoId, id)).run();
    if (prIds.length > 0) {
      db.delete(reviewComments).where(inArray(reviewComments.prId, prIds)).run();
      db.delete(reviewThreads).where(inArray(reviewThreads.prId, prIds)).run();
      db.delete(prComments).where(inArray(prComments.prId, prIds)).run();
      db.delete(reviews).where(inArray(reviews.prId, prIds)).run();
      db.delete(commits).where(inArray(commits.prId, prIds)).run();
      db.delete(schema.reviewRequests).where(inArray(schema.reviewRequests.prId, prIds)).run();
      db.delete(prViews).where(inArray(prViews.prId, prIds)).run();
      db.delete(pullRequests).where(eq(pullRequests.repoId, id)).run();
    }
    db.delete(syncState).where(eq(syncState.repoId, id)).run();
    db.delete(repos).where(eq(repos.id, id)).run();
  });
  return true;
}
