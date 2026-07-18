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
  lt,
  lte,
  ne,
  notInArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type {
  ApprovedPrItem,
  CheckRun,
  CiStatus,
  CommitDetail,
  DerivedState,
  DismissedItem,
  DismissedMyTurnResponse,
  EventType,
  InsightCard,
  InsightKind,
  InsightSeverity,
  SuggestedReviewer,
  ReviewerSuggestion,
  TeamInsightsResponse,
  TeamMetrics,
  TeamMetricStat,
  TeamMetricsDetail,
  SprintComparisonMode,
  MetricPr,
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
  Team,
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
  ActivityResponse,
  ActivityRepo,
  ActivityRepoStats,
  RepoClaudeReviewsResponse,
  RepoClaudeReviewPr,
  ConsolidatedFeedItem,
  ConsolidatedFeedResponse,
  FeedAffectedThread,
  MyTurnPr,
  BotSignalCard,
  BotSignalVendorStat,
  AutomatedReviewerKind,
  ReviewerClassification,
  ReviewerOverrideBody,
  DetectedReviewer,
  DetectedReviewersResponse,
  ReviewProvenance,
  BotWindowKind,
  BotVerdict,
  BotVendorTrendPoint,
  BotVendorAnalytics,
  BotAnalyticsResponse,
  BotVendorPr,
  BotVendorPrsResponse,
  BotDedupMember,
  BotDedupCluster,
  BotDedupResponse,
  BotMuteRule,
  BotMuteRuleInput,
  BotMuteAction,
  BotTuningSuggestion,
  BotOnlyReviewCard,
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
import { enrichMyTurn } from '../feed/my-turn.js';
import { resolvePrTickets } from '../pr/detail-enricher.js';
import { config } from '../config.js';
import { getProCapabilities } from '../pro/contract.js';
import { createHash } from 'node:crypto';
import {
  computeApprovalInfoByPr,
  computeTriage,
  type TriageResult,
} from './triage.js';
import { getAccountUserId } from '../auth/account.js';
import { ensureRoutingPrFiles } from '../sync/routing-files.js';
import { reviewBotKind, reviewBotLogins } from '../sync/bot-detection.js';
import {
  classifyReviewer,
  labelFor as labelForKind,
  rowToClassification,
  type ReviewerEvidence,
} from '../sync/reviewer-classify.js';
import { computeBehavioralSignals } from '../sync/reviewer-behavior.js';
import { fingerprintReview } from '../sync/review-fingerprint.js';

// Bind a JS Date into a raw-`sql` epoch comparison portably: Postgres columns are
// timestamptz (drizzle binds the Date through the codec), whereas SQLite columns
// are integer unix-epoch seconds (`mode:'timestamp'`), so we hand it the int.
const tsBound = (d: Date): Date | number =>
  isPg ? d : Math.floor(d.getTime() / 1000);

const {
  accounts,
  repos,
  users,
  pullRequests,
  reviewRequests,
  reviewThreads,
  reviewComments,
  prComments,
  reviews,
  commits,
  commitFiles,
  events,
  syncState,
  prViews,
  myTurnDismissals,
  claudeReviews,
  claudeReviewFindings,
  ciStatusEvents,
  botReviewClassification,
  botMuteRules,
  teams,
  teamRepos,
} = schema;

function iso(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}

function emptyCounts(): ThreadStateCounts {
  return { resolved: 0, likely_addressed: 0, replied_unresolved: 0, untouched: 0 };
}

// GitHub anchors a file in a PR's "Files changed" diff by the SHA-256 of its path; used to
// deep-link the Changes tab's per-file rows (getPrDetail).
function diffAnchorId(path: string): string {
  return createHash('sha256').update(path, 'utf8').digest('hex');
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

// ---- Teams (CORE) ----
// Named groupings of an account's repos. Every read/write is accountId-scoped; id-addressed
// mutators verify ownership and return false/empty for another account's team (→ 404 at the
// route). A repo may belong to several teams (the team_repos join allows overlap). Assigning a
// repo to a team auto-Watches it (inboxWatch=true) so team activity flows into the inbox.

function mapTeam(
  t: typeof teams.$inferSelect,
  repoIds: number[],
): Team {
  return {
    id: t.id,
    name: t.name,
    repoIds,
    repoCount: repoIds.length,
    createdAt: t.createdAt.toISOString(),
  };
}

// All teams for an account, each carrying its member repo ids (join team_repos). Ordered by
// name for a stable UI.
export async function listTeams(accountId: number): Promise<Team[]> {
  const teamRows = await db
    .select()
    .from(teams)
    .where(eq(teams.accountId, accountId))
    .orderBy(asc(teams.name))
    .execute();
  if (teamRows.length === 0) return [];
  const memberRows = await db
    .select({ teamId: teamRepos.teamId, repoId: teamRepos.repoId })
    .from(teamRepos)
    .where(eq(teamRepos.accountId, accountId))
    .execute();
  const byTeam = new Map<number, number[]>();
  for (const m of memberRows) {
    const arr = byTeam.get(m.teamId) ?? [];
    arr.push(m.repoId);
    byTeam.set(m.teamId, arr);
  }
  return teamRows.map((t) => mapTeam(t, byTeam.get(t.id) ?? []));
}

// Create a team (unique per (accountId, name)). Throws on a duplicate name — the caller maps
// the unique-constraint failure to a 400. Returns the fresh Team (no repos yet).
export async function createTeam(accountId: number, name: string): Promise<Team> {
  const [row] = await db
    .insert(teams)
    .values({ accountId, name })
    .returning()
    .execute();
  return mapTeam(row!, []);
}

// Rename a team (account-scoped → false/404 for a team this account doesn't own). Returns
// false when nothing was updated (unknown/foreign team).
export async function renameTeam(
  id: number,
  accountId: number,
  name: string,
): Promise<boolean> {
  const updated = await db
    .update(teams)
    .set({ name })
    .where(and(eq(teams.id, id), eq(teams.accountId, accountId)))
    .returning({ id: teams.id })
    .execute();
  return updated.length > 0;
}

// Delete a team (account-scoped). The team_repos rows cascade via FK, but we also delete them
// explicitly first so the txn ordering is dialect-agnostic (Postgres enforces FKs immediately;
// SQLite only when foreign_keys=ON). Returns false for an unknown/foreign team.
export async function deleteTeam(id: number, accountId: number): Promise<boolean> {
  const owned = await db
    .select({ id: teams.id })
    .from(teams)
    .where(and(eq(teams.id, id), eq(teams.accountId, accountId)))
    .limit(1)
    .execute();
  if (!owned[0]) return false;
  await runTransaction(async (tx) => {
    await tx
      .delete(teamRepos)
      .where(and(eq(teamRepos.teamId, id), eq(teamRepos.accountId, accountId)))
      .execute();
    await tx
      .delete(teams)
      .where(and(eq(teams.id, id), eq(teams.accountId, accountId)))
      .execute();
  });
  return true;
}

// The member repo ids of a team, account-scoped (foreign/unknown team → empty array). The FK
// on team_repos.repoId guarantees these are live repo ids.
export async function getTeamRepoIds(
  teamId: number,
  accountId: number,
): Promise<number[]> {
  // Ownership is enforced via the accountId predicate on team_repos (denormalized) — a foreign
  // team's rows carry a different accountId and are filtered out.
  const rows = await db
    .select({ repoId: teamRepos.repoId })
    .from(teamRepos)
    .innerJoin(teams, eq(teams.id, teamRepos.teamId))
    .where(and(eq(teamRepos.teamId, teamId), eq(teams.accountId, accountId)))
    .execute();
  return rows.map((r) => r.repoId);
}

// The UNION of every team's member repos for the account, deduped (→ scope 'teams', cross-team
// monitoring). Differs from 'all' (which is every account repo, incl. repos in no team): this is
// strictly the repos assigned to at least one team. Empty when the account has no team repos.
export async function getAllTeamRepoIds(accountId: number): Promise<number[]> {
  const rows = await db
    .select({ repoId: teamRepos.repoId })
    .from(teamRepos)
    .where(eq(teamRepos.accountId, accountId))
    .execute();
  return [...new Set(rows.map((r) => r.repoId))];
}

// Repo ids owned by the account that belong to NO team (the "unassigned" bucket → scope 'none').
// Filtered in JS against the (small, ≤ per-account cap) assigned set — no subquery, so it stays
// on the portable async surface both dialects share.
export async function getUnassignedRepoIds(accountId: number): Promise<number[]> {
  const [repoRows, assignedRows] = await Promise.all([
    db.select({ id: repos.id }).from(repos).where(eq(repos.accountId, accountId)).execute(),
    db
      .select({ repoId: teamRepos.repoId })
      .from(teamRepos)
      .where(eq(teamRepos.accountId, accountId))
      .execute(),
  ]);
  const assigned = new Set(assignedRows.map((r) => r.repoId));
  return repoRows.map((r) => r.id).filter((id) => !assigned.has(id));
}

// Assign repos to a team (idempotent). Only repos the account actually owns are assigned (a
// foreign repoId is silently dropped — no cross-account leakage). Each assigned repo is
// auto-Watched (inboxWatch=true) so its activity flows into the inbox. No-op for a
// foreign/unknown team.
export async function assignReposToTeam(
  teamId: number,
  accountId: number,
  repoIds: number[],
): Promise<void> {
  // Verify team ownership first.
  const owned = await db
    .select({ id: teams.id })
    .from(teams)
    .where(and(eq(teams.id, teamId), eq(teams.accountId, accountId)))
    .limit(1)
    .execute();
  if (!owned[0]) return;
  if (repoIds.length === 0) return;
  // Keep only repos this account owns (defends the FK + the isolation invariant).
  const ownedRepos = await db
    .select({ id: repos.id })
    .from(repos)
    .where(and(eq(repos.accountId, accountId), inArray(repos.id, repoIds)))
    .execute();
  const validIds = ownedRepos.map((r) => r.id);
  if (validIds.length === 0) return;
  await runTransaction(async (tx) => {
    for (const repoId of validIds) {
      await tx
        .insert(teamRepos)
        .values({ accountId, teamId, repoId })
        .onConflictDoNothing({
          target: [teamRepos.teamId, teamRepos.repoId],
        })
        .execute();
    }
    // Auto-watch every assigned repo (idempotent). Stamp the watch-start only when unset so a
    // re-assign preserves the original window (mirrors setRepoInboxWatch).
    await tx
      .update(repos)
      .set({
        inboxWatch: true,
        inboxWatchStartedAt: sql`coalesce(${repos.inboxWatchStartedAt}, ${tsBound(new Date())})`,
      })
      .where(and(eq(repos.accountId, accountId), inArray(repos.id, validIds)))
      .execute();
  });
}

// Remove one repo from a team (account-scoped). Returns false when nothing was removed
// (foreign/unknown team or the repo wasn't a member). Does NOT un-Watch the repo — a repo can
// be watched independently of team membership.
export async function removeRepoFromTeam(
  teamId: number,
  repoId: number,
  accountId: number,
): Promise<boolean> {
  const removed = await db
    .delete(teamRepos)
    .where(
      and(
        eq(teamRepos.teamId, teamId),
        eq(teamRepos.repoId, repoId),
        eq(teamRepos.accountId, accountId),
      ),
    )
    .returning({ id: teamRepos.id })
    .execute();
  return removed.length > 0;
}

// The single scope resolver. A `scope` wire value ('all' | 'none' | 'teams' | '<teamId>') resolves
// to the concrete repo-id set to compute over: 'all' → null (means "every account repo", the
// callers' existing default), 'none' → the unassigned repos, 'teams' → the UNION of every team's
// repos (cross-team monitoring), a numeric string → that team's repos (ownership-checked; an
// unknown/foreign team → empty array). Reuse this everywhere a scope needs turning into repo ids.
export async function resolveScopeRepoIds(
  accountId: number,
  scope: string,
): Promise<number[] | null> {
  if (scope === 'all') return null;
  if (scope === 'none') return getUnassignedRepoIds(accountId);
  if (scope === 'teams') return getAllTeamRepoIds(accountId);
  const teamId = Number(scope);
  if (!Number.isInteger(teamId) || teamId <= 0) return [];
  return getTeamRepoIds(teamId, accountId);
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
  // Bots to KEEP visible even when excludeBots is on (the per-repo allow-list override).
  // null/empty → exclude every bot. Ignored when excludeBots is false.
  allowBotIds?: number[] | null;
  // true → hide "stale" open PRs (no commit/comment/review in [from, to]).
  excludeStale: boolean;
  // When set (non-empty), fetch EXACTLY these PRs + ALL their events, ignoring every other
  // filter (date/repo/member/status/review/stale/bots). Used by a pr-focus tab's isolated
  // timeline so it loads a single PR (+ its markers) cheaply and regardless of the board's
  // filters — the subject PR may be in a repo/date the board excludes. Still accountId-scoped
  // (an id from another tenant simply matches nothing).
  prIds?: number[] | null;
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

// The user ids of every KNOWN AI review bot (CodeRabbit/Greptile/Copilot/Qodo/…). Matched
// by LOGIN (not the coarse `users.isBot` flag) so it catches review-bot rows synced before
// the login joined the known set — their `isBot` may still be false until the next sync.
// Includes both the bare slug and the `slug[bot]` form (GraphQL vs REST author strings).
async function reviewBotUserIds(): Promise<number[]> {
  const logins = reviewBotLogins();
  if (logins.length === 0) return [];
  const candidates = [...logins, ...logins.map((l) => `${l}[bot]`)];
  const inList = sql.join(
    candidates.map((c) => sql`${c}`),
    sql`, `,
  );
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.githubLogin}) in (${inList})`)
    .execute();
  return rows.map((r) => r.id);
}

// Per-PR review-thread counts RESTRICTED to threads a review bot opened (by
// `originalCommenterId`), split by derived state. Same GROUP BY shape as
// buildThreadCounts; feeds the deterministic per-repo "acted-on rate" headline stat.
async function buildBotThreadCounts(
  prIds: number[],
  botUserIds: number[],
): Promise<Map<number, ThreadStateCounts>> {
  const map = new Map<number, ThreadStateCounts>();
  if (prIds.length === 0 || botUserIds.length === 0) return map;
  const rows = await db
    .select({
      prId: reviewThreads.prId,
      state: reviewThreads.derivedState,
      c: count(),
    })
    .from(reviewThreads)
    .where(
      and(
        inArray(reviewThreads.prId, prIds),
        inArray(reviewThreads.originalCommenterId, botUserIds),
      ),
    )
    .groupBy(reviewThreads.prId, reviewThreads.derivedState)
    .execute();
  for (const r of rows) {
    const entry = map.get(r.prId) ?? emptyCounts();
    entry[r.state] = r.c;
    map.set(r.prId, entry);
  }
  return map;
}

// "Acted-on" heuristic over a bag of bot threads: resolved + likely_addressed (a commit
// touched the file after the bot's comment) vs the untouched/replied backlog.
function botActedOn(c: ThreadStateCounts): number {
  return c.resolved + c.likely_addressed;
}
function botThreadTotal(c: ThreadStateCounts): number {
  return c.resolved + c.likely_addressed + c.replied_unresolved + c.untouched;
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
    isApproved: tr?.isApproved ?? false,
    isChangesRequested: tr?.isChangesRequested ?? false,
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
    allowBotIds,
    excludeStale,
  } = filters;

  // A pr-focus tab's isolated timeline: fetch EXACTLY these PRs + all their events, bypassing
  // every board filter (the subject PR may be in a repo/date the board excludes). Always
  // accountId-scoped.
  const prIds = filters.prIds ?? null;
  const prScoped = prIds != null && prIds.length > 0;

  // ---- PRs that overlap the window (or, when pr-scoped, exactly the requested PRs) ----
  const prConds = [eq(pullRequests.accountId, accountId)];
  if (prScoped) {
    prConds.push(inArray(pullRequests.id, prIds!));
  } else {
    prConds.push(
      lte(pullRequests.openedAt, to),
      or(
        eq(pullRequests.state, 'open'),
        gte(
          sql`coalesce(${pullRequests.mergedAt}, ${pullRequests.closedAt}, ${pullRequests.openedAt})`,
          tsBound(from),
        ),
      )!,
    );
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
  }
  // Resolve the bot set once (used by both the PR and events branches below). The
  // per-repo allow-list subtracts the "important" bots so their activity stays visible
  // even under excludeBots — every downstream predicate keys off this trimmed set. Skipped
  // entirely when pr-scoped (no bot filtering there).
  const allowBots = new Set(allowBotIds ?? []);
  const bots =
    !prScoped && excludeBots ? (await botUserIds()).filter((id) => !allowBots.has(id)) : [];
  if (!prScoped && excludeBots && bots.length > 0) {
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
  // building the lean PRs so their events can be dropped too (below). Skipped when pr-scoped.
  const staleIds =
    !prScoped && excludeStale
      ? await staleOpenPrIds(prRows, from, to)
      : new Set<number>();
  if (staleIds.size > 0) prRows = prRows.filter((p) => !staleIds.has(p.id));

  const prs: TimelinePr[] = await buildTimelinePrs(prRows, accountId);

  // ---- events (in the window, or — when pr-scoped — ALL events for the requested PRs) ----
  const evConds = [eq(events.accountId, accountId)];
  if (prScoped) {
    evConds.push(inArray(events.prId, prIds!));
  } else {
    evConds.push(gte(events.occurredAt, from), lte(events.occurredAt, to));
    if (repoIds) evConds.push(inArray(events.repoId, repoIds));
    if (types) evConds.push(inArray(events.type, types));
    if (userIds && userIds.length > 0) {
      evConds.push(inArray(events.actorId, userIds));
    }
  }
  // Drop events whose PR is filtered out by status — so a contributor with only
  // a (e.g.) closed PR keeps neither a bar nor any markers, and loses their row.
  // (All remaining event filters are bypassed when pr-scoped.)
  if (!prScoped && statuses) {
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
  if (!prScoped && reviewStates) {
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
export interface FeedFilters {
  daysBefore?: number;
  // null / omitted → all the account's repos; a list → scope to those repo ids.
  repoIds?: number[] | null;
  // Filters events by actor (member filter); null / empty → all actors.
  userIds?: number[] | null;
  // Legacy /api/feed IndexedDB-mirror semantics only: restrict to inbox-watched repos.
  watchedOnly?: boolean;
  // Single-PR isolation: scope to this PR's events AND drop the `daysBefore` window (the
  // scan is one PR, so its full history is cheap). Lets the Feed's per-PR filter show an
  // old PR's opened event + all activity, not just the last `daysBefore` days.
  prId?: number | null;
  // Bot feed: restrict events to these actor ids (the automated-reviewer set) IN SQL, so the
  // bot-only feed filters before the cap instead of the client thinning an already-capped mixed
  // page. Null/omitted → no actor restriction. An empty array yields an empty feed by design.
  botActorIds?: number[] | null;
}

export async function getFeed(
  accountId: number,
  opts: FeedFilters = {},
): Promise<FeedResponse> {
  const { daysBefore = 14, repoIds = null, userIds = null, watchedOnly = false, prId = null, botActorIds = null } = opts;
  // Isolated to one PR → no time window (epoch 0); otherwise the rolling `daysBefore` window.
  const since = prId != null ? new Date(0) : new Date(Date.now() - daysBefore * 24 * 60 * 60 * 1000);
  const conds: SQL[] = [
    eq(events.accountId, accountId),
    gte(events.occurredAt, since),
    ne(events.type, 'commit_pushed'),
  ];
  if (prId != null) conds.push(eq(events.prId, prId));
  if (watchedOnly) conds.push(eq(repos.inboxWatch, true));
  if (repoIds) conds.push(inArray(events.repoId, repoIds));
  if (userIds && userIds.length > 0) conds.push(inArray(events.actorId, userIds));
  // Bot feed: restrict to the automated-reviewer actor set (before the cap). An empty set
  // means "no bots" → force an unsatisfiable predicate so the feed is empty (not unfiltered).
  if (botActorIds != null)
    conds.push(
      botActorIds.length > 0 ? inArray(events.actorId, botActorIds) : sql`1 = 0`,
    );
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
    .where(and(...conds))
    .orderBy(desc(events.occurredAt))
    .execute();
  if (rows.length === 0) return { events: [], users: [] };

  // Verdicts for review_submitted events (refId → reviews.state).
  const reviewIds = rows
    .filter((r) => r.type === 'review_submitted' && r.refTable === 'reviews' && r.refId != null)
    .map((r) => r.refId as number);
  const reviewStateById = new Map<number, ReviewState>();
  const reviewBodyById = new Map<number, string | null>();
  if (reviewIds.length > 0) {
    for (const r of await db
      .select({ id: reviews.id, state: reviews.state, body: reviews.body })
      .from(reviews)
      .where(inArray(reviews.id, reviewIds))
      .execute()) {
      reviewStateById.set(r.id, r.state as ReviewState);
      reviewBodyById.set(r.id, r.body);
    }
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
    // The full markdown body for text events (fallback to `excerpt` when a row was
    // synced lean before full-body persistence).
    let content: string | null = null;
    if (r.type === 'review_comment' && r.refId != null) {
      const arr = commentsByThread.get(r.refId) ?? [];
      const match =
        arr.find(
          (c) => c.createdAt.getTime() === r.occurredAt.getTime() && c.authorId === r.actorId,
        ) ?? arr.find((c) => c.createdAt.getTime() === r.occurredAt.getTime());
      excerpt = match?.excerpt ?? (match?.body ? truncate(match.body, 160) : null);
      content = match?.body ?? null;
    } else if (r.type === 'pr_comment' && r.refId != null) {
      const body = prCommentBodyById.get(r.refId) ?? null;
      excerpt = body ? truncate(body, 160) : null;
      content = body;
    } else if (r.type === 'review_submitted' && r.refId != null) {
      content = reviewBodyById.get(r.refId) ?? null;
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
      content,
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

  // ---- CI recovery + failure reasons (from the ci_status_events transition log) ----
  // Port of the cross-repo walk in getTeamMetrics, SCOPED to this single repo and WEEKLY-
  // bucketed over the 84-day window. Walk each PR's events in time order: a red streak opens
  // on the first failure and closes on the next success → a resolution duration, bucketed by
  // resolution week. Failing-check names tally into the by-stage reason breakdown. No events →
  // both arrays come back empty (the chart shows an empty state).
  const ciEvents = await db
    .select({
      prId: ciStatusEvents.prId,
      status: ciStatusEvents.status,
      failingChecks: ciStatusEvents.failingChecks,
      observedAt: ciStatusEvents.observedAt,
    })
    .from(ciStatusEvents)
    .where(
      and(
        eq(ciStatusEvents.accountId, accountId),
        eq(ciStatusEvents.repoId, repoId),
        gte(ciStatusEvents.observedAt, windowStart),
      ),
    )
    .orderBy(ciStatusEvents.prId, ciStatusEvents.observedAt)
    .execute();

  const ciRecoveryByBucket: number[][] = Array.from({ length: nBuckets }, () => []);
  const ciReasonCounts = new Map<string, number>();
  {
    let curPr: number | null = null;
    let failStartMs: number | null = null;
    for (const e of ciEvents) {
      if (e.prId !== curPr) {
        curPr = e.prId;
        failStartMs = null;
      }
      const obsMs = e.observedAt.getTime();
      if (e.status === 'failure' || e.status === 'error') {
        if (failStartMs == null) failStartMs = obsMs;
        for (const name of e.failingChecks ?? [])
          ciReasonCounts.set(name, (ciReasonCounts.get(name) ?? 0) + 1);
      } else if (e.status === 'success' && failStartMs != null) {
        if (inWin(obsMs)) ciRecoveryByBucket[bi(obsMs)]!.push((obsMs - failStartMs) / 3_600_000);
        failStartMs = null;
      }
    }
  }
  const ciFailuresByStage = [...ciReasonCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([stage, count]) => ({ stage, count }));

  const round1 = (x: number): number => Math.round(x * 10) / 10;
  return {
    repoId: repo.id,
    repoFullName: repo.fullName,
    windowDays,
    stallThresholdDays: config.stallThresholdDays,
    generatedAt: new Date().toISOString(),
    weekBuckets,
    ciRecovery: ciRecoveryByBucket.map((arr, i) => {
      const m = median(arr);
      return {
        weekStart: weekBuckets[i]!,
        medianHours: m == null ? null : round1(m),
        incidents: arr.length,
      };
    }),
    ciFailuresByStage,
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

// ---- inbox (CORE, always-on, no AI) ----

// Reason tags that, on an open PR, count as "needs attention" for the Activity rail
// badge (a my-turn-shaped triage reason). Stalled + untouched threads are folded
// in separately via the per-PR flags. Keep in sync with REASON_PRIORITY values.
const ACTIVITY_ATTENTION_REASONS = new Set<ReasonTag>([
  'awaiting_your_review',
  'your_pr_new_comments',
  'ci_failing',
  'merge_conflicts',
  'untouched_threads',
]);

// The Activity aggregate: per WATCHED repo, current-state stats + a per-repo thread
// total + maintainer ids + attention/unread flags + the open PRs (caller groups by
// author). Scoped to the account's WATCHED repos (inboxWatch); a passed `repoIds` further
// narrows WITHIN watched. Composes EXISTING accountId-scoped readers — getInsights /
// getOpenPrs / getMergers / listRepos — so isolation + triage logic stay single-sourced.
// The one genuinely new aggregation is `threadTotals` (sum each open PR's threadCounts
// per repo). Every watched repo is included (a quiet repo → empty prs, zeroed stats).
export async function getActivity(
  accountId: number,
  repoIds: number[] | null,
  userIds: number[] | null = null,
): Promise<ActivityResponse> {
  const reposAll = await listRepos(accountId);
  const watched = reposAll.filter((r) => r.inboxWatch);
  const reposScoped = repoIds ? watched.filter((r) => repoIds.includes(r.id)) : watched;
  const scopedIds = reposScoped.map((r) => r.id);

  // No watched repos in scope → a valid empty response (also avoids an inArray([]) below).
  if (scopedIds.length === 0) return { repos: [], generatedAt: new Date().toISOString() };

  // The compact-header `stats` stay REPO-scoped (repo health: open/draft/merged/stalled/
  // median-first-review) — filtering them by member would misreport repo throughput. The
  // PR cards + thread bar reflect the member filter via getOpenPrs' userIds. Pass the
  // watched-scoped ids (never the raw repoIds) so downstream readers stay watched-only.
  const [insights, openPrs, mergers] = await Promise.all([
    getInsights({ accountId, repoIds: scopedIds }),
    getOpenPrs({ accountId, repoIds: scopedIds, userIds }),
    getMergers(accountId),
  ]);

  const insightsByRepo = new Map(insights.repos.map((r) => [r.repoId, r]));
  const mergersByRepo = new Map(mergers.map((m) => [m.repoId, m.userIds]));
  const prsByRepo = new Map<number, TimelinePr[]>();
  for (const pr of openPrs) {
    const arr = prsByRepo.get(pr.repoId);
    if (arr) arr.push(pr);
    else prsByRepo.set(pr.repoId, [pr]);
  }

  // Deterministic per-repo review-bot signal over these open PRs (no AI): threads a known
  // AI review bot opened, split by whether a later commit has acted on them. Empty map (0)
  // when the account runs no review bot — the headline stat then simply doesn't render.
  const botThreadCountsByPr = await buildBotThreadCounts(
    openPrs.map((pr) => pr.id),
    await automatedReviewerUserIds(accountId),
  );

  // Preserve listRepos order (stable, not jumpy across loads).
  const activityRepos: ActivityRepo[] = reposScoped.map((repo) => {
    const repoPrs = prsByRepo.get(repo.id) ?? [];
    const ins = insightsByRepo.get(repo.id);

    const botTotals = emptyCounts();
    for (const pr of repoPrs) {
      const bc = botThreadCountsByPr.get(pr.id);
      if (!bc) continue;
      botTotals.untouched += bc.untouched;
      botTotals.replied_unresolved += bc.replied_unresolved;
      botTotals.likely_addressed += bc.likely_addressed;
      botTotals.resolved += bc.resolved;
    }
    const botThreads = botThreadTotal(botTotals);
    const botThreadsActedOn = botActedOn(botTotals);

    const stats: ActivityRepoStats = ins
      ? {
          openPrs: ins.openPrs,
          draftPrs: ins.draftPrs,
          mergedLast7d: ins.mergedLast7d,
          stalledPrs: ins.stalledPrs,
          medianHoursToFirstReview: ins.medianHoursToFirstReview,
          oldestUnreviewed: ins.oldestUnreviewed,
          botThreads,
          botThreadsActedOn,
        }
      : {
          openPrs: 0,
          draftPrs: 0,
          mergedLast7d: 0,
          stalledPrs: 0,
          medianHoursToFirstReview: null,
          oldestUnreviewed: null,
          botThreads,
          botThreadsActedOn,
        };

    const threadTotals = emptyCounts();
    for (const pr of repoPrs) {
      threadTotals.untouched += pr.threadCounts.untouched;
      threadTotals.replied_unresolved += pr.threadCounts.replied_unresolved;
      threadTotals.likely_addressed += pr.threadCounts.likely_addressed;
      threadTotals.resolved += pr.threadCounts.resolved;
    }

    const attentionCount = repoPrs.filter(
      (pr) =>
        pr.isStalled ||
        pr.threadCounts.untouched > 0 ||
        ACTIVITY_ATTENTION_REASONS.has(pr.reasonTag),
    ).length;
    const hasUnread = repoPrs.some((pr) => pr.newSinceLastViewed != null);

    return {
      repoId: repo.id,
      repoFullName: repo.fullName,
      stats,
      threadTotals,
      maintainerIds: mergersByRepo.get(repo.id) ?? [],
      attentionCount,
      hasUnread,
      prs: repoPrs,
    };
  });

  return { repos: activityRepos, generatedAt: new Date().toISOString() };
}

// ---- consolidated Feed (the Activity "Feed" entry; CORE, no AI) ----
// A single flat, purely-chronological (newest-first) stream of real activity events, each
// flagged isMyTurn by participation (see getConsolidatedFeed). There is no synthesized
// "My Turn" layer or dedup anymore — one row per underlying event.

// Every My Turn (participated) event is always kept; the plain activity rows are bounded to
// the most recent, so a busy multi-repo account doesn't render thousands of them.
const FEED_EVENT_CAP = 250;
// The Bots pane's bot-only feed filters to automated reviewers IN SQL, so its cap governs bot
// activity alone (not a slice of all activity). Set generously so it spans the full window and
// tracks the ROI thread counts; the feed is paginated + DOM-windowed, so a high total is cheap.
const BOT_FEED_EVENT_CAP = 1000;

// A top-level PR comment and a coinciding "host" event by the SAME actor on the SAME PR are
// folded into ONE card when they land within this window of each other (issue comments carry
// no head SHA, so time is the only proxy for "posted together"). Symmetric around the host.
const COMMENT_MERGE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

// The events a PR comment can fold INTO: a submitted review (approve / comment / request-
// changes) OR a lifecycle action taken WITH a comment — GitHub's "Comment and close" /
// "Comment and merge" post the comment and the close/merge as separate objects at the same
// instant, which otherwise read as two feed cards. The number ranks hosts for the rare tie
// where a comment is equidistant from two (a review is the richest headline, then merge,
// then close).
const HOST_PRIORITY: Record<string, number> = {
  review_submitted: 0,
  pr_merged: 1,
  pr_closed: 2,
};
const hostPriority = (kind: string): number => HOST_PRIORITY[kind] ?? 99;
const isCommentHost = (kind: string): boolean => kind in HOST_PRIORITY;

// Fold each actor's near-in-time top-level PR comment(s) INTO their coinciding host event on
// the same PR (appending to the host's `mergedComments`) and remove those comment rows from
// `items` + `byId`, IN PLACE. A comment with no host within the window keeps its own row; a
// comment is claimed by its NEAREST host (host-priority breaks the rare tie), so two hosts in
// one window don't both grab it. This collapses "approve + summary comment", "close + why",
// and "merge + note" into a single feed card. Exported for unit tests (pure over the arrays).
export function coalesceEventComments(
  items: ConsolidatedFeedItem[],
  byId: Map<string, ConsolidatedFeedItem>,
): void {
  const hostsByKey = new Map<string, ConsolidatedFeedItem[]>();
  const commentsByKey = new Map<string, ConsolidatedFeedItem[]>();
  const bucketPush = (
    m: Map<string, ConsolidatedFeedItem[]>,
    key: string,
    it: ConsolidatedFeedItem,
  ): void => {
    const arr = m.get(key);
    if (arr) arr.push(it);
    else m.set(key, [it]);
  };
  for (const it of items) {
    if (it.actorId == null || it.prId == null) continue;
    const key = `${it.actorId}:${it.prId}`;
    if (isCommentHost(it.kind)) bucketPush(hostsByKey, key, it);
    else if (it.kind === 'pr_comment' && it.commentId != null) bucketPush(commentsByKey, key, it);
  }
  if (hostsByKey.size === 0 || commentsByKey.size === 0) return;

  const foldedIds = new Set<string>();
  for (const [key, comments] of commentsByKey) {
    const hosts = hostsByKey.get(key);
    if (hosts == null) continue;
    for (const comment of comments) {
      const ct = Date.parse(comment.occurredAt);
      let best: ConsolidatedFeedItem | null = null;
      let bestDist = Infinity;
      for (const host of hosts) {
        const dist = Math.abs(Date.parse(host.occurredAt) - ct);
        if (dist > COMMENT_MERGE_WINDOW_MS) continue;
        // Nearest wins; equidistant → the higher-priority host kind.
        if (
          dist < bestDist ||
          (dist === bestDist && best != null && hostPriority(host.kind) < hostPriority(best.kind))
        ) {
          best = host;
          bestDist = dist;
        }
      }
      if (best == null) continue;
      best.mergedComments.push({
        commentId: comment.commentId as number,
        content: comment.content ?? '',
        occurredAt: comment.occurredAt,
      });
      foldedIds.add(comment.id);
    }
  }
  if (foldedIds.size === 0) return;

  // Chronological within each host (a host can fold more than one comment).
  for (const hosts of hostsByKey.values())
    for (const host of hosts)
      if (host.mergedComments.length > 1)
        host.mergedComments.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));

  for (const id of foldedIds) byId.delete(id);
  const kept = items.filter((it) => !foldedIds.has(it.id));
  items.length = 0;
  items.push(...kept);
}

export interface ConsolidatedFeedFilters {
  // null / omitted → ALL the account's repos; a list → scope to those repo ids.
  repoIds?: number[] | null;
  // Member filter: null / empty → all actors; a list → only those actors.
  userIds?: number[] | null;
  // Isolate the feed to a SINGLE PR: null → every PR in scope; a pr id → only that PR's
  // items. Applied after coalesce + my-turn enrich so `total` and the page reflect the
  // isolated set. Drives the Feed "open PRs" panel's per-PR filter.
  prId?: number | null;
  // Mirror the timeline's "exclude bots" toggle: drop feed activity + My Turn items whose
  // actor is a known bot (users.isBot). Claude-review items are never dropped (no member
  // author). Absent/false → bots shown.
  excludeBots?: boolean;
  // Bots to KEEP visible even when excludeBots is on (the per-repo allow-list override).
  // null/empty → exclude every bot. Ignored when excludeBots is false.
  allowBotIds?: number[] | null;
  // The Bots pane's bot-ONLY feed: restrict to the automated-reviewer set (deepsource /
  // coderabbit / classified in-house / Pierre …) IN SQL, before the cap — so bot activity spans
  // the full window instead of being thinned out of a 250-event mixed page. Skips commit-push +
  // Claude items (not review-bot activity), ignores excludeBots, and uses a higher cap. The
  // caller should also drop the member (userIds) filter (bots aren't members).
  botsOnly?: boolean;
  // Pagination over the merged, chronologically-sorted stream. `limit` omitted → the
  // whole stream (legacy). The response `total` is the full count so the client knows
  // when to stop "Load more". Only the returned page is enriched (merge/review credit)
  // + has its users backfilled, so hidden items cost nothing to fetch or render.
  limit?: number | null;
  offset?: number | null;
}

// Commit runs that ADDRESSED a review thread — the only commit activity surfaced in the
// consolidated feed (plain pushes are noise, hidden on the timeline by default too). A
// "run" is consecutive commits by one author on one PR (a >6h gap splits runs). A run is
// kept only when some commit in it touched a still-`likely_addressed` thread's file AFTER
// that thread's last comment — exactly the derive-thread-state heuristic — and the
// addressed threads ride along inline. All queries are accountId-scoped (the seed
// commit_pushed events carry accountId; every downstream id derives from them).
const COMMIT_ITEM_SCAN_CAP = 600; // most-recent commit_pushed events scanned
const COMMIT_RUN_GAP_MS = 6 * 60 * 60 * 1000; // >6h between an author's commits splits runs

async function getCommitThreadItems(
  accountId: number,
  opts: {
    repoIds: number[] | null;
    userIds: number[] | null;
    botIds: Set<number>;
    since: Date;
    // Single-PR isolation (see getFeed): scope to this PR's commit rows. The caller widens
    // `since` alongside it so the isolated view shows the PR's full thread-addressing history.
    prId?: number | null;
  },
): Promise<ConsolidatedFeedItem[]> {
  const { repoIds, userIds, botIds, since, prId = null } = opts;
  const conds: SQL[] = [
    eq(events.accountId, accountId),
    eq(events.type, 'commit_pushed'),
    eq(events.refTable, 'commits'),
    isNotNull(events.refId),
    isNotNull(events.prId),
    gte(events.occurredAt, since),
  ];
  if (prId != null) conds.push(eq(events.prId, prId));
  if (repoIds) conds.push(inArray(events.repoId, repoIds));
  if (userIds && userIds.length > 0) conds.push(inArray(events.actorId, userIds));
  if (botIds.size > 0)
    conds.push(
      sql`(${events.actorId} is null or ${events.actorId} not in (${sql.join(
        [...botIds],
        sql`, `,
      )}))`,
    );

  const evRows = await db
    .select({
      id: events.id,
      actorId: events.actorId,
      prId: events.prId,
      occurredAt: events.occurredAt,
      commitId: events.refId,
      repoId: events.repoId,
      repoOwner: repos.owner,
      repoName: repos.name,
      prNumber: pullRequests.number,
      prTitle: pullRequests.title,
      prState: pullRequests.state,
    })
    .from(events)
    .innerJoin(repos, eq(repos.id, events.repoId))
    .leftJoin(pullRequests, eq(pullRequests.id, events.prId))
    .where(and(...conds))
    .orderBy(desc(events.occurredAt))
    .limit(COMMIT_ITEM_SCAN_CAP)
    .execute();
  if (evRows.length === 0) return [];
  type EvRow = (typeof evRows)[number];

  // Resolve each commit event's sha + committed time.
  const commitIds = [...new Set(evRows.map((r) => r.commitId as number))];
  const commitById = new Map<number, { sha: string; committedAt: Date }>();
  for (const c of await db
    .select({ id: commits.id, sha: commits.sha, committedAt: commits.committedAt })
    .from(commits)
    .where(inArray(commits.id, commitIds))
    .execute())
    commitById.set(c.id, { sha: c.sha, committedAt: c.committedAt });

  // Changed-file paths per commit sha (immutable, content-addressed).
  const shas = [...new Set([...commitById.values()].map((c) => c.sha))];
  const filesBySha = new Map<string, string[]>();
  if (shas.length > 0)
    for (const f of await db
      .select({ sha: commitFiles.sha, paths: commitFiles.paths })
      .from(commitFiles)
      .where(inArray(commitFiles.sha, shas))
      .execute())
      filesBySha.set(f.sha, f.paths ?? []);

  // Candidate threads (currently `likely_addressed`) on the involved PRs.
  const prIds = [...new Set(evRows.map((r) => r.prId as number))];
  type Cand = {
    id: number;
    prId: number;
    path: string;
    line: number | null;
    originalCommenterId: number | null;
  };
  const threadsByPr = new Map<number, Cand[]>();
  const candThreadIds: number[] = [];
  for (const t of await db
    .select({
      id: reviewThreads.id,
      prId: reviewThreads.prId,
      path: reviewThreads.path,
      line: reviewThreads.line,
      originalCommenterId: reviewThreads.originalCommenterId,
    })
    .from(reviewThreads)
    .where(
      and(inArray(reviewThreads.prId, prIds), eq(reviewThreads.derivedState, 'likely_addressed')),
    )
    .execute()) {
    const arr = threadsByPr.get(t.prId) ?? [];
    arr.push(t);
    threadsByPr.set(t.prId, arr);
    candThreadIds.push(t.id);
  }
  if (candThreadIds.length === 0) return [];

  // First-comment excerpt/author + last-comment time per candidate thread. Only the
  // short `excerpt` is loaded (always populated — never the bulky `body`), keeping this
  // per-page pass cheap.
  const firstByThread = new Map<number, { excerpt: string | null; authorId: number | null }>();
  const lastAtByThread = new Map<number, number>();
  for (const c of await db
    .select({
      threadId: reviewComments.threadId,
      createdAt: reviewComments.createdAt,
      excerpt: reviewComments.excerpt,
      authorId: reviewComments.authorId,
    })
    .from(reviewComments)
    .where(inArray(reviewComments.threadId, candThreadIds))
    .orderBy(asc(reviewComments.createdAt))
    .execute()) {
    if (!firstByThread.has(c.threadId))
      firstByThread.set(c.threadId, { excerpt: c.excerpt, authorId: c.authorId });
    lastAtByThread.set(c.threadId, c.createdAt.getTime());
  }

  // Coalesce a PR-author's commit events into contiguous runs (gap > COMMIT_RUN_GAP_MS).
  interface Run {
    prId: number;
    actorId: number | null;
    repoId: number;
    repoFullName: string;
    prNumber: number | null;
    prTitle: string | null;
    prState: PrState | null;
    commitShas: { sha: string; committedAt: Date }[];
    latestOccurredAt: Date;
    latestEventId: number;
    commitCount: number;
  }
  const groups = new Map<string, EvRow[]>();
  for (const r of evRows) {
    const key = `${r.prId}:${r.actorId ?? 'null'}`;
    const arr = groups.get(key) ?? [];
    arr.push(r);
    groups.set(key, arr);
  }
  const runs: Run[] = [];
  for (const arr of groups.values()) {
    const sorted = [...arr].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
    let cur: EvRow[] = [];
    const flush = (): void => {
      if (cur.length === 0) return;
      const first = cur[0]!;
      const last = cur[cur.length - 1]!;
      const commitShas = cur
        .map((e) => commitById.get(e.commitId as number))
        .filter((c): c is { sha: string; committedAt: Date } => c != null);
      runs.push({
        prId: first.prId as number,
        actorId: first.actorId,
        repoId: first.repoId,
        repoFullName: `${first.repoOwner}/${first.repoName}`,
        prNumber: first.prNumber ?? null,
        prTitle: first.prTitle ?? null,
        prState: (first.prState as PrState | null) ?? null,
        commitShas,
        latestOccurredAt: last.occurredAt,
        latestEventId: last.id,
        commitCount: cur.length,
      });
      cur = [];
    };
    for (const e of sorted) {
      if (cur.length === 0) {
        cur = [e];
        continue;
      }
      const prev = cur[cur.length - 1]!;
      if (e.occurredAt.getTime() - prev.occurredAt.getTime() > COMMIT_RUN_GAP_MS) flush();
      cur.push(e);
    }
    flush();
  }

  // Keep only runs that addressed ≥1 thread; attach those threads inline. Attribute each
  // thread to exactly ONE run — the most RECENT run that addressed it — so a thread never
  // appears under two commit cards of the same PR (two co-authors → two runs by key; or one
  // author's pushes split by the >6h gap). Claim newest-first via a shared set.
  const out: ConsolidatedFeedItem[] = [];
  const claimed = new Set<number>();
  const runsByRecency = [...runs].sort(
    (a, b) => b.latestOccurredAt.getTime() - a.latestOccurredAt.getTime(),
  );
  for (const run of runsByRecency) {
    const cands = threadsByPr.get(run.prId) ?? [];
    if (cands.length === 0) continue;
    const affected: FeedAffectedThread[] = [];
    for (const t of cands) {
      if (claimed.has(t.id)) continue;
      const lastAt = lastAtByThread.get(t.id);
      if (lastAt == null) continue;
      const hit = run.commitShas.some(
        (c) => c.committedAt.getTime() > lastAt && (filesBySha.get(c.sha) ?? []).includes(t.path),
      );
      if (!hit) continue;
      claimed.add(t.id);
      const first = firstByThread.get(t.id);
      const excerpt = first?.excerpt ?? '';
      affected.push({
        threadId: t.id,
        path: t.path,
        line: t.line,
        derivedState: 'likely_addressed',
        excerpt,
        authorId: t.originalCommenterId ?? first?.authorId ?? null,
      });
    }
    if (affected.length === 0) continue;
    const commitWord = run.commitCount === 1 ? 'commit' : 'commits';
    const threadWord = affected.length === 1 ? 'thread' : 'threads';
    out.push({
      id: `feed:commitrun:${run.prId}:${run.latestEventId}`,
      // Flagged by the caller (getConsolidatedFeed) once participation is resolved.
      isMyTurn: false,
      myTurnReasons: [],
      kind: 'commit_pushed',
      occurredAt: run.latestOccurredAt.toISOString(),
      repoId: run.repoId,
      repoFullName: run.repoFullName,
      prId: run.prId,
      prNumber: run.prNumber,
      prTitle: run.prTitle,
      prState: run.prState,
      actorId: run.actorId,
      content: null,
      threadId: null,
      commentId: null,
      path: null,
      line: null,
      reasonTag: null,
      reviewState: null,
      githubUrl:
        run.prNumber != null
          ? `https://github.com/${run.repoFullName}/pull/${run.prNumber}`
          : null,
      mergedById: null,
      reviewers: null,
      ciStatus: null,
      changedFilesCount: null,
      affectedThreads: affected,
      commitCount: run.commitCount,
      changeSummary: `pushed ${run.commitCount} ${commitWord} · addressed ${affected.length} ${threadWord}`,
      claudeReviewId: null,
      claudeVerdict: null,
      mergedComments: [],
    });
  }
  return out;
}

