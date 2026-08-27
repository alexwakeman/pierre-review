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
  max,
  ne,
  notInArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type {
  ApprovedPrItem,
  CheckRun,
  CiFailingCard,
  CiStatus,
  CommitDetail,
  DerivedState,
  DismissedItem,
  DismissedMyTurnResponse,
  EventType,
  InsightCard,
  InsightKind,
  InsightPrRef,
  InsightSeverity,
  MyTurnCard,
  MyTurnCardReason,
  ReviewerSuggestion,
  WorkspaceInsightsResponse,
  WorkspaceMetrics,
  WorkspaceMetricStat,
  WorkspaceMetricsDetail,
  SprintComparisonMode,
  MetricPr,
  MentionCandidate,
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
  ResolvableThreadPr,
  ReviewerLoadSeries,
  SizeCyclePoint,
  SizeCycleBucket,
  PrStatus,
  ReasonTag,
  Repo,
  Workspace,
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
  ConsolidatedFeedCounts,
  FeedAffectedThread,
  MyTurnPr,
  MyTurnRelevance,
  BotSignalCard,
  BotSignalVendorStat,
  AutomatedReviewerKind,
  ClassificationConfidence,
  ClassificationSource,
  ReviewerClassification,
  ReviewerFootprint,
  RepoReviewerFootprintEntry,
  WorkspaceReviewer,
  WorkspaceReviewerPatchBody,
  ReviewerRole,
  CostModel,
  DetectedReviewersResponse,
  ReviewProvenance,
  BotWindowKind,
  BotVerdict,
  BotVendorTrendPoint,
  BotVendorAnalytics,
  BotAnalyticsResponse,
  BotBehaviourResponse,
  BotBehaviourBotStat,
  BotBehaviourTrendPoint,
  BotBehaviourAnomaly,
  BotBehaviourMl,
  BotBehaviourMlBot,
  BotBehaviourMlWeekPoint,
  BotOverlapStats,
  BotCoReviewPair,
  BotRepoDirBreakdown,
  PrBotBehaviourResponse,
  PrBotBehaviour,
  BotVendorPr,
  BotVendorPrsResponse,
  BotDedupMember,
  BotDedupCluster,
  BotDedupResponse,
  AddressedConfidence,
  BotTuningSuggestion,
  AdvisorFindingsPayload,
  AdvisorPathCell,
  AdvisorCategoryCell,
  AdvisorOverlapCell,
  AdvisorBotTotals,
  AdvisorEffectPanel,
  AdvisorEffectSummary,
  AdvisorChangepoint,
  MlSeverity,
  MlSeverityCounts,
  MlCategory,
  BotOnlyReviewCard,
  UserContributionStats,
  ArmedMergeRequest,
  ArmedMergePhase,
  ArmedMergeState,
  MergeMethod,
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
import { getAccountById, getAccountUserId } from '../auth/account.js';
import { viewerMentionedPrIds } from './pr-mentions.js';
import { enrichReviewerSuggestions } from '../github/reviewer-suggest.js';
import { ensureRoutingPrFiles } from '../sync/routing-files.js';
import {
  matchesAutomatedLoginPattern,
  qualityCheckBotLogins,
  reviewBotKind,
  reviewBotLogins,
} from '../sync/bot-detection.js';
import {
  classifyReviewer,
  defaultRoleFor,
  labelFor as labelForKind,
  persistHumanJudgement,
  type ReviewerEvidence,
} from '../sync/reviewer-classify.js';
import { computeBehavioralSignals } from '../sync/reviewer-behavior.js';
import { fingerprintReview } from '../sync/review-fingerprint.js';
// ⚠ A deliberate module CYCLE: ml-labels.ts imports the bot-set resolvers from this file. It is
// benign under ESM because both sides export hoisted function declarations and only call each
// other at request time — never during module evaluation. Do not add an eval-time use.
import {
  getMlWindowAggregates,
  listMlLabelsForBehaviour,
  vendorAgreementOf,
} from './ml-labels.js';
import { clusterThreadsByLine } from './line-overlap.js';
import { botWindowMs } from './bot-window.js';
import { detectChangepoints } from './changepoint.js';

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
  // The TRUNK twin of ciStatusEvents (migration 0052 / pg 0039). Separate table, not a nullable
  // prId on the PR one: it is repo-scoped, has no PR to anchor retention to, and stores the
  // BranchCheckRun[] render payload rather than bare names.
  trunkCiStatusEvents,
  // Trunk commits (the default-branch snapshot's window). Read here for ONE thing: its
  // `pr_number` column, which is how a trunk CI failure names the PR that landed the commit
  // it failed on. NOT derivable from `commits` — that table is PR-scoped, so a squash-merged
  // PR never appears there under the sha that landed on trunk.
  branchCommits,
  mlCommentLabels,
  // THE ONE SCOPE (migrations 0044/0045). `workspaces` + `workspace_repos` replace the old
  // `teams`/`team_repos` many-to-many: a repo belongs to EXACTLY ONE workspace, as a database
  // fact (`workspace_repos`, UNIQUE (account_id, repo_id)), so there is no scope grammar left to
  // parse and no "belongs to nothing" state.
  workspaces,
  workspaceRepos,
  // THE BOT OBJECT: one row per (account, WORKSPACE, actor), carrying the judgement, the vendor
  // identity AND the price. It replaced the two-grain `repo_reviewers` / `account_reviewers` pair
  // — those existed only because judgement and identity sat at different grains, and with one
  // workspace as the only scope they are facts about the same key. The two PROVENANCE FLAGS
  // (`source` for automated/role/confidence/reasons, `identity_source` for kind/label) are what
  // now keep the halves apart; `monthly_cents` has exactly one writer (`setReviewerCost`).
  workspaceReviewers,
  benchmarkContributions,
  autoMergeRequests,
  // "@you was mentioned on this PR" (migration 0056 / pg 0043). Read here only through
  // db/pr-mentions.ts; named in this destructure for the ONE thing that has to live in this
  // file — `deleteRepo`'s hand-written cascade.
  prMentions,
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

// ⚠ EVERY REPO CARRIES ITS `workspaceId`, and it is never absent: the client has no other
// repo→workspace mapping, and the surfaces that hold only a repoId (PR detail, ThreadList's
// bulk-resolve offer, a restored tab, a search hit) must name the PR's OWN workspace rather than
// the selected one. A repo whose membership row is somehow missing is REPAIRED into the account's
// Default before this listing returns — `ensureRepoMemberships` is the read-side half of the
// invariant `sync/upsert.ts` writes (see the workspace_repos comment in schema.sqlite.ts).
export async function listRepos(accountId: number): Promise<Repo[]> {
  await ensureRepoMemberships(accountId);
  const [rows, memberRows] = await Promise.all([
    db
      .select()
      .from(repos)
      .leftJoin(syncState, eq(syncState.repoId, repos.id))
      .where(eq(repos.accountId, accountId))
      .orderBy(asc(repos.owner), asc(repos.name))
      .execute(),
    db
      .select({ repoId: workspaceRepos.repoId, workspaceId: workspaceRepos.workspaceId })
      .from(workspaceRepos)
      .where(eq(workspaceRepos.accountId, accountId))
      .execute(),
  ]);
  const workspaceByRepo = new Map(memberRows.map((m) => [m.repoId, m.workspaceId]));

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
    // The repair above guarantees a row; the `?? 0` is only there because TypeScript cannot see
    // that. A 0 here would mean the repair itself failed, which is a bug, not a state.
    workspaceId: workspaceByRepo.get(r.repos.id) ?? 0,
  }));
}

export async function getRepo(id: number, accountId: number): Promise<Repo | null> {
  return (await listRepos(accountId)).find((r) => r.id === id) ?? null;
}

// Node IDs of every repo ALREADY ADDED to this account. Two callers: dropping already-tracked
// repos out of live GitHub search results (a search hit exposes the same GraphQL `id`), and
// counting against the per-account repo cap. There is no second visibility axis to filter on —
// every repo in a workspace is fully live.
export async function getAddedRepoNodeIds(accountId: number): Promise<Set<string>> {
  const rows = await db
    .select({ nodeId: repos.githubNodeId })
    .from(repos)
    .where(eq(repos.accountId, accountId))
    .execute();
  return new Set(rows.map((r) => r.nodeId));
}

// ---- Workspaces (CORE) ----
// A named grouping of an account's repos, and THE ONE SCOPE THIS APP HAS. Every read/write is
// accountId-scoped; id-addressed mutators verify ownership and return false/'not_found'/empty for
// another account's workspace (→ 404 at the route).
//
// A repo belongs to EXACTLY ONE workspace — a database fact (`workspace_repos`, UNIQUE
// (account_id, repo_id)) — so assigning it elsewhere is a MOVE and there is no "belongs to
// nothing" state. That is what retired the whole scope grammar this block used to carry: 'all' /
// 'none' / 'teams' / '<id>' / 'teams:<ids>', five branches with three server parsers, whose
// answers could disagree. There is one workspace id and nothing to parse.
//
// TWO INVARIANTS ARE REPAIRED ON READ rather than merely asserted, because both fail silently:
//   • every account has exactly one `is_default` workspace  (`ensureDefaultWorkspace`)
//   • every repo has exactly one membership row             (`ensureRepoMemberships`)
// A repo with no membership row is invisible to every workspace-scoped read — no PRs, no feed
// rows, no bots, no error.
//
// ⚠ MEMBERSHIP IS THE ONLY THING THESE WRITES TOUCH — none of them UPDATEs `repos`. There used to
// be a second visibility axis ("watched"), and assignment silently switched it on for every id it
// touched; that was defensible while assignment was an explicit user gesture, but a repo can no
// longer be un-assigned, only MOVED, so the same write is now reached by `deleteWorkspace`, by the
// PATCH drop path and by the membership repair — none of which is a user gesture about visibility.
// The axis is gone: every repo in a workspace is fully live (Feed, Activity, My Turn, Bots), so
// there is nothing left for a re-home to smuggle in.

function mapWorkspace(
  w: typeof workspaces.$inferSelect,
  repoIds: number[],
): Workspace {
  return {
    id: w.id,
    name: w.name,
    repoIds,
    repoCount: repoIds.length,
    isDefault: w.isDefault,
    createdAt: w.createdAt.toISOString(),
  };
}

// The account's default workspace id, creating the row if absent. Called at account creation
// (ensureLocalAccount / upsertCloudAccount) and defensively from listWorkspaces /
// resolveWorkspaceScope — i.e. on effectively every request — so it must be genuinely
// CONCURRENT-SAFE, not merely re-runnable:
//   • INSERT … ON CONFLICT DO NOTHING, then re-SELECT. Two simultaneous callers must both come
//     back with the winner's id; a plain SELECT-then-INSERT 500s the loser. The partial unique
//     index `workspaces_one_default` (created in migration 0044 / pg 0031, not in the drizzle
//     table config) is what makes the conflict reachable for the is_default half; the
//     (account_id, name) unique covers the rest. The conflict target is deliberately UNSPELLED —
//     either index may be the one that fires, and a bare `ON CONFLICT DO NOTHING` covers both in
//     both dialects.
//   • It carries the SAME three-level name fallback the migration uses, because
//     `workspaces_account_name` is unique and an account whose team was literally called "Default"
//     migrated to a NON-default workspace holding that name. A bare INSERT … name='Default' would
//     then collide on every request for that account, forever.
export async function ensureDefaultWorkspace(accountId: number): Promise<number> {
  const readDefault = async (): Promise<number | null> => {
    const row = (
      await db
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(and(eq(workspaces.accountId, accountId), eq(workspaces.isDefault, true)))
        .limit(1)
        .execute()
    )[0];
    return row?.id ?? null;
  };

  const existing = await readDefault();
  if (existing != null) return existing;

  const taken = new Set(
    (
      await db
        .select({ name: workspaces.name })
        .from(workspaces)
        .where(eq(workspaces.accountId, accountId))
        .execute()
    ).map((r) => r.name),
  );
  // The third form embeds the account id, so it cannot collide with the first two for the same
  // account — the same ladder migration 0044 step 2 walks.
  const name = !taken.has('Default')
    ? 'Default'
    : !taken.has('Default workspace')
      ? 'Default workspace'
      : `Default (workspace ${accountId})`;

  await db
    .insert(workspaces)
    .values({ accountId, name, isDefault: true })
    .onConflictDoNothing()
    .execute();

  const after = await readDefault();
  if (after != null) return after;
  // Unreachable unless the partial unique index is missing from the database (a migration that
  // never ran), in which case failing loudly beats handing every caller a wrong scope.
  throw new Error(
    `ensureDefaultWorkspace: no default workspace for account ${accountId} after insert`,
  );
}

// Insert a Default membership row for every repo of the account that has none. Portable
// anti-join: two SELECTs diffed in JS (the shape the old `getUnassignedRepoIds` used) — no
// correlated subquery, so it stays on the async surface both dialects share.
//
// ⚠ IT IS A WRITE ON ESSENTIALLY EVERY GET, so two things are mandatory. The insert carries
// `ON CONFLICT (account_id, repo_id) DO NOTHING` because concurrent requests WILL race the unique.
// And it MUST NOT touch the `repos` row at all: repairing a membership is not a user gesture, so
// anything it changed about the repo itself would be a behaviour change smuggled in by a repair.
//
// It only reaches `ensureDefaultWorkspace` when there is actually something to repair, so the
// steady state is two cheap SELECTs and no write at all.
export async function ensureRepoMemberships(accountId: number): Promise<void> {
  const [repoRows, memberRows] = await Promise.all([
    db.select({ id: repos.id }).from(repos).where(eq(repos.accountId, accountId)).execute(),
    db
      .select({ repoId: workspaceRepos.repoId })
      .from(workspaceRepos)
      .where(eq(workspaceRepos.accountId, accountId))
      .execute(),
  ]);
  const have = new Set(memberRows.map((r) => r.repoId));
  const missing = repoRows.map((r) => r.id).filter((id) => !have.has(id));
  if (missing.length === 0) return;
  const defaultId = await ensureDefaultWorkspace(accountId);
  for (const repoId of missing) {
    await db
      .insert(workspaceRepos)
      .values({ accountId, workspaceId: defaultId, repoId })
      .onConflictDoNothing({
        target: [workspaceRepos.accountId, workspaceRepos.repoId],
      })
      .execute();
  }
}

// All workspaces for an account, each carrying its member repo ids. DEFAULT FIRST, then by name:
// the default is where users land and where everything is re-homed, so it belongs at the top of
// every picker. Repairs both invariants before reading.
export async function listWorkspaces(accountId: number): Promise<Workspace[]> {
  await ensureDefaultWorkspace(accountId);
  await ensureRepoMemberships(accountId);
  const [wsRows, memberRows] = await Promise.all([
    db.select().from(workspaces).where(eq(workspaces.accountId, accountId)).execute(),
    db
      .select({ workspaceId: workspaceRepos.workspaceId, repoId: workspaceRepos.repoId })
      .from(workspaceRepos)
      .innerJoin(repos, eq(repos.id, workspaceRepos.repoId))
      .where(eq(workspaceRepos.accountId, accountId))
      .orderBy(asc(repos.owner), asc(repos.name))
      .execute(),
  ]);
  const byWorkspace = new Map<number, number[]>();
  for (const m of memberRows) {
    const arr = byWorkspace.get(m.workspaceId) ?? [];
    arr.push(m.repoId);
    byWorkspace.set(m.workspaceId, arr);
  }
  return wsRows
    .slice()
    .sort(
      (a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name),
    )
    .map((w) => mapWorkspace(w, byWorkspace.get(w.id) ?? []));
}

// Create a workspace (unique per (accountId, name)). ALWAYS `isDefault: false` —
// `ensureDefaultWorkspace` is the only writer of `true`. Throws on a duplicate name; the caller
// maps the unique-constraint failure to a 400. Returns the fresh Workspace (no repos yet: a repo
// is MOVED in, never created into one).
export async function createWorkspace(accountId: number, name: string): Promise<Workspace> {
  const [row] = await db
    .insert(workspaces)
    .values({ accountId, name, isDefault: false })
    .returning()
    .execute();
  return mapWorkspace(row!, []);
}

// Rename a workspace (account-scoped → false/404 for one this account doesn't own). THE DEFAULT
// IS RENAMEABLE: it is not deletable, which is a different thing — a user who wants to call their
// primary workspace "Platform" is not asking to remove the fallback everything re-homes into.
export async function renameWorkspace(
  id: number,
  accountId: number,
  name: string,
): Promise<boolean> {
  const updated = await db
    .update(workspaces)
    .set({ name })
    .where(and(eq(workspaces.id, id), eq(workspaces.accountId, accountId)))
    .returning({ id: workspaces.id })
    .execute();
  return updated.length > 0;
}

// Delete a workspace. THREE-STATE, not boolean: the route must tell "not yours" (404) from
// "that's the default" (409).
//
// ⚠ RE-HOMING THE REVIEWER ROWS IS NOT OPTIONAL. Two cascades fire from `workspaces`, and only one
// of them is recoverable. `workspace_repos` losing its rows leaves the repos invisible until the
// next repair pass moves them to Default — the right end state by the wrong route. But
// `workspace_reviewers` cascading destroys every `source='manual'` verdict, every
// `identity_source='manual'` vendor name and every `monthly_cents` in the workspace — money the
// user typed — while the repos survive, with no warning and no undo. Under the old model deleting
// a team touched no classification at all (`repo_reviewers` keyed on repo, `account_reviewers` on
// account); one workspace-keyed row created this failure mode and this is where it is closed.
//
// ⚠ ON A COLLISION, DEFAULT'S EXISTING ROW WINS AND IS LEFT UNTOUCHED. Price is per workspace, so
// the deleted workspace's row and Default's row for the same actor may hold different numbers, and
// the `DO NOTHING` below is what decides it — the collision rule, not an optimisation. Deleting a
// workspace is an explicit destructive act the user confirmed, so discarding its price with its row
// is the expected cost; silently OVERWRITING a price the user set in Default, as a side effect of
// deleting a DIFFERENT workspace, would be strictly worse and would have no undo.
//
// The repo re-home is MEMBERSHIP ONLY — no `repos` UPDATE, so nothing about the repos themselves
// changes as a side effect of deleting the workspace that held them.
export async function deleteWorkspace(
  id: number,
  accountId: number,
): Promise<'deleted' | 'not_found' | 'is_default'> {
  const owned = (
    await db
      .select({ id: workspaces.id, isDefault: workspaces.isDefault })
      .from(workspaces)
      .where(and(eq(workspaces.id, id), eq(workspaces.accountId, accountId)))
      .limit(1)
      .execute()
  )[0];
  if (!owned) return 'not_found';
  if (owned.isDefault) return 'is_default';

  const defaultId = await ensureDefaultWorkspace(accountId);
  const [memberRows, reviewerRows] = await Promise.all([
    db
      .select({ repoId: workspaceRepos.repoId })
      .from(workspaceRepos)
      .where(and(eq(workspaceRepos.accountId, accountId), eq(workspaceRepos.workspaceId, id)))
      .execute(),
    db
      .select()
      .from(workspaceReviewers)
      .where(
        and(eq(workspaceReviewers.accountId, accountId), eq(workspaceReviewers.workspaceId, id)),
      )
      .execute(),
  ]);

  await runTransaction(async (tx) => {
    // 1. Repos → Default. A plain UPDATE cannot collide: UNIQUE (account_id, repo_id) means the
    //    repo has exactly this one membership row, so re-pointing it is always legal.
    for (const m of memberRows) {
      await tx
        .update(workspaceRepos)
        .set({ workspaceId: defaultId })
        .where(
          and(
            eq(workspaceRepos.accountId, accountId),
            eq(workspaceRepos.repoId, m.repoId),
          ),
        )
        .execute();
    }
    // 2. Reviewer rows → Default. An UPDATE here WOULD collide (Default may already hold a row
    //    for the same actor), so it is an insert-with-DO-NOTHING plus a delete of the leftovers:
    //    Default keeps whatever it had, judgement, identity and price alike.
    for (const r of reviewerRows) {
      await tx
        .insert(workspaceReviewers)
        .values({
          accountId,
          workspaceId: defaultId,
          authorUserId: r.authorUserId,
          automated: r.automated,
          role: r.role,
          confidence: r.confidence,
          source: r.source,
          reasonsJson: r.reasonsJson,
          kind: r.kind,
          label: r.label,
          identitySource: r.identitySource,
          monthlyCents: r.monthlyCents,
          // The price's reading rule travels WITH the price: a per-seat unit re-homed as 'flat'
          // would silently turn $29 × seats into a bare $29.
          costModel: r.costModel,
          updatedAt: r.updatedAt,
        })
        .onConflictDoNothing({
          target: [
            workspaceReviewers.accountId,
            workspaceReviewers.workspaceId,
            workspaceReviewers.authorUserId,
          ],
        })
        .execute();
    }
    await tx
      .delete(workspaceReviewers)
      .where(
        and(eq(workspaceReviewers.accountId, accountId), eq(workspaceReviewers.workspaceId, id)),
      )
      .execute();
    // 3. Belt-and-braces: step 1 already emptied this, and the FK cascades — but the explicit
    //    delete keeps the ordering dialect-agnostic (Postgres enforces FKs immediately; SQLite
    //    only with foreign_keys=ON).
    await tx
      .delete(workspaceRepos)
      .where(and(eq(workspaceRepos.accountId, accountId), eq(workspaceRepos.workspaceId, id)))
      .execute();
    await tx
      .delete(workspaces)
      .where(and(eq(workspaces.id, id), eq(workspaces.accountId, accountId)))
      .execute();
  });
  return 'deleted';
}

// The member repo ids of a workspace, account-scoped (foreign/unknown workspace → empty array).
// Ordered owner/name so `DetectedReviewersResponse.repoIds` and every scope that derives from it
// are in RENDER order rather than insertion order.
export async function getWorkspaceRepoIds(
  workspaceId: number,
  accountId: number,
): Promise<number[]> {
  const rows = await db
    .select({ repoId: workspaceRepos.repoId })
    .from(workspaceRepos)
    .innerJoin(repos, eq(repos.id, workspaceRepos.repoId))
    .where(
      and(
        eq(workspaceRepos.accountId, accountId),
        eq(workspaceRepos.workspaceId, workspaceId),
      ),
    )
    .orderBy(asc(repos.owner), asc(repos.name))
    .execute();
  return rows.map((r) => r.repoId);
}

// MOVE repos into a workspace — not "add". The UNIQUE (account_id, repo_id) makes that structural:
// the upsert re-points the repo's one membership row, so a repo already elsewhere is relocated and
// no code path can produce a second row. Only repos the account actually owns are touched (a
// foreign repoId is silently dropped — no cross-account leakage). No-op for a foreign/unknown
// workspace.
//
// ⚠ IT WRITES `workspace_repos` AND NOTHING ELSE — no `repos` UPDATE. It is reached from paths
// that are not user gestures (`deleteWorkspace`, the PATCH drop path, the membership repair), so
// anything it changed about the repo row itself would fire on all of them. There is no second
// visibility flag to set: a repo in a workspace is fully live by virtue of being there.
export async function assignReposToWorkspace(
  workspaceId: number,
  accountId: number,
  repoIds: number[],
): Promise<void> {
  const owned = (
    await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(and(eq(workspaces.id, workspaceId), eq(workspaces.accountId, accountId)))
      .limit(1)
      .execute()
  )[0];
  if (!owned) return;
  if (repoIds.length === 0) return;
  // Keep only repos this account owns (defends the composite FK + the isolation invariant).
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
        .insert(workspaceRepos)
        .values({ accountId, workspaceId, repoId })
        .onConflictDoUpdate({
          // (account_id, repo_id) — the unique that makes this a MOVE. A stale target
          // type-checks perfectly and raises "no unique or exclusion constraint matching the
          // ON CONFLICT specification" at RUNTIME, in both dialects, only on a real write.
          target: [workspaceRepos.accountId, workspaceRepos.repoId],
          set: { workspaceId },
        })
        .execute();
    }
  });
}

// Membership-only re-home: no `repos` UPDATE at all. Used by
// the PATCH drop path (ids removed from a workspace's membership go to Default, because there is
// no "no workspace" state to drop them into).
export async function rehomeReposToDefault(
  accountId: number,
  repoIds: number[],
): Promise<void> {
  if (repoIds.length === 0) return;
  const defaultId = await ensureDefaultWorkspace(accountId);
  const ownedRepos = await db
    .select({ id: repos.id })
    .from(repos)
    .where(and(eq(repos.accountId, accountId), inArray(repos.id, repoIds)))
    .execute();
  if (ownedRepos.length === 0) return;
  await db
    .update(workspaceRepos)
    .set({ workspaceId: defaultId })
    .where(
      and(
        eq(workspaceRepos.accountId, accountId),
        inArray(
          workspaceRepos.repoId,
          ownedRepos.map((r) => r.id),
        ),
      ),
    )
    .execute();
}

// Every bot getter needs TWO different things, and the old single `repoIds: number[] | null`
// conflated them: the WORKSPACE decides who counts as a bot, the REPO LIST narrows which data is
// measured. One object with two named fields, so a call site cannot transpose a number and a
// number[] and cannot forget which one the verdict comes from.
//
// ⚠ `null` IS GONE. `[]` keeps its one meaning — "no repos in scope ⇒ empty result" — and it is
// now an ordinary state (a freshly created workspace), not an edge case. Its predecessor's `null`
// meant "every repo of the account", which is precisely what a workspace scope must never silently
// widen to.
//
// A BotScope is only ever constructed by `resolveWorkspaceScope`, whose contract guarantees
// `repoIds ⊆ the workspace's membership`. The ONE genuine account-wide sweep — the cross-org
// benchmark rollup — has its own explicitly named helpers instead of a null sentinel
// (`automatedReviewerUserIdsForAccount` / `classificationKindForUserForAccount`).
export interface BotScope {
  workspaceId: number; // the JUDGEMENT grain — always exactly one
  repoIds: number[]; // the DATA narrowing — always concrete. [] = this workspace is empty.
}

// THE ONE SCOPE RESOLVER. `raw` is the wire `?workspace=` value. Unknown, unparseable, or another
// tenant's id ⇒ the account's DEFAULT workspace. It never throws, never 404s and is never an
// existence oracle (every id yields the same response shape, and the resolved id is always one the
// caller owns); the resolved id is echoed on every scoped response so a client can correct a stale
// bookmark.
//
// ⚠ IT IS ALSO THE ONE PLACE THE `?repoIds=` NARROWING IS BOUNDED. `narrow` is the caller's
// explicit list; the returned `repoIds` is ALWAYS `membership ∩ (narrow ?? membership)`. Under the
// old model an explicit list REPLACED the scope and was only intersected with the ACCOUNT's repos,
// which was sufficient while the judgement grain was the repo. It no longer is:
// `?workspace=5&repoIds=<a repo of workspace 9>` would otherwise pass the account check, and the
// listing would enumerate footprints over workspace-9 repos while the lazy classifier writes rows
// keyed to workspace 5 for actors with ZERO footprint there — fabricating exactly the rows the
// anti-fabrication gate exists to forbid, and making `getBotAnalytics(ws5, repos-of-ws9)` measure
// one workspace's data through another's verdicts. Doing it here, once, is what stops it being a
// per-route convention fourteen handlers must remember.
export async function resolveWorkspaceScope(
  accountId: number,
  raw: string | number | undefined | null,
  narrow?: number[] | null,
): Promise<BotScope> {
  await ensureRepoMemberships(accountId);
  const requested =
    typeof raw === 'number' ? raw : raw == null ? Number.NaN : Number.parseInt(String(raw), 10);
  let workspaceId: number | null = null;
  if (Number.isInteger(requested) && requested > 0) {
    const owned = (
      await db
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(and(eq(workspaces.id, requested), eq(workspaces.accountId, accountId)))
        .limit(1)
        .execute()
    )[0];
    if (owned) workspaceId = owned.id;
  }
  if (workspaceId == null) workspaceId = await ensureDefaultWorkspace(accountId);
  const membership = await getWorkspaceRepoIds(workspaceId, accountId);
  const repoIds =
    narrow == null ? membership : membership.filter((id) => narrow.includes(id));
  return { workspaceId, repoIds };
}

// The repo → workspace direction, as a ready-made scope. Needed by the two plugin call sites that
// hold only a `repoId` (the per-repo Insights metrics route) and by nothing else. Ownership-bound:
// a foreign/unknown repo yields null, never another tenant's workspace id.
export async function workspaceScopeForRepo(
  accountId: number,
  repoId: number,
): Promise<BotScope | null> {
  const row = (
    await db
      .select({ workspaceId: workspaceRepos.workspaceId })
      .from(workspaceRepos)
      .where(
        and(eq(workspaceRepos.accountId, accountId), eq(workspaceRepos.repoId, repoId)),
      )
      .limit(1)
      .execute()
  )[0];
  if (row) return { workspaceId: row.workspaceId, repoIds: [repoId] };
  // No membership row yet (a repo added microseconds ago, or a repair that has not run). Confirm
  // ownership before repairing, so this cannot be used to probe another tenant's repo ids.
  const ownedRepo = (
    await db
      .select({ id: repos.id })
      .from(repos)
      .where(and(eq(repos.id, repoId), eq(repos.accountId, accountId)))
      .limit(1)
      .execute()
  )[0];
  if (!ownedRepo) return null;
  await ensureRepoMemberships(accountId);
  const repaired = (
    await db
      .select({ workspaceId: workspaceRepos.workspaceId })
      .from(workspaceRepos)
      .where(
        and(eq(workspaceRepos.accountId, accountId), eq(workspaceRepos.repoId, repoId)),
      )
      .limit(1)
      .execute()
  )[0];
  return repaired ? { workspaceId: repaired.workspaceId, repoIds: [repoId] } : null;
}

/**
 * The GitHub actors visible to ONE account.
 *
 * `users` is one of the two deliberately GLOBAL tables (the other is `commitFiles`) — a
 * GitHub login is the same person for everyone, so deduplicating them account-side would be
 * wrong. But "global row storage" must not mean "global row DISCLOSURE": this used to
 * `select().from(users)` unscoped, so any tenant could enumerate the login, display name and
 * avatar of every GitHub user any OTHER tenant had ever synced — including contributors to
 * private repositories the caller has no access to, which is exactly the shape of leak the
 * per-account isolation rule exists to prevent.
 *
 * Scoping predicate: an actor is visible when they appear anywhere in THIS account's synced
 * data — as an event actor, a PR author or merger, a requested reviewer, or the author of a
 * review or comment on one of its PRs. That is a superset of everyone the UI can render and
 * a subset of the global table, so the Members panel is unchanged for the caller while
 * another tenant's contributors disappear from it.
 *
 * All six branches are correlated SUBQUERIES rather than materialised id arrays: a busy
 * account has hundreds of thousands of events, and round-tripping those ids through JS to
 * build an `IN (…)` list would be slower than the leak was dangerous.
 */
export async function listUsers(accountId: number): Promise<User[]> {
  // The account's PRs — the anchor for the child tables, which reach their account via prId.
  const accountPrIds = db
    .select({ id: pullRequests.id })
    .from(pullRequests)
    .where(eq(pullRequests.accountId, accountId));

  const rows = await db
    .select()
    .from(users)
    .where(
      or(
        inArray(
          users.id,
          db
            .selectDistinct({ id: events.actorId })
            .from(events)
            .where(and(eq(events.accountId, accountId), isNotNull(events.actorId))),
        ),
        inArray(
          users.id,
          db
            .selectDistinct({ id: pullRequests.authorId })
            .from(pullRequests)
            .where(
              and(eq(pullRequests.accountId, accountId), isNotNull(pullRequests.authorId)),
            ),
        ),
        inArray(
          users.id,
          db
            .selectDistinct({ id: pullRequests.mergedById })
            .from(pullRequests)
            .where(
              and(eq(pullRequests.accountId, accountId), isNotNull(pullRequests.mergedById)),
            ),
        ),
        // Requested reviewers who have not acted yet emit no event, so they need their own
        // branch or they would vanish from the Members panel.
        inArray(
          users.id,
          db
            .selectDistinct({ id: reviewRequests.userId })
            .from(reviewRequests)
            .where(
              and(
                inArray(reviewRequests.prId, accountPrIds),
                isNotNull(reviewRequests.userId),
              ),
            ),
        ),
        // An empty `commented` review is deliberately suppressed as an event, so review and
        // comment authors are covered explicitly rather than via `events`.
        inArray(
          users.id,
          db
            .selectDistinct({ id: reviews.authorId })
            .from(reviews)
            .where(and(inArray(reviews.prId, accountPrIds), isNotNull(reviews.authorId))),
        ),
        inArray(
          users.id,
          db
            .selectDistinct({ id: prComments.authorId })
            .from(prComments)
            .where(
              and(inArray(prComments.prId, accountPrIds), isNotNull(prComments.authorId)),
            ),
        ),
      ),
    )
    .orderBy(asc(users.githubLogin))
    .execute();
  return rows.map(mapUser);
}

// All-time contribution counts for ONE user, as seen from ONE account's synced data.
//
// Deliberately COUNTS-ONLY: no titles, no bodies, no ids, no profile fields — the caller
// already knows who it asked about, and a popover that leaks a PR title would leak it from
// repos the reader may not have open. There is no date window either; these are lifetime
// totals over whatever this account has synced, which is what a "who is this person" hover
// wants (a windowed number reads as "did nothing" for a long-tenured contributor).
//
// Account scoping is the load-bearing part. `users` is a GLOBAL table, so the user id alone
// grants nothing: every count is bound to `pullRequests.accountId = accountId`. PRs carry
// `accountId` directly (it's denormalized onto the anchor tables); `reviews`, `prComments`
// and `reviewComments` do NOT, so they reach their tenant the only way they can — an inner
// join to their parent PR, exactly as the reviewer-evidence / detected-reviewer queries do.
// The upshot is that asking about another tenant's user returns all zeros rather than their
// numbers, and it does so without an ownership 404 (which would make ids enumerable).
//
// `repoIds`: null = every repo in the account; a non-empty list narrows; an EMPTY array is a
// caller that narrowed to nothing, which must be all-zeros rather than an `inArray([])`.
export async function getUserStats(
  accountId: number,
  userId: number,
  repoIds: number[] | null = null,
): Promise<UserContributionStats> {
  const zero: UserContributionStats = {
    userId,
    prsMerged: 0,
    prsOpen: 0,
    prsDraft: 0,
    prsClosed: 0,
    reviewsGiven: 0,
    comments: 0,
    repoIds,
  };
  if (repoIds != null && repoIds.length === 0) return zero;

  // The repo narrowing, expressed once against pullRequests — every source reaches the
  // repo through its PR, so the same predicate works for all four queries.
  const repoScope = repoIds ? [inArray(pullRequests.repoId, repoIds)] : [];

  // PR buckets: ONE grouped count folded in JS. Grouping on (state, isDraft) keeps this
  // portable (no CASE), and `isDraft` reads back as a real boolean on both dialects
  // (integer mode:'boolean' in sqlite, boolean in pg). Bucket mapping mirrors
  // prStatusWhere(): merged / closed by state, open split by isDraft.
  const [prRows, revRows, prCommentRows, reviewCommentRows] = await Promise.all([
    db
      .select({ state: pullRequests.state, isDraft: pullRequests.isDraft, n: count() })
      .from(pullRequests)
      .where(
        and(
          eq(pullRequests.accountId, accountId),
          eq(pullRequests.authorId, userId),
          ...repoScope,
        ),
      )
      .groupBy(pullRequests.state, pullRequests.isDraft)
      .execute(),
    // Reviews SUBMITTED. `pending` is a draft review that was never submitted — excluded
    // here as it is everywhere else in this file.
    //
    // Also excluded: GitHub's body-less `commented` WRAPPER — the empty review row it
    // creates around a batch of inline comments. Counting those would (a) disagree with
    // what the rest of the app calls a review (`isSubstantiveReview` in sync/upsert.ts,
    // which is why the timeline suppresses them) and (b) DOUBLE-COUNT against the
    // `comments` total below, since the wrapper's inline comments are counted there too.
    // On real data that is over half the rows for an active reviewer. `reviews.body` is
    // persisted unconditionally in both modes, so the test is reliable. (A whitespace-ONLY
    // body counts as substantive here where `isSubstantiveReview` would trim it away —
    // expressing trim() portably would need a raw sql template for a case that does not
    // occur; the emptiness test is `IS NOT NULL AND <> ''`.)
    db
      .select({ n: count() })
      .from(reviews)
      .innerJoin(pullRequests, eq(pullRequests.id, reviews.prId))
      .where(
        and(
          eq(pullRequests.accountId, accountId),
          eq(reviews.authorId, userId),
          ne(reviews.state, 'pending'),
          or(ne(reviews.state, 'commented'), and(isNotNull(reviews.body), ne(reviews.body, ''))),
          ...repoScope,
        ),
      )
      .execute(),
    // Issue-level PR comments.
    db
      .select({ n: count() })
      .from(prComments)
      .innerJoin(pullRequests, eq(pullRequests.id, prComments.prId))
      .where(
        and(
          eq(pullRequests.accountId, accountId),
          eq(prComments.authorId, userId),
          ...repoScope,
        ),
      )
      .execute(),
    // Inline review-thread comments. `reviewComments` carries its own `prId` alongside the
    // thread fk, so it joins the PR directly — the shape reviewerEvidence() already uses.
    db
      .select({ n: count() })
      .from(reviewComments)
      .innerJoin(pullRequests, eq(pullRequests.id, reviewComments.prId))
      .where(
        and(
          eq(pullRequests.accountId, accountId),
          eq(reviewComments.authorId, userId),
          ...repoScope,
        ),
      )
      .execute(),
  ]);

  const stats: UserContributionStats = { ...zero };
  for (const r of prRows) {
    if (r.state === 'merged') stats.prsMerged += r.n;
    else if (r.state === 'closed') stats.prsClosed += r.n;
    else if (r.state === 'open') {
      if (r.isDraft) stats.prsDraft += r.n;
      else stats.prsOpen += r.n;
    }
  }
  stats.reviewsGiven = revRows[0]?.n ?? 0;
  stats.comments = (prCommentRows[0]?.n ?? 0) + (reviewCommentRows[0]?.n ?? 0);
  return stats;
}

// NOTE: `setUserBot` was REMOVED along with `PATCH /api/users/:id`.
//
// It wrote `isBot` + the sticky `isBotOverridden` flag to the GLOBAL `users` row with no
// ownership predicate at all, so any authenticated account could flip any enumerable user id
// and have that classification apply to EVERY tenant watching that login — permanently,
// since `isBotOverridden` suppresses later auto-detection. Nothing in the frontend called it
// (only `listUsers` is used); bot classification is done by the account-scoped
// `PATCH /api/bot-reviewers/:userId`, which writes the per-(account, workspace, actor)
// `workspace_reviewers` row. Deleting the route was therefore strictly better than adding a
// predicate to it.
// If a global override is ever wanted again, it needs to be an operator action, not an API.

export interface TimelineFilters {
  accountId: number;
  // The REQUEST's resolved workspace (the route already runs resolveWorkspaceScope for
  // `repoIds`) — the grain the excludeBots union reads its automated-reviewer verdict at.
  // Required so no call site can quietly fall back to Default while the rows on screen come
  // from another workspace's repos.
  workspaceId: number;
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

// ---- Timeline row caps (memory bound, NOT a product limit) ----
// `/api/timeline` is the one route whose result size is driven purely by client-supplied
// dates, and both of its selects load whole rows into memory and then into a single JSON
// body. The route clamps the requested span, but a clamp is not a bound: a tenant watching
// 100 busy repos can have a legitimately enormous window inside the retention horizon.
// These caps sit far above any real view (a 14-day default board is orders of magnitude
// smaller, and the SPA never asks for more than 90 days) and exist so that no single
// request — or a burst of them — can exhaust the heap of a process that, in cloud, is
// shared by every tenant. Truncation is surfaced as `truncated` rather than hidden.
const TIMELINE_PR_ROW_CAP = 5_000;
const TIMELINE_EVENT_ROW_CAP = 20_000;

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
    additions: p.additions,
    deletions: p.deletions,
    changedFiles: p.changedFiles,
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
    workspaceId,
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
  // Resolve the bot set once (used by both the PR and events branches below) — the UNION
  // definition (global users.isBot ∪ the workspace's automated-reviewer verdict, manualHuman
  // removed from both halves; see hiddenBotUserIds), so a workspace-classified in-house bot is
  // hidden too and a workspace "not a bot" override un-hides. The per-repo allow-list subtracts
  // the "important" bots so their activity stays visible even under excludeBots — every
  // downstream predicate keys off this trimmed set. Skipped entirely when pr-scoped (no bot
  // filtering there).
  const allowBots = new Set(allowBotIds ?? []);
  const bots =
    !prScoped && excludeBots
      ? (await hiddenBotUserIds(accountId, workspaceId)).filter((id) => !allowBots.has(id))
      : [];
  if (!prScoped && excludeBots && bots.length > 0) {
    prConds.push(
      or(
        sql`${pullRequests.authorId} is null`,
        sql`${pullRequests.authorId} not in (${sql.join(bots, sql`, `)})`,
      )!,
    );
  }

  // Hard row caps. `from`/`to` come from the client, and the route clamps the span — but a
  // clamp alone is not a memory bound: a tenant with 100 busy repos can legitimately have a
  // very large retained window, and both of these selects materialise every matching row
  // into JS objects and then into ONE JSON response. Without a cap, a handful of concurrent
  // wide-window requests OOM the container — which in cloud is shared by every tenant, so
  // one authenticated account could take the whole deployment down.
  //
  // The caps sit far above any real window (a default 14-day view is orders of magnitude
  // smaller) and truncation is reported to the client via `truncated` so the UI can say so
  // rather than silently showing a partial board.
  //
  // Ordering matters when truncating: take the MOST RECENT rows, not an arbitrary page.
  // The pr-scoped path is never capped — a selected PR must never be filtered out.
  let prRows = prScoped
    ? await db.select().from(pullRequests).where(and(...prConds)).execute()
    : await db
        .select()
        .from(pullRequests)
        .where(and(...prConds))
        .orderBy(desc(pullRequests.updatedAt))
        .limit(TIMELINE_PR_ROW_CAP + 1)
        .execute();
  const prsTruncated = prRows.length > TIMELINE_PR_ROW_CAP;
  if (prsTruncated) prRows = prRows.slice(0, TIMELINE_PR_ROW_CAP);

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

  // Same cap for events. Selected NEWEST-first so a truncation drops the far (oldest) edge
  // of the window rather than an arbitrary slice, then reversed back to the ascending order
  // the rest of this function and the SPA both expect.
  const evRowsDesc = await db
    .select()
    .from(events)
    .where(and(...evConds))
    .orderBy(desc(events.occurredAt))
    .limit(TIMELINE_EVENT_ROW_CAP + 1)
    .execute();
  const eventsTruncated = evRowsDesc.length > TIMELINE_EVENT_ROW_CAP;
  const evRows = (
    eventsTruncated ? evRowsDesc.slice(0, TIMELINE_EVENT_ROW_CAP) : evRowsDesc
  ).reverse();

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

  return {
    prs,
    events: timelineEvents,
    // Only present when a row cap actually bit, so the common case serialises unchanged.
    ...(prsTruncated || eventsTruncated ? { truncated: true as const } : {}),
  };
}

// ---- recent-activity Feed (My Turn panel) ----

// Recent activity across the account's repos (narrowed by `repoIds` when the caller has a
// scope), newest first,
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
  const { daysBefore = 14, repoIds = null, userIds = null, prId = null, botActorIds = null } = opts;
  // Isolated to one PR → no time window (epoch 0); otherwise the rolling `daysBefore` window.
  const since = prId != null ? new Date(0) : new Date(Date.now() - daysBefore * 24 * 60 * 60 * 1000);
  const conds: SQL[] = [
    eq(events.accountId, accountId),
    gte(events.occurredAt, since),
    ne(events.type, 'commit_pushed'),
  ];
  if (prId != null) conds.push(eq(events.prId, prId));
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

// ---- insights (per-repo sprint stats) ----

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
 * in the last 30 days that got a review. Per-repo only — no workspace aggregation yet.
 * Scoped to the account; `repoIds` narrows to the caller's repo selection.
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
  // Port of the cross-repo walk in getWorkspaceMetrics, SCOPED to this single repo and WEEKLY-
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

/**
 * The synced `repos.viewerPermission` values that mean the viewer can PUSH to the repo.
 *
 * Lives here, exported, because two unrelated features now ask the same question and a second
 * literal set is a second answer waiting to drift: the auto-merge runner's land-time re-check,
 * and My Turn's personal-relevance gate (`viewerMaintainedRepoIds` below). GitHub's other values
 * — READ, TRIAGE, NONE, and a null from a token that couldn't read the field — are all "no".
 */
export const WRITE_PERMISSIONS = new Set(['WRITE', 'MAINTAIN', 'ADMIN']);

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

/**
 * THE REPOS THIS VIEWER MAINTAINS — the repo half of My Turn's personal-relevance gate.
 *
 * "Maintains" is deliberately a UNION of two independent signals, because either one alone is
 * wrong on a real account:
 *   • `repos.viewerPermission` ∈ WRITE/MAINTAIN/ADMIN — GitHub's own answer, but it is null on
 *     rows synced before the column existed and READ on a repo you nonetheless ship to via a
 *     fork-and-merge arrangement.
 *   • you have landed a PR on the repo's DEFAULT BRANCH (`getMergers`) — behavioural, works
 *     without any permission grant, and the same proxy the reviewer suggester already trusts.
 *
 * WHY IT EXISTS: My Turn's "New PRs" section notifies about every non-draft human PR in every
 * repo the account has added, which on a real account is hundreds of strangers' PRs in repos the
 * viewer only reads. The NOTIFICATION surfaces narrow to this set; the board does not (see
 * `MyTurnCard.personal`). A stranger's PR in a repo you maintain is still personal — that is the
 * whole point of the maintainer half.
 *
 * ⚠ `getMergers` has NO `ORDER BY`, so its rows and each row's `userIds` arrive in heap order,
 * which flips after any UPDATE on Postgres. Only set MEMBERSHIP is read here; nothing may index
 * into `userIds` positionally.
 */
async function viewerMaintainedRepoIds(
  accountId: number,
  viewerUserId: number | null,
): Promise<Set<number>> {
  const out = new Set<number>();
  const permRows = await db
    .select({ id: repos.id, viewerPermission: repos.viewerPermission })
    .from(repos)
    .where(eq(repos.accountId, accountId))
    .execute();
  for (const r of permRows) {
    if (WRITE_PERMISSIONS.has(r.viewerPermission ?? '')) out.add(r.id);
  }
  // A viewer we couldn't resolve to a users row has no merge history to consult; the permission
  // half above still stands on its own.
  if (viewerUserId == null) return out;
  for (const m of await getMergers(accountId)) {
    if (m.userIds.includes(viewerUserId)) out.add(m.repoId);
  }
  return out;
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

// The Activity aggregate: per repo, current-state stats + a per-repo thread
// total + maintainer ids + attention/unread flags + the open PRs (caller groups by
// author). Scoped to the account's repos ∩ `scope.repoIds` — i.e. the whole selected
// workspace, with no second visibility axis. Composes
// EXISTING accountId-scoped readers — getInsights / getOpenPrs / getMergers / listRepos — so
// isolation + triage logic stay single-sourced. The one genuinely new aggregation is
// `threadTotals` (sum each open PR's threadCounts per repo). Every repo in scope is
// included (a quiet repo → empty prs, zeroed stats).
//
// It takes a full `BotScope` rather than a repo list because its acted-on bot stat needs the
// WORKSPACE to know who counts as a review bot; `scope.repoIds` only narrows the data.
export async function getActivity(
  accountId: number,
  scope: BotScope,
  userIds: number[] | null = null,
): Promise<ActivityResponse> {
  const reposAll = await listRepos(accountId);
  const reposScoped = reposAll.filter((r) => scope.repoIds.includes(r.id));
  const scopedIds = reposScoped.map((r) => r.id);

  // No repos in scope → a valid empty response (also avoids an inArray([]) below).
  if (scopedIds.length === 0) return { repos: [], generatedAt: new Date().toISOString() };

  // The compact-header `stats` stay REPO-scoped (repo health: open/draft/merged/stalled/
  // median-first-review) — filtering them by member would misreport repo throughput. The
  // PR cards + thread bar reflect the member filter via getOpenPrs' userIds. Pass the
  // ids that survived the ownership intersection, never the raw `scope.repoIds`.
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
  // when the workspace runs no review bot — the headline stat then simply doesn't render.
  // The judgement comes from `scope.workspaceId`, the same workspace the repos in this response
  // belong to. `role: 'review'` — this is a REVIEW-bot acted-on rate; a linter's threads would
  // inflate it.
  const botThreadCountsByPr = await buildBotThreadCounts(
    openPrs.map((pr) => pr.id),
    await automatedReviewerUserIds(accountId, scope.workspaceId, 'review'),
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

// The consolidated Feed's rolling READ window (the un-isolated stream; single-PR isolation drops
// it — see getConsolidatedFeed). Exported because a retention policy anywhere upstream has to be
// at least this long or the Feed reads rows that no longer exist: `sync/branch-status.ts`'s trunk
// CI transition log trims against it, after a count-only trim let an active repo evict the very
// failure rows this window is supposed to surface.
export const FEED_WINDOW_DAYS = 14;

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
  // WHICH WORKSPACE'S JUDGEMENT the bot-only feed uses. REQUIRED, and required rather than
  // optional deliberately: the bots-only path resolves an automated-reviewer set, and that answer
  // is a workspace fact. An optional field here would have every call site quietly fall back to
  // some default workspace's verdicts while the rows on screen came from another's repos. The
  // route resolves it via `resolveWorkspaceScope` (absent / unknown / foreign ⇒ Default).
  workspaceId: number;
  // null / omitted → ALL the account's repos; a list → scope to those repo ids. The route
  // passes `scope.repoIds`, already bounded by the workspace's membership.
  repoIds?: number[] | null;
  // Member filter: null / empty → all actors; a list → only those actors.
  userIds?: number[] | null;
  // Isolate the feed to a SINGLE PR: null → every PR in scope; a pr id → only that PR's
  // items. Applied after coalesce + my-turn enrich so `total` and the page reflect the
  // isolated set. Drives the Feed "open PRs" panel's per-PR filter.
  prId?: number | null;
  // Mirror the timeline's "exclude bots" filter: drop feed activity + My Turn items whose
  // actor is a bot under the UNION definition (global users.isBot ∪ this workspace's
  // automated-reviewer verdict — see hiddenBotUserIds). Applied BEFORE the page cap, so a
  // bot-heavy window fills with human rows rather than paging mostly-hidden ones (this is what
  // the SPA's feed lens 'hide' sends). Claude-review items are never dropped (no member
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
  // Bot-only feed window override (days) so the bot feed follows the analytics window
  // selector. Applied ONLY on the botsOnly path; absent/null → the default 14. The route
  // clamps it to 1..90.
  botWindowDays?: number | null;
  // Surface EVERY commit-push run, not just the ones that addressed a review thread — the
  // opt-in "Commits" feed toggle (off by default). Plain pushes stay hidden unless this is
  // set. Ignored on the botsOnly path (a push is the author responding, not review-bot
  // activity). The addressed-thread runs still ride along inline either way.
  includeAllCommits?: boolean;
  // Surface CI FAILURES as feed items — the opt-in "CI failures" toggle, OFF BY DEFAULT.
  // Covers both halves at once: failed checks on a PR head (`ci_status_events`) AND failed
  // checks on a repo's default branch (`trunk_ci_status_events`). Absent/false → the two
  // builders are not even called and the `ciFailures` facet is 0.
  //
  // Ignored on the botsOnly path (a red build is not review-bot activity) and skipped whenever
  // a member filter is active — these rows are actor-less, so they would survive a feed the
  // reader explicitly scoped to specific people (the getClaudeReviewFeedItems rule).
  includeCiFailures?: boolean;
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
    // Emit EVERY run (opt-in "show commits"), not just the ones that addressed a thread. A
    // run with no addressed thread carries an empty `affectedThreads` + a "pushed N commits"
    // summary. Off → the default (thread-addressing runs only).
    includeAllCommits?: boolean;
  },
): Promise<ConsolidatedFeedItem[]> {
  const { repoIds, userIds, botIds, since, prId = null, includeAllCommits = false } = opts;
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
  // No addressed threads anywhere: with the default gate that's an empty feed; under
  // includeAllCommits we still emit the plain commit runs below.
  if (candThreadIds.length === 0 && !includeAllCommits) return [];

  // First-comment excerpt/author + last-comment time per candidate thread. Only the
  // short `excerpt` is loaded (always populated — never the bulky `body`), keeping this
  // per-page pass cheap.
  const firstByThread = new Map<number, { excerpt: string | null; authorId: number | null }>();
  const lastAtByThread = new Map<number, number>();
  if (candThreadIds.length > 0)
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
    if (cands.length === 0 && !includeAllCommits) continue;
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
    if (affected.length === 0 && !includeAllCommits) continue;
    const commitWord = run.commitCount === 1 ? 'commit' : 'commits';
    const threadWord = affected.length === 1 ? 'thread' : 'threads';
    const changeSummary =
      affected.length === 0
        ? `pushed ${run.commitCount} ${commitWord}`
        : `pushed ${run.commitCount} ${commitWord} · addressed ${affected.length} ${threadWord}`;
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
      changeSummary,
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

// ---- CI-failure feed items (OFF BY DEFAULT — the "CI failures" pill) ----
//
// Two synthesized kinds, no `events` rows, following the `claude_review` precedent exactly:
//   'ci_failed'       — a check failing on a PR head        (source: ci_status_events)
//   'trunk_ci_failed' — a check failing on the default branch (source: trunk_ci_status_events)
//
// GRAIN: ONE ITEM PER FAILED RUN, keyed (PR-or-branch, head sha, check name). Both sources are
// TRANSITION logs that write a new row whenever the failing-check SET changes, so a build whose
// checks go red one at a time emits several rows for one broken push — un-deduped that reads as
// spam and crowds the 250-row plain-activity cap. The EARLIEST observation of each key wins, so
// a card's timestamp is when the failure was first seen, not when it was last re-confirmed.
//
// ⚠ `observedAt` is OUR observation time, never GitHub's completion time (neither GraphQL query
// selects `completedAt`). A PR head can be up to the ~30-minute forced re-walk floor behind, and
// trunk has no fast path at all — `syncBranchStatus` runs only at the end of a full walk. Card
// copy therefore says "CI failure detected", never "CI failed at".
//
// Both builders are actor-less (`actorId: null`), so — exactly like getClaudeReviewFeedItems —
// the caller skips them whenever a member filter is active, and they never enter the My-Turn
// lane (see getConsolidatedFeed).

// The two synthesized CI kinds, in ONE predicate. Every place that must treat them together —
// the My-Turn withholding, the facet count, the live-CI enrichment guard — goes through this
// rather than repeating a two-arm `||`, because missing one arm is silent. Exported for tests.
export function isCiFeedKind(kind: string): boolean {
  return kind === 'ci_failed' || kind === 'trunk_ci_failed';
}

// Newest CI transition rows scanned per builder. Bounds the read on an account with a chronically
// red matrix build; the dedupe below collapses them further.
const CI_EVENT_SCAN_CAP = 1000;
// How many distinct failing CHECK NAMES one (target, head sha) may emit cards for. A 60-shard
// matrix going red must not put 60 cards in the feed; the overflow is DISCLOSED on each emitted
// card's summary rather than silently dropped.
//
// ⚠ THE GRAIN IS THE HEAD, NOT THE ROW. Both sources are TRANSITION logs (a fresh row every time
// the failing SET changes on the same head), so a sharded matrix build going red shard by shard
// writes ten rows for one head, each carrying the cumulative set. Applying this cap to a single
// row's list — while the dedupe set spans rows — let EVERY row contribute one more card (a newly
// named shard sorts into the top-N window, is an unseen key, and is emitted), so one head emitted
// far more than N cards and the early ones disclosed "0 more" while N+5 checks were failing.
// `collapseCiRows` therefore accumulates per head across rows.
const MAX_CI_ITEMS_PER_HEAD = 5;

const shortSha = (sha: string): string => sha.slice(0, 7);

// Shared shape-builder for both halves, so a PR card and a trunk card can never drift apart.
function ciFeedItem(args: {
  id: string;
  kind: 'ci_failed' | 'trunk_ci_failed';
  occurredAt: Date;
  repoId: number;
  repoFullName: string;
  prId: number | null;
  prNumber: number | null;
  prTitle: string | null;
  prState: PrState | null;
  status: CiStatus;
  headSha: string;
  checkName: string | null;
  moreFailing: number;
  githubUrl: string | null;
  where: string;
}): ConsolidatedFeedItem {
  const label = args.checkName ?? 'CI';
  const more =
    args.moreFailing > 0
      ? ` · ${args.moreFailing} more check${args.moreFailing === 1 ? '' : 's'} also failing`
      : '';
  return {
    id: args.id,
    isMyTurn: false,
    myTurnReasons: [],
    kind: args.kind,
    occurredAt: args.occurredAt.toISOString(),
    repoId: args.repoId,
    repoFullName: args.repoFullName,
    prId: args.prId,
    prNumber: args.prNumber,
    prTitle: args.prTitle,
    prState: args.prState,
    actorId: null,
    content: null,
    threadId: null,
    commentId: null,
    path: null,
    line: null,
    reasonTag: null,
    reviewState: null,
    githubUrl: args.githubUrl,
    mergedById: null,
    reviewers: null,
    // The rollup state AT THE OBSERVATION, not the PR's live one. getConsolidatedFeed's
    // per-page enrichment overwrites `ciStatus` for PR-bearing items from pull_requests, which
    // is the right live answer for those cards; the historical state stays in changeSummary.
    ciStatus: args.status,
    changedFilesCount: null,
    affectedThreads: null,
    commitCount: null,
    changeSummary: `${label} failed on ${args.where} ${shortSha(args.headSha)}${more}`,
    failingChecks: args.checkName != null ? [args.checkName] : [],
    ciHeadSha: args.headSha,
    claudeReviewId: null,
    claudeVerdict: null,
    mergedComments: [],
  };
}

/**
 * Collapse a transition log's rows into one card per (target, head sha, check name).
 *
 * `rows` must arrive NEWEST FIRST (that is how both indexes are read and how the scan cap keeps
 * the recent tail); this walks them in reverse so the EARLIEST row for each key wins the
 * timestamp. Emission order doesn't matter — getConsolidatedFeed sorts the merged stream.
 *
 * TWO PASSES, and the transition log's shape is the reason (see MAX_CI_ITEMS_PER_HEAD): the cap
 * and the "N more checks also failing" disclosure are both facts about a HEAD, which routinely
 * owns many rows, so neither can be computed from the single row being emitted. Pass 1 walks the
 * rows accumulating, per head, the UNION of every failing name it was ever observed with plus the
 * capped picks in first-observation order; pass 2 emits, so every card on a head discloses the
 * same, final overflow count.
 */
function collapseCiRows<T>(
  rows: T[],
  key: (r: T) => string,
  names: (r: T) => string[],
  emit: (r: T, checkName: string | null, moreFailing: number) => ConsolidatedFeedItem,
): ConsolidatedFeedItem[] {
  interface HeadState {
    // Every distinct failing check name this head was EVER observed with — the denominator of
    // the overflow disclosure. It grows across rows; the cap never truncates it.
    union: Set<string>;
    // How many NAMED cards this head emitted (the bare-rollup card names nothing, so it is not
    // counted here and therefore not subtracted from the union).
    named: number;
    cards: { row: T; name: string | null }[];
  }
  const heads = new Map<string, HeadState>();
  const seen = new Set<string>();
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i] as T;
    const head = key(row);
    let state = heads.get(head);
    if (state == null) {
      state = { union: new Set(), named: 0, cards: [] };
      heads.set(head, state);
    }
    const all = [...new Set(names(row))].sort();
    for (const name of all) state.union.add(name);
    // A red rollup that carried no named contexts still deserves one honest card.
    const emitted = all.length > 0 ? all : [null];
    for (const name of emitted) {
      // The cap is spent PER HEAD, ACROSS ROWS — never per row (that was the bug: each later
      // row's newly-named shard was an unseen key inside its own top-N window, so a matrix build
      // going red shard by shard emitted one card per row).
      if (state.cards.length >= MAX_CI_ITEMS_PER_HEAD) break;
      const k = `${head} ${name ?? ''}`;
      if (seen.has(k)) continue;
      seen.add(k);
      state.cards.push({ row, name });
      if (name != null) state.named += 1;
    }
  }

  const out: ConsolidatedFeedItem[] = [];
  for (const state of heads.values()) {
    // Named failures the cap kept out of the feed, counted over the head's whole union rather
    // than over whichever row happened to carry the card.
    const more = Math.max(0, state.union.size - state.named);
    for (const c of state.cards) out.push(emit(c.row, c.name, more));
  }
  return out;
}

/** PR-side CI failures, from the `ci_status_events` transition log. */
async function getCiFailureFeedItems(
  accountId: number,
  repoIds: number[],
  since: Date,
  // Single-PR isolation (see getFeed): scope to this PR's rows (with a widened `since`).
  prId: number | null = null,
): Promise<ConsolidatedFeedItem[]> {
  if (repoIds.length === 0) return [];
  const conds = [
    eq(ciStatusEvents.accountId, accountId),
    inArray(ciStatusEvents.repoId, repoIds),
    inArray(ciStatusEvents.status, ['failure', 'error']),
    gte(ciStatusEvents.observedAt, since),
  ];
  if (prId != null) conds.push(eq(ciStatusEvents.prId, prId));
  const rows = await db
    .select({
      prId: ciStatusEvents.prId,
      repoId: ciStatusEvents.repoId,
      headSha: ciStatusEvents.headSha,
      status: ciStatusEvents.status,
      failingChecks: ciStatusEvents.failingChecks,
      observedAt: ciStatusEvents.observedAt,
      owner: repos.owner,
      name: repos.name,
      prNumber: pullRequests.number,
      prTitle: pullRequests.title,
      prState: pullRequests.state,
    })
    .from(ciStatusEvents)
    .innerJoin(pullRequests, eq(pullRequests.id, ciStatusEvents.prId))
    .innerJoin(repos, eq(repos.id, ciStatusEvents.repoId))
    .where(and(...conds))
    // Covered by cse_account_repo_observed / cse_account_pr_observed.
    .orderBy(desc(ciStatusEvents.observedAt))
    .limit(CI_EVENT_SCAN_CAP)
    .execute();

  return collapseCiRows(
    rows,
    (r) => `${r.prId} ${r.headSha}`,
    (r) => r.failingChecks ?? [],
    (r, checkName, moreFailing) =>
      ciFeedItem({
        id: `feed:ci:${r.prId}:${r.headSha}:${checkName ?? ''}`,
        kind: 'ci_failed',
        occurredAt: r.observedAt,
        repoId: r.repoId,
        repoFullName: `${r.owner}/${r.name}`,
        prId: r.prId,
        prNumber: r.prNumber,
        prTitle: r.prTitle,
        prState: r.prState,
        status: r.status as CiStatus,
        headSha: r.headSha,
        checkName,
        moreFailing,
        githubUrl: `https://github.com/${r.owner}/${r.name}/pull/${r.prNumber}/checks`,
        where: `#${r.prNumber}`,
      }),
  );
}

/**
 * Resolve trunk commit shas → the PR that landed each one, keyed `${repoId}:${sha}`.
 *
 * The mapping is already stored: the default-branch snapshot writes `branch_commits.pr_number`
 * from `associatedPullRequests` (see `pickAssociatedPrNumber`), so this only walks the two hops
 * needed to turn it into a local PR id.
 *
 * ⚠ BOTH maps key on `(repoId, X)`, never on a bare sha or number. A PR number is unique only
 * WITHIN a repo, and the `inArray × inArray` shape deliberately over-matches (it is the portable
 * one) — the composite key is what discards the cross-repo pairs it returns. `db/branch-queries.ts`
 * documents the same trap; there is a seeded test pinning it there.
 *
 * A MISS IS ORDINARY, NOT AN ERROR, and the caller degrades to a PR-less card rather than
 * guessing: a direct push to trunk has no PR at all; `pr_number` is null until the snapshot
 * observes the association; the two logs are trimmed on DIFFERENT schedules (`branch_commits` =
 * newest-100 ∪ within-90d, `trunk_ci_status_events` = newest-200 ∪ within the 14-day feed window),
 * so an old sha can outlive its commit row; and the landing PR may simply not be synced here.
 */
interface TrunkLandingPr {
  id: number;
  number: number;
  title: string;
  state: PrState;
  /** Who merged it. This is the WHOLE of the ci_failing trunk card's attribution, and it
   *  attributes LANDING, never BREAKING — trunk may well have been red before this PR merged
   *  (see the ci_failing block in getWorkspaceInsights for why we do not try to say more). */
  mergedById: number | null;
}

async function resolveTrunkCommitPrs(
  accountId: number,
  pairs: { repoId: number; sha: string }[],
): Promise<Map<string, TrunkLandingPr>> {
  const out = new Map<string, TrunkLandingPr>();
  if (pairs.length === 0) return out;
  const repoIds = [...new Set(pairs.map((p) => p.repoId))];
  const shas = [...new Set(pairs.map((p) => p.sha))];
  const wanted = new Set(pairs.map((p) => `${p.repoId}:${p.sha}`));

  // Covered by the (accountId, repoId, sha) unique.
  const commitRows = await db
    .select({
      repoId: branchCommits.repoId,
      sha: branchCommits.sha,
      prNumber: branchCommits.prNumber,
    })
    .from(branchCommits)
    .where(
      and(
        eq(branchCommits.accountId, accountId),
        inArray(branchCommits.repoId, repoIds),
        inArray(branchCommits.sha, shas),
      ),
    )
    .execute();

  const landed = commitRows.filter(
    (c): c is typeof c & { prNumber: number } =>
      c.prNumber != null && wanted.has(`${c.repoId}:${c.sha}`),
  );
  if (landed.length === 0) return out;

  const prRows = await db
    .select({
      id: pullRequests.id,
      repoId: pullRequests.repoId,
      number: pullRequests.number,
      title: pullRequests.title,
      state: pullRequests.state,
      // Selected HERE rather than re-queried by a caller: this is already the one hop from a
      // trunk sha to its PR row. The feed-item caller simply ignores the extra column.
      mergedById: pullRequests.mergedById,
    })
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.accountId, accountId),
        inArray(pullRequests.repoId, repoIds),
        inArray(pullRequests.number, [...new Set(landed.map((c) => c.prNumber))]),
      ),
    )
    .execute();
  const prByRepoNumber = new Map(prRows.map((p) => [`${p.repoId}:${p.number}`, p]));

  for (const c of landed) {
    const pr = prByRepoNumber.get(`${c.repoId}:${c.prNumber}`);
    if (pr != null)
      out.set(`${c.repoId}:${c.sha}`, {
        id: pr.id,
        number: pr.number,
        title: pr.title,
        state: pr.state as PrState,
        mergedById: pr.mergedById,
      });
  }
  return out;
}

/**
 * Default-branch CI failures, from the `trunk_ci_status_events` transition log.
 *
 * The failure is a fact about TRUNK, but the commit it broke on was usually put there by a PR —
 * so each card carries the landing PR (`resolveTrunkCommitPrs`) when the sha resolves to one,
 * giving the SPA something to open. `githubUrl` stays the COMMIT, not the PR: a trunk run's
 * checks live on the commit page, and the card keeps that link either way.
 *
 * ⚠ A resolved `prId` no longer keeps these rows out of the My-Turn lane — the kind-based
 * `isCiFeedKind` guard in getConsolidatedFeed is now the ONLY thing that does, and it must stay.
 * A CI row is actor-less, so `enrichMyTurn` would flag every red trunk build on a PR you touched
 * as an UNCAPPED yellow card. Still skipped entirely under single-PR isolation — trunk is not a
 * PR's history, even when a PR landed the commit.
 */
async function getTrunkCiFailureFeedItems(
  accountId: number,
  repoIds: number[],
  since: Date,
): Promise<ConsolidatedFeedItem[]> {
  if (repoIds.length === 0) return [];
  const rows = await db
    .select({
      repoId: trunkCiStatusEvents.repoId,
      branchName: trunkCiStatusEvents.branchName,
      headSha: trunkCiStatusEvents.headSha,
      status: trunkCiStatusEvents.status,
      failingChecks: trunkCiStatusEvents.failingChecks,
      observedAt: trunkCiStatusEvents.observedAt,
      owner: repos.owner,
      name: repos.name,
    })
    .from(trunkCiStatusEvents)
    .innerJoin(repos, eq(repos.id, trunkCiStatusEvents.repoId))
    .where(
      and(
        eq(trunkCiStatusEvents.accountId, accountId),
        inArray(trunkCiStatusEvents.repoId, repoIds),
        inArray(trunkCiStatusEvents.status, ['failure', 'error']),
        gte(trunkCiStatusEvents.observedAt, since),
      ),
    )
    .orderBy(desc(trunkCiStatusEvents.observedAt))
    .limit(CI_EVENT_SCAN_CAP)
    .execute();

  // One lookup for the whole scan's shas, BEFORE the collapse — which emits up to 5 cards per
  // head, so resolving inside the emit would repeat the same two queries per card.
  const prByCommit = await resolveTrunkCommitPrs(
    accountId,
    rows.map((r) => ({ repoId: r.repoId, sha: r.headSha })),
  );

  return collapseCiRows(
    rows,
    (r) => `${r.repoId} ${r.headSha}`,
    (r) => (r.failingChecks ?? []).map((c) => c.name),
    (r, checkName, moreFailing) => {
      // The PR that landed this commit, when we can name it — often absent (a direct push, an
      // association not observed yet, a PR not tracked here), and the card reads fine without it.
      const pr = prByCommit.get(`${r.repoId}:${r.headSha}`);
      return ciFeedItem({
        id: `feed:trunkci:${r.repoId}:${r.headSha}:${checkName ?? ''}`,
        kind: 'trunk_ci_failed',
        occurredAt: r.observedAt,
        repoId: r.repoId,
        repoFullName: `${r.owner}/${r.name}`,
        prId: pr?.id ?? null,
        prNumber: pr?.number ?? null,
        prTitle: pr?.title ?? null,
        prState: pr?.state ?? null,
        status: r.status as CiStatus,
        headSha: r.headSha,
        checkName,
        moreFailing,
        // The COMMIT, not the PR, even when one resolved: a trunk run's checks live on the
        // commit page, and the failure is a fact about trunk. The landing PR is reachable from
        // the card's own PR reference. Rendered through safeExternalUrl client-side.
        githubUrl: `https://github.com/${r.owner}/${r.name}/commit/${r.headSha}`,
        where: r.branchName ?? 'trunk',
      });
    },
  );
}

// ---- Activity-Feed "seen" marker (server-side, per account) ----

// The account's last feed-view timestamp (null until the first view).
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

// ---- Workspace review-intelligence "Insights" (Pro; workspaceInsights) ----

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
// `my_turn` gets its OWN, much larger cap. Every other kind is a SURVEY of the workspace, where 15
// is a digestible sample of a long tail; my_turn is the viewer's actual inbox, where a cap is a
// LIE — the daily brief reports the number of cards emitted, so capping at 15 would silently
// restate "you have 54 things" as "you have 15". 50 keeps the board bounded while sitting above
// any realistic personal inbox; the tail beyond it is disclosed by /api/my-turn's own listing.
const MY_TURN_CARD_CAP = 50;

/**
 * IS THIS BUILD RED? — and RED IS ALWAYS THE PAIR `failure` | `error`, never one of them.
 *
 * GitHub reports an infrastructure/permissions problem as `error` and a genuine check failure as
 * `failure`, and every layer of this app that asks "is it red" has to accept both: db/triage.ts's
 * reason tags, getWorkspaceMetricsDetail's own local `isRed`, and the SPA's lib/ui.ts. A fold that
 * tested only 'failure' would silently drop every errored build — which is the half that most
 * often needs a human.
 */
const RED_CI_STATUSES = ['failure', 'error'] as const;
function isRedCiStatus(ci: CiStatus | null): boolean {
  return (RED_CI_STATUSES as readonly string[]).includes(ci ?? '');
}

/** "just now" / "42m ago" / "6h ago" / "3d ago" — the my_turn card's one-line detail suffix. */
function agoLabel(fromMs: number, nowMs: number): string {
  const secs = Math.max(0, Math.floor((nowMs - fromMs) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function topLevelDir(path: string): string {
  const i = path.indexOf('/');
  return i === -1 ? '.' : path.slice(0, i);
}

const WORKSPACE_METRICS_WINDOW_DAYS = 84; // 12 weeks of weekly chart history
const WORKSPACE_METRICS_WEEK_MS = 7 * 86_400_000;
// A cur-vs-prev stat comparison needs at least this many items on BOTH sides to be worth a
// trend read. Below it (typical early in a sprint — often a single carryover PR) the stat is
// flagged low-confidence: the tile drops the delta arrow and the AI report states the raw "so
// far" figure without a percentage / "cliff" / "spike". This is what stops a day-1 report from
// claiming "merges collapsed 99%" off a 1-vs-N sample.
const WORKSPACE_METRIC_MIN_SAMPLE = 3;

// The comparison window handed in by the Pro layer (getComparisonWindow). fromMs/toMs drive the
// cur/prev math; `mode` is passed straight through onto WorkspaceMetrics.comparisonMode so the UI + AI
// report label value/previous correctly. A rolling_N window has toMs === now (elapsed === full →
// "previous" is the immediately-preceding N days); a sprint window has toMs in the future.
type MetricsWindow = { fromMs: number; toMs: number; mode?: SprintComparisonMode };

function medianOf(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

// Workspace-wide DORA-ish flow metrics across the scoped repos (NO AI). Best-effort DORA
// mapping from synced PR/CI data: deploy frequency = merges; lead time = open→merge;
// change-failure (inverted) = merged-PR CI success; time-to-restore is a PROXY off the
// current snapshot (open PRs red on CI + how long they've sat) since no CI-state history
// is stored. The weekly CHART series are ALWAYS a fixed 12 weeks ending now (independent of
// any sprint window); the stat TILES compare THIS sprint to the immediately-preceding
// equal-length one, aligned to the configured sprint `window` (default trailing 14d). The
// DB fetch spans max(12 weeks, both sprints) so the "previous" tiles aren't starved. Weekly
// series (aligned to `weekBuckets`) feed the same chart toolkit the per-repo analytics use.
export async function getWorkspaceMetrics(
  accountId: number,
  repoIds: number[],
  nowMs: number,
  // The comparison window (epoch millis) + mode for the stat TILES: THIS window's elapsed slice vs
  // the SAME slice of the immediately-preceding one. Undefined → the legacy trailing-14d default.
  // The CHART window is a fixed 12 weeks regardless.
  window?: MetricsWindow,
): Promise<WorkspaceMetrics | null> {
  if (repoIds.length === 0) return null;

  // Charts: a fixed 12-week window ending now, INDEPENDENT of the sprint window.
  const chartWindowStartMs = nowMs - WORKSPACE_METRICS_WINDOW_DAYS * 86_400_000;

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
      id: pullRequests.id,
      state: pullRequests.state,
      isDraft: pullRequests.isDraft,
      openedAt: pullRequests.openedAt,
      firstReviewAt: pullRequests.firstReviewAt,
      firstReviewRequestedAt: pullRequests.firstReviewRequestedAt,
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

  const nBuckets = Math.max(1, Math.round((nowMs - chartWindowStartMs) / WORKSPACE_METRICS_WEEK_MS));
  const weekBuckets: string[] = [];
  for (let i = 0; i < nBuckets; i++)
    weekBuckets.push(new Date(chartWindowStartMs + i * WORKSPACE_METRICS_WEEK_MS).toISOString());
  const bi = (ms: number): number =>
    Math.max(
      0,
      Math.min(nBuckets - 1, Math.floor((ms - chartWindowStartMs) / WORKSPACE_METRICS_WEEK_MS)),
    );
  const zeros = (): number[] => new Array<number>(nBuckets).fill(0);

  const openedSeries = zeros();
  const mergedSeries = zeros();
  const leadByBucket: number[][] = Array.from({ length: nBuckets }, () => []);
  const ciByBucket = Array.from({ length: nBuckets }, () => ({ succ: 0, total: 0 }));
  // Review pickup latency (request → first review), median by first-review week — a clean
  // responsiveness signal that (unlike TTFR-from-open) only exists for PRs with a request event,
  // so it doesn't distort as coverage grows. Empty until syncs backfill firstReviewRequestedAt.
  const pickupByBucket: number[][] = Array.from({ length: nBuckets }, () => []);

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
  // Review-load: merged-PR id → its merge-week bucket (only PRs merged inside the chart window).
  // The per-bucket merge count reuses mergedSeries as the denominator. mergedPrFirstReview carries
  // each merged PR's first-review time (or null) for the Phase-2 rework-ratio series.
  const mergedPrBucket = new Map<number, number>();
  const mergedPrFirstReview = new Map<number, number | null>();

  for (const p of prs) {
    const openedMs = p.openedAt.getTime();
    if (openedMs >= chartWindowStartMs) openedSeries[bi(openedMs)]! += 1;
    if (p.state === 'open' && !p.isDraft) openPrsNow += 1;

    if (p.firstReviewAt != null) {
      const firstReviewMs = p.firstReviewAt.getTime();
      const ttfr = (firstReviewMs - openedMs) / 3_600_000;
      if (ttfr >= 0) {
        if (inWin(openedMs, curLo, curHi)) ttfrCur.push(ttfr);
        else if (inWin(openedMs, prevLo, prevHi)) ttfrPrev.push(ttfr);
      }
      // Review pickup: request → first review, bucketed by the first-review week.
      if (p.firstReviewRequestedAt != null && firstReviewMs >= chartWindowStartMs) {
        const pickup = (firstReviewMs - p.firstReviewRequestedAt.getTime()) / 3_600_000;
        if (pickup >= 0) pickupByBucket[bi(firstReviewMs)]!.push(pickup);
      }
    }

    if (p.state === 'merged' && p.mergedAt != null) {
      const mergedMs = p.mergedAt.getTime();
      if (mergedMs >= chartWindowStartMs) {
        mergedSeries[bi(mergedMs)]! += 1;
        mergedPrBucket.set(p.id, bi(mergedMs));
        mergedPrFirstReview.set(p.id, p.firstReviewAt != null ? p.firstReviewAt.getTime() : null);
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

  // ---- Review load per merged PR (human vs bot), by merge week ----
  // Count review TOUCHES (reviews excl. pending + inline comments + issue comments) each merged
  // PR attracted, split by whether the author is a bot, bucketed into the PR's merge week; ÷ the
  // week's merge count (mergedSeries) → average review load per shipped PR. Same touch model as
  // the Bots behaviour panel, so the two surfaces read consistently. Gathered by PR id (not by
  // comment time), so pre-merge review on an old-but-recently-merged PR is fully counted.
  const humanLoadByBucket = zeros();
  const botLoadByBucket = zeros();
  // Phase-2 self-review depth, all keyed off the same merged-PR touch scan:
  const prHasHuman = new Set<number>(); // PR got ≥1 human review touch
  const prHasBot = new Set<number>(); // PR got ≥1 bot review touch
  const crPrs = new Set<number>(); // PR got a changes-requested review
  const mergedIds = [...mergedPrBucket.keys()];
  if (mergedIds.length > 0) {
    const addLoad = (prId: number | null, isBot: boolean): void => {
      if (prId == null) return;
      const b = mergedPrBucket.get(prId);
      if (b == null) return;
      if (isBot) {
        botLoadByBucket[b]! += 1;
        prHasBot.add(prId);
      } else {
        humanLoadByBucket[b]! += 1;
        prHasHuman.add(prId);
      }
    };
    for (const r of await db
      .select({ prId: reviews.prId, isBot: users.isBot, state: reviews.state })
      .from(reviews)
      .innerJoin(users, eq(users.id, reviews.authorId))
      .where(and(inArray(reviews.prId, mergedIds), ne(reviews.state, 'pending')))
      .execute()) {
      addLoad(r.prId, r.isBot);
      if (r.prId != null && r.state === 'changes_requested') crPrs.add(r.prId);
    }
    for (const r of await db
      .select({ prId: reviewComments.prId, isBot: users.isBot })
      .from(reviewComments)
      .innerJoin(users, eq(users.id, reviewComments.authorId))
      .where(inArray(reviewComments.prId, mergedIds))
      .execute())
      addLoad(r.prId, r.isBot);
    for (const r of await db
      .select({ prId: prComments.prId, isBot: users.isBot })
      .from(prComments)
      .innerJoin(users, eq(users.id, prComments.authorId))
      .where(inArray(prComments.prId, mergedIds))
      .execute())
      addLoad(r.prId, r.isBot);
  }
  const r2 = (x: number): number => Math.round(x * 100) / 100;
  const perMergedLoad = (n: number, i: number): number | null =>
    mergedSeries[i]! > 0 ? r2(n / mergedSeries[i]!) : null;
  const reviewLoad = {
    human: humanLoadByBucket.map(perMergedLoad),
    bot: botLoadByBucket.map(perMergedLoad),
  };

  // ---- Self-review depth (Phase 2), all by merge week ----
  // Changes-requested rate: % of merged PRs with a changes-requested review (falling = cleaner
  // first drafts). Coverage: each merged PR classified human-reviewed / bot-only / unreviewed.
  const crByBucket = zeros();
  const covHuman = zeros();
  const covBotOnly = zeros();
  const covUnreviewed = zeros();
  for (const [prId, bucket] of mergedPrBucket) {
    if (crPrs.has(prId)) crByBucket[bucket]! += 1;
    if (prHasHuman.has(prId)) covHuman[bucket]! += 1;
    else if (prHasBot.has(prId)) covBotOnly[bucket]! += 1;
    else covUnreviewed[bucket]! += 1;
  }
  const changesRequestedTrend = crByBucket.map((n, i) =>
    mergedSeries[i]! > 0 ? Math.round((n / mergedSeries[i]!) * 100) : null,
  );
  const reviewCoverage = { human: covHuman, botOnly: covBotOnly, unreviewed: covUnreviewed };

  // Rework ratio: for each REVIEWED merged PR, the share of its commits pushed AFTER first review
  // (churn once review started — a proxy for how "baked" it was on submission). Median across the
  // week's reviewed PRs. PRs never reviewed (no firstReviewAt) can't have post-review rework → out.
  const reworkByBucket: number[][] = Array.from({ length: nBuckets }, () => []);
  if (mergedIds.length > 0) {
    const prCommits = new Map<number, { total: number; after: number }>();
    for (const c of await db
      .select({ prId: commits.prId, at: commits.committedAt })
      .from(commits)
      .where(inArray(commits.prId, mergedIds))
      .execute()) {
      const firstReviewMs = mergedPrFirstReview.get(c.prId);
      if (firstReviewMs === undefined) continue; // not a chart-window merged PR
      const rec = prCommits.get(c.prId) ?? { total: 0, after: 0 };
      rec.total += 1;
      if (firstReviewMs != null && c.at.getTime() > firstReviewMs) rec.after += 1;
      prCommits.set(c.prId, rec);
    }
    for (const [prId, rec] of prCommits) {
      // Only PRs that were actually reviewed contribute a rework ratio.
      if (mergedPrFirstReview.get(prId) == null || rec.total === 0) continue;
      const bucket = mergedPrBucket.get(prId);
      if (bucket == null) continue;
      reworkByBucket[bucket]!.push(Math.round((rec.after / rec.total) * 100));
    }
  }
  const reworkTrend = reworkByBucket.map(medianOf);

  // ---- Thread resolution latency (human vs bot self-resolve), by resolution week ----
  // For threads we OBSERVED resolve (resolvedAt set — going forward only), median hours from the
  // thread opening (createdAt) to resolution, bucketed by the resolution week. Split by whether
  // the resolver login is a bot (self-resolve) vs a human (a dev addressed the feedback). Empty
  // until post-deploy syncs witness resolves; latency for a backfilled resolve is unknowable so
  // it's excluded (resolvedAt stays null). Buckets by resolvedAt week, like CI recovery.
  const resHumanByBucket: number[][] = Array.from({ length: nBuckets }, () => []);
  const resBotByBucket: number[][] = Array.from({ length: nBuckets }, () => []);
  for (const row of await db
    .select({
      createdAt: reviewThreads.createdAt,
      resolvedAt: reviewThreads.resolvedAt,
      isBot: users.isBot,
    })
    .from(reviewThreads)
    .innerJoin(pullRequests, eq(pullRequests.id, reviewThreads.prId))
    .leftJoin(users, eq(users.githubLogin, reviewThreads.resolvedByLogin))
    .where(
      and(
        eq(pullRequests.accountId, accountId),
        inArray(pullRequests.repoId, repoIds),
        isNotNull(reviewThreads.resolvedAt),
        gte(reviewThreads.resolvedAt, new Date(chartWindowStartMs)),
      ),
    )
    .execute()) {
    if (row.resolvedAt == null) continue;
    const hours = (row.resolvedAt.getTime() - row.createdAt.getTime()) / 3_600_000;
    if (hours < 0) continue;
    const bucket = bi(row.resolvedAt.getTime());
    (row.isBot === true ? resBotByBucket : resHumanByBucket)[bucket]!.push(hours);
  }
  const resolutionLatencyTrend = {
    human: resHumanByBucket.map(medianOf),
    bot: resBotByBucket.map(medianOf),
  };

  // Wrap each cur/prev pair with its sample sizes + a low-confidence flag (either side below
  // WORKSPACE_METRIC_MIN_SAMPLE). For counts the sample IS the value; for medians/percentages it's
  // the number of items that fed the statistic.
  const stat = (
    value: number | null,
    previous: number | null,
    curN: number,
    prevN: number,
  ): WorkspaceMetricStat => ({
    value,
    previous,
    sampleSize: curN,
    previousSampleSize: prevN,
    lowConfidence: curN < WORKSPACE_METRIC_MIN_SAMPLE || prevN < WORKSPACE_METRIC_MIN_SAMPLE,
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
    reviewLoad,
    changesRequestedTrend,
    reviewCoverage,
    reworkTrend,
    resolutionLatencyTrend,
    reviewPickupTrend: pickupByBucket.map(medianOf),
    ciFailureReasons,
  };
}

// CORE/free wrapper around getWorkspaceMetrics: narrows the workspace's repos to the ones this
// account really owns, then computes the flow-metric header. Lets the core
// /api/workspace-metrics route serve the Feed's now-free metrics (moved out of the Pro Insights
// pane) without the Pro insights bundle.
//
// ⚠ `repoIds` IS REQUIRED AND CONCRETE — no `null` "means every repo" fallback. `[]` is a
// legal, explicitly-supported state (an empty workspace) and returns null; a nullable parameter
// here would silently widen an empty workspace to every repo the account has added, which is the
// exact opposite of what the caller asked for.
export async function getWorkspaceMetricsForScope(
  accountId: number,
  repoIds: number[],
): Promise<WorkspaceMetrics | null> {
  if (repoIds.length === 0) return null;
  const owned = await db
    .select({ id: repos.id })
    .from(repos)
    .where(and(eq(repos.accountId, accountId), inArray(repos.id, repoIds)))
    .execute();
  return getWorkspaceMetrics(
    accountId,
    owned.map((r) => r.id),
    Date.now(),
    undefined,
  );
}

// Per-list safety cap for the drill-down. Deliberately GENEROUS: the lists are already
// bounded (the 2-week sprint window for merges / review-latency / recovery; the open-PR
// backlog for lead-time / red-now), so 500 shows every entry for any realistic sprint —
// it's a guard against a pathological payload, not a display limit (a low cap like 100
// looked like a rounded "real" count in the tab badges).
const METRIC_DETAIL_CAP = 500;

// The per-metric PR lists behind the 6 flow-metric tiles (the drill-down). A heavier,
// on-demand read than getWorkspaceMetrics — loaded only when a tile is clicked — over the
// workspace's repos + the current sprint. Returns the PRs behind each tile with the
// metric-specific figures, so the user can see WHERE issues cluster.
export async function getWorkspaceMetricsDetail(
  accountId: number,
  // The comparison window (epoch millis); undefined → legacy default lookback. The lower bound
  // uses window.fromMs; `now` remains the upper bound. `mode` is unused here (a current-window PR
  // list, no cur/prev split) but accepted so callers pass the same object as getWorkspaceMetrics.
  window: MetricsWindow | undefined,
  // The workspace's repos. REQUIRED and CONCRETE: `[]` is a legal state (an empty workspace) and
  // yields the empty result. There is no null "means every repo" fallback — see
  // getWorkspaceMetricsForScope for why that widening is the bug this parameter shape prevents.
  repoIds: number[],
): Promise<WorkspaceMetricsDetail> {
  const now = Date.now();
  const sprintFromMs = window?.fromMs ?? now - INSIGHT_SPRINT_DAYS * 86_400_000;
  const sprintFrom = new Date(sprintFromMs);
  const sprint = {
    from: sprintFrom.toISOString(),
    to: new Date(window?.toMs ?? now).toISOString(),
  };
  const empty: WorkspaceMetricsDetail = {
    sprint,
    merges: [],
    leadTime: [],
    reviewLatency: [],
    mergeCi: [],
    ciRecovery: [],
    ciRed: [],
    users: [],
  };

  // An empty workspace short-circuits (also dodges the empty-array inArray pitfall below).
  if (repoIds.length === 0) return empty;
  const scoped = await db
    .select({ id: repos.id, owner: repos.owner, name: repos.name })
    .from(repos)
    .where(and(eq(repos.accountId, accountId), inArray(repos.id, repoIds)))
    .execute();
  const scopedRepoIds = scoped.map((r) => r.id);
  if (scopedRepoIds.length === 0) return empty;
  const repoName = new Map(scoped.map((r) => [r.id, `${r.owner}/${r.name}`]));
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
        inArray(ciStatusEvents.repoId, scopedRepoIds),
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
      updatedAt: pullRequests.updatedAt,
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
        inArray(pullRequests.repoId, scopedRepoIds),
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
      updatedAt: p.updatedAt.toISOString(),
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

  // (There is deliberately NO open-PRs list here: the "Open PRs" tile routes to the open-PRs
  // drill-down over /api/open-prs — uncapped TimelinePr rows, drafts included — not a sub-tab.)

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
    merges,
    leadTime,
    reviewLatency,
    mergeCi,
    ciRecovery,
    ciRed,
    users: userRows.map(mapUser),
  };
}

// Compute the workspace review-intelligence cards from already-synced data — NO AI. The
// workspace's repos are the scope; "sprint" is the trailing 2 weeks. Runs on read (the client
// refetches on the sync cadence); every query is account-scoped + bounded (the workspace's repos,
// open PRs, the sprint window, per-kind caps).
//
// It takes a full `BotScope` rather than a repo list because its `bot_signal` and
// `bot_only_review` cards need the WORKSPACE to know who counts as an automated reviewer;
// `scope.repoIds` only narrows the data.
export async function getWorkspaceInsights(
  accountId: number,
  window: MetricsWindow | undefined,
  scope: BotScope,
): Promise<WorkspaceInsightsResponse> {
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
  // The my_turn fold's PRE-CAP length — the disclosure that keeps MY_TURN_CARD_CAP from reading
  // as "that's everything". Written once, inside the my_turn block below (so an empty workspace
  // leaves it undefined = nothing to disclose); the CARDS remain the figure every surface shows.
  let myTurnTotal: number | undefined;
  // The same pre-cap array, folded a second time over `MyTurnCard.personal` — the denominator
  // the NOTIFICATION surfaces need. ⚠ It has to be its own total: pairing a narrow count with
  // `myTurnTotal` mixes two populations in one row, and the cap disclosure only fires when the
  // displayed figure equals the count it qualifies, so a narrow line borrowing the broad total
  // silently loses its "of N" for ever.
  let myTurnPersonalTotal: number | undefined;
  // The same pre-cap array, folded a third/fourth/fifth time — one total per `MyTurnRelevance`
  // value, because the brief renders the split as SEPARATE lines and each of them opens its own
  // board. ⚠ NONE of these may be a subtraction off the two totals above: `capFor` only prints
  // "of N" when the displayed figure equals the count it is qualifying, so a line whose
  // denominator came from another population loses its cap disclosure silently, on exactly the
  // workspaces where it matters. Every displayed count folds its own total, from this one array.
  let myTurnDirectTotal: number | undefined;
  let myTurnMaintainedTotal: number | undefined;
  let myTurnOtherTotal: number | undefined;
  // The `ci_failing` fold's PRE-CAP length, on the same rule as `myTurnTotal`: that kind shares
  // INSIGHT_CARD_CAP (15) with the SURVEY kinds, which stay silent about their cap because 15 is
  // a fair sample of a long tail — but "N red builds are yours" is a worklist the viewer clears,
  // where a silent cap is the same lie my_turn's was. Written inside the block below, so an empty
  // workspace leaves it undefined = nothing to disclose.
  let ciFailingTotal: number | undefined;
  const userIdSet = new Set<number>();
  const addUser = (id: number | null): void => {
    if (id != null) userIdSet.add(id);
  };

  const scopedRepos =
    scope.repoIds.length === 0
      ? [] // an empty workspace → no repos (also dodges the empty-array inArray pitfall)
      : await db
          .select({ id: repos.id, owner: repos.owner, name: repos.name })
          .from(repos)
          .where(and(eq(repos.accountId, accountId), inArray(repos.id, scope.repoIds)))
          .execute();
  const repoName = new Map(scopedRepos.map((r) => [r.id, `${r.owner}/${r.name}`]));
  const repoIds = scopedRepos.map((r) => r.id);

  const ghUrl = (repoId: number, number: number): string =>
    `https://github.com/${repoName.get(repoId)}/pull/${number}`;

  // THE ONE BUILDER OF AN `InsightPrRef`. Every PR-bearing card kind (stalled_review,
  // untouched_thread, reviewer_routing, my_turn) fills its shared PR context through this, so a
  // new kind cannot quietly invent a different shape — or a different null policy — for the same
  // eleven fields. `openedAt`/`additions`/`deletions`/`changedFiles` are NOT NULL columns;
  // `ciStatus` is the only genuinely nullable one (null = no checks) and stays null.
  const prRef = (p: {
    id: number;
    repoId: number;
    number: number;
    title: string;
    authorId: number | null;
    openedAt: Date;
    ciStatus: CiStatus | null;
    changedFiles: number;
    additions: number;
    deletions: number;
  }): InsightPrRef => ({
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
    openedAt: p.openedAt.toISOString(),
  });

  const finish = async (): Promise<WorkspaceInsightsResponse> => {
    const kindRank: Record<InsightKind, number> = {
      // my_turn leads every severity tier: it is the ONLY kind that is about the VIEWER
      // personally ("someone is waiting on you"), where every other kind is a survey of the
      // workspace. A thing you must do outranks a thing you might look at.
      my_turn: 0,
      // The OTHER kind that is about the VIEWER rather than the workspace — a red build you are on
      // the hook for. It sits directly under my_turn for the same reason my_turn leads: a thing
      // you must do outranks a thing you might look at.
      ci_failing: 1,
      bot_signal: 2, // the flagship "layer above your review bot" summary, next in its severity tier
      bot_only_review: 3, // the governance "only a bot reviewed this" risk, right after
      stalled_review: 4,
      untouched_thread: 5,
      reviewer_load: 6,
      reviewer_routing: 7,
    };
    const sevRank: Record<InsightSeverity, number> = { high: 0, warn: 1, info: 2 };
    cards.sort(
      (a, b) => sevRank[a.severity] - sevRank[b.severity] || kindRank[a.kind] - kindRank[b.kind],
    );
    const userRows =
      userIdSet.size > 0
        ? await db.select().from(users).where(inArray(users.id, [...userIdSet])).execute()
        : [];
    const metrics = await getWorkspaceMetrics(accountId, repoIds, now, window);
    return {
      enabled: true,
      generatedAt: generatedAt.toISOString(),
      sprint,
      metrics,
      cards,
      users: userRows.map(mapUser),
      // The cap disclosure (see the field's doc). `finish()` is also the empty-workspace early
      // return below, where the my_turn block never ran and this is correctly undefined.
      myTurnTotal,
      myTurnPersonalTotal,
      myTurnDirectTotal,
      myTurnMaintainedTotal,
      myTurnOtherTotal,
      ciFailingTotal,
    };
  };
  if (repoIds.length === 0) return finish();

  // ── my_turn cards (CORE, deterministic, no AI) ─────────────────────────────
  // The VIEWER'S OWN inbox, promoted from an uncountable Feed facet to first-class cards.
  //
  // ⚠ This is NOT a re-derivation. It calls the SAME `getMyTurn` fold that `GET /api/my-turn`
  // serves — passing the workspace scope — and emits one card per row of its six sections. The
  // daily brief then counts the cards emitted here, so the strip's number and the list the user
  // lands on are the same object by construction. (The count used to come from the consolidated
  // feed's `counts.myTurn`: a tally of EVENTS in a rolling 14 days, which corresponded to no
  // clickable list at all — "54 items" the user could not open.)
  //
  // Computed HERE, before the open-PR guard below, for the same reason the two bot cards are: a
  // thread awaiting your reply, or a finished Claude review, can sit on a PR that guard drops
  // (drafts, ultra-stale) — and dropping it would understate the brief's number.
  {
    const mt = await getMyTurn(accountId, scope);
    const loginById = new Map(mt.users.map((u) => [u.id, u.githubLogin]));
    const handle = (id: number | null): string =>
      id != null ? `@${loginById.get(id) ?? `user${id}`}` : 'someone';

    // Everything a card needs that is NOT in the shared InsightPrRef. `since` stays a Date until
    // the sort is done (the cards' wire field is ISO), and is NULL when the section row carries no
    // usable timestamp of its own — `sinceFor` then dates the card off the PR row.
    type Seed = {
      reason: MyTurnCardReason;
      dismissRefId: number | null;
      threadId: number | null;
      severity: InsightSeverity;
      detail: string;
      since: Date | null;
      prId: number;
      /** `MyTurnCard.relevance` — read off the section row, never re-derived (see `relevanceOf`).
       *  The card's `personal` is FOLDED from this one field, so the two cannot drift. */
      relevance: MyTurnRelevance;
      /** actors to resolve for the client beyond the PR author (prRef's authorId) */
      extraActorIds: (number | null)[];
    };
    const seeds: Seed[] = [];

    // THE CLOCK, READ NOT RE-DERIVED. Every PR-shaped section dates itself on the wire
    // (`MyTurnPr.since` — review requested / last update / newest approval / opened), resolved
    // once inside `getMyTurn`. Reading it here is what keeps a card and the browser notification
    // built off the same fold from disagreeing about when an item landed — and it is why this
    // block no longer runs its own `computeApprovalInfoByPr` for the approval timestamp.
    // `openedAt` remains the floor for a row that predates the field.
    const sinceOf = (i: MyTurnPr): Date | null =>
      i.since != null ? new Date(Date.parse(i.since)) : null;

    // THE RELEVANCE ANSWER, READ NOT RE-DERIVED — the `sinceOf` rule applied to the second thing
    // this block would otherwise answer for a second time. `getMyTurn` owns the relevance rule
    // AND the maintainer/mention sets it needs (one repo/merger/mention read per fold); re-running
    // it here would cost a second batch of queries and could disagree with the wire the very same
    // request serves.
    //
    // Absent ⇒ fall back to the older boolean: `true` ⇒ 'direct', `false` ⇒ 'none'. A row that
    // carries no `relevance` cannot be told apart from 'maintained', and it never has to be —
    // only "New PRs" is ever that value and that section always sets the field. Over-notifying
    // remains the safe direction for a row we can't classify.
    const relevanceOf = (i: {
      relevance?: MyTurnRelevance;
      personal?: boolean;
    }): MyTurnRelevance => i.relevance ?? ((i.personal ?? true) ? 'direct' : 'none');

    for (const i of mt.awaitingReview) {
      seeds.push({
        reason: 'review_request',
        dismissRefId: i.prId,
        threadId: null,
        severity: 'high',
        detail:
          i.alsoRequested > 0
            ? `Review requested from you · ${i.alsoRequested} other reviewer${i.alsoRequested === 1 ? '' : 's'} also requested`
            : 'Review requested from you',
        since: sinceOf(i),
        prId: i.prId,
        relevance: relevanceOf(i),
        extraActorIds: [],
      });
    }
    for (const i of mt.threadsAwaiting) {
      const at = new Date(Date.parse(i.lastReplyAt));
      seeds.push({
        reason: 'thread',
        dismissRefId: i.threadId,
        threadId: i.threadId,
        severity: 'high',
        detail: `${handle(i.lastReplyAuthorId)} replied ${agoLabel(at.getTime(), now)}`,
        since: at,
        prId: i.prId,
        relevance: relevanceOf(i),
        extraActorIds: [i.lastReplyAuthorId],
      });
    }
    for (const i of mt.approvedPrs) {
      const at = sinceOf(i) ?? new Date(Date.parse(i.openedAt));
      const conflicts = i.mergeable === 'conflicting' ? ' · conflicts' : '';
      seeds.push({
        reason: 'pr_approved',
        dismissRefId: i.prId,
        threadId: null,
        severity: 'warn',
        detail: `Approved by ${i.approvals} reviewer${i.approvals === 1 ? '' : 's'} · ${agoLabel(at.getTime(), now)}${conflicts}`,
        since: at,
        prId: i.prId,
        relevance: relevanceOf(i),
        extraActorIds: [],
      });
    }
    for (const i of mt.yourPrs) {
      seeds.push({
        reason: 'your_pr',
        // 'your_pr' is the ONE section with no dismissal kind — opening the PR clears it
        // (the pr_views marker), so there is no my_turn_dismissals row to reference.
        dismissRefId: null,
        threadId: null,
        severity: 'warn',
        detail: i.summary,
        since: sinceOf(i),
        prId: i.prId,
        relevance: relevanceOf(i),
        extraActorIds: [],
      });
    }
    for (const i of mt.watchedRepoPrs) {
      const at = sinceOf(i) ?? new Date(Date.parse(i.openedAt));
      seeds.push({
        reason: 'watched_repo_pr',
        dismissRefId: i.prId,
        threadId: null,
        severity: 'info',
        detail: `New PR from ${handle(i.authorId)} · ${agoLabel(at.getTime(), now)}`,
        since: at,
        prId: i.prId,
        // The ONE section that is ever anything but 'direct': 'maintained' when it is a repo the
        // viewer has write on or has landed a PR into, 'none' for a stranger's PR in a repo they
        // merely track. (A mention on it makes it 'direct' again, even in a read-only repo.)
        relevance: relevanceOf(i),
        extraActorIds: [i.authorId],
      });
    }
    for (const i of mt.claudeReviewsToAction) {
      seeds.push({
        reason: 'claude_review',
        dismissRefId: i.reviewId,
        threadId: null,
        severity: 'warn',
        detail: `Claude review ready${i.verdict ? ` · ${i.verdict}` : ''}${i.headStale ? ' · head moved since' : ''}`,
        // finishedAt is nullable on the wire; null falls back to the PR row's openedAt.
        since: i.finishedAt != null ? new Date(Date.parse(i.finishedAt)) : null,
        prId: i.prId,
        relevance: relevanceOf(i),
        extraActorIds: [],
      });
    }

    if (seeds.length > 0) {
      // The PR context (repoId / CI / diff size) the sections don't carry. These PRs are already
      // inside `scope.repoIds` — getMyTurn was passed the scope — so this select is the account
      // guard, not the scope one.
      const seedPrIds = [...new Set(seeds.map((s) => s.prId))];
      const prRows = await db
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
        })
        .from(pullRequests)
        .where(
          and(eq(pullRequests.accountId, accountId), inArray(pullRequests.id, seedPrIds)),
        )
        .execute();
      const prRowById = new Map(prRows.map((p) => [p.id, p]));

      // Every seed already carries its own clock (`sinceOf` above, or the thread/run timestamp);
      // openedAt is only the floor for a row that carries none. The per-reason resolution that
      // used to live HERE — review_request off `firstReviewRequestedAt`, your_pr off `updatedAt` —
      // moved upstream into `getMyTurn`, so the wire, the card and the notification all read ONE
      // derivation of "when did this happen".
      const sinceFor = (s: Seed, p: (typeof prRows)[number]): Date => s.since ?? p.openedAt;

      const sevRank: Record<InsightSeverity, number> = { high: 0, warn: 1, info: 2 };
      const ranked = seeds
        .flatMap((s) => {
          const p = prRowById.get(s.prId);
          // A PR the account doesn't own can't reach here; a missing row means the PR was
          // deleted between the two reads. Drop the card rather than render a hollow one.
          return p ? [{ s, p, since: sinceFor(s, p) }] : [];
        })
        .sort(
          (a, b) =>
            sevRank[a.s.severity] - sevRank[b.s.severity] ||
            b.since.getTime() - a.since.getTime(),
        );
      // ⚠ THE CAP IS DISCLOSED, NOT HIDDEN. `ranked.length` is the population this board would
      // paint uncapped — on a real workspace 148 against a cap of 50 — and it travels as
      // `myTurnTotal` so the header can say "50 of 148". It is deliberately measured AFTER the
      // deleted-PR drop above: the disclosure must name what the user could actually open, not
      // a seed count that includes rows we refused to render. Raising or removing the cap is NOT
      // the fix (50 is already the edge of what this board should paint), and neither is
      // reporting 148 where the list holds 50 — that is the "number with no list behind it" bug
      // this whole surface exists to end.
      myTurnTotal = ranked.length;
      // ⚠ FOLDED OFF THE PRE-CAP ARRAY, for the same reason `myTurnTotal` is. Counted after the
      // slice it would be bounded by 50 and would stop being a total; counted here it is the real
      // "how many of these are actually about you" population the notification surfaces need.
      myTurnPersonalTotal = ranked.filter((r) => r.s.relevance !== 'none').length;
      // The three-way split of the same array, in the same pass and under the same pre-cap rule.
      // Mutually exclusive and exhaustive: direct + maintained + other === myTurnTotal, and
      // direct + maintained === myTurnPersonalTotal. Spelled out rather than subtracted — see the
      // declaration above for why a subtracted denominator is a silent defect, not a shortcut.
      myTurnDirectTotal = ranked.filter((r) => r.s.relevance === 'direct').length;
      myTurnMaintainedTotal = ranked.filter((r) => r.s.relevance === 'maintained').length;
      myTurnOtherTotal = ranked.filter((r) => r.s.relevance === 'none').length;
      const built = ranked.slice(0, MY_TURN_CARD_CAP);

      for (const { s, p, since } of built) {
        addUser(p.authorId);
        for (const id of s.extraActorIds) addUser(id);
        const card: MyTurnCard = {
          // `myturn:` keeps these distinct from the stalled:/thread:/load:/route: ids — in
          // particular a 'thread' reason and an untouched_thread card can name the SAME thread id.
          id: `myturn:${s.reason}:${s.dismissRefId ?? s.prId}`,
          kind: 'my_turn',
          severity: s.severity,
          ...prRef(p),
          reason: s.reason,
          dismissRefId: s.dismissRefId,
          threadId: s.threadId,
          detail: s.detail,
          since: since.toISOString(),
          // ⚠ FOLDED FROM `relevance`, never carried alongside it. One source of truth means the
          // board's label and the notification's count cannot disagree about the same card.
          personal: s.relevance !== 'none',
          relevance: s.relevance,
        };
        cards.push(card);
      }
    }
  }

  // ── bot_signal card (deterministic, no AI) ──────────────────────────────────
  // The un-copyable cross-repo, cross-bot "signal-to-noise" view: over the sprint window,
  // how many review threads each automated reviewer opened, what share a later commit acted
  // on, and how much untouched backlog is piling up. Computed here (BEFORE the open-PR guard)
  // so it counts bot threads on merged PRs too — "this sprint's" volume, not just open work.
  // Grouped by AutomatedReviewerKind (vendors AND in-house-classified reviewers).
  {
    // The judgement comes from `scope.workspaceId` — the workspace whose repos this card is
    // computed over, so the metric and the "is this login a bot here" answer cannot disagree.
    // `role: 'review'` — the bot_signal card is a REVIEW-bot signal-to-noise view; SonarQube
    // volume in it is exactly the noise the role exists to remove.
    const botIds = await automatedReviewerUserIds(accountId, scope.workspaceId, 'review');
    if (botIds.length > 0) {
      const kindMap = await classificationKindForUser(accountId, scope.workspaceId);
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
  // "Only a bot reviewed this" — PRs (merged, or open-and-mergeable) in the workspace's repos
  // whose ONLY reviews came from automated reviewers (incl. Pierre-verbatim) with no human
  // review. Computed here (BEFORE the open-PR guard) like bot_signal so merged PRs count. It
  // takes the same `scope` as the bot_signal card, so both cards judge by the same workspace.
  {
    const botOnly = await getBotOnlyReviewPrs(accountId, scope, {
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

  // Open, non-draft PRs in the workspace's repos that are NOT ultra-stale — i.e. have a real ACTIVITY
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
      // The ci_failing 'your_pr' arm's clock — the head commit the CI verdict is ABOUT. It is not
      // a "red since": there is no stored per-PR CI transition to read one from.
      lastCommitAt: pullRequests.lastCommitAt,
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

  // ── ci_failing cards (CORE, deterministic, no AI) ─────────────────────────────────
  // RED BUILDS THE VIEWER IS ON THE HOOK FOR. Two arms, and they are two different claims — the
  // same distinction the my_turn board draws between work that is YOURS and work that is merely in
  // YOUR REPOS:
  //   • 'your_pr' — an open, non-draft PR YOU AUTHORED whose head CI is red. Your code, your fix.
  //   • 'trunk'   — the default branch of a repo you MAINTAIN is red RIGHT NOW; the card names the
  //                 PR that landed the red head when the sha resolves to one.
  //
  // ⚠ IT SITS ABOVE THE `openPrIds.length === 0` GUARD BELOW, and must stay there. The trunk arm
  // needs no open PR at all, so under the guard a workspace whose repos are quiet (or newly added,
  // with no in-window activity event) would paint a green board over a red trunk.
  //
  // ⚠ TWO NEIGHBOURING QUESTIONS SOMEBODY WILL REACH FOR HERE. BOTH WERE MEASURED AND CUT:
  //   1. "PRs I MERGED whose CI is failing", off `pull_requests.ci_status` on merged rows. A merged
  //      PR is never re-walked (the repo walk orders by UPDATED_AT with a cutoff), so that column
  //      is FROZEN at the merge instant — all three such rows on the reporting account froze within
  //      20s of merging, 3-5 months ago. It answers "did this land red": a retro metric, which is
  //      exactly what the merge-CI tile is for, not an inbox item.
  //   2. "the commit that TURNED trunk red". Real data defeats streak-start detection: trunk CI is
  //      non-monotone, 21% of `branch_commits` rows carry ciStatus 'unknown', and a chronically-red
  //      repo has no streak start at all. Honest transition attribution needs a NEW append-only
  //      per-commit table plus a sync step to fill it, and it was judged not worth building (0 of
  //      96 red heads on the reporting account were the viewer's). So the card names the LANDING PR
  //      of the CURRENT head and claims nothing whatsoever about who broke the build.
  {
    const viewerId = await getAccountUserId(accountId);
    // Sorted and capped together, so the two arms compete on urgency rather than one arm always
    // winning the cap. `sortAt` is the card's own clock (see `observedAt`), 0 when it has none.
    const ciSeeds: { card: CiFailingCard; sortAt: number }[] = [];

    // ARM 1 — your own open PRs, red NOW. NO NEW QUERY: `openPrs` above already selects authorId
    // and ciStatus, and `pull_requests.ci_status` is NOT lean-gated (sync/upsert.ts writes it on
    // every walk; only `check_runs` is gated), so this is a fold over rows we already hold and it
    // hydrates nothing. It inherits that query's population on purpose — non-draft (a draft's red
    // CI is not yet a summons) and not ultra-stale (an abandoned PR is not an inbox item).
    if (viewerId != null) {
      for (const p of openPrs) {
        if (p.authorId !== viewerId || !isRedCiStatus(p.ciStatus)) continue;
        const at = p.lastCommitAt ?? p.openedAt;
        ciSeeds.push({
          sortAt: at.getTime(),
          card: {
            id: `cifail:pr:${p.id}`,
            kind: 'ci_failing',
            // Your own PR, red, open: the most actionable thing this board can hold.
            severity: 'high',
            arm: 'your_pr',
            repoId: p.repoId,
            repoFullName: repoName.get(p.repoId) ?? '',
            ciStatus: p.ciStatus as CiStatus,
            prId: p.id,
            prNumber: p.number,
            prTitle: p.title,
            headSha: null,
            mergedById: null,
            viewerMerged: false,
            detail: 'You opened this PR — its head commit is red',
            observedAt: at.toISOString(),
            githubUrl: ghUrl(p.repoId, p.number),
          },
        });
      }
    }

    // ARM 2 — trunk red NOW in a repo the viewer MAINTAINS. `repos.defaultBranchCiStatus` is the
    // live default-branch snapshot /api/branch-status reads; it is a CURRENT-STATE column, which is
    // what makes this an inbox item rather than history.
    const redTrunks =
      repoIds.length === 0
        ? []
        : await db
            .select({
              id: repos.id,
              branchName: repos.defaultBranchName,
              headSha: repos.defaultBranchHeadSha,
              ci: repos.defaultBranchCiStatus,
              observedAt: repos.defaultBranchUpdatedAt,
            })
            .from(repos)
            .where(
              and(
                eq(repos.accountId, accountId),
                inArray(repos.id, repoIds),
                // ⚠ THE SAME ONE SPELLING the row-level test uses, pushed into SQL rather than
                // re-typed as a literal pair here: a second copy is a second answer waiting to
                // drift, and the half that drifts is always 'error'. (A NULL status is not red —
                // a freshly added repo has no snapshot yet, and "unknown" is the honest answer.)
                inArray(repos.defaultBranchCiStatus, [...RED_CI_STATUSES]),
              ),
            )
            .execute();
    // The SAME maintainer set My Turn's relevance gate uses — "a repo you maintain" has to mean one
    // thing in this app, and that resolver is the union of GitHub's viewerPermission and "you have
    // landed a PR on its default branch". Skipped entirely when no trunk is red, because membership
    // is the only thing that could change the answer.
    const maintained =
      redTrunks.length > 0
        ? await viewerMaintainedRepoIds(accountId, viewerId)
        : new Set<number>();
    const myRedTrunks = redTrunks.filter((r) => maintained.has(r.id));
    // ONE lookup for every red head, before the loop — resolving inside it would repeat the same
    // two queries per repo.
    const landingPrs = await resolveTrunkCommitPrs(
      accountId,
      myRedTrunks.flatMap((r) => (r.headSha != null ? [{ repoId: r.id, sha: r.headSha }] : [])),
    );
    for (const r of myRedTrunks) {
      // ⚠ A MISS HERE IS ORDINARY, NOT A GAP. ~11% of red heads are DIRECT PUSHES to the default
      // branch (a legitimate steady state), and others simply have no association observed yet or
      // no synced PR. The card must still say trunk is red — it just does not name a PR.
      const landed = r.headSha != null ? landingPrs.get(`${r.id}:${r.headSha}`) : undefined;
      const viewerMerged = landed?.mergedById != null && landed.mergedById === viewerId;
      addUser(landed?.mergedById ?? null);
      const full = repoName.get(r.id) ?? '';
      const branch = r.branchName ?? 'trunk';
      const shortSha = r.headSha != null ? r.headSha.slice(0, 7) : null;
      ciSeeds.push({
        sortAt: r.observedAt?.getTime() ?? 0,
        card: {
          id: `cifail:trunk:${r.id}:${r.headSha ?? ''}`,
          kind: 'ci_failing',
          // You LANDED the commit that is sitting on a red trunk — still not proof you broke it
          // (see the block header), but the strongest claim this data supports. Everything else in
          // a repo you maintain is a 'warn': real, yours to care about, not necessarily yours to fix.
          severity: viewerMerged ? 'high' : 'warn',
          arm: 'trunk',
          repoId: r.id,
          repoFullName: full,
          ciStatus: r.ci as CiStatus,
          prId: landed?.id ?? null,
          prNumber: landed?.number ?? null,
          prTitle: landed?.title ?? null,
          headSha: r.headSha,
          mergedById: landed?.mergedById ?? null,
          viewerMerged,
          detail: `You maintain this repo — ${branch} is red${shortSha != null ? ` at ${shortSha}` : ''}${
            viewerMerged ? '; you merged the PR that landed this commit' : ''
          }`,
          // OUR observation time (when the branch snapshot last refreshed), not the commit's — the
          // wire type says so, because the two are different facts and only one is stored here.
          observedAt: r.observedAt?.toISOString() ?? null,
          // The COMMIT page, not the PR: a trunk run's checks live on the commit, the same rule the
          // trunk_ci_failed feed item follows. Falls back to the repo when we hold no head sha.
          githubUrl:
            r.headSha != null
              ? `https://github.com/${full}/commit/${r.headSha}`
              : `https://github.com/${full}`,
        },
      });
    }

    const ciSevRank: Record<InsightSeverity, number> = { high: 0, warn: 1, info: 2 };
    ciSeeds.sort(
      (a, b) =>
        ciSevRank[a.card.severity] - ciSevRank[b.card.severity] ||
        b.sortAt - a.sortAt ||
        a.card.repoFullName.localeCompare(b.card.repoFullName),
    );
    // ⚠ MEASURED BEFORE THE SLICE, exactly as `myTurnTotal` is — counted after it, the "total"
    // would be bounded by the cap and would stop being one.
    ciFailingTotal = ciSeeds.length;
    // ⚠ AND THE SLICE IS OURS TO CALL. There is no central cap in this function: every builder
    // slices itself, so a block that forgets ships an uncapped card kind.
    for (const seed of ciSeeds.slice(0, INSIGHT_CARD_CAP)) cards.push(seed.card);
  }

  if (openPrIds.length === 0) return finish();

  // Pending review requests (GitHub drops the request once a review lands → still-pending).
  // Rows with userId null are GitHub TEAM requests (teamName set) — they count as "someone is
  // on the hook" for the orphan test + the stalled filter, matching getSuggestedReviewersBasis'
  // `wants` gate (which counts ALL review_requests rows — the two must stay in agreement).
  const reqRows = await db
    .select({
      prId: reviewRequests.prId,
      userId: reviewRequests.userId,
      teamName: reviewRequests.teamName,
    })
    .from(reviewRequests)
    .where(inArray(reviewRequests.prId, openPrIds))
    .execute();
  const requestedPrIds = new Set<number>(); // any outstanding request, user OR team
  const teamNamesByPr = new Map<number, string[]>(); // GitHub team display names, deduped
  const pendingByPr = new Map<number, number[]>();
  const pendingByReviewer = new Map<number, number[]>();
  for (const r of reqRows) {
    requestedPrIds.add(r.prId);
    if (r.teamName != null) {
      const t = teamNamesByPr.get(r.prId) ?? [];
      if (!t.includes(r.teamName)) t.push(r.teamName);
      teamNamesByPr.set(r.prId, t);
    }
    // LOAD-BEARING: pendingByPr/pendingByReviewer stay USER-only — their values flow into
    // requestedReviewerIds: number[] on the wire and reviewer_load card ids (a null leaked
    // here mints a bogus 'load:null' card).
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

  // Sprint review load per reviewer (reviews submitted on the workspace's PRs in the window).
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

  // (1) STALLED REVIEWS — open PRs with a still-pending reviewer (user OR team), open past
  // the threshold.
  const stalled = openPrs
    .filter(
      (p) =>
        requestedPrIds.has(p.id) &&
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
      ...prRef(p),
      ageHours,
      requestedReviewerIds: reviewers,
      requestedTeamNames: teamNamesByPr.get(p.id) ?? [],
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
  // Same workspace as the bot_signal card above — these cards are drawn from that workspace's
  // threads, so the judgement that tags them must come from that workspace's rows.
  const untouchedKindMap = await classificationKindForUser(accountId, scope.workspaceId);
  for (const { t, ageHours } of threads) {
    addUser(t.originalCommenterId);
    addUser(t.authorId);
    const botKind =
      t.originalCommenterId != null ? untouchedKindMap.get(t.originalCommenterId) ?? null : null;
    cards.push({
      id: `thread:${t.threadId}`,
      kind: 'untouched_thread',
      severity: ageHours >= 96 ? 'high' : ageHours >= 48 ? 'warn' : 'info',
      ...prRef({ ...t, id: t.prId, number: t.prNumber, title: t.prTitle }),
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
  // `requestedPrIds`, not `pendingByPr`: a TEAM request already has a reviewer on the hook.
  const orphans = openPrs
    .filter(
      (p) =>
        !requestedPrIds.has(p.id) &&
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

    // Author logins (to drop the author from CODEOWNERS user suggestions — no self-review).
    const authorIds = [
      ...new Set(orphans.map((p) => p.authorId).filter((x): x is number => x != null)),
    ];
    const authorLoginById = new Map<number, string>();
    if (authorIds.length > 0)
      for (const u of await db
        .select({ id: users.id, login: users.githubLogin })
        .from(users)
        .where(inArray(users.id, authorIds))
        .execute())
        authorLoginById.set(u.id, u.login);

    // Per orphan: the SAME suggested-reviewer pipeline as the PR-detail "Suggested reviewers" row.
    // suggestReviewersFromHistory resolves candidates through getReviewerLogins (drops bots + null
    // logins) → so BOTS ARE STRUCTURALLY IMPOSSIBLE here; enrichReviewerSuggestions then layers
    // CODEOWNERS owners + CODEOWNERS teams + inferred team history on top (TEAMS are first-class,
    // exactly like the PR detail). Best-effort network per orphan (per-repo cached), parallelised;
    // any failure degrades to just the bot-filtered history users.
    const built = await Promise.all(
      orphans.map(async (p) => {
        const paths = orphanFiles.get(p.id) ?? [];
        const full = repoName.get(p.repoId) ?? '';
        const slash = full.indexOf('/');
        const owner = slash > 0 ? full.slice(0, slash) : '';
        const name = slash > 0 ? full.slice(slash + 1) : '';
        const base = await suggestReviewersFromHistory(accountId, p.repoId, p.authorId, paths);
        const { suggestions, extraUsers } = await enrichReviewerSuggestions({
          accountId,
          owner,
          name,
          authorLogin: p.authorId != null ? authorLoginById.get(p.authorId) ?? null : null,
          paths,
          userSuggestions: base,
          knownUserIds: new Set<number>(),
          resolveUsers: getUsersByLogins,
        });
        return { p, paths, suggestions, extraUsers };
      }),
    );

    for (const { p, paths, suggestions, extraUsers } of built) {
      if (suggestions.length === 0) continue; // nothing useful to suggest (users or teams)
      addUser(p.authorId);
      for (const s of suggestions) addUser(s.userId);
      for (const u of extraUsers) addUser(u.id);
      cards.push({
        id: `route:${p.id}`,
        kind: 'reviewer_routing',
        severity: 'info',
        ...prRef(p),
        topPaths: paths.slice(0, 5),
        suggestedReviewers: suggestions,
      });
    }
  }

  return finish();
}

// Facet counts over the post-cap `ordered` stream (see ConsolidatedFeedCounts). Pure, so it's
// unit-testable and shares the exact set the page is sliced from — the badges reconcile with
// the loadable feed by construction. `botIds` is the raw UNION bot id set (users.isBot ∪ the
// workspace's automated reviewers, manualHuman removed — NOT the allow-list-subtracted
// excludeBots set), matching the SPA's isBotActor. `byBotActor` is only built in the bot-only
// feed; `byThreadState` groups items carrying a derivedState.
export function computeFeedCounts(
  ordered: ConsolidatedFeedItem[],
  botIds: ReadonlySet<number>,
  botsOnly: boolean,
): ConsolidatedFeedCounts {
  const counts: ConsolidatedFeedCounts = {
    total: ordered.length,
    myTurn: 0,
    claude: 0,
    comments: 0,
    prEvents: 0,
    commits: 0,
    ciFailures: 0,
    awaitingReview: 0,
    bots: 0,
    byBotActor: {},
    byThreadState: {},
  };
  const awaitingPrIds = new Set<number>();
  for (const it of ordered) {
    if (it.isMyTurn) counts.myTurn += 1;
    if (it.kind === 'claude_review') counts.claude += 1;
    if (it.kind === 'review_comment' || it.kind === 'pr_comment') counts.comments += 1;
    if (it.kind === 'commit_pushed') counts.commits += 1;
    if (isCiFeedKind(it.kind)) counts.ciFailures += 1;
    if (
      it.kind === 'pr_opened' ||
      it.kind === 'pr_merged' ||
      it.kind === 'pr_closed' ||
      it.kind === 'pr_reopened' ||
      it.kind === 'pr_ready_for_review' ||
      it.kind === 'review_submitted'
    )
      counts.prEvents += 1;
    // Mirrors FeedView's matchesNeedsReview — but counts DISTINCT PRs, not events: a PR opened
    // as a draft and later marked ready has BOTH kinds in the window, and "Needs review 2" for
    // one PR reads as two PRs. (FeedView's page-derived fallback dedupes the same way.)
    if (
      (it.kind === 'pr_opened' || it.kind === 'pr_ready_for_review') &&
      it.prAwaitingReview === true &&
      it.prId != null
    )
      awaitingPrIds.add(it.prId);
    if (it.actorId != null && botIds.has(it.actorId)) counts.bots += 1;
    if (botsOnly && it.actorId != null)
      counts.byBotActor[it.actorId] = (counts.byBotActor[it.actorId] ?? 0) + 1;
    if (it.derivedState != null)
      counts.byThreadState[it.derivedState] = (counts.byThreadState[it.derivedState] ?? 0) + 1;
  }
  counts.awaitingReview = awaitingPrIds.size;
  return counts;
}

// The consolidated Feed. Scoped to the account's repos; a passed `repoIds` (the selected
// workspace) narrows WITHIN them — null → every repo the account has added. One flat, newest-first
// stream of real activity, each row flagged isMyTurn by participation (CORE; feed/my-turn.ts).
export async function getConsolidatedFeed(
  accountId: number,
  opts: ConsolidatedFeedFilters,
): Promise<ConsolidatedFeedResponse> {
  const {
    workspaceId,
    repoIds = null,
    userIds = null,
    prId = null,
    limit = null,
    offset = 0,
    excludeBots = false,
    allowBotIds = null,
    botsOnly = false,
    botWindowDays = null,
    includeAllCommits = false,
    includeCiFailures = false,
  } = opts;

  // Restrict to the repos this account owns; a passed repoIds narrows within them. The
  // intersection is the isolation guard, not a filter — a foreign repoId can never widen the
  // scan. An out-of-scope / empty selection → a valid empty page (also avoids an inArray([])
  // below).
  // EXCEPTION — single-PR isolation (prId) bypasses the narrowing entirely: "Show in feed"
  // promises the PR's history, and its repo may be outside the selected workspace (the bot-only
  // list scopes to ALL account repos). Ownership still gates it — a foreign/unknown prId is an
  // empty page, never a leak.
  const emptyResponse = (): ConsolidatedFeedResponse => ({
    items: [],
    users: [],
    total: 0,
    uncappedTotal: 0,
    counts: computeFeedCounts([], new Set<number>(), botsOnly),
    generatedAt: new Date().toISOString(),
  });
  let effectiveRepoIds: number[];
  if (prId != null) {
    const [ownedPr] = await db
      .select({ repoId: pullRequests.repoId })
      .from(pullRequests)
      .where(and(eq(pullRequests.id, prId), eq(pullRequests.accountId, accountId)))
      .limit(1)
      .execute();
    if (!ownedPr) return emptyResponse();
    effectiveRepoIds = [ownedPr.repoId];
  } else {
    const accountRepoIds = (await listRepos(accountId)).map((r) => r.id);
    effectiveRepoIds = repoIds
      ? repoIds.filter((id) => accountRepoIds.includes(id))
      : accountRepoIds;
  }
  if (effectiveRepoIds.length === 0) return emptyResponse();
  const allowBots = new Set(allowBotIds ?? []);
  // The UNION bot id set (global users.isBot ∪ this workspace's automated-reviewer verdict,
  // manualHuman removed — see hiddenBotUserIds) — ONE lookup, reused for BOTH the excludeBots
  // filter (below, minus the per-repo allow-list) AND the `bots` facet count (the raw union,
  // matching the SPA's isBotActor, which reads the same two halves client-side). getFeed
  // doesn't filter bots, so the notBot() below applies excludeBots here; the commit helper
  // filters in its own SQL.
  const unionBotIds = new Set(await hiddenBotUserIds(accountId, workspaceId));
  // excludeBots is meaningless in the bot-only feed (it would drop everything) — force it off.
  // The per-repo allow-list subtracts the "important" bots so their activity stays visible.
  const botIds =
    !botsOnly && excludeBots
      ? new Set([...unionBotIds].filter((id) => !allowBots.has(id)))
      : new Set<number>();
  const notBot = (id: number | null): boolean =>
    !excludeBots || id == null || !botIds.has(id);

  // Isolated to a single PR (the Open-PRs filter) → show that PR's FULL history: scope every
  // source to the PR and drop the 14-day window (epoch since). The scan is one PR, so it's
  // cheap, and the reader sees the opened event + all activity even on a long-idle PR — not an
  // empty pane. The un-isolated feed keeps the rolling 14-day window (a live activity stream).
  const feedSince =
    prId != null ? new Date(0) : new Date(Date.now() - FEED_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  // Bot-only feed: resolve the automated-reviewer actor set (vendors + classified in-house /
  // Pierre — the SAME set the ROI panel counts, so it catches deepsource-io etc. that aren't
  // users.isBot). Empty → nobody's classified → an empty feed. Filtered IN SQL by getFeed.
  // `role: 'all'` — NOT 'review'. The bot feed must keep showing quality-check activity: the
  // user confirmed a quality-check reviewer stays visible and reclassifiable, and a linter's
  // threads are still things a human has to triage. The role only splits METRICS from the feed.
  //
  // The judgement comes from `workspaceId`, not from `effectiveRepoIds`. They agree in the normal
  // case (the route intersects the narrowing with the workspace's membership), and they
  // deliberately do NOT in the single-PR isolation branch below, which reaches a PR whose repo may
  // sit outside the selected workspace — the workspace still owns "is this login a bot", which is what
  // keeps the vendor tag on an isolated PR's rows consistent with the rest of the app.
  const botActorIds = botsOnly
    ? await automatedReviewerUserIds(accountId, workspaceId, 'all')
    : null;
  if (botsOnly && (botActorIds == null || botActorIds.length === 0)) {
    return {
      items: [],
      users: [],
      total: 0,
      uncappedTotal: 0,
      counts: computeFeedCounts([], unionBotIds, botsOnly),
      generatedAt: new Date().toISOString(),
    };
  }
  // CI-failure rows are actor-less, so a member filter must skip them for the same reason it
  // skips Claude runs: an actor-less row cannot belong to any of the people the reader picked.
  // Computed once and shared by both halves so the two can never disagree.
  const ciFailuresOn =
    includeCiFailures && !botsOnly && !(userIds != null && userIds.length > 0);
  const [feed, commitItems, claudeItems, ciItems, trunkCiItems] = await Promise.all([
    // The bot-only feed follows the analytics window selector (botWindowDays); every other
    // view keeps the rolling 14 days.
    getFeed(accountId, {
      daysBefore: botsOnly && botWindowDays != null ? botWindowDays : 14,
      prId,
      repoIds: effectiveRepoIds,
      userIds,
      botActorIds,
    }),
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
          includeAllCommits,
        }),
    // Claude Review runs surfaced as their own feed item kind (local-only; empty in cloud).
    // Skipped in the bot-only feed (they're the user's own runs, not review-bot activity).
    // ALSO skipped whenever a member filter is active: these rows are emitted with
    // `actorId: null` (a run has no member author), and getClaudeReviewFeedItems takes no
    // userIds, so they would survive every member filter and appear in a feed the reader
    // explicitly scoped to specific people. An actor-less row cannot belong to any of them.
    botsOnly || (userIds != null && userIds.length > 0)
      ? Promise.resolve<ConsolidatedFeedItem[]>([])
      : getClaudeReviewFeedItems(accountId, effectiveRepoIds, feedSince, prId),
    // CI failures on a PR head — the opt-in "CI failures" toggle, off by default.
    ciFailuresOn
      ? getCiFailureFeedItems(accountId, effectiveRepoIds, feedSince, prId)
      : Promise.resolve<ConsolidatedFeedItem[]>([]),
    // CI failures on the DEFAULT BRANCH. Same toggle; additionally skipped under single-PR
    // isolation, where the reader asked for one PR's history and trunk is not part of it.
    ciFailuresOn && prId == null
      ? getTrunkCiFailureFeedItems(accountId, effectiveRepoIds, feedSince)
      : Promise.resolve<ConsolidatedFeedItem[]>([]),
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

  // CI-failure items (both halves). Deliberately NOT added to the uncapped `alwaysRows` set
  // below: a repo with a flaky matrix build or a chronically red trunk could otherwise starve
  // the 250-row plain-activity budget with red cards.
  for (const it of ciItems) push(it);
  for (const it of trunkCiItems) push(it);

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

  // Attach each PR-bearing item's LIVE "still awaiting a first review" snapshot (open ∧ not
  // draft ∧ firstReviewAt null) — powers the "Needs review" pill. Recomputed per request,
  // never stored: the same card can match today and not tomorrow. One query over the distinct
  // PR ids referenced by the stream; PR-less items stay null.
  const feedPrIds = [...new Set(items.map((i) => i.prId).filter((p): p is number => p != null))];
  if (feedPrIds.length > 0) {
    const prRows = await db
      .select({
        id: pullRequests.id,
        state: pullRequests.state,
        isDraft: pullRequests.isDraft,
        firstReviewAt: pullRequests.firstReviewAt,
      })
      .from(pullRequests)
      .where(and(eq(pullRequests.accountId, accountId), inArray(pullRequests.id, feedPrIds)))
      .execute();
    const awaitingByPr = new Map<number, boolean>(
      prRows.map((r) => [r.id, r.state === 'open' && !r.isDraft && r.firstReviewAt == null]),
    );
    for (const it of items) {
      it.prAwaitingReview = it.prId != null ? (awaitingByPr.get(it.prId) ?? false) : null;
    }
  }

  // "My Turn" enrichment (CORE / free): flag each item `isMyTurn` by the viewer's participation
  // in its PR. Runs BEFORE the cap so uncapped My-Turn rows survive.
  //
  // ⚠ CI-failure rows are WITHHELD from it, and this is not tidiness. `enrichMyTurn` flags any
  // PR-bearing item whose actor isn't you — and a CI item's actor is `null`, so `actorId !==
  // localUserId` is trivially true. Handing them over would turn every red build on a PR you
  // participate in into an UNCAPPED yellow My-Turn card, i.e. a silent behaviour change to the
  // product's core lane hidden inside a CI toggle. (`enrichMyTurn` mutates the items it is
  // given, so passing a filtered array is enough — the objects are the same.)
  await enrichMyTurn(
    accountId,
    ciFailuresOn ? items.filter((i) => !isCiFeedKind(i.kind)) : items,
  );

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
  // Facet counts over the WHOLE post-cap stream (not just the page) so the SPA's pill badges
  // reflect every matching item. Uses the raw union bot set, so `bots` matches isBotActor.
  const counts = computeFeedCounts(ordered, unionBotIds, botsOnly);
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
    // A CI-failure card's `ciStatus` is the rollup AT THE OBSERVATION it reports. Overwriting it
    // with the PR's LIVE rollup would leave a card that says "CI failed" carrying a green
    // status once the re-run passed — the one item kind where the live answer is the wrong one.
    if (!isCiFeedKind(it.kind)) it.ciStatus = ciByPr.get(it.prId) ?? null;
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
  // Bot-only feed: the vendor pills are built from `counts.byBotActor`, which spans the WHOLE
  // stream (beyond the loaded page). Fetch + ship every such actor so the SPA can label a pill
  // whose items all fall past the current page.
  if (botsOnly)
    for (const key of Object.keys(counts.byBotActor)) {
      const id = Number(key);
      needed.add(id);
      pageUserIds.add(id);
    }
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
    // Pre-cap stream length — lets the client disclose "total most recent of N" honestly
    // when the plain-activity cap dropped older rows (uncappedTotal > total).
    uncappedTotal: scoped.length,
    counts,
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
  // NB the STORED kind string stays `watched_repo_pr`: it is a value in
  // `my_turn_dismissals.kind` (and in the shared wire union), so renaming it would strand every
  // existing dismissal. The section it belongs to is now "New PRs".
  const newRepoPrDismissals = dismissals.filter((d) => d.kind === 'watched_repo_pr');
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

  // "New PRs" (stored kind `watched_repo_pr`) dismissals → their PRs (account-scoped). Same
  // shape as a review_request dismissal, just a different kind tag.
  if (newRepoPrDismissals.length > 0) {
    const prRows = await db
      .select()
      .from(pullRequests)
      .innerJoin(repos, eq(repos.id, pullRequests.repoId))
      .where(
        and(
          eq(pullRequests.accountId, accountId),
          inArray(
            pullRequests.id,
            newRepoPrDismissals.map((d) => d.refId),
          ),
        ),
      )
      .execute();
    const byId = new Map(prRows.map((r) => [r.pull_requests.id, r]));
    for (const d of newRepoPrDismissals) {
      const row = byId.get(d.refId);
      if (!row) continue;
      const { pull_requests: pr, repos: repo } = row;
      if (pr.authorId != null) referencedUsers.add(pr.authorId);
      // Restorable if still eligible for the "New PRs" section, OR if it has since
      // become a review request (restoring then surfaces it under "Awaiting review").
      const restorable =
        actionable.newRepoPrIds.has(pr.id) ||
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

// "New PRs" inbox eligibility, IGNORING dismissals and the cross-section dedupe: the set of
// open-PR ids that qualify for the section (opened on/after the repo was ADDED to the account,
// authored by a non-bot human other than you, non-draft). Shared by getMyTurn (which then layers
// dismissals + dedupe) and getActionableActivityIds (restorability of a Done entry).
//
// ⚠ `repos.createdAt` IS THE CLOCK, and it is the load-bearing part of this function. Without a
// cutoff, adding a repo with 400 open PRs dumps all 400 into My Turn on day one. It replaced a
// separate `inboxWatchStartedAt` stamped by the retired "watched" toggle; `createdAt` is NOT NULL,
// so unlike that column it can never be missing and there is no "no cutoff → show nothing"
// defensive branch to port.
async function getAddedRepoActionablePrIds(
  accountId: number,
  localUserId: number,
  open: TimelinePr[],
  openRows: PrRow[],
): Promise<Set<number>> {
  const repoRows = await db
    .select({ repoId: repos.id, addedAt: repos.createdAt })
    .from(repos)
    .where(eq(repos.accountId, accountId))
    .execute();
  const addedAtByRepo = new Map<number, Date>();
  for (const r of repoRows) addedAtByRepo.set(r.repoId, r.addedAt);
  const out = new Set<number>();
  if (addedAtByRepo.size === 0) return out;
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
    // A PR whose repo isn't in this account's set can't reach here (open/openRows are
    // account-scoped), but the lookup still gates: no repo row, no cutoff, no entry.
    const addedAt = addedAtByRepo.get(t.repoId);
    if (addedAt == null) continue;
    if (t.authorId == null || t.authorId === localUserId) continue;
    if (botUserIds.has(t.authorId)) continue;
    const m = rowById.get(t.id);
    if (!m || m.isDraft) continue;
    if (m.openedAt.getTime() >= addedAt.getTime()) out.add(t.id);
  }
  return out;
}

// The inbox's actionable ids per kind, IGNORING dismissals — i.e. everything that
// COULD be in "My Turn" if nothing were dismissed. The single source of truth for
// whether a dismissed "Done" entry is restorable: removing its dismissal returns it
// to the inbox iff its ref is still in the matching set here. Reuses the same
// building blocks getMyTurn does (reviewRequestedFromMe, getAddedRepoActionablePrIds,
// getThreadsAwaiting, getUnactionedClaudeReviews) so the two never drift.
async function getActionableActivityIds(accountId: number): Promise<{
  reviewRequestPrIds: Set<number>;
  newRepoPrIds: Set<number>;
  approvedPrIds: Set<number>;
  threadIds: Set<number>;
  claudeReviewIds: Set<number>;
}> {
  const localUserId = await getAccountUserId(accountId);
  const empty = {
    reviewRequestPrIds: new Set<number>(),
    newRepoPrIds: new Set<number>(),
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
  const newRepoPrIds = await getAddedRepoActionablePrIds(
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

  return { reviewRequestPrIds, newRepoPrIds, approvedPrIds, threadIds, claudeReviewIds };
}

// THE "my turn" FOLD — the six sections of what is on the viewer's plate, PR/thread-grained.
//
// `scope` is OPTIONAL and the two shapes are deliberately different questions:
//   • omitted  → the ACCOUNT-WIDE inbox. `GET /api/my-turn` and the CLI status board take this,
//                and its behaviour must stay byte-identical to the pre-scope version.
//   • passed   → the WORKSPACE inbox: every section's driving query is narrowed to
//                `scope.repoIds`, and an EMPTY repo list is an ordinary, immediate empty answer
//                (a freshly created workspace), never a widening to the whole account.
// The scoped form is what mints the `my_turn` insight cards in getWorkspaceInsights — so the
// board's list and the daily brief's number come out of THIS function, once.
export async function getMyTurn(
  accountId: number,
  scope?: BotScope,
): Promise<MyTurnResponse> {
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
  // An empty workspace has nothing on your plate — and returning here also dodges the
  // `inArray(col, [])` pitfall every scoped query below would otherwise hit.
  if (scope && scope.repoIds.length === 0) return empty;
  // null (not []) is the "no narrowing" sentinel the scoped helpers below test for.
  const scopedRepoIds = scope ? scope.repoIds : null;

  const referencedUsers = new Set<number>();

  // Open PRs, enriched with triage, are the basis for sections 1 & 2.
  const openRows = await db
    .select()
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.accountId, accountId),
        scopedRepoIds == null
          ? undefined
          : inArray(pullRequests.repoId, scopedRepoIds),
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
  // Dismissed "New PRs" ids (stored kind `watched_repo_pr` — a DB enum value, kept for the
  // existing rows). Sticky: a dismissal removes that PR from the section for good (no timestamp
  // comparison — it acknowledges a new PR).
  const newRepoPrDismissedIds = new Set<number>();
  for (const d of dismissals) {
    if (d.kind === 'review_request') reviewDismissedAt.set(d.refId, d.dismissedAt);
    else if (d.kind === 'thread') threadDismissedAt.set(d.refId, d.dismissedAt);
    else if (d.kind === 'pr_approved') approvedDismissedAt.set(d.refId, d.dismissedAt);
    else if (d.kind === 'claude_review') claudeDismissedIds.add(d.refId);
    else if (d.kind === 'watched_repo_pr') newRepoPrDismissedIds.add(d.refId);
  }

  const meta = (prId: number) =>
    openRows.find((p) => p.id === prId)!;

  // `since` is THE CLOCK — when the thing that needs you happened — and it is a PARAMETER
  // rather than something derived here because each section dates off a different column
  // (see `MyTurnPr.since`). Making it required is the point: a new section cannot quietly
  // fall back to `openedAt`, which is the wrong moment for three of the four.
  const toMyTurnPr = (t: TimelinePr, since: Date) => {
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
      since: since.toISOString(),
      // The DEFAULT of the relevance rule (see `MyTurnRelevance`): five of the six sections
      // require your involvement to exist at all — a review was requested of YOU, it is YOUR PR,
      // YOUR PR was approved, YOUR thread got a reply, YOU asked for the run — so membership IS
      // the relevance test and there is nothing further to check. Only "New PRs" admits work
      // nobody asked you about, and it overrides BOTH of these below.
      //
      // `personal` is DERIVED from `relevance` (`!== 'none'`) and written anyway: it is still the
      // field every notification surface reads, and keeping the server the one place that folds
      // the three values down to the boolean is what stops the two ever disagreeing.
      relevance: 'direct' as const,
      personal: true,
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
        const m = meta(t.id);
        // The review-pickup clock: when a review was REQUESTED of you (the PR's open time only
        // stands in for repos synced before that column existed).
        return {
          ...toMyTurnPr(t, m.firstReviewRequestedAt ?? m.openedAt),
          alsoRequested: others,
        };
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
      // Dated by the NEWEST approval — the same fold the section's dismissal test uses above.
      ...toMyTurnPr(t, approvalInfo.get(t.id)?.latestApprovalAt ?? meta(t.id).openedAt),
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
      // Dated by the PR's last update — that update IS the "new activity" this section reports.
      ...toMyTurnPr(t, meta(t.id).updatedAt),
      newSinceLastViewed: t.newSinceLastViewed!,
      summary: summariseNew(t.newSinceLastViewed!),
    }));

  // 2b. New open PRs in your repos. Built AFTER awaitingReview + yourPrs so those PRs
  //     aren't shown twice. Eligibility (opened on/after the repo was ADDED, by a non-bot
  //     human other than you, non-draft) is the shared getAddedRepoActionablePrIds; here we
  //     layer the cross-section dedupe + sticky dismissals on top.
  //     ⚠ This section is workspace-scoped BY CONSTRUCTION, not by a predicate of its own: it
  //     only ever emits ids drawn from `open`/`openRows`, which the query above already narrowed
  //     to `scope.repoIds`. (Its repos read is a repo → addedAt CUTOFF map, so narrowing it would
  //     change nothing but the row count.)
  const newRepoPrEligible = await getAddedRepoActionablePrIds(
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
  // The response field keeps its wire name (`MyTurnResponse.watchedRepoPrs`).
  const newRepoPrCandidates = open.filter(
    (t) =>
      newRepoPrEligible.has(t.id) &&
      !inOtherSections.has(t.id) &&
      !newRepoPrDismissedIds.has(t.id),
  );
  // ⚠ THE ONE SECTION THAT NEEDS A RELEVANCE TEST, and it is a FLAG, not a filter. Every
  //   candidate above still ships (the "Needs attention" board paints them all, and the CLI
  //   status board + the Done tab's restorability contract both read the full set); what the
  //   maintainer test decides is whether the NOTIFICATION surfaces are allowed to interrupt the
  //   viewer about it. Narrowing the section itself would delete work rather than route it.
  //   Membership is what changes the answer, so the extra read is skipped when nothing is here.
  //
  //   THE RULE HAS TWO ARMS AND THEY ANSWER DIFFERENT QUESTIONS. The repo arm asks "is this your
  //   patch of ground"; the mention arm asks "did somebody type your name". A mention makes a PR
  //   personal EVEN IN A REPO YOU ONLY READ — which is the whole reason it is not folded into the
  //   maintainer test. The mention set is DERIVED OFFLINE (sync/mention-scan.ts) precisely so this
  //   line stays an indexed existence check: the underlying question is a substring scan over
  //   every comment body in scope, and this function runs on every Feed landing.
  const [maintainedRepoIds, mentionedPrIds] =
    newRepoPrCandidates.length > 0
      ? await Promise.all([
          viewerMaintainedRepoIds(accountId, localUserId),
          // Login-scoped, so a renamed account narrows immediately rather than trusting rows the
          // scanner has not caught up with. No rows at all ⇒ an empty set ⇒ this arm contributes
          // nothing and the flag is exactly the maintainer test it was before mentions existed.
          getAccountById(accountId).then((a) =>
            viewerMentionedPrIds(
              accountId,
              a?.githubLogin ?? null,
              newRepoPrCandidates.map((t) => t.id),
            ),
          ),
        ])
      : [new Set<number>(), new Set<number>()];
  const watchedRepoPrs = newRepoPrCandidates
    // The one section where OPENING is genuinely the event, so openedAt is the honest clock.
    .map((t) => {
      // ⚠ THE TWO ARMS STAY TWO FACTS. They used to be OR-ed into one boolean, and that union is
      // precisely what made the board unreadable: "somebody typed your name on this PR" and "this
      // PR is in a repo you happen to have write on" are not the same summons, and a card that
      // said "YOUR TURN" for the second one was claiming ownership of a stranger's work. Keep
      // them separate all the way to the label; collapse only at the very end, into `personal`.
      //
      // DIRECT WINS: a mention in a repo you also maintain is still about you.
      const relevance: MyTurnRelevance = mentionedPrIds.has(t.id)
        ? 'direct'
        : maintainedRepoIds.has(t.repoId)
          ? 'maintained'
          : 'none';
      return {
        ...toMyTurnPr(t, meta(t.id).openedAt),
        relevance,
        // DERIVED, and written here rather than left to the consumer so `personal` keeps meaning
        // exactly what it meant before this split existed: "may a notification surface interrupt
        // the viewer about this row?" — direct ∪ maintained, unchanged.
        personal: relevance !== 'none',
      };
    })
    .sort((a, b) => b.openedAt.localeCompare(a.openedAt));

  // 3. Threads awaiting your response: you opened the thread, someone replied
  //    after you, and it isn't resolved. A dismissal sticks until a newer reply.
  const threadsAwaiting = (
    await getThreadsAwaiting(localUserId, accountId, repoNameById, scopedRepoIds)
  )
    .filter((ta) => {
      const d = threadDismissedAt.get(ta.threadId);
      return !d || Date.parse(ta.lastReplyAt) > d.getTime();
    })
    // You opened the thread and someone replied to YOU — DIRECT by construction. Stamped rather
    // than left absent so every section answers the relevance question in the same two fields.
    .map((ta) => ({ ...ta, relevance: 'direct' as const, personal: true }));
  for (const ta of threadsAwaiting) {
    if (ta.lastReplyAuthorId != null) referencedUsers.add(ta.lastReplyAuthorId);
  }

  // Completed-but-unactioned Claude reviews (local-only feature; empty otherwise).
  // A manual "Done" hides the run until a newer run finishes (see claudeDismissedIds).
  const claudeReviewsToAction: ClaudeReviewToAction[] = getProCapabilities().claudeReview
    ? (await getUnactionedClaudeReviews(accountId, scopedRepoIds))
        .filter((c) => !claudeDismissedIds.has(c.reviewId))
        // You asked for the run — DIRECT by construction, same as the thread section.
        .map((c) => ({ ...c, relevance: 'direct' as const, personal: true }))
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
  // The workspace's repo narrowing, or null/undefined for the account-wide (unscoped) read that
  // GET /api/my-turn and the CLI status board take. An EMPTY array is a real, scoped answer
  // ("this workspace has no repos") and the caller short-circuits before reaching here.
  repoIds?: number[] | null,
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
        repoIds == null ? undefined : inArray(pullRequests.repoId, repoIds),
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
      addressedConfidence: t.addressedConfidence,
      addressedReason: t.addressedReason,
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
  // The judgement scope is THIS PR's own workspace, resolved from its repo — never the caller's
  // currently-selected one. A PR can be opened from another workspace via `?pr=`, a restored tab
  // or a search hit, and tagging its reviews with a different workspace's verdicts is how the
  // same review reads "CodeRabbit" on one screen and "unclassified" on the next.
  const prScope = await workspaceScopeForRepo(accountId, pr.repoId);
  const [provenanceByReview, prClassKind] = await Promise.all([
    getReviewerProvenanceForPr(accountId, id),
    prScope
      ? classificationKindForUser(accountId, prScope.workspaceId)
      : Promise.resolve(new Map<number, AutomatedReviewerKind>()),
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
  // Whether the viewer may CLOSE this PR: WRITE+ on the repo OR they authored it (GitHub
  // lets an author close their own PR without push access). The close route re-checks.
  const viewerCanClose =
    viewerCanPush || (viewerUserId != null && viewerUserId === pr.authorId);

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
    // Null both when the repo requires no review and when this PR predates the column —
    // the merge verdict degrades to a generic "blocked" reason either way, never a lie.
    reviewDecision: pr.reviewDecision ?? null,
    labels: (pr.labels ?? []) as Label[],
    checkRuns: (pr.checkRuns ?? []) as CheckRun[],
    additions: pr.additions,
    deletions: pr.deletions,
    changedFilesCount: pr.changedFiles,
    files: filesOut,
    requestedReviewers,
    viewerCanApprove,
    viewerCanPush,
    viewerCanClose,
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
//
// `isMaintainer` is membership of the merger set, NOT rank 5: a maintainer who is also
// the PR's author ranks 0, and the picker still owes them a shield.
export async function getMentionCandidates(
  prId: number,
  accountId: number,
): Promise<MentionCandidate[] | null> {
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
  const maintainerIds = new Set<number>();
  for (const r of mergerRows) {
    bump(r.userId, 5);
    if (r.userId != null) maintainerIds.add(r.userId);
  }
  for (const r of repoAuthorRows) bump(r.authorId, 6);

  // The viewer can't @ themselves.
  const viewerUserId = await getAccountUserId(accountId);
  if (viewerUserId != null) rank.delete(viewerUserId);

  const ids = [...rank.keys()];
  if (ids.length === 0) return [];
  const rows = await db.select().from(users).where(inArray(users.id, ids)).execute();
  return rows
    .filter((u) => !u.isBot)
    .map((u) => ({
      user: { ...mapUser(u), isMaintainer: maintainerIds.has(u.id) },
      rank: rank.get(u.id) ?? 99,
    }))
    .sort((a, b) => a.rank - b.rank || a.user.githubLogin.localeCompare(b.user.githubLogin))
    .map((x) => x.user);
}

// @mention candidates scoped to a REPO SET (a Workspace / the FilterBar-visible repos) rather than one
// PR — powers the ad-hoc Insights "Ask about the sprint" box, whose questions span the whole
// scope. `repoIds` null = every repo the account owns (the 'all' scope). People = whoever has
// MERGED (maintainers, rank 0) or OPENED (rank 1) a PR in the scope's repos; self + bots excluded.
// Account-scoped: the repo set is intersected with the account's own repos so a foreign repo id
// can never widen it. Sorted by rank then login; the picker slices client-side.
export async function getScopeMentionCandidates(
  accountId: number,
  repoIds: number[] | null,
): Promise<MentionCandidate[]> {
  // Resolve the scope to a bounded set of THIS account's repo ids (never trust caller ids raw).
  const ownRepoRows = await db
    .select({ id: repos.id })
    .from(repos)
    .where(eq(repos.accountId, accountId))
    .execute();
  const ownIds = new Set(ownRepoRows.map((r) => r.id));
  const scopeIds =
    repoIds == null ? [...ownIds] : repoIds.filter((id) => ownIds.has(id));
  if (scopeIds.length === 0) return [];

  const rank = new Map<number, number>();
  const bump = (id: number | null | undefined, r: number): void => {
    if (id == null) return;
    const cur = rank.get(id);
    if (cur == null || r < cur) rank.set(id, r);
  };

  const [mergerRows, authorRows] = await Promise.all([
    db
      .selectDistinct({ userId: pullRequests.mergedById })
      .from(pullRequests)
      .where(and(inArray(pullRequests.repoId, scopeIds), eq(pullRequests.state, 'merged')))
      .execute(),
    db
      .selectDistinct({ authorId: pullRequests.authorId })
      .from(pullRequests)
      .where(inArray(pullRequests.repoId, scopeIds))
      .execute(),
  ]);
  const maintainerIds = new Set<number>();
  for (const r of mergerRows) {
    bump(r.userId, 0);
    if (r.userId != null) maintainerIds.add(r.userId);
  }
  for (const r of authorRows) bump(r.authorId, 1);

  const viewerUserId = await getAccountUserId(accountId);
  if (viewerUserId != null) rank.delete(viewerUserId);

  const ids = [...rank.keys()];
  if (ids.length === 0) return [];
  const rows = await db.select().from(users).where(inArray(users.id, ids)).execute();
  return rows
    .filter((u) => !u.isBot)
    .map((u) => ({
      user: { ...mapUser(u), isMaintainer: maintainerIds.has(u.id) },
      rank: rank.get(u.id) ?? 99,
    }))
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
    addressedConfidence: t.addressedConfidence,
    addressedReason: t.addressedReason,
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
    // CI status history FKs BOTH repos and pull_requests with ON DELETE no action (see
    // migrations 0022 / pg 0011), so leaving it would FK-fail the pullRequests delete
    // below. Keyed by repoId like events (every row is stamped with its PR's repo).
    await tx.delete(ciStatusEvents).where(eq(ciStatusEvents.repoId, id)).execute();
    // The TRUNK CI transition log (migration 0052 / pg 0039). Its FKs DO cascade, unlike
    // ci_status_events' — but SQLite enforces FKs only under `foreign_keys=ON` while Postgres
    // enforces them immediately, so it is deleted explicitly here for the same reason
    // erase-account.ts deletes branch_commits explicitly: the guarantee must not depend on
    // which dialect is running. Keyed by repoId — a trunk row has no PR.
    await tx
      .delete(trunkCiStatusEvents)
      .where(eq(trunkCiStatusEvents.repoId, id))
      .execute();
    // "@you" mention rows (migration 0056 / pg 0043). Its FKs cascade from repos AND
    // pull_requests, so this is belt-and-braces for the same stated reason as the two above —
    // SQLite enforces FKs only under `foreign_keys=ON` — but it is NOT optional: a surviving row
    // would keep claiming a deleted PR is personally relevant, and the row is keyed by repo, so
    // this is one indexed predicate rather than a dependency on the prIds list being non-empty.
    await tx.delete(prMentions).where(eq(prMentions.repoId, id)).execute();
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
    // The workspace membership row references this repo (the composite FK is ON DELETE cascade,
    // but delete it explicitly so the ordering is dialect-agnostic and can't FK-fail if
    // foreign_keys is off).
    //
    // ⚠ IT DOES NOT TOUCH `workspace_reviewers`. That row keys on (workspace, actor), not on the
    // repo, so removing one repo from a workspace does not invalidate a judgement about a
    // reviewer that may still cover the workspace's other repos — and a stored row whose
    // footprint has gone must stay visible and editable (its counts simply read zero).
    await tx.delete(workspaceRepos).where(eq(workspaceRepos.repoId, id)).execute();
    await tx.delete(syncState).where(eq(syncState.repoId, id)).execute();
    await tx.delete(repos).where(eq(repos.id, id)).execute();
  });
  return true;
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
  // Optional workspace repo narrowing (same contract as getThreadsAwaiting's): null/undefined =
  // the account-wide read, an array = only these repos' PRs.
  repoIds?: number[] | null,
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
        repoIds == null ? undefined : inArray(pullRequests.repoId, repoIds),
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
  // `role: 'review'` — the bulk-resolve backlog covers review-bot threads only. Resolving a
  // SonarQube finding does not mean a review comment was addressed, and the `likely_addressed`
  // heuristic (a later commit touched the file) is a much weaker claim for a linter. This is the
  // one exclusion a user might want reversed; it's cheap to make it a toggle later and expensive
  // to un-ship. The judgement comes from the PR's OWN workspace, resolved from the
  // ownership-bound lookup (a foreign/unknown prId yields null, so nothing is ever classed
  // automated for it).
  const prScope = await botScopeForPr(accountId, prId);
  if (!prScope) return [];
  const botIds = await automatedReviewerUserIds(accountId, prScope.workspaceId, 'review');
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

// The whole-scope generalization of getResolvableBotThreads — the review-BOT threads a later
// commit has LIKELY ADDRESSED across the WHOLE account (or one repo / a repo set), for the
// "clear the stale-bot backlog" review-and-resolve flow on the Bots rail / per-repo Bots tab.
// Same eligibility predicate as the per-PR getter (owned + automated-reviewer-originated +
// `likely_addressed` + unresolved + carries a GitHub node id) MINUS the single-PR filter, PLUS
// an optional repo scope. The returned page is CAPPED (SCOPE_RESOLVE_THREAD_CAP) and ordered
// newest-first, but `totalEligible` reports the UN-capped size so the UI can say "showing the
// N most recent". Enriched with the per-thread root-comment excerpt + a resolved bot label for
// the review list; the node id stays server-side (the resolve helper needs it, the client doesn't).
//
// `scope`: the workspace decides who counts as a bot, `scope.repoIds` narrows which threads are
// considered. `[]` = an empty workspace (resolve nothing). threadIds: identical semantics to the
// per-PR getter — null/undefined = unfiltered, [] = resolve nothing (the load-bearing landmine),
// a non-empty list = the exact reviewed set (the confirm-gated resolve path). On the resolve path
// (threadIds present) the page cap is NOT applied — the inArray already bounds the result to
// ≤ the caller's list — so a re-derive never silently drops a requested-and-eligible id.
export const SCOPE_RESOLVE_THREAD_CAP = 500;

export interface ResolvableBotThreadRow {
  threadId: number;
  threadNodeId: string;
  path: string;
  // The THREAD's own creation time (ISO) — GitHub-stable, unlike the PR's `updatedAt`. Added for
  // the synthesis input (db/synthesis-input.ts), whose payload hash needs a per-item field that
  // never moves under an unchanged backlog.
  threadCreatedAt: string;
  prId: number;
  prNumber: number;
  prTitle: string;
  repoFullName: string;
  prGithubUrl: string;
  authorId: number | null;
  ciStatus: CiStatus;
  openedAt: string;
  updatedAt: string;
  originalCommenterId: number | null;
  excerpt: string | null;
  botLabel: string;
}

export async function getResolvableBotThreadsForScope(
  accountId: number,
  scope: BotScope,
  threadIds: number[] | null = null,
): Promise<{
  threads: ResolvableBotThreadRow[];
  totalEligible: number;
  // Per-PR bot-only thread-state mix for the compact list rows. Populated only on the LISTING
  // path (threadIds == null); empty on the resolve path, which needs only ids.
  botCountsByPr: Map<number, ThreadStateCounts>;
}> {
  const empty = {
    threads: [] as ResolvableBotThreadRow[],
    totalEligible: 0,
    botCountsByPr: new Map<number, ThreadStateCounts>(),
  };
  // An empty workspace or an empty reviewed list both mean "nothing" — resolve/return nothing.
  if (scope.repoIds.length === 0) return empty;
  if (threadIds != null && threadIds.length === 0) return empty;
  // `role: 'review'` — same reasoning as the per-PR getResolvableBotThreads: the backlog is
  // review-bot threads only. The two MUST agree, because the resolve route re-derives eligibility
  // through this function and the per-PR route through that one.
  //
  // The judgement scope is `scope.workspaceId`, and the LISTING resolves the identical one — which
  // is what keeps the offer and the re-derive from disagreeing. Under the old team key the resolve
  // body carried `repoIds` but no team, so the re-derive ran at the account default and found a
  // per-team-only bot ineligible, resolving 0 for threads the listing had just offered. One
  // workspace id on both sides cannot disagree with itself.
  const botIds = await automatedReviewerUserIds(accountId, scope.workspaceId, 'review');
  if (botIds.length === 0) return empty;

  const preds = [
    eq(pullRequests.accountId, accountId),
    inArray(reviewThreads.originalCommenterId, botIds),
    eq(reviewThreads.derivedState, 'likely_addressed'),
    eq(reviewThreads.isResolved, false),
    isNotNull(reviewThreads.githubNodeId),
  ];
  preds.push(inArray(pullRequests.repoId, scope.repoIds));
  if (threadIds != null) preds.push(inArray(reviewThreads.id, threadIds));
  const where = and(...preds);

  const cnt = await db
    .select({ c: count() })
    .from(reviewThreads)
    .innerJoin(pullRequests, eq(pullRequests.id, reviewThreads.prId))
    .where(where)
    .execute();
  const totalEligible = cnt[0]?.c ?? 0;
  if (totalEligible === 0) return empty;

  // The resolve path (threadIds present) is already bounded by the client's ≤-cap list, so it
  // must NOT be re-capped — that would silently drop a requested id. Only the listing path caps.
  const base = db
    .select({
      threadId: reviewThreads.id,
      threadNodeId: reviewThreads.githubNodeId,
      path: reviewThreads.path,
      threadCreatedAt: reviewThreads.createdAt,
      commenterId: reviewThreads.originalCommenterId,
      prId: pullRequests.id,
      prNumber: pullRequests.number,
      prTitle: pullRequests.title,
      authorId: pullRequests.authorId,
      ciStatus: pullRequests.ciStatus,
      openedAt: pullRequests.openedAt,
      updatedAt: pullRequests.updatedAt,
      owner: repos.owner,
      name: repos.name,
    })
    .from(reviewThreads)
    .innerJoin(pullRequests, eq(pullRequests.id, reviewThreads.prId))
    .innerJoin(repos, eq(repos.id, pullRequests.repoId))
    .where(where)
    .orderBy(desc(reviewThreads.createdAt), desc(reviewThreads.id));
  const pageRows = await (threadIds != null ? base : base.limit(SCOPE_RESOLVE_THREAD_CAP)).execute();

  // Per-thread root-comment excerpt: the EARLIEST non-empty comment on each page thread, in ONE
  // query. `excerpt` (always kept) is preferred; a body falls back. Whitespace-collapsed + capped
  // so a long markdown body renders as a single dim one-liner in the review list.
  const pageThreadIds = pageRows.map((r) => r.threadId);
  const excerptByThread = new Map<number, string>();
  if (pageThreadIds.length > 0) {
    const comments = await db
      .select({
        threadId: reviewComments.threadId,
        excerpt: reviewComments.excerpt,
        body: reviewComments.body,
      })
      .from(reviewComments)
      .where(inArray(reviewComments.threadId, pageThreadIds))
      .orderBy(asc(reviewComments.createdAt), asc(reviewComments.id))
      .execute();
    for (const c of comments) {
      if (excerptByThread.has(c.threadId)) continue; // earliest non-empty wins
      const raw = c.excerpt ?? c.body;
      if (raw && raw.trim() !== '') {
        excerptByThread.set(c.threadId, raw.replace(/\s+/g, ' ').trim().slice(0, 200));
      }
    }
  }

  // Bot label per commenter, mirroring getBotAnalytics' reviewerLabel resolution EXACTLY: the
  // account's custom classification label → the vendor's pretty name (known vendors) → the
  // reviewer's display name/login. (Chose the full resolution over login-only: it's a few cheap
  // account-scoped maps and gives the same labels the ROI table shows — no drift.)
  const kindMap = await classificationKindForUser(accountId, scope.workspaceId);
  const classLabel = await classificationLabelMap(accountId, scope.workspaceId);
  const commenterIds = [...new Set(pageRows.flatMap((r) => (r.commenterId != null ? [r.commenterId] : [])))];
  const loginById = new Map<number, string>();
  if (commenterIds.length > 0) {
    for (const r of await db
      .select({ id: users.id, login: users.githubLogin, name: users.displayName })
      .from(users)
      .where(inArray(users.id, commenterIds))
      .execute()) {
      loginById.set(r.id, r.name?.trim() || r.login || `#${r.id}`);
    }
  }
  const botLabelFor = (userId: number | null): string => {
    if (userId == null) return 'Automated';
    const custom = classLabel.get(userId);
    if (custom) return custom;
    const kind = kindMap.get(userId) ?? 'in_house';
    if (kind !== 'in_house' && kind !== 'pierre' && kind !== 'vendor')
      return labelForKind(kind);
    return loginById.get(userId) ?? labelForKind(kind);
  };

  // Bot-only thread-state mix per page PR — only the listing path needs it (the resolve path
  // maps ids only, so skip the extra GROUP BY there). All page PRs carry ≥1 likely_addressed
  // bot thread by the predicate, so every group gets an entry; the route falls back defensively.
  const botCountsByPr =
    threadIds == null
      ? await buildBotThreadCounts([...new Set(pageRows.map((r) => r.prId))], botIds)
      : new Map<number, ThreadStateCounts>();

  const threads: ResolvableBotThreadRow[] = pageRows.map((r) => ({
    threadId: r.threadId,
    threadNodeId: r.threadNodeId,
    path: r.path,
    threadCreatedAt: r.threadCreatedAt.toISOString(),
    prId: r.prId,
    prNumber: r.prNumber,
    prTitle: r.prTitle,
    repoFullName: `${r.owner}/${r.name}`,
    prGithubUrl: `https://github.com/${r.owner}/${r.name}/pull/${r.prNumber}`,
    authorId: r.authorId,
    ciStatus: (r.ciStatus ?? 'unknown') as CiStatus,
    openedAt: r.openedAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    originalCommenterId: r.commenterId,
    excerpt: excerptByThread.get(r.threadId) ?? null,
    botLabel: botLabelFor(r.commenterId),
  }));
  return { threads, totalEligible, botCountsByPr };
}

// The UNCAPPED, PR-centric listing for the "review & clear the stale-bot backlog" tab. Same
// eligibility predicate as getResolvableBotThreadsForScope (owned + automated-reviewer-originated
// + `likely_addressed` + unresolved + carries a node id), grouped by PR, with EVERY resolvable
// thread id per PR (no page cap) + the bot-only thread-state mix. The client sorts, paginates,
// and "Select all"s across the whole backlog; the resolve is chunked into ≤cap-per-POST requests
// (getResolvableBotThreadsForScope re-derives eligibility for each chunk). No excerpts/labels —
// the compact rows don't render per-thread detail, so this stays a lean id-list query even at
// thousands of threads. Account-scoped (binds pullRequests.accountId).
export async function getResolvableBotThreadPrs(
  accountId: number,
  scope: BotScope,
): Promise<{ prs: ResolvableThreadPr[]; totalThreads: number }> {
  if (scope.repoIds.length === 0) return { prs: [], totalThreads: 0 };
  // Same workspace as getResolvableBotThreadsForScope, and it MUST stay the same: the LISTING
  // offers thread ids that the resolve route re-derives through that function, so a judgement
  // scope that differs here would offer threads the server then refuses to resolve.
  const botIds = await automatedReviewerUserIds(accountId, scope.workspaceId, 'review');
  if (botIds.length === 0) return { prs: [], totalThreads: 0 };

  const preds = [
    eq(pullRequests.accountId, accountId),
    inArray(reviewThreads.originalCommenterId, botIds),
    eq(reviewThreads.derivedState, 'likely_addressed'),
    eq(reviewThreads.isResolved, false),
    isNotNull(reviewThreads.githubNodeId),
    inArray(pullRequests.repoId, scope.repoIds),
  ];

  const rows = await db
    .select({
      threadId: reviewThreads.id,
      addressedConfidence: reviewThreads.addressedConfidence,
      prId: pullRequests.id,
      prNumber: pullRequests.number,
      prTitle: pullRequests.title,
      repoId: pullRequests.repoId,
      authorId: pullRequests.authorId,
      ciStatus: pullRequests.ciStatus,
      openedAt: pullRequests.openedAt,
      updatedAt: pullRequests.updatedAt,
      owner: repos.owner,
      name: repos.name,
    })
    .from(reviewThreads)
    .innerJoin(pullRequests, eq(pullRequests.id, reviewThreads.prId))
    .innerJoin(repos, eq(repos.id, pullRequests.repoId))
    .where(and(...preds))
    .orderBy(desc(reviewThreads.createdAt), desc(reviewThreads.id))
    .execute();

  // Group by PR, preserving newest-thread-first order (first-seen PR wins the slot).
  const byPr = new Map<number, ResolvableThreadPr>();
  for (const r of rows) {
    let g = byPr.get(r.prId);
    if (!g) {
      const full = `${r.owner}/${r.name}`;
      g = {
        prId: r.prId,
        prNumber: r.prNumber,
        prTitle: r.prTitle,
        repoId: r.repoId,
        repoFullName: full,
        githubUrl: `https://github.com/${full}/pull/${r.prNumber}`,
        authorId: r.authorId,
        ciStatus: (r.ciStatus ?? 'unknown') as CiStatus,
        openedAt: r.openedAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
        botThreadCounts: emptyCounts(),
        resolvableCount: 0,
        threadIds: [],
        confidenceCounts: { high: 0, medium: 0, low: 0, none: 0 },
        highConfidenceThreadIds: [],
      };
      byPr.set(r.prId, g);
    }
    g.threadIds.push(r.threadId);
    g.resolvableCount += 1;
    g.confidenceCounts[r.addressedConfidence] += 1;
    if (r.addressedConfidence === 'high') g.highConfidenceThreadIds.push(r.threadId);
  }

  const prIds = [...byPr.keys()];
  const counts = await buildBotThreadCounts(prIds, botIds);
  for (const [prId, g] of byPr) g.botThreadCounts = counts.get(prId) ?? emptyCounts();

  return { prs: [...byPr.values()], totalThreads: rows.length };
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
  state: 'open' | 'merged' | 'closed';
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
      state: pullRequests.state,
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
    state: row.state,
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

// Optimistic stamp for a close (not a merge): state → 'closed' + closedAt now. Mirrors
// markPrMergedLocally so the ['pr', id] refetch reflects the close immediately; the next
// sync reconciles from GitHub either way.
export async function markPrClosedLocally(prId: number, accountId: number): Promise<void> {
  await db
    .update(pullRequests)
    .set({ state: 'closed', closedAt: new Date(), mergeStateStatus: 'unknown' })
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

// ── WORKSPACE-GRAIN reviewer resolution ────────────────────────────────────────────────────
//
// A BOT IS A PER-WORKSPACE OBJECT (migrations 0044/0045). ONE `workspace_reviewers` row per
// (account, workspace, actor) carries all three facts: the JUDGEMENT (automated / role /
// confidence / source / reasons), the IDENTITY (kind / label / identity_source) and the PRICE
// (monthly_cents). They used to live in two tables at two grains — the judgement per repo, the
// identity per account — and the split existed only because of that mismatch. With the workspace
// as the only scope they are facts about the same key, so a second table would key on the
// identical three columns and be joined at every call site.
//
// ⚠ THERE IS NO FOLD ANY MORE. Its predecessor read six repo rows and unioned them into one
// answer per actor (automated if ANY row said so; a manual "this is a human" winning only when
// nothing in scope disagreed). One row per (workspace, actor) IS the answer, so every helper below
// is a straight read. Nothing here merges, inherits or deduplicates — the only union rule left in
// the file is the explicitly-named account-wide sweep the cross-org benchmark needs, and it is a
// separate function precisely so no ordinary read can reach it by accident.
//
// THE RULE every helper follows: it takes ONE `workspaceId`. There is no `null` scope, no
// sentinel, and no "no scope at all" — those were the shapes that let one team's override steer
// account-wide reads. `BotScope.repoIds` narrows the DATA a getter measures; it never decides who
// counts as a bot.
//
// ⚠ THE TWO PROVENANCE FLAGS ARE STILL TWO FLAGS. `source` owns automated/role/confidence/
// reasons; `identity_source` owns kind/label. Inside one row that separation is code discipline
// (a narrowed `set:` object) rather than a table boundary, and it is what stops "not a bot here"
// from also un-naming the vendor. `monthly_cents` is owned by neither and has exactly one writer.

// Which automated reviewers a metric counts. `'review'` = real AI code reviewers only (behaviour,
// dedup, the cross-org benchmark); `'all'` = every automated reviewer including quality checks
// (EXCLUSION sets + the feed, where a linter's threads must stay visible).
//
// Two entries in the `'all'` column are there for reasons worth stating, because both look like
// oversights:
//   • getBotAnalytics (ROI) asks for 'all' and then SPLITS the result by role into `vendors` vs
//     `qualityChecks`, rather than filtering. A mis-roled bot therefore stays VISIBLE in its own
//     section where the user can fix it, instead of vanishing from a panel that is the only place
//     to reclassify it.
//   • getBotOnlyReviewPrs asks for 'all' because it answers "did a human look at this before it
//     merged". A PR reviewed only by SonarQube is precisely what it exists to flag; narrowing to
//     'review' would leave it with no qualifying bot review and drop it from the list entirely.
//     ⚠ BOT-ONLY PRs ARE IN THE `'all'` COLUMN, NOT THE `'review'` ONE. The scoring sets narrow
//     because a linter's volume makes a reviewer's numbers lie; this RISK set does not, because a
//     linter's approval is not a human's.
//
// This parameter is REQUIRED and POSITIONAL on automatedReviewerUserIds precisely so every call
// site had to be reviewed individually — confusing the two sets is the defect this feature is most
// likely to ship. See the ReviewerRole comment in shared.
export type ReviewerRoleFilter = 'review' | 'all';

// The global user ids whose login is a known QUALITY-CHECK automation. Mirrors reviewBotUserIds.
// Needed because the role seed only lands on a row once the LAZY classifier has run for that
// reviewer (it runs on GET /api/bot-reviewers, not during sync) — without this, a SonarQube
// account in an untouched install would count as a review bot in every metric.
async function qualityCheckUserIds(): Promise<number[]> {
  const logins = qualityCheckBotLogins();
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

// One actor's stored row in one workspace, as every helper below reads it. It is a ROW, not a
// fold: `resolveJudgements` (per-repo, unioned) and `resolveIdentities` (per-account) merged into
// this the moment both facts landed on the same key.
interface ResolvedReviewer {
  automated: boolean;
  role: ReviewerRole;
  // `source === 'manual' && !automated` — a human said "this is a person". Kept as its own field
  // because it is the one judgement that must beat a known vendor login.
  manualHuman: boolean;
  confidence: ClassificationConfidence;
  source: ClassificationSource;
  reasons: string[];
  kind: AutomatedReviewerKind | null;
  label: string | null;
  identitySource: 'auto' | 'manual';
  monthlyCents: number | null;
  costModel: CostModel;
}

// ONE read of ONE row per actor in ONE workspace. The `workspace_reviewers_account_workspace_idx`
// index serves it directly.
async function resolveWorkspaceReviewers(
  accountId: number,
  workspaceId: number,
): Promise<Map<number, ResolvedReviewer>> {
  const rows = await db
    .select()
    .from(workspaceReviewers)
    .where(
      and(
        eq(workspaceReviewers.accountId, accountId),
        eq(workspaceReviewers.workspaceId, workspaceId),
      ),
    )
    .execute();
  const out = new Map<number, ResolvedReviewer>();
  for (const r of rows) out.set(r.authorUserId, mapResolvedReviewer(r));
  return out;
}

function mapResolvedReviewer(
  r: typeof workspaceReviewers.$inferSelect,
): ResolvedReviewer {
  return {
    automated: r.automated,
    role: (r.role as ReviewerRole | null) ?? 'review',
    manualHuman: r.source === 'manual' && !r.automated,
    confidence: r.confidence as ClassificationConfidence,
    source: r.source as ClassificationSource,
    reasons: r.reasonsJson ?? [],
    kind: (r.kind as AutomatedReviewerKind | null) ?? null,
    label: r.label,
    identitySource: r.identitySource,
    monthlyCents: r.monthlyCents,
    costModel: r.costModel,
  };
}

// THE ACCOUNT-WIDE SWEEP — every workspace's rows, UNIONED per actor. It exists for exactly one
// caller (the cross-org benchmark rollup, which contributes the tenant's whole footprint and has
// no legal single workspace to name) and is a named function rather than a null sentinel so no
// ordinary read can reach it by accident.
//
// The union rule is the old multi-repo one, lifted: automated in ANY workspace ⇒ automated;
// `role: 'review'` in any workspace ⇒ 'review' (a login that lints one workspace and reviews
// another belongs in the reviewer cohort); a manual "this is a human" only counts when NO
// workspace calls the actor automated.
async function resolveReviewersForAccount(
  accountId: number,
): Promise<Map<number, { automated: boolean; role: ReviewerRole; manualHuman: boolean }>> {
  const rows = await db
    .select({
      id: workspaceReviewers.authorUserId,
      automated: workspaceReviewers.automated,
      role: workspaceReviewers.role,
      source: workspaceReviewers.source,
    })
    .from(workspaceReviewers)
    .where(eq(workspaceReviewers.accountId, accountId))
    .execute();
  const out = new Map<number, { automated: boolean; role: ReviewerRole; manualHuman: boolean }>();
  for (const r of rows) {
    const role = (r.role as ReviewerRole | null) ?? 'review';
    const manualHuman = r.source === 'manual' && !r.automated;
    const prev = out.get(r.id);
    if (!prev) {
      out.set(r.id, { automated: r.automated, role, manualHuman });
      continue;
    }
    prev.automated = prev.automated || r.automated;
    if (role === 'review') prev.role = 'review';
    prev.manualHuman = prev.manualHuman || manualHuman;
  }
  return out;
}

// The bot scope for a getter addressed by prId: the PR's repo, and the workspace that repo belongs
// to. Ownership-bound, so a foreign/unknown prId yields null — the conservative answer (nothing is
// classified as a bot) that never discloses whether the PR exists.
export async function botScopeForPr(
  accountId: number,
  prId: number,
): Promise<BotScope | null> {
  const row = (
    await db
      .select({ repoId: pullRequests.repoId })
      .from(pullRequests)
      .where(and(eq(pullRequests.id, prId), eq(pullRequests.accountId, accountId)))
      .limit(1)
      .execute()
  )[0];
  if (!row) return null;
  return workspaceScopeForRepo(accountId, row.repoId);
}

// Every repo this account owns. Still needed by erase/export and by the membership repair — it is
// deliberately NOT a scope: a workspace-scoped read never reaches for it.
export async function accountRepoIds(accountId: number): Promise<number[]> {
  const rows = await db
    .select({ id: repos.id })
    .from(repos)
    .where(eq(repos.accountId, accountId))
    .orderBy(repos.owner, repos.name)
    .execute();
  return rows.map((r) => r.id);
}

// The monthly price recorded for each actor IN THIS WORKSPACE — the stored UNIT in whole US
// DOLLARS (storage is integer cents) plus its reading rule. Under 'flat' the unit IS the monthly
// figure; under 'per_seat' the CALLER multiplies by `workspaceHumanSeatCount` ON READ (the
// product is never stored — it can exceed int4 as cents and would go stale). NULL unit = no price
// set; 0 = "recorded as free". Nothing inherits, so there is no chain behind a `??`.
//
// ⚠ THE CALLER OWNS THE RENDERING RULE THE SCHEMA CANNOT ENFORCE. Within one workspace there is
// exactly one row per actor, so a total over the EFFECTIVE figures is a plain sum. ACROSS
// workspaces it must never be summed: six workspaces each listing a $120 CodeRabbit is either six
// subscriptions or one seen six ways, and the app must not assert which.
//
// Cost is CORE/free: it is read from a core table, so an OSS/npx install can set and see it.
export async function reviewerCostForUser(
  accountId: number,
  workspaceId: number,
): Promise<Map<number, { unitMonthlyUsd: number | null; costModel: CostModel }>> {
  const out = new Map<number, { unitMonthlyUsd: number | null; costModel: CostModel }>();
  for (const [id, r] of await resolveWorkspaceReviewers(accountId, workspaceId))
    out.set(id, {
      unitMonthlyUsd: r.monthlyCents == null ? null : r.monthlyCents / 100,
      costModel: r.costModel,
    });
  return out;
}

// A SEAT: one distinct HUMAN PR author across THIS workspace's repos over the trailing 30 days —
// the grain per-seat vendors meter ("developers who opened PRs"). The window is FIXED rather than
// following whatever analytics window the user is viewing: the price is an invoice-shaped fact,
// and a monthly figure that changed when a chart flipped from 7d to 30d would read as a billing
// bug. Every per-seat derivation (`effectiveMonthlyUsd`, the analytics' effective
// `costMonthlyUsd`) multiplies by this number on read.
const SEAT_WINDOW_DAYS = 30;

// ⚠ THE BOT EXCLUSION IS THE WORKSPACE'S OWN VERDICT, NOT A RAW `users.isBot` PREDICATE — and the
// verdict wins BOTH directions. `isBot` alone under-excludes (rows synced before a login joined
// the known set — the same reason other exclusions in this file filter by LOGIN), so the excluded
// set is `automatedReviewerUserIds` (vendor-login seed ∪ workspace rows) UNION the global
// Bot markers; and a workspace's manual "this is a human" row makes that author a SEAT even where
// the global table types the login a Bot.
//
// TENANCY IS THE JOIN: `workspace_repos (repo_id, account_id)` bound to the PR's own accountId,
// so a foreign or unknown workspace id yields 0 — never another tenant's headcount, and no
// existence oracle. The count keys on the WORKSPACE MEMBERSHIP (like the price itself), never on
// a repoIds narrowing: a per-seat invoice does not shrink because the user filtered a chart.
export async function workspaceHumanSeatCount(
  accountId: number,
  workspaceId: number,
): Promise<number> {
  const since = new Date(Date.now() - SEAT_WINDOW_DAYS * 86_400_000);
  const [automatedIds, resolved, authorRows] = await Promise.all([
    automatedReviewerUserIds(accountId, workspaceId, 'all'),
    resolveWorkspaceReviewers(accountId, workspaceId),
    // The global markers ride the author join rather than a sweep of the GLOBAL `users` table —
    // only the authors actually in scope are ever read.
    db
      .selectDistinct({
        id: pullRequests.authorId,
        isBot: users.isBot,
        githubType: users.githubType,
      })
      .from(pullRequests)
      .innerJoin(
        workspaceRepos,
        and(
          eq(workspaceRepos.repoId, pullRequests.repoId),
          eq(workspaceRepos.accountId, pullRequests.accountId),
        ),
      )
      .innerJoin(users, eq(users.id, pullRequests.authorId))
      .where(
        and(
          eq(pullRequests.accountId, accountId),
          eq(workspaceRepos.workspaceId, workspaceId),
          gte(pullRequests.openedAt, since),
        ),
      )
      .execute(),
  ]);
  const automated = new Set(automatedIds);
  let seats = 0;
  for (const r of authorRows) {
    if (r.id == null) continue;
    // The workspace's manual "this is a human" beats every global marker.
    if (resolved.get(r.id)?.manualHuman) {
      seats += 1;
      continue;
    }
    if (automated.has(r.id)) continue;
    if (r.isBot || r.githubType === 'Bot') continue;
    seats += 1;
  }
  return seats;
}

// The set of automated-reviewer user ids for ONE workspace = known vendor logins (the global
// reviewBotUserIds set) ∪ this workspace's `workspace_reviewers` rows flagged automated, narrowed
// by `role`. getActivity / getWorkspaceInsights' bot_signal / the resolvable-thread getters all
// route through this so in-house-classified reviewers count alongside vendors.
export async function automatedReviewerUserIds(
  accountId: number,
  workspaceId: number,
  role: ReviewerRoleFilter,
): Promise<number[]> {
  const [vendorIds, qcIds, resolved] = await Promise.all([
    reviewBotUserIds(),
    role === 'review' ? qualityCheckUserIds() : Promise.resolve<number[]>([]),
    resolveWorkspaceReviewers(accountId, workspaceId),
  ]);
  return narrowAutomatedIds(vendorIds, qcIds, resolved, role);
}

// The UNION over every one of the account's workspaces. Benchmark-only (see
// resolveReviewersForAccount); a login automated in ANY workspace counts.
export async function automatedReviewerUserIdsForAccount(
  accountId: number,
  role: ReviewerRoleFilter,
): Promise<number[]> {
  const [vendorIds, qcIds, resolved] = await Promise.all([
    reviewBotUserIds(),
    role === 'review' ? qualityCheckUserIds() : Promise.resolve<number[]>([]),
    resolveReviewersForAccount(accountId),
  ]);
  return narrowAutomatedIds(vendorIds, qcIds, resolved, role);
}

// The shared tail of the two functions above: apply the stored verdicts over the vendor-login
// seed, then narrow by role. Split out so the workspace read and the account-wide union cannot
// drift apart on the part that is genuinely identical.
function narrowAutomatedIds(
  vendorIds: number[],
  qcIds: number[],
  resolved: Map<number, { automated: boolean; role: ReviewerRole; manualHuman: boolean }>,
  role: ReviewerRoleFilter,
): number[] {
  const set = new Set<number>(vendorIds);
  for (const [id, r] of resolved) {
    if (r.automated) set.add(id);
    // A manual "this is a human" wins both directions — it removes even a known vendor login from
    // this account's automated set.
    else if (r.manualHuman) set.delete(id);
  }
  if (role === 'all') return [...set];
  // role === 'review': KEEP ONLY the reviewer cohort. An explicit row is authoritative (a user may
  // have flipped a linter back to 'review', or marked a vendor a quality check); otherwise the
  // login seed decides.
  //
  // ⚠ THE TEST IS `=== 'review'`, NOT `!== 'quality_check'`. It was the latter while those were
  // the only two roles, which is the same answer — and became silently wrong the moment
  // `dependency` / `code_agent` / `release` / `housekeeping` joined the union, because every one
  // of them would have passed a "not a quality check" filter straight back into the ROI,
  // behaviour, dedup and benchmark sets. See the ⚠ on `ReviewerRole` in shared.
  const qcDefault = new Set(qcIds);
  return [...set].filter((id) => {
    const r = resolved.get(id);
    if (r) return r.role === 'review';
    return !qcDefault.has(id);
  });
}

// The UNION bot set that "hide bots" hides (the Timeline's excludeBots + the Feed lens): the
// global `users.isBot` flag ∪ this WORKSPACE's automated-reviewer verdict (vendor-login seed +
// `workspace_reviewers` rows flagged automated), with the workspace's manual "this is a human"
// winning BOTH directions — it removes the actor from the set even where the global table flags
// the login a Bot. Either half alone lies: `isBot` misses workspace-classified in-house bots
// (deepsource-io etc.), and the workspace set misses dependabot-style non-review bots the global
// heuristic catches. Per-workspace on purpose — a judgement must never leak across workspaces,
// so the caller passes the REQUEST's resolved scope, never a default.
async function hiddenBotUserIds(
  accountId: number,
  workspaceId: number,
): Promise<number[]> {
  const [globalIds, vendorIds, resolved] = await Promise.all([
    botUserIds(),
    reviewBotUserIds(),
    resolveWorkspaceReviewers(accountId, workspaceId),
  ]);
  // Same verdict rule as narrowAutomatedIds (role 'all'), applied over BOTH halves of the
  // union — a manualHuman row must also subtract a `users.isBot` id, which the automated
  // helpers alone cannot express (they never see the global flag).
  const set = new Set<number>([...globalIds, ...vendorIds]);
  for (const [id, r] of resolved) {
    if (r.automated) set.add(id);
    else if (r.manualHuman) set.delete(id);
  }
  return [...set];
}

// Map every automated reviewer in ONE workspace → its AutomatedReviewerKind, for grouping
// analytics / bot_signal / dedup. A known vendor login wins; else the stored kind; else
// 'in_house'. NOT role-filtered — callers narrow by the id set from automatedReviewerUserIds, and
// the quality-check SECTION of the ROI panel needs the kinds of the very rows the metrics exclude.
//
// ⚠ IDENTITY IS PER WORKSPACE NOW. The same login may legitimately be named `coderabbit` in one
// workspace and left unnamed in another; nothing reconciles them and nothing is meant to. A colour
// or label lookup must therefore be built from the ACTIVE workspace's answer.
export async function classificationKindForUser(
  accountId: number,
  workspaceId: number,
): Promise<Map<number, AutomatedReviewerKind>> {
  const resolved = await resolveWorkspaceReviewers(accountId, workspaceId);
  const map = await vendorLoginKindMap();
  for (const [id, r] of resolved) {
    if (!r.automated) {
      // A manual "this is a human" unmakes even a vendor login's kind.
      if (r.manualHuman) map.delete(id);
      continue;
    }
    if (map.has(id)) continue;
    map.set(id, r.kind ?? 'in_house');
  }
  return map;
}

// The ACCOUNT-WIDE kind map — the second helper the cross-org benchmark needs, and the single
// highest data-integrity stake in this file: the value decides what leaves the tenant into a
// CROSS-ORG benchmark and cannot be un-shipped.
//
// ⚠ IDENTITY IS PER WORKSPACE, so an actor can legitimately be `coderabbit` in A and null in B.
// THE TIE-BREAK IS WRITTEN, NOT INCIDENTAL: a NON-NULL vendor kind in any workspace WINS, and ties
// among non-null kinds are broken by the LOWEST workspace id. A known vendor login still wins over
// everything, and a manual "this is a human" in every workspace still removes the actor.
// (`vendorKindOf` at the call site drops in_house/pierre/vendor, so only real vendor kinds are
// ever emitted.)
export async function classificationKindForUserForAccount(
  accountId: number,
): Promise<Map<number, AutomatedReviewerKind | null>> {
  const rows = await db
    .select({
      id: workspaceReviewers.authorUserId,
      workspaceId: workspaceReviewers.workspaceId,
      automated: workspaceReviewers.automated,
      source: workspaceReviewers.source,
      kind: workspaceReviewers.kind,
    })
    .from(workspaceReviewers)
    .where(eq(workspaceReviewers.accountId, accountId))
    .orderBy(asc(workspaceReviewers.workspaceId))
    .execute();

  const vendorMap = await vendorLoginKindMap();
  const out = new Map<number, AutomatedReviewerKind | null>(vendorMap);
  // Ordered by workspaceId asc, so "first non-null wins" IS "lowest workspace id breaks ties".
  const stored = new Map<number, AutomatedReviewerKind | null>();
  const automatedAnywhere = new Set<number>();
  const manualHumanEverywhere = new Map<number, boolean>();
  for (const r of rows) {
    if (r.automated) automatedAnywhere.add(r.id);
    const manualHuman = r.source === 'manual' && !r.automated;
    manualHumanEverywhere.set(r.id, (manualHumanEverywhere.get(r.id) ?? false) || manualHuman);
    const kind = (r.kind as AutomatedReviewerKind | null) ?? null;
    if (kind != null && stored.get(r.id) == null) stored.set(r.id, kind);
    else if (!stored.has(r.id)) stored.set(r.id, null);
  }
  for (const [id, kind] of stored) {
    if (!automatedAnywhere.has(id)) {
      if (manualHumanEverywhere.get(id)) out.delete(id);
      continue;
    }
    if (out.has(id)) continue;
    out.set(id, kind ?? 'in_house');
  }
  return out;
}

// Known vendor logins (the GLOBAL users table) → their vendor kind. The seed both kind maps start
// from; a login is one vendor everywhere, which is a fact about the LOGIN, not about a workspace.
async function vendorLoginKindMap(): Promise<Map<number, AutomatedReviewerKind>> {
  const map = new Map<number, AutomatedReviewerKind>();
  const logins = reviewBotLogins();
  if (logins.length === 0) return map;
  const candidates = [...logins, ...logins.map((l) => `${l}[bot]`)];
  const inList = sql.join(
    candidates.map((c) => sql`${c}`),
    sql`, `,
  );
  const rows = await db
    .select({ id: users.id, login: users.githubLogin })
    .from(users)
    .where(sql`lower(${users.githubLogin}) in (${inList})`)
    .execute();
  for (const r of rows) {
    const kind = reviewBotKind(r.login);
    if (kind) map.set(r.id, kind);
  }
  return map;
}

// The workspace's custom reviewer LABELS. WORKSPACE-GRAIN now — a human-set display name lives on
// the same row as everything else, so the same login may carry a different name in another
// workspace. Replaces the six hand-rolled inline reads that used to sit in the analytics getters.
export async function classificationLabelMap(
  accountId: number,
  workspaceId: number,
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  for (const [id, r] of await resolveWorkspaceReviewers(accountId, workspaceId)) {
    const label = r.label?.trim();
    if (label) out.set(id, label);
  }
  return out;
}

// Resolved ReviewerRole per automated reviewer in ONE workspace (explicit row → login seed →
// 'review'). Used where a surface must SPLIT the two sets rather than filter to one —
// getBotAnalytics computes every automated reviewer's row and then routes quality checks into
// their own excluded section.
// The actors a HUMAN has explicitly vouched for in this workspace (`source === 'manual' &&
// !automated`). Exported because that judgement must beat every automated signal, and any caller
// building its own union of automation signals has to be able to subtract it — otherwise a global
// `users.isBot` or a bot-ish login silently overrules the person who said "this is a colleague".
//
// It reads `manualHuman` from `resolveWorkspaceReviewers` rather than re-deriving the predicate,
// so there stays exactly ONE definition of what a manual human is.
export async function manualHumanUserIds(
  accountId: number,
  workspaceId: number,
): Promise<number[]> {
  const resolved = await resolveWorkspaceReviewers(accountId, workspaceId);
  return [...resolved].filter(([, r]) => r.manualHuman).map(([id]) => id);
}

export async function reviewerRoleForUser(
  accountId: number,
  workspaceId: number,
): Promise<Map<number, ReviewerRole>> {
  const [qcIds, resolved] = await Promise.all([
    qualityCheckUserIds(),
    resolveWorkspaceReviewers(accountId, workspaceId),
  ]);
  const out = new Map<number, ReviewerRole>();
  for (const id of qcIds) out.set(id, 'quality_check');
  for (const [id, r] of resolved) out.set(id, r.role);
  return out;
}

// The actors whose ROLE a human set by hand in this workspace — `source === 'manual'`, which is
// the provenance flag that owns the whole JUDGEMENT half (automated + role + confidence +
// reasons), so a manual judgement necessarily means the role was chosen rather than derived.
//
// It exists because `resolveActorLanes` has to distinguish "this row says 'review' because a
// person picked Review bot" from "this row says 'review' because that is the default a login we
// have never heard of gets". Those are the same stored byte and opposite facts: the first must
// beat every login vocabulary, the second must lose to all of them. Without this reader the
// resolver would either ignore manual role choices (a user marks Copilot a code agent and the
// report keeps filing it under AI review) or obey stale defaults over known logins.
//
// Automated rows ONLY. A manual `automated: false` is a manual HUMAN, which `manualHumanUserIds`
// already owns and which wins earlier in the resolver — including it here would hand a person a
// bot lane via whatever `role` their row happens to carry.
export async function manualRoleUserIds(
  accountId: number,
  workspaceId: number,
): Promise<Map<number, ReviewerRole>> {
  const resolved = await resolveWorkspaceReviewers(accountId, workspaceId);
  const out = new Map<number, ReviewerRole>();
  for (const [id, r] of resolved) {
    if (r.source === 'manual' && r.automated) out.set(id, r.role);
  }
  return out;
}

// Best-effort review-body / comment severity inference from the account's fingerprint
// vocabulary. Coarse buckets only (nitpick / issue / refactor); null when unknowable.
// Used for the dedup conflict signal.
function inferSeverity(text: string | null | undefined): string | null {
  if (!text) return null;
  if (/\bnit(?:pick|:)|🧹/i.test(text)) return 'nitpick';
  if (/⚠️|potential issue|\bbug\b|security|vulnerab|\berror\b/i.test(text)) return 'issue';
  if (/🛠️|refactor|\bsuggestion\b|\bconsider\b/i.test(text)) return 'refactor';
  return null;
}

// The path bucket a deterministic tuning suggestion groups by: the top-level dir as a
// `<seg>/**` glob, or the file path itself when it's at root. Advisory only (the pathGlob
// rides along in the suggestion for display; nothing matches against it anymore).
function pathBucket(path: string): string {
  const seg = path.split('/')[0];
  return seg && seg !== path ? `${seg}/**` : path;
}

// The BASE acted-on predicate over a thread's derived state: resolved, or likely_addressed
// (the commit heuristic). The MERGED headline definition additionally ORs "a human followed
// up after the bot's last comment" — a per-thread set the caller builds from the thread's
// comments; the weekly trend deliberately uses only this base form (a follow-up scan over the
// full 84-day span would be a second heavy pass for a sparkline). One predicate, shared by
// getBotAnalytics and getAdvisorFindings, so the two surfaces can never disagree about what
// "acted on" means.
//
// ⚠ Its counterpart is NOT `!isActedOnThreadState`: "not acted on" is `state === 'untouched'`
// EXACTLY, because `replied_unresolved` is neither (someone answered and then nothing happened).
// Every caller in this file already spells that literal for that reason.
function isActedOnThreadState(state: DerivedState | string): boolean {
  return state === 'resolved' || state === 'likely_addressed';
}

// The overdue grace window: a not-addressed (untouched) thread only counts as overdue — and only
// then feeds the 'noisy' verdict — once it's older than this. A FIXED 36h, NOT the measured reply
// time: the reply-time sample is intrinsically fast (only threads someone engaged with ever draw a
// reply; ignored ones never do), so a measured norm gives almost no grace. Flat + predictable.
const OVERDUE_GRACE_MS = 36 * 60 * 60 * 1000;

// THE ML nit-ratio gates — ONE pair, read by BOTH the tuning suggestion and `botVerdict`'s
// escalation below. They are deliberately not two pairs: the chip and the suggestion make the
// same claim about the same bot ("this one is mostly nits"), and a drift between them would show
// up as a row whose verdict says 'keep' while the advisory underneath it says to tune.
// FINDINGS, not labelled — summaries/praise are not findings — and a real sample floor so a bot
// is never judged on a handful of scored comments.
const ML_NIT_MIN_FINDINGS = 20;
const ML_NIT_MIN_SHARE = 0.7;

const ML_SEVERITY_KEYS: MlSeverity[] = ['nit', 'minor', 'major', 'critical'];
function emptyMlSeverityCounts(): MlSeverityCounts {
  return { nit: 0, minor: 0, major: 0, critical: 0 };
}

// Gates on the same-line-overlap tuning suggestion (ADVISORY — pair-level redundancy hint;
// botVerdict never reads overlap). The share is of the bot's window threads landing in ≥2-bot
// clusters (the shared ±3-line definition — db/line-overlap.ts), with a volume floor so two
// bots are never called redundant over a handful of threads.
const OVERLAP_SUGGESTION_MIN_SHARE = 0.4;
const OVERLAP_SUGGESTION_MIN_THREADS = 5;

// ── Bot Tuning Advisor cell-emission floors (CORE — the same family as the gates above) ─────
// getAdvisorFindings emits evidence CELLS; these floors gate emission so the advisor is never
// arguing from a handful of threads. They are CELL floors only — the thresholds that turn a
// cell into a recommendation (suppress/amplify decisions) live in the plugin's intents.ts;
// AMPLIFY's acted-on bar lives HERE because the plugin must not invent a second definition of
// "well acted on" (it is echoed on the wire via `floors`).
const ADVISOR_MIN_CELL_THREADS = 5; // same claim as the path-suggestion volume gate below
const ADVISOR_MIN_CELL_FINDINGS = 20; // same bar as ML_NIT_MIN_FINDINGS — a real label sample
const ADVISOR_AMPLIFY_MIN_ACTED_PCT = 70;
const ADVISOR_SAMPLE_CAP = 5; // sample PR/thread ids carried per cell for evidence deep links

// keep / tune / noisy verdict (deterministic rule-of-thumb, no AI): high volume + low
// acted-on + a high share of OVERDUE-untouched threads (untouched AND aged past the account-
// wide normal response window) → noisy; moderate low acted-on → tune; else keep. The overdue
// gate is what stops a bot being called noisy for threads the workspace simply hasn't reached yet.
//
// ── THE ONE ML INPUT: a nit-heavy bot can be ESCALATED 'keep' → 'tune' ──────────────────────
// A bot whose threads all get answered looks perfect to the thread math, and that is exactly the
// bot whose severity floor is set too low: the team is doing the work of triaging nits. The ML
// fold is the only signal that sees it, so it speaks here as well as in the suggestion (same
// gates, `ML_NIT_MIN_*` — one pair, so the chip and the advisory cannot contradict each other).
//
// ⚠ ESCALATION ONLY, AND ONLY TO 'tune'. The label is advisory (macro-F1 ≈ 0.66), so it may
// never make a bot look WORSE than the thread math already found it ('noisy' stays 'noisy',
// 'tune' stays 'tune') and it can never PRODUCE 'noisy' — "mostly nits" is a tuning fact, not
// evidence the bot is being ignored. `nits` is the FINDINGS-only nit count (summaries and praise
// are excluded upstream by the fold), and the bot's OWN declared severity is never an input to
// it — that stored badge is display-only, and on the gold-300 it is the worst of the three
// raters (see docs/ML-SEVERITY.md § Accuracy).
function botVerdict(
  threads: number,
  actedOnPct: number | null,
  overdueUntouched: number,
  ml?: { findings: number; nits: number } | null,
): BotVerdict {
  const overdueRatio = threads > 0 ? overdueUntouched / threads : 0;
  const highVolume = threads >= 10;
  const lowActedOn = actedOnPct != null && actedOnPct < 30;
  const highOverdue = overdueRatio >= 0.5;
  if (highVolume && lowActedOn && highOverdue) return 'noisy';
  if (threads >= 5 && actedOnPct != null && actedOnPct < 60) return 'tune';
  if (
    ml != null &&
    ml.findings >= ML_NIT_MIN_FINDINGS &&
    ml.nits / ml.findings >= ML_NIT_MIN_SHARE
  )
    return 'tune';
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

// THE BOT LISTING — one `WorkspaceReviewer` per actor with a footprint in the scoped repos (or
// already carrying a stored row in this workspace). Judgement, identity, price and evidence all
// ride on the one object, because with the workspace as the only scope they are facts about the
// same key. Runs the lazy resolver for not-yet-classified actors (which persists rows).
// Account-scoped.
//
// ⚠ THERE IS NOTHING LEFT TO DEDUPLICATE. Its predecessor returned one `rows` entry per (repo,
// actor) plus one `reviewers` entry per actor, and a vendor running on six repos appeared six
// times ON PURPOSE, because the judgement could legitimately differ per repo. It cannot any more:
// one workspace, one row, one card. What the six repos still buy is `repoFootprints[]` — the blast
// radius of an edit that is workspace-wide by design.
//
// ── SCOPE ───────────────────────────────────────────────────────────────────────────────────
// `scope.workspaceId` decides the VERDICT; `scope.repoIds` narrows the FOOTPRINT display and drops
// reviewers with no footprint in those repos. They can no longer disagree because they answer
// different questions — and `scope` came from `resolveWorkspaceScope`, so the narrowing is already
// bounded by the workspace's membership. That bound is what stops
// `?workspace=5&repoIds=<repo of workspace 9>` from enumerating one workspace's footprints while
// the lazy classifier writes rows keyed to another.
//
// The response echoes the repos it covered (`repoIds`), which is what makes an empty `reviewers`
// legible: `[]` means "this workspace has no repos — go move some in", a non-empty list with no
// reviewers means "these repos have no reviewers yet".
//
// ⚠ THE PER-REPO BOTS TAB DOES NOT USE THE NARROWING. It fetches the WORKSPACE listing and filters
// client-side, so each card can show its full `repoFootprints[]`. Server-side narrowing would
// leave exactly one entry in that array and reduce the blast-radius disclosure to a line of copy
// asserting something the UI cannot show.
//
// ── FOOTPRINT ───────────────────────────────────────────────────────────────────────────────
// An actor is LISTED when they ever submitted a review, opened an inline thread or left an issue
// comment on a PR in one of the scoped repos. Rows are NEVER fabricated for an actor with no
// footprint anywhere in the workspace: such a row is not a bot object, it is an invented one —
// and, because `author_user_id` points at the GLOBAL `users` table, inventing one would turn this
// listing into a cross-tenant profile lookup (the exact shape `listUsers(accountId)` exists to
// prevent). An actor with a stored row but no remaining footprint still lists, with zeroed counts:
// that is a judgement someone recorded for a workspace the reviewer no longer touches, and the
// numbers say so without needing a flag.
//
// The COUNTS are a rolling 90 days (so the caption reflects current volume); `lastActiveAt` is
// ALL-TIME, so a long-dormant bot still reports when it last ran.
export async function listDetectedReviewers(
  accountId: number,
  scope: BotScope,
): Promise<DetectedReviewersResponse> {
  const generatedAt = new Date().toISOString();
  const { workspaceId } = scope;
  // ⚠ RE-INTERSECT, even though `resolveWorkspaceScope` already did. This is the ONE function that
  // WRITES rows keyed to `workspaceId` off a footprint derived from `repoIds`, so a transposed
  // scope here does not merely read the wrong repos — it FABRICATES bot objects in a workspace the
  // actor has never touched, which the anti-fabrication rule exists to forbid. Holding that
  // invariant one caller away (a convention every future call site must remember) is what turns a
  // one-line mistake into stored, displayed, editable junk. Two cheap reads make it structural.
  const membership = new Set(await getWorkspaceRepoIds(workspaceId, accountId));
  const scopeRepoIds = scope.repoIds.filter((id) => membership.has(id));
  if (scopeRepoIds.length === 0) {
    // Still the WORKSPACE's seat count, not the (empty) narrowing's: seats key on membership.
    return {
      workspaceId,
      reviewers: [],
      repoIds: scopeRepoIds,
      workspaceSeatCount: await workspaceHumanSeatCount(accountId, workspaceId),
      generatedAt,
    };
  }

  const since90 = new Date(Date.now() - 90 * 86_400_000);
  const scopePred = inArray(pullRequests.repoId, scopeRepoIds);

  // ── FOOTPRINT: three sources × (all-time last activity, 90-day count), per (repo, actor) ────
  // Six grouped queries rather than one clever aggregate: `count(*) FILTER (WHERE …)` is not
  // portable, and a settings listing is not a hot path. Each binds pullRequests.accountId, so
  // tenancy holds even before the repo scope narrows. Grouping stays per (repo, actor) because the
  // card needs BOTH the workspace total and the per-repo breakdown.
  const [revLast, revCount, thLast, thCount, cmLast, cmCount] = await Promise.all([
    db
      .select({
        repoId: pullRequests.repoId,
        userId: reviews.authorId,
        last: max(reviews.submittedAt),
      })
      .from(reviews)
      .innerJoin(pullRequests, eq(pullRequests.id, reviews.prId))
      .where(and(eq(pullRequests.accountId, accountId), scopePred, isNotNull(reviews.authorId)))
      .groupBy(pullRequests.repoId, reviews.authorId)
      .execute(),
    db
      .select({ repoId: pullRequests.repoId, userId: reviews.authorId, c: count() })
      .from(reviews)
      .innerJoin(pullRequests, eq(pullRequests.id, reviews.prId))
      .where(
        and(
          eq(pullRequests.accountId, accountId),
          scopePred,
          isNotNull(reviews.authorId),
          gte(reviews.submittedAt, since90),
        ),
      )
      .groupBy(pullRequests.repoId, reviews.authorId)
      .execute(),
    db
      .select({
        repoId: pullRequests.repoId,
        userId: reviewThreads.originalCommenterId,
        last: max(reviewThreads.createdAt),
      })
      .from(reviewThreads)
      .innerJoin(pullRequests, eq(pullRequests.id, reviewThreads.prId))
      .where(
        and(
          eq(pullRequests.accountId, accountId),
          scopePred,
          isNotNull(reviewThreads.originalCommenterId),
        ),
      )
      .groupBy(pullRequests.repoId, reviewThreads.originalCommenterId)
      .execute(),
    db
      .select({
        repoId: pullRequests.repoId,
        userId: reviewThreads.originalCommenterId,
        c: count(),
      })
      .from(reviewThreads)
      .innerJoin(pullRequests, eq(pullRequests.id, reviewThreads.prId))
      .where(
        and(
          eq(pullRequests.accountId, accountId),
          scopePred,
          isNotNull(reviewThreads.originalCommenterId),
          gte(reviewThreads.createdAt, since90),
        ),
      )
      .groupBy(pullRequests.repoId, reviewThreads.originalCommenterId)
      .execute(),
    // Issue-level PR commenters too. A comment-only automated account — e.g. golang's gopherbot,
    // which posts issue comments but never a formal review or inline thread — would otherwise be
    // invisible here and could never be classified. These take the CHEAP classification path
    // below (no behavioral-evidence query — with no reviews there is none).
    db
      .select({
        repoId: pullRequests.repoId,
        userId: prComments.authorId,
        last: max(prComments.createdAt),
      })
      .from(prComments)
      .innerJoin(pullRequests, eq(pullRequests.id, prComments.prId))
      .where(and(eq(pullRequests.accountId, accountId), scopePred, isNotNull(prComments.authorId)))
      .groupBy(pullRequests.repoId, prComments.authorId)
      .execute(),
    db
      .select({ repoId: pullRequests.repoId, userId: prComments.authorId, c: count() })
      .from(prComments)
      .innerJoin(pullRequests, eq(pullRequests.id, prComments.prId))
      .where(
        and(
          eq(pullRequests.accountId, accountId),
          scopePred,
          isNotNull(prComments.authorId),
          gte(prComments.createdAt, since90),
        ),
      )
      .groupBy(pullRequests.repoId, prComments.authorId)
      .execute(),
  ]);

  const pairKey = (repoId: number, userId: number): string => `${repoId}:${userId}`;
  interface Foot {
    repoId: number;
    userId: number;
    reviews: number;
    threads: number;
    comments: number;
    lastActiveAt: Date | null;
    // Submitted a review or opened an inline thread here — the population that earns the full
    // evidence-based classification. A comment-only actor takes the cheap path.
    reviewerHere: boolean;
  }
  const foot = new Map<string, Foot>();
  const touch = (repoId: number, userId: number): Foot => {
    const k = pairKey(repoId, userId);
    let f = foot.get(k);
    if (!f) {
      f = {
        repoId,
        userId,
        reviews: 0,
        threads: 0,
        comments: 0,
        lastActiveAt: null,
        reviewerHere: false,
      };
      foot.set(k, f);
    }
    return f;
  };
  const laterOf = (a: Date | null, b: Date | null): Date | null =>
    a == null ? b : b == null ? a : a.getTime() >= b.getTime() ? a : b;
  for (const r of revLast) {
    if (r.userId == null) continue;
    const f = touch(r.repoId, r.userId);
    f.lastActiveAt = laterOf(f.lastActiveAt, r.last);
    f.reviewerHere = true;
  }
  for (const r of thLast) {
    if (r.userId == null) continue;
    const f = touch(r.repoId, r.userId);
    f.lastActiveAt = laterOf(f.lastActiveAt, r.last);
    f.reviewerHere = true;
  }
  for (const r of cmLast) {
    if (r.userId == null) continue;
    const f = touch(r.repoId, r.userId);
    f.lastActiveAt = laterOf(f.lastActiveAt, r.last);
  }
  for (const r of revCount) if (r.userId != null) touch(r.repoId, r.userId).reviews = r.c;
  for (const r of thCount) if (r.userId != null) touch(r.repoId, r.userId).threads = r.c;
  for (const r of cmCount) if (r.userId != null) touch(r.repoId, r.userId).comments = r.c;

  // ── STORED ROWS in this workspace ─────────────────────────────────────────────────────────
  // A stored row with no surviving footprint still lists (zeroed counts): the judgement is still
  // steering every metric computed over this workspace, and a row that governs but cannot be seen
  // is the support question this listing exists to pre-empt.
  const storedRows = await db
    .select()
    .from(workspaceReviewers)
    .where(
      and(
        eq(workspaceReviewers.accountId, accountId),
        eq(workspaceReviewers.workspaceId, workspaceId),
      ),
    )
    .execute();
  const storedByUser = new Map(storedRows.map((r) => [r.authorUserId, r]));

  // Aggregate the per-(repo, actor) footprints into per-actor totals + the per-repo breakdown.
  interface ActorFoot {
    userId: number;
    total: { reviews: number; threads: number; comments: number; lastActiveAt: Date | null };
    perRepo: Foot[];
    reviewerAnywhere: boolean;
  }
  const actors = new Map<number, ActorFoot>();
  const touchActor = (userId: number): ActorFoot => {
    let a = actors.get(userId);
    if (!a) {
      a = {
        userId,
        total: { reviews: 0, threads: 0, comments: 0, lastActiveAt: null },
        perRepo: [],
        reviewerAnywhere: false,
      };
      actors.set(userId, a);
    }
    return a;
  };
  for (const f of foot.values()) {
    const a = touchActor(f.userId);
    a.total.reviews += f.reviews;
    a.total.threads += f.threads;
    a.total.comments += f.comments;
    a.total.lastActiveAt = laterOf(a.total.lastActiveAt, f.lastActiveAt);
    a.reviewerAnywhere = a.reviewerAnywhere || f.reviewerHere;
    a.perRepo.push(f);
  }
  // A stored row with no footprint left anywhere in the workspace still gets an (empty) actor.
  for (const r of storedRows) touchActor(r.authorUserId);

  if (actors.size === 0) {
    // No reviewers is not "no seats": the repos may hold plenty of human PR authors.
    return {
      workspaceId,
      reviewers: [],
      repoIds: scopeRepoIds,
      workspaceSeatCount: await workspaceHumanSeatCount(accountId, workspaceId),
      generatedAt,
    };
  }

  const userIds = [...actors.keys()];
  const userRows = await db.select().from(users).where(inArray(users.id, userIds)).execute();
  const userById = new Map(userRows.map((u) => [u.id, u]));

  // ── LAZY CLASSIFICATION — ONCE PER ACTOR, PER WORKSPACE ───────────────────────────────────
  // The trigger is "an actor with a footprint in this workspace and NO stored row for it" — one
  // derivation per actor instead of one per repo, which makes this page strictly cheaper than its
  // predecessor. Every strong signal (vendor login, users.githubType, app attribution, the
  // branded-marker fingerprint) is a property of the ACTOR, so per-repo derivation only ever
  // multiplied the work — and the BILLED Haiku tie-break — for an identical answer.
  //
  // ⚠ IT CANNOT FABRICATE. An actor reaches this loop only via `foot`, which is built from real
  // reviews / inline threads / PR comments on PRs in the scoped repos, and the scoped repos are
  // bounded by the workspace's membership. `reviewerAnywhere === false && perRepo.length === 0`
  // is a stored-row-only actor and is skipped: there is nothing new to derive, and deriving it
  // would rewrite a row nobody asked about.
  for (const a of actors.values()) {
    if (storedByUser.has(a.userId)) continue; // already judged in this workspace
    if (a.perRepo.length === 0) continue; // stored-row-only actor (unreachable given the above)
    const u = userById.get(a.userId);
    if (!u) continue;
    if (a.reviewerAnywhere) {
      const evidence = await reviewerEvidence(accountId, a.userId);
      await classifyReviewer(
        accountId,
        { id: u.id, githubLogin: u.githubLogin, githubType: u.githubType, isBot: u.isBot },
        evidence,
        [workspaceId],
      );
    } else if (
      // Comment-only account. Skip the behavioral-evidence query (there are no reviews to score).
      // Still run the CHEAP hard-signal classifier for the few that clearly look automated (known
      // vendor login / GitHub Bot type / service-account login pattern) so a comment-only vendor
      // or app bot is still auto-badged.
      u.isBot ||
      u.githubType === 'Bot' ||
      reviewBotKind(u.githubLogin) != null ||
      matchesAutomatedLoginPattern(u.githubLogin)
    ) {
      await classifyReviewer(
        accountId,
        { id: u.id, githubLogin: u.githubLogin, githubType: u.githubType, isBot: u.isBot },
        {},
        [workspaceId],
      );
    } else {
      // A plain human commenter. Persist a low-confidence "not automated" row so the actor has a
      // real object behind it (the row IS the bot object; an actor with no row is not listable and
      // could never be corrected by hand).
      await persistHumanJudgement(accountId, [workspaceId], u.id, u.githubLogin);
    }
  }

  // Re-read now that the lazy pass has written. One extra query, and it is what makes the response
  // reflect what is actually stored rather than what we think we wrote.
  const finalRows = await db
    .select()
    .from(workspaceReviewers)
    .where(
      and(
        eq(workspaceReviewers.accountId, accountId),
        eq(workspaceReviewers.workspaceId, workspaceId),
      ),
    )
    .execute();
  const rowByUser = new Map(finalRows.map((r) => [r.authorUserId, r]));

  // Most-recent non-empty review body per actor in the scoped repos — the "why we think this is a
  // bot" evidence, so it must come from THIS workspace.
  const sampleRows = await db
    .select({
      authorId: reviews.authorId,
      body: reviews.body,
      submittedAt: reviews.submittedAt,
    })
    .from(reviews)
    .innerJoin(pullRequests, eq(pullRequests.id, reviews.prId))
    .where(
      and(
        eq(pullRequests.accountId, accountId),
        scopePred,
        inArray(reviews.authorId, userIds),
        isNotNull(reviews.body),
      ),
    )
    .orderBy(desc(reviews.submittedAt))
    .execute();
  const sampleByUser = new Map<number, string>();
  for (const r of sampleRows) {
    if (r.authorId == null) continue;
    if (sampleByUser.has(r.authorId)) continue; // newest wins (ordered desc)
    const body = (r.body ?? '').trim();
    if (body) sampleByUser.set(r.authorId, body.length > 400 ? `${body.slice(0, 399)}…` : body);
  }

  // ONE seat count per response — it feeds every per-seat row below, and it is computed AFTER the
  // lazy pass so a bot first classified by this very listing is already out of the count.
  const workspaceSeatCount = await workspaceHumanSeatCount(accountId, workspaceId);

  const reviewers: WorkspaceReviewer[] = [];
  for (const a of actors.values()) {
    const stored = rowByUser.get(a.userId);
    if (!stored) continue; // the classifier declined to write (unknown user) — nothing to show
    const u = userById.get(a.userId);
    if (!u) continue;
    reviewers.push(
      mapWorkspaceReviewer(
        stored,
        u,
        {
          footprint: footprintOf(a.total),
          repoFootprints: a.perRepo
            .slice()
            .sort((x, y) => x.repoId - y.repoId)
            .map((f) => ({ repoId: f.repoId, ...footprintOf(f) })),
          sampleReviewBody: sampleByUser.get(a.userId) ?? null,
        },
        workspaceSeatCount,
      ),
    );
  }

  // Automated first, then by 90-day thread volume desc, then label — a stable order.
  reviewers.sort(
    (a, b) =>
      Number(b.automated) - Number(a.automated) ||
      b.footprint.threads - a.footprint.threads ||
      a.label.localeCompare(b.label) ||
      a.login.localeCompare(b.login),
  );

  return { workspaceId, reviewers, repoIds: scopeRepoIds, workspaceSeatCount, generatedAt };
}

function footprintOf(f: {
  reviews: number;
  threads: number;
  comments: number;
  lastActiveAt: Date | null;
}): ReviewerFootprint {
  return {
    reviews: f.reviews,
    threads: f.threads,
    comments: f.comments,
    lastActiveAt: f.lastActiveAt ? f.lastActiveAt.toISOString() : null,
  };
}

// The wire form of one `workspace_reviewers` row. Display-name resolution is fixed here so every
// surface agrees: a human-set label → the vendor's brand name → the login.
function mapWorkspaceReviewer(
  row: typeof workspaceReviewers.$inferSelect,
  u: { id: number; githubLogin: string; displayName: string | null; avatarUrl: string | null },
  evidence: {
    footprint: ReviewerFootprint;
    repoFootprints: RepoReviewerFootprintEntry[];
    sampleReviewBody: string | null;
  },
  // The workspace's derived seat count — computed ONCE by the caller (once per listing, once per
  // single-reviewer echo), never per row: it is one number for the whole workspace.
  seatCount: number,
): WorkspaceReviewer {
  const kind = (row.kind as AutomatedReviewerKind | null) ?? null;
  const label =
    row.label?.trim() ||
    (kind && kind !== 'in_house' ? labelForKind(kind) : null) ||
    u.githubLogin;
  // NULL = no price set, 0 = free. Nothing inherits, so there is no third state to resolve.
  const unitUsd = row.monthlyCents == null ? null : row.monthlyCents / 100;
  return {
    workspaceId: row.workspaceId,
    userId: u.id,
    login: u.githubLogin,
    displayName: u.displayName,
    avatarUrl: u.avatarUrl,
    automated: row.automated,
    role: (row.role as ReviewerRole | null) ?? 'review',
    confidence: row.confidence as ClassificationConfidence,
    source: row.source as ClassificationSource,
    reasons: row.reasonsJson ?? [],
    isManualOverride: row.source === 'manual',
    kind,
    label,
    identitySource: row.identitySource,
    costMonthlyUsd: unitUsd,
    // Read via the stored reading rule; a per-seat price is 'flat' by construction once cleared.
    ...priceReading(unitUsd, row.costModel, seatCount),
    footprint: evidence.footprint,
    repoFootprints: evidence.repoFootprints,
    sampleReviewBody: evidence.sampleReviewBody,
  };
}

// unit × seats, ON READ — the one place the per-seat multiplication happens for the reviewer wire
// (the analytics row does the same arithmetic against its own map). The product stays in JS
// dollars (binary64) and is re-rounded to the cent; it is NEVER stored, because seats × cents can
// exceed int4 and a stored copy would go stale as the team changes.
function priceReading(
  unitUsd: number | null,
  costModel: CostModel,
  seatCount: number,
): { costModel: CostModel; effectiveMonthlyUsd: number | null } {
  return {
    costModel,
    effectiveMonthlyUsd:
      unitUsd == null
        ? null
        : costModel === 'per_seat'
          ? Math.round(unitUsd * seatCount * 100) / 100
          : unitUsd,
  };
}

// Read ONE stored row as the wire serves it, with its evidence recomputed. Used by all four write
// routes to echo the row they just wrote. Returns null when the row or the user is gone.
//
// The footprint is recomputed rather than carried because the write routes have no listing in
// hand, and a card rendered with a stale (or absent) blast radius is exactly what the
// `repoFootprints[]` disclosure exists to prevent.
async function readWorkspaceReviewer(
  accountId: number,
  workspaceId: number,
  userId: number,
): Promise<WorkspaceReviewer | null> {
  const [row] = await db
    .select()
    .from(workspaceReviewers)
    .where(
      and(
        eq(workspaceReviewers.accountId, accountId),
        eq(workspaceReviewers.workspaceId, workspaceId),
        eq(workspaceReviewers.authorUserId, userId),
      ),
    )
    .limit(1)
    .execute();
  if (!row) return null;
  const u = (
    await db
      .select({
        id: users.id,
        githubLogin: users.githubLogin,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
      .execute()
  )[0];
  if (!u) return null;
  const evidence = await reviewerFootprintIn(accountId, workspaceId, userId);
  // Once per echo, exactly like once per listing — never per row.
  const seatCount = await workspaceHumanSeatCount(accountId, workspaceId);
  return mapWorkspaceReviewer(row, u, evidence, seatCount);
}

// One actor's footprint across a workspace's repos: the workspace total + the per-repo breakdown +
// the newest review body. The single-actor form of the six grouped queries in the listing.
async function reviewerFootprintIn(
  accountId: number,
  workspaceId: number,
  userId: number,
): Promise<{
  footprint: ReviewerFootprint;
  repoFootprints: RepoReviewerFootprintEntry[];
  sampleReviewBody: string | null;
}> {
  const empty = { reviews: 0, threads: 0, comments: 0, lastActiveAt: null };
  const repoIds = await getWorkspaceRepoIds(workspaceId, accountId);
  if (repoIds.length === 0) {
    return { footprint: footprintOf(empty), repoFootprints: [], sampleReviewBody: null };
  }
  const since90 = new Date(Date.now() - 90 * 86_400_000);
  const scoped = and(
    eq(pullRequests.accountId, accountId),
    inArray(pullRequests.repoId, repoIds),
  );
  const [revLast, revCount, thLast, thCount, cmLast, cmCount, sample] = await Promise.all([
    db
      .select({ repoId: pullRequests.repoId, last: max(reviews.submittedAt) })
      .from(reviews)
      .innerJoin(pullRequests, eq(pullRequests.id, reviews.prId))
      .where(and(scoped, eq(reviews.authorId, userId)))
      .groupBy(pullRequests.repoId)
      .execute(),
    db
      .select({ repoId: pullRequests.repoId, c: count() })
      .from(reviews)
      .innerJoin(pullRequests, eq(pullRequests.id, reviews.prId))
      .where(and(scoped, eq(reviews.authorId, userId), gte(reviews.submittedAt, since90)))
      .groupBy(pullRequests.repoId)
      .execute(),
    db
      .select({ repoId: pullRequests.repoId, last: max(reviewThreads.createdAt) })
      .from(reviewThreads)
      .innerJoin(pullRequests, eq(pullRequests.id, reviewThreads.prId))
      .where(and(scoped, eq(reviewThreads.originalCommenterId, userId)))
      .groupBy(pullRequests.repoId)
      .execute(),
    db
      .select({ repoId: pullRequests.repoId, c: count() })
      .from(reviewThreads)
      .innerJoin(pullRequests, eq(pullRequests.id, reviewThreads.prId))
      .where(
        and(
          scoped,
          eq(reviewThreads.originalCommenterId, userId),
          gte(reviewThreads.createdAt, since90),
        ),
      )
      .groupBy(pullRequests.repoId)
      .execute(),
    db
      .select({ repoId: pullRequests.repoId, last: max(prComments.createdAt) })
      .from(prComments)
      .innerJoin(pullRequests, eq(pullRequests.id, prComments.prId))
      .where(and(scoped, eq(prComments.authorId, userId)))
      .groupBy(pullRequests.repoId)
      .execute(),
    db
      .select({ repoId: pullRequests.repoId, c: count() })
      .from(prComments)
      .innerJoin(pullRequests, eq(pullRequests.id, prComments.prId))
      .where(and(scoped, eq(prComments.authorId, userId), gte(prComments.createdAt, since90)))
      .groupBy(pullRequests.repoId)
      .execute(),
    db
      .select({ body: reviews.body })
      .from(reviews)
      .innerJoin(pullRequests, eq(pullRequests.id, reviews.prId))
      .where(and(scoped, eq(reviews.authorId, userId), isNotNull(reviews.body)))
      .orderBy(desc(reviews.submittedAt))
      .limit(1)
      .execute(),
  ]);

  interface Acc {
    reviews: number;
    threads: number;
    comments: number;
    lastActiveAt: Date | null;
  }
  const byRepo = new Map<number, Acc>();
  const at = (repoId: number): Acc => {
    let a = byRepo.get(repoId);
    if (!a) {
      a = { reviews: 0, threads: 0, comments: 0, lastActiveAt: null };
      byRepo.set(repoId, a);
    }
    return a;
  };
  const laterOf = (a: Date | null, b: Date | null): Date | null =>
    a == null ? b : b == null ? a : a.getTime() >= b.getTime() ? a : b;
  for (const r of revLast) at(r.repoId).lastActiveAt = laterOf(at(r.repoId).lastActiveAt, r.last);
  for (const r of thLast) at(r.repoId).lastActiveAt = laterOf(at(r.repoId).lastActiveAt, r.last);
  for (const r of cmLast) at(r.repoId).lastActiveAt = laterOf(at(r.repoId).lastActiveAt, r.last);
  for (const r of revCount) at(r.repoId).reviews = r.c;
  for (const r of thCount) at(r.repoId).threads = r.c;
  for (const r of cmCount) at(r.repoId).comments = r.c;

  const total: Acc = { reviews: 0, threads: 0, comments: 0, lastActiveAt: null };
  for (const a of byRepo.values()) {
    total.reviews += a.reviews;
    total.threads += a.threads;
    total.comments += a.comments;
    total.lastActiveAt = laterOf(total.lastActiveAt, a.lastActiveAt);
  }
  const body = (sample[0]?.body ?? '').trim();
  return {
    footprint: footprintOf(total),
    repoFootprints: [...byRepo.entries()]
      .sort((x, y) => x[0] - y[0])
      .map(([repoId, a]) => ({ repoId, ...footprintOf(a) })),
    sampleReviewBody: body ? (body.length > 400 ? `${body.slice(0, 399)}…` : body) : null,
  };
}

// Does this actor already have a row in THIS workspace? Half of the 404 gate on the write routes.
async function actorHasWorkspaceRow(
  accountId: number,
  workspaceId: number,
  userId: number,
): Promise<boolean> {
  const row = (
    await db
      .select({ id: workspaceReviewers.id })
      .from(workspaceReviewers)
      .where(
        and(
          eq(workspaceReviewers.accountId, accountId),
          eq(workspaceReviewers.workspaceId, workspaceId),
          eq(workspaceReviewers.authorUserId, userId),
        ),
      )
      .limit(1)
      .execute()
  )[0];
  return row != null;
}

// Has this actor ever reviewed / opened a thread / commented on a PR in ANY of the workspace's
// repos? THE ANTI-FABRICATION GATE, and the one gate nothing else stands in for: the case it
// catches is SAME-ACCOUNT — writing a row for an actor this workspace never interacted with. A row
// IS the bot object and the listing is row-driven, so a fabricated pair renders a stranger's login,
// display name and avatar — read out of the GLOBAL `users` table — inside this account's settings.
//
// ⚠ THE `repoIds.length === 0` EARLY-OUT IS LOAD-BEARING. An empty workspace is a legal,
// explicitly-supported state, and the probes would otherwise emit `repo_id IN ()` rather than
// trusting the two dialects to agree about an empty IN list.
async function hasFootprintInWorkspace(
  accountId: number,
  workspaceId: number,
  userId: number,
): Promise<boolean> {
  const repoIds = await getWorkspaceRepoIds(workspaceId, accountId);
  if (repoIds.length === 0) return false;
  const scoped = and(
    eq(pullRequests.accountId, accountId),
    inArray(pullRequests.repoId, repoIds),
  );
  const [rev, th, cm] = await Promise.all([
    db
      .select({ id: reviews.id })
      .from(reviews)
      .innerJoin(pullRequests, eq(pullRequests.id, reviews.prId))
      .where(and(scoped, eq(reviews.authorId, userId)))
      .limit(1)
      .execute(),
    db
      .select({ id: reviewThreads.id })
      .from(reviewThreads)
      .innerJoin(pullRequests, eq(pullRequests.id, reviewThreads.prId))
      .where(and(scoped, eq(reviewThreads.originalCommenterId, userId)))
      .limit(1)
      .execute(),
    db
      .select({ id: prComments.id })
      .from(prComments)
      .innerJoin(pullRequests, eq(pullRequests.id, prComments.prId))
      .where(and(scoped, eq(prComments.authorId, userId)))
      .limit(1)
      .execute(),
  ]);
  return rev.length > 0 || th.length > 0 || cm.length > 0;
}

// Is this workspace one the calling account owns? A cheap, non-disclosing ownership probe — the
// composite FK `(workspace_id, account_id) → workspaces(id, account_id)` would also reject a
// foreign pair, but as a CONSTRAINT VIOLATION, i.e. a 500. This turns it into a 404.
async function ownsWorkspace(accountId: number, workspaceId: number): Promise<boolean> {
  if (!Number.isInteger(workspaceId) || workspaceId <= 0) return false;
  const row = (
    await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(and(eq(workspaces.id, workspaceId), eq(workspaces.accountId, accountId)))
      .limit(1)
      .execute()
  )[0];
  return row != null;
}

// PATCH /api/bot-reviewers/:userId — the four RE-DERIVABLE fields, one row.
//
// ⚠ THE TWO PROVENANCE FLAGS ARE STAMPED INDEPENDENTLY: `source: 'manual'` iff `automated` and/or
// `role` is present, `identitySource: 'manual'` iff `kind` and/or `label` is present. That
// independence is the ONLY thing left stopping "not a bot here" from also un-naming the vendor,
// now that the two facts share a row — the 0042/0043 table boundary that used to enforce it is
// gone. A patch carrying only a judgement must not touch the identity flag, and vice versa.
//
// ⚠ ITS `set:` OBJECT CONTAINS NO `monthlyCents` KEY, in any branch. Structural, not a rule to
// remember: `setReviewerCost` is the only statement in this file that names the column.
//
// ⚠ THE 404 GATE IS `!existing && !hasFootprintInWorkspace(...)`, NOT the footprint test alone. The
// `!existing &&` half is load-bearing: a STORED row whose actor has since gone quiet must stay
// editable, because that row is still steering every metric and it is the only place its own reset
// control can live. Drop the short-circuit and a "not a bot" pin on a vendor that later goes silent
// becomes permanent and unreachable — the precise failure the two reset routes exist to prevent.
//
// ⚠ A ROLE-ONLY PATCH STILL STAMPS `source: 'manual'`, which also pins `automated` for this
// workspace. Deliberate: not stamping it would let the next classification pass re-derive `role`
// from the login seed and silently revert the edit. A visible, resettable pin beats an edit that
// quietly disappears.
//
// null ⇒ the route 404s (unknown user / unknown or foreign workspace / no row AND no footprint) —
// deliberately one status for all three, so the route is never an existence oracle over another
// tenant's workspace ids or over the GLOBAL `users` table.
export async function setWorkspaceReviewer(
  accountId: number,
  userId: number,
  body: WorkspaceReviewerPatchBody,
): Promise<WorkspaceReviewer | null> {
  const workspaceId = body.workspaceId;
  if (!(await ownsWorkspace(accountId, workspaceId))) return null;

  const u = (
    await db
      .select({ id: users.id, login: users.githubLogin })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
      .execute()
  )[0];
  if (!u) return null;

  const [existing] = await db
    .select()
    .from(workspaceReviewers)
    .where(
      and(
        eq(workspaceReviewers.accountId, accountId),
        eq(workspaceReviewers.workspaceId, workspaceId),
        eq(workspaceReviewers.authorUserId, userId),
      ),
    )
    .limit(1)
    .execute();
  if (!existing && !(await hasFootprintInWorkspace(accountId, workspaceId, userId))) return null;

  const touchesJudgement = body.automated !== undefined || body.role !== undefined;
  const touchesIdentity = body.kind !== undefined || body.label !== undefined;

  const now = new Date();
  // The values the row must carry if it does not exist yet. NOT NULL columns need all of them;
  // `monthly_cents` is deliberately absent, so a row this write creates has NO price.
  const automated = body.automated ?? existing?.automated ?? false;
  const role: ReviewerRole =
    body.role ?? (existing?.role as ReviewerRole | null) ?? defaultRoleFor(u.login);
  const reasons =
    body.automated === undefined
      ? [`manually set role to ${role}`]
      : body.automated
        ? ['manually tagged as an automated reviewer']
        : ['manually confirmed as a human'];
  const kind =
    body.kind === undefined
      ? ((existing?.kind as AutomatedReviewerKind | null) ?? null)
      : body.kind;
  const label = body.label === undefined ? (existing?.label ?? null) : body.label;

  // TWO NARROWED HALVES, assembled independently — never one shared object used as both the
  // INSERT values and the `set:`. That shared-object shape is correct for a single-grain table and
  // is exactly what would let a judgement patch overwrite a human's vendor name here.
  const set: Record<string, unknown> = { updatedAt: now };
  if (touchesJudgement)
    Object.assign(set, {
      automated,
      role,
      confidence: 'high' as const,
      source: 'manual' as const,
      reasonsJson: reasons,
    });
  if (touchesIdentity)
    Object.assign(set, { kind, label, identitySource: 'manual' as const });

  await db
    .insert(workspaceReviewers)
    .values({
      accountId,
      workspaceId,
      authorUserId: userId,
      automated,
      role,
      // A brand-new row created by an identity-only patch is still a real judgement row; it takes
      // the auto-looking provenance so the next classification pass owns it.
      confidence: touchesJudgement ? 'high' : (existing?.confidence ?? 'low'),
      source: touchesJudgement ? 'manual' : (existing?.source ?? 'behavioral'),
      reasonsJson: touchesJudgement ? reasons : (existing?.reasonsJson ?? []),
      kind,
      label,
      identitySource: touchesIdentity ? 'manual' : (existing?.identitySource ?? 'auto'),
      updatedAt: now,
    })
    .onConflictDoUpdate({
      // (account_id, workspace_id, author_user_id) — `workspace_reviewers_account_workspace_author`.
      // A stale target type-checks perfectly and raises "no unique or exclusion constraint matching
      // the ON CONFLICT specification" at RUNTIME, in both dialects, only on a real write.
      target: [
        workspaceReviewers.accountId,
        workspaceReviewers.workspaceId,
        workspaceReviewers.authorUserId,
      ],
      set,
    })
    .execute();

  return readWorkspaceReviewer(accountId, workspaceId, userId);
}

// DELETE /api/bot-reviewers/:userId/judgement?workspaceId= — hand automated/role/confidence/
// reasons back to detection.
//
// THE UNDO FOR setWorkspaceReviewer, and the reason the pin documented there is an acceptable
// trade at all. A `source: 'manual'` row is one the classifier never re-derives, so without a reset
// every judgement edit was PERMANENT — including a role-only patch. Flipping the value back by hand
// does not undo it: the row is still manual, still frozen, just frozen on another value.
//
// ⚠ IT IS AN UPDATE, NOT A ROW DELETE. The old per-repo reset deleted its row because the row held
// nothing else and the listing re-derived a missing row on the next pass. This row also holds the
// vendor IDENTITY and the PRICE, so a delete is lossy.
//
// ⚠ IT RE-DERIVES IN THE SAME REQUEST: clear the provenance, THEN
// `classifyReviewer(…, [workspaceId], { only: 'judgement' })`. A clear-only reset would leave the
// human's automated/role values sitting under an auto label until something else overwrote them —
// a stale opinion wearing the wrong provenance, strictly worse than no reset. Order matters:
// persist() skips a still-'manual' row, so with the two swapped this would be a no-op.
//
// ⚠ THE `[workspaceId]` ARGUMENT IS NOT DECORATION. Its predecessor passed an EMPTY repo list to
// mean "identity only", which worked only because persist() wrote the two halves as two statements
// against two TABLES with the second gated on a non-empty list. With one merged row there is a
// single per-workspace loop, so an empty list writes NOTHING. `PersistOpts.only` is the mechanism
// now, and it is explicit rather than emergent.
export async function resetWorkspaceReviewerJudgement(
  accountId: number,
  userId: number,
  workspaceId: number,
): Promise<WorkspaceReviewer | null> {
  if (!(await ownsWorkspace(accountId, workspaceId))) return null;
  if (!(await actorHasWorkspaceRow(accountId, workspaceId, userId))) return null;
  const u = (
    await db
      .select({
        id: users.id,
        githubLogin: users.githubLogin,
        githubType: users.githubType,
        isBot: users.isBot,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
      .execute()
  )[0];
  if (!u) return null;

  // 1. Hand provenance back to detection. `source` is the write gate persist() reads; anything
  //    else here would be cosmetic. The IDENTITY columns and the PRICE are untouched.
  await db
    .update(workspaceReviewers)
    .set({ source: 'behavioral', confidence: 'low', updatedAt: new Date() })
    .where(
      and(
        eq(workspaceReviewers.accountId, accountId),
        eq(workspaceReviewers.workspaceId, workspaceId),
        eq(workspaceReviewers.authorUserId, userId),
      ),
    )
    .execute();

  // 2. Re-derive the judgement NOW, judgement-half only.
  await classifyReviewer(
    accountId,
    { id: u.id, githubLogin: u.githubLogin, githubType: u.githubType, isBot: u.isBot },
    await reviewerEvidence(accountId, userId),
    [workspaceId],
    { only: 'judgement' },
  );
  return readWorkspaceReviewer(accountId, workspaceId, userId);
}

// DELETE /api/bot-reviewers/:userId/identity?workspaceId= — clear kind/label, identitySource →
// 'auto', re-derive NOW.
//
// The undo for the identity half of the PATCH. Without it, naming a vendor once pinned
// `identity_source` forever: the classifier skips a manual identity by design, so re-typing the
// auto-derived name by hand would not un-pin it either — it would just re-stamp 'manual' on the
// same value.
//
// ⚠ THE PRICE SURVIVES. Un-naming a vendor is not a statement about what it costs; losing what you
// pay for CodeRabbit as a side effect is exactly the coupling this contract keeps separated. The
// `set:` below is the structural guarantee — there is no cost key in it.
//
// ⚠ NOR MAY IT TOUCH `automated` / `role` / `source` / `confidence` / `reasons_json` — that is the
// other provenance flag and the other route. `{ only: 'identity' }` is what enforces it inside
// persist(), where a table boundary used to.
//
// ⚠ WHY IT RE-DERIVES IMMEDIATELY instead of only clearing. The lazy pass in
// listDetectedReviewers reclassifies an actor only when it has NO row in this workspace, so a
// clear-only reset would leave `kind: null` on an actor nobody re-derives, `mapWorkspaceReviewer`
// would fall back to the raw login, and `useBotColors` (which filters `kind != null`) would drop
// the brand colour: "Reset name" would read as "delete the vendor", indefinitely.
export async function resetWorkspaceReviewerIdentity(
  accountId: number,
  userId: number,
  workspaceId: number,
): Promise<WorkspaceReviewer | null> {
  if (!(await ownsWorkspace(accountId, workspaceId))) return null;
  if (!(await actorHasWorkspaceRow(accountId, workspaceId, userId))) return null;
  const u = (
    await db
      .select({
        id: users.id,
        githubLogin: users.githubLogin,
        githubType: users.githubType,
        isBot: users.isBot,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
      .execute()
  )[0];
  if (!u) return null;

  // 1. Clear the human's naming and hand provenance back. NO cost key, NO judgement key.
  await db
    .update(workspaceReviewers)
    .set({ kind: null, label: null, identitySource: 'auto', updatedAt: new Date() })
    .where(
      and(
        eq(workspaceReviewers.accountId, accountId),
        eq(workspaceReviewers.workspaceId, workspaceId),
        eq(workspaceReviewers.authorUserId, userId),
      ),
    )
    .execute();

  // 2. Re-derive the identity NOW, identity-half only. It must run AFTER step 1 — persist() skips
  //    a 'manual' identity, so with the order swapped this would clear and stop.
  await classifyReviewer(
    accountId,
    { id: u.id, githubLogin: u.githubLogin, githubType: u.githubType, isBot: u.isBot },
    await reviewerEvidence(accountId, userId),
    [workspaceId],
    { only: 'identity' },
  );
  return readWorkspaceReviewer(accountId, workspaceId, userId);
}

// The int4 ceiling in CENTS, and the reason the cost route clamps rather than trusting the
// driver: Postgres RAISES `integer out of range` (a 500) above it while SQLite's 64-bit integers
// accept the value happily, so an unbounded field means the same request succeeds locally and
// 500s in cloud, leaving a number cloud can never represent. (Measured: monthlyUsd 99999999999
// stored 2147483647 on pg and 9999999999900 on sqlite.)
const MAX_MONTHLY_CENTS = 2_147_483_647;

// The FIXED rounding rule, shared verbatim with the migrations: cents = floor(usd × 100 + 0.5)
// evaluated in IEEE-754 binary64. Do not reach for a "more exact" decimal rounding on one side —
// $1.005 lands on 100 under this rule and 101 under exact-decimal rounding, and the two backfill
// paths were measured disagreeing on exactly that value.
export function monthlyUsdToCents(usd: number): number {
  if (!Number.isFinite(usd)) return 0;
  const cents = Math.floor(usd * 100 + 0.5);
  return Math.min(MAX_MONTHLY_CENTS, Math.max(0, cents));
}

// PUT /api/bot-reviewers/:userId/cost — THE ONLY WRITE OF `monthly_cents` AND `cost_model`
// ANYWHERE.
//
// TWO STATES ONLY: a number → `monthly_cents` (0 is real: "we pay nothing"); null → NULL. There is
// nothing to fall back to, so NULL means exactly "no price set".
//
// ⚠ IT WRITES EXACTLY ONE ROW: the predicate is (account_id, workspace_id, author_user_id). Price
// is per workspace, like every other attribute on the row — the same actor's rows in other
// workspaces are untouched and may hold different numbers. There is NO fan-out writer, NO INSERT
// seed, and no cross-workspace coupling of any kind; a row created later in another workspace
// comes up with a NULL price. `workspaceId` is therefore part of the row's IDENTITY, not merely
// the ownership gate. The editor's copy says "Price for this Workspace".
//
// ⚠ CLEARING IS A COLUMN WRITE, NOT A ROW DELETE. Cost shares its row with the judgement and the
// identity, so deleting the row would take both with it. (When cost had its own table, NOT NULL +
// delete-to-clear was the right shape — do not carry that reflex over.)
//
// ⚠ THE VALUE IS CLAMPED HERE, not left to the driver — see MAX_MONTHLY_CENTS. The route ALSO
// bounds the input (so a fat-fingered paste gets a 400 rather than a silently clamped price); this
// clamp is the backstop for every other caller.
//
// 404 when the workspace is not the account's, or the actor has no row in it — the write would
// land, but the listing is row-driven, so nothing could ever display, edit or clear it.
export async function setReviewerCost(
  accountId: number,
  userId: number,
  workspaceId: number,
  monthlyUsd: number | null,
  // How the number is to be read — 'flat' (omitted ⇒ flat) or 'per_seat' (a per-seat unit,
  // multiplied on read by workspaceHumanSeatCount). It shares the price's one writer because it
  // changes what the stored number MEANS: a body that can set one without the other could turn
  // $29/mo into $29 × seats without touching a money column.
  costModel?: CostModel,
): Promise<WorkspaceReviewer | null> {
  if (!(await ownsWorkspace(accountId, workspaceId))) return null;
  if (!(await actorHasWorkspaceRow(accountId, workspaceId, userId))) return null;
  const monthlyCents = monthlyUsd == null ? null : monthlyUsdToCents(monthlyUsd);
  await db
    .update(workspaceReviewers)
    // THE PRICE, ITS READING RULE AND THE TIMESTAMP, NOTHING ELSE. This object is the structural
    // guarantee that pricing a bot cannot restate its judgement or its identity. A CLEAR resets
    // the model to 'flat' in the SAME statement: a NULL price has no reading rule, and a per-seat
    // leftover would silently re-meter the next number typed as unit × seats.
    .set({
      monthlyCents,
      costModel: monthlyUsd == null ? 'flat' : (costModel ?? 'flat'),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(workspaceReviewers.accountId, accountId),
        eq(workspaceReviewers.workspaceId, workspaceId),
        eq(workspaceReviewers.authorUserId, userId),
      ),
    )
    .execute();
  return readWorkspaceReviewer(accountId, workspaceId, userId);
}

// WS7 — "only a bot reviewed this": PRs (merged in-window, or open-and-mergeable) in the
// given repos whose ONLY counting reviews (approved/changes_requested/commented) are from
// automated reviewers (incl. Pierre-verbatim via the claudeReviews join) with NO human
// review. Account-scoped. Feeds the bot_only_review card in getWorkspaceInsights.
export interface BotOnlyReviewPr {
  prId: number;
  number: number;
  title: string;
  repoId: number;
  repoFullName: string;
  botLabel: string;
  state: PrState;
  githubUrl: string;
  openedAt: string;
  updatedAt: string;
  authorId: number | null;
  // The PR's ONLY automated touch is a Pierre-verbatim review (posted with the human's token,
  // so no bot-ACTOR events exist) — the bot-only feed isolation can't surface it.
  viaPierreOnly: boolean;
}
export async function getBotOnlyReviewPrs(
  accountId: number,
  scope: BotScope,
  window: { from: Date; to: Date },
  // openOnly: restrict to currently-OPEN (mergeable) PRs, dropping merged-in-window. The
  // analytics COUNT (the "only a bot reviewed…" banner) uses this — it's a live "needs a human
  // before it merges" signal, and merged PRs have already shipped. The drill-down LIST omits
  // this so the tab can offer merged behind a "Show merged" toggle.
  opts?: { openOnly?: boolean },
): Promise<BotOnlyReviewPr[]> {
  const repoIds = scope.repoIds;
  if (repoIds.length === 0) return [];
  // `role: 'all'` — DELIBERATELY NOT narrowed to 'review', and this is the one metric where the
  // obvious edit is wrong. This getter flags PRs NO HUMAN reviewed. Narrowing to review-role bots
  // means a PR reviewed only by SonarQube has zero review-role bot reviews, fails the "at least
  // one automated review" leg, and VANISHES from the list — hiding the risk instead of flagging
  // it, the exact opposite of the banner's purpose ("needs a human before it merges"). The role
  // narrowing belongs on ROI / behaviour / dedup / benchmark, not here.
  //
  // The judgement comes from `scope.workspaceId` — the workspace the scanned repos belong to, so
  // the drill-down list and the count above it evaluate the identical rule by construction.
  const automatedIds = new Set(
    await automatedReviewerUserIds(accountId, scope.workspaceId, 'all'),
  );
  const kindMap = await classificationKindForUser(accountId, scope.workspaceId);

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
      openedAt: pullRequests.openedAt,
      updatedAt: pullRequests.updatedAt,
    })
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.accountId, accountId),
        inArray(pullRequests.repoId, repoIds),
        opts?.openOnly
          ? and(eq(pullRequests.state, 'open'), eq(pullRequests.mergeable, 'mergeable'))
          : or(
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
    // True when a CLASSIFIED bot actor touched the PR. A PR whose only automated touch is a
    // Pierre-VERBATIM review has NO bot-actor events (the human's token posted it), so the
    // bot-only feed isolation can't surface it — the UI needs to know (viaPierreOnly).
    let anyRealBot = false;
    let botLabel: string | null = null;
    const noteAuto = (authorId: number | null, isPierre: boolean): void => {
      anyAutomated = true;
      if (authorId != null && automatedIds.has(authorId)) anyRealBot = true;
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
        repoId: pr.repoId,
        repoFullName: full,
        botLabel: botLabel ?? 'Automated',
        state: pr.state,
        githubUrl: `https://github.com/${full}/pull/${pr.number}`,
        openedAt: pr.openedAt.toISOString(),
        updatedAt: pr.updatedAt.toISOString(),
        authorId: pr.authorId,
        viaPierreOnly: !anyRealBot,
      });
    }
  }
  return out;
}

// WS3 — the Bot-ROI analytics. Per AutomatedReviewerKind over the requested window:
// volume (threads + comments), acted-on %, untouched backlog + oldest age, human
// follow-through %, noise ratio (untouched-share proxy — severity is often unknowable),
// a keep/tune/noisy verdict, and a ≤12-week weekly trend. Cost fields stay null (the
// frontend overlays per-vendor cost from Pro settings). Deterministic, NO AI. Account-scoped.
// ── Human THEMES source rows (Pro) — the raw HUMAN review-comment CONTENT ─────────────────────
// The sibling of getBotReviewComments for people, NOT bots: comments authored by non-bot users
// (excludes every automated reviewer + any is_bot user), which INCLUDES human replies inside
// bot-initiated threads. Powers the Pro "Discussion themes" Feed summary. Account- + WORKSPACE-scoped +
// windowed; capped most-recent per source (a `truncated` flag). Returns the thread's derivedState so
// the plugin funnel can prioritise threads that have responses (derivedState != 'untouched'). The
// row shape is RE-DECLARED verbatim in packages/pro/src/human-themes/build.ts (open-core boundary);
// KEEP THE TWO IN LOCKSTEP.
export interface HumanReviewCommentRow {
  id: number;
  source: 'review' | 'issue';
  prId: number;
  prNumber: number;
  repoId: number;
  repoFullName: string;
  path: string | null;
  authorUserId: number;
  login: string | null;
  displayName: string | null;
  body: string | null;
  createdAt: string; // ISO
  derivedState: string | null; // inline threads only — the "has responses" prioritisation signal
  threadId: number | null;
}

export async function getHumanReviewComments(
  accountId: number,
  window: BotWindowKind,
  scope: BotScope,
): Promise<{ comments: HumanReviewCommentRow[]; truncated: boolean }> {
  if (scope.repoIds.length === 0) return { comments: [], truncated: false };
  // `role: 'all'` — this set is used to EXCLUDE bots from the human Discussion-themes AI pass.
  // Narrowing it to review-role bots would let every SonarQube comment through as "human" and
  // leak lint output straight into the human themes summary (and pay for it). This is the site
  // where the obvious edit is wrong; see the ReviewerRole note in shared.
  const automatedIds = await automatedReviewerUserIds(accountId, scope.workspaceId, 'all');

  const nowMs = Date.now();
  const from = new Date(nowMs - botWindowMs(window));
  const repoScopeFilter = [inArray(pullRequests.repoId, scope.repoIds)];
  // Exclude bots two ways: any is_bot user, and the resolved automated-reviewer set (which can
  // include service-account PATs that carry is_bot=false). notInArray on [] is a no-op we skip.
  const excludeAutomated =
    automatedIds.length > 0 ? [notInArray(reviewComments.authorId, automatedIds)] : [];
  const excludeAutomatedPr =
    automatedIds.length > 0 ? [notInArray(prComments.authorId, automatedIds)] : [];

  const reviewRows = await db
    .select({
      id: reviewComments.id,
      prId: reviewComments.prId,
      prNumber: pullRequests.number,
      repoId: pullRequests.repoId,
      owner: repos.owner,
      name: repos.name,
      authorId: reviewComments.authorId,
      login: users.githubLogin,
      displayName: users.displayName,
      body: reviewComments.body,
      createdAt: reviewComments.createdAt,
      path: reviewThreads.path,
      derivedState: reviewThreads.derivedState,
      threadId: reviewComments.threadId,
    })
    .from(reviewComments)
    .innerJoin(pullRequests, eq(pullRequests.id, reviewComments.prId))
    .innerJoin(repos, eq(repos.id, pullRequests.repoId))
    .innerJoin(users, eq(users.id, reviewComments.authorId))
    .leftJoin(reviewThreads, eq(reviewThreads.id, reviewComments.threadId))
    .where(
      and(
        eq(pullRequests.accountId, accountId),
        eq(users.isBot, false),
        gte(reviewComments.createdAt, from),
        ...excludeAutomated,
        ...repoScopeFilter,
      ),
    )
    .orderBy(desc(reviewComments.createdAt))
    .limit(BOT_THEME_COMMENT_CAP)
    .execute();

  const prCommentRows = await db
    .select({
      id: prComments.id,
      prId: prComments.prId,
      prNumber: pullRequests.number,
      repoId: pullRequests.repoId,
      owner: repos.owner,
      name: repos.name,
      authorId: prComments.authorId,
      login: users.githubLogin,
      displayName: users.displayName,
      body: prComments.body,
      createdAt: prComments.createdAt,
    })
    .from(prComments)
    .innerJoin(pullRequests, eq(pullRequests.id, prComments.prId))
    .innerJoin(repos, eq(repos.id, pullRequests.repoId))
    .innerJoin(users, eq(users.id, prComments.authorId))
    .where(
      and(
        eq(pullRequests.accountId, accountId),
        eq(users.isBot, false),
        gte(prComments.createdAt, from),
        ...excludeAutomatedPr,
        ...repoScopeFilter,
      ),
    )
    .orderBy(desc(prComments.createdAt))
    .limit(BOT_THEME_COMMENT_CAP)
    .execute();

  const toIso = (d: Date | number | null): string => {
    if (d == null) return new Date(0).toISOString();
    if (d instanceof Date) return d.toISOString();
    const ms = Number(d) > 1e12 ? Number(d) : Number(d) * 1000;
    return new Date(ms).toISOString();
  };

  const out: HumanReviewCommentRow[] = [];
  for (const r of reviewRows) {
    if (r.authorId == null) continue;
    out.push({
      id: r.id,
      source: 'review',
      prId: r.prId,
      prNumber: r.prNumber,
      repoId: r.repoId,
      repoFullName: `${r.owner}/${r.name}`,
      path: r.path ?? null,
      authorUserId: r.authorId,
      login: r.login ?? null,
      displayName: r.displayName ?? null,
      body: r.body,
      createdAt: toIso(r.createdAt),
      derivedState: r.derivedState ?? null,
      threadId: r.threadId ?? null,
    });
  }
  for (const r of prCommentRows) {
    if (r.authorId == null) continue;
    out.push({
      id: r.id,
      source: 'issue',
      prId: r.prId,
      prNumber: r.prNumber,
      repoId: r.repoId,
      repoFullName: `${r.owner}/${r.name}`,
      path: null,
      authorUserId: r.authorId,
      login: r.login ?? null,
      displayName: r.displayName ?? null,
      body: r.body,
      createdAt: toIso(r.createdAt),
      derivedState: null,
      threadId: null,
    });
  }
  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  const truncated =
    reviewRows.length >= BOT_THEME_COMMENT_CAP ||
    prCommentRows.length >= BOT_THEME_COMMENT_CAP ||
    out.length > BOT_THEME_COMMENT_CAP;
  return { comments: out.slice(0, BOT_THEME_COMMENT_CAP), truncated };
}

// ── Bot THEMES source rows (Pro) — the raw automated-reviewer comment CONTENT ────────────────
// The ONE bot query that returns comment BODIES (every other bot query is deterministic counts).
// Powers the Pro "Themes" AI summary: the plugin funnels these (dedup + strip) then one Haiku pass
// reads them. Account-scoped + WORKSPACE-scoped (`scope`, mirroring getBotAnalytics) + windowed;
// only automated-reviewer authors; capped most-recent (a `truncated` flag) so a firehose repo can't
// blow the payload. Returns both inline review-thread comments (with path + derivedState) and
// issue-level PR comments (path/derivedState null). ⚠ TWO consumers of this row shape: the
// REVIVED plugin bot-themes/build.ts re-declares it BY HAND (open-core boundary — the plugin
// imports no host internals), so any change here must be mirrored there; core
// db/synthesis-input.ts's 'workspace-bots' fold imports the declaration directly.
export interface BotReviewCommentRow {
  id: number; // source-row id (namespaced by `source` — not globally unique across sources)
  source: 'review' | 'issue';
  prId: number;
  prNumber: number;
  repoId: number;
  repoFullName: string;
  path: string | null; // inline comments carry a file path; issue-level comments don't
  authorUserId: number;
  reviewerKey: string; // `u<userId>` — mirrors the ROI row identity
  label: string;
  login: string | null;
  kind: AutomatedReviewerKind;
  body: string | null;
  createdAt: string; // ISO
  derivedState: string | null; // inline threads only (untouched/replied/likely_addressed/resolved)
  threadId: number | null;
}

const BOT_THEME_COMMENT_CAP = 3000; // most-recent bot comments per source considered for a summary

export async function getBotReviewComments(
  accountId: number,
  window: BotWindowKind,
  scope: BotScope,
): Promise<{ comments: BotReviewCommentRow[]; truncated: boolean }> {
  // An empty workspace → nothing to summarize.
  if (scope.repoIds.length === 0) return { comments: [], truncated: false };
  // `role: 'review'` — the Pro "Themes" Haiku pass summarises what the REVIEW bots are saying.
  // Excluding quality checks also saves real money: there is nothing to learn from summarising
  // lint output, and it is the highest-volume comment source in most accounts.
  const automatedIds = await automatedReviewerUserIds(accountId, scope.workspaceId, 'review');
  if (automatedIds.length === 0) return { comments: [], truncated: false };
  const kindMap = await classificationKindForUser(accountId, scope.workspaceId);

  const nowMs = Date.now();
  // Window resolution mirrors getBotAnalytics exactly (rolling_14 / 'sprint' both → 14d trailing).
  const from = new Date(nowMs - botWindowMs(window));
  const repoScopeFilter = [inArray(pullRequests.repoId, scope.repoIds)];

  // Per-reviewer label (custom classification label → vendor pretty name → login) — mirrors
  // getBotAnalytics.reviewerLabel exactly, so a bot reads the same here as in the ROI panel.
  const classLabel = await classificationLabelMap(accountId, scope.workspaceId);
  const loginById = new Map<number, string>();
  const rawLoginById = new Map<number, string>();
  for (const r of await db
    .select({ id: users.id, login: users.githubLogin, name: users.displayName })
    .from(users)
    .where(inArray(users.id, automatedIds))
    .execute()) {
    loginById.set(r.id, r.name?.trim() || r.login || `#${r.id}`);
    if (r.login) rawLoginById.set(r.id, r.login);
  }
  const labelFor = (userId: number, kind: AutomatedReviewerKind): string => {
    const custom = classLabel.get(userId);
    if (custom) return custom;
    if (kind !== 'in_house' && kind !== 'pierre' && kind !== 'vendor') return labelForKind(kind);
    return loginById.get(userId) ?? labelForKind(kind);
  };

  // Inline review-thread comments (carry the thread's path + derivedState).
  const reviewRows = await db
    .select({
      id: reviewComments.id,
      prId: reviewComments.prId,
      prNumber: pullRequests.number,
      repoId: pullRequests.repoId,
      owner: repos.owner,
      name: repos.name,
      authorId: reviewComments.authorId,
      body: reviewComments.body,
      createdAt: reviewComments.createdAt,
      path: reviewThreads.path,
      derivedState: reviewThreads.derivedState,
      threadId: reviewComments.threadId,
    })
    .from(reviewComments)
    .innerJoin(pullRequests, eq(pullRequests.id, reviewComments.prId))
    .innerJoin(repos, eq(repos.id, pullRequests.repoId))
    .leftJoin(reviewThreads, eq(reviewThreads.id, reviewComments.threadId))
    .where(
      and(
        eq(pullRequests.accountId, accountId),
        inArray(reviewComments.authorId, automatedIds),
        gte(reviewComments.createdAt, from),
        ...repoScopeFilter,
      ),
    )
    .orderBy(desc(reviewComments.createdAt))
    .limit(BOT_THEME_COMMENT_CAP)
    .execute();

  // Issue-level PR comments (no path / derivedState).
  const prCommentRows = await db
    .select({
      id: prComments.id,
      prId: prComments.prId,
      prNumber: pullRequests.number,
      repoId: pullRequests.repoId,
      owner: repos.owner,
      name: repos.name,
      authorId: prComments.authorId,
      body: prComments.body,
      createdAt: prComments.createdAt,
    })
    .from(prComments)
    .innerJoin(pullRequests, eq(pullRequests.id, prComments.prId))
    .innerJoin(repos, eq(repos.id, pullRequests.repoId))
    .where(
      and(
        eq(pullRequests.accountId, accountId),
        inArray(prComments.authorId, automatedIds),
        gte(prComments.createdAt, from),
        ...repoScopeFilter,
      ),
    )
    .orderBy(desc(prComments.createdAt))
    .limit(BOT_THEME_COMMENT_CAP)
    .execute();

  const toIso = (d: Date | number | null): string => {
    if (d == null) return new Date(0).toISOString();
    if (d instanceof Date) return d.toISOString();
    const ms = Number(d) > 1e12 ? Number(d) : Number(d) * 1000;
    return new Date(ms).toISOString();
  };

  const out: BotReviewCommentRow[] = [];
  for (const r of reviewRows) {
    if (r.authorId == null) continue;
    const kind = kindMap.get(r.authorId) ?? 'in_house';
    out.push({
      id: r.id,
      source: 'review',
      prId: r.prId,
      prNumber: r.prNumber,
      repoId: r.repoId,
      repoFullName: `${r.owner}/${r.name}`,
      path: r.path ?? null,
      authorUserId: r.authorId,
      reviewerKey: `u${r.authorId}`,
      label: labelFor(r.authorId, kind),
      login: rawLoginById.get(r.authorId) ?? null,
      kind,
      body: r.body,
      createdAt: toIso(r.createdAt),
      derivedState: r.derivedState ?? null,
      threadId: r.threadId ?? null,
    });
  }
  for (const r of prCommentRows) {
    if (r.authorId == null) continue;
    const kind = kindMap.get(r.authorId) ?? 'in_house';
    out.push({
      id: r.id,
      source: 'issue',
      prId: r.prId,
      prNumber: r.prNumber,
      repoId: r.repoId,
      repoFullName: `${r.owner}/${r.name}`,
      path: null,
      authorUserId: r.authorId,
      reviewerKey: `u${r.authorId}`,
      label: labelFor(r.authorId, kind),
      login: rawLoginById.get(r.authorId) ?? null,
      kind,
      body: r.body,
      createdAt: toIso(r.createdAt),
      derivedState: null,
      threadId: null,
    });
  }
  // Newest-first, capped combined (the plugin funnels further before the LLM). `truncated` when
  // either source hit its own cap OR the combined stream overflowed the cap.
  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  const truncated =
    reviewRows.length >= BOT_THEME_COMMENT_CAP ||
    prCommentRows.length >= BOT_THEME_COMMENT_CAP ||
    out.length > BOT_THEME_COMMENT_CAP;
  return { comments: out.slice(0, BOT_THEME_COMMENT_CAP), truncated };
}

export async function getBotAnalytics(
  accountId: number,
  // Either a KIND (resolved here against the one shared duration mapping) or a kind carried
  // ALONGSIDE explicit bounds. The second form exists for one reason: `'sprint'` resolves to a
  // trailing 14 days in core, because the account's cadence + start live in the plugin-owned
  // `pro_settings` and core cannot read them. A caller that HAS those bounds (the Pro Insights
  // chat, whose range chips include "Sprint to date") passes them, and the response's window then
  // states the real sprint dates instead of a 14-day stand-in that nothing labelled as one.
  // Bounds are trusted as given — they are server-derived or route-validated (the People
  // report's `fromMs`/`toMs` query params, schema- and span-checked in bot-triage.ts): they only
  // narrow WHAT IS MEASURED inside the account's own resolved scope — they carry no authority,
  // exactly like the enum they refine.
  window: BotWindowKind | { kind: BotWindowKind; fromMs: number; toMs: number },
  // ONE object carrying both halves: `workspaceId` decides who counts as a bot, `repoIds` narrows
  // which data is measured. Its predecessor conflated them into a single `number[] | null` and
  // then needed a SECOND `teamKey` parameter for the judgement, which a caller could forget to
  // thread through — so the metric and the drill-down behind it could evaluate different rules.
  // `repoIds: []` = an empty workspace → empty analytics.
  scope: BotScope,
  // `inflationHistory` (plan P1.2/C2): fold the per-bot WEEKLY inflation series (the Pro
  // sparkline behind the Inflation column) over the 12-week trend span. The route sets it from
  // the `botDepth` entitlement — the current-window counts are FREE and computed regardless;
  // only the history is paid, and an unentitled response simply ships no `weekly`.
  opts?: { inflationHistory?: boolean },
): Promise<BotAnalyticsResponse> {
  const nowMs = Date.now();
  const windowKind = typeof window === 'string' ? window : window.kind;
  // The one shared window→duration mapping (db/bot-window.ts; sprint = 14d there) unless the
  // caller supplied real bounds.
  const to = new Date(typeof window === 'string' ? nowMs : window.toMs);
  const from = new Date(
    typeof window === 'string' ? nowMs - botWindowMs(window) : window.fromMs,
  );
  // The 12-week trend series must COVER the measured window, or a 90-day range would chart only
  // its most recent 84 days while the totals beside it counted all 90. Anchored on `from`, not on
  // now, so an explicit (possibly future-ending) sprint window is covered too.
  const trendFrom = new Date(Math.min(from.getTime(), nowMs - 12 * 7 * 86_400_000));
  // The window's UPPER predicate, applied ONLY under EXPLICIT bounds — the same rule
  // `getMlWindowAggregates`' `to` parameter states, and for the same two reasons. Under the enum
  // form the window ENDS AT NOW, so an upper bound can exclude nothing that exists except rows
  // written in the CURRENT SECOND (these columns are second-granular on sqlite) — a live-data
  // flake, not a window rule — and dropping it keeps every enum-form scan byte-identical to the
  // drill-downs reading the same rows. A completed period, by contrast, MUST cap: a thread the
  // bot opened after the period is a different population.
  const toBound = typeof window === 'string' ? null : to;
  const generatedAt = new Date(nowMs).toISOString();
  const win = { kind: windowKind, from: from.toISOString(), to: to.toISOString() };

  const emptyTotals = { threads: 0, comments: 0, actedOn: 0, actedOnPct: null, untouched: 0, botOnlyPrs: 0, overdueGraceMs: OVERDUE_GRACE_MS, overlapClusters: 0 };
  // An empty workspace → nothing to analyze.
  if (scope.repoIds.length === 0) {
    return { enabled: true, generatedAt, window: win, vendors: [], qualityChecks: [], totals: emptyTotals, suggestions: [] };
  }
  // Spread into each PR-joined WHERE to narrow to the workspace's repos.
  const repoScopeFilter = [inArray(pullRequests.repoId, scope.repoIds)];
  // `role: 'all'` here is NOT a leak of quality checks into the metrics: this getter computes a
  // row for EVERY automated reviewer and then SPLITS them by role at the bottom — `vendors` (the
  // metric surface: totals, verdicts, suggestions) vs `qualityChecks` (a collapsed
  // "excluded from ROI" section, volume only). Computing both in one pass is why a mis-roled bot
  // is discoverable in the UI instead of just vanishing.
  const automatedIds = await automatedReviewerUserIds(accountId, scope.workspaceId, 'all');
  if (automatedIds.length === 0) {
    return { enabled: true, generatedAt, window: win, vendors: [], qualityChecks: [], totals: emptyTotals, suggestions: [] };
  }
  const kindMap = await classificationKindForUser(accountId, scope.workspaceId);
  const roleMap = await reviewerRoleForUser(accountId, scope.workspaceId);
  // SERVER-resolved cost, read from `workspace_reviewers.monthly_cents` for THIS workspace. There
  // is exactly one row per actor here, so this array may be totalled — but the figure is a
  // WORKSPACE total and must never be added to another workspace's: six workspaces each listing a
  // $120 CodeRabbit is either six subscriptions or one seen six ways, and the app must not assert
  // which. (This used to be `null` here with the client overlaying a per-LOGIN blob from
  // `pro_settings.bots.cost`.)
  const costMap = await reviewerCostForUser(accountId, scope.workspaceId);
  // ONE seat count per response. Per-seat prices multiply by it on read, and it is one number for
  // the whole workspace — fanning the DISTINCT scan out per vendor row would be pure waste. It
  // keys on the workspace MEMBERSHIP, never the repoIds narrowing (a per-seat invoice does not
  // shrink because the user filtered a chart).
  const seatCount = await workspaceHumanSeatCount(accountId, scope.workspaceId);

  // The windowed ML label fold (docs/ML-SEVERITY.md): the merged Bots table shows severity
  // columns beside the ROI columns over the SAME window, so the per-bot aggregates ride this
  // response instead of a second, unwindowed one. Computed for the whole automated set (both
  // roles, like the rollup) and ALWAYS — the SPA's render gate is MeResponse.mlSeverity, and on
  // a deployment with no scoring service this is a cheap scan of an empty table plus three
  // indexed zero counts. The vendor's own declared severity is never read here.
  // Under `inflationHistory` the scan widens to `trendFrom` for the weekly series; the window
  // counts are unchanged (in-window rows are a newest-first PREFIX of the widened scan — see the
  // note on `getMlWindowAggregates`' `history` parameter).
  const mlAgg = await getMlWindowAggregates(
    accountId,
    scope,
    automatedIds,
    from,
    // Explicit bounds cap the label scan too; the enum form passes null (window ends at now —
    // no upper predicate, keeping the scan byte-identical to the flagging drill-down's).
    typeof window === 'string' ? null : to,
    opts?.inflationHistory ? { trendFrom } : undefined,
  );

  // Per-REVIEWER identity (so in-house bots — all kind 'in_house' — separate into their own rows
  // instead of collapsing). Label preference: the account's custom classification label →
  // the vendor's pretty name (for known vendors) → the reviewer's login/display name.
  const classLabel = await classificationLabelMap(accountId, scope.workspaceId);
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
    if (kind !== 'in_house' && kind !== 'pierre' && kind !== 'vendor')
      return labelForKind(kind);
    return loginById.get(userId) ?? labelForKind(kind);
  };

  // Automated-reviewer threads over the 12-week trend span (⊇ the selected window), capped at
  // `to` like every fold here — under explicit bounds (a completed period) a thread opened AFTER
  // the period must reach neither the headline counts nor the trend/lastActive/dormancy math, or
  // one row mixes two window populations. The half-open [from, to) spelling is the route's
  // stated contract (bot-triage.ts); under the enum form there is no upper predicate at all
  // (see `toBound`).
  // `line` feeds ONLY the same-line overlap pass below (reviewThreads is the one table carrying
  // line data — reviewComments has no line columns; overlap never computes from comments).
  const threadRows = await db
    .select({
      id: reviewThreads.id,
      prId: reviewThreads.prId,
      userId: reviewThreads.originalCommenterId,
      path: reviewThreads.path,
      line: reviewThreads.line,
      state: reviewThreads.derivedState,
      createdAt: reviewThreads.createdAt,
      resolvedAt: reviewThreads.resolvedAt,
    })
    .from(reviewThreads)
    .innerJoin(pullRequests, eq(pullRequests.id, reviewThreads.prId))
    .where(
      and(
        eq(pullRequests.accountId, accountId),
        inArray(reviewThreads.originalCommenterId, automatedIds),
        gte(reviewThreads.createdAt, trendFrom),
        ...(toBound != null ? [lt(reviewThreads.createdAt, toBound)] : []),
        ...repoScopeFilter,
      ),
    )
    .execute();

  // "Merged past": PRs MERGED inside the window still carrying ≥1 untouched thread by the
  // bot — the team's FINAL answer was to ship anyway. A dedicated query (not the trend-span
  // thread walk above) so the threads may be arbitrarily older than the window; the WINDOW
  // applies to the PR's mergedAt. A NULL mergedAt never matches the gte. Display-only —
  // `verdict` never reads it.
  const mergedPastRows = await db
    .select({ prId: reviewThreads.prId, userId: reviewThreads.originalCommenterId })
    .from(reviewThreads)
    .innerJoin(pullRequests, eq(pullRequests.id, reviewThreads.prId))
    .where(
      and(
        eq(pullRequests.accountId, accountId),
        inArray(reviewThreads.originalCommenterId, automatedIds),
        eq(reviewThreads.derivedState, 'untouched'),
        gte(pullRequests.mergedAt, from),
        ...(toBound != null ? [lt(pullRequests.mergedAt, toBound)] : []),
        ...repoScopeFilter,
      ),
    )
    .execute();
  const mergedPastByUser = new Map<number, { prs: Set<number>; threads: number }>();
  for (const r of mergedPastRows) {
    if (r.userId == null) continue;
    let m = mergedPastByUser.get(r.userId);
    if (!m) {
      m = { prs: new Set(), threads: 0 };
      mergedPastByUser.set(r.userId, m);
    }
    m.prs.add(r.prId);
    m.threads += 1;
  }

  type Acc = {
    kind: AutomatedReviewerKind;
    reviewers: Set<number>;
    threads: number;
    actedOn: number;
    untouched: number;
    oldestUntouchedMs: number | null;
    humanFollow: number;
    // Time-to-ADDRESSED samples (ms) for THIS bot's window threads that were addressed by ANY
    // means — a human reply, a resolve, or an addressing commit (firstAddressed − createdAt). The
    // MEDIAN drives the per-vendor time-to-address column (info only — robust to the skew).
    addressedSamples: number[];
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
        addressedSamples: [],
        weekly: Array.from({ length: 12 }, () => ({ threads: 0, actedOn: 0, untouched: 0 })),
        buckets: new Map(),
      };
      byUser.set(userId, a);
    }
    return a;
  };

  // Last activity per reviewer across the trend span (thread opened / review comment /
  // submitted review) — context on every row, and what `dormant` is relative to.
  const lastActiveMsByUser = new Map<number, number>();
  const bumpLastActive = (userId: number, ms: number): void => {
    const cur = lastActiveMsByUser.get(userId);
    if (cur == null || ms > cur) lastActiveMsByUser.set(userId, ms);
  };

  // Trend (12 weekly buckets, oldest→newest) uses the full 12-week span.
  const windowThreads: { id: number; prId: number; userId: number; kind: AutomatedReviewerKind; path: string; line: number | null; state: DerivedState; createdAt: Date; resolvedAt: Date | null }[] = [];
  for (const t of threadRows) {
    if (t.userId == null) continue;
    const kind = kindMap.get(t.userId);
    if (!kind) continue;
    bumpLastActive(t.userId, t.createdAt.getTime());
    const acc = accFor(t.userId, kind);
    const acted = isActedOnThreadState(t.state);
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
      windowThreads.push({ id: t.id, prId: t.prId, userId: t.userId, kind, path: t.path, line: t.line, state: t.state, createdAt: t.createdAt, resolvedAt: t.resolvedAt });
    }
  }

  // Human follow-through: of the bot's window threads, the ones where a human commented after
  // the bot's last comment on that thread. Feeds BOTH the human-only humanFollowThroughPct
  // sub-figure (acc.humanFollow) AND the merged acted-on definition (humanFollowSet, item 6).
  const humanFollowSet = new Set<number>();
  // Each NOT-ADDRESSED window thread → the id of the bot comment that OPENED it. The ML severity
  // pass below joins `ml_comment_labels` on these ids; it is filled here because this is the one
  // place the threads' comments are already in memory (a second read of the same rows for the
  // severity split would be pure waste). Untouched-only on purpose: that is exactly the
  // population the "Not addressed" column counts, so the per-severity split cannot describe a
  // different set of threads than the total it sits beside.
  const originCommentIdByThread = new Map<number, number>();
  const wtIds = windowThreads.map((t) => t.id);
  if (wtIds.length > 0) {
    const ftRows = await db
      .select({
        id: reviewComments.id,
        threadId: reviewComments.threadId,
        authorId: reviewComments.authorId,
        createdAt: reviewComments.createdAt,
      })
      .from(reviewComments)
      .where(inArray(reviewComments.threadId, wtIds))
      .execute();
    const byThread = new Map<number, { id: number; authorId: number | null; at: number }[]>();
    for (const r of ftRows) {
      const arr = byThread.get(r.threadId) ?? [];
      arr.push({ id: r.id, authorId: r.authorId, at: r.createdAt.getTime() });
      byThread.set(r.threadId, arr);
    }
    for (const t of windowThreads) {
      if (t.state !== 'untouched') continue;
      // The thread's OWN bot (`originalCommenterId`), earliest comment first; ties break on the
      // lower id so the same thread resolves to the same comment on every run and in both
      // dialects (row order out of the join is not a promise).
      let origin: { id: number; at: number } | null = null;
      for (const c of byThread.get(t.id) ?? []) {
        if (c.authorId !== t.userId) continue;
        if (origin == null || c.at < origin.at || (c.at === origin.at && c.id < origin.id))
          origin = { id: c.id, at: c.at };
      }
      if (origin) originCommentIdByThread.set(t.id, origin.id);
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

    // Time-to-ADDRESSED per window thread = created → the FIRST time it was addressed by ANY
    // means: a human reply, the thread being resolved (any resolver — it WAS addressed), or a
    // commit that touched the thread's file after its last comment (the likely_addressed
    // heuristic, timed by that addressing commit). The MEDIAN feeds each bot's time-to-address
    // column (info only; the overdue gate is a fixed grace window, NOT this). A thread never
    // addressed contributes no sample — it IS a not-addressed thread.
    //
    // Commit times are needed only for likely_addressed threads, so load commits + changed-file
    // paths once for JUST those threads' PRs (the same signal derive-thread-state used).
    const laThreads = windowThreads.filter((t) => t.state === 'likely_addressed');
    const commitsByPr = new Map<number, { sha: string; ms: number }[]>();
    const pathsBySha = new Map<string, string[]>();
    if (laThreads.length > 0) {
      const laPrIds = [...new Set(laThreads.map((t) => t.prId))];
      const commitRows = await db
        .select({ prId: commits.prId, sha: commits.sha, committedAt: commits.committedAt })
        .from(commits)
        .where(inArray(commits.prId, laPrIds))
        .execute();
      for (const c of commitRows) {
        const arr = commitsByPr.get(c.prId) ?? [];
        arr.push({ sha: c.sha, ms: c.committedAt.getTime() });
        commitsByPr.set(c.prId, arr);
      }
      for (const arr of commitsByPr.values()) arr.sort((a, b) => a.ms - b.ms);
      const shas = [...new Set(commitRows.map((c) => c.sha))];
      if (shas.length > 0) {
        for (const f of await db
          .select({ sha: commitFiles.sha, paths: commitFiles.paths })
          .from(commitFiles)
          .where(inArray(commitFiles.sha, shas))
          .execute()) {
          pathsBySha.set(f.sha, f.paths);
        }
      }
    }
    // Earliest commit on the PR AFTER `afterMs` that touched `path` (commits pre-sorted ascending).
    const addressingCommitMs = (prId: number, path: string, afterMs: number): number | null => {
      for (const c of commitsByPr.get(prId) ?? []) {
        if (c.ms <= afterMs) continue;
        if ((pathsBySha.get(c.sha) ?? []).includes(path)) return c.ms;
      }
      return null;
    };

    for (const t of windowThreads) {
      const createdMs = t.createdAt.getTime();
      const comments = byThread.get(t.id) ?? [];
      let addressedMs: number | null = null;
      const consider = (ms: number | null): void => {
        if (ms != null && ms > createdMs && (addressedMs == null || ms < addressedMs)) addressedMs = ms;
      };
      // A human reply on the thread, or the thread being resolved (any resolver — it was addressed).
      for (const c of comments) {
        if (c.authorId != null && !automatedIds.includes(c.authorId)) consider(c.at);
      }
      consider(t.resolvedAt != null ? t.resolvedAt.getTime() : null);
      // A commit that addressed it — timed by the first file-touching commit after the last comment.
      if (t.state === 'likely_addressed') {
        const lastCommentMs = comments.length ? Math.max(...comments.map((c) => c.at)) : createdMs;
        consider(addressingCommitMs(t.prId, t.path, lastCommentMs));
      }
      if (addressedMs != null) {
        accFor(t.userId, t.kind).addressedSamples.push(addressedMs - createdMs);
      }
    }
  }

  // The overdue gate is the FIXED grace window (see OVERDUE_GRACE_MS) — not the measured reply
  // time. An untouched thread only counts as OVERDUE (and only then feeds the noisy verdict) once
  // its age exceeds it, so a bot isn't penalised for threads still inside the grace window.
  const overdueGateMs = OVERDUE_GRACE_MS;
  const overdueByUser = new Map<number, number>();
  for (const t of windowThreads) {
    if (t.state !== 'untouched') continue;
    if (nowMs - t.createdAt.getTime() > overdueGateMs) {
      overdueByUser.set(t.userId, (overdueByUser.get(t.userId) ?? 0) + 1);
    }
  }

  // ── "Not addressed" BY ML SEVERITY (CORE, free — docs/ML-SEVERITY.md) ─────────────────────
  // The `untouched` column split by how bad the model thinks each ignored finding was: "17 not
  // addressed" is a volume complaint, "3 of them major" is a decision. Same population as that
  // column by construction (`originCommentIdByThread` is untouched-only), bucketed by the label
  // on the comment that OPENED the thread — the finding itself, not a later reply.
  //
  // ONE query over the whole scope, never a per-vendor fan-out: the ids are already collected and
  // the read is the label table's own (account, kind, target) unique. A thread whose origin
  // comment carries NO label simply does not count — the four numbers are a split of the LABELLED
  // untouched threads and must not be read as summing to `untouched` (the UI blanks a zero for
  // exactly this reason). Summaries and praise are excluded, the same exclusion the fold applies:
  // a walkthrough nobody replied to is not an ignored finding.
  const notAddressedBySeverityByUser = new Map<number, MlSeverityCounts>();
  if (originCommentIdByThread.size > 0) {
    const labelByCommentId = new Map<number, { severity: MlSeverity; skip: boolean }>();
    for (const r of await db
      .select({
        targetId: mlCommentLabels.targetId,
        severity: mlCommentLabels.severity,
        categories: mlCommentLabels.categories,
        isSummary: mlCommentLabels.isSummary,
      })
      .from(mlCommentLabels)
      .where(
        and(
          eq(mlCommentLabels.accountId, accountId),
          eq(mlCommentLabels.targetKind, 'review_comment'),
          inArray(mlCommentLabels.targetId, [...originCommentIdByThread.values()]),
        ),
      )
      .execute()) {
      const severity = ML_SEVERITY_KEYS.find((s) => s === r.severity);
      if (!severity) continue; // the column is plain text in both dialects — an unreadable value is no claim
      const categories = Array.isArray(r.categories) ? r.categories : [];
      labelByCommentId.set(r.targetId, {
        severity,
        skip: r.isSummary === true || categories.includes('praise'),
      });
    }
    for (const t of windowThreads) {
      if (t.state !== 'untouched') continue;
      const commentId = originCommentIdByThread.get(t.id);
      if (commentId == null) continue;
      const label = labelByCommentId.get(commentId);
      if (!label || label.skip) continue;
      const counts = notAddressedBySeverityByUser.get(t.userId) ?? emptyMlSeverityCounts();
      counts[label.severity] += 1;
      notAddressedBySeverityByUser.set(t.userId, counts);
    }
  }

  // Item 6 — merged "acted-on": a window thread counts as acted-on when it's resolved or
  // likely_addressed (the commit heuristic) OR a human followed up after the bot (humanFollowSet).
  for (const t of windowThreads) {
    if (isActedOnThreadState(t.state) || humanFollowSet.has(t.id)) {
      accFor(t.userId, t.kind).actedOn += 1;
    }
  }

  // ── Same-line overlap (ADVISORY — the redundancy signal) ──────────────────────────────────
  // THE shared ±3-line clustering (db/line-overlap.ts — the same definition the per-PR dedup
  // rollup renders), over the window's REVIEW-role threads. Quality checks are excluded on both
  // sides (the dedup stance, kept: a rule firing is not review consensus); null-line threads
  // (outdated / file-level) are excluded too — a thread LOSES its line when it outdates, and a
  // per-file null lump manufactures overlap out of any two chatty bots. A cluster with ≥2
  // DISTINCT bots credits EACH bot's threads in it (→ overlapPct = the share of a bot's output
  // landing where another bot also landed) and counts ONCE per sorted pair for the top-partner
  // attribution. Advisory only: a column + a suggestion — botVerdict never reads any of this.
  const overlapThreadsByUser = new Map<number, number>();
  const overlapPairClusters = new Map<string, number>(); // `u<a>|u<b>` (a < b) → shared clusters
  // The qualifying clusters themselves — the ONE scope-level number behind "line areas more than
  // one bot flagged". Counted here rather than derived from the per-vendor columns because those
  // credit EACH member of a cluster, so summing them double-counts by construction.
  let overlapClusters = 0;
  {
    const reviewRoleThreads = windowThreads.filter((t) => roleMap.get(t.userId) !== 'quality_check');
    for (const c of clusterThreadsByLine(reviewRoleThreads, { nullLineGroup: false })) {
      if (c.userIds.size < 2) continue;
      overlapClusters += 1;
      for (const t of c.items)
        overlapThreadsByUser.set(t.userId, (overlapThreadsByUser.get(t.userId) ?? 0) + 1);
      const ids = [...c.userIds].sort((x, y) => x - y);
      for (let i = 0; i < ids.length; i++)
        for (let j = i + 1; j < ids.length; j++) {
          const k = `u${ids[i]}|u${ids[j]}`;
          overlapPairClusters.set(k, (overlapPairClusters.get(k) ?? 0) + 1);
        }
    }
  }
  // Each bot's top overlap partner (most shared clusters; ties break to the lower userId for
  // determinism). Only `topOverlapPartner` ships — the pair map itself stays server-side, so
  // no capped pair list is needed on this wire (the behaviour surface's top-15 covers pairs).
  const topPartnerByUser = new Map<number, { userId: number; clusters: number }>();
  for (const [k, clusters] of overlapPairClusters) {
    const [a, b] = k.split('|').map((s) => Number(s.slice(1))) as [number, number];
    for (const [self, other] of [
      [a, b],
      [b, a],
    ] as const) {
      const cur = topPartnerByUser.get(self);
      if (!cur || clusters > cur.clusters || (clusters === cur.clusters && other < cur.userId))
        topPartnerByUser.set(self, { userId: other, clusters });
    }
  }

  // Comments volume per REVIEWER — fetched over the TREND span (⊇ the window) so the same
  // rows also feed lastActiveAt; only createdAt >= from counts toward window volume.
  const commentRows = await db
    .select({ authorId: reviewComments.authorId, createdAt: reviewComments.createdAt })
    .from(reviewComments)
    .innerJoin(pullRequests, eq(pullRequests.id, reviewComments.prId))
    .where(
      and(
        eq(pullRequests.accountId, accountId),
        inArray(reviewComments.authorId, automatedIds),
        gte(reviewComments.createdAt, trendFrom),
        ...(toBound != null ? [lt(reviewComments.createdAt, toBound)] : []),
        ...repoScopeFilter,
      ),
    )
    .execute();
  // Reviewers whose only trend-span footprint is comments/reviews (no authored threads) still
  // need an accumulator + a survival signal, or they vanish instead of going dormant.
  const trendActiveUserIds = new Set<number>();
  const commentsByUser = new Map<number, number>();
  for (const r of commentRows) {
    if (r.authorId == null) continue;
    const kind = kindMap.get(r.authorId);
    if (!kind) continue;
    bumpLastActive(r.authorId, r.createdAt.getTime());
    accFor(r.authorId, kind);
    trendActiveUserIds.add(r.authorId);
    if (r.createdAt >= from)
      commentsByUser.set(r.authorId, (commentsByUser.get(r.authorId) ?? 0) + 1);
  }

  // Submitted reviews per REVIEWER over the trend span. A body-only review (no inline
  // threads — e.g. Copilot's "reviewed, nothing to flag" pass) is still window ACTIVITY: it
  // gates row emission + dormancy and feeds lastActiveAt, but deliberately stays OUT of the
  // volume / acted-on math (that stays threads + comments).
  const reviewSubmitRows = await db
    .select({ authorId: reviews.authorId, submittedAt: reviews.submittedAt })
    .from(reviews)
    .innerJoin(pullRequests, eq(pullRequests.id, reviews.prId))
    .where(
      and(
        eq(pullRequests.accountId, accountId),
        inArray(reviews.authorId, automatedIds),
        ne(reviews.state, 'pending'),
        gte(reviews.submittedAt, trendFrom),
        ...(toBound != null ? [lt(reviews.submittedAt, toBound)] : []),
        ...repoScopeFilter,
      ),
    )
    .execute();
  const windowReviewsByUser = new Map<number, number>();
  for (const r of reviewSubmitRows) {
    if (r.authorId == null) continue;
    const kind = kindMap.get(r.authorId);
    if (!kind) continue;
    bumpLastActive(r.authorId, r.submittedAt.getTime());
    // A reviews-only reviewer (zero threads across the trend span) still needs a row —
    // even when its last review predates the window, so it can surface as DORMANT.
    accFor(r.authorId, kind);
    trendActiveUserIds.add(r.authorId);
    if (r.submittedAt >= from)
      windowReviewsByUser.set(r.authorId, (windowReviewsByUser.get(r.authorId) ?? 0) + 1);
  }

  const suggestions: BotTuningSuggestion[] = [];
  const vendors: BotVendorAnalytics[] = [];
  // Automated reviewers whose resolved ReviewerRole is 'quality_check' (SonarQube, Codecov, …).
  // Same row shape, computed the same way, but kept OUT of `vendors`/`totals`/`suggestions`:
  // their volume inflates thread counts and their untouched threads would earn them a `noisy`
  // verdict for doing exactly their job. Surfaced as their own collapsed section so a user can
  // still see the bot is running and can spot a mis-role.
  const qualityChecks: BotVendorAnalytics[] = [];
  for (const [userId, acc] of byUser) {
    const comments = commentsByUser.get(userId) ?? 0;
    // This bot's windowed ML label aggregate — undefined when it has no labels in the window,
    // and the row then OMITS the ml* fields entirely (blanks in the UI, never zeros).
    //
    // ⚠ `labelled > 0`, not bare presence: under `inflationHistory` the widened scan creates an
    // accumulator for a bot whose only labels PREDATE the window, and shipping its zeros would
    // change what a present `mlFindings: 0` means ("in-window labels exist, all summaries/praise").
    const mlRowRaw = mlAgg.byBot.get(userId);
    const mlRow = mlRowRaw != null && mlRowRaw.labelled > 0 ? mlRowRaw : undefined;
    // Window activity = threads/comments (the volume math) OR a body-only submitted review.
    // No window activity but ANY 12-week-trend footprint (threads, comments, or body-only
    // reviews) → the row survives as DORMANT (zeroed window counts + the trend) instead of
    // vanishing from the table.
    const hasWindowActivity =
      acc.threads > 0 || comments > 0 || (windowReviewsByUser.get(userId) ?? 0) > 0;
    if (!hasWindowActivity && !acc.weekly.some((w) => w.threads > 0) && !trendActiveUserIds.has(userId))
      continue;
    const dormant = !hasWindowActivity;
    const lastActiveMs = lastActiveMsByUser.get(userId);
    const kind = acc.kind;
    const label = reviewerLabel(userId, kind);
    const actedOnPct = acc.threads > 0 ? Math.round((acc.actedOn / acc.threads) * 100) : null;
    const oldestUntouchedDays =
      acc.oldestUntouchedMs == null ? null : Math.floor((nowMs - acc.oldestUntouchedMs) / 86_400_000);
    const humanFollowThroughPct = acc.threads > 0 ? Math.round((acc.humanFollow / acc.threads) * 100) : null;
    // Noise ratio: untouched-share proxy (see the header — true severity is often unknowable).
    const noiseRatioPct = acc.threads > 0 ? Math.round((acc.untouched / acc.threads) * 100) : null;
    // Same-line overlap for this bot (always 0 / null for quality checks — excluded from the pass).
    const overlapThreads = overlapThreadsByUser.get(userId) ?? 0;
    const overlapPct = acc.threads > 0 ? Math.round((overlapThreads / acc.threads) * 100) : null;
    const topPartner = topPartnerByUser.get(userId);
    // This bot's own MEDIAN time-to-addressed (reply | resolve | addressing commit); display-only,
    // null when no thread of its was ever addressed.
    const botMedian = medianOf(acc.addressedSamples);
    const medianAddressedMs = botMedian == null ? null : Math.round(botMedian);
    // Not-addressed (untouched) threads that have aged past the account-wide normal response
    // window — the ones that are genuinely being ignored. This gates the noisy verdict.
    const overdueUntouched = overdueByUser.get(userId) ?? 0;
    // The ROLE decides which array this row lands in. Everything above is computed identically
    // for both — a quality check's numbers are real, they are just not REVIEW numbers.
    //
    // ⚠ `!== 'review'`, NEVER `=== 'quality_check'`. The wire field is still called
    // `qualityChecks` for compatibility, but it now holds EVERY non-reviewer role — dependency,
    // code_agent, release and housekeeping as well. Testing for the one old role would send all
    // four newer ones into `vendors`, i.e. straight back into the AI-reviewer ROI table this
    // split exists to keep clean. An absent entry means no stored row and no seeded login, which
    // is the historical default 'review'.
    const isQualityCheck = (roleMap.get(userId) ?? 'review') !== 'review';
    // `?? null` (never `||`): a stored 0 is a REAL price ("we pay nothing for this bot") and must
    // survive as 0, not collapse to "unknown". Nothing inherits, so there is no chain to walk.
    const storedCost = costMap.get(userId);
    const costModel: CostModel = storedCost?.costModel ?? 'flat';
    const unitUsd = storedCost?.unitMonthlyUsd ?? null;
    // The EFFECTIVE monthly (unit × seats under per_seat, computed here on read — the product is
    // never stored) rides the long-standing `costMonthlyUsd` field, so every consumer — the ROI
    // cell, `costPerActedOnUsd`, within-workspace totals — is seat-adjusted without knowing seats
    // exist. The stored unit survives as `costUnitMonthlyUsd` for tooltip copy.
    const costMonthlyUsd =
      unitUsd == null
        ? null
        : costModel === 'per_seat'
          ? Math.round(unitUsd * seatCount * 100) / 100
          : unitUsd;
    const trend: BotVendorTrendPoint[] = acc.weekly.map((w, i) => ({
      weekStart: new Date(trendFrom.getTime() + i * 7 * 86_400_000).toISOString(),
      threads: w.threads,
      actedOnPct: w.threads > 0 ? Math.round((w.actedOn / w.threads) * 100) : null,
      untouched: w.untouched,
    }));
    (isQualityCheck ? qualityChecks : vendors).push({
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
      overdueUntouched,
      medianAddressedMs,
      oldestUntouchedDays,
      humanFollowThroughPct,
      noiseRatioPct,
      mergedPastPrs: mergedPastByUser.get(userId)?.prs.size ?? 0,
      mergedPastThreads: mergedPastByUser.get(userId)?.threads ?? 0,
      overlapThreads,
      overlapPct,
      topOverlapPartner: topPartner
        ? {
            key: `u${topPartner.userId}`,
            label: reviewerLabel(topPartner.userId, kindMap.get(topPartner.userId) ?? 'in_house'),
            clusters: topPartner.clusters,
          }
        : null,
      // ML severity mix over the SAME window (fields absent when the bot has no in-window
      // labels). Rates divide by FINDINGS — the phantom-gap rule — and round like their `…Pct`
      // siblings; the suggestion gate below uses the raw share, not these rounded figures.
      ...(mlRow
        ? {
            mlFindings: mlRow.findings,
            mlBySeverity: mlRow.bySeverity,
            mlNitPct:
              mlRow.findings > 0
                ? Math.round((mlRow.bySeverity.nit / mlRow.findings) * 100)
                : null,
            mlHighPct:
              mlRow.findings > 0 ? Math.round((mlRow.high / mlRow.findings) * 100) : null,
            // The not-addressed threads split by the severity of the finding that opened them.
            // Rides the same `mlRow` gate as its siblings — a bot with no in-window labels has no
            // ML claim to make about its backlog either. Zeros here mean "labels exist, none of
            // the ignored threads are scored that way"; the UI blanks them like the other ML cells.
            notAddressedBySeverity:
              notAddressedBySeverityByUser.get(userId) ?? emptyMlSeverityCounts(),
            // The Inflation column (plan P1.2/C2): counts partition `badged` (never `findings`),
            // direction via the ONE shared `vendorAgreementOf` rule — so each count equals the
            // flagging drill-down's `filteredTotal` for the same bot + direction. `weekly` ships
            // only under the `botDepth` entitlement (the route's `inflationHistory` flag); a
            // sparkline of all-zero weeks is dropped — nothing to draw.
            mlInflation: {
              badged: mlRow.vendorBadged,
              overCall: mlRow.vendorOverCall,
              underCall: mlRow.vendorUnderCall,
              ...(mlRow.inflationWeekly != null &&
              mlRow.inflationWeekly.some((w) => w.overCall > 0 || w.underCall > 0)
                ? { weekly: mlRow.inflationWeekly }
                : {}),
            },
          }
        : {}),
      // The verdict uses OVERDUE untouched (aged past the norm), not raw untouched — so a bot
      // isn't flagged noisy for threads the workspace just hasn't gotten to within its normal window.
      // The ONE ML input is the nit ratio, and it can only ESCALATE 'keep' → 'tune' (see
      // botVerdict): a bot whose threads all get answered is invisible to the thread math even
      // when the team is triaging its nits by hand. Same gates as the suggestion below, so the
      // chip and the advisory always agree. Semantics pinned by bot-analytics-verdict.test.ts.
      verdict: botVerdict(
        acc.threads,
        actedOnPct,
        overdueUntouched,
        mlRow ? { findings: mlRow.findings, nits: mlRow.bySeverity.nit } : null,
      ),
      // `?? null` (never `||`): a resolved 0 is a REAL price ("we pay nothing for this
      // bot") and must survive as 0, not collapse to "unknown". $/acted-on divides the EFFECTIVE
      // monthly and is null whenever the price is unknown or nothing was acted on — dividing by 0
      // would print Infinity.
      costMonthlyUsd: costMonthlyUsd,
      costPerActedOnUsd:
        costMonthlyUsd != null && acc.actedOn > 0 ? costMonthlyUsd / acc.actedOn : null,
      costModel,
      costSeatCount: seatCount,
      costUnitMonthlyUsd: costModel === 'per_seat' ? unitUsd : null,
      dormant,
      lastActiveAt: lastActiveMs != null ? new Date(lastActiveMs).toISOString() : null,
      trend,
    });
    // Deterministic, ADVISORY tuning suggestions (§3h): a (reviewer, path-bucket) with volume
    // ≥ 5 and untouchedPct ≥ 70 → a "mostly noise" hint. No action attached — the reader tunes
    // the bot on its own platform (or resolves addressed threads via the confirm-gated flow).
    // Quality checks are skipped: "most of SonarQube's findings in src/** went untouched" is the
    // normal, expected state of a linter, so a suggestion there is pure noise about noise.
    if (isQualityCheck) continue;
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
        rationale: `${untouchedPct}% of ${label}'s ${b.volume} threads in ${pb} went untouched — mostly noise; consider tuning this bot.`,
      });
    }
    // ML nit-ratio advisory — the severity-slot suggestion: a bot whose scored findings are
    // overwhelmingly nits probably has its severity floor set too low. Gated on a real sample so
    // a bot is never judged on a handful of labels. Quality checks are skipped by the `continue`
    // above — a linter's findings being nits is its job, not a tuning signal.
    //
    // It shares its gates with the verdict's escalation (ML_NIT_MIN_*), so whenever this
    // sentence appears the chip above it reads at least 'tune'. That is the point of one pair of
    // constants: the suggestion explains what the chip is reacting to, rather than being a second
    // opinion about it.
    if (mlRow && mlRow.findings >= ML_NIT_MIN_FINDINGS) {
      const nitShare = mlRow.bySeverity.nit / mlRow.findings;
      if (nitShare >= ML_NIT_MIN_SHARE) {
        const nitPct = Math.round(nitShare * 100);
        suggestions.push({
          vendorKind: kind,
          label,
          pathGlob: null,
          severity: 'nit',
          // The share this suggestion keys on (see BotTuningSuggestion in shared): nit share
          // for a severity suggestion, over `volume` = scored findings.
          untouchedPct: nitPct,
          volume: mlRow.findings,
          rationale: `${nitPct}% of ${label}'s ${mlRow.findings} scored findings are nits — consider raising its severity floor.`,
        });
      }
    }
    // Same-line overlap advisory — redundant coverage. Gated on the RAW share (like the nit
    // suggestion; `overlapPct` is the rounded display twin) plus a volume floor. Overlap is
    // symmetric, so BOTH bots of a heavy pair can earn one (each names the other) — pair-level
    // presentation on purpose; the reader decides which of the two to narrow.
    if (acc.threads >= OVERLAP_SUGGESTION_MIN_THREADS && topPartner) {
      const overlapShare = overlapThreads / acc.threads;
      if (overlapShare >= OVERLAP_SUGGESTION_MIN_SHARE) {
        const partnerLabel = reviewerLabel(
          topPartner.userId,
          kindMap.get(topPartner.userId) ?? 'in_house',
        );
        suggestions.push({
          vendorKind: kind,
          label,
          pathGlob: null,
          severity: null,
          partnerLabel,
          untouchedPct: Math.round(overlapShare * 100),
          volume: acc.threads,
          // `overlapThreads` pools clusters shared with ANY bot, while `partnerLabel` names
          // only the top pair — so the pooled count must not be attributed to the partner
          // (with 3+ overlapping bots that overstates the named pair, sometimes ~2×). The
          // pooled figure describes the bot; the pair figure describes the partner.
          rationale: `${overlapThreads} of ${label}'s threads land on lines other bots also flagged (most often ${partnerLabel}: ${topPartner.clusters} shared cluster${topPartner.clusters === 1 ? '' : 's'}) — redundant coverage; consider narrowing one of them.`,
        });
      }
    }
  }
  vendors.sort((a, b) => b.threads - a.threads || b.comments - a.comments);
  qualityChecks.sort((a, b) => b.threads - a.threads || b.comments - a.comments);
  suggestions.sort((a, b) => b.volume - a.volume);

  // Item 4b — bot-only OPEN PR count over THIS WORKSPACE's repos, using the same broadened rule
  // as getBotOnlyReviewPrs (item 4a): automated touch (review OR comment, incl. Pierre-verbatim)
  // with no human review AND no human comment. OPEN-only (`openOnly`) — the banner is a live
  // "needs a human before it merges" signal, so merged PRs (already shipped) are excluded; the
  // drill-down list still offers them behind a toggle. It takes the SAME `scope`, so the count and
  // the list it opens cannot disagree about either the repos or the verdict.
  const botOnlyPrs = (
    await getBotOnlyReviewPrs(accountId, scope, { from, to }, { openOnly: true })
  ).length;

  // Totals sum `vendors` ONLY — quality checks are excluded by construction (they're in their own
  // array). That is the point of the role: a linter's thread volume must not move the headline
  // acted-on %, which is a claim about REVIEW throughput.
  const totalThreads = vendors.reduce((s, v) => s + v.threads, 0);
  const totalActedOn = vendors.reduce((s, v) => s + v.actedOn, 0);
  const totals = {
    threads: totalThreads,
    comments: vendors.reduce((s, v) => s + v.comments, 0),
    actedOn: totalActedOn,
    actedOnPct: totalThreads > 0 ? Math.round((totalActedOn / totalThreads) * 100) : null,
    untouched: vendors.reduce((s, v) => s + v.untouched, 0),
    botOnlyPrs,
    // The fixed overdue grace window (ms): a not-addressed thread is "overdue" (feeding the noisy
    // verdict) once it's older than this. Exposed so the UI can state the rule ("overdue after 36h").
    overdueGraceMs: OVERDUE_GRACE_MS,
    // Line areas MORE THAN ONE review bot flagged in this window (the shared ±3-line clustering).
    // A scope-level count, not a per-bot one — it answers "how much of this window did two tools
    // both cover", which the per-vendor `overlapThreads` cannot: those credit every member of a
    // cluster, so adding them up counts each shared spot twice or more.
    overlapClusters,
  };
  // `ml` rides every non-empty response (the two empty-scope early returns omit it — treat
  // absent as "nothing labelled"). The totals cover the WHOLE automated set, both roles.
  return { enabled: true, generatedAt, window: win, vendors, qualityChecks, totals, ml: mlAgg.totals, suggestions };
}

// ── Bot Tuning Advisor findings (CORE, deterministic — the Pro advisor's evidence layer) ────
// A NEW query, not a getBotAnalytics extension: that getter is the Bots-tab hot path at
// per-reviewer grain, while the advisor's grain is per-CELL over the whole labelled corpus
// ((bot × path-bucket), (bot × category), (bot × partner)). It REUSES, never re-derives: the
// shared acted-on predicate, OVERDUE_GRACE_MS, pathBucket (already the `<seg>/**` glob shape),
// clusterThreadsByLine, and the one window mapping. Cells are pure evidence — the plugin turns
// them into intents; NOTHING here may ever feed botVerdict (the advisory invariant pinned by
// bot-analytics-verdict.test.ts holds for this surface too).
//
// Quality-check reviewers appear in `bots` (context; the UI can explain why a linter has no
// findings) but emit NO cells — a linter's untouched findings are its job (the same rule the
// tuning suggestions apply).
//
// Path coverage: only labels of the `review_comment` kind can ever resolve to a path (PR
// comments and review bodies have no file). `pathCoveragePct` discloses that per bot and
// corpus-wide, and every path-keyed consumer must render it.
const ADVISOR_SCAN_CAP = 50_000; // same honesty cap as the ML rollup scan (ml-labels.ts)

export async function getAdvisorFindings(
  accountId: number,
  window: BotWindowKind,
  scope: BotScope,
): Promise<AdvisorFindingsPayload> {
  const nowMs = Date.now();
  const to = new Date(nowMs);
  // The one shared window→duration mapping (db/bot-window.ts).
  const from = new Date(nowMs - botWindowMs(window));
  const generatedAt = to.toISOString();
  const win = { kind: window, from: from.toISOString(), to: to.toISOString() };
  const floors = {
    minCellThreads: ADVISOR_MIN_CELL_THREADS,
    minCellFindings: ADVISOR_MIN_CELL_FINDINGS,
    amplifyMinActedPct: ADVISOR_AMPLIFY_MIN_ACTED_PCT,
    overdueGraceMs: OVERDUE_GRACE_MS,
  };
  const empty: AdvisorFindingsPayload = {
    generatedAt,
    window: win,
    workspaceId: scope.workspaceId,
    bots: [],
    pathCells: [],
    categoryCells: [],
    overlapCells: [],
    pathCoveragePct: null,
    floors,
  };
  if (scope.repoIds.length === 0) return empty;
  const automatedIds = await automatedReviewerUserIds(accountId, scope.workspaceId, 'all');
  if (automatedIds.length === 0) return empty;
  const kindMap = await classificationKindForUser(accountId, scope.workspaceId);
  const roleMap = await reviewerRoleForUser(accountId, scope.workspaceId);
  const classLabel = await classificationLabelMap(accountId, scope.workspaceId);
  const repoScopeFilter = [inArray(pullRequests.repoId, scope.repoIds)];

  // Identity maps — the same label preference getBotAnalytics uses.
  const loginById = new Map<number, string>();
  const rawLoginById = new Map<number, string>();
  for (const r of await db
    .select({ id: users.id, login: users.githubLogin, name: users.displayName })
    .from(users)
    .where(inArray(users.id, automatedIds))
    .execute()) {
    loginById.set(r.id, r.name?.trim() || r.login || `#${r.id}`);
    if (r.login) rawLoginById.set(r.id, r.login);
  }
  const reviewerLabel = (userId: number, kind: AutomatedReviewerKind): string => {
    const custom = classLabel.get(userId);
    if (custom) return custom;
    if (kind !== 'in_house' && kind !== 'pierre' && kind !== 'vendor')
      return labelForKind(kind);
    return loginById.get(userId) ?? labelForKind(kind);
  };

  // The bot's window THREADS (the path-cell + totals population). `prMerged` feeds the
  // mergedUntouched counts — an untouched thread whose PR has SINCE merged is the team's
  // final answer, the subset the plugin's suppression gate keys on.
  const threadRows = await db
    .select({
      id: reviewThreads.id,
      prId: reviewThreads.prId,
      userId: reviewThreads.originalCommenterId,
      path: reviewThreads.path,
      line: reviewThreads.line,
      state: reviewThreads.derivedState,
      createdAt: reviewThreads.createdAt,
      prState: pullRequests.state,
    })
    .from(reviewThreads)
    .innerJoin(pullRequests, eq(pullRequests.id, reviewThreads.prId))
    .where(
      and(
        eq(pullRequests.accountId, accountId),
        inArray(reviewThreads.originalCommenterId, automatedIds),
        gte(reviewThreads.createdAt, from),
        ...repoScopeFilter,
      ),
    )
    .execute();

  type WThread = {
    id: number;
    prId: number;
    userId: number;
    kind: AutomatedReviewerKind;
    path: string;
    line: number | null;
    state: string;
    createdAt: Date;
    prMerged: boolean;
  };
  const windowThreads: WThread[] = [];
  for (const t of threadRows) {
    if (t.userId == null) continue;
    const kind = kindMap.get(t.userId);
    if (!kind) continue;
    windowThreads.push({
      id: t.id,
      prId: t.prId,
      userId: t.userId,
      kind,
      path: t.path,
      line: t.line,
      state: t.state,
      createdAt: t.createdAt,
      prMerged: t.prState === 'merged',
    });
  }
  const threadById = new Map(windowThreads.map((t) => [t.id, t]));

  // One comments pass over the window threads → the human-follow-up set (the merged acted-on
  // definition) and the ORIGIN comment of every thread (unlike getBotAnalytics's untouched-only
  // map — category cells need acted-on facts for acted threads too).
  const humanFollowSet = new Set<number>();
  const threadIdByOriginComment = new Map<number, number>();
  if (windowThreads.length > 0) {
    const ftRows = await db
      .select({
        id: reviewComments.id,
        threadId: reviewComments.threadId,
        authorId: reviewComments.authorId,
        createdAt: reviewComments.createdAt,
      })
      .from(reviewComments)
      .where(inArray(reviewComments.threadId, windowThreads.map((t) => t.id)))
      .execute();
    const byThread = new Map<number, { id: number; authorId: number | null; at: number }[]>();
    for (const r of ftRows) {
      const arr = byThread.get(r.threadId) ?? [];
      arr.push({ id: r.id, authorId: r.authorId, at: r.createdAt.getTime() });
      byThread.set(r.threadId, arr);
    }
    for (const t of windowThreads) {
      // The thread's OWN bot, earliest comment first; ties break on the lower id (deterministic
      // in both dialects — row order out of the join is not a promise).
      let origin: { id: number; at: number } | null = null;
      for (const c of byThread.get(t.id) ?? []) {
        if (c.authorId !== t.userId) continue;
        if (origin == null || c.at < origin.at || (c.at === origin.at && c.id < origin.id))
          origin = { id: c.id, at: c.at };
      }
      if (origin) threadIdByOriginComment.set(origin.id, t.id);
      // Human follow-up after the bot's LAST comment on the thread.
      let botLastAt = -Infinity;
      for (const c of byThread.get(t.id) ?? []) {
        if (c.authorId != null && automatedIds.includes(c.authorId) && c.at > botLastAt)
          botLastAt = c.at;
      }
      if (
        (byThread.get(t.id) ?? []).some(
          (c) => c.authorId != null && !automatedIds.includes(c.authorId) && c.at > botLastAt,
        )
      )
        humanFollowSet.add(t.id);
    }
  }

  const isOverdue = (t: WThread): boolean =>
    t.state === 'untouched' && nowMs - t.createdAt.getTime() > OVERDUE_GRACE_MS;
  const isActed = (t: WThread): boolean =>
    isActedOnThreadState(t.state) || humanFollowSet.has(t.id);

  // The window LABEL scan (all three target kinds) — the category-cell + coverage population.
  const labelRows = await db
    .select({
      targetKind: mlCommentLabels.targetKind,
      targetId: mlCommentLabels.targetId,
      authorUserId: mlCommentLabels.authorUserId,
      prId: mlCommentLabels.prId,
      severity: mlCommentLabels.severity,
      categories: mlCommentLabels.categories,
      isSummary: mlCommentLabels.isSummary,
    })
    .from(mlCommentLabels)
    .where(
      and(
        eq(mlCommentLabels.accountId, accountId),
        inArray(mlCommentLabels.repoId, scope.repoIds),
        inArray(mlCommentLabels.authorUserId, automatedIds),
        gte(mlCommentLabels.targetCreatedAt, from),
      ),
    )
    .orderBy(desc(mlCommentLabels.targetCreatedAt), desc(mlCommentLabels.id))
    .limit(ADVISOR_SCAN_CAP)
    .execute();

  type BotAgg = {
    threads: number;
    actedOn: number;
    untouched: number;
    mergedUntouched: number;
    overdueUntouched: number;
    dissent: number;
    mlLabelled: number;
    mlFindings: number;
    mlNits: number;
    actedOnNits: number;
    mlWithPath: number;
  };
  const botAgg = new Map<number, BotAgg>();
  const botAggFor = (userId: number): BotAgg => {
    let a = botAgg.get(userId);
    if (!a) {
      a = {
        threads: 0,
        actedOn: 0,
        untouched: 0,
        mergedUntouched: 0,
        overdueUntouched: 0,
        dissent: 0,
        mlLabelled: 0,
        mlFindings: 0,
        mlNits: 0,
        actedOnNits: 0,
        mlWithPath: 0,
      };
      botAgg.set(userId, a);
    }
    return a;
  };

  const pushSample = (arr: number[], id: number): void => {
    if (arr.length < ADVISOR_SAMPLE_CAP && !arr.includes(id)) arr.push(id);
  };

  // Label pass: per-bot ML counts + coverage, category cells, and the per-thread origin label
  // (feeding the path cells' severity mix / actedOnHigh below).
  type CatAgg = {
    findings: number;
    bySeverity: MlSeverityCounts;
    threadLinked: number;
    actedOn: number;
    actedOnHigh: number;
    untouched: number;
    mergedUntouched: number;
    overdueUntouched: number;
    dissent: number;
    samplePrIds: number[];
  };
  const catAgg = new Map<number, Map<string, CatAgg>>();
  const originLabelByThread = new Map<number, MlSeverity>(); // findings only
  for (const r of labelRows) {
    const severity = ML_SEVERITY_KEYS.find((s) => s === r.severity);
    if (!severity) continue; // plain-text column — an unreadable value is no claim
    const agg = botAggFor(r.authorUserId);
    agg.mlLabelled += 1;
    if (r.targetKind === 'review_comment') agg.mlWithPath += 1;
    const categories = Array.isArray(r.categories) ? (r.categories as string[]) : [];
    const isFinding = r.isSummary !== true && !categories.includes('praise');
    if (!isFinding) continue;
    agg.mlFindings += 1;
    if (severity === 'nit') agg.mlNits += 1;
    // Thread linkage exists only for the origin comment of a window thread.
    const threadId =
      r.targetKind === 'review_comment' ? threadIdByOriginComment.get(r.targetId) : undefined;
    const thread = threadId != null ? threadById.get(threadId) : undefined;
    if (thread) originLabelByThread.set(thread.id, severity);
    if (roleMap.get(r.authorUserId) === 'quality_check') continue; // no cells for linters
    let byCat = catAgg.get(r.authorUserId);
    if (!byCat) {
      byCat = new Map();
      catAgg.set(r.authorUserId, byCat);
    }
    for (const category of categories) {
      if (category === 'praise') continue;
      let c = byCat.get(category);
      if (!c) {
        c = {
          findings: 0,
          bySeverity: emptyMlSeverityCounts(),
          threadLinked: 0,
          actedOn: 0,
          actedOnHigh: 0,
          untouched: 0,
          mergedUntouched: 0,
          overdueUntouched: 0,
          dissent: 0,
          samplePrIds: [],
        };
        byCat.set(category, c);
      }
      c.findings += 1;
      c.bySeverity[severity] += 1;
      pushSample(c.samplePrIds, r.prId);
      if (thread) {
        c.threadLinked += 1;
        if (isActed(thread)) {
          c.actedOn += 1;
          if (severity === 'major' || severity === 'critical') c.actedOnHigh += 1;
        }
        if (thread.state === 'untouched') {
          c.untouched += 1;
          if (thread.prMerged) c.mergedUntouched += 1;
        }
        if (isOverdue(thread)) c.overdueUntouched += 1;
        if (thread.state === 'replied_unresolved') c.dissent += 1;
      }
    }
  }

  // Thread pass: per-bot thread totals + path cells.
  //
  // Path buckets are ADAPTIVE-DEPTH: every thread aggregates into its depth-1 parent
  // (`a/**`) AND — when the path is deep enough — its depth-2 child (`a/b/**`). Emission
  // below prefers qualifying children; the parent is emitted only when NONE of its children
  // meets the thread floor, so emitted globs never overlap and the retro-check identity
  // ("our glob matches exactly the prefix the cell aggregated") holds at either depth.
  // A top-level `apps/**` cell over a monorepo where apps/ IS the codebase was too coarse
  // to act on — the free tuning suggestion keeps the depth-1 `pathBucket` above; this
  // sharper grouping is advisor-only.
  type PathAgg = {
    volume: number;
    actedOn: number;
    actedOnHigh: number;
    actedOnNits: number;
    untouched: number;
    mergedUntouched: number;
    overdueUntouched: number;
    dissent: number;
    bySeverity: MlSeverityCounts;
    samplePrIds: number[];
    sampleThreadIds: number[];
  };
  const emptyPathAgg = (): PathAgg => ({
    volume: 0,
    actedOn: 0,
    actedOnHigh: 0,
    actedOnNits: 0,
    untouched: 0,
    mergedUntouched: 0,
    overdueUntouched: 0,
    dissent: 0,
    bySeverity: emptyMlSeverityCounts(),
    samplePrIds: [],
    sampleThreadIds: [],
  });
  const advisorBucketKeys = (path: string): { parent: string; child: string | null } => {
    const segs = path.split('/');
    if (segs.length <= 1) return { parent: path, child: null }; // root-level file
    if (segs.length === 2) return { parent: `${segs[0]}/**`, child: null }; // direct file
    return { parent: `${segs[0]}/**`, child: `${segs[0]}/${segs[1]}/**` };
  };
  type PathGroup = { all: PathAgg; children: Map<string, PathAgg> };
  const pathAgg = new Map<number, Map<string, PathGroup>>();
  for (const t of windowThreads) {
    const agg = botAggFor(t.userId);
    agg.threads += 1;
    const acted = isActed(t);
    if (acted) agg.actedOn += 1;
    if (t.state === 'untouched') {
      agg.untouched += 1;
      if (t.prMerged) agg.mergedUntouched += 1;
    }
    if (isOverdue(t)) agg.overdueUntouched += 1;
    if (t.state === 'replied_unresolved') agg.dissent += 1;
    const originSeverity = originLabelByThread.get(t.id);
    if (acted && originSeverity === 'nit') agg.actedOnNits += 1;
    if (roleMap.get(t.userId) === 'quality_check') continue; // no cells for linters
    let byParent = pathAgg.get(t.userId);
    if (!byParent) {
      byParent = new Map();
      pathAgg.set(t.userId, byParent);
    }
    const { parent, child } = advisorBucketKeys(t.path);
    let group = byParent.get(parent);
    if (!group) {
      group = { all: emptyPathAgg(), children: new Map() };
      byParent.set(parent, group);
    }
    const targets = [group.all];
    if (child) {
      let c = group.children.get(child);
      if (!c) {
        c = emptyPathAgg();
        group.children.set(child, c);
      }
      targets.push(c);
    }
    for (const p of targets) {
      p.volume += 1;
      if (acted) {
        p.actedOn += 1;
        if (originSeverity === 'major' || originSeverity === 'critical') p.actedOnHigh += 1;
        if (originSeverity === 'nit') p.actedOnNits += 1;
      }
      if (t.state === 'untouched') {
        p.untouched += 1;
        if (t.prMerged) p.mergedUntouched += 1;
      }
      if (isOverdue(t)) p.overdueUntouched += 1;
      if (t.state === 'replied_unresolved') p.dissent += 1;
      if (originSeverity) p.bySeverity[originSeverity] += 1;
      pushSample(p.samplePrIds, t.prId);
      pushSample(p.sampleThreadIds, t.id);
    }
  }

  // Overlap pass — the shared ±3-line clustering, review-role bots only (both the dedup and
  // the ROI overlap column apply the same exclusion).
  const overlapThreadsByUser = new Map<number, number>();
  const overlapPairClusters = new Map<string, number>();
  {
    const reviewRoleThreads = windowThreads.filter(
      (t) => roleMap.get(t.userId) !== 'quality_check',
    );
    for (const c of clusterThreadsByLine(reviewRoleThreads, { nullLineGroup: false })) {
      if (c.userIds.size < 2) continue;
      for (const t of c.items)
        overlapThreadsByUser.set(t.userId, (overlapThreadsByUser.get(t.userId) ?? 0) + 1);
      const ids = [...c.userIds].sort((x, y) => x - y);
      for (let i = 0; i < ids.length; i++)
        for (let j = i + 1; j < ids.length; j++) {
          const k = `u${ids[i]}|u${ids[j]}`;
          overlapPairClusters.set(k, (overlapPairClusters.get(k) ?? 0) + 1);
        }
    }
  }

  // ── Emission (floors + deterministic ordering) ───────────────────────────────────────────
  const bots: AdvisorBotTotals[] = [];
  for (const [userId, agg] of botAgg) {
    if (agg.threads === 0 && agg.mlLabelled === 0) continue;
    const kind = kindMap.get(userId) ?? 'in_house';
    const actedOnPct = agg.threads > 0 ? Math.round((agg.actedOn / agg.threads) * 100) : null;
    bots.push({
      botUserId: userId,
      key: `u${userId}`,
      kind,
      label: reviewerLabel(userId, kind),
      login: rawLoginById.get(userId) ?? null,
      // `!== 'review'` — the flag means "not a reviewer", and it has to keep meaning that now the
      // role union carries dependency / code_agent / release / housekeeping. See the note beside
      // the `qualityChecks` split in getBotAnalytics.
      isQualityCheck: (roleMap.get(userId) ?? 'review') !== 'review',
      threads: agg.threads,
      actedOn: agg.actedOn,
      untouched: agg.untouched,
      mergedUntouched: agg.mergedUntouched,
      overdueUntouched: agg.overdueUntouched,
      dissent: agg.dissent,
      mlLabelled: agg.mlLabelled,
      mlFindings: agg.mlFindings,
      mlNits: agg.mlNits,
      actedOnNits: agg.actedOnNits,
      pathCoveragePct:
        agg.mlLabelled > 0 ? Math.round((agg.mlWithPath / agg.mlLabelled) * 100) : null,
      // READ-only use of the verdict (context for the advisor UI); the advisory invariant runs
      // the other way — nothing computed here feeds botVerdict.
      verdict: botVerdict(
        agg.threads,
        actedOnPct,
        agg.overdueUntouched,
        agg.mlFindings > 0 ? { findings: agg.mlFindings, nits: agg.mlNits } : null,
      ),
    });
  }
  bots.sort((a, b) => b.threads - a.threads || b.mlFindings - a.mlFindings || a.botUserId - b.botUserId);

  const pathCells: AdvisorPathCell[] = [];
  for (const [userId, byParent] of pathAgg) {
    for (const [parentKey, group] of byParent) {
      // Prefer qualifying depth-2 children; the coarse parent only when none qualifies.
      // Sub-floor children (and, when children win, the parent's direct-file remainder)
      // are unreported — the same statement the floors already make everywhere else.
      const qualifying = [...group.children.entries()].filter(
        ([, p]) => p.volume >= ADVISOR_MIN_CELL_THREADS,
      );
      const emit: [string, PathAgg][] =
        qualifying.length > 0
          ? qualifying
          : group.all.volume >= ADVISOR_MIN_CELL_THREADS
            ? [[parentKey, group.all]]
            : [];
      for (const [bucket, p] of emit) {
        pathCells.push({
          botUserId: userId,
          pathBucket: bucket,
          volume: p.volume,
          actedOn: p.actedOn,
          actedOnHigh: p.actedOnHigh,
          actedOnNits: p.actedOnNits,
          untouched: p.untouched,
          mergedUntouched: p.mergedUntouched,
          overdueUntouched: p.overdueUntouched,
          dissent: p.dissent,
          bySeverity: p.bySeverity,
          samplePrIds: p.samplePrIds,
          sampleThreadIds: p.sampleThreadIds,
        });
      }
    }
  }
  pathCells.sort(
    (a, b) => b.volume - a.volume || a.botUserId - b.botUserId || a.pathBucket.localeCompare(b.pathBucket),
  );

  const categoryCells: AdvisorCategoryCell[] = [];
  for (const [userId, byCat] of catAgg) {
    for (const [category, c] of byCat) {
      if (c.findings < ADVISOR_MIN_CELL_FINDINGS) continue;
      categoryCells.push({
        botUserId: userId,
        category: category as MlCategory,
        findings: c.findings,
        bySeverity: c.bySeverity,
        threadLinked: c.threadLinked,
        actedOn: c.actedOn,
        actedOnHigh: c.actedOnHigh,
        untouched: c.untouched,
        mergedUntouched: c.mergedUntouched,
        overdueUntouched: c.overdueUntouched,
        dissent: c.dissent,
        samplePrIds: c.samplePrIds,
      });
    }
  }
  categoryCells.sort(
    (a, b) =>
      b.findings - a.findings || a.botUserId - b.botUserId || a.category.localeCompare(b.category),
  );

  const overlapCells: AdvisorOverlapCell[] = [];
  for (const [k, sharedClusters] of overlapPairClusters) {
    const [a, b] = k.split('|').map((s) => Number(s.slice(1))) as [number, number];
    for (const [self, other] of [
      [a, b],
      [b, a],
    ] as const) {
      const threads = botAgg.get(self)?.threads ?? 0;
      if (threads < ADVISOR_MIN_CELL_THREADS) continue;
      overlapCells.push({
        botUserId: self,
        partnerUserId: other,
        sharedClusters,
        overlapThreads: overlapThreadsByUser.get(self) ?? 0,
        threads,
      });
    }
  }
  overlapCells.sort(
    (a, b) =>
      b.sharedClusters - a.sharedClusters || a.botUserId - b.botUserId || a.partnerUserId - b.partnerUserId,
  );

  const totalLabelled = bots.reduce((s, b) => s + b.mlLabelled, 0);
  const totalWithPath = [...botAgg.values()].reduce((s, a) => s + a.mlWithPath, 0);
  return {
    generatedAt,
    window: win,
    workspaceId: scope.workspaceId,
    bots,
    pathCells,
    categoryCells,
    overlapCells,
    pathCoveragePct: totalLabelled > 0 ? Math.round((totalWithPath / totalLabelled) * 100) : null,
    floors,
  };
}

// ── Bot effect panel (the advisor's verification loop — CORE math, Pro-gated route) ─────────
// Five weekly series over the behaviour tab's 12-week span, split before/after `anchorMs` (a
// config event or a merged advisor PR — resolved by the PLUGIN; this query never sees a
// recommendation, which is what keeps measurement independent of emission), or scanned for
// unattributed changepoints when the anchor is null. Null-vs-zero policy matches the
// behaviour analytics verbatim: a zero-volume week is null in the volume series (no baseline
// contribution — going dark stays detectSilentRuns's job). Acted-on uses the BASE predicate
// (the weekly-trend precedent — no follow-up scan over the full span).
export async function getBotEffectPanel(
  accountId: number,
  scope: BotScope,
  botUserId: number,
  anchorMs: number | null,
): Promise<AdvisorEffectPanel> {
  const nowMs = Date.now();
  const generatedAt = new Date(nowMs).toISOString();
  const SPAN_WEEKS = 12;
  const WEEK = 7 * 86_400_000;
  const spanStartMs = nowMs - SPAN_WEEKS * WEEK;
  const weekStarts = Array.from({ length: SPAN_WEEKS }, (_, i) =>
    new Date(spanStartMs + i * WEEK).toISOString(),
  );
  const wi = (ms: number): number =>
    Math.min(SPAN_WEEKS - 1, Math.max(0, Math.floor((ms - spanStartMs) / WEEK)));

  const panel: AdvisorEffectPanel = {
    generatedAt,
    botUserId,
    weekStarts,
    volume: Array.from({ length: SPAN_WEEKS }, () => null),
    findings: Array.from({ length: SPAN_WEEKS }, () => 0),
    bySeverity: Array.from({ length: SPAN_WEEKS }, emptyMlSeverityCounts),
    nitSharePct: Array.from({ length: SPAN_WEEKS }, () => null),
    topCategories: [],
    actedOnPct: Array.from({ length: SPAN_WEEKS }, () => null),
    highSeverityMedianHours: Array.from({ length: SPAN_WEEKS }, () => null),
    anchor: null,
    before: null,
    after: null,
    changepoints: [],
  };
  // Scope/ownership gate: the bot must be one of THIS workspace's automated reviewers — an
  // arbitrary user id from the request body earns an empty panel, never data.
  const automatedIds = await automatedReviewerUserIds(accountId, scope.workspaceId, 'all');
  if (scope.repoIds.length === 0 || !automatedIds.includes(botUserId)) return panel;

  const spanStart = new Date(spanStartMs);
  const threadRows = await db
    .select({
      id: reviewThreads.id,
      state: reviewThreads.derivedState,
      createdAt: reviewThreads.createdAt,
      resolvedAt: reviewThreads.resolvedAt,
    })
    .from(reviewThreads)
    .innerJoin(pullRequests, eq(pullRequests.id, reviewThreads.prId))
    .where(
      and(
        eq(pullRequests.accountId, accountId),
        eq(reviewThreads.originalCommenterId, botUserId),
        gte(reviewThreads.createdAt, spanStart),
        inArray(pullRequests.repoId, scope.repoIds),
      ),
    )
    .execute();

  const volumeRaw = Array.from({ length: SPAN_WEEKS }, () => 0);
  const actedRaw = Array.from({ length: SPAN_WEEKS }, () => 0);
  for (const t of threadRows) {
    const w = wi(t.createdAt.getTime());
    volumeRaw[w]! += 1;
    if (isActedOnThreadState(t.state)) actedRaw[w]! += 1;
  }

  const labelRows = await db
    .select({
      targetKind: mlCommentLabels.targetKind,
      targetId: mlCommentLabels.targetId,
      severity: mlCommentLabels.severity,
      categories: mlCommentLabels.categories,
      isSummary: mlCommentLabels.isSummary,
      targetCreatedAt: mlCommentLabels.targetCreatedAt,
    })
    .from(mlCommentLabels)
    .where(
      and(
        eq(mlCommentLabels.accountId, accountId),
        inArray(mlCommentLabels.repoId, scope.repoIds),
        eq(mlCommentLabels.authorUserId, botUserId),
        gte(mlCommentLabels.targetCreatedAt, spanStart),
      ),
    )
    .orderBy(desc(mlCommentLabels.targetCreatedAt), desc(mlCommentLabels.id))
    .limit(ADVISOR_SCAN_CAP)
    .execute();

  const catWeekly = new Map<string, number[]>();
  const highLabelCommentIds = new Set<number>();
  for (const r of labelRows) {
    const severity = ML_SEVERITY_KEYS.find((s) => s === r.severity);
    if (!severity) continue;
    const categories = Array.isArray(r.categories) ? (r.categories as string[]) : [];
    if (r.isSummary === true || categories.includes('praise')) continue;
    const w = wi(r.targetCreatedAt.getTime());
    panel.findings[w]! += 1;
    panel.bySeverity[w]![severity] += 1;
    if (
      (severity === 'major' || severity === 'critical') &&
      r.targetKind === 'review_comment'
    )
      highLabelCommentIds.add(r.targetId);
    for (const category of categories) {
      let counts = catWeekly.get(category);
      if (!counts) {
        counts = Array.from({ length: SPAN_WEEKS }, () => 0);
        catWeekly.set(category, counts);
      }
      counts[w]! += 1;
    }
  }

  // High-severity resolution latency: threads whose ORIGIN comment carries a major/critical
  // label and that were resolved — bucketed by the thread's CREATION week (the before/after
  // question is "how were findings made after the change handled", so the sample belongs to
  // the week the finding was made, not the week someone got to it).
  const highSamplesByWeek: number[][] = Array.from({ length: SPAN_WEEKS }, () => []);
  if (highLabelCommentIds.size > 0 && threadRows.length > 0) {
    const resolvedIds = threadRows.filter((t) => t.resolvedAt != null).map((t) => t.id);
    if (resolvedIds.length > 0) {
      const originRows = await db
        .select({
          id: reviewComments.id,
          threadId: reviewComments.threadId,
          authorId: reviewComments.authorId,
          createdAt: reviewComments.createdAt,
        })
        .from(reviewComments)
        .where(inArray(reviewComments.threadId, resolvedIds))
        .execute();
      const originByThread = new Map<number, { id: number; at: number }>();
      for (const c of originRows) {
        if (c.authorId !== botUserId) continue;
        const cur = originByThread.get(c.threadId);
        const at = c.createdAt.getTime();
        if (!cur || at < cur.at || (at === cur.at && c.id < cur.id))
          originByThread.set(c.threadId, { id: c.id, at });
      }
      for (const t of threadRows) {
        if (t.resolvedAt == null) continue;
        const origin = originByThread.get(t.id);
        if (!origin || !highLabelCommentIds.has(origin.id)) continue;
        const hours = (t.resolvedAt.getTime() - t.createdAt.getTime()) / 3_600_000;
        if (hours < 0) continue;
        highSamplesByWeek[wi(t.createdAt.getTime())]!.push(hours);
      }
    }
  }

  panel.volume = volumeRaw.map((v) => (v > 0 ? v : null));
  panel.actedOnPct = volumeRaw.map((v, i) =>
    v > 0 ? Math.round((actedRaw[i]! / v) * 100) : null,
  );
  panel.nitSharePct = panel.findings.map((f, i) =>
    f > 0 ? Math.round((panel.bySeverity[i]!.nit / f) * 100) : null,
  );
  panel.highSeverityMedianHours = highSamplesByWeek.map((samples) => {
    const m = medianOf(samples);
    return m == null ? null : Math.round(m * 10) / 10;
  });
  panel.topCategories = [...catWeekly.entries()]
    .map(([category, counts]) => ({ category: category as MlCategory, counts }))
    .sort(
      (a, b) =>
        b.counts.reduce((s, n) => s + n, 0) - a.counts.reduce((s, n) => s + n, 0) ||
        a.category.localeCompare(b.category),
    )
    .slice(0, 8);

  const summarize = (weekIdxs: number[]): AdvisorEffectSummary | null => {
    const active = weekIdxs.filter((i) => volumeRaw[i]! > 0 || panel.findings[i]! > 0);
    if (active.length === 0) return null;
    const threads = weekIdxs.reduce((s, i) => s + volumeRaw[i]!, 0);
    const acted = weekIdxs.reduce((s, i) => s + actedRaw[i]!, 0);
    const findings = weekIdxs.reduce((s, i) => s + panel.findings[i]!, 0);
    const nits = weekIdxs.reduce((s, i) => s + panel.bySeverity[i]!.nit, 0);
    const highSamples = weekIdxs.flatMap((i) => highSamplesByWeek[i]!);
    const highMedian = medianOf(highSamples);
    const volMedian = medianOf(weekIdxs.map((i) => volumeRaw[i]!).filter((v) => v > 0));
    return {
      weeks: active.length,
      volumePerWeek: volMedian == null ? null : Math.round(volMedian * 10) / 10,
      nitSharePct: findings > 0 ? Math.round((nits / findings) * 100) : null,
      actedOnPct: threads > 0 ? Math.round((acted / threads) * 100) : null,
      highSeverityMedianHours: highMedian == null ? null : Math.round(highMedian * 10) / 10,
    };
  };

  if (anchorMs != null) {
    const anchorWeek = wi(anchorMs);
    panel.anchor = { ms: anchorMs, weekIndex: anchorWeek };
    // The anchor week itself is transitional (part-before, part-after) and joins neither side.
    panel.before = summarize(Array.from({ length: anchorWeek }, (_, i) => i));
    panel.after = summarize(
      Array.from({ length: SPAN_WEEKS - anchorWeek - 1 }, (_, i) => anchorWeek + 1 + i),
    );
  } else {
    const cps: AdvisorChangepoint[] = [];
    const push = (series: AdvisorChangepoint['series'], values: (number | null)[], minScale: number): void => {
      for (const cp of detectChangepoints(values, { minScale })) {
        cps.push({
          series,
          weekIndex: cp.index,
          beforeMedian: Math.round(cp.beforeMedian * 10) / 10,
          afterMedian: Math.round(cp.afterMedian * 10) / 10,
          direction: cp.direction,
          z: Math.round(cp.z * 10) / 10,
        });
      }
    };
    push('volume', panel.volume, 2);
    push('nitShare', panel.nitSharePct, 10);
    push('actedOn', panel.actedOnPct, 10);
    panel.changepoints = cps;
  }
  return panel;
}

// ── Bot BEHAVIOUR analytics (EXPERIMENTAL, CORE, deterministic) ────────────────────────────
// A SEPARATE surface from getBotAnalytics (which stays untouched) powering the "Behaviour"
// sub-tab. Per bot, over the shared window (+ a 12-week TTFR trend): time-to-first-review, the
// LoC-to-comments ratio, the week×hour activity heatmap (coverage / rate-limit inference), and
// post-first-review follow-up behaviour. All from durable timestamped rows (reviews.submittedAt,
// reviewComments/prComments.createdAt) — no lean-gated text — so it's fully deterministic. TTFR
// clock start = pr_ready_for_review (when observed) else pullRequests.openedAt.
const TTFR_BUCKETS: { label: string; maxHours: number }[] = [
  { label: '<1h', maxHours: 1 },
  { label: '1–4h', maxHours: 4 },
  { label: '4–12h', maxHours: 12 },
  { label: '12–24h', maxHours: 24 },
  { label: '1–3d', maxHours: 72 },
  { label: '>3d', maxHours: Infinity },
];
function bucketize(values: number[], buckets: { label: string; maxHours: number }[]): AnalyticsBin[] {
  const counts = new Array<number>(buckets.length).fill(0);
  for (const v of values) {
    const i = buckets.findIndex((b) => v < b.maxHours);
    counts[i < 0 ? buckets.length - 1 : i]! += 1;
  }
  return buckets.map((b, i) => ({ label: b.label, count: counts[i]! }));
}
// medianOf is defined once above (shared with getWorkspaceMetrics).
function percentileOf(xs: number[], p: number): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1));
  return s[idx]!;
}

// ── Robust anomaly detection (deterministic, no AI) ────────────────────────────────────────
// Each bot is judged against ITS OWN history (a self-baseline), so "typical" means typical for
// THAT bot — the evidence a consistency claim needs. We use the MEDIAN + MAD (median absolute
// deviation), not mean/stddev: MAD is spike-resistant, so one bad week can't inflate the very
// baseline it should stand out against. Robust z = (x − median) / max(1.4826·MAD, minScale);
// the minScale floor stops a near-constant series from flagging trivial wobble as an anomaly.
const ANOMALY_Z = 3; // ≥3 robust-SDs from the bot's own median is an exception
const MIN_BASELINE_POINTS = 4; // fewer than this and "typical" isn't yet meaningful ("building baseline")
interface WeekAnomaly { z: number; typical: number; direction: 'high' | 'low' }
// Per-index anomaly (or null) over a weekly series. `direction`: 'high' flags only worse-than-
// -typical (TTFR), 'both' flags either way (volume, follow-up). `minScale` is the metric's
// floor on the robust SD (e.g. 0.5h for TTFR, a couple of touches for volume, 10pp for a rate).
export function weeklyAnomalies(
  values: (number | null)[],
  opts: { direction: 'high' | 'both'; minScale: number },
): (WeekAnomaly | null)[] {
  const present = values.filter((v): v is number => v != null);
  if (present.length < MIN_BASELINE_POINTS) return values.map(() => null);
  const median = medianOf(present)!;
  const mad = medianOf(present.map((v) => Math.abs(v - median)))!;
  const sigma = Math.max(1.4826 * mad, opts.minScale);
  return values.map((v) => {
    if (v == null) return null;
    const z = (v - median) / sigma;
    if (Math.abs(z) < ANOMALY_Z) return null;
    if (opts.direction === 'high' && z <= 0) return null; // faster-than-usual TTFR isn't a problem
    return { z: Math.abs(z), typical: median, direction: z > 0 ? 'high' : 'low' };
  });
}

// Coverage-gap detection over a bot's daily activity. A "silent run" = consecutive zero-activity
// days AFTER the bot's first active day (a leading run is just "started mid-span", not a gap; a
// TRAILING run is the bot going quiet and staying quiet — the highest-value alert, so it's kept).
// Only for a normally-REGULAR bot (≥ MIN_BASELINE_POINTS active days); a run flags when it's ≥
// max(3, 3·medianGap) days, where medianGap is the bot's typical spacing between active days — so
// a daily bot flags a 3-day silence while a naturally sparse bot doesn't cry wolf.
export function detectSilentRuns(daily: number[]): { startDay: number; days: number }[] {
  const activeDays: number[] = [];
  for (let i = 0; i < daily.length; i++) if (daily[i]! > 0) activeDays.push(i);
  if (activeDays.length < MIN_BASELINE_POINTS) return [];
  const gaps: number[] = [];
  for (let k = 1; k < activeDays.length; k++) gaps.push(activeDays[k]! - activeDays[k - 1]!);
  const medianGap = gaps.length > 0 ? medianOf(gaps)! : 1;
  const threshold = Math.max(3, Math.round(3 * medianGap));
  const first = activeDays[0]!;
  const runs: { startDay: number; days: number }[] = [];
  let runStart = -1;
  for (let i = first + 1; i < daily.length; i++) {
    if (daily[i] === 0) {
      if (runStart < 0) runStart = i;
    } else if (runStart >= 0) {
      const len = i - runStart;
      if (len >= threshold) runs.push({ startDay: runStart, days: len });
      runStart = -1;
    }
  }
  if (runStart >= 0) {
    const len = daily.length - runStart; // trailing (ongoing) silence up to now
    if (len >= threshold) runs.push({ startDay: runStart, days: len });
  }
  return runs;
}

export async function getBotBehaviourAnalytics(
  accountId: number,
  window: BotWindowKind,
  // Exactly as getBotAnalytics: `workspaceId` decides who counts as a bot, `repoIds` narrows the
  // measured data. `repoIds: []` = an empty workspace.
  scope: BotScope,
  // Optional ONE-BOT narrowing (apiVersion 21 — the per-bot drill-down tab's fetch). When set,
  // the whole result covers only that bot: the automated-id set is sliced BEFORE any of the
  // touch/thread/ML scans run, so opening one bot's tab never computes fifteen bots' heatmaps.
  // A `botUserId` that is not one of the workspace's role-'review' automated reviewers yields
  // the empty response, exactly like a workspace with no reviewers.
  botUserId?: number,
): Promise<BotBehaviourResponse> {
  const nowMs = Date.now();
  const to = new Date(nowMs);
  const from = new Date(nowMs - botWindowMs(window));
  const fromMs = from.getTime();
  const trendFrom = new Date(nowMs - 12 * 7 * 86_400_000); // 84 days ⊇ every window
  const generatedAt = to.toISOString();
  const win = { kind: window, from: from.toISOString(), to: to.toISOString() };
  const DAY = 86_400_000;
  const SPAN_DAYS = 84; // == trendFrom → now; the anomaly baseline AND the coverage strip span
  const trendFromMs = trendFrom.getTime();
  const daySpanStart = trendFrom.toISOString();

  // Second DayStrip series: per-day count of human-authored, non-draft PRs opened over the same
  // 84-day coverage span + scope. A SHARED response field (PR inflow is an account/repo fact, not
  // per-bot) so every bot's coverage strip can be read against real PR inflow — the days a bot went
  // silent while PRs kept coming are exactly the coverage gaps the user wants to spot.
  const EMPTY_OVERLAP: BotOverlapStats = {
    reviewedPrs: 0,
    multiReviewedPrs: 0,
    distribution: [
      { label: '1 bot', count: 0 },
      { label: '2 bots', count: 0 },
      { label: '3+ bots', count: 0 },
    ],
    pairs: [],
    lineOverlapClusters: 0,
    lineOverlapPrs: 0,
  };
  const empty = (prsOpenedPerDay: number[]): BotBehaviourResponse => ({
    enabled: true,
    generatedAt,
    window: win,
    bots: [],
    prsOpenedPerDay,
    daySpanStart,
    overlap: EMPTY_OVERLAP,
    repoBotDirs: [],
  });

  if (scope.repoIds.length === 0) return empty(new Array<number>(SPAN_DAYS).fill(0));
  const repoScopeFilter = [inArray(pullRequests.repoId, scope.repoIds)];

  const prsOpenedPerDay = new Array<number>(SPAN_DAYS).fill(0);
  for (const p of await db
    .select({ openedAt: pullRequests.openedAt })
    .from(pullRequests)
    .innerJoin(users, eq(users.id, pullRequests.authorId))
    .where(
      and(
        eq(pullRequests.accountId, accountId),
        eq(pullRequests.isDraft, false),
        eq(users.isBot, false),
        gte(pullRequests.openedAt, trendFrom),
        lte(pullRequests.openedAt, to),
        ...repoScopeFilter,
      ),
    )
    .execute()) {
    const dIdx = Math.min(SPAN_DAYS - 1, Math.max(0, Math.floor((p.openedAt.getTime() - trendFromMs) / DAY)));
    prsOpenedPerDay[dIdx]! += 1;
  }

  // `role: 'review'` — TTFR, follow-up rate and the coverage heatmap are all claims about REVIEW
  // behaviour. A linter that fires on every push would flatten TTFR and dominate the heatmap.
  //
  // The one-bot narrowing slices HERE, before any scan runs: every downstream query
  // (reviews/comments/threads/ML) filters on `automatedIds`, so one filter is the whole slice.
  // Filtering (never trusting the raw id) also keeps the workspace-membership guarantee: a
  // caller cannot smuggle a non-reviewer or another workspace's bot into the measured set.
  const allAutomatedIds = await automatedReviewerUserIds(accountId, scope.workspaceId, 'review');
  const automatedIds =
    botUserId != null ? allAutomatedIds.filter((id) => id === botUserId) : allAutomatedIds;
  if (automatedIds.length === 0) return empty(prsOpenedPerDay);
  const kindMap = await classificationKindForUser(accountId, scope.workspaceId);

  // Identity (label + login) — mirrors getBotAnalytics.reviewerLabel exactly.
  const classLabel = await classificationLabelMap(accountId, scope.workspaceId);
  const loginById = new Map<number, string>();
  const rawLoginById = new Map<number, string>();
  for (const r of await db
    .select({ id: users.id, login: users.githubLogin, name: users.displayName })
    .from(users)
    .where(inArray(users.id, automatedIds))
    .execute()) {
    loginById.set(r.id, r.name?.trim() || r.login || `#${r.id}`);
    if (r.login) rawLoginById.set(r.id, r.login);
  }
  const reviewerLabel = (userId: number, kind: AutomatedReviewerKind): string => {
    const custom = classLabel.get(userId);
    if (custom) return custom;
    if (kind !== 'in_house' && kind !== 'pierre' && kind !== 'vendor')
      return labelForKind(kind);
    return loginById.get(userId) ?? labelForKind(kind);
  };

  // Bot touches over the 12-week trend span (⊇ the window). Reviews (excl. pending) + inline
  // comments + issue-level comments — the three ways a review bot marks a PR.
  const reviewRows = await db
    .select({ authorId: reviews.authorId, prId: reviews.prId, at: reviews.submittedAt })
    .from(reviews)
    .innerJoin(pullRequests, eq(pullRequests.id, reviews.prId))
    .where(
      and(
        eq(pullRequests.accountId, accountId),
        inArray(reviews.authorId, automatedIds),
        ne(reviews.state, 'pending'),
        gte(reviews.submittedAt, trendFrom),
        lte(reviews.submittedAt, to),
        ...repoScopeFilter,
      ),
    )
    .execute();
  const rcRows = await db
    .select({ authorId: reviewComments.authorId, prId: reviewComments.prId, at: reviewComments.createdAt })
    .from(reviewComments)
    .innerJoin(pullRequests, eq(pullRequests.id, reviewComments.prId))
    .where(
      and(
        eq(pullRequests.accountId, accountId),
        inArray(reviewComments.authorId, automatedIds),
        gte(reviewComments.createdAt, trendFrom),
        lte(reviewComments.createdAt, to),
        ...repoScopeFilter,
      ),
    )
    .execute();
  const pcRows = await db
    .select({ authorId: prComments.authorId, prId: prComments.prId, at: prComments.createdAt })
    .from(prComments)
    .innerJoin(pullRequests, eq(pullRequests.id, prComments.prId))
    .where(
      and(
        eq(pullRequests.accountId, accountId),
        inArray(prComments.authorId, automatedIds),
        gte(prComments.createdAt, trendFrom),
        lte(prComments.createdAt, to),
        ...repoScopeFilter,
      ),
    )
    .execute();

  // (userId → prId → touches) over the trend span, + the flat per-user touch times for the heatmap.
  interface Touch { ms: number; isComment: boolean }
  const touchesByUserPr = new Map<number, Map<number, Touch[]>>();
  const involvedPrIds = new Set<number>();
  const addTouch = (userId: number | null, prId: number | null, at: Date, isComment: boolean): void => {
    if (userId == null || prId == null || !kindMap.has(userId)) return;
    involvedPrIds.add(prId);
    let byPr = touchesByUserPr.get(userId);
    if (!byPr) {
      byPr = new Map();
      touchesByUserPr.set(userId, byPr);
    }
    const arr = byPr.get(prId) ?? [];
    arr.push({ ms: at.getTime(), isComment });
    byPr.set(prId, arr);
  };
  for (const r of reviewRows) addTouch(r.authorId, r.prId, r.at, false);
  for (const r of rcRows) addTouch(r.authorId, r.prId, r.at, true);
  for (const r of pcRows) addTouch(r.authorId, r.prId, r.at, true);
  if (touchesByUserPr.size === 0) return empty(prsOpenedPerDay);

  // PR baselines: openedAt + diff size, and the earliest observed ready-for-review event.
  const prIdList = [...involvedPrIds];
  const prMeta = new Map<number, { openedMs: number; loc: number }>();
  for (const p of await db
    .select({
      id: pullRequests.id,
      openedAt: pullRequests.openedAt,
      additions: pullRequests.additions,
      deletions: pullRequests.deletions,
    })
    .from(pullRequests)
    .where(and(eq(pullRequests.accountId, accountId), inArray(pullRequests.id, prIdList)))
    .execute())
    prMeta.set(p.id, { openedMs: p.openedAt.getTime(), loc: p.additions + p.deletions });
  const readyByPr = new Map<number, number>();
  for (const e of await db
    .select({ prId: events.prId, at: events.occurredAt })
    .from(events)
    .where(
      and(
        eq(events.accountId, accountId),
        eq(events.type, 'pr_ready_for_review'),
        inArray(events.prId, prIdList),
      ),
    )
    .execute()) {
    if (e.prId == null) continue;
    const ms = e.at.getTime();
    const cur = readyByPr.get(e.prId);
    if (cur == null || ms < cur) readyByPr.set(e.prId, ms);
  }

  // Findings-density numerator: review THREADS each bot OPENED (originalCommenterId) on the PRs it
  // touched. Threads (not raw comments) match the user's "thread counts per PR" — a multi-comment
  // thread is one finding. Bucketed per PR into its first-touch week in the loop below.
  const threadsByUserPr = new Map<number, Map<number, number>>();
  for (const t of await db
    .select({ opener: reviewThreads.originalCommenterId, prId: reviewThreads.prId })
    .from(reviewThreads)
    .innerJoin(pullRequests, eq(pullRequests.id, reviewThreads.prId))
    .where(
      and(
        eq(pullRequests.accountId, accountId),
        inArray(reviewThreads.originalCommenterId, automatedIds),
        inArray(reviewThreads.prId, prIdList),
      ),
    )
    .execute()) {
    if (t.opener == null || t.prId == null) continue;
    let byPr = threadsByUserPr.get(t.opener);
    if (!byPr) {
      byPr = new Map();
      threadsByUserPr.set(t.opener, byPr);
    }
    byPr.set(t.prId, (byPr.get(t.prId) ?? 0) + 1);
  }

  const HOUR = 3_600_000;
  const SPAN_WEEKS = 12;
  // DAY / SPAN_DAYS / trendFromMs are hoisted above (they also gate the prsOpenedPerDay series).
  // THE week boundaries, computed once. Both the per-bot `trend` below and the ML fold at the end
  // read this array rather than re-deriving `trendFromMs + i·7·DAY` — the two series are drawn on
  // the same x-axis, and a second copy of that arithmetic is exactly how they would come to
  // disagree by a week without anything failing.
  const weekStarts = Array.from({ length: SPAN_WEEKS }, (_, i) =>
    new Date(trendFromMs + i * 7 * DAY).toISOString(),
  );
  const weekIndexOf = (ms: number): number =>
    Math.min(SPAN_WEEKS - 1, Math.max(0, Math.floor((ms - trendFromMs) / (7 * DAY))));
  const bots: BotBehaviourBotStat[] = [];
  for (const [userId, byPr] of touchesByUserPr) {
    const kind = kindMap.get(userId);
    if (!kind) continue;

    // Per-PR aggregation over the trend span (windowed slices pulled out below).
    const ttfrWindow: number[] = []; // hours, PRs FIRST touched in-window
    const baselineTally = { ready: 0, opened: 0 };
    const followupGaps: number[] = []; // hours between consecutive touches, in-window PRs
    const followupCounts: number[] = []; // extra touches per in-window PR
    const locPerComment: number[] = [];
    let totalComments = 0;
    let prsReviewed = 0;
    const ttfrByWeek = new Map<number, number[]>(); // week index (0..11) → TTFR hours
    // Span-wide weekly series feeding the anomaly baseline + the trend charts.
    const volumeByWeek = new Array<number>(SPAN_WEEKS).fill(0); // touches per week
    const followupByWeek = Array.from({ length: SPAN_WEEKS }, () => ({ withFollowup: 0, total: 0 }));
    // Findings density per week (bucketed by each PR's first-touch week): threads the bot opened,
    // PRs it reviewed, and their changed LoC — the numerators/denominators of findingsPerPr/KLoC.
    const threadsByWeek = new Array<number>(SPAN_WEEKS).fill(0);
    const prsByWeek = new Array<number>(SPAN_WEEKS).fill(0);
    const locByWeek = new Array<number>(SPAN_WEEKS).fill(0);
    const botThreadsByPr = threadsByUserPr.get(userId);
    const dailyActivity = new Array<number>(SPAN_DAYS).fill(0); // touches per day → coverage strip
    const heatmap = new Array<number>(168).fill(0);
    let totalActivity = 0;

    for (const [prId, touches] of byPr) {
      const meta = prMeta.get(prId);
      if (!meta) continue;
      const sorted = [...touches].sort((a, b) => a.ms - b.ms);
      const firstMs = sorted[0]!.ms;
      // TTFR baseline: ready-for-review when observed at/before the first touch, else opened.
      const readyMs = readyByPr.get(prId);
      const useReady = readyMs != null && readyMs <= firstMs;
      const baselineMs = useReady ? readyMs : meta.openedMs;
      const ttfrHours = Math.max(0, (firstMs - baselineMs) / HOUR);

      // 12-week trend: bucket every trend-span PR by the week of its first touch.
      const wk = weekIndexOf(firstMs);
      const wkArr = ttfrByWeek.get(wk) ?? [];
      wkArr.push(ttfrHours);
      ttfrByWeek.set(wk, wkArr);
      // Weekly follow-up rate: of the PRs first-reviewed in a week, the share the bot came back to.
      followupByWeek[wk]!.total += 1;
      if (sorted.length > 1) followupByWeek[wk]!.withFollowup += 1;
      // Weekly findings density: attribute this PR's opened-threads + LoC to its first-touch week.
      prsByWeek[wk]! += 1;
      threadsByWeek[wk]! += botThreadsByPr?.get(prId) ?? 0;
      locByWeek[wk]! += meta.loc;

      // Every touch → the span-wide weekly volume + the daily coverage strip; the week×hour
      // heatmap keeps its WINDOW scope (the coverage snapshot). All from real GitHub timestamps.
      for (const t of touches) {
        const wIdx = weekIndexOf(t.ms);
        volumeByWeek[wIdx]! += 1;
        const dIdx = Math.min(SPAN_DAYS - 1, Math.max(0, Math.floor((t.ms - trendFromMs) / DAY)));
        dailyActivity[dIdx]! += 1;
        if (t.ms >= fromMs) {
          const d = new Date(t.ms);
          heatmap[d.getUTCDay() * 24 + d.getUTCHours()]! += 1;
          totalActivity += 1;
        }
      }

      // Headline metrics: PRs whose FIRST touch landed in the window.
      if (firstMs >= fromMs) {
        prsReviewed += 1;
        ttfrWindow.push(ttfrHours);
        baselineTally[useReady ? 'ready' : 'opened'] += 1;
        followupCounts.push(sorted.length - 1);
        for (let i = 1; i < sorted.length; i++)
          followupGaps.push((sorted[i]!.ms - sorted[i - 1]!.ms) / HOUR);
        const comments = touches.reduce((n, t) => n + (t.isComment ? 1 : 0), 0);
        totalComments += comments;
        if (comments > 0) locPerComment.push(meta.loc / comments);
      }
    }

    // Coverage gaps — computed BEFORE the row gate so the "bot went dark" alert survives. A
    // trailing (ongoing) silent run reaches the end of the strip: a bot with early-span activity
    // then total silence has zero WINDOW footprint, but IS the highest-value signal, so keep it.
    const silentRuns = detectSilentRuns(dailyActivity);
    const hasTrailingSilence = silentRuns.some((r) => r.startDay + r.days >= SPAN_DAYS);
    // No window footprint AND no ongoing silence to report → skip the row (a bot that was never
    // regular enough to have a silent run, or is simply out of scope).
    if (totalActivity === 0 && prsReviewed === 0 && !hasTrailingSilence) continue;

    const baseline: BotBehaviourBotStat['ttfrBaseline'] =
      baselineTally.ready === 0 && baselineTally.opened === 0
        ? null
        : baselineTally.ready > 0 && baselineTally.opened > 0
          ? 'mixed'
          : baselineTally.ready > 0
            ? 'ready'
            : 'opened';

    // The three weekly series → the anomaly baseline. A week with no PRs has a null TTFR/
    // follow-up (no data, no baseline contribution); volume is a real 0 (silence is a signal).
    const ttfrSeries = Array.from({ length: SPAN_WEEKS }, (_, i) => medianOf(ttfrByWeek.get(i) ?? []));
    const followupSeries = followupByWeek.map((w) =>
      w.total > 0 ? Math.round((w.withFollowup / w.total) * 100) : null,
    );
    // Volume's baseline is the bot's ACTIVE weeks only (zero weeks → null): a "typical volume"
    // means "how much when it's working". This makes the MIN_BASELINE_POINTS guard count real
    // weeks (a new / bursty bot with < 4 active weeks reads as "building baseline", not an
    // "anomalous spike vs typical 0"), and leaves drops-to-ZERO to the silence detector — a
    // volume anomaly is a change in the bot's ACTIVE output (e.g. 50→5/week), not going dark.
    const volumeSeries: (number | null)[] = volumeByWeek.map((v) => (v > 0 ? v : null));
    // Density series: null for a PR-less week (no data → no baseline contribution, like TTFR). The
    // per-KLoC series drives the anomaly baseline; a diverging week (either way) is an exception.
    const round2 = (x: number): number => Math.round(x * 100) / 100;
    const findingsPerPrSeries = prsByWeek.map((n, i) => (n > 0 ? round2(threadsByWeek[i]! / n) : null));
    const findingsPerKlocSeries = locByWeek.map((loc, i) =>
      loc > 0 ? round2(threadsByWeek[i]! / (loc / 1000)) : null,
    );
    const ttfrAnoms = weeklyAnomalies(ttfrSeries, { direction: 'high', minScale: 0.5 });
    const volAnoms = weeklyAnomalies(volumeSeries, { direction: 'both', minScale: 2 });
    const followupAnoms = weeklyAnomalies(followupSeries, { direction: 'both', minScale: 10 });
    const densityAnoms = weeklyAnomalies(findingsPerKlocSeries, { direction: 'both', minScale: 0.5 });

    const trend: BotBehaviourTrendPoint[] = Array.from({ length: SPAN_WEEKS }, (_, i) => ({
      weekStart: weekStarts[i]!,
      medianTtfrHours: ttfrSeries[i]!,
      volume: volumeByWeek[i]!,
      followupRatePct: followupSeries[i]!,
      ttfrAnomaly: ttfrAnoms[i] != null,
      volumeAnomaly: volAnoms[i] != null,
      followupAnomaly: followupAnoms[i] != null,
      findingsPerPr: findingsPerPrSeries[i]!,
      findingsPerKloc: findingsPerKlocSeries[i]!,
      prsInWeek: prsByWeek[i]!,
      densityAnomaly: densityAnoms[i] != null,
    }));

    // The anomaly evidence list (newest week first, then silence runs). typical = the bot's own
    // robust median for that metric — the "vs typical" the customer's claim needs. (silentRuns
    // was computed above the row gate so the "bot went dark" case survives.)
    const anomalies: BotBehaviourAnomaly[] = [];
    for (let i = SPAN_WEEKS - 1; i >= 0; i--) {
      const weekStart = trend[i]!.weekStart;
      const a = ttfrAnoms[i];
      if (a) anomalies.push({ metric: 'ttfr', direction: a.direction, weekStart, observed: ttfrSeries[i]!, typical: a.typical, z: Math.round(a.z * 10) / 10 });
      const v = volAnoms[i];
      if (v) anomalies.push({ metric: 'volume', direction: v.direction, weekStart, observed: volumeByWeek[i]!, typical: v.typical, z: Math.round(v.z * 10) / 10 });
      const f = followupAnoms[i];
      if (f && followupSeries[i] != null)
        anomalies.push({ metric: 'followup', direction: f.direction, weekStart, observed: followupSeries[i]!, typical: f.typical, z: Math.round(f.z * 10) / 10 });
      const d = densityAnoms[i];
      if (d && findingsPerKlocSeries[i] != null)
        anomalies.push({ metric: 'density', direction: d.direction, weekStart, observed: findingsPerKlocSeries[i]!, typical: d.typical, z: Math.round(d.z * 10) / 10 });
    }
    // Silence runs → anomalies (typical = the bot's median spacing between active days).
    const activeDays: number[] = [];
    for (let i = 0; i < dailyActivity.length; i++) if (dailyActivity[i]! > 0) activeDays.push(i);
    const gaps: number[] = [];
    for (let k = 1; k < activeDays.length; k++) gaps.push(activeDays[k]! - activeDays[k - 1]!);
    const typicalGap = gaps.length > 0 ? medianOf(gaps)! : 1;
    for (const run of silentRuns)
      anomalies.push({
        metric: 'silence',
        direction: 'low',
        dayStart: new Date(trendFromMs + run.startDay * DAY).toISOString(),
        spanDays: run.days,
        observed: run.days,
        typical: typicalGap,
        z: null,
      });

    bots.push({
      key: `u${userId}`,
      userId,
      login: rawLoginById.get(userId) ?? null,
      kind,
      label: reviewerLabel(userId, kind),
      prsReviewed,
      ttfrMedianHours: medianOf(ttfrWindow),
      ttfrP90Hours: percentileOf(ttfrWindow, 0.9),
      ttfrBaseline: baseline,
      ttfrDist: bucketize(ttfrWindow, TTFR_BUCKETS),
      trend,
      followupLatencyMedianHours: medianOf(followupGaps),
      medianLocPerComment: medianOf(locPerComment),
      totalComments,
      activityHeatmap: heatmap,
      totalActivity,
      dailyActivity,
      daySpanStart: new Date(trendFromMs).toISOString(),
      silentRuns,
      anomalies,
      followupRatePct:
        followupCounts.length > 0
          ? Math.round((followupCounts.filter((c) => c > 0).length / followupCounts.length) * 100)
          : null,
      avgFollowups:
        followupCounts.length > 0
          ? Math.round((followupCounts.reduce((s, c) => s + c, 0) / followupCounts.length) * 10) / 10
          : null,
      followupDist: [
        { label: '0', count: followupCounts.filter((c) => c === 0).length },
        { label: '1', count: followupCounts.filter((c) => c === 1).length },
        { label: '2–3', count: followupCounts.filter((c) => c === 2 || c === 3).length },
        { label: '4+', count: followupCounts.filter((c) => c >= 4).length },
      ],
    });
  }
  bots.sort((a, b) => b.totalActivity - a.totalActivity || b.prsReviewed - a.prsReviewed);

  // ── Cross-bot overlap + coverage (EXPERIMENTAL) ─────────────────────────────────────────────
  // All over the SELECTED window [from, to] + scope. Bot identity mirrors the per-bot rows
  // (key `u<userId>`, same reviewerLabel/login/kind resolution).
  const botIdentity = (
    userId: number,
  ): { key: string; label: string; login: string | null; kind: AutomatedReviewerKind } => {
    const k = kindMap.get(userId) ?? 'in_house';
    return {
      key: `u${userId}`,
      label: reviewerLabel(userId, k),
      login: rawLoginById.get(userId) ?? null,
      kind: k,
    };
  };

  // (i) Multiple bots on the SAME PR — from the already-fetched touch maps (any touch type),
  // restricted to bots with an IN-WINDOW touch. Counts DISTINCT bot accounts.
  const prBots = new Map<number, Set<number>>();
  for (const [uid, byPr] of touchesByUserPr)
    for (const [prId, touches] of byPr) {
      if (!touches.some((t) => t.ms >= fromMs)) continue;
      let s = prBots.get(prId);
      if (!s) {
        s = new Set();
        prBots.set(prId, s);
      }
      s.add(uid);
    }
  let reviewedPrs = 0;
  let multiReviewedPrs = 0;
  let d1 = 0;
  let d2 = 0;
  let d3 = 0;
  const pairCount = new Map<string, number>();
  for (const s of prBots.values()) {
    const ids = [...s].sort((a, b) => a - b);
    reviewedPrs += 1;
    if (ids.length === 1) d1 += 1;
    else if (ids.length === 2) d2 += 1;
    else d3 += 1;
    if (ids.length >= 2) {
      multiReviewedPrs += 1;
      for (let i = 0; i < ids.length; i++)
        for (let j = i + 1; j < ids.length; j++)
          pairCount.set(`${ids[i]}|${ids[j]}`, (pairCount.get(`${ids[i]}|${ids[j]}`) ?? 0) + 1);
    }
  }
  const pairs: BotCoReviewPair[] = [...pairCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([k, prs]) => {
      const [a, b] = k.split('|').map(Number) as [number, number];
      const ia = botIdentity(a);
      const ib = botIdentity(b);
      return { aKey: ia.key, bKey: ib.key, aLabel: ia.label, bLabel: ib.label, prs };
    });

  // One reviewThreads pass (path/line are ALWAYS persisted — no lean-gated diffHunk):
  // same-line overlap + the merged repo × bot × directory "where bots work" breakdown.
  const threadRows = await db
    .select({
      prId: reviewThreads.prId,
      repoId: pullRequests.repoId,
      path: reviewThreads.path,
      line: reviewThreads.line,
      commenterId: reviewThreads.originalCommenterId,
    })
    .from(reviewThreads)
    .innerJoin(pullRequests, eq(pullRequests.id, reviewThreads.prId))
    .where(
      and(
        eq(pullRequests.accountId, accountId),
        inArray(reviewThreads.originalCommenterId, automatedIds),
        gte(reviewThreads.createdAt, from),
        lte(reviewThreads.createdAt, to),
        ...repoScopeFilter,
      ),
    )
    .execute();

  const threadsByBot = new Map<number, number>();
  // bot → repo → area(dir) → thread count: the merged "where bots work" breakdown.
  const repoBotDir = new Map<number, Map<number, Map<string, number>>>();
  const repoIdsSeen = new Set<number>();
  const overlapItems: { prId: number; path: string; line: number | null; userId: number }[] = [];
  for (const r of threadRows) {
    const uid = r.commenterId;
    if (uid == null) continue;
    const dir = topLevelDir(r.path);
    threadsByBot.set(uid, (threadsByBot.get(uid) ?? 0) + 1);
    repoIdsSeen.add(r.repoId);
    // Merged breakdown: this bot's threads in this repo, by top-level area (dir).
    let rbd = repoBotDir.get(uid);
    if (!rbd) {
      rbd = new Map();
      repoBotDir.set(uid, rbd);
    }
    let rd = rbd.get(r.repoId);
    if (!rd) {
      rd = new Map();
      rbd.set(r.repoId, rd);
    }
    rd.set(dir, (rd.get(dir) ?? 0) + 1);
    overlapItems.push({ prId: r.prId, path: r.path, line: r.line, userId: uid });
  }
  // Same-line overlap via THE shared ±3-line clustering (db/line-overlap.ts) — the same
  // definition the per-PR dedup rollup and the ROI overlap column use. ⚠ DISCONTINUITY: this
  // used to be EXACT (path,line) equality with a per-file null-line lump; it is now the ±3
  // window with null-line (outdated / file-level) threads excluded, so the counts step once on
  // upgrade — adjacent-line findings merge (fewer, truer clusters) while null-line "overlap"
  // vanishes. User-distinct throughout (two in-house bots CAN overlap), as it always was here.
  let lineOverlapClusters = 0;
  const overlapPrSet = new Set<number>();
  for (const c of clusterThreadsByLine(overlapItems, { nullLineGroup: false }))
    if (c.userIds.size >= 2) {
      lineOverlapClusters += 1;
      overlapPrSet.add(c.prId);
    }

  const repoNameById = new Map<number, string>();
  if (repoIdsSeen.size > 0)
    for (const r of await db
      .select({ id: repos.id, owner: repos.owner, name: repos.name })
      .from(repos)
      .where(inArray(repos.id, [...repoIdsSeen]))
      .execute())
      repoNameById.set(r.id, `${r.owner}/${r.name}`);

  // Merged "where bots work": per bot → its repos (top by volume) → each repo's top areas (dirs)
  // desc, capped + an 'other' tail. `totalThreads` on the bot counts ALL its repos; the `repos`
  // list is capped for chart readability.
  const AREA_TOP = 8;
  const REPOS_PER_BOT = 6;
  const repoBotDirs: BotRepoDirBreakdown[] = [...repoBotDir.entries()]
    .map(([uid, byRepo]) => {
      const repos = [...byRepo.entries()]
        .map(([repoId, dm]) => {
          const sorted = [...dm.entries()].sort((a, b) => b[1] - a[1]);
          const total = sorted.reduce((n, [, c]) => n + c, 0);
          const dirs = sorted.slice(0, AREA_TOP).map(([dir, count]) => ({ dir, count }));
          const otherCount = sorted.slice(AREA_TOP).reduce((n, [, c]) => n + c, 0);
          if (otherCount > 0) dirs.push({ dir: 'other', count: otherCount });
          return {
            repoId,
            repoName: repoNameById.get(repoId) ?? `#${repoId}`,
            totalThreads: total,
            dirs,
          };
        })
        .sort((a, b) => b.totalThreads - a.totalThreads)
        .slice(0, REPOS_PER_BOT);
      return { ...botIdentity(uid), totalThreads: threadsByBot.get(uid) ?? 0, repos };
    })
    .sort((a, b) => b.totalThreads - a.totalThreads);

  const overlap: BotOverlapStats = {
    reviewedPrs,
    multiReviewedPrs,
    distribution: [
      { label: '1 bot', count: d1 },
      { label: '2 bots', count: d2 },
      { label: '3+ bots', count: d3 },
    ],
    pairs,
    lineOverlapClusters,
    lineOverlapPrs: overlapPrSet.size,
  };

  // ── ML severity/category fold (CORE, free tier — no LLM) ────────────────────────────────────
  // ONE read of `ml_comment_labels` over the trend span, grouped in memory: no per-bot fan-out,
  // and no second derivation of anything. Scope, bot set and week boundaries are the SAME values
  // the rest of this function used — `automatedIds` (role 'review', so a linter's volume can't
  // dominate a chart about reviewers), `scope.repoIds`, and `weekIndexOf`/`weekStarts`.
  //
  // Exclusions are the shared ones with ONE deliberate difference, spelled out in
  // BotBehaviourMl's doc: severity is FINDINGS-ONLY (no summaries, no praise), while categories
  // cover every non-summary row so `praise` can appear as a category in its own right.
  //
  // Rows are emitted only for bots that also appear in `bots` — the key is the join, and a
  // severity row for a bot the panel never draws is a row nothing can label or colour.
  const mlBotKeys = new Set(bots.map((b) => b.userId));
  const { rows: mlRows, truncated: mlTruncated } = await listMlLabelsForBehaviour(
    accountId,
    scope,
    automatedIds,
    trendFrom,
    to,
  );

  interface MlAcc {
    findings: number;
    bySeverity: MlSeverityCounts;
    byVendorSeverity: MlSeverityCounts;
    vendorDeclared: number;
    // The inflation index — the same three counters SeverityAgreementMatrix carries, at this
    // response's grain. They partition `vendorDeclared`, never `findings`.
    vendorAgree: number;
    vendorOverCall: number;
    vendorUnderCall: number;
    byCategory: Map<MlCategory, number>;
    weekly: { bySeverity: MlSeverityCounts; byCategory: Map<MlCategory, number> }[];
  }
  const emptyCounts = (): MlSeverityCounts => ({ nit: 0, minor: 0, major: 0, critical: 0 });
  const mlByBot = new Map<number, MlAcc>();
  for (const row of mlRows) {
    if (!mlBotKeys.has(row.authorUserId)) continue;
    if (row.isSummary) continue; // a walkthrough is not a finding, and its categories are template
    let acc = mlByBot.get(row.authorUserId);
    if (!acc) {
      acc = {
        findings: 0,
        bySeverity: emptyCounts(),
        byVendorSeverity: emptyCounts(),
        vendorDeclared: 0,
        vendorAgree: 0,
        vendorOverCall: 0,
        vendorUnderCall: 0,
        byCategory: new Map(),
        weekly: Array.from({ length: SPAN_WEEKS }, () => ({
          bySeverity: emptyCounts(),
          byCategory: new Map<MlCategory, number>(),
        })),
      };
      mlByBot.set(row.authorUserId, acc);
    }
    const wk = acc.weekly[weekIndexOf(row.targetCreatedAtMs)]!;
    const inWindow = row.targetCreatedAtMs >= fromMs;
    const isPraise = row.categories.includes('praise');

    // Categories: every non-summary row, both grains.
    for (const c of row.categories) {
      wk.byCategory.set(c, (wk.byCategory.get(c) ?? 0) + 1);
      if (inWindow) acc.byCategory.set(c, (acc.byCategory.get(c) ?? 0) + 1);
    }
    // Severity: findings only. Praise carries a severity in the table (every row does) and it
    // means nothing — counting it would put "acknowledged your fix" in the nit column.
    if (isPraise) continue;
    wk.bySeverity[row.severity] += 1;
    if (inWindow) {
      acc.findings += 1;
      acc.bySeverity[row.severity] += 1;
      // The vendor's own badge — a strictly smaller population (most findings carry none), so it
      // gets its own denominator and never shares one with ours.
      //
      // The three disagreement counters ride the SAME branch, which is what makes
      // `agree + over + under === vendorDeclared` structural rather than a property someone has
      // to remember: an unbadged finding never reaches here, and silence is not a conflict.
      // Direction comes from `vendorAgreementOf` — the one rule the confusion matrix and the
      // flagging drill-down's `disagree` refinement also use, so this bar chart and the list it
      // opens cannot disagree about which way a row leans.
      if (row.vendorSeverity) {
        acc.vendorDeclared += 1;
        acc.byVendorSeverity[row.vendorSeverity] += 1;
        const dir = vendorAgreementOf(row.vendorSeverity, row.severity);
        if (dir === 'agree') acc.vendorAgree += 1;
        else if (dir === 'over') acc.vendorOverCall += 1;
        else if (dir === 'under') acc.vendorUnderCall += 1;
      }
    }
  }

  const sortedCategories = (m: Map<MlCategory, number>): Array<{ category: MlCategory; count: number }> =>
    [...m.entries()]
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));

  const mlPerBot: BotBehaviourMlBot[] = bots
    .filter((b) => mlByBot.has(b.userId))
    .map((b) => {
      const acc = mlByBot.get(b.userId)!;
      const weekly: BotBehaviourMlWeekPoint[] = acc.weekly.map((w, i) => ({
        weekStart: weekStarts[i]!,
        bySeverity: w.bySeverity,
        byCategory: sortedCategories(w.byCategory),
      }));
      return {
        key: b.key,
        findings: acc.findings,
        bySeverity: acc.bySeverity,
        byVendorSeverity: acc.byVendorSeverity,
        vendorDeclared: acc.vendorDeclared,
        vendorAgree: acc.vendorAgree,
        vendorOverCall: acc.vendorOverCall,
        vendorUnderCall: acc.vendorUnderCall,
        byCategory: sortedCategories(acc.byCategory),
        weekly,
      };
    });
  const ml: BotBehaviourMl | undefined =
    mlPerBot.length > 0 ? { perBot: mlPerBot, truncated: mlTruncated } : undefined;

  return {
    enabled: true,
    generatedAt,
    window: win,
    bots,
    prsOpenedPerDay,
    daySpanStart,
    overlap,
    repoBotDirs,
    ...(ml ? { ml } : {}),
  };
}

// PR-SCOPED bot behaviour (EXPERIMENTAL, CORE, deterministic) — the per-PR view of the aggregate
// Behaviour tab. For ONE PR, each automated reviewer's touch timeline + how its behaviour ON THIS
// PR compares to that bot's OWN typical (an 84-day account-wide robust baseline, same self-baseline
// idea as the aggregate tab). Account-scoped: a foreign/unknown prId → null (the route 404s).
export async function getPrBotBehaviour(
  prId: number,
  accountId: number,
): Promise<PrBotBehaviourResponse | null> {
  const [pr] = await db
    .select({ id: pullRequests.id, repoId: pullRequests.repoId, openedAt: pullRequests.openedAt })
    .from(pullRequests)
    .where(and(eq(pullRequests.id, prId), eq(pullRequests.accountId, accountId)))
    .limit(1)
    .execute();
  if (!pr) return null; // not the caller's PR → 404

  // `role: 'review'` — mirrors getBotBehaviourAnalytics, whose account-wide baseline this PR's
  // numbers are compared against. If the two sets disagreed the "slower than typical" claim would
  // be measured against a population the PR view doesn't contain.
  //
  // The judgement scope is THIS PR's OWN workspace, derived from its repo — never the caller's
  // selected one. A PR can be opened from another workspace via `?pr=`, a restored tab or a search
  // hit, and "is this login a bot HERE" is exactly the question a per-PR panel asks.
  const prScope = await botScopeForPr(accountId, prId);
  if (!prScope) return null;
  const automatedIds = await automatedReviewerUserIds(accountId, prScope.workspaceId, 'review');
  if (automatedIds.length === 0) return { enabled: true, prId, bots: [] };
  const kindMap = await classificationKindForUser(accountId, prScope.workspaceId);

  // Identity (label + login) — same resolution as getBotBehaviourAnalytics / the ROI panel.
  const classLabel = await classificationLabelMap(accountId, prScope.workspaceId);
  const loginById = new Map<number, string>();
  const rawLoginById = new Map<number, string>();
  for (const r of await db
    .select({ id: users.id, login: users.githubLogin, name: users.displayName })
    .from(users)
    .where(inArray(users.id, automatedIds))
    .execute()) {
    loginById.set(r.id, r.name?.trim() || r.login || `#${r.id}`);
    if (r.login) rawLoginById.set(r.id, r.login);
  }
  const reviewerLabel = (userId: number, kind: AutomatedReviewerKind): string => {
    const custom = classLabel.get(userId);
    if (custom) return custom;
    if (kind !== 'in_house' && kind !== 'pierre' && kind !== 'vendor')
      return labelForKind(kind);
    return loginById.get(userId) ?? labelForKind(kind);
  };

  const HOUR = 3_600_000;
  const trendFrom = new Date(Date.now() - 84 * 86_400_000);

  // (1) THIS PR's bot touches (reviews + inline comments + issue comments) for automated authors.
  type Touch = { userId: number; at: Date; kind: 'review' | 'comment' };
  const prTouches: Touch[] = [];
  for (const r of await db
    .select({ userId: reviews.authorId, at: reviews.submittedAt })
    .from(reviews)
    .where(and(eq(reviews.prId, prId), inArray(reviews.authorId, automatedIds), ne(reviews.state, 'pending')))
    .execute())
    if (r.userId != null) prTouches.push({ userId: r.userId, at: r.at, kind: 'review' });
  for (const r of await db
    .select({ userId: reviewComments.authorId, at: reviewComments.createdAt })
    .from(reviewComments)
    .where(and(eq(reviewComments.prId, prId), inArray(reviewComments.authorId, automatedIds)))
    .execute())
    if (r.userId != null) prTouches.push({ userId: r.userId, at: r.at, kind: 'comment' });
  for (const r of await db
    .select({ userId: prComments.authorId, at: prComments.createdAt })
    .from(prComments)
    .where(and(eq(prComments.prId, prId), inArray(prComments.authorId, automatedIds)))
    .execute())
    if (r.userId != null) prTouches.push({ userId: r.userId, at: r.at, kind: 'comment' });
  const prBotIds = [...new Set(prTouches.map((t) => t.userId))].filter((id) => kindMap.has(id));
  if (prBotIds.length === 0) return { enabled: true, prId, bots: [] };

  // ready-for-review for THIS PR (the TTFR clock start when observed at/before the first touch).
  const [readyEv] = await db
    .select({ at: events.occurredAt })
    .from(events)
    .where(and(eq(events.accountId, accountId), eq(events.prId, prId), eq(events.type, 'pr_ready_for_review')))
    .orderBy(asc(events.occurredAt))
    .limit(1)
    .execute();
  const readyThisPr = readyEv ? readyEv.at.getTime() : null;

  // (2) BASELINE: the prBotIds' per-PR first-touch + follow-ups over 84 days, account-wide — the
  // "typical" each bot is judged against. Only the bots on this PR (usually 1–3), so it's bounded.
  type BTouch = { userId: number; bPrId: number; ms: number };
  const baseTouches: BTouch[] = [];
  for (const r of await db
    .select({ userId: reviews.authorId, bPrId: reviews.prId, at: reviews.submittedAt })
    .from(reviews)
    .innerJoin(pullRequests, eq(pullRequests.id, reviews.prId))
    .where(and(eq(pullRequests.accountId, accountId), inArray(reviews.authorId, prBotIds), ne(reviews.state, 'pending'), gte(reviews.submittedAt, trendFrom)))
    .execute())
    if (r.userId != null && r.bPrId != null) baseTouches.push({ userId: r.userId, bPrId: r.bPrId, ms: r.at.getTime() });
  for (const r of await db
    .select({ userId: reviewComments.authorId, bPrId: reviewComments.prId, at: reviewComments.createdAt })
    .from(reviewComments)
    .innerJoin(pullRequests, eq(pullRequests.id, reviewComments.prId))
    .where(and(eq(pullRequests.accountId, accountId), inArray(reviewComments.authorId, prBotIds), gte(reviewComments.createdAt, trendFrom)))
    .execute())
    if (r.userId != null && r.bPrId != null) baseTouches.push({ userId: r.userId, bPrId: r.bPrId, ms: r.at.getTime() });
  for (const r of await db
    .select({ userId: prComments.authorId, bPrId: prComments.prId, at: prComments.createdAt })
    .from(prComments)
    .innerJoin(pullRequests, eq(pullRequests.id, prComments.prId))
    .where(and(eq(pullRequests.accountId, accountId), inArray(prComments.authorId, prBotIds), gte(prComments.createdAt, trendFrom)))
    .execute())
    if (r.userId != null && r.bPrId != null) baseTouches.push({ userId: r.userId, bPrId: r.bPrId, ms: r.at.getTime() });

  // Baseline PRs' openedAt + ready events (the TTFR clock, same rule as this PR).
  const basePrIds = [...new Set(baseTouches.map((t) => t.bPrId))];
  const openedByPr = new Map<number, number>();
  const readyByPr = new Map<number, number>();
  if (basePrIds.length > 0) {
    for (const p of await db
      .select({ id: pullRequests.id, openedAt: pullRequests.openedAt })
      .from(pullRequests)
      .where(and(eq(pullRequests.accountId, accountId), inArray(pullRequests.id, basePrIds)))
      .execute())
      openedByPr.set(p.id, p.openedAt.getTime());
    for (const e of await db
      .select({ bPrId: events.prId, at: events.occurredAt })
      .from(events)
      .where(and(eq(events.accountId, accountId), eq(events.type, 'pr_ready_for_review'), inArray(events.prId, basePrIds)))
      .execute()) {
      if (e.bPrId == null) continue;
      const ms = e.at.getTime();
      const cur = readyByPr.get(e.bPrId);
      if (cur == null || ms < cur) readyByPr.set(e.bPrId, ms);
    }
  }
  const ttfrOf = (pid: number, firstMs: number): number => {
    const ready = readyByPr.get(pid);
    const opened = openedByPr.get(pid) ?? firstMs;
    const base = ready != null && ready <= firstMs ? ready : opened;
    return Math.max(0, (firstMs - base) / HOUR);
  };
  // Group baseline per (bot, PR): first-touch + touch count → the bot's TTFR + follow-up samples.
  const byBotPr = new Map<number, Map<number, { first: number; count: number }>>();
  for (const t of baseTouches) {
    let m = byBotPr.get(t.userId);
    if (!m) {
      m = new Map();
      byBotPr.set(t.userId, m);
    }
    const e = m.get(t.bPrId);
    if (!e) m.set(t.bPrId, { first: t.ms, count: 1 });
    else {
      if (t.ms < e.first) e.first = t.ms;
      e.count += 1;
    }
  }

  // (3) Per-bot output: this PR's numbers + the vs-typical comparison.
  const out: PrBotBehaviour[] = [];
  for (const userId of prBotIds) {
    const kind = kindMap.get(userId)!;
    const mine = prTouches
      .filter((t) => t.userId === userId)
      .sort((a, b) => a.at.getTime() - b.at.getTime());
    const firstMs = mine[0]!.at.getTime();
    const useReady = readyThisPr != null && readyThisPr <= firstMs;
    const base = useReady ? readyThisPr! : pr.openedAt.getTime();
    const ttfrHours = Math.max(0, (firstMs - base) / HOUR);

    const perPr = byBotPr.get(userId) ?? new Map<number, { first: number; count: number }>();
    const ttfrSample: number[] = [];
    const followupSample: number[] = [];
    for (const [pid, e] of perPr) {
      ttfrSample.push(ttfrOf(pid, e.first));
      followupSample.push(e.count - 1);
    }
    const typicalTtfr = ttfrSample.length >= MIN_BASELINE_POINTS ? medianOf(ttfrSample) : null;
    const typicalFollowups = followupSample.length >= MIN_BASELINE_POINTS ? medianOf(followupSample) : null;
    let ttfrAnomaly: { z: number; typical: number } | null = null;
    if (typicalTtfr != null) {
      const mad = medianOf(ttfrSample.map((v) => Math.abs(v - typicalTtfr)))!;
      const sigma = Math.max(1.4826 * mad, 0.5);
      const z = (ttfrHours - typicalTtfr) / sigma;
      if (z >= ANOMALY_Z) ttfrAnomaly = { z: Math.round(z * 10) / 10, typical: typicalTtfr };
    }

    out.push({
      key: `u${userId}`,
      userId,
      login: rawLoginById.get(userId) ?? null,
      kind,
      label: reviewerLabel(userId, kind),
      firstTouchAt: mine[0]!.at.toISOString(),
      ttfrHours,
      ttfrBasis: useReady ? 'ready' : 'opened',
      touchCount: mine.length,
      followupCount: mine.length - 1,
      commentCount: mine.filter((t) => t.kind === 'comment').length,
      touches: mine.map((t) => ({ at: t.at.toISOString(), kind: t.kind })),
      typicalTtfrHours: typicalTtfr,
      typicalFollowups,
      baselinePrs: ttfrSample.length,
      ttfrAnomaly,
    });
  }
  out.sort((a, b) => (a.firstTouchAt ?? '').localeCompare(b.firstTouchAt ?? ''));
  return { enabled: true, prId, bots: out };
}

// Item 4 — the exact PR LIST behind getBotAnalytics's totals.botOnlyPrs count. A THIN wrapper:
// it resolves the window date range + the default repo scope IDENTICALLY to the analytics
// count path (§7078: window days from the kind; null scope → every account repo; [] short-
// circuits to empty) then defers to getBotOnlyReviewPrs for the shared bot-only rule, so the
// caption and its expandable list are computed from the same source and can NEVER disagree. The
// return shape (BotOnlyPrItem[]) is structurally the local BotOnlyReviewPr. Deterministic, no AI,
// account-scoped (getBotOnlyReviewPrs binds pullRequests.accountId, so a foreign repo id → []).
export async function getBotOnlyPrs(
  accountId: number,
  window: BotWindowKind,
  // The SAME `BotScope` object getBotAnalytics computed its count from — which is what makes the
  // COUNT and this LIST agree by construction. The old second `teamKey` argument was a thing a
  // caller could forget, and one drill-down did. `repoIds: []` = an empty workspace → empty.
  scope: BotScope,
): Promise<{ window: { kind: BotWindowKind; from: string; to: string }; prs: BotOnlyReviewPr[] }> {
  const nowMs = Date.now();
  const to = new Date(nowMs);
  // rolling_14 and 'sprint' both use the 14-day trailing window (matches getBotAnalytics).
  const from = new Date(nowMs - botWindowMs(window));
  const win = { kind: window, from: from.toISOString(), to: to.toISOString() };

  // An empty workspace means "no repos" → no PRs.
  if (scope.repoIds.length === 0) return { window: win, prs: [] };
  // No `openOnly` here: the LIST offers merged PRs behind a client-side "Show merged" toggle.
  const prs = await getBotOnlyReviewPrs(accountId, scope, { from, to });
  return { window: win, prs };
}

// ── Cross-org benchmark network — Phase 0 collection (CORE, cloud-only) ──────────────────
// De-identified, AGGREGATE-ONLY weekly review-bot outcome stats per KNOWN vendor, for the
// opt-in benchmark (accounts.benchmark_opt_in). Mirrors getBotAnalytics's per-thread heuristics
// (acted-on = resolved | likely_addressed | a human replied after the bot) but grouped by
// (vendorKind, ISO-week) and restricted to known ReviewBotKind vendors — in_house/pierre are not
// comparable across orgs / are identifying, so EXCLUDED. Reads ONLY this account's own data
// (accountId-scoped); the cross-account read is the future serving job (Phase 1, Pro plugin).

export interface BenchmarkContributionAgg {
  vendorKind: string; // a known ReviewBotKind
  weekStart: Date; // UTC Monday 00:00
  threads: number;
  comments: number;
  actedOn: number;
  untouched: number;
  humanFollow: number;
  oldestUntouchedDays: number | null;
}

// UTC Monday 00:00 of the ISO week containing `d`.
export function isoWeekStartUtc(d: Date): Date {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const backToMonday = (t.getUTCDay() + 6) % 7; // getUTCDay: 0=Sun..6=Sat
  t.setUTCDate(t.getUTCDate() - backToMonday);
  return t;
}

// Contributor-size covariate bucket from a distinct active-author count.
export function orgSizeBucket(contributors: number): string {
  if (contributors <= 1) return '1';
  if (contributors <= 5) return '2-5';
  if (contributors <= 20) return '6-20';
  if (contributors <= 50) return '21-50';
  if (contributors <= 200) return '51-200';
  return '200+';
}

// Distinct PR authors across the account's repos over the last `days` — the org-size proxy
// (the covariate a cohort conditions on). accountId-scoped.
export async function getAccountContributorCount(
  accountId: number,
  days = 90,
): Promise<number> {
  const since = new Date(Date.now() - days * 86_400_000);
  const rows = await db
    .selectDistinct({ id: pullRequests.authorId })
    .from(pullRequests)
    .where(and(eq(pullRequests.accountId, accountId), gte(pullRequests.openedAt, since)))
    .execute();
  return rows.filter((r) => r.id != null).length;
}

// Accounts that have consented to contribute (cloud-only; local never contributes). The rollup
// loops these. NOT a cross-tenant read of tenant data — just the consent roster.
export async function getBenchmarkOptedInAccountIds(): Promise<number[]> {
  const rows = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.benchmarkOptIn, true), eq(accounts.isLocal, false)))
    .execute();
  return rows.map((r) => r.id);
}

// MIRRORED from `REVIEW_BOT_KINDS` in @pierre-review/shared — the types-only package cannot be
// imported for a runtime value (the release build greps `release/dist` and fails on a real
// import), so the set is spelled twice and `bot-detection.test.ts` asserts they are identical.
//
// This is the list of kinds allowed to LEAVE THE TENANT for the cross-org benchmark. Adding a
// member is a data-governance decision, not a formatting one: rows keyed on it are contributed to
// a shared dataset and cannot be recalled.
export const BENCHMARKABLE_VENDOR_KINDS = new Set<string>([
  'coderabbit', 'greptile', 'copilot', 'qodo', 'sourcery', 'bito', 'ellipsis', 'korbit',
  'baz', 'graphite', 'cursor', 'devin', 'entelligence', 'deepsource', 'github_code_quality',
  'github_advanced_security', 'codex',
]);

// Weekly per-known-vendor benchmark aggregates for ONE account over [from, to).
export async function getBenchmarkContributions(
  accountId: number,
  from: Date,
  to: Date,
): Promise<BenchmarkContributionAgg[]> {
  // `role: 'review'` — the HIGHEST data-integrity stake in this file. These rows leave the tenant
  // and land in a CROSS-ORG benchmark, so shipping a linter's volume into a named review-bot
  // cohort corrupts the shared dataset permanently, for everyone, and cannot be un-shipped.
  // Quality checks were excluded ACCIDENTALLY until now (SonarQube resolved to `in_house`, which
  // the kind filter below drops); this makes it deliberate and survives a user classifying
  // SonarQube as a named vendor.
  //
  // THE ONE GENUINE ACCOUNT-WIDE SWEEP, and it uses the two EXPLICITLY NAMED account-wide helpers
  // rather than a null sentinel: this rollup contributes the tenant's whole footprint to the
  // shared dataset, so narrowing it to one workspace would silently under-report. A login
  // automated in ANY workspace counts (the union rule), and the kind map applies the written
  // cross-workspace tie-break — a non-null vendor kind in any workspace wins, lowest workspace id
  // breaks ties — because identity is per workspace now and an actor can legitimately be
  // `coderabbit` in A and unnamed in B. That value decides what leaves the tenant and cannot be
  // un-shipped, which is why it is a named rule and not an incidental Map build.
  const automatedIds = await automatedReviewerUserIdsForAccount(accountId, 'review');
  if (automatedIds.length === 0) return [];
  const kindMap = await classificationKindForUserForAccount(accountId);
  const nowMs = Date.now();

  // Only KNOWN AI-REVIEW vendors are comparable across orgs.
  //
  // ⚠ AN ALLOW-LIST, AND IT MUST STAY ONE. This was a DENY-list — `!== 'in_house' && !== 'pierre'
  // && !== 'vendor'` — which was correct only while `ReviewBotKind` was the entire branded
  // universe: everything else was one of those three. The moment `AutomatedReviewerKind` grew
  // vendor kinds for quality gates, dependency bots, code agents, release and housekeeping
  // automation, every one of them would have passed that test and shipped a linter's volume into
  // a shared cross-org REVIEW-BOT cohort — permanently, for every account, with no way to
  // un-ship it. A deny-list fails open on exactly the change nobody thinks to audit here.
  //
  // The `role: 'review'` narrowing above is the other half of the defence and neither is
  // redundant: role says "the user considers this a reviewer", this says "the brand is one we can
  // compare across orgs". A user who marks SonarQube a review bot passes the first and must still
  // fail the second — `sonarqube` is not a review-bot cohort anywhere else in the dataset.
  //
  // `REVIEW_BOT_KINDS` is MIRRORED from shared for the usual release-guard reason (types-only
  // package, no runtime import); `bot-detection.test.ts` pins the two copies identical.
  const vendorKindOf = (userId: number): string | null => {
    const k = kindMap.get(userId);
    return k != null && BENCHMARKABLE_VENDOR_KINDS.has(k) ? k : null;
  };

  type Acc = {
    vendorKind: string;
    weekMs: number;
    threads: number;
    comments: number;
    actedOn: number;
    untouched: number;
    humanFollow: number;
    oldestUntouchedMs: number | null;
  };
  const acc = new Map<string, Acc>();
  const bucketFor = (vendorKind: string, at: Date): Acc => {
    const weekMs = isoWeekStartUtc(at).getTime();
    const key = `${vendorKind} ${weekMs}`;
    let a = acc.get(key);
    if (!a) {
      a = {
        vendorKind,
        weekMs,
        threads: 0,
        comments: 0,
        actedOn: 0,
        untouched: 0,
        humanFollow: 0,
        oldestUntouchedMs: null,
      };
      acc.set(key, a);
    }
    return a;
  };

  // Threads opened by an automated reviewer in [from, to).
  const threadRows = await db
    .select({
      id: reviewThreads.id,
      userId: reviewThreads.originalCommenterId,
      state: reviewThreads.derivedState,
      createdAt: reviewThreads.createdAt,
    })
    .from(reviewThreads)
    .innerJoin(pullRequests, eq(pullRequests.id, reviewThreads.prId))
    .where(
      and(
        eq(pullRequests.accountId, accountId),
        inArray(reviewThreads.originalCommenterId, automatedIds),
        gte(reviewThreads.createdAt, from),
        lt(reviewThreads.createdAt, to),
      ),
    )
    .execute();

  // Pass 1: volume / untouched / oldest-untouched per (vendor, week); remember each thread's
  // bucket + base-acted for the merged acted-on definition below.
  const windowThreads: { id: number; bucket: Acc; baseActed: boolean }[] = [];
  for (const t of threadRows) {
    if (t.userId == null) continue;
    const kind = vendorKindOf(t.userId);
    if (!kind) continue;
    const bucket = bucketFor(kind, t.createdAt);
    bucket.threads += 1;
    const baseActed = t.state === 'resolved' || t.state === 'likely_addressed';
    if (t.state === 'untouched') {
      bucket.untouched += 1;
      const ms = t.createdAt.getTime();
      if (bucket.oldestUntouchedMs == null || ms < bucket.oldestUntouchedMs) {
        bucket.oldestUntouchedMs = ms;
      }
    }
    windowThreads.push({ id: t.id, bucket, baseActed });
  }

  // Pass 2: human follow-through — a human commented after the bot's last comment on the thread.
  const wtIds = windowThreads.map((w) => w.id);
  const humanFollow = new Set<number>();
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
    const autoSet = new Set(automatedIds);
    for (const [threadId, comments] of byThread) {
      let botLastAt = -Infinity;
      for (const c of comments) {
        if (c.authorId != null && autoSet.has(c.authorId) && c.at > botLastAt) botLastAt = c.at;
      }
      if (comments.some((c) => c.authorId != null && !autoSet.has(c.authorId) && c.at > botLastAt)) {
        humanFollow.add(threadId);
      }
    }
  }
  for (const w of windowThreads) {
    if (humanFollow.has(w.id)) w.bucket.humanFollow += 1;
    if (w.baseActed || humanFollow.has(w.id)) w.bucket.actedOn += 1;
  }

  // Comments authored by an automated reviewer in [from, to), per (vendor, week).
  const commentRows = await db
    .select({
      authorId: reviewComments.authorId,
      createdAt: reviewComments.createdAt,
    })
    .from(reviewComments)
    .innerJoin(pullRequests, eq(pullRequests.id, reviewComments.prId))
    .where(
      and(
        eq(pullRequests.accountId, accountId),
        inArray(reviewComments.authorId, automatedIds),
        gte(reviewComments.createdAt, from),
        lt(reviewComments.createdAt, to),
      ),
    )
    .execute();
  for (const c of commentRows) {
    if (c.authorId == null) continue;
    const kind = vendorKindOf(c.authorId);
    if (!kind) continue;
    bucketFor(kind, c.createdAt).comments += 1;
  }

  return [...acc.values()]
    .filter((a) => a.threads > 0 || a.comments > 0)
    .map((a) => ({
      vendorKind: a.vendorKind,
      weekStart: new Date(a.weekMs),
      threads: a.threads,
      comments: a.comments,
      actedOn: a.actedOn,
      untouched: a.untouched,
      humanFollow: a.humanFollow,
      oldestUntouchedDays:
        a.oldestUntouchedMs == null
          ? null
          : Math.floor((nowMs - a.oldestUntouchedMs) / 86_400_000),
    }));
}

// Idempotent upsert of an account's weekly contributions (one row per vendor+week). The
// org-size bucket is the account's size at contribution time (denormalized per row).
export async function upsertBenchmarkContributions(
  accountId: number,
  sizeBucket: string,
  rows: BenchmarkContributionAgg[],
): Promise<void> {
  for (const r of rows) {
    await db
      .insert(benchmarkContributions)
      .values({
        accountId,
        vendorKind: r.vendorKind,
        weekStart: r.weekStart,
        threads: r.threads,
        comments: r.comments,
        actedOn: r.actedOn,
        untouched: r.untouched,
        humanFollow: r.humanFollow,
        oldestUntouchedDays: r.oldestUntouchedDays,
        orgSizeBucket: sizeBucket,
        schemaVersion: 1,
      })
      .onConflictDoUpdate({
        target: [
          benchmarkContributions.accountId,
          benchmarkContributions.vendorKind,
          benchmarkContributions.weekStart,
        ],
        set: {
          threads: r.threads,
          comments: r.comments,
          actedOn: r.actedOn,
          untouched: r.untouched,
          humanFollow: r.humanFollow,
          oldestUntouchedDays: r.oldestUntouchedDays,
          orgSizeBucket: sizeBucket,
        },
      })
      .execute();
  }
}

// Withdraw consent → delete the account's contributions (one-click, complete removal).
export async function deleteBenchmarkContributions(accountId: number): Promise<void> {
  await db
    .delete(benchmarkContributions)
    .where(eq(benchmarkContributions.accountId, accountId))
    .execute();
}

// Item 6 — the per-PR drill-down behind a vendor's Bot-ROI row (GET /api/bot-analytics/vendor/:key/prs).
// Keyed by the analytics ROW (per-REVIEWER, not per-kind), so two in-house bots don't collapse into
// one merged list. `target` is either `{ userId }` (a single reviewer) or the `{ kind: 'pierre' }`
// sentinel. Lists the PRs that reviewer touched in the window (its review threads + comments), with
// per-PR volume, the merged "acted-on" count (resolved | likely_addressed | a human followed up
// after the bot), the untouched backlog, last-activity, and the broadened bot-only flag. Ordered
// most-recent-bot-activity first (nulls last). Deterministic, NO AI, account-scoped (the vendor's
// threads/comments bind pullRequests.accountId via the PR join — a foreign/unknown userId surfaces
// nothing). For the 'pierre' sentinel the PRs are those with a Pierre-verbatim posted review
// in-window — per-review provenance means Pierre has no attributable threads/comments (the human who
// posted is never reclassified), so its rows carry the review timestamp as lastBotActivityAt and 0
// thread/comment counts.
export async function getBotVendorPrs(
  accountId: number,
  target: { userId: number } | { kind: 'pierre' },
  window: BotWindowKind,
  // The SAME `BotScope` the ROI row was computed at — this list must reproduce ONE of that
  // panel's rows, so the header label and the per-PR `botOnly` badge both take the identical
  // workspace and repo set. `repoIds` is applied at the final PR-metadata load (the single
  // narrowing point), so the whole result stays scoped; `repoIds: []` = an empty workspace.
  scope: BotScope,
): Promise<BotVendorPrsResponse> {
  const nowMs = Date.now();
  const to = new Date(nowMs);
  // The one shared window→duration mapping (db/bot-window.ts).
  const from = new Date(nowMs - botWindowMs(window));
  const win = { kind: window, from: from.toISOString(), to: to.toISOString() };
  const generatedAt = new Date(nowMs).toISOString();

  // Resolve the drill-down's identity — the analytics ROW this list belongs to.
  const isPierre = 'kind' in target;
  let key: string;
  let kindTyped: AutomatedReviewerKind;
  let label: string;
  let login: string | null;
  let vendorIds: number[];
  if (isPierre) {
    key = 'pierre';
    kindTyped = 'pierre';
    label = labelForKind('pierre');
    login = null;
    vendorIds = [];
  } else {
    const userId = target.userId;
    key = `u${userId}`;
    // NOT role-filtered: the quality-check SECTION of the ROI panel offers the same drill-down,
    // so narrowing here would make its rows un-openable.
    const kindMap = await classificationKindForUser(accountId, scope.workspaceId);
    // Only a reviewer this account has CLASSIFIED as automated is a valid drill-down target.
    // An arbitrary (human / foreign / unknown) userId lists nothing AND identifies nothing:
    // the users table is GLOBAL, and resolving login/displayName for an unclassified numeric
    // id would hand any tenant a cross-account login-enumeration oracle — the exact thing the
    // /api/users/:id/stats precedent (counts only, no profile fields) exists to prevent. The
    // key is the caller's own input; the label degrades to it; login stays null.
    if (!kindMap.has(userId)) {
      return {
        enabled: true, key, kind: 'in_house', label: key, login: null, window: win,
        prs: [], generatedAt,
      };
    }
    kindTyped = kindMap.get(userId) ?? 'in_house';
    vendorIds = [userId];
    // Per-reviewer identity — mirrors getBotAnalytics's reviewerLabel resolution: the workspace's
    // custom label → the vendor's pretty name (known vendors) → login/display name. ONE row per
    // (workspace, actor), so this drill-down and the ROI row it was opened from cannot show
    // different labels — which they could when the label was replicated per repo/team row and an
    // unordered `limit(1)` picked whichever the storage engine handed back first. Safe to read
    // the global row HERE: the classification row above proves the account association.
    const classLabel = await classificationLabelMap(accountId, scope.workspaceId);
    const [userRow] = await db
      .select({ login: users.githubLogin, name: users.displayName })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
      .execute();
    login = userRow?.login ?? null;
    const custom = classLabel.get(userId);
    if (custom) label = custom;
    else if (kindTyped !== 'in_house' && kindTyped !== 'pierre' && kindTyped !== 'vendor')
      label = labelForKind(kindTyped);
    else label = userRow?.name?.trim() || login || `u${userId}`;
  }

  const empty: BotVendorPrsResponse = {
    enabled: true, key, kind: kindTyped, label, login, window: win, prs: [], generatedAt,
  };
  if (scope.repoIds.length === 0) return empty;

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

  if (isPierre) {
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
    // `role: 'all'` — this set answers "was the replier a HUMAN". A quality-check bot's reply is
    // not human follow-through, so narrowing to review-role bots would count it as one.
    const autoSet = new Set(
      await automatedReviewerUserIds(accountId, scope.workspaceId, 'all'),
    );
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
        inArray(pullRequests.repoId, scope.repoIds),
      ),
    )
    .execute();

  // Bot-only flag: reuse the broadened rule (item 4a) over the candidate PRs' OWN repos, at THIS
  // scope's workspace — so this drill-down and the `totals.botOnlyPrs` header above it cannot
  // evaluate different rules. Under the old two-parameter shape, forgetting to thread the
  // classification key gave one screen two contradictory bot-only answers.
  const repoIdSet = [...new Set(metaRows.map((m) => m.repoId))];
  const botOnlyIds = new Set(
    (
      await getBotOnlyReviewPrs(
        accountId,
        { workspaceId: scope.workspaceId, repoIds: repoIdSet },
        { from, to },
      )
    ).map((p) => p.prId),
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

  return { enabled: true, key, kind: kindTyped, label, login, window: win, prs, generatedAt };
}

// WS4 — cross-bot dedup + consensus for one PR. Groups the PR's automated-reviewer
// threads by (path, ±3-line window — THE shared definition, db/line-overlap.ts); a group with
// ≥2 threads from ≥2 DISTINCT USERS is a real dedup hit (user-distinct, not kind-distinct: two
// different in-house bots independently flagging one line IS the signal — that they share a
// kind is irrelevant). Members are COLLAPSED per bot — one BotDedupMember per user carrying a
// representative threadId + the full `threadIds` list — so a verbose bot's 23 threads render
// as one ×23 pill, not 23 identical pills. consensus = ALL threads' inferred severities agree
// (or are unknowable); conflict = they diverge. Ownership → null (→ the route 404s).
// Account-scoped.
export async function getBotDedupClusters(
  prId: number,
  accountId: number,
): Promise<BotDedupResponse | null> {
  const owned = (
    await db
      .select({ id: pullRequests.id, repoId: pullRequests.repoId })
      .from(pullRequests)
      .where(and(eq(pullRequests.id, prId), eq(pullRequests.accountId, accountId)))
      .limit(1)
      .execute()
  )[0];
  if (!owned) return null;
  // The judgement scope is THIS PR's OWN workspace, derived from its repo — never the caller's
  // selected one (a PR reachable via `?pr=`, a restored tab or a search hit may belong to another).
  const prScope = await workspaceScopeForRepo(accountId, owned.repoId);
  if (!prScope) return { prId, clusters: [] };

  // `role: 'review'` — a dedup cluster claims two REVIEWERS independently flagged the same line.
  // "SonarQube and CodeRabbit both commented on line 42" is not cross-bot review consensus: one
  // is a rule firing, the other is a judgement, and presenting them as agreement is misleading.
  const automatedIds = await automatedReviewerUserIds(accountId, prScope.workspaceId, 'review');
  if (automatedIds.length === 0) return { prId, clusters: [] };
  const kindMap = await classificationKindForUser(accountId, prScope.workspaceId);
  // Per-reviewer label (custom classification label → vendor pretty name → login/display name)
  // — mirrors getBotAnalytics.reviewerLabel, so two in-house bots are distinguishable here
  // instead of both reading the kind-generic "In-house AI".
  const classLabel = await classificationLabelMap(accountId, prScope.workspaceId);

  const rows = await db
    .select({
      id: reviewThreads.id,
      userId: reviewThreads.originalCommenterId,
      path: reviewThreads.path,
      line: reviewThreads.line,
      state: reviewThreads.derivedState,
      addressedConfidence: reviewThreads.addressedConfidence,
      login: users.githubLogin,
      name: users.displayName,
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

  interface DedupThread {
    prId: number;
    path: string;
    line: number | null;
    threadId: number;
    userId: number;
    kind: AutomatedReviewerKind;
    login: string;
    label: string;
    excerpt: string | null;
    derivedState: DerivedState;
    addressedConfidence: AddressedConfidence;
  }
  const threads: DedupThread[] = [];
  for (const r of rows) {
    if (r.userId == null) continue;
    const kind = kindMap.get(r.userId);
    if (!kind) continue;
    const custom = classLabel.get(r.userId);
    const label =
      custom ??
      (kind !== 'in_house' && kind !== 'pierre' && kind !== 'vendor'
        ? labelForKind(kind)
        : r.name?.trim() || r.login);
    threads.push({
      prId,
      path: r.path,
      line: r.line,
      threadId: r.id,
      userId: r.userId,
      kind,
      login: r.login,
      label,
      excerpt: excerptByThread.get(r.id) ?? null,
      derivedState: r.state,
      addressedConfidence: r.addressedConfidence,
    });
  }

  // THE shared ±3-line clustering. The null-line catch-all group is KEPT on this surface —
  // outdated/file-level threads still render as a per-file lump the reader can clear in one
  // pass — while the ROI overlap metric excludes them (see getBotAnalytics).
  const clusters: BotDedupCluster[] = [];
  for (const c of clusterThreadsByLine(threads, { nullLineGroup: true })) {
    // Entry gate: ≥2 threads from ≥2 DISTINCT USERS (implied: userIds ⊆ threads).
    if (c.userIds.size < 2) continue;
    // Severity-conflict over ALL threads' excerpts, not just the representatives — a bot's 2nd
    // thread disagreeing with another bot is still a disagreement.
    const sevs = new Set(
      c.items.map((m) => inferSeverity(m.excerpt)).filter((s): s is string => s != null),
    );
    const conflict = sevs.size >= 2;
    // Collapse per bot: representative = the bot's first thread in cluster (line) order.
    const byUser = new Map<number, DedupThread[]>();
    for (const t of c.items) {
      const arr = byUser.get(t.userId) ?? [];
      arr.push(t);
      byUser.set(t.userId, arr);
    }
    const members: BotDedupMember[] = [...byUser.values()].map((ts) => {
      const rep = ts[0]!;
      return {
        threadId: rep.threadId,
        userId: rep.userId,
        kind: rep.kind,
        login: rep.login,
        label: rep.label,
        excerpt: rep.excerpt,
        derivedState: rep.derivedState,
        addressedConfidence: rep.addressedConfidence,
        threadIds: ts.map((t) => t.threadId),
      };
    });
    clusters.push({ path: c.path, line: c.line, members, consensus: !conflict, conflict });
  }
  // Most bots first, then most threads — the biggest dedup hit leads.
  const threadTotal = (cl: BotDedupCluster): number =>
    cl.members.reduce((n, m) => n + (m.threadIds?.length ?? 1), 0);
  clusters.sort((a, b) => b.members.length - a.members.length || threadTotal(b) - threadTotal(a));
  return { prId, clusters };
}


// ---------------------------------------------------------------------------------------
// Auto-merge intents ("arm it and walk away") — the query layer for `auto_merge_requests`.
//
// This is Pierre's OWN watcher, not GitHub's native auto-merge: a stored intent that the
// background pass in `merge/auto-merge-runner.ts` re-evaluates. Everything here is
// accountId-scoped; the one cross-account read (`listArmedMergeRequestsForRunner`) is the
// watcher's own scan and returns the accountId on every row so the caller can fetch that
// tenant's token and stay isolated.
// ---------------------------------------------------------------------------------------

// The wire shape of an intent, spelled ONCE so the three readers below can't drift. The
// repo/PR identity rides every row because the cross-PR surface (the global armed-merge card)
// gets nothing else to label a row with — and the join is NOT the tenancy guard: every reader
// keeps its explicit `accountId` predicate on `auto_merge_requests`.
// A FUNCTION, not a module-level object: the table handles are destructured off `schema` at
// import time, and a suite that stubs the schema module leaves them undefined — reading a
// column there would throw while merely IMPORTING queries.ts, taking unrelated suites with it.
const armedMergeColumns = () => ({
  prId: autoMergeRequests.prId,
  mergeMethod: autoMergeRequests.mergeMethod,
  updateStrategy: autoMergeRequests.updateStrategy,
  viaMergeQueue: autoMergeRequests.viaMergeQueue,
  enqueuedAt: autoMergeRequests.enqueuedAt,
  armedAt: autoMergeRequests.armedAt,
  expectedHeadOid: autoMergeRequests.expectedHeadOid,
  state: autoMergeRequests.state,
  phase: autoMergeRequests.phase,
  lastCheckedAt: autoMergeRequests.lastCheckedAt,
  lastReason: autoMergeRequests.lastReason,
  expiresAt: autoMergeRequests.expiresAt,
  repoOwner: repos.owner,
  repoName: repos.name,
  prNumber: pullRequests.number,
  prTitle: pullRequests.title,
});

interface AutoMergeRow {
  prId: number;
  mergeMethod: string;
  updateStrategy: 'rebase' | 'merge' | 'none';
  viaMergeQueue: boolean;
  enqueuedAt: Date | null;
  armedAt: Date;
  expectedHeadOid: string;
  state: string;
  phase: string | null;
  lastCheckedAt: Date | null;
  lastReason: string | null;
  expiresAt: Date;
  repoOwner: string;
  repoName: string;
  prNumber: number;
  prTitle: string;
}

function toArmedMergeRequest(row: AutoMergeRow): ArmedMergeRequest {
  return {
    prId: row.prId,
    repoOwner: row.repoOwner,
    repoName: row.repoName,
    prNumber: row.prNumber,
    prTitle: row.prTitle,
    mergeMethod: row.mergeMethod as MergeMethod,
    updateStrategy: row.updateStrategy,
    viaMergeQueue: row.viaMergeQueue,
    enqueuedAt: iso(row.enqueuedAt),
    armedAt: row.armedAt.toISOString(),
    expectedHeadOid: row.expectedHeadOid,
    state: row.state as ArmedMergeState,
    lastCheckedAt: iso(row.lastCheckedAt),
    lastReason: row.lastReason,
    phase: row.phase as ArmedMergePhase | null,
    expiresAt: row.expiresAt.toISOString(),
  };
}

/**
 * Arm (or RE-arm) auto-merge for one PR. The unique `(accountId, prId)` means re-arming
 * OVERWRITES the previous row — including a terminal one — which is the point: after a
 * `disarmed_head_moved` the user re-arms against the NEW head and the intent starts clean
 * (state back to 'armed', reason cleared, the clock restarted).
 *
 * The caller is responsible for having verified write permission and for passing the LIVE
 * head SHA; this function does not talk to GitHub.
 */
export async function armAutoMerge(
  accountId: number,
  prId: number,
  opts: {
    mergeMethod: MergeMethod;
    updateStrategy: 'rebase' | 'merge' | 'none';
    // Whether the base branch had a merge queue at arm time (the caller checked live).
    viaMergeQueue: boolean;
    expectedHeadOid: string;
    expiresAt: Date;
  },
): Promise<ArmedMergeRequest> {
  const now = new Date();
  const rows = await db
    .insert(autoMergeRequests)
    .values({
      accountId,
      prId,
      mergeMethod: opts.mergeMethod,
      updateStrategy: opts.updateStrategy,
      viaMergeQueue: opts.viaMergeQueue,
      enqueuedAt: null,
      expectedHeadOid: opts.expectedHeadOid,
      state: 'armed',
      armedAt: now,
      expiresAt: opts.expiresAt,
      lastCheckedAt: null,
      lastReason: null,
      // The watcher hasn't looked yet (up to one cron tick away), and saying so is more honest
      // than a blank row — the SPA seeds its progress card from THIS payload, on the click.
      phase: 'pending_first_check',
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [autoMergeRequests.accountId, autoMergeRequests.prId],
      set: {
        mergeMethod: opts.mergeMethod,
        updateStrategy: opts.updateStrategy,
        viaMergeQueue: opts.viaMergeQueue,
        // A re-arm starts clean: any queue entry recorded on the previous intent belonged
        // to a head/consent that no longer applies.
        enqueuedAt: null,
        expectedHeadOid: opts.expectedHeadOid,
        state: 'armed',
        armedAt: now,
        expiresAt: opts.expiresAt,
        lastCheckedAt: null,
        lastReason: null,
        phase: 'pending_first_check',
        updatedAt: now,
      },
    })
    .execute();
  // Read back through the ONE joined reader rather than `.returning()`: the arm response is
  // what the SPA seeds its progress card from, so it must carry the same identity + phase
  // fields the polled list does. The upsert always yields exactly one row, so the non-null
  // assert mirrors persistPr's.
  const armed = await getAutoMergeRequest(accountId, prId);
  return armed!;
}

/**
 * The base branch as last SYNCED for one PR (null when unknown / foreign / unsynced).
 *
 * The auto-merge watcher has no `expected_base_ref` column to pin the consented target to, so
 * it uses the synced base ref as the consent record — which is only a valid record if it
 * MATCHES the live base at arming time. The arm route checks exactly that with this.
 */
export async function getSyncedBaseRef(
  accountId: number,
  prId: number,
): Promise<string | null> {
  const rows = await db
    .select({ baseRefName: pullRequests.baseRefName })
    .from(pullRequests)
    .innerJoin(repos, eq(repos.id, pullRequests.repoId))
    .where(and(eq(pullRequests.id, prId), eq(repos.accountId, accountId)))
    .limit(1)
    .execute();
  return rows[0]?.baseRefName ?? null;
}

/** The live intent for one PR, or null. Account-scoped (a foreign prId reads as null). */
export async function getAutoMergeRequest(
  accountId: number,
  prId: number,
): Promise<ArmedMergeRequest | null> {
  const rows = await db
    .select(armedMergeColumns())
    .from(autoMergeRequests)
    .innerJoin(pullRequests, eq(pullRequests.id, autoMergeRequests.prId))
    .innerJoin(repos, eq(repos.id, pullRequests.repoId))
    .where(
      and(eq(autoMergeRequests.accountId, accountId), eq(autoMergeRequests.prId, prId)),
    )
    .limit(1)
    .execute();
  const row = rows[0];
  return row ? toArmedMergeRequest(row) : null;
}

/**
 * Disarm: DELETE the row rather than move it to a terminal state. `ArmedMergeState` has no
 * "the user changed their mind" value on purpose — an intent the user withdrew is not
 * history worth keeping, and leaving a terminal row behind would make the next arm look
 * like a re-arm in the UI. Returns whether anything was armed.
 */
export async function disarmAutoMerge(
  accountId: number,
  prId: number,
): Promise<boolean> {
  const rows = await db
    .delete(autoMergeRequests)
    .where(
      and(eq(autoMergeRequests.accountId, accountId), eq(autoMergeRequests.prId, prId)),
    )
    .returning({ id: autoMergeRequests.id })
    .execute();
  return rows.length > 0;
}

// How long a resolved (merged / disarmed / expired / failed) intent keeps being reported by
// GET /api/auto-merge. Long enough for the client's poll to observe the armed→merged edge
// and raise its toast even if the tab was asleep for a while; short enough that the list
// stays a "what's about to land" surface rather than a log.
const RESOLVED_INTENT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Every armed intent for the account, plus recently-resolved ones (the client diffs
 * armed→merged to raise its toast). Newest first, capped.
 *
 * Joined to the repo + PR so each row can LABEL itself: this list is what the cross-PR
 * progress surface reads, and it has no PR context of its own to look a name up from. Still a
 * pure DB read, which is the reason `GET /api/auto-merge` may sit on the default `read` rate
 * tier — see the note in api/plugins/rate-limit.ts before adding anything live to it.
 */
export async function listAutoMergeRequests(
  accountId: number,
): Promise<ArmedMergeRequest[]> {
  const cutoff = new Date(Date.now() - RESOLVED_INTENT_WINDOW_MS);
  const rows = await db
    .select(armedMergeColumns())
    .from(autoMergeRequests)
    .innerJoin(pullRequests, eq(pullRequests.id, autoMergeRequests.prId))
    .innerJoin(repos, eq(repos.id, pullRequests.repoId))
    .where(
      and(
        eq(autoMergeRequests.accountId, accountId),
        or(
          eq(autoMergeRequests.state, 'armed'),
          gte(autoMergeRequests.updatedAt, cutoff),
        ),
      ),
    )
    .orderBy(desc(autoMergeRequests.updatedAt))
    .limit(200)
    .execute();
  return rows.map(toArmedMergeRequest);
}

/** One armed intent joined to everything the watcher needs to act on it. */
export interface ArmedMergeWork {
  id: number;
  accountId: number;
  prId: number;
  prNodeId: string;
  owner: string;
  name: string;
  number: number;
  prState: PrState;
  viewerPermission: string | null;
  mergeMethod: MergeMethod;
  updateStrategy: 'rebase' | 'merge' | 'none';
  // The base branch had a merge queue at arm time — the watcher enqueues instead of
  // direct-merging (re-verified live each tick; a since-disabled queue falls back).
  viaMergeQueue: boolean;
  // When the watcher itself enqueued the PR; null until then. The attribution record:
  // merged-while-set resolves 'merged', a human's queue entry never does.
  enqueuedAt: Date | null;
  expectedHeadOid: string;
  expiresAt: Date;
  armedAt: Date;
  // The base branch as last SYNCED — i.e. the target the SPA was showing when the user armed.
  // The watcher compares it to the live base so a retarget (which leaves head.sha untouched,
  // so the head pin can't see it) doesn't land the PR in a branch nobody consented to.
  syncedBaseRef: string | null;
  // The head commit's CI status as last SYNCED. Used for ONE thing: GitHub collapses "required
  // checks still running" and "required reviews missing" into the same `mergeableState:
  // 'blocked'`, and this is what lets the watcher name which of the two it is without a second
  // live fetch per intent per tick. Advisory only — it never gates the merge.
  syncedCiStatus: CiStatus | null;
}

/**
 * The watcher's scan: still-armed intents across EVERY account, LEAST-RECENTLY-CHECKED first,
 * bounded by `limit` — one tick must be a bounded amount of GitHub traffic no matter how many
 * intents exist. Each row carries its `accountId`; the caller MUST fetch that account's token
 * (`getAccessToken`) and wrap each account's work in its own try/catch.
 *
 * The order is load-bearing for FAIRNESS. It used to be `armedAt ASC`, which never changes
 * after arming — so past `limit` armed intents the same oldest `limit` rows were re-picked
 * every tick and intent #limit+1 was never evaluated at all. `lastCheckedAt` is stamped by
 * every pass, so ordering on it rotates the whole backlog.
 *
 * DIALECT TRAP: a never-checked row has a NULL `lastCheckedAt` and must sort FIRST, but SQLite
 * sorts NULLs first in ASC while Postgres sorts them last, and drizzle's `asc()` emits no
 * NULLS clause. The explicit CASE key pins "nulls first" identically in both dialects.
 */
export async function listArmedMergeRequestsForRunner(
  limit: number,
): Promise<ArmedMergeWork[]> {
  const rows = await db
    .select({
      id: autoMergeRequests.id,
      accountId: autoMergeRequests.accountId,
      prId: autoMergeRequests.prId,
      prNodeId: pullRequests.githubNodeId,
      owner: repos.owner,
      name: repos.name,
      number: pullRequests.number,
      prState: pullRequests.state,
      viewerPermission: repos.viewerPermission,
      mergeMethod: autoMergeRequests.mergeMethod,
      updateStrategy: autoMergeRequests.updateStrategy,
      viaMergeQueue: autoMergeRequests.viaMergeQueue,
      enqueuedAt: autoMergeRequests.enqueuedAt,
      expectedHeadOid: autoMergeRequests.expectedHeadOid,
      expiresAt: autoMergeRequests.expiresAt,
      armedAt: autoMergeRequests.armedAt,
      syncedBaseRef: pullRequests.baseRefName,
      syncedCiStatus: pullRequests.ciStatus,
    })
    .from(autoMergeRequests)
    .innerJoin(pullRequests, eq(pullRequests.id, autoMergeRequests.prId))
    .innerJoin(repos, eq(repos.id, pullRequests.repoId))
    .where(eq(autoMergeRequests.state, 'armed'))
    .orderBy(
      sql`case when ${autoMergeRequests.lastCheckedAt} is null then 0 else 1 end`,
      asc(autoMergeRequests.lastCheckedAt),
      asc(autoMergeRequests.armedAt),
    )
    .limit(limit)
    .execute();
  return rows.map((r) => ({
    ...r,
    prState: r.prState as PrState,
    mergeMethod: r.mergeMethod as MergeMethod,
    syncedCiStatus: r.syncedCiStatus as CiStatus | null,
  }));
}

/**
 * Record the outcome of one watcher pass over an intent. `state` is omitted for the common
 * "still waiting" case, which only stamps `lastCheckedAt` + the current blocker.
 */
export async function updateAutoMergeState(
  id: number,
  opts: {
    state?: ArmedMergeState;
    lastReason?: string | null;
    // The machine-readable twin of `lastReason` — pass it in the SAME call that writes the
    // prose, never in a follow-up, so the two can't disagree. Explicit null resolves a
    // terminal row (the outcome is `state`) or an uncharacterisable wait.
    phase?: ArmedMergePhase | null;
    checkedAt?: Date;
    // Re-pin the consent anchor. ONLY the watcher's own "update the branch from trunk" step
    // may do this: it moved the head itself, so leaving the old SHA in place would make the
    // very next tick disarm the intent as "the branch moved". A head that moved for any other
    // reason must still disarm — that is the whole point of the anchor.
    expectedHeadOid?: string;
    // Stamp the watcher's own enqueue (merge-queue intents only). Never cleared while armed —
    // it is the attribution record for the eventual merge; a re-arm resets it.
    enqueuedAt?: Date;
  },
): Promise<void> {
  const now = new Date();
  await db
    .update(autoMergeRequests)
    .set({
      lastCheckedAt: opts.checkedAt ?? now,
      updatedAt: now,
      ...(opts.state !== undefined ? { state: opts.state } : {}),
      ...(opts.lastReason !== undefined ? { lastReason: opts.lastReason } : {}),
      ...(opts.phase !== undefined ? { phase: opts.phase } : {}),
      ...(opts.expectedHeadOid !== undefined
        ? { expectedHeadOid: opts.expectedHeadOid }
        : {}),
      ...(opts.enqueuedAt !== undefined ? { enqueuedAt: opts.enqueuedAt } : {}),
    })
    .where(eq(autoMergeRequests.id, id))
    .execute();
}