// Claude Review runs surfaced in the consolidated feed as their own item kind. One item
// per PR = that PR's most-recent SUCCEEDED run finished within the feed window, repo-scoped.
// Gated on the feature flag (force-off in cloud) so no items appear where Claude Review
// doesn't exist. Never member-/bot-filtered (a run has no member author).
async function getClaudeReviewFeedItems(
  accountId: number,
  repoIds: number[] | null,
  since: Date,
  // Single-PR isolation (see getFeed): scope to this PR's runs (with a widened `since`).
  prId: number | null = null,
): Promise<ConsolidatedFeedItem[]> {
  if (!getProCapabilities().claudeReview) return [];
  const conds = [
    eq(repos.accountId, accountId),
    eq(claudeReviews.status, 'succeeded'),
    gte(sql`coalesce(${claudeReviews.finishedAt}, ${claudeReviews.createdAt})`, tsBound(since)),
  ];
  if (prId != null) conds.push(eq(claudeReviews.prId, prId));
  if (repoIds) conds.push(inArray(pullRequests.repoId, repoIds));
  const rows = await db
    .select({
      reviewId: claudeReviews.id,
      prId: claudeReviews.prId,
      repoId: pullRequests.repoId,
      owner: repos.owner,
      name: repos.name,
      prNumber: pullRequests.number,
      prTitle: pullRequests.title,
      prState: pullRequests.state,
      summary: claudeReviews.summary,
      verdict: claudeReviews.verdict,
      userVerdict: claudeReviews.userVerdict,
      finishedAt: claudeReviews.finishedAt,
      createdAt: claudeReviews.createdAt,
    })
    .from(claudeReviews)
    .innerJoin(pullRequests, eq(pullRequests.id, claudeReviews.prId))
    .innerJoin(repos, eq(repos.id, pullRequests.repoId))
    .where(and(...conds))
    .orderBy(desc(claudeReviews.finishedAt), desc(claudeReviews.createdAt))
    .execute();
  // Keep the most-recent succeeded run per PR (rows are newest-first).
  const seen = new Set<number>();
  const out: ConsolidatedFeedItem[] = [];
  for (const r of rows) {
    if (seen.has(r.prId)) continue;
    seen.add(r.prId);
    out.push({
      id: `feed:claude:${r.reviewId}`,
      isMyTurn: false,
      myTurnReasons: [],
      kind: 'claude_review',
      occurredAt: (r.finishedAt ?? r.createdAt).toISOString(),
      repoId: r.repoId,
      repoFullName: `${r.owner}/${r.name}`,
      prId: r.prId,
      prNumber: r.prNumber,
      prTitle: r.prTitle,
      prState: r.prState,
      actorId: null,
      content: r.summary,
      threadId: null,
      commentId: null,
      path: null,
      line: null,
      reasonTag: null,
      reviewState: null,
      githubUrl:
        r.prNumber != null ? `https://github.com/${r.owner}/${r.name}/pull/${r.prNumber}` : null,
      mergedById: null,
      reviewers: null,
      ciStatus: null,
      changedFilesCount: null,
      affectedThreads: null,
      commitCount: null,
      changeSummary: null,
      claudeReviewId: r.reviewId,
      // Prefer the user's decision when they've set one, else Claude's read-only verdict.
      claudeVerdict: r.userVerdict ?? r.verdict,
      mergedComments: [],
    });
  }
  return out;
}

// ---- Activity-Feed "seen" marker (server-side, per account) ----

// The account's last feed-view timestamp (null until the first view).
export async function getFeedLastSeenAt(accountId: number): Promise<Date | null> {
  const rows = await db
    .select({ at: accounts.feedLastSeenAt })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1)
    .execute();
  return rows[0]?.at ?? null;
}

// Record that the account has now viewed the feed (bumps the "seen" marker to now).
export async function markFeedSeen(accountId: number): Promise<Date> {
  const now = new Date();
  await db
    .update(accounts)
    .set({ feedLastSeenAt: now })
    .where(eq(accounts.id, accountId))
    .execute();
  return now;
}

// ---- Team review-intelligence "Insights" (Pro; teamInsights) ----

const INSIGHT_STALLED_REVIEW_HOURS = 24;
const INSIGHT_UNTOUCHED_THREAD_HOURS = 24; // "> 1 day"
const INSIGHT_SPRINT_DAYS = 14; // trailing 2 weeks
const INSIGHT_ROUTING_MIN_AGE_HOURS = 4; // ignore brand-new PRs
// A PR with NO activity (GitHub updatedAt) in this many days is "ultra-stale": effectively
// abandoned-but-unclosed, no longer being looked at. Insight cards (and, downstream, the AI
// sprint report) exclude them so they don't clutter "what needs attention". 90d = the board's
// max range — beyond it, a PR is off everyone's radar.
const INSIGHT_MAX_STALE_DAYS = 90;
const INSIGHT_CARD_CAP = 15; // per-kind cap so the board stays digestible

function topLevelDir(path: string): string {
  const i = path.indexOf('/');
  return i === -1 ? '.' : path.slice(0, i);
}

const TEAM_METRICS_WINDOW_DAYS = 84; // 12 weeks of weekly chart history
const TEAM_METRICS_WEEK_MS = 7 * 86_400_000;
// A cur-vs-prev stat comparison needs at least this many items on BOTH sides to be worth a
// trend read. Below it (typical early in a sprint — often a single carryover PR) the stat is
// flagged low-confidence: the tile drops the delta arrow and the AI report states the raw "so
// far" figure without a percentage / "cliff" / "spike". This is what stops a day-1 report from
// claiming "merges collapsed 99%" off a 1-vs-N sample.
const TEAM_METRIC_MIN_SAMPLE = 3;

// The comparison window handed in by the Pro layer (getComparisonWindow). fromMs/toMs drive the
// cur/prev math; `mode` is passed straight through onto TeamMetrics.comparisonMode so the UI + AI
// report label value/previous correctly. A rolling_N window has toMs === now (elapsed === full →
// "previous" is the immediately-preceding N days); a sprint window has toMs in the future.
type MetricsWindow = { fromMs: number; toMs: number; mode?: SprintComparisonMode };

function medianOf(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

// Team-wide DORA-ish flow metrics across the watched repos (NO AI). Best-effort DORA
// mapping from synced PR/CI data: deploy frequency = merges; lead time = open→merge;
// change-failure (inverted) = merged-PR CI success; time-to-restore is a PROXY off the
// current snapshot (open PRs red on CI + how long they've sat) since no CI-state history
// is stored. The weekly CHART series are ALWAYS a fixed 12 weeks ending now (independent of
// any sprint window); the stat TILES compare THIS sprint to the immediately-preceding
// equal-length one, aligned to the configured sprint `window` (default trailing 14d). The
// DB fetch spans max(12 weeks, both sprints) so the "previous" tiles aren't starved. Weekly
// series (aligned to `weekBuckets`) feed the same chart toolkit the per-repo analytics use.
export async function getTeamMetrics(
  accountId: number,
  repoIds: number[],
  nowMs: number,
  // The comparison window (epoch millis) + mode for the stat TILES: THIS window's elapsed slice vs
  // the SAME slice of the immediately-preceding one. Undefined → the legacy trailing-14d default.
  // The CHART window is a fixed 12 weeks regardless.
  window?: MetricsWindow,
): Promise<TeamMetrics | null> {
  if (repoIds.length === 0) return null;

  // Charts: a fixed 12-week window ending now, INDEPENDENT of the sprint window.
  const chartWindowStartMs = nowMs - TEAM_METRICS_WINDOW_DAYS * 86_400_000;

  // Sprint tiles: this sprint SO FAR (curLo..curHi, never counting the future) vs the SAME
  // elapsed slice of the immediately-preceding sprint. ELAPSED-MATCHED: `prevHi` tracks how far
  // into the sprint we are (prevLo + elapsed), NOT the full prior sprint (prevLo..curLo). On day
  // 1 this compares day-1-so-far vs the previous sprint's first day — a fair, apples-to-apples
  // read — instead of a few hours against a complete 14-day sprint (which surfaced as merges
  // "down 99%" and lead time "spiked 37×" the moment a sprint rolled over). At sprint end
  // elapsedMs === sprintLenMs → prevHi === curLo, i.e. it degrades to the full-vs-full compare.
  const curLo = window ? window.fromMs : nowMs - INSIGHT_SPRINT_DAYS * 86_400_000;
  const curHi = Math.min(window ? window.toMs : nowMs, nowMs);
  const sprintLenMs = window ? window.toMs - window.fromMs : INSIGHT_SPRINT_DAYS * 86_400_000;
  const elapsedMs = Math.max(0, curHi - curLo);
  const prevLo = curLo - sprintLenMs;
  const prevHi = prevLo + elapsedMs;

  // Fetch must cover BOTH the chart window AND the previous sprint (which can predate it) —
  // this is what actually feeds the cur-vs-prev "previous" tiles (else they come back 0).
  const fetchStartMs = Math.min(chartWindowStartMs, prevLo);
  const fetchStart = new Date(fetchStartMs);

  const prs = await db
    .select({
      state: pullRequests.state,
      isDraft: pullRequests.isDraft,
      openedAt: pullRequests.openedAt,
      firstReviewAt: pullRequests.firstReviewAt,
      mergedAt: pullRequests.mergedAt,
      lastCommitAt: pullRequests.lastCommitAt,
      ciStatus: pullRequests.ciStatus,
    })
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.accountId, accountId),
        inArray(pullRequests.repoId, repoIds),
        // Everything currently open, plus anything opened or merged within the fetch window
        // (max of the 12-week chart span and the previous sprint).
        or(
          eq(pullRequests.state, 'open'),
          gte(pullRequests.openedAt, fetchStart),
          gte(pullRequests.mergedAt, fetchStart),
        ),
      ),
    )
    .execute();

  const nBuckets = Math.max(1, Math.round((nowMs - chartWindowStartMs) / TEAM_METRICS_WEEK_MS));
  const weekBuckets: string[] = [];
  for (let i = 0; i < nBuckets; i++)
    weekBuckets.push(new Date(chartWindowStartMs + i * TEAM_METRICS_WEEK_MS).toISOString());
  const bi = (ms: number): number =>
    Math.max(
      0,
      Math.min(nBuckets - 1, Math.floor((ms - chartWindowStartMs) / TEAM_METRICS_WEEK_MS)),
    );
  const zeros = (): number[] => new Array<number>(nBuckets).fill(0);

  const openedSeries = zeros();
  const mergedSeries = zeros();
  const leadByBucket: number[][] = Array.from({ length: nBuckets }, () => []);
  const ciByBucket = Array.from({ length: nBuckets }, () => ({ succ: 0, total: 0 }));

  const inWin = (ms: number, lo: number, hi: number): boolean => ms >= lo && ms < hi;

  const leadCur: number[] = [];
  const leadPrev: number[] = [];
  const ttfrCur: number[] = [];
  const ttfrPrev: number[] = [];
  let mergesCur = 0;
  let mergesPrev = 0;
  const ciMergedCur = { succ: 0, total: 0 };
  const ciMergedPrev = { succ: 0, total: 0 };
  const failingAges: number[] = [];
  let ciFailingNow = 0;
  let openPrsNow = 0;

  for (const p of prs) {
    const openedMs = p.openedAt.getTime();
    if (openedMs >= chartWindowStartMs) openedSeries[bi(openedMs)]! += 1;
    if (p.state === 'open' && !p.isDraft) openPrsNow += 1;

    if (p.firstReviewAt != null) {
      const ttfr = (p.firstReviewAt.getTime() - openedMs) / 3_600_000;
      if (ttfr >= 0) {
        if (inWin(openedMs, curLo, curHi)) ttfrCur.push(ttfr);
        else if (inWin(openedMs, prevLo, prevHi)) ttfrPrev.push(ttfr);
      }
    }

    if (p.state === 'merged' && p.mergedAt != null) {
      const mergedMs = p.mergedAt.getTime();
      if (mergedMs >= chartWindowStartMs) {
        mergedSeries[bi(mergedMs)]! += 1;
        const lead = (mergedMs - openedMs) / 3_600_000;
        if (lead >= 0) leadByBucket[bi(mergedMs)]!.push(lead);
        const green = p.ciStatus === 'success';
        const cb = ciByBucket[bi(mergedMs)]!;
        cb.total += 1;
        if (green) cb.succ += 1;
      }
      // Sprint tiles are independent of the chart window (a merge in the prev sprint but
      // before the 12-week chart still counts toward the "previous" tile).
      if (inWin(mergedMs, curLo, curHi)) {
        mergesCur += 1;
        const lead = (mergedMs - openedMs) / 3_600_000;
        if (lead >= 0) leadCur.push(lead);
        ciMergedCur.total += 1;
        if (p.ciStatus === 'success') ciMergedCur.succ += 1;
      } else if (inWin(mergedMs, prevLo, prevHi)) {
        mergesPrev += 1;
        const lead = (mergedMs - openedMs) / 3_600_000;
        if (lead >= 0) leadPrev.push(lead);
        ciMergedPrev.total += 1;
        if (p.ciStatus === 'success') ciMergedPrev.succ += 1;
      }
    }

    if (
      p.state === 'open' &&
      !p.isDraft &&
      (p.ciStatus === 'failure' || p.ciStatus === 'error')
    ) {
      ciFailingNow += 1;
      const since = (p.lastCommitAt ?? p.openedAt).getTime();
      failingAges.push((nowMs - since) / 3_600_000);
    }
  }

  const pct = (s: { succ: number; total: number }): number | null =>
    s.total === 0 ? null : Math.round((s.succ / s.total) * 100);

  // ---- CI recovery + failure reasons (from the ci_status_events transition log) ----
  // Walk each PR's events in time order: a red streak opens on the first failure and
  // closes on the next success → a resolution duration. Failing-check names tally into
  // the by-stage reason breakdown. A red streak spanning multiple commits stays "one"
  // until it goes green (total time-broken).
  const ciEvents = await db
    .select({
      prId: ciStatusEvents.prId,
      status: ciStatusEvents.status,
      failingChecks: ciStatusEvents.failingChecks,
      observedAt: ciStatusEvents.observedAt,
    })
    .from(ciStatusEvents)
    .where(
      and(
        eq(ciStatusEvents.accountId, accountId),
        inArray(ciStatusEvents.repoId, repoIds),
        gte(ciStatusEvents.observedAt, fetchStart),
      ),
    )
    .orderBy(ciStatusEvents.prId, ciStatusEvents.observedAt)
    .execute();

  const recoveries: { atMs: number; hours: number }[] = [];
  const reasonCounts = new Map<string, number>();
  let curPr: number | null = null;
  let failStartMs: number | null = null;
  for (const e of ciEvents) {
    if (e.prId !== curPr) {
      curPr = e.prId;
      failStartMs = null;
    }
    const obsMs = e.observedAt.getTime();
    if (e.status === 'failure' || e.status === 'error') {
      if (failStartMs == null) failStartMs = obsMs;
      for (const name of e.failingChecks ?? [])
        reasonCounts.set(name, (reasonCounts.get(name) ?? 0) + 1);
    } else if (e.status === 'success' && failStartMs != null) {
      recoveries.push({ atMs: obsMs, hours: (obsMs - failStartMs) / 3_600_000 });
      failStartMs = null;
    }
  }

  const recoveryByBucket: number[][] = Array.from({ length: nBuckets }, () => []);
  const recCur: number[] = [];
  const recPrev: number[] = [];
  for (const r of recoveries) {
    if (r.atMs >= chartWindowStartMs) recoveryByBucket[bi(r.atMs)]!.push(r.hours);
    if (inWin(r.atMs, curLo, curHi)) recCur.push(r.hours);
    else if (inWin(r.atMs, prevLo, prevHi)) recPrev.push(r.hours);
  }
  const ciFailureReasons = [...reasonCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([stage, count]) => ({ stage, count }));

  // Wrap each cur/prev pair with its sample sizes + a low-confidence flag (either side below
  // TEAM_METRIC_MIN_SAMPLE). For counts the sample IS the value; for medians/percentages it's
  // the number of items that fed the statistic.
  const stat = (
    value: number | null,
    previous: number | null,
    curN: number,
    prevN: number,
  ): TeamMetricStat => ({
    value,
    previous,
    sampleSize: curN,
    previousSampleSize: prevN,
    lowConfidence: curN < TEAM_METRIC_MIN_SAMPLE || prevN < TEAM_METRIC_MIN_SAMPLE,
  });

  const elapsedDays = elapsedMs / 86_400_000;
  const elapsedFraction = sprintLenMs > 0 ? Math.min(1, elapsedMs / sprintLenMs) : 1;

  return {
    comparisonMode: window?.mode ?? 'rolling_14',
    sprintDays: Math.round(sprintLenMs / 86_400_000),
    elapsedDays: Math.round(elapsedDays * 10) / 10,
    elapsedFraction,
    weekBuckets,
    openPrs: openPrsNow,
    merges: stat(mergesCur, mergesPrev, mergesCur, mergesPrev),
    leadTimeHours: stat(medianOf(leadCur), medianOf(leadPrev), leadCur.length, leadPrev.length),
    timeToFirstReviewHours: stat(
      medianOf(ttfrCur),
      medianOf(ttfrPrev),
      ttfrCur.length,
      ttfrPrev.length,
    ),
    mergeCiSuccessPct: stat(
      pct(ciMergedCur),
      pct(ciMergedPrev),
      ciMergedCur.total,
      ciMergedPrev.total,
    ),
    ciFailingNow,
    ciFailingMedianAgeHours: medianOf(failingAges),
    ciRecoveryHours: stat(medianOf(recCur), medianOf(recPrev), recCur.length, recPrev.length),
    throughput: { opened: openedSeries, merged: mergedSeries },
    leadTimeTrend: leadByBucket.map(medianOf),
    ciSuccessTrend: ciByBucket.map(pct),
    ciRecoveryTrend: recoveryByBucket.map(medianOf),
    ciFailureReasons,
  };
}

// Per-list safety cap for the drill-down. Deliberately GENEROUS: the lists are already
// bounded (the 2-week sprint window for merges / review-latency / recovery; the open-PR
// backlog for lead-time / red-now), so 500 shows every entry for any realistic sprint —
// it's a guard against a pathological payload, not a display limit (a low cap like 100
// looked like a rounded "real" count in the tab badges).
const METRIC_DETAIL_CAP = 500;

// The per-metric PR lists behind the 6 flow-metric tiles (the drill-down). A heavier,
// on-demand read than getTeamMetrics — loaded only when a tile is clicked — over the
// WATCHED repos + the current sprint. Returns the PRs behind each tile with the
// metric-specific figures, so the user can see WHERE issues cluster.
export async function getTeamMetricsDetail(
  accountId: number,
  // The comparison window (epoch millis); undefined → legacy default lookback. The lower bound
  // uses window.fromMs; `now` remains the upper bound. `mode` is unused here (a current-window PR
  // list, no cur/prev split) but accepted so callers pass the same object as getTeamMetrics.
  window?: MetricsWindow,
  // Optional explicit repo scope (per-team AI). When provided (non-null) these exact repos are
  // used INSTEAD of the account's watched set; null/undefined keeps the watched-set default. An
  // empty array (e.g. a scope that resolved to no repos) → the empty result.
  scopeRepoIds?: number[] | null,
): Promise<TeamMetricsDetail> {
  const now = Date.now();
  const sprintFromMs = window?.fromMs ?? now - INSIGHT_SPRINT_DAYS * 86_400_000;
  const sprintFrom = new Date(sprintFromMs);
  const sprint = {
    from: sprintFrom.toISOString(),
    to: new Date(window?.toMs ?? now).toISOString(),
  };
  const empty: TeamMetricsDetail = {
    sprint,
    openPrs: [],
    merges: [],
    leadTime: [],
    reviewLatency: [],
    mergeCi: [],
    ciRecovery: [],
    ciRed: [],
    users: [],
  };

  // An explicit empty scope short-circuits (also dodges the empty-array inArray pitfall below).
  if (scopeRepoIds != null && scopeRepoIds.length === 0) return empty;
  const watched = await db
    .select({ id: repos.id, owner: repos.owner, name: repos.name })
    .from(repos)
    .where(
      scopeRepoIds != null
        ? and(eq(repos.accountId, accountId), inArray(repos.id, scopeRepoIds))
        : and(eq(repos.accountId, accountId), eq(repos.inboxWatch, true)),
    )
    .execute();
  const repoIds = watched.map((r) => r.id);
  if (repoIds.length === 0) return empty;
  const repoName = new Map(watched.map((r) => [r.id, `${r.owner}/${r.name}`]));
  const ghUrl = (repoId: number, number: number): string =>
    `https://github.com/${repoName.get(repoId)}/pull/${number}`;

  // (0) CI recoveries (red→green) from the transition log — walked over a slightly wider
  // window than the sprint so a red streak that STARTED before the sprint but resolved
  // inside it is still measured. We keep, per PR, the LONGEST recovery resolved in-sprint.
  const recoveryWindow = new Date(now - 30 * 86_400_000);
  const ciEvents = await db
    .select({
      prId: ciStatusEvents.prId,
      status: ciStatusEvents.status,
      observedAt: ciStatusEvents.observedAt,
    })
    .from(ciStatusEvents)
    .where(
      and(
        eq(ciStatusEvents.accountId, accountId),
        inArray(ciStatusEvents.repoId, repoIds),
        gte(ciStatusEvents.observedAt, recoveryWindow),
      ),
    )
    .orderBy(ciStatusEvents.prId, ciStatusEvents.observedAt)
    .execute();
  const recoveryByPr = new Map<number, number>(); // prId -> longest in-sprint recovery hours
  {
    let curPr: number | null = null;
    let failStartMs: number | null = null;
    for (const e of ciEvents) {
      if (e.prId !== curPr) {
        curPr = e.prId;
        failStartMs = null;
      }
      const obsMs = e.observedAt.getTime();
      if (e.status === 'failure' || e.status === 'error') {
        if (failStartMs == null) failStartMs = obsMs;
      } else if (e.status === 'success' && failStartMs != null) {
        if (obsMs >= sprintFromMs) {
          const hours = (obsMs - failStartMs) / 3_600_000;
          recoveryByPr.set(e.prId, Math.max(recoveryByPr.get(e.prId) ?? 0, hours));
        }
        failStartMs = null;
      }
    }
  }
  const recoveryPrIds = [...recoveryByPr.keys()];

  // The candidate PR set: everything currently open, plus merged / first-reviewed inside
  // the sprint, plus any PR that recovered in-sprint (so its row has metadata).
  const prs = await db
    .select({
      id: pullRequests.id,
      repoId: pullRequests.repoId,
      number: pullRequests.number,
      title: pullRequests.title,
      authorId: pullRequests.authorId,
      mergedById: pullRequests.mergedById,
      state: pullRequests.state,
      isDraft: pullRequests.isDraft,
      openedAt: pullRequests.openedAt,
      firstReviewAt: pullRequests.firstReviewAt,
      mergedAt: pullRequests.mergedAt,
      lastCommitAt: pullRequests.lastCommitAt,
      ciStatus: pullRequests.ciStatus,
      additions: pullRequests.additions,
      deletions: pullRequests.deletions,
      changedFiles: pullRequests.changedFiles,
    })
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.accountId, accountId),
        inArray(pullRequests.repoId, repoIds),
        or(
          eq(pullRequests.state, 'open'),
          gte(pullRequests.mergedAt, sprintFrom),
          gte(pullRequests.firstReviewAt, sprintFrom),
          recoveryPrIds.length > 0
            ? inArray(pullRequests.id, recoveryPrIds)
            : undefined,
        ),
      ),
    )
    .execute();

  const userIds = new Set<number>();
  type Row = (typeof prs)[number];
  const base = (p: Row): MetricPr => {
    if (p.authorId != null) userIds.add(p.authorId);
    return {
      prId: p.id,
      repoId: p.repoId,
      repoFullName: repoName.get(p.repoId) ?? '',
      prNumber: p.number,
      prTitle: p.title,
      authorId: p.authorId,
      state: p.state,
      githubUrl: ghUrl(p.repoId, p.number),
      ciStatus: p.ciStatus,
      additions: p.additions,
      deletions: p.deletions,
      changedFiles: p.changedFiles,
      openedAt: p.openedAt.toISOString(),
      mergedAt: p.mergedAt ? p.mergedAt.toISOString() : null,
      leadTimeHours: null,
      reviewLatencyHours: null,
      recoveryHours: null,
      redAgeHours: null,
      mergedById: null,
      reviewerIds: [],
    };
  };

  const mergedInSprint = prs.filter(
    (p) => p.state === 'merged' && p.mergedAt != null && p.mergedAt.getTime() >= sprintFromMs,
  );
  const openNonDraft = prs.filter((p) => p.state === 'open' && !p.isDraft);
  const isRed = (ci: Row['ciStatus']): boolean => ci === 'failure' || ci === 'error';

  // (0) OPEN PRS — every currently-open, non-draft PR, longest-open first. The metric-
  // specific figure is the open age (open→now), shown in the same "lead time"-style column.
  const openPrs = openNonDraft
    .map((p) => ({
      ...base(p),
      leadTimeHours: (now - p.openedAt.getTime()) / 3_600_000,
    }))
    .sort((a, b) => (b.leadTimeHours ?? 0) - (a.leadTimeHours ?? 0))
    .slice(0, METRIC_DETAIL_CAP);

  // (1) MERGES — merged in the sprint, newest first (client groups per repo).
  const merges = mergedInSprint
    .slice()
    .sort((a, b) => b.mergedAt!.getTime() - a.mergedAt!.getTime())
    .slice(0, METRIC_DETAIL_CAP)
    .map((p) => {
      if (p.mergedById != null) userIds.add(p.mergedById);
      return {
        ...base(p),
        leadTimeHours: (p.mergedAt!.getTime() - p.openedAt.getTime()) / 3_600_000,
        mergedById: p.mergedById,
      };
    });

  // (2) LEAD TIME — merged-in-sprint (open→merge) + currently-open (open→now), longest first.
  const leadTime = [
    ...mergedInSprint.map((p) => ({
      ...base(p),
      leadTimeHours: (p.mergedAt!.getTime() - p.openedAt.getTime()) / 3_600_000,
    })),
    ...openNonDraft.map((p) => ({
      ...base(p),
      leadTimeHours: (now - p.openedAt.getTime()) / 3_600_000,
    })),
  ]
    .sort((a, b) => (b.leadTimeHours ?? 0) - (a.leadTimeHours ?? 0))
    .slice(0, METRIC_DETAIL_CAP);

  // (3) REVIEW LATENCY — PRs opened in the sprint that received a review, longest open→
  // first-review first. Reviewer ids attached below.
  const reviewLatency = prs
    .filter((p) => p.firstReviewAt != null && p.openedAt.getTime() >= sprintFromMs)
    .map((p) => ({
      ...base(p),
      reviewLatencyHours: (p.firstReviewAt!.getTime() - p.openedAt.getTime()) / 3_600_000,
    }))
    .filter((r) => (r.reviewLatencyHours ?? -1) >= 0)
    .sort((a, b) => (b.reviewLatencyHours ?? 0) - (a.reviewLatencyHours ?? 0))
    .slice(0, METRIC_DETAIL_CAP);
  if (reviewLatency.length > 0) {
    const reviewerRows = await db
      .select({ prId: reviews.prId, authorId: reviews.authorId })
      .from(reviews)
      .where(
        and(
          inArray(
            reviews.prId,
            reviewLatency.map((r) => r.prId),
          ),
          isNotNull(reviews.authorId),
        ),
      )
      .execute();
    const byPr = new Map<number, Set<number>>();
    for (const r of reviewerRows) {
      if (r.authorId == null) continue;
      userIds.add(r.authorId);
      const s = byPr.get(r.prId) ?? new Set<number>();
      s.add(r.authorId);
      byPr.set(r.prId, s);
    }
    for (const r of reviewLatency) r.reviewerIds = [...(byPr.get(r.prId) ?? [])];
  }

  // (4) MERGE CI — merged-in-sprint PRs, the ones that merged with red/failing CI first.
  const mergeCi = mergedInSprint
    .slice()
    .map((p) => {
      if (p.mergedById != null) userIds.add(p.mergedById);
      return {
        ...base(p),
        leadTimeHours: (p.mergedAt!.getTime() - p.openedAt.getTime()) / 3_600_000,
        mergedById: p.mergedById,
      };
    })
    .sort((a, b) => {
      const ra = isRed(a.ciStatus) ? 0 : a.ciStatus === 'success' ? 2 : 1;
      const rb = isRed(b.ciStatus) ? 0 : b.ciStatus === 'success' ? 2 : 1;
      return ra - rb || (b.mergedAt ?? '').localeCompare(a.mergedAt ?? '');
    })
    .slice(0, METRIC_DETAIL_CAP);

  // (5) CI RECOVERY — PRs with a red→green recovery in-sprint, slowest first.
  const ciRecovery = prs
    .filter((p) => recoveryByPr.has(p.id))
    .map((p) => ({ ...base(p), recoveryHours: recoveryByPr.get(p.id) ?? null }))
    .sort((a, b) => (b.recoveryHours ?? 0) - (a.recoveryHours ?? 0))
    .slice(0, METRIC_DETAIL_CAP);

  // (6) CI RED NOW — open, non-draft PRs currently failing CI, longest red first.
  const ciRed = openNonDraft
    .filter((p) => isRed(p.ciStatus))
    .map((p) => ({
      ...base(p),
      redAgeHours: (now - (p.lastCommitAt ?? p.openedAt).getTime()) / 3_600_000,
    }))
    .sort((a, b) => (b.redAgeHours ?? 0) - (a.redAgeHours ?? 0))
    .slice(0, METRIC_DETAIL_CAP);

  const userRows =
    userIds.size > 0
      ? await db.select().from(users).where(inArray(users.id, [...userIds])).execute()
      : [];

  return {
    sprint,
    openPrs,
    merges,
    leadTime,
    reviewLatency,
    mergeCi,
    ciRecovery,
    ciRed,
    users: userRows.map(mapUser),
  };
}

// Compute the team review-intelligence cards from already-synced data — NO AI. WATCHED
// repos (`inboxWatch`) are the team; "sprint" is the trailing 2 weeks. Runs on read (the
// client refetches on the sync cadence); every query is account-scoped + bounded (watched
// repos, open PRs, the sprint window, per-kind caps).
export async function getTeamInsights(
  accountId: number,
  window?: MetricsWindow,
  // Optional explicit repo scope (per-team AI). When provided (non-null) these exact repos are
  // used INSTEAD of the account's watched set (both for the cards AND the forwarded team
  // metrics); null/undefined keeps the watched-set default. An empty array → no repos.
  scopeRepoIds?: number[] | null,
): Promise<TeamInsightsResponse> {
  const now = Date.now();
  const generatedAt = new Date(now);
  // The Insights window: the configured SPRINT when provided (its `to` may be in the future for
  // the in-progress sprint — metrics facts only exist up to `now`), else the legacy default.
  // Insight CARDS iterate currently-open PRs that have had activity within the last
  // INSIGHT_MAX_STALE_DAYS (ultra-stale = abandoned, excluded), independently of this window;
  // the window only bounds the time-based flow metrics.
  const sprintFrom = new Date(window?.fromMs ?? now - INSIGHT_SPRINT_DAYS * 86_400_000);
  const sprintTo = new Date(window?.toMs ?? now);
  const sprint = { from: sprintFrom.toISOString(), to: sprintTo.toISOString() };
  const cards: InsightCard[] = [];
  const userIdSet = new Set<number>();
  const addUser = (id: number | null): void => {
    if (id != null) userIdSet.add(id);
  };

  const watched =
    scopeRepoIds != null && scopeRepoIds.length === 0
      ? [] // explicit empty scope → no repos (dodges the empty-array inArray pitfall)
      : await db
          .select({ id: repos.id, owner: repos.owner, name: repos.name })
          .from(repos)
          .where(
            scopeRepoIds != null
              ? and(eq(repos.accountId, accountId), inArray(repos.id, scopeRepoIds))
              : and(eq(repos.accountId, accountId), eq(repos.inboxWatch, true)),
          )
          .execute();
  const repoName = new Map(watched.map((r) => [r.id, `${r.owner}/${r.name}`]));
  const repoIds = watched.map((r) => r.id);
  const finish = async (): Promise<TeamInsightsResponse> => {
    const kindRank: Record<InsightKind, number> = {
      bot_signal: 0, // the flagship "layer above your review bot" summary, leads its severity tier
      bot_only_review: 1, // the governance "only a bot reviewed this" risk, right after
      stalled_review: 2,
      untouched_thread: 3,
      reviewer_load: 4,
      reviewer_routing: 5,
    };
    const sevRank: Record<InsightSeverity, number> = { high: 0, warn: 1, info: 2 };
    cards.sort(
      (a, b) => sevRank[a.severity] - sevRank[b.severity] || kindRank[a.kind] - kindRank[b.kind],
    );
    const userRows =
      userIdSet.size > 0
        ? await db.select().from(users).where(inArray(users.id, [...userIdSet])).execute()
        : [];
    const metrics = await getTeamMetrics(accountId, repoIds, now, window);
    return {
      enabled: true,
      generatedAt: generatedAt.toISOString(),
      sprint,
      metrics,
      cards,
      users: userRows.map(mapUser),
    };
  };
  if (repoIds.length === 0) return finish();

  // ── bot_signal card (deterministic, no AI) ──────────────────────────────────
  // The un-copyable cross-repo, cross-bot "signal-to-noise" view: over the sprint window,
  // how many review threads each automated reviewer opened, what share a later commit acted
  // on, and how much untouched backlog is piling up. Computed here (BEFORE the open-PR guard)
  // so it counts bot threads on merged PRs too — "this sprint's" volume, not just open work.
  // Grouped by AutomatedReviewerKind (vendors AND in-house-classified reviewers).
  {
    const botIds = await automatedReviewerUserIds(accountId);
    if (botIds.length > 0) {
      const kindMap = await classificationKindForUser(accountId);
      const rows = await db
        .select({
          userId: reviewThreads.originalCommenterId,
          state: reviewThreads.derivedState,
          createdAt: reviewThreads.createdAt,
        })
        .from(reviewThreads)
        .innerJoin(pullRequests, eq(pullRequests.id, reviewThreads.prId))
        .where(
          and(
            eq(pullRequests.accountId, accountId),
            inArray(pullRequests.repoId, repoIds),
            inArray(reviewThreads.originalCommenterId, botIds),
            gte(reviewThreads.createdAt, sprintFrom),
            lte(reviewThreads.createdAt, sprintTo),
          ),
        )
        .execute();

      type Agg = { threads: number; actedOn: number; untouched: number; oldestUntouchedMs: number | null };
      const byVendor = new Map<AutomatedReviewerKind, Agg>();
      for (const r of rows) {
        const kind = r.userId == null ? undefined : kindMap.get(r.userId);
        if (!kind) continue; // originator matched by id but unclassified — skip defensively
        const v = byVendor.get(kind) ?? { threads: 0, actedOn: 0, untouched: 0, oldestUntouchedMs: null };
        v.threads += 1;
        if (r.state === 'resolved' || r.state === 'likely_addressed') v.actedOn += 1;
        if (r.state === 'untouched') {
          v.untouched += 1;
          const t = r.createdAt.getTime();
          if (v.oldestUntouchedMs == null || t < v.oldestUntouchedMs) v.oldestUntouchedMs = t;
        }
        byVendor.set(kind, v);
      }

      const vendors: BotSignalVendorStat[] = [...byVendor.entries()]
        .map(([kind, v]) => ({
          kind,
          threads: v.threads,
          actedOn: v.actedOn,
          untouched: v.untouched,
          oldestUntouchedDays:
            v.oldestUntouchedMs == null ? null : Math.floor((now - v.oldestUntouchedMs) / 86_400_000),
        }))
        .sort((a, b) => b.threads - a.threads);

      const totalThreads = vendors.reduce((s, v) => s + v.threads, 0);
      if (totalThreads > 0) {
        const totalActedOn = vendors.reduce((s, v) => s + v.actedOn, 0);
        const totalUntouched = vendors.reduce((s, v) => s + v.untouched, 0);
        const oldestUntouchedDays = vendors.reduce<number | null>(
          (m, v) => (v.oldestUntouchedDays == null ? m : m == null ? v.oldestUntouchedDays : Math.max(m, v.oldestUntouchedDays)),
          null,
        );
        const severity: InsightSeverity =
          totalUntouched === 0 ? 'info' : oldestUntouchedDays != null && oldestUntouchedDays >= 7 ? 'high' : 'warn';
        const card: BotSignalCard = {
          id: 'bot_signal',
          kind: 'bot_signal',
          severity,
          totalThreads,
          totalActedOn,
          totalUntouched,
          actedOnPct: Math.round((totalActedOn / totalThreads) * 100),
          oldestUntouchedDays,
          vendors,
        };
        cards.push(card);
      }
    }
  }

  // ── bot_only_review card (WS7, deterministic, no AI) ────────────────────────
  // "Only a bot reviewed this" — PRs (merged, or open-and-mergeable) in the team's repos
  // whose ONLY reviews came from automated reviewers (incl. Pierre-verbatim) with no human
  // review. Computed here (BEFORE the open-PR guard) like bot_signal so merged PRs count.
  {
    const botOnly = await getBotOnlyReviewPrs(accountId, repoIds, {
      from: sprintFrom,
      to: sprintTo,
    });
    if (botOnly.length > 0) {
      for (const p of botOnly) addUser(p.authorId);
      const card: BotOnlyReviewCard = {
        id: 'bot_only_review',
        kind: 'bot_only_review',
        // Governance/trust hook — a rubber-stamping-fatigue caution, never "high".
        severity: 'warn',
        prs: botOnly.map((p) => ({
          prId: p.prId,
          number: p.number,
          title: p.title,
          repoFullName: p.repoFullName,
          botLabel: p.botLabel,
          state: p.state,
          githubUrl: p.githubUrl,
        })),
      };
      cards.push(card);
    }
  }

  const ghUrl = (repoId: number, number: number): string =>
    `https://github.com/${repoName.get(repoId)}/pull/${number}`;

  // Open, non-draft PRs in the team's repos that are NOT ultra-stale — i.e. have a real ACTIVITY
  // EVENT (open/commit/comment/review) within the last INSIGHT_MAX_STALE_DAYS. We key off the
  // events feed, NOT pullRequests.updatedAt: GitHub bumps updatedAt on non-substantive base/label
  // syncs, so an abandoned PR can still show a "today" updatedAt — the events feed is the honest
  // "is anyone actually working on this" signal. A PR with no event in-window is abandoned-but-
  // unclosed; it shouldn't surface as a stalled review / untouched thread (nor feed the sprint report).
  const staleCutoff = new Date(now - INSIGHT_MAX_STALE_DAYS * 86_400_000);
  const openPrs = await db
    .select({
      id: pullRequests.id,
      repoId: pullRequests.repoId,
      number: pullRequests.number,
      title: pullRequests.title,
      authorId: pullRequests.authorId,
      openedAt: pullRequests.openedAt,
      ciStatus: pullRequests.ciStatus,
      changedFiles: pullRequests.changedFiles,
      additions: pullRequests.additions,
      deletions: pullRequests.deletions,
      files: pullRequests.files,
    })
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.accountId, accountId),
        inArray(pullRequests.repoId, repoIds),
        eq(pullRequests.state, 'open'),
        eq(pullRequests.isDraft, false),
        exists(
          db
            .select({ x: sql`1` })
            .from(events)
            .where(
              and(
                eq(events.prId, pullRequests.id),
                eq(events.accountId, accountId),
                gte(events.occurredAt, staleCutoff),
              ),
            ),
        ),
      ),
    )
    .execute();
  const openPrIds = openPrs.map((p) => p.id);
  const prById = new Map(openPrs.map((p) => [p.id, p]));
  if (openPrIds.length === 0) return finish();

  // Pending review requests (GitHub drops the request once a review lands → still-pending).
  const reqRows = await db
    .select({ prId: reviewRequests.prId, userId: reviewRequests.userId })
    .from(reviewRequests)
    .where(and(inArray(reviewRequests.prId, openPrIds), isNotNull(reviewRequests.userId)))
    .execute();
  const pendingByPr = new Map<number, number[]>();
  const pendingByReviewer = new Map<number, number[]>();
  for (const r of reqRows) {
    if (r.userId == null) continue;
    const a = pendingByPr.get(r.prId) ?? [];
    a.push(r.userId);
    pendingByPr.set(r.prId, a);
    const b = pendingByReviewer.get(r.userId) ?? [];
    b.push(r.prId);
    pendingByReviewer.set(r.userId, b);
  }

  // PRs that already have a submitted review (used by the routing "orphan" test).
  const reviewedPrIds = new Set<number>();
  for (const r of await db
    .select({ prId: reviews.prId })
    .from(reviews)
    .where(inArray(reviews.prId, openPrIds))
    .execute())
    reviewedPrIds.add(r.prId);

  // Sprint review load per reviewer (reviews submitted on team PRs in the window).
  const reviewsThisSprint = new Map<number, number>();
  for (const r of await db
    .select({ authorId: reviews.authorId })
    .from(reviews)
    .innerJoin(pullRequests, eq(pullRequests.id, reviews.prId))
    .where(
      and(
        eq(pullRequests.accountId, accountId),
        inArray(pullRequests.repoId, repoIds),
        gte(reviews.submittedAt, sprintFrom),
        isNotNull(reviews.authorId),
      ),
    )
    .execute()) {
    if (r.authorId != null)
      reviewsThisSprint.set(r.authorId, (reviewsThisSprint.get(r.authorId) ?? 0) + 1);
  }

  // (1) STALLED REVIEWS — open PRs with a still-pending reviewer, open past the threshold.
  const stalled = openPrs
    .filter(
      (p) =>
        (pendingByPr.get(p.id)?.length ?? 0) > 0 &&
        p.openedAt != null &&
        (now - p.openedAt.getTime()) / 3_600_000 > INSIGHT_STALLED_REVIEW_HOURS,
    )
    .map((p) => ({ p, ageHours: Math.round((now - p.openedAt!.getTime()) / 3_600_000) }))
    .sort((a, b) => b.ageHours - a.ageHours)
    .slice(0, INSIGHT_CARD_CAP);
  for (const { p, ageHours } of stalled) {
    const reviewers = pendingByPr.get(p.id) ?? [];
    addUser(p.authorId);
    reviewers.forEach(addUser);
    cards.push({
      id: `stalled:${p.id}`,
      kind: 'stalled_review',
      severity: ageHours >= 72 ? 'high' : ageHours >= 48 ? 'warn' : 'info',
      prId: p.id,
      repoId: p.repoId,
      repoFullName: repoName.get(p.repoId) ?? '',
      prNumber: p.number,
      prTitle: p.title,
      authorId: p.authorId,
      githubUrl: ghUrl(p.repoId, p.number),
      ciStatus: p.ciStatus,
      changedFiles: p.changedFiles,
      additions: p.additions,
      deletions: p.deletions,
      openedAt: p.openedAt!.toISOString(),
      ageHours,
      requestedReviewerIds: reviewers,
    });
  }

  // (2) UNTOUCHED THREADS — derivedState 'untouched', older than a day, on open PRs. Scoped to
  // `openPrIds` (the active, non-ultra-stale set built above) so an untouched thread on an
  // abandoned PR (no activity in 90d) doesn't resurrect it as "needs attention".
  const threadRows = await db
    .select({
      threadId: reviewThreads.id,
      path: reviewThreads.path,
      createdAt: reviewThreads.createdAt,
      originalCommenterId: reviewThreads.originalCommenterId,
      prId: pullRequests.id,
      prNumber: pullRequests.number,
      prTitle: pullRequests.title,
      repoId: pullRequests.repoId,
      authorId: pullRequests.authorId,
      openedAt: pullRequests.openedAt,
      ciStatus: pullRequests.ciStatus,
      changedFiles: pullRequests.changedFiles,
      additions: pullRequests.additions,
      deletions: pullRequests.deletions,
    })
    .from(reviewThreads)
    .innerJoin(pullRequests, eq(pullRequests.id, reviewThreads.prId))
    .where(
      and(
        inArray(pullRequests.id, openPrIds),
        eq(reviewThreads.derivedState, 'untouched'),
        lt(reviewThreads.createdAt, new Date(now - INSIGHT_UNTOUCHED_THREAD_HOURS * 3_600_000)),
      ),
    )
    .execute();
  const threads = threadRows
    .map((t) => ({ t, ageHours: Math.round((now - t.createdAt.getTime()) / 3_600_000) }))
    .sort((a, b) => b.ageHours - a.ageHours)
    .slice(0, INSIGHT_CARD_CAP);
  // Item 5 — tag an untouched thread whose originating commenter is an automated reviewer so the
  // card can show a vendor pill (the thread came from a bot, not a human). Resolved once here.
  const untouchedKindMap = await classificationKindForUser(accountId);
  for (const { t, ageHours } of threads) {
    addUser(t.originalCommenterId);
    addUser(t.authorId);
    const botKind =
      t.originalCommenterId != null ? untouchedKindMap.get(t.originalCommenterId) ?? null : null;
    cards.push({
      id: `thread:${t.threadId}`,
      kind: 'untouched_thread',
      severity: ageHours >= 96 ? 'high' : ageHours >= 48 ? 'warn' : 'info',
      prId: t.prId,
      repoId: t.repoId,
      repoFullName: repoName.get(t.repoId) ?? '',
      prNumber: t.prNumber,
      prTitle: t.prTitle,
      authorId: t.authorId,
      githubUrl: ghUrl(t.repoId, t.prNumber),
      ciStatus: t.ciStatus,
      changedFiles: t.changedFiles,
      additions: t.additions,
      deletions: t.deletions,
      openedAt: t.openedAt.toISOString(),
      threadId: t.threadId,
      path: t.path,
      ageHours,
      originalCommenterId: t.originalCommenterId,
      botKind,
      botLabel: botKind ? labelForKind(botKind) : null,
    });
  }

  // (3) REVIEWER LOAD — ranked by pending-queue depth, with sprint load alongside.
  const loadCards = [...pendingByReviewer.keys()]
    .map((rid) => ({
      rid,
      pending: pendingByReviewer.get(rid)?.length ?? 0,
      sprint: reviewsThisSprint.get(rid) ?? 0,
    }))
    .filter((x) => x.pending >= 1)
    .sort((a, b) => b.pending - a.pending || b.sprint - a.sprint)
    .slice(0, 8);
  for (const x of loadCards) {
    addUser(x.rid);
    const pendingPrs = (pendingByReviewer.get(x.rid) ?? [])
      .map((id) => prById.get(id))
      .filter((p): p is NonNullable<typeof p> => p != null)
      .slice(0, 8)
      .map((p) => ({
        prId: p.id,
        repoFullName: repoName.get(p.repoId) ?? '',
        prNumber: p.number,
        prTitle: p.title,
      }));
    cards.push({
      id: `load:${x.rid}`,
      kind: 'reviewer_load',
      severity: x.pending >= 4 ? 'high' : x.pending >= 2 ? 'warn' : 'info',
      reviewerId: x.rid,
      pendingCount: x.pending,
      reviewsThisSprint: x.sprint,
      pendingPrs,
    });
  }

  // (4) REVIEWER ROUTING — orphan PRs (nobody requested, nobody reviewed) + who should review.
  const orphans = openPrs
    .filter(
      (p) =>
        (pendingByPr.get(p.id)?.length ?? 0) === 0 &&
        !reviewedPrIds.has(p.id) &&
        p.openedAt != null &&
        (now - p.openedAt.getTime()) / 3_600_000 > INSIGHT_ROUTING_MIN_AGE_HOURS,
    )
    .slice(0, INSIGHT_CARD_CAP);
  if (orphans.length > 0) {
    // Orphan PRs' changed paths come from the always-synced pull_requests.files. A few
    // stale orphans (old PRs predating the files column) are backfilled once via a
    // bounded GitHub fetch (cached onto the row), so routing works without depending on
    // the sparse per-commit commit_files cache.
    const orphanFiles = new Map<number, string[]>(
      orphans.map((p) => [p.id, (p.files ?? []).map((f) => f.path)]),
    );
    const missing = orphans.filter((p) => p.files == null).map((p) => p.id);
    if (missing.length > 0)
      for (const [prId, paths] of await ensureRoutingPrFiles(accountId, missing))
        orphanFiles.set(prId, paths);

    // Repo-wide "who recently worked where": every PR touched in the sprint → its author
    // × the top-level dirs its files span. Sourced from the always-stored
    // pull_requests.files (no commit-file dependency), so it reflects real recent
    // activity in each area of the codebase.
    const dirAuthors = new Map<string, Map<number, number>>();
    for (const pr of await db
      .select({
        repoId: pullRequests.repoId,
        authorId: pullRequests.authorId,
        files: pullRequests.files,
      })
      .from(pullRequests)
      .where(
        and(
          eq(pullRequests.accountId, accountId),
          inArray(pullRequests.repoId, repoIds),
          isNotNull(pullRequests.authorId),
          isNotNull(pullRequests.files),
          gte(pullRequests.updatedAt, sprintFrom),
        ),
      )
      .execute()) {
      if (pr.authorId == null || pr.files == null) continue;
      for (const d of new Set(pr.files.map((f) => topLevelDir(f.path)))) {
        const key = `${pr.repoId} ${d}`;
        const m = dirAuthors.get(key) ?? new Map<number, number>();
        m.set(pr.authorId, (m.get(pr.authorId) ?? 0) + 1);
        dirAuthors.set(key, m);
      }
    }

    const mergers = new Map(
      (await getMergers(accountId)).map((m) => [m.repoId, new Set(m.userIds)]),
    );

    for (const p of orphans) {
      const paths = orphanFiles.get(p.id) ?? [];
      const dirs = [...new Set(paths.map(topLevelDir))];
      const repoMergers = mergers.get(p.repoId) ?? new Set<number>();
      // Candidates: mergers who recently worked in the same dirs. Track each one's
      // most-touched dir to phrase the rationale.
      const score = new Map<number, number>();
      const topDir = new Map<number, { dir: string; cnt: number }>();
      for (const d of dirs) {
        const m = dirAuthors.get(`${p.repoId} ${d}`);
        if (!m) continue;
        for (const [uid, cnt] of m) {
          if (uid === p.authorId || !repoMergers.has(uid)) continue;
          score.set(uid, (score.get(uid) ?? 0) + cnt);
          const cur = topDir.get(uid);
          if (!cur || cnt > cur.cnt) topDir.set(uid, { dir: d, cnt });
        }
      }
      const dirLabel = (d: string): string => (d === '.' ? 'the repo root' : `${d}/`);
      let suggested: SuggestedReviewer[] = [...score.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([uid]) => {
          const top = topDir.get(uid);
          return {
            userId: uid,
            reason: top ? `recently changed ${dirLabel(top.dir)}` : 'has merge rights here',
          };
        });
      // Fallback: any repo merger who isn't the author.
      if (suggested.length === 0)
        suggested = [...repoMergers]
          .filter((uid) => uid !== p.authorId)
          .slice(0, 3)
          .map((uid) => ({ userId: uid, reason: 'has merge rights here' }));
      if (suggested.length === 0) continue; // nothing useful to suggest
      addUser(p.authorId);
      suggested.forEach((s) => addUser(s.userId));
      cards.push({
        id: `route:${p.id}`,
        kind: 'reviewer_routing',
        severity: 'info',
        prId: p.id,
        repoId: p.repoId,
        repoFullName: repoName.get(p.repoId) ?? '',
        prNumber: p.number,
        prTitle: p.title,
        authorId: p.authorId,
        githubUrl: ghUrl(p.repoId, p.number),
        ciStatus: p.ciStatus,
        changedFiles: p.changedFiles,
        additions: p.additions,
        deletions: p.deletions,
        openedAt: p.openedAt!.toISOString(),
        topPaths: paths.slice(0, 5),
        suggestedReviewers: suggested,
      });
    }
  }

  return finish();
}

// The consolidated Feed. Scoped to the account's WATCHED repos (inboxWatch); a passed
// `repoIds` further narrows WITHIN watched (null → all watched). One flat, newest-first
// stream of real activity, each row flagged isMyTurn by participation (CORE; feed/my-turn.ts).
export async function getConsolidatedFeed(
  accountId: number,
  opts: ConsolidatedFeedFilters = {},
): Promise<ConsolidatedFeedResponse> {
  const {
    repoIds = null,
    userIds = null,
    prId = null,
    limit = null,
    offset = 0,
    excludeBots = false,
    allowBotIds = null,
    botsOnly = false,
  } = opts;

  // Restrict to the account's WATCHED repos; a passed repoIds narrows within them. An
  // out-of-scope / empty selection → a valid empty page (also avoids an inArray([]) below).
  const watchedIds = (await listRepos(accountId)).filter((r) => r.inboxWatch).map((r) => r.id);
  const effectiveRepoIds = repoIds
    ? repoIds.filter((id) => watchedIds.includes(id))
    : watchedIds;
  if (effectiveRepoIds.length === 0)
    return { items: [], users: [], total: 0, generatedAt: new Date().toISOString() };
  // Bot set (only loaded when the filter is on) — drops bot-authored activity, mirroring
  // the timeline's excludeBots. The per-repo allow-list subtracts the "important" bots so
  // their activity stays visible. getFeed doesn't filter bots, so we do it here; the commit
  // helper filters in its own SQL.
  const allowBots = new Set(allowBotIds ?? []);
  // excludeBots is meaningless in the bot-only feed (it would drop everything) — force it off.
  const botIds =
    !botsOnly && excludeBots
      ? new Set((await botUserIds()).filter((id) => !allowBots.has(id)))
      : new Set<number>();
  const notBot = (id: number | null): boolean =>
    !excludeBots || id == null || !botIds.has(id);

  // Isolated to a single PR (the Open-PRs filter) → show that PR's FULL history: scope every
  // source to the PR and drop the 14-day window (epoch since). The scan is one PR, so it's
  // cheap, and the reader sees the opened event + all activity even on a long-idle PR — not an
  // empty pane. The un-isolated feed keeps the rolling 14-day window (a live activity stream).
  const feedSince = prId != null ? new Date(0) : new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  // Bot-only feed: resolve the automated-reviewer actor set (vendors + classified in-house /
  // Pierre — the SAME set the ROI panel counts, so it catches deepsource-io etc. that aren't
  // users.isBot). Empty → nobody's classified → an empty feed. Filtered IN SQL by getFeed.
  const botActorIds = botsOnly ? await automatedReviewerUserIds(accountId) : null;
  if (botsOnly && (botActorIds == null || botActorIds.length === 0)) {
    return { items: [], users: [], total: 0, generatedAt: new Date().toISOString() };
  }
  const [feed, commitItems, claudeItems] = await Promise.all([
    getFeed(accountId, { daysBefore: 14, prId, repoIds: effectiveRepoIds, userIds, botActorIds }),
    // Commit-push activity that ADDRESSED a review thread (the only commit rows we surface
    // — plain pushes are noise). Each carries the affected threads inline. Skipped in the
    // bot-only feed (a commit push is the AUTHOR responding, not review-bot activity).
    botsOnly
      ? Promise.resolve<ConsolidatedFeedItem[]>([])
      : getCommitThreadItems(accountId, {
          repoIds: effectiveRepoIds,
          userIds,
          botIds,
          since: feedSince,
          prId,
        }),
    // Claude Review runs surfaced as their own feed item kind (local-only; empty in cloud).
    // Skipped in the bot-only feed (they're the user's own runs, not review-bot activity).
    botsOnly
      ? Promise.resolve<ConsolidatedFeedItem[]>([])
      : getClaudeReviewFeedItems(accountId, effectiveRepoIds, feedSince, prId),
  ]);

  // The "My Turn" participation flag (isMyTurn / myTurnReasons / reasonTag) is CORE / free
  // (see feed/my-turn.ts). Core builds every item as a PLAIN row (isMyTurn:false), then
  // enrichMyTurn flags participation below — BEFORE the cap, so uncapped My-Turn rows survive.

  const usersById = new Map<number, User>();
  for (const u of feed.users) usersById.set(u.id, u);

  const items: ConsolidatedFeedItem[] = [];
  const byId = new Map<string, ConsolidatedFeedItem>();
  const push = (it: ConsolidatedFeedItem): void => {
    if (byId.has(it.id)) return;
    byId.set(it.id, it);
    items.push(it);
  };

  // Activity events → one row each, as PLAIN rows (isMyTurn:false). The Pro enricher flags
  // participation below; without it every row stays plain. Exactly one row per underlying
  // event (no synthesized "My Turn" layer / dedup).
  for (const f of feed.events) {
    // excludeBots: drop bot-authored activity (getFeed doesn't filter bots).
    if (!notBot(f.actorId)) continue;
    push({
      id: `feed:${f.id}`,
      isMyTurn: false,
      myTurnReasons: [],
      kind: f.type,
      occurredAt: f.occurredAt,
      repoId: f.repoId,
      repoFullName: f.repoFullName,
      prId: f.prId,
      prNumber: f.prNumber,
      prTitle: f.prTitle,
      prState: f.prState,
      actorId: f.actorId,
      // Full markdown body (fallback to the short preview on pre-persistence lean rows).
      content: f.content ?? f.excerpt,
      threadId: f.type === 'review_comment' ? f.refId : null,
      commentId: f.type === 'pr_comment' ? f.refId : null,
      path: null,
      line: null,
      reasonTag: null,
      reviewState: f.reviewState,
      githubUrl:
        f.prNumber != null ? `https://github.com/${f.repoFullName}/pull/${f.prNumber}` : null,
      mergedById: null,
      reviewers: null,
      ciStatus: null,
      changedFilesCount: null,
      affectedThreads: null,
      commitCount: null,
      changeSummary: null,
      claudeReviewId: null,
      claudeVerdict: null,
      mergedComments: [],
    });
  }

  // Commit-push items (already repo/member/bot-scoped + thread-enriched in the SQL helper).
  // Pushed as plain rows; the Pro enricher flags participation below.
  for (const it of commitItems) push(it);

  // Claude Review items — a distinct kind (never bot/member-scoped). Kept out of the My-Turn
  // flow but always retained (see the caps below) so the "Claude Reviews" pill finds them.
  for (const it of claudeItems) push(it);

  // Consolidate a coinciding host event (a submitted review OR a close/merge) + the SAME
  // actor's top-level PR comment(s) on the SAME PR posted within a short window (issue comments
  // carry no head SHA, so time is the proxy): fold the comment(s) into the host's
  // `mergedComments` and drop their standalone rows, so "review + summary comment", "close +
  // why", and "merge + note" each read as one card everywhere (including My Turn) instead of
  // two. Runs BEFORE the my-turn enrich/cap/paginate so `total`, participation and page bounds
  // reflect the collapsed set (a comment folded here is never separately flagged/capped).
  coalesceEventComments(items, byId);

  // Attach each thread-bearing item's review-thread derived state (untouched / replied /
  // likely_addressed / resolved) — powers the Bots pane's state-filter pills. One query over
  // the distinct thread ids referenced by this page's items; non-thread items stay null.
  const feedThreadIds = [
    ...new Set(items.map((i) => i.threadId).filter((t): t is number => t != null)),
  ];
  if (feedThreadIds.length > 0) {
    const stateRows = await db
      .select({ id: reviewThreads.id, derivedState: reviewThreads.derivedState })
      .from(reviewThreads)
      .where(inArray(reviewThreads.id, feedThreadIds))
      .execute();
    const stateById = new Map<number, DerivedState>(
      stateRows.map((r) => [r.id, r.derivedState]),
    );
    for (const it of items) {
      if (it.threadId != null) it.derivedState = stateById.get(it.threadId) ?? null;
    }
  }

  // "My Turn" enrichment (CORE / free): flag each item `isMyTurn` by the viewer's participation
  // in its PR. Runs BEFORE the cap so uncapped My-Turn rows survive.
  await enrichMyTurn(accountId, items);

  // Optional single-PR isolation (the Feed "open PRs" panel): keep only this PR's items.
  // Applied here so `total` + the page bounds reflect the isolated set.
  const scoped = prId == null ? items : items.filter((i) => i.prId === prId);

  // Pure chronological — newest first. Keep every My Turn item AND every Claude-review item
  // (both are always relevant); cap the plain activity rows so a busy multi-repo account
  // doesn't render thousands of them.
  const alwaysRows = scoped.filter((i) => i.isMyTurn || i.kind === 'claude_review');
  const feedRows = scoped
    .filter((i) => !i.isMyTurn && i.kind !== 'claude_review')
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
    .slice(0, botsOnly ? BOT_FEED_EVENT_CAP : FEED_EVENT_CAP);
  const ordered = [...alwaysRows, ...feedRows].sort((a, b) =>
    b.occurredAt.localeCompare(a.occurredAt),
  );

  // Paginate: `total` is the full stream length; `page` is the requested window. Only
  // the page is enriched + has its users backfilled, so hidden items cost nothing.
  const total = ordered.length;
  const start = Math.max(0, offset ?? 0);
  const page =
    limit != null ? ordered.slice(start, start + Math.max(0, limit)) : ordered.slice(start);

  // Enrich PR items with merge + review credit, bounded to the PRs actually on the page.
  const prIdsForCtx = new Set<number>();
  for (const it of page) if (it.prId != null) prIdsForCtx.add(it.prId);
  const mergedByPr = new Map<number, number | null>();
  const ciByPr = new Map<number, CiStatus>();
  const filesByPr = new Map<number, number | null>();
  const reviewersByPr = new Map<number, { userId: number; state: ReviewState }[]>();
  if (prIdsForCtx.size > 0) {
    const prIdList = [...prIdsForCtx];
    // mergedById + CI rollup + changed-file count — account-scoped via
    // pullRequests.accountId. CI/files surface on pr_opened cards (item 2).
    for (const row of await db
      .select({
        id: pullRequests.id,
        mergedById: pullRequests.mergedById,
        ciStatus: pullRequests.ciStatus,
        changedFiles: pullRequests.changedFiles,
      })
      .from(pullRequests)
      .where(and(eq(pullRequests.accountId, accountId), inArray(pullRequests.id, prIdList)))
      .execute()) {
      mergedByPr.set(row.id, row.mergedById);
      ciByPr.set(row.id, (row.ciStatus ?? 'unknown') as CiStatus);
      filesByPr.set(row.id, row.changedFiles);
    }

    // reviewers — `reviews` has NO accountId, so isolation MUST come from the join to
    // pullRequests (eq accountId). Ascending order → the last write per (prId, userId)
    // is that reviewer's standing state; non-'pending' only.
    const reviewRows = await db
      .select({ prId: reviews.prId, userId: reviews.authorId, state: reviews.state })
      .from(reviews)
      .innerJoin(pullRequests, eq(pullRequests.id, reviews.prId))
      .where(
        and(
          eq(pullRequests.accountId, accountId),
          inArray(reviews.prId, prIdList),
          isNotNull(reviews.authorId),
          ne(reviews.state, 'pending'),
        ),
      )
      .orderBy(asc(reviews.submittedAt))
      .execute();
    const latestReview = new Map<string, { userId: number; state: ReviewState }>();
    const reviewOrderByPr = new Map<number, string[]>();
    for (const r of reviewRows) {
      if (r.userId == null) continue;
      const key = `${r.prId}:${r.userId}`;
      if (!latestReview.has(key)) {
        const arr = reviewOrderByPr.get(r.prId) ?? [];
        arr.push(key);
        reviewOrderByPr.set(r.prId, arr);
      }
      latestReview.set(key, { userId: r.userId, state: r.state as ReviewState });
    }
    for (const [prId, keys] of reviewOrderByPr)
      reviewersByPr.set(prId, keys.map((k) => latestReview.get(k)!));
  }
  for (const it of page) {
    if (it.prId == null) continue;
    it.mergedById = mergedByPr.get(it.prId) ?? null;
    it.reviewers = reviewersByPr.get(it.prId) ?? null;
    it.ciStatus = ciByPr.get(it.prId) ?? null;
    it.changedFilesCount = filesByPr.get(it.prId) ?? null;
  }

  // Backfill any referenced users on the page not already loaded by getMyTurn / getFeed —
  // including merger + reviewer ids so the SPA resolves their login/avatar.
  const needed = new Set<number>();
  for (const i of page) {
    if (i.actorId != null) needed.add(i.actorId);
    if (i.mergedById != null) needed.add(i.mergedById);
    if (i.reviewers) for (const r of i.reviewers) needed.add(r.userId);
    // Affected-thread original commenters (commit items) resolve to a login/avatar too.
    if (i.affectedThreads)
      for (const t of i.affectedThreads) if (t.authorId != null) needed.add(t.authorId);
  }
  // Only ship the users the page references (paginated pages merge client-side).
  const pageUsers: User[] = [];
  const pageUserIds = new Set(needed);
  for (const i of page) if (i.actorId != null) pageUserIds.add(i.actorId);
  for (const id of usersById.keys()) needed.delete(id);
  if (needed.size > 0) {
    for (const u of await db
      .select()
      .from(schema.users)
      .where(inArray(schema.users.id, [...needed]))
      .execute())
      usersById.set(u.id, mapUser(u));
  }
  for (const id of pageUserIds) {
    const u = usersById.get(id);
    if (u) pageUsers.push(u);
  }

  return {
    items: page,
    users: pageUsers,
    total,
    generatedAt: new Date().toISOString(),
  };
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
  if (
    kind === 'review_request' ||
    kind === 'watched_repo_pr' ||
    kind === 'pr_approved'
  ) {
    // All three reference a PR id directly.
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
  const actionable = await getActionableActivityIds(accountId);
  const prClosedReason = (state: PrState): string | null =>
    state === 'merged' ? 'PR merged' : state === 'closed' ? 'PR closed' : null;

  const reviewDismissals = dismissals.filter((d) => d.kind === 'review_request');
  const threadDismissals = dismissals.filter((d) => d.kind === 'thread');
  const watchedDismissals = dismissals.filter((d) => d.kind === 'watched_repo_pr');
  const approvedDismissals = dismissals.filter((d) => d.kind === 'pr_approved');
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

  // pr_approved dismissals → their PRs (account-scoped). Same shape as a
  // review_request dismissal, a different kind tag.
  if (approvedDismissals.length > 0) {
    const prRows = await db
      .select()
      .from(pullRequests)
      .innerJoin(repos, eq(repos.id, pullRequests.repoId))
      .where(
        and(
          eq(pullRequests.accountId, accountId),
          inArray(
            pullRequests.id,
            approvedDismissals.map((d) => d.refId),
          ),
        ),
      )
      .execute();
    const byId = new Map(prRows.map((r) => [r.pull_requests.id, r]));
    for (const d of approvedDismissals) {
      const row = byId.get(d.refId);
      if (!row) continue;
      const { pull_requests: pr, repos: repo } = row;
      if (pr.authorId != null) referencedUsers.add(pr.authorId);
      const restorable = actionable.approvedPrIds.has(pr.id);
      items.push({
        kind: 'pr_approved',
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
          : { reason: prClosedReason(pr.state as PrState) ?? 'No longer approved' }),
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
        lastReplyBody: last?.body ?? null,
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
// and getActionableActivityIds (restorability of a Done entry).
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
async function getActionableActivityIds(accountId: number): Promise<{
  reviewRequestPrIds: Set<number>;
  watchedPrIds: Set<number>;
  approvedPrIds: Set<number>;
  threadIds: Set<number>;
  claudeReviewIds: Set<number>;
}> {
  const localUserId = await getAccountUserId(accountId);
  const empty = {
    reviewRequestPrIds: new Set<number>(),
    watchedPrIds: new Set<number>(),
    approvedPrIds: new Set<number>(),
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
  // Your authored, open PRs with a standing approval (restorability source for the
  // pr_approved Done entries).
  const approvalInfo = await computeApprovalInfoByPr(open.map((t) => t.id));
  const approvedPrIds = new Set(
    open
      .filter(
        (t) => t.authorId === localUserId && !t.isDraft && approvalInfo.get(t.id)?.approved,
      )
      .map((t) => t.id),
  );

  const repoNameById = new Map<number, string>();
  for (const r of await listRepos(accountId)) repoNameById.set(r.id, r.fullName);
  const threadIds = new Set(
    (await getThreadsAwaiting(localUserId, accountId, repoNameById)).map(
      (ta) => ta.threadId,
    ),
  );

  const claudeReviewIds = getProCapabilities().claudeReview
    ? new Set((await getUnactionedClaudeReviews(accountId)).map((c) => c.reviewId))
    : new Set<number>();

  return { reviewRequestPrIds, watchedPrIds, approvedPrIds, threadIds, claudeReviewIds };
}

export async function getMyTurn(accountId: number): Promise<MyTurnResponse> {
  const localUserId = await getAccountUserId(accountId);
  const empty: MyTurnResponse = {
    awaitingReview: [],
    yourPrs: [],
    approvedPrs: [],
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
  // Dismissed "your PR was approved" entries. Keyed by PR id; honoured until a NEWER
  // approval lands (compared against the latest approving review's timestamp below).
  const approvedDismissedAt = new Map<number, Date>();
  // Dismissed Claude-review run ids. Keyed by run id (not PR id): a fresh run gets
  // a new id, so it naturally re-appears without a timestamp comparison.
  const claudeDismissedIds = new Set<number>();
  // Dismissed watched-repo PR ids. Sticky: a dismissal removes that PR from the
  // watched section for good (no timestamp comparison — acknowledging a new PR).
  const watchedDismissedIds = new Set<number>();
  for (const d of dismissals) {
    if (d.kind === 'review_request') reviewDismissedAt.set(d.refId, d.dismissedAt);
    else if (d.kind === 'thread') threadDismissedAt.set(d.refId, d.dismissedAt);
    else if (d.kind === 'pr_approved') approvedDismissedAt.set(d.refId, d.dismissedAt);
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

  // 2. Your authored, open PRs that have a standing approval (likely ready to merge).
  //    An approving review lands them here; a "Done" dismissal hides them until a
  //    NEWER approval arrives (compared against the latest approving review's
  //    timestamp — not the PR's updatedAt, which any commit would bump and re-nag).
  //    They leave automatically once the PR is merged/closed (drops out of `open`).
  const approvalInfo = await computeApprovalInfoByPr(open.map((t) => t.id));
  const approvedPrs: ApprovedPrItem[] = open
    .filter((t) => {
      // Drafts can't merge even when approved — don't claim "ready to merge".
      if (t.authorId !== localUserId || t.isDraft) return false;
      const info = approvalInfo.get(t.id);
      if (!info?.approved) return false;
      const dismissedAt = approvedDismissedAt.get(t.id);
      if (!dismissedAt) return true;
      const latest = info.latestApprovalAt?.getTime() ?? 0;
      return latest > dismissedAt.getTime();
    })
    .map((t) => ({
      ...toMyTurnPr(t),
      approvals: approvalInfo.get(t.id)?.approvals ?? 0,
      mergeable: t.mergeable,
      mergeStateStatus: t.mergeStateStatus,
    }));
  const approvedShownIds = new Set(approvedPrs.map((i) => i.prId));

  // 3. Your PRs with new activity since you last looked — excluding ones already shown
  //    under "approved" (the stronger, more actionable signal wins).
  const yourPrs = open
    .filter(
      (t) =>
        t.authorId === localUserId &&
        !approvedShownIds.has(t.id) &&
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
    ...approvedPrs.map((i) => i.prId),
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
  const claudeReviewsToAction = getProCapabilities().claudeReview
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
    approvedPrs,
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
      // Full markdown (comment bodies are always persisted); null on pre-persistence
      // lean rows — the Feed then falls back to the excerpt.
      lastReplyBody: last.body ?? null,
      lastReplyAt: last.createdAt.toISOString(),
      lastReplyAuthorId: last.authorId,
      githubUrl: `https://github.com/${owner}/${name}/pull/${pr.number}`,
    });
  }
  out.sort((a, b) => b.lastReplyAt.localeCompare(a.lastReplyAt));
  return out;
}

// Recent-activity window for the CORE reviewer suggester (both the dir-overlap authorship
// signal and the "reviews here often" pool). 90d = the board's max range; beyond it a
// contributor is off the radar.
const REVIEWER_SUGGEST_WINDOW_MS = 90 * 86_400_000;

// Suggest reviewers for a PR that has NONE assigned, from ALREADY-SYNCED data only (no
// GitHub calls). Candidate pool = people with merge rights in the repo ∪ people who review
// it often; ranked by how much they've recently worked in the top-level dirs this PR
// touches. The PR author + bots are excluded. Returns up to 3 user suggestions
// (source 'history'). CODEOWNERS suggestions are layered on top in the route (they need a
// token + network); this is the always-available core signal.
async function suggestReviewersFromHistory(
  accountId: number,
  repoId: number,
  authorId: number | null,
  changedPaths: string[],
): Promise<ReviewerSuggestion[]> {
  const since = new Date(Date.now() - REVIEWER_SUGGEST_WINDOW_MS);
  const dirs = [...new Set(changedPaths.map(topLevelDir))];

  // Repo-wide "who recently worked where" (author × top-level dir), from the always-stored
  // pull_requests.files — real recent activity per area, no commit-file dependency.
  const dirCount = new Map<string, Map<number, number>>(); // dir -> uid -> #PRs
  for (const pr of await db
    .select({ authorId: pullRequests.authorId, files: pullRequests.files })
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.accountId, accountId),
        eq(pullRequests.repoId, repoId),
        isNotNull(pullRequests.authorId),
        isNotNull(pullRequests.files),
        gte(pullRequests.updatedAt, since),
      ),
    )
    .execute()) {
    if (pr.authorId == null || pr.files == null) continue;
    for (const d of new Set(pr.files.map((f) => topLevelDir(f.path)))) {
      const m = dirCount.get(d) ?? new Map<number, number>();
      m.set(pr.authorId, (m.get(pr.authorId) ?? 0) + 1);
      dirCount.set(d, m);
    }
  }

  // Merge-rights set for this repo.
  const repoMergers = new Set(
    (await getMergers(accountId)).find((m) => m.repoId === repoId)?.userIds ?? [],
  );

  // Frequent reviewers of this repo (review count per author, recent window).
  const reviewCount = new Map<number, number>();
  for (const r of await db
    .select({ authorId: reviews.authorId })
    .from(reviews)
    .innerJoin(pullRequests, eq(pullRequests.id, reviews.prId))
    .where(
      and(
        eq(pullRequests.accountId, accountId),
        eq(pullRequests.repoId, repoId),
        isNotNull(reviews.authorId),
        gte(reviews.submittedAt, since),
      ),
    )
    .execute()) {
    if (r.authorId == null) continue;
    reviewCount.set(r.authorId, (reviewCount.get(r.authorId) ?? 0) + 1);
  }

  // Candidate pool = mergers ∪ frequent reviewers, minus the author.
  const pool = new Set<number>([...repoMergers, ...reviewCount.keys()]);
  if (authorId != null) pool.delete(authorId);
  if (pool.size === 0) return [];

  // Score by dir-overlap; track each candidate's most-touched matching dir for the reason.
  const overlap = new Map<number, number>();
  const topDir = new Map<number, { dir: string; cnt: number }>();
  for (const d of dirs) {
    const m = dirCount.get(d);
    if (!m) continue;
    for (const [uid, cnt] of m) {
      if (!pool.has(uid)) continue;
      overlap.set(uid, (overlap.get(uid) ?? 0) + cnt);
      const cur = topDir.get(uid);
      if (!cur || cnt > cur.cnt) topDir.set(uid, { dir: d, cnt });
    }
  }

  // Resolve to logins (drops bots + null logins), then rank.
  const resolved = await getReviewerLogins([...pool]);
  const dirLabel = (d: string): string => (d === '.' ? 'the repo root' : `${d}/`);
  const ranked = resolved
    .sort((a, b) => {
      const ov = (overlap.get(b.userId) ?? 0) - (overlap.get(a.userId) ?? 0);
      if (ov !== 0) return ov;
      const rv = (reviewCount.get(b.userId) ?? 0) - (reviewCount.get(a.userId) ?? 0);
      if (rv !== 0) return rv;
      return (repoMergers.has(b.userId) ? 1 : 0) - (repoMergers.has(a.userId) ? 1 : 0);
    })
    .slice(0, 3);

  return ranked.map(({ userId, login }): ReviewerSuggestion => {
    const top = topDir.get(userId);
    const reason =
      top && (overlap.get(userId) ?? 0) > 0
        ? `recently changed ${dirLabel(top.dir)}`
        : (reviewCount.get(userId) ?? 0) > 0
          ? 'reviews here often'
          : 'has merge rights here';
    return { kind: 'user', login, userId, teamSlug: null, teamName: null, reason, source: 'history' };
  });
}

// Resolve GitHub logins to synced User rows (for CODEOWNERS suggestion enrichment in the
// route — an @user owner may or may not be someone we've synced). Case-insensitive on
// login is unnecessary: GitHub logins in CODEOWNERS match the stored githubLogin exactly.
export async function getUsersByLogins(logins: string[]): Promise<User[]> {
  if (logins.length === 0) return [];
  const rows = await db
    .select()
    .from(users)
    .where(inArray(users.githubLogin, logins))
    .execute();
  return rows.map(mapUser);
}

// The DB-only basis for the live suggested-reviewers query (the route layers CODEOWNERS +
// team history on top). Scoped to the account (→ null if the PR isn't the caller's). `wants`
// gates on the SAME trigger the row uses (open · non-draft · nobody requested/reviewed yet),
// read live from the DB so an optimistic stamp of a just-requested reviewer empties it.
export interface SuggestionBasis {
  wants: boolean;
  owner: string;
  name: string;
  authorId: number | null;
  authorLogin: string | null; // to drop the author from CODEOWNERS user suggestions
  paths: string[];
  suggestions: ReviewerSuggestion[]; // history-based (user) picks from synced data
  users: User[]; // users referenced by `suggestions` (for avatar/link rendering)
}

export async function getSuggestedReviewersBasis(
  id: number,
  accountId: number,
): Promise<SuggestionBasis | null> {
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

  const [reviewRows, reqRows] = await Promise.all([
    db.select({ id: reviews.id }).from(reviews).where(eq(reviews.prId, id)).execute(),
    db
      .select({ id: schema.reviewRequests.id })
      .from(schema.reviewRequests)
      .where(eq(schema.reviewRequests.prId, id))
      .execute(),
  ]);
  const wants =
    pr.state === 'open' &&
    !pr.isDraft &&
    reqRows.length === 0 &&
    reviewRows.length === 0;

  const paths = (pr.files ?? []).map((f) => f.path);
  const suggestions = wants
    ? await suggestReviewersFromHistory(accountId, pr.repoId, pr.authorId, paths)
    : [];

  const uids = new Set<number>();
  for (const s of suggestions) if (s.userId != null) uids.add(s.userId);
  if (pr.authorId) uids.add(pr.authorId);
  const usersOut =
    uids.size > 0
      ? (
          await db.select().from(users).where(inArray(users.id, [...uids])).execute()
        ).map(mapUser)
      : [];
  const authorLogin =
    pr.authorId != null
      ? usersOut.find((u) => u.id === pr.authorId)?.githubLogin ?? null
      : null;

  return {
    wants,
    owner: repo.owner,
    name: repo.name,
    authorId: pr.authorId,
    authorLogin,
    paths,
    suggestions,
    users: usersOut,
  };
}

// Optimistically record just-requested reviewers locally so the "Requested" row + the
// suggestion gate reflect the assignment immediately, before the next sync re-derives
// `review_requests` (idempotently). Inserts only rows not already present (the table has no
// unique constraint, and a re-request must not duplicate). Mirrors the other write routes'
// local-stamp pattern (approve / comment / merge).
export async function stampReviewRequests(
  prId: number,
  userIds: number[],
  teamNames: string[],
): Promise<void> {
  if (userIds.length === 0 && teamNames.length === 0) return;
  const existing = await db
    .select()
    .from(schema.reviewRequests)
    .where(eq(schema.reviewRequests.prId, prId))
    .execute();
  const haveUser = new Set(existing.filter((r) => r.userId != null).map((r) => r.userId));
  const haveTeam = new Set(existing.filter((r) => r.teamName != null).map((r) => r.teamName));
  const toInsert: Array<{ prId: number; userId: number | null; teamName: string | null }> = [];
  for (const uid of new Set(userIds)) if (!haveUser.has(uid)) toInsert.push({ prId, userId: uid, teamName: null });
  for (const tn of new Set(teamNames)) if (!haveTeam.has(tn)) toInsert.push({ prId, userId: null, teamName: tn });
  if (toInsert.length > 0) await db.insert(schema.reviewRequests).values(toInsert).execute();
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

  // Bot-triage provenance (compute-on-read): which reviews were posted by an automated
  // reviewer. Pierre-posted reviews come from the claudeReviews join (§2f, keyed by
  // reviews.id → {kind:'pierre', provenance}); other automated reviewers come from the
  // per-account classification map (keyed by the review author's user id). Pierre wins
  // when both apply. The human who posted a Pierre review is NEVER reclassified — the
  // 'pierre' kind lives only on the review row.
  const [provenanceByReview, prClassKind] = await Promise.all([
    getReviewerProvenanceForPr(accountId, id),
    classificationKindForUser(accountId),
  ]);
  const reviewsOut: ReviewDetail[] = reviewRows.map((r) => {
    const pierre = provenanceByReview.get(r.id);
    const authorKind = r.authorId == null ? undefined : prClassKind.get(r.authorId);
    const automatedKind: AutomatedReviewerKind | null = pierre
      ? 'pierre'
      : (authorKind ?? null);
    return {
      id: r.id,
      authorId: r.authorId,
      state: r.state as ReviewState,
      body: r.body,
      submittedAt: r.submittedAt.toISOString(),
      url: r.databaseId ? `${prUrl}#pullrequestreview-${r.databaseId}` : null,
      automatedKind,
      provenance: pierre ? pierre.provenance : null,
    };
  });

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

  // NOTE: suggested reviewers are NOT part of PrDetail — they're served by their own live
  // query (GET /api/prs/:id/suggested-reviewers → getSuggestedReviewers below) so they never
  // freeze inside the aggressively-cached detail payload (they must empty the instant a
  // reviewer is requested). See SuggestedReviewersResponse.

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
  // Whether the viewer may PUSH (WRITE+ on the repo) — like viewerCanApprove but
  // WITHOUT the author exclusion (an author can push to their own PR branch). Gates
  // the Pro AI-Fix push controls; the push route re-checks server-side.
  const viewerCanPush = ['WRITE', 'MAINTAIN', 'ADMIN'].includes(
    repo.viewerPermission ?? '',
  );

  // The viewer's STANDING review: their LATEST decisive review (approved /
  // changes_requested / dismissed; 'commented'/'pending' don't count). reviewRows is
  // ASC by submittedAt, so the last decisive entry by the viewer wins. When it's
  // 'approved', the Approve control renders disabled ("already approved").
  let viewerHasApprovedStanding = false;
  if (viewerUserId != null) {
    let standing: string | null = null;
    for (const r of reviewRows) {
      if (
        r.authorId === viewerUserId &&
        (r.state === 'approved' ||
          r.state === 'changes_requested' ||
          r.state === 'dismissed')
      ) {
        standing = r.state;
      }
    }
    viewerHasApprovedStanding = standing === 'approved';
  }

  // Jira/Linear ticket links — compute-on-read via the Pro enricher (inert in OSS → null).
  const tickets = await resolvePrTickets({
    accountId,
    prId: pr.id,
    repoId: pr.repoId,
    repoFullName: `${repo.owner}/${repo.name}`,
    title: pr.title,
    headRefName: pr.headRefName,
  });

  return {
    id: pr.id,
    repoId: pr.repoId,
    repoFullName: `${repo.owner}/${repo.name}`,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    tickets,
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
    viewerCanPush,
    viewerHasApprovedStanding,
    threads,
    reviews: reviewsOut,
    comments: commentsOut,
    commits: commitsOut,
    users: userList,
    lastViewedAt: iso(lastViewedAt),
    newSinceLastViewed,
  };
}

// Candidates for an "@mention" autocomplete on a PR, ranked by PROXIMITY to the PR
// (closest first) and account-scoped. Excludes the viewer (they can't @ themselves)
// and bots. Ownership is verified via the account-scoped PR/repo join → null (→ 404)
// when the PR isn't the caller's. Ranks: author(0) > requested reviewer(1) >
// reviewer(2) > comment/thread author(3) > commit author(4) > repo maintainer(5) >
// other repo PR author(6). Repo-people (5/6) are a bounded proxy for "active in this
// repo" (authors + those who've merged here) — cheap and never cross-tenant because a
// repo row belongs to exactly one account.
export async function getMentionCandidates(
  prId: number,
  accountId: number,
): Promise<User[] | null> {
  const prRows = await db
    .select({ repoId: pullRequests.repoId, authorId: pullRequests.authorId })
    .from(pullRequests)
    .innerJoin(repos, eq(repos.id, pullRequests.repoId))
    .where(and(eq(pullRequests.id, prId), eq(repos.accountId, accountId)))
    .limit(1)
    .execute();
  const pr = prRows[0];
  if (!pr) return null;
  const repoId = pr.repoId;

  // Best (lowest) rank wins if a user shows up in more than one bucket.
  const rank = new Map<number, number>();
  const bump = (id: number | null | undefined, r: number): void => {
    if (id == null) return;
    const cur = rank.get(id);
    if (cur == null || r < cur) rank.set(id, r);
  };

  bump(pr.authorId, 0);

  const [reqRows, revRows, rcRows, thRows, pcRows, cmRows] = await Promise.all([
    db
      .select({ userId: schema.reviewRequests.userId })
      .from(schema.reviewRequests)
      .where(eq(schema.reviewRequests.prId, prId))
      .execute(),
    db.select({ authorId: reviews.authorId }).from(reviews).where(eq(reviews.prId, prId)).execute(),
    db
      .select({ authorId: reviewComments.authorId })
      .from(reviewComments)
      .where(eq(reviewComments.prId, prId))
      .execute(),
    db
      .select({ id: reviewThreads.originalCommenterId })
      .from(reviewThreads)
      .where(eq(reviewThreads.prId, prId))
      .execute(),
    db
      .select({ authorId: prComments.authorId })
      .from(prComments)
      .where(eq(prComments.prId, prId))
      .execute(),
    db
      .select({ authorId: commits.authorId, committerId: commits.committerId })
      .from(commits)
      .where(eq(commits.prId, prId))
      .execute(),
  ]);
  for (const r of reqRows) bump(r.userId, 1);
  for (const r of revRows) bump(r.authorId, 2);
  for (const r of rcRows) bump(r.authorId, 3);
  for (const r of thRows) bump(r.id, 3);
  for (const r of pcRows) bump(r.authorId, 3);
  for (const r of cmRows) {
    bump(r.authorId, 4);
    bump(r.committerId, 4);
  }

  // Repo people: whoever has MERGED here (maintainers, rank 5) + anyone who has
  // OPENED a PR here (rank 6). Bounded to this repo's PR rows.
  const [mergerRows, repoAuthorRows] = await Promise.all([
    db
      .selectDistinct({ userId: pullRequests.mergedById })
      .from(pullRequests)
      .where(and(eq(pullRequests.repoId, repoId), eq(pullRequests.state, 'merged')))
      .execute(),
    db
      .selectDistinct({ authorId: pullRequests.authorId })
      .from(pullRequests)
      .where(eq(pullRequests.repoId, repoId))
      .execute(),
  ]);
  for (const r of mergerRows) bump(r.userId, 5);
  for (const r of repoAuthorRows) bump(r.authorId, 6);

  // The viewer can't @ themselves.
  const viewerUserId = await getAccountUserId(accountId);
  if (viewerUserId != null) rank.delete(viewerUserId);

  const ids = [...rank.keys()];
  if (ids.length === 0) return [];
  const rows = await db.select().from(users).where(inArray(users.id, ids)).execute();
  return rows
    .filter((u) => !u.isBot)
    .map((u) => ({ user: mapUser(u), rank: rank.get(u.id) ?? 99 }))
    .sort((a, b) => a.rank - b.rank || a.user.githubLogin.localeCompare(b.user.githubLogin))
    .map((x) => x.user);
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
    // Team membership rows reference this repo (FK is ON DELETE cascade, but delete them
    // explicitly so the ordering is dialect-agnostic and can't FK-fail if foreign_keys is off).
    await tx.delete(teamRepos).where(eq(teamRepos.repoId, id)).execute();
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

// ---- Claude Review reads (CORE-owned surfaces only) ----
// The FEATURE-only reads (getClaudeReviewById/Latest/History/listAll + the post/PR
// contexts + mapReview/mapFinding) MOVED to packages/pro/src/claude-review/persist.ts
// when Claude Review became a Pro capability. The two readers below stay CORE because
// CORE surfaces consume them: listClaudeReviewsByRepo (Activity console) +
// getUnactionedClaudeReviews (My-Turn inbox). Both read the still-core tables.

// Repo-oriented Claude-review retrieval for the Activity single-repo console: ALL runs
// for a repo's PRs, grouped by PR (newest run first within each), PRs ordered by
// most-recent run desc. Richer than listAllClaudeReviews (which keeps only one
// latest-succeeded run per PR). IDOR-sensitive id getter: scoped by accountId, and
// gated on getProCapabilities().claudeReview. An unowned repo (cross-account) → empty list.
export async function listClaudeReviewsByRepo(
  repoId: number,
  accountId: number,
): Promise<RepoClaudeReviewsResponse> {
  if (!getProCapabilities().claudeReview) return { enabled: false, prs: [] };
  // Ownership: a repo not owned by this account leaks nothing (404-equivalent).
  const owned = await getRepo(repoId, accountId);
  if (!owned) return { enabled: getProCapabilities().claudeReview, prs: [] };

  const rows = await db
    .select({
      review: claudeReviews,
      prNumber: pullRequests.number,
      prTitle: pullRequests.title,
      prState: pullRequests.state,
      authorId: pullRequests.authorId,
    })
    .from(claudeReviews)
    .innerJoin(pullRequests, eq(pullRequests.id, claudeReviews.prId))
    .where(and(eq(claudeReviews.accountId, accountId), eq(pullRequests.repoId, repoId)))
    .orderBy(desc(claudeReviews.id))
    .execute();

  // Rows are globally id-desc (newest-first). The first row seen for each PR is its
  // newest run, so map-insertion order = PRs by most-recent run desc, and each PR's
  // runs[] accumulate newest-first — no extra sort needed.
  const byPr = new Map<number, RepoClaudeReviewPr>();
  for (const { review: r, prNumber, prTitle, prState, authorId } of rows) {
    const summary: ClaudeReviewSummary = {
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
    };
    const existing = byPr.get(r.prId);
    if (existing) existing.runs.push(summary);
    else
      byPr.set(r.prId, {
        prId: r.prId,
        prNumber,
        prTitle,
        prState,
        authorId,
        runs: [summary],
      });
  }
  return { enabled: true, prs: [...byPr.values()] };
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
// The review-BOT threads on a PR that a later commit has LIKELY ADDRESSED — the set the
// "clear the bot backlog" bulk action may safely resolve. Ownership-scoped (join to the PR's
// account), restricted to review-bot-originated threads currently in `likely_addressed` that
// are still unresolved and carry a GitHub node id (needed to resolve on GitHub). When
// `threadIds` is non-empty it further narrows to the exact reviewed list the client confirmed
// — defence-in-depth so a stale client can never resolve a thread the server wouldn't offer.
export async function getResolvableBotThreads(
  prId: number,
  accountId: number,
  threadIds: number[] | null = null,
): Promise<{ id: number; threadNodeId: string }[]> {
  const botIds = await automatedReviewerUserIds(accountId);
  if (botIds.length === 0) return [];
  const preds = [
    eq(reviewThreads.prId, prId),
    eq(pullRequests.accountId, accountId),
    inArray(reviewThreads.originalCommenterId, botIds),
    eq(reviewThreads.derivedState, 'likely_addressed'),
    eq(reviewThreads.isResolved, false),
    isNotNull(reviewThreads.githubNodeId),
  ];
  // Distinguish an explicit empty selection from the null default: `[]` means "the client
  // reviewed nothing" → resolve nothing (NOT resolve-all). Only `null` (no caller today) is
  // the unfiltered resolve-every-eligible path.
  if (threadIds) {
    if (threadIds.length === 0) return [];
    preds.push(inArray(reviewThreads.id, threadIds));
  }
  const rows = await db
    .select({ id: reviewThreads.id, threadNodeId: reviewThreads.githubNodeId })
    .from(reviewThreads)
    .innerJoin(pullRequests, eq(pullRequests.id, reviewThreads.prId))
    .where(and(...preds))
    .execute();
  return rows.flatMap((r) => (r.threadNodeId != null ? [{ id: r.id, threadNodeId: r.threadNodeId }] : []));
}

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

// Optimistically stamp a PR as merged after a successful GitHub merge, so the UI reflects it
// immediately (the ['pr',id] query is staleTime:Infinity + IndexedDB-persisted, so the mutation
// MUST invalidate it — but stamping first avoids a flash of the stale 'open' state). Account-
// scoped. The next sync reconciles the authoritative merge metadata.
export async function markPrMergedLocally(
  prId: number,
  accountId: number,
  mergedById: number | null,
): Promise<void> {
  await db
    .update(pullRequests)
    .set({
      state: 'merged',
      mergedAt: new Date(),
      mergedById,
      mergeStateStatus: 'unknown',
    })
    .where(and(eq(pullRequests.id, prId), eq(pullRequests.accountId, accountId)))
    .execute();
}

// Resolve a set of user ids to their GitHub logins for a reviewer request. Bots are
// dropped (GitHub 422s on bot reviewers); the `users` table is global so no account
// scope is needed (the caller already gated the PR by ownership + write access).
export async function getReviewerLogins(
  userIds: number[],
): Promise<{ userId: number; login: string }[]> {
  if (userIds.length === 0) return [];
  const rows = await db
    .select({ id: users.id, login: users.githubLogin, isBot: users.isBot })
    .from(users)
    .where(inArray(users.id, userIds))
    .execute();
  return rows
    .filter((r) => !r.isBot && r.login)
    .map((r) => ({ userId: r.id, login: r.login }));
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
// and the full body (comment bodies are always persisted). Returns the local row id.
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
        // Comment bodies are always persisted now, so don't clobber a synced body
        // back to null under lean storage.
        body: gh.body,
        excerpt: stampExcerpt(gh.body),
        diffHunk: null,
        databaseId: gh.databaseId != null ? String(gh.databaseId) : null,
        createdAt,
      })
      .onConflictDoUpdate({
        target: [reviewComments.prId, reviewComments.githubNodeId],
        set: {
          body: gh.body,
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
        // Comment bodies are always persisted now — don't clobber to null under lean.
        body: gh.body,
        databaseId: gh.databaseId != null ? String(gh.databaseId) : null,
        createdAt,
      })
      .onConflictDoUpdate({
        target: [prComments.prId, prComments.githubNodeId],
        set: {
          body: gh.body,
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
        // Review bodies are always persisted now — don't clobber to null under lean.
        body: gh.body ?? null,
        databaseId: String(gh.databaseId),
        submittedAt,
      })
      .onConflictDoUpdate({
        target: [reviews.prId, reviews.githubNodeId],
        set: {
          state: 'approved',
          body: gh.body ?? null,
          databaseId: String(gh.databaseId),
          submittedAt,
        },
      })
      .returning({ id: reviews.id })
      .execute()
  )[0]!;
  return row.id;
}

// ════════════════════════════════════════════════════════════════════════════
// Bot-Triage Platform — the CORE read layer (WS1–WS7; deterministic, NO AI here).
// Every getter is account-scoped; id-addressed ones verify ownership → null/false.
// Shared helpers below reuse the module-private emptyCounts/mapUser/reviewBotUserIds.
// ════════════════════════════════════════════════════════════════════════════

// The ACCOUNT-SCOPED set of automated-reviewer user ids = known vendor logins (the
// global reviewBotUserIds set) ∪ this account's classification-store rows flagged
// automated. getActivity / getTeamInsights' bot_signal / getResolvableBotThreads all
// route through this so in-house-classified reviewers count alongside vendors.
export async function automatedReviewerUserIds(accountId: number): Promise<number[]> {
  const vendorIds = await reviewBotUserIds();
  const rows = await db
    .select({
      id: botReviewClassification.authorUserId,
      automated: botReviewClassification.automated,
      source: botReviewClassification.source,
    })
    .from(botReviewClassification)
    .where(eq(botReviewClassification.accountId, accountId))
    .execute();
  const set = new Set<number>(vendorIds);
  for (const r of rows) {
    if (r.automated) set.add(r.id);
    // A manual "this is a human" override wins both directions — it removes even a
    // known vendor login from this account's automated set.
    else if (r.source === 'manual') set.delete(r.id);
  }
  return [...set];
}

// Map every automated reviewer (in this account) → its AutomatedReviewerKind, for
// grouping analytics / bot_signal / dedup. A known vendor login wins; else the
// classification-store kind; else 'in_house'.
export async function classificationKindForUser(
  accountId: number,
): Promise<Map<number, AutomatedReviewerKind>> {
  const map = new Map<number, AutomatedReviewerKind>();
  // Known vendors (global users table) resolved from the login → vendor kind.
  const logins = reviewBotLogins();
  if (logins.length > 0) {
    const candidates = [...logins, ...logins.map((l) => `${l}[bot]`)];
    const inList = sql.join(
      candidates.map((c) => sql`${c}`),
      sql`, `,
    );
    const vrows = await db
      .select({ id: users.id, login: users.githubLogin })
      .from(users)
      .where(sql`lower(${users.githubLogin}) in (${inList})`)
      .execute();
    for (const r of vrows) {
      const kind = reviewBotKind(r.login);
      if (kind) map.set(r.id, kind);
    }
  }
  // Account classification store. A vendor login resolved above takes precedence for the
  // kind; an automated row else contributes its stored kind (default in_house); a manual
  // "this is a human" override removes the reviewer from the automated set entirely.
  const crows = await db
    .select({
      id: botReviewClassification.authorUserId,
      kind: botReviewClassification.kind,
      automated: botReviewClassification.automated,
      source: botReviewClassification.source,
    })
    .from(botReviewClassification)
    .where(eq(botReviewClassification.accountId, accountId))
    .execute();
  for (const r of crows) {
    if (!r.automated) {
      if (r.source === 'manual') map.delete(r.id);
      continue;
    }
    if (map.has(r.id)) continue;
    map.set(r.id, (r.kind as AutomatedReviewerKind | null) ?? 'in_house');
  }
  return map;
}

// Best-effort review-body / comment severity inference from the account's fingerprint
// vocabulary. Coarse buckets only (nitpick / issue / refactor); null when unknowable.
// Used for the (optional) severity dimension of mute rules + the dedup conflict signal.
function inferSeverity(text: string | null | undefined): string | null {
  if (!text) return null;
  if (/\bnit(?:pick|:)|🧹/i.test(text)) return 'nitpick';
  if (/⚠️|potential issue|\bbug\b|security|vulnerab|\berror\b/i.test(text)) return 'issue';
  if (/🛠️|refactor|\bsuggestion\b|\bconsider\b/i.test(text)) return 'refactor';
  return null;
}

// Translate a simple path glob (supports `*` within a segment and `**` across
// segments) to an anchored, case-insensitive RegExp. null/empty glob → matches any.
function pathGlobMatch(glob: string | null, path: string): boolean {
  if (glob == null) return true;
  const g = glob.trim();
  if (!g) return true;
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const ch = g[i]!;
    if (ch === '*') {
      if (g[i + 1] === '*') {
        re += '.*';
        i++;
      } else {
        re += '[^/]*';
      }
    } else if ('.+?^${}()|[]\\'.includes(ch)) {
      re += `\\${ch}`;
    } else {
      re += ch;
    }
  }
  try {
    return new RegExp(`^${re}$`, 'i').test(path);
  } catch {
    return false;
  }
}

// The path bucket a deterministic tuning suggestion groups by: the top-level dir as a
// `<seg>/**` glob (matched by pathGlobMatch), or the file path itself when it's at root.
function pathBucket(path: string): string {
  const seg = path.split('/')[0];
  return seg && seg !== path ? `${seg}/**` : path;
}

// keep / tune / kill verdict (deterministic rule-of-thumb, no AI): high volume + low
// acted-on + high untouched → kill; moderate low acted-on → tune; else keep.
function botVerdict(threads: number, actedOnPct: number | null, untouched: number): BotVerdict {
  const untouchedRatio = threads > 0 ? untouched / threads : 0;
  const highVolume = threads >= 10;
  const lowActedOn = actedOnPct != null && actedOnPct < 30;
  const highUntouched = untouchedRatio >= 0.5;
  if (highVolume && lowActedOn && highUntouched) return 'kill';
  if (threads >= 5 && actedOnPct != null && actedOnPct < 60) return 'tune';
  return 'keep';
}

function normalizeBody(s: string | null | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim();
}

// §2f — Pierre-posted-review provenance for a PR: LEFT-join claudeReviews on
// postedReviewId = reviews.databaseId (both TEXT). Keyed by the local reviews.id →
// { provenance }. ai_verbatim when the posted userBody equals Claude's summary
// (whitespace-normalized), else human_curated. The 'pierre' kind lives ONLY on the
// review row (the human who posted it is never reclassified). Account-scoped.
export async function getReviewerProvenanceForPr(
  accountId: number,
  prId: number,
): Promise<Map<number, { provenance: ReviewProvenance }>> {
  const rows = await db
    .select({
      reviewId: reviews.id,
      userBody: claudeReviews.userBody,
      summary: claudeReviews.summary,
    })
    .from(claudeReviews)
    .innerJoin(reviews, eq(reviews.databaseId, claudeReviews.postedReviewId))
    .where(
      and(
        eq(claudeReviews.accountId, accountId),
        eq(claudeReviews.prId, prId),
        eq(reviews.prId, prId),
        isNotNull(claudeReviews.postedReviewId),
      ),
    )
    .execute();
  const map = new Map<number, { provenance: ReviewProvenance }>();
  for (const r of rows) {
    const ub = normalizeBody(r.userBody);
    const provenance: ReviewProvenance =
      ub.length > 0 && ub === normalizeBody(r.summary) ? 'ai_verbatim' : 'human_curated';
    map.set(r.reviewId, { provenance });
  }
  return map;
}

// Gather the deterministic evidence the classifier needs for a not-yet-cached reviewer:
// the fingerprint (over their most-recent review body + a sample of inline comments)
// and their behavioral signals. Account-scoped.
async function reviewerEvidence(
  accountId: number,
  userId: number,
): Promise<ReviewerEvidence> {
  const revBodies = await db
    .select({ body: reviews.body })
    .from(reviews)
    .innerJoin(pullRequests, eq(pullRequests.id, reviews.prId))
    .where(
      and(
        eq(pullRequests.accountId, accountId),
        eq(reviews.authorId, userId),
        isNotNull(reviews.body),
      ),
    )
    .orderBy(desc(reviews.submittedAt))
    .limit(1)
    .execute();
  const commentBodies = await db
    .select({ body: reviewComments.body })
    .from(reviewComments)
    .innerJoin(pullRequests, eq(pullRequests.id, reviewComments.prId))
    .where(
      and(
        eq(pullRequests.accountId, accountId),
        eq(reviewComments.authorId, userId),
        isNotNull(reviewComments.body),
      ),
    )
    .limit(20)
    .execute();
  const reviewBody = revBodies[0]?.body ?? null;
  const comments = commentBodies
    .map((c) => c.body)
    .filter((b): b is string => typeof b === 'string' && b.length > 0);
  return {
    fingerprint: fingerprintReview(reviewBody, comments),
    behavioral: await computeBehavioralSignals(accountId, userId),
  };
}

// WS1/WS8 — every distinct reviewer seen in this account (authored a review OR
// originated a thread), joined with its classification (manual + auto + vendor login
// map), 90-day thread volume, and a sample review body. Runs the resolver for not-yet-
// cached reviewers (which persists an auto row). Account-scoped.
export async function listDetectedReviewers(
  accountId: number,
): Promise<DetectedReviewersResponse> {
  const generatedAt = new Date().toISOString();

  const [revAuthors, thAuthors] = await Promise.all([
    db
      .select({ id: reviews.authorId })
      .from(reviews)
      .innerJoin(pullRequests, eq(pullRequests.id, reviews.prId))
      .where(eq(pullRequests.accountId, accountId))
      .execute(),
    db
      .select({ id: reviewThreads.originalCommenterId })
      .from(reviewThreads)
      .innerJoin(pullRequests, eq(pullRequests.id, reviewThreads.prId))
      .where(eq(pullRequests.accountId, accountId))
      .execute(),
  ]);
  const idSet = new Set<number>();
  for (const r of revAuthors) if (r.id != null) idSet.add(r.id);
  for (const r of thAuthors) if (r.id != null) idSet.add(r.id);
  if (idSet.size === 0) return { reviewers: [], generatedAt };
  const ids = [...idSet];

  const userRows = await db
    .select()
    .from(users)
    .where(inArray(users.id, ids))
    .execute();
  const userById = new Map(userRows.map((u) => [u.id, u]));

  // Cached classification rows for these reviewers.
  const clsRows = await db
    .select()
    .from(botReviewClassification)
    .where(
      and(
        eq(botReviewClassification.accountId, accountId),
        inArray(botReviewClassification.authorUserId, ids),
      ),
    )
    .execute();
  const clsById = new Map(clsRows.map((c) => [c.authorUserId, c]));

  // 90-day thread volume per reviewer.
  const since = new Date(Date.now() - 90 * 86_400_000);
  const volRows = await db
    .select({ id: reviewThreads.originalCommenterId, c: count() })
    .from(reviewThreads)
    .innerJoin(pullRequests, eq(pullRequests.id, reviewThreads.prId))
    .where(
      and(
        eq(pullRequests.accountId, accountId),
        inArray(reviewThreads.originalCommenterId, ids),
        gte(reviewThreads.createdAt, since),
      ),
    )
    .groupBy(reviewThreads.originalCommenterId)
    .execute();
  const volById = new Map<number, number>();
  for (const r of volRows) if (r.id != null) volById.set(r.id, r.c);

  // Most-recent non-empty review body per reviewer (a small sample for the UI).
  const sampleRows = await db
    .select({ authorId: reviews.authorId, body: reviews.body, submittedAt: reviews.submittedAt })
    .from(reviews)
    .innerJoin(pullRequests, eq(pullRequests.id, reviews.prId))
    .where(
      and(
        eq(pullRequests.accountId, accountId),
        inArray(reviews.authorId, ids),
        isNotNull(reviews.body),
      ),
    )
    .orderBy(desc(reviews.submittedAt))
    .execute();
  const sampleById = new Map<number, string>();
  for (const r of sampleRows) {
    if (r.authorId == null) continue;
    if (sampleById.has(r.authorId)) continue;
    const body = (r.body ?? '').trim();
    if (body) sampleById.set(r.authorId, body.length > 400 ? `${body.slice(0, 399)}…` : body);
  }

  const reviewers: DetectedReviewer[] = [];
  for (const id of ids) {
    const u = userById.get(id);
    if (!u) continue;
    const cached = clsById.get(id);
    let classification: ReviewerClassification;
    let isManualOverride = false;
    if (cached) {
      classification = rowToClassification(cached, u.githubLogin);
      isManualOverride = cached.source === 'manual';
    } else {
      const evidence = await reviewerEvidence(accountId, id);
      classification = await classifyReviewer(
        accountId,
        {
          id: u.id,
          githubLogin: u.githubLogin,
          githubType: u.githubType,
          isBot: u.isBot,
        },
        evidence,
      );
    }
    reviewers.push({
      userId: id,
      login: u.githubLogin,
      displayName: u.displayName,
      avatarUrl: u.avatarUrl,
      classification,
      isManualOverride,
      threadsLast90d: volById.get(id) ?? 0,
      sampleReviewBody: sampleById.get(id) ?? null,
    });
  }

  // Automated first, then by 90-day volume desc, then login — a stable, useful order.
  reviewers.sort(
    (a, b) =>
      Number(b.classification.automated) - Number(a.classification.automated) ||
      b.threadsLast90d - a.threadsLast90d ||
      a.login.localeCompare(b.login),
  );
  return { reviewers, generatedAt };
}

// WS1e — the two-way manual override. Upserts a source='manual' classification row for
// (accountId, userId) that the auto resolver never overwrites. Returns the new
// classification, or null when the user id is unknown (→ the route 404s). Account-scoped
// (the upsert targets this account's row only; another account is never mutated).
export async function setReviewerOverride(
  accountId: number,
  userId: number,
  body: ReviewerOverrideBody,
): Promise<ReviewerClassification | null> {
  const u = (
    await db
      .select({ id: users.id, login: users.githubLogin })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
      .execute()
  )[0];
  if (!u) return null;
  const kind: AutomatedReviewerKind | null = body.automated ? body.kind ?? 'in_house' : null;
  const label = body.automated
    ? body.label ?? (kind ? labelForKind(kind) : u.login)
    : body.label ?? u.login;
  const reasons = [
    body.automated
      ? 'manually tagged as an automated reviewer'
      : 'manually confirmed as a human',
  ];
  const values = {
    automated: body.automated,
    kind,
    label,
    confidence: 'high' as const,
    source: 'manual' as const,
    reasonsJson: reasons,
    updatedAt: new Date(),
  };
  await db
    .insert(botReviewClassification)
    .values({ accountId, authorUserId: userId, ...values })
    .onConflictDoUpdate({
      target: [botReviewClassification.accountId, botReviewClassification.authorUserId],
      set: values,
    })
    .execute();
  return {
    userId,
    login: u.login,
    automated: body.automated,
    kind,
    label,
    confidence: 'high',
    source: 'manual',
    reasons,
  };
}

// ---- WS6 mute / auto-triage rules (account-scoped; ownership → false/null) ----

function muteRuleToApi(r: typeof botMuteRules.$inferSelect): BotMuteRule {
  return {
    id: r.id,
    vendorKind: (r.vendorKind as AutomatedReviewerKind | null) ?? null,
    pathGlob: r.pathGlob,
    severity: r.severity,
    action: r.action as BotMuteAction,
    autoResolveDays: r.autoResolveDays,
    createdAt: r.createdAt.toISOString(),
  };
}

export async function listBotMuteRules(accountId: number): Promise<BotMuteRule[]> {
  const rows = await db
    .select()
    .from(botMuteRules)
    .where(eq(botMuteRules.accountId, accountId))
    .orderBy(desc(botMuteRules.createdAt))
    .execute();
  return rows.map(muteRuleToApi);
}

export async function addBotMuteRule(
  accountId: number,
  input: BotMuteRuleInput,
): Promise<BotMuteRule> {
  const rows = await db
    .insert(botMuteRules)
    .values({
      accountId,
      vendorKind: input.vendorKind ?? null,
      pathGlob: input.pathGlob ?? null,
      severity: input.severity ?? null,
      action: input.action,
      autoResolveDays: input.autoResolveDays ?? null,
      createdAt: new Date(),
    })
    .returning()
    .execute();
  return muteRuleToApi(rows[0]!);
}

export async function deleteBotMuteRule(accountId: number, id: number): Promise<boolean> {
  const rows = await db
    .delete(botMuteRules)
    .where(and(eq(botMuteRules.accountId, accountId), eq(botMuteRules.id, id)))
    .returning({ id: botMuteRules.id })
    .execute();
  return rows.length > 0;
}

// WS7 — "only a bot reviewed this": PRs (merged in-window, or open-and-mergeable) in the
// given repos whose ONLY counting reviews (approved/changes_requested/commented) are from
// automated reviewers (incl. Pierre-verbatim via the claudeReviews join) with NO human
// review. Account-scoped. Feeds the bot_only_review card in getTeamInsights.
export interface BotOnlyReviewPr {
  prId: number;
  number: number;
  title: string;
  repoFullName: string;
  botLabel: string;
  state: string;
  githubUrl: string;
  authorId: number | null;
}
export async function getBotOnlyReviewPrs(
  accountId: number,
  repoIds: number[],
  window: { from: Date; to: Date },
): Promise<BotOnlyReviewPr[]> {
  if (repoIds.length === 0) return [];
  const automatedIds = new Set(await automatedReviewerUserIds(accountId));
  const kindMap = await classificationKindForUser(accountId);

  // Pierre-verbatim posted review ids (these count as automated reviews; a human-curated
  // Pierre review counts as a human review). Keyed by reviews.databaseId == postedReviewId.
  const crRows = await db
    .select({
      postedReviewId: claudeReviews.postedReviewId,
      userBody: claudeReviews.userBody,
      summary: claudeReviews.summary,
    })
    .from(claudeReviews)
    .where(
      and(eq(claudeReviews.accountId, accountId), isNotNull(claudeReviews.postedReviewId)),
    )
    .execute();
  const pierreVerbatim = new Set<string>();
  for (const r of crRows) {
    if (!r.postedReviewId) continue;
    const ub = normalizeBody(r.userBody);
    if (ub.length > 0 && ub === normalizeBody(r.summary)) pierreVerbatim.add(r.postedReviewId);
  }

  const prRows = await db
    .select({
      id: pullRequests.id,
      repoId: pullRequests.repoId,
      number: pullRequests.number,
      title: pullRequests.title,
      authorId: pullRequests.authorId,
      state: pullRequests.state,
    })
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.accountId, accountId),
        inArray(pullRequests.repoId, repoIds),
        or(
          and(
            eq(pullRequests.state, 'merged'),
            gte(pullRequests.mergedAt, window.from),
            lte(pullRequests.mergedAt, window.to),
          ),
          and(eq(pullRequests.state, 'open'), eq(pullRequests.mergeable, 'mergeable')),
        ),
      ),
    )
    .execute();
  if (prRows.length === 0) return [];
  const prIds = prRows.map((p) => p.id);

  const revRows = await db
    .select({
      prId: reviews.prId,
      authorId: reviews.authorId,
      databaseId: reviews.databaseId,
      state: reviews.state,
    })
    .from(reviews)
    .where(inArray(reviews.prId, prIds))
    .execute();
  const revsByPr = new Map<number, typeof revRows>();
  for (const r of revRows) {
    const arr = revsByPr.get(r.prId) ?? [];
    arr.push(r);
    revsByPr.set(r.prId, arr);
  }

  // Item 4a — a PR's comments count as touch too: a bot review-thread/issue comment is automated
  // touch, and a NON-AUTHOR human comment disqualifies "bot-only" (the author's own comments never
  // count as human input). Gather review-thread + issue-comment authors for the candidate PRs.
  const rcAuthorRows = await db
    .select({ prId: reviewComments.prId, authorId: reviewComments.authorId })
    .from(reviewComments)
    .where(inArray(reviewComments.prId, prIds))
    .execute();
  const pcAuthorRows = await db
    .select({ prId: prComments.prId, authorId: prComments.authorId })
    .from(prComments)
    .where(inArray(prComments.prId, prIds))
    .execute();
  const commentAuthorsByPr = new Map<number, (number | null)[]>();
  for (const r of [...rcAuthorRows, ...pcAuthorRows]) {
    const arr = commentAuthorsByPr.get(r.prId) ?? [];
    arr.push(r.authorId);
    commentAuthorsByPr.set(r.prId, arr);
  }

  const repoRows = await db
    .select({ id: repos.id, owner: repos.owner, name: repos.name })
    .from(repos)
    .where(inArray(repos.id, repoIds))
    .execute();
  const repoFullName = new Map(repoRows.map((r) => [r.id, `${r.owner}/${r.name}`]));

  const out: BotOnlyReviewPr[] = [];
  for (const pr of prRows) {
    const revs = (revsByPr.get(pr.id) ?? []).filter(
      (rv) =>
        rv.state === 'approved' || rv.state === 'changes_requested' || rv.state === 'commented',
    );
    let anyAutomated = false;
    let anyHuman = false;
    let botLabel: string | null = null;
    const noteAuto = (authorId: number | null, isPierre: boolean): void => {
      anyAutomated = true;
      if (botLabel == null) {
        const kind = authorId != null ? kindMap.get(authorId) : undefined;
        botLabel = kind ? labelForKind(kind) : isPierre ? labelForKind('pierre') : 'Automated';
      }
    };
    // Reviews: automated (incl. Pierre-verbatim) → automated touch; a NON-AUTHOR human review
    // disqualifies (a review by the PR author — rare — never counts as human input).
    for (const rv of revs) {
      const isPierre = rv.databaseId != null && pierreVerbatim.has(rv.databaseId);
      const isAuto = (rv.authorId != null && automatedIds.has(rv.authorId)) || isPierre;
      if (isAuto) noteAuto(rv.authorId, isPierre);
      else if (rv.authorId != null && rv.authorId !== pr.authorId) anyHuman = true;
    }
    // Comments (review-thread + issue): a bot comment is automated touch; a non-author human
    // comment disqualifies. Null-author (unknown/deleted) comments count as neither.
    for (const cid of commentAuthorsByPr.get(pr.id) ?? []) {
      if (cid == null) continue;
      if (automatedIds.has(cid)) noteAuto(cid, false);
      else if (cid !== pr.authorId) anyHuman = true;
    }
    if (anyAutomated && !anyHuman) {
      const full = repoFullName.get(pr.repoId) ?? '';
      out.push({
        prId: pr.id,
        number: pr.number,
        title: pr.title,
        repoFullName: full,
        botLabel: botLabel ?? 'Automated',
        state: pr.state,
        githubUrl: `https://github.com/${full}/pull/${pr.number}`,
        authorId: pr.authorId,
      });
    }
  }
  return out;
}

// WS3 — the Bot-ROI analytics. Per AutomatedReviewerKind over the requested window:
// volume (threads + comments), acted-on %, untouched backlog + oldest age, human
// follow-through %, noise ratio (untouched-share proxy — severity is often unknowable),
// a keep/tune/kill verdict, and a ≤12-week weekly trend. Cost fields stay null (the
// frontend overlays per-vendor cost from Pro settings). 'hide' mute rules drop matching
// threads from the counts. Deterministic, NO AI. Account-scoped.
export async function getBotAnalytics(
  accountId: number,
  window: BotWindowKind,
  // Team scope: null/undefined = all account repos; a repo-id list = only those; [] = no
  // repos in scope (e.g. the "No team" scope with everything assigned) → empty analytics.
  scopeRepoIds?: number[] | null,
): Promise<BotAnalyticsResponse> {
  const nowMs = Date.now();
  const to = new Date(nowMs);
  // rolling_14 and 'sprint' both use the 14-day trailing window (core can't read the
  // account's configured sprint bounds — they live in Pro settings).
  const windowDays = window === 'rolling_7' ? 7 : window === 'rolling_30' ? 30 : 14;
  const from = new Date(nowMs - windowDays * 86_400_000);
  const trendFrom = new Date(nowMs - 12 * 7 * 86_400_000); // 84 days ⊇ every window
  const generatedAt = to.toISOString();
  const win = { kind: window, from: from.toISOString(), to: to.toISOString() };

  const emptyTotals = { threads: 0, comments: 0, actedOn: 0, actedOnPct: null, untouched: 0, botOnlyPrs: 0 };
  // Team scope resolved to no repos → nothing to analyze.
  if (scopeRepoIds != null && scopeRepoIds.length === 0) {
    return { enabled: true, generatedAt, window: win, vendors: [], totals: emptyTotals, suggestions: [] };
  }
  // Spread into each PR-joined WHERE to narrow to the scope's repos (empty = all repos).
  const repoScopeFilter =
    scopeRepoIds != null ? [inArray(pullRequests.repoId, scopeRepoIds)] : [];
  const automatedIds = await automatedReviewerUserIds(accountId);
  if (automatedIds.length === 0) {
    return { enabled: true, generatedAt, window: win, vendors: [], totals: emptyTotals, suggestions: [] };
  }
  const kindMap = await classificationKindForUser(accountId);
  const hideRules = (await listBotMuteRules(accountId)).filter((r) => r.action === 'hide');

  // Per-REVIEWER identity (so in-house bots — all kind 'in_house' — separate into their own rows
  // instead of collapsing). Label preference: the account's custom classification label →
  // the vendor's pretty name (for known vendors) → the reviewer's login/display name.
  const classLabel = new Map<number, string>();
  for (const r of await db
    .select({ id: botReviewClassification.authorUserId, label: botReviewClassification.label })
    .from(botReviewClassification)
    .where(eq(botReviewClassification.accountId, accountId))
    .execute()) {
    if (r.label != null && r.label.trim() !== '') classLabel.set(r.id, r.label.trim());
  }
  const loginById = new Map<number, string>(); // display fallback (name || login)
  const rawLoginById = new Map<number, string>(); // the github login — the per-bot cost key
  if (automatedIds.length > 0) {
    for (const r of await db
      .select({ id: users.id, login: users.githubLogin, name: users.displayName })
      .from(users)
      .where(inArray(users.id, automatedIds))
      .execute()) {
      loginById.set(r.id, r.name?.trim() || r.login || `#${r.id}`);
      if (r.login) rawLoginById.set(r.id, r.login);
    }
  }
  const reviewerLabel = (userId: number, kind: AutomatedReviewerKind): string => {
    const custom = classLabel.get(userId);
    if (custom) return custom;
    if (kind !== 'in_house' && kind !== 'pierre') return labelForKind(kind);
    return loginById.get(userId) ?? labelForKind(kind);
  };

  // Automated-reviewer threads over the 12-week trend span (⊇ the selected window).
  const threadRows = await db
    .select({
      id: reviewThreads.id,
      userId: reviewThreads.originalCommenterId,
      path: reviewThreads.path,
      state: reviewThreads.derivedState,
      createdAt: reviewThreads.createdAt,
    })
    .from(reviewThreads)
    .innerJoin(pullRequests, eq(pullRequests.id, reviewThreads.prId))
    .where(
      and(
        eq(pullRequests.accountId, accountId),
        inArray(reviewThreads.originalCommenterId, automatedIds),
        gte(reviewThreads.createdAt, trendFrom),
        ...repoScopeFilter,
      ),
    )
    .execute();

  // Severity per thread is only needed if a hide rule filters on it (rare) — fetch the
  // originating comment excerpts lazily then.
  const needSeverity = hideRules.some((r) => r.severity != null);
  const threadIds = threadRows.map((t) => t.id);
  const severityByThread = new Map<number, string | null>();
  if (needSeverity && threadIds.length > 0) {
    const exRows = await db
      .select({
        threadId: reviewComments.threadId,
        excerpt: reviewComments.excerpt,
        createdAt: reviewComments.createdAt,
      })
      .from(reviewComments)
      .where(inArray(reviewComments.threadId, threadIds))
      .orderBy(asc(reviewComments.createdAt))
      .execute();
    for (const r of exRows) {
      if (!severityByThread.has(r.threadId)) {
        severityByThread.set(r.threadId, inferSeverity(r.excerpt));
      }
    }
  }

  const isHidden = (t: (typeof threadRows)[number], kind: AutomatedReviewerKind): boolean => {
    for (const rule of hideRules) {
      if (rule.vendorKind != null && rule.vendorKind !== kind) continue;
      if (!pathGlobMatch(rule.pathGlob, t.path)) continue;
      if (rule.severity != null && (severityByThread.get(t.id) ?? null) !== rule.severity) continue;
      return true;
    }
    return false;
  };

  type Acc = {
    kind: AutomatedReviewerKind;
    reviewers: Set<number>;
    threads: number;
    actedOn: number;
    untouched: number;
    oldestUntouchedMs: number | null;
    humanFollow: number;
    // weekly buckets (12), each {threads, actedOn, untouched} — untouched drives the
    // per-vendor noise-ratio-over-time trend (untouched / threads).
    weekly: { threads: number; actedOn: number; untouched: number }[];
    // (pathBucket → {volume, untouched}) for tuning suggestions.
    buckets: Map<string, { volume: number; untouched: number }>;
  };
  // Keyed by REVIEWER user id (not kind) so each bot — including every in-house bot that shares
  // kind 'in_house' — gets its own row. `kind` rides along for colour / cost / verdict semantics.
  const byUser = new Map<number, Acc>();
  const accFor = (userId: number, kind: AutomatedReviewerKind): Acc => {
    let a = byUser.get(userId);
    if (!a) {
      a = {
        kind,
        reviewers: new Set(),
        threads: 0,
        actedOn: 0,
        untouched: 0,
        oldestUntouchedMs: null,
        humanFollow: 0,
        weekly: Array.from({ length: 12 }, () => ({ threads: 0, actedOn: 0, untouched: 0 })),
        buckets: new Map(),
      };
      byUser.set(userId, a);
    }
    return a;
  };

  // Trend (12 weekly buckets, oldest→newest) uses the full 12-week span.
  const windowThreads: { id: number; userId: number; kind: AutomatedReviewerKind; path: string; state: DerivedState; createdAt: Date }[] = [];
  for (const t of threadRows) {
    if (t.userId == null) continue;
    const kind = kindMap.get(t.userId);
    if (!kind) continue;
    if (isHidden(t, kind)) continue;
    const acc = accFor(t.userId, kind);
    const acted = t.state === 'resolved' || t.state === 'likely_addressed';
    // Trend bucket by created week.
    const wk = Math.min(11, Math.max(0, Math.floor((t.createdAt.getTime() - trendFrom.getTime()) / (7 * 86_400_000))));
    const bucket = acc.weekly[wk]!;
    bucket.threads += 1;
    if (acted) bucket.actedOn += 1;
    if (t.state === 'untouched') bucket.untouched += 1;
    // Headline metrics use only the selected window. NOTE: acc.actedOn is accumulated LATER
    // (after the human-follow-up pass) under the merged "acted-on" definition (item 6) —
    // resolved | likely_addressed | a human replied after the bot's last comment.
    if (t.createdAt >= from) {
      acc.reviewers.add(t.userId);
      acc.threads += 1;
      if (t.state === 'untouched') {
        acc.untouched += 1;
        const ms = t.createdAt.getTime();
        if (acc.oldestUntouchedMs == null || ms < acc.oldestUntouchedMs) acc.oldestUntouchedMs = ms;
      }
      const pb = pathBucket(t.path);
      const b = acc.buckets.get(pb) ?? { volume: 0, untouched: 0 };
      b.volume += 1;
      if (t.state === 'untouched') b.untouched += 1;
      acc.buckets.set(pb, b);
      windowThreads.push({ id: t.id, userId: t.userId, kind, path: t.path, state: t.state, createdAt: t.createdAt });
    }
  }

  // Human follow-through: of the bot's window threads, the ones where a human commented after
  // the bot's last comment on that thread. Feeds BOTH the human-only humanFollowThroughPct
  // sub-figure (acc.humanFollow) AND the merged acted-on definition (humanFollowSet, item 6).
  const humanFollowSet = new Set<number>();
  const wtIds = windowThreads.map((t) => t.id);
  if (wtIds.length > 0) {
    const ftRows = await db
      .select({
        threadId: reviewComments.threadId,
        authorId: reviewComments.authorId,
        createdAt: reviewComments.createdAt,
      })
      .from(reviewComments)
      .where(inArray(reviewComments.threadId, wtIds))
      .execute();
    const byThread = new Map<number, { authorId: number | null; at: number }[]>();
    for (const r of ftRows) {
      const arr = byThread.get(r.threadId) ?? [];
      arr.push({ authorId: r.authorId, at: r.createdAt.getTime() });
      byThread.set(r.threadId, arr);
    }
    const reviewerByThread = new Map(windowThreads.map((t) => [t.id, { userId: t.userId, kind: t.kind }]));
    for (const [threadId, comments] of byThread) {
      const rv = reviewerByThread.get(threadId);
      if (!rv) continue;
      let botLastAt = -Infinity;
      for (const c of comments) {
        if (c.authorId != null && automatedIds.includes(c.authorId) && c.at > botLastAt) botLastAt = c.at;
      }
      const humanAfter = comments.some(
        (c) => c.authorId != null && !automatedIds.includes(c.authorId) && c.at > botLastAt,
      );
      if (humanAfter) {
        humanFollowSet.add(threadId);
        accFor(rv.userId, rv.kind).humanFollow += 1;
      }
    }
  }

  // Item 6 — merged "acted-on": a window thread counts as acted-on when it's resolved or
  // likely_addressed (the commit heuristic) OR a human followed up after the bot (humanFollowSet).
  for (const t of windowThreads) {
    const baseActed = t.state === 'resolved' || t.state === 'likely_addressed';
    if (baseActed || humanFollowSet.has(t.id)) accFor(t.userId, t.kind).actedOn += 1;
  }

  // Comments volume per REVIEWER (bot-authored review comments in the window).
  const commentRows = await db
    .select({ authorId: reviewComments.authorId })
    .from(reviewComments)
    .innerJoin(pullRequests, eq(pullRequests.id, reviewComments.prId))
    .where(
      and(
        eq(pullRequests.accountId, accountId),
        inArray(reviewComments.authorId, automatedIds),
        gte(reviewComments.createdAt, from),
        lte(reviewComments.createdAt, to),
        ...repoScopeFilter,
      ),
    )
    .execute();
  const commentsByUser = new Map<number, number>();
  for (const r of commentRows) {
    if (r.authorId == null) continue;
    if (!kindMap.get(r.authorId)) continue;
    commentsByUser.set(r.authorId, (commentsByUser.get(r.authorId) ?? 0) + 1);
  }

  const suggestions: BotTuningSuggestion[] = [];
  const vendors: BotVendorAnalytics[] = [];
  for (const [userId, acc] of byUser) {
    const comments = commentsByUser.get(userId) ?? 0;
    if (acc.threads === 0 && comments === 0) continue;
    const kind = acc.kind;
    const label = reviewerLabel(userId, kind);
    const actedOnPct = acc.threads > 0 ? Math.round((acc.actedOn / acc.threads) * 100) : null;
    const oldestUntouchedDays =
      acc.oldestUntouchedMs == null ? null : Math.floor((nowMs - acc.oldestUntouchedMs) / 86_400_000);
    const humanFollowThroughPct = acc.threads > 0 ? Math.round((acc.humanFollow / acc.threads) * 100) : null;
    // Noise ratio: untouched-share proxy (see the header — true severity is often unknowable).
    const noiseRatioPct = acc.threads > 0 ? Math.round((acc.untouched / acc.threads) * 100) : null;
    const trend: BotVendorTrendPoint[] = acc.weekly.map((w, i) => ({
      weekStart: new Date(trendFrom.getTime() + i * 7 * 86_400_000).toISOString(),
      threads: w.threads,
      actedOnPct: w.threads > 0 ? Math.round((w.actedOn / w.threads) * 100) : null,
      untouched: w.untouched,
    }));
    vendors.push({
      // A stable per-reviewer row key (kind repeats across in-house bots, so the table can't key
      // on kind). `kind` still drives colour / cost / verdict; `label` is the per-bot name.
      key: `u${userId}`,
      kind,
      label,
      login: rawLoginById.get(userId) ?? null,
      reviewers: acc.reviewers.size,
      threads: acc.threads,
      comments,
      actedOn: acc.actedOn,
      actedOnPct,
      untouched: acc.untouched,
      oldestUntouchedDays,
      humanFollowThroughPct,
      noiseRatioPct,
      verdict: botVerdict(acc.threads, actedOnPct, acc.untouched),
      costMonthlyUsd: null,
      costPerActedOnUsd: null,
      trend,
    });
    // Deterministic tuning suggestions (§3h): a (reviewer, path-bucket) with volume ≥ 5 and
    // untouchedPct ≥ 70 → "mute this". vendorKind stays the kind (mute rules match by kind).
    for (const [pb, b] of acc.buckets) {
      if (b.volume < 5) continue;
      const untouchedPct = Math.round((b.untouched / b.volume) * 100);
      if (untouchedPct < 70) continue;
      suggestions.push({
        vendorKind: kind,
        label,
        pathGlob: pb,
        severity: null,
        untouchedPct,
        volume: b.volume,
        rationale: `${untouchedPct}% of ${label}'s ${b.volume} threads in ${pb} went untouched — mute them?`,
      });
    }
  }
  vendors.sort((a, b) => b.threads - a.threads || b.comments - a.comments);
  suggestions.sort((a, b) => b.volume - a.volume);

  // Item 4b — bot-only PR count across ALL the account's repos in the window, using the same
  // broadened rule as getBotOnlyReviewPrs (item 4a): automated touch (review OR comment, incl.
  // Pierre-verbatim) with no human review AND no human comment.
  const allRepoRows = await db
    .select({ id: repos.id })
    .from(repos)
    .where(eq(repos.accountId, accountId))
    .execute();
  const botOnlyPrs = (
    await getBotOnlyReviewPrs(
      accountId,
      scopeRepoIds ?? allRepoRows.map((r) => r.id),
      { from, to },
    )
  ).length;

  const totalThreads = vendors.reduce((s, v) => s + v.threads, 0);
  const totalActedOn = vendors.reduce((s, v) => s + v.actedOn, 0);
  const totals = {
    threads: totalThreads,
    comments: vendors.reduce((s, v) => s + v.comments, 0),
    actedOn: totalActedOn,
    actedOnPct: totalThreads > 0 ? Math.round((totalActedOn / totalThreads) * 100) : null,
    untouched: vendors.reduce((s, v) => s + v.untouched, 0),
    botOnlyPrs,
  };
  return { enabled: true, generatedAt, window: win, vendors, totals, suggestions };
}

// Item 7 — the per-PR drill-down behind a vendor's Bot-ROI row (GET /api/bot-analytics/:kind/prs).
// Lists the PRs one automated reviewer KIND touched in the window (its review threads + comments),
// with per-PR volume, the merged "acted-on" count (item 6: resolved | likely_addressed | a human
// followed up after the bot), the untouched backlog, last-activity, and the broadened bot-only flag
// (item 4a). Ordered most-recent-bot-activity first (nulls last). Deterministic, NO AI, account-
// scoped. For kind==='pierre' the PRs are those with a Pierre-verbatim posted review in-window —
// per-review provenance means Pierre has no attributable threads/comments (the human who posted is
// never reclassified), so its rows carry the review timestamp as lastBotActivityAt and 0 thread/
// comment counts. When the account has no automated reviewers of that kind, returns prs:[].
export async function getBotVendorPrs(
  accountId: number,
  kind: string,
  window: BotWindowKind,
  // Team scope: null/undefined = all account repos; [] = no repos → empty. Applied at the
  // final PR-metadata load (the single narrowing point), so the whole result stays scoped.
  scopeRepoIds?: number[] | null,
): Promise<BotVendorPrsResponse> {
  const nowMs = Date.now();
  const to = new Date(nowMs);
  // Same window→days mapping as getBotAnalytics (rolling_7=7, rolling_30=30, else — incl. sprint — 14).
  const windowDays = window === 'rolling_7' ? 7 : window === 'rolling_30' ? 30 : 14;
  const from = new Date(nowMs - windowDays * 86_400_000);
  const win = { kind: window, from: from.toISOString(), to: to.toISOString() };
  const kindTyped = kind as AutomatedReviewerKind;
  const label = labelForKind(kindTyped);
  const generatedAt = new Date(nowMs).toISOString();
  const empty: BotVendorPrsResponse = {
    enabled: true, kind: kindTyped, label, window: win, prs: [], generatedAt,
  };
  if (scopeRepoIds != null && scopeRepoIds.length === 0) return empty;

  const kindMap = await classificationKindForUser(accountId);
  // The account's user ids classified as the requested kind. Empty for 'pierre' (per-review, not
  // per-user) — that kind is resolved from verbatim posted reviews instead.
  const vendorIds = [...kindMap.entries()].filter(([, k]) => k === kind).map(([id]) => id);

  // Per-PR vendor-activity accumulator.
  type PrAcc = {
    threadIds: number[];
    threadStates: DerivedState[];
    botThreads: number;
    botComments: number;
    lastAtMs: number | null;
  };
  const perPr = new Map<number, PrAcc>();
  const accForPr = (prId: number): PrAcc => {
    let a = perPr.get(prId);
    if (!a) {
      a = { threadIds: [], threadStates: [], botThreads: 0, botComments: 0, lastAtMs: null };
      perPr.set(prId, a);
    }
    return a;
  };
  const bump = (a: PrAcc, atMs: number): void => {
    if (a.lastAtMs == null || atMs > a.lastAtMs) a.lastAtMs = atMs;
  };

  if (kind === 'pierre') {
    // Pierre PRs via Pierre-verbatim posted reviews in-window (postedReviewId == reviews.databaseId).
    const crRows = await db
      .select({
        prId: reviews.prId,
        submittedAt: reviews.submittedAt,
        userBody: claudeReviews.userBody,
        summary: claudeReviews.summary,
      })
      .from(claudeReviews)
      .innerJoin(reviews, eq(reviews.databaseId, claudeReviews.postedReviewId))
      .where(
        and(
          eq(claudeReviews.accountId, accountId),
          isNotNull(claudeReviews.postedReviewId),
          gte(reviews.submittedAt, from),
          lte(reviews.submittedAt, to),
        ),
      )
      .execute();
    for (const r of crRows) {
      const ub = normalizeBody(r.userBody);
      if (ub.length === 0 || ub !== normalizeBody(r.summary)) continue; // verbatim only
      bump(accForPr(r.prId), r.submittedAt.getTime());
    }
  } else {
    if (vendorIds.length === 0) return empty;
    // Vendor review threads in-window (account-scoped via the PR join).
    const threadRows = await db
      .select({
        id: reviewThreads.id,
        prId: reviewThreads.prId,
        state: reviewThreads.derivedState,
        createdAt: reviewThreads.createdAt,
      })
      .from(reviewThreads)
      .innerJoin(pullRequests, eq(pullRequests.id, reviewThreads.prId))
      .where(
        and(
          eq(pullRequests.accountId, accountId),
          inArray(reviewThreads.originalCommenterId, vendorIds),
          gte(reviewThreads.createdAt, from),
          lte(reviewThreads.createdAt, to),
        ),
      )
      .execute();
    for (const t of threadRows) {
      const a = accForPr(t.prId);
      a.threadIds.push(t.id);
      a.threadStates.push(t.state);
      a.botThreads += 1;
      bump(a, t.createdAt.getTime());
    }
    // Vendor review comments in-window.
    const commentRows = await db
      .select({ prId: reviewComments.prId, createdAt: reviewComments.createdAt })
      .from(reviewComments)
      .innerJoin(pullRequests, eq(pullRequests.id, reviewComments.prId))
      .where(
        and(
          eq(pullRequests.accountId, accountId),
          inArray(reviewComments.authorId, vendorIds),
          gte(reviewComments.createdAt, from),
          lte(reviewComments.createdAt, to),
        ),
      )
      .execute();
    for (const c of commentRows) {
      const a = accForPr(c.prId);
      a.botComments += 1;
      bump(a, c.createdAt.getTime());
    }
  }

  const prIds = [...perPr.keys()];
  if (prIds.length === 0) return empty;

  // Human follow-up per vendor thread → the merged acted-on rule (item 6). Fetch ALL comments on
  // the vendor threads (not just in-window) to detect a human reply after the bot's last comment.
  const allThreadIds = [...perPr.values()].flatMap((a) => a.threadIds);
  const humanFollowSet = new Set<number>();
  if (allThreadIds.length > 0) {
    const autoSet = new Set(await automatedReviewerUserIds(accountId));
    const fcRows = await db
      .select({
        threadId: reviewComments.threadId,
        authorId: reviewComments.authorId,
        createdAt: reviewComments.createdAt,
      })
      .from(reviewComments)
      .where(inArray(reviewComments.threadId, allThreadIds))
      .execute();
    const byThread = new Map<number, { authorId: number | null; at: number }[]>();
    for (const r of fcRows) {
      const arr = byThread.get(r.threadId) ?? [];
      arr.push({ authorId: r.authorId, at: r.createdAt.getTime() });
      byThread.set(r.threadId, arr);
    }
    for (const [threadId, comments] of byThread) {
      let botLastAt = -Infinity;
      for (const c of comments) {
        if (c.authorId != null && autoSet.has(c.authorId) && c.at > botLastAt) botLastAt = c.at;
      }
      const humanAfter = comments.some(
        (c) => c.authorId != null && !autoSet.has(c.authorId) && c.at > botLastAt,
      );
      if (humanAfter) humanFollowSet.add(threadId);
    }
  }

  // PR metadata (account-scoped) + repo name.
  const metaRows = await db
    .select({
      id: pullRequests.id,
      repoId: pullRequests.repoId,
      number: pullRequests.number,
      title: pullRequests.title,
      authorId: pullRequests.authorId,
      state: pullRequests.state,
      ciStatus: pullRequests.ciStatus,
      additions: pullRequests.additions,
      deletions: pullRequests.deletions,
      changedFiles: pullRequests.changedFiles,
      openedAt: pullRequests.openedAt,
      owner: repos.owner,
      name: repos.name,
    })
    .from(pullRequests)
    .innerJoin(repos, eq(repos.id, pullRequests.repoId))
    .where(
      and(
        eq(pullRequests.accountId, accountId),
        inArray(pullRequests.id, prIds),
        ...(scopeRepoIds != null ? [inArray(pullRequests.repoId, scopeRepoIds)] : []),
      ),
    )
    .execute();

  // Bot-only flag: reuse the broadened rule (item 4a) over the candidate PRs' repos.
  const repoIdSet = [...new Set(metaRows.map((m) => m.repoId))];
  const botOnlyIds = new Set(
    (await getBotOnlyReviewPrs(accountId, repoIdSet, { from, to })).map((p) => p.prId),
  );

  const prs: BotVendorPr[] = [];
  for (const m of metaRows) {
    const a = perPr.get(m.id)!;
    let botActedOn = 0;
    let botUntouched = 0;
    for (let i = 0; i < a.threadIds.length; i++) {
      const st = a.threadStates[i]!;
      if (st === 'resolved' || st === 'likely_addressed' || humanFollowSet.has(a.threadIds[i]!)) {
        botActedOn += 1;
      }
      if (st === 'untouched') botUntouched += 1;
    }
    const full = `${m.owner}/${m.name}`;
    prs.push({
      prId: m.id,
      repoId: m.repoId,
      repoFullName: full,
      prNumber: m.number,
      prTitle: m.title,
      authorId: m.authorId,
      state: m.state,
      githubUrl: `https://github.com/${full}/pull/${m.number}`,
      ciStatus: m.ciStatus,
      additions: m.additions,
      deletions: m.deletions,
      changedFiles: m.changedFiles,
      openedAt: m.openedAt.toISOString(),
      botThreads: a.botThreads,
      botComments: a.botComments,
      botActedOn,
      botUntouched,
      lastBotActivityAt: a.lastAtMs == null ? null : new Date(a.lastAtMs).toISOString(),
      botOnly: botOnlyIds.has(m.id),
    });
  }
  // Most-recent-bot-activity first (nulls last).
  prs.sort((x, y) => {
    const xa = x.lastBotActivityAt == null ? -Infinity : Date.parse(x.lastBotActivityAt);
    const ya = y.lastBotActivityAt == null ? -Infinity : Date.parse(y.lastBotActivityAt);
    return ya - xa;
  });

  return { enabled: true, kind: kindTyped, label, window: win, prs, generatedAt };
}

// WS4 — cross-bot dedup + consensus for one PR. Groups the PR's automated-reviewer
// threads by (path, ±3-line window); a cluster with ≥2 DISTINCT kinds is a real dedup
// hit. consensus = the members' inferred severities agree (or are unknowable); conflict
// = they diverge. Ownership → null (→ the route 404s). Account-scoped.
export async function getBotDedupClusters(
  prId: number,
  accountId: number,
): Promise<BotDedupResponse | null> {
  const owned = (
    await db
      .select({ id: pullRequests.id })
      .from(pullRequests)
      .where(and(eq(pullRequests.id, prId), eq(pullRequests.accountId, accountId)))
      .limit(1)
      .execute()
  )[0];
  if (!owned) return null;

  const automatedIds = await automatedReviewerUserIds(accountId);
  if (automatedIds.length === 0) return { prId, clusters: [] };
  const kindMap = await classificationKindForUser(accountId);

  const rows = await db
    .select({
      id: reviewThreads.id,
      userId: reviewThreads.originalCommenterId,
      path: reviewThreads.path,
      line: reviewThreads.line,
      state: reviewThreads.derivedState,
      login: users.githubLogin,
    })
    .from(reviewThreads)
    .innerJoin(users, eq(users.id, reviewThreads.originalCommenterId))
    .where(
      and(
        eq(reviewThreads.prId, prId),
        inArray(reviewThreads.originalCommenterId, automatedIds),
      ),
    )
    .execute();
  if (rows.length === 0) return { prId, clusters: [] };

  // Originating-comment excerpt per thread (for the member preview + severity).
  const excerptByThread = new Map<number, string | null>();
  const exRows = await db
    .select({
      threadId: reviewComments.threadId,
      excerpt: reviewComments.excerpt,
      createdAt: reviewComments.createdAt,
    })
    .from(reviewComments)
    .where(inArray(reviewComments.threadId, rows.map((r) => r.id)))
    .orderBy(asc(reviewComments.createdAt))
    .execute();
  for (const r of exRows) {
    if (!excerptByThread.has(r.threadId)) excerptByThread.set(r.threadId, r.excerpt);
  }

  interface Member extends BotDedupMember {
    line: number | null;
  }
  const membersByPath = new Map<string, Member[]>();
  for (const r of rows) {
    if (r.userId == null) continue;
    const kind = kindMap.get(r.userId);
    if (!kind) continue;
    const arr = membersByPath.get(r.path) ?? [];
    arr.push({
      threadId: r.id,
      userId: r.userId,
      kind,
      login: r.login,
      label: labelForKind(kind),
      excerpt: excerptByThread.get(r.id) ?? null,
      derivedState: r.state,
      line: r.line,
    });
    membersByPath.set(r.path, arr);
  }

  const clusters: BotDedupCluster[] = [];
  for (const [path, members] of membersByPath) {
    // Cluster within a file by line proximity (±3). null-line threads group together.
    const withLine = members.filter((m) => m.line != null).sort((a, b) => a.line! - b.line!);
    const nullLine = members.filter((m) => m.line == null);
    const groups: Member[][] = [];
    let cur: Member[] = [];
    let anchor: number | null = null;
    for (const m of withLine) {
      if (anchor != null && m.line! - anchor <= 3) {
        cur.push(m);
      } else {
        if (cur.length > 0) groups.push(cur);
        cur = [m];
        anchor = m.line!;
      }
    }
    if (cur.length > 0) groups.push(cur);
    if (nullLine.length > 0) groups.push(nullLine);

    for (const g of groups) {
      const distinctKinds = new Set(g.map((m) => m.kind));
      if (g.length < 2 || distinctKinds.size < 2) continue;
      const sevs = new Set(g.map((m) => inferSeverity(m.excerpt)).filter((s): s is string => s != null));
      const conflict = sevs.size >= 2;
      clusters.push({
        path,
        line: g[0]!.line,
        members: g.map(({ line: _line, ...rest }) => rest),
        consensus: !conflict,
        conflict,
      });
    }
  }
  clusters.sort((a, b) => b.members.length - a.members.length);
  return { prId, clusters };
}

// WS6b — the auto-triage engine's candidate finder (used by the standing scheduled job).
// For each account auto_resolve rule, the likely_addressed + unresolved automated-bot
// threads (with a GitHub node id) matching the rule's vendor/path/severity AND older than
// the rule's autoResolveDays. NEVER returns a non-likely_addressed thread. Account-scoped.
export async function getAutoResolveCandidates(
  accountId: number,
): Promise<{ prId: number; threadIds: number[] }[]> {
  const rules = (await listBotMuteRules(accountId)).filter(
    (r) => r.action === 'auto_resolve' && r.autoResolveDays != null,
  );
  if (rules.length === 0) return [];
  const automatedIds = await automatedReviewerUserIds(accountId);
  if (automatedIds.length === 0) return [];
  const kindMap = await classificationKindForUser(accountId);

  const rows = await db
    .select({
      id: reviewThreads.id,
      prId: reviewThreads.prId,
      userId: reviewThreads.originalCommenterId,
      path: reviewThreads.path,
      createdAt: reviewThreads.createdAt,
    })
    .from(reviewThreads)
    .innerJoin(pullRequests, eq(pullRequests.id, reviewThreads.prId))
    .where(
      and(
        eq(pullRequests.accountId, accountId),
        inArray(reviewThreads.originalCommenterId, automatedIds),
        eq(reviewThreads.derivedState, 'likely_addressed'),
        eq(reviewThreads.isResolved, false),
        isNotNull(reviewThreads.githubNodeId),
      ),
    )
    .execute();
  if (rows.length === 0) return [];

  const needSeverity = rules.some((r) => r.severity != null);
  const severityByThread = new Map<number, string | null>();
  if (needSeverity) {
    const exRows = await db
      .select({
        threadId: reviewComments.threadId,
        excerpt: reviewComments.excerpt,
        createdAt: reviewComments.createdAt,
      })
      .from(reviewComments)
      .where(inArray(reviewComments.threadId, rows.map((r) => r.id)))
      .orderBy(asc(reviewComments.createdAt))
      .execute();
    for (const r of exRows) {
      if (!severityByThread.has(r.threadId)) severityByThread.set(r.threadId, inferSeverity(r.excerpt));
    }
  }

  const nowMs = Date.now();
  const byPr = new Map<number, number[]>();
  for (const t of rows) {
    if (t.userId == null) continue;
    const kind = kindMap.get(t.userId);
    if (!kind) continue;
    const ageMs = nowMs - t.createdAt.getTime();
    const matched = rules.some((rule) => {
      if (rule.vendorKind != null && rule.vendorKind !== kind) return false;
      if (!pathGlobMatch(rule.pathGlob, t.path)) return false;
      if (rule.severity != null && (severityByThread.get(t.id) ?? null) !== rule.severity) return false;
      const days = rule.autoResolveDays!;
      return ageMs > days * 86_400_000;
    });
    if (!matched) continue;
    const arr = byPr.get(t.prId) ?? [];
    arr.push(t.id);
    byPr.set(t.prId, arr);
  }
  return [...byPr.entries()].map(([prId, threadIds]) => ({ prId, threadIds }));
}
