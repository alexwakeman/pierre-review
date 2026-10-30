import type { Page, Route } from '@playwright/test';
import type {
  AiBudgetResponse,
  CloneStorageResponse,
  ThreadCheckStatusResponse,
  ReferenceDocSectionResponse,
  ReferenceDocTreeResponse,
  ReferenceDocsConversationsResponse,
  ReferenceDocsResponse,
  ReferenceDocsSettings,
  WorkspaceAutoReviewResponse,
  AttentionCardsResponse,
  AttentionLivenessResponse,
  AwaitingReviewItem,
  BranchStatusResponse,
  BranchTrendsResponse,
  ConsolidatedFeedItem,
  ConsolidatedFeedResponse,
  ActivityResponse,
  MeResponse,
  MyTurnPr,
  MergedPrsResponse,
  MyTurnResponse,
  OpenPrsResponse,
  ClaudeReviewStatesResponse,
  ClaudeThreadJudgementsResponse,
  PrTicketReviewsResponse,
  TicketReviewStatesResponse,
  CiReviewStatesResponse,
  PrCiReviewResponse,
  PrDetail,
  Repo,
  ThreadDetail,
  TimelineEvent,
  TimelinePr,
  TimelineResponse,
  User,
  WatchedRepoPrItem,
  Workspace,
  WorkspacesResponse,
  DetectedReviewersResponse,
  ArmedMergeListResponse,
  SyncActivityResponse,
  DailyBriefResponse,
  DependencyBumpCard,
  InsightCard,
  InsightKind,
  InsightPrRef,
  PendingAuthorSplit,
  PendingTab,
  SecurityCard,
  TicketLinksResponse,
  TicketMergedPrsResponse,
  TicketStoryResponse,
  WorkspaceTrackerSettings,
  WorkspaceSonarSettings,
  WikiCredentialsSettings,
  SonarPrResponse,
  PrSequenceDiagramsResponse,
  TicketSequenceDiagramResponse,
  StoryDocsAlignmentResponse,
  SprintGraphResponse,
  SprintGraphTokenResponse,
  StoryBuild,
  StoryBuildChecksPreview,
  StoryBuildDiffResponse,
  StoryBuildForTicketResponse,
  StoryBuildPushResponse,
  StoryBuildRepo,
  StoryBuildStartResponse,
  WorkspaceProSettings,
  WorkspaceSlackTargetResponse,
} from '@pierre-review/shared';
// VALUES, not types — the fixtures quote the shipped default rather than re-typing 1500, and
// build the Pending tabs from the shipped list rather than re-typing it.
import {
  AI_BUDGET_DEFAULTS,
  aiKindsAll,
  LARGE_PR_CODE_LOC_DEFAULT,
  PENDING_TABS,
  pendingTabHolds,
  pendingAuthorSideOf,
  resolveMyTurnSettings,
  STORY_BUILD_API,
} from '@pierre-review/shared';

// Deterministic, self-contained API fixtures for the My Turn / Feed / Focus-mode
// regression tests. Every /api/** request is intercepted in the browser (page.route)
// and answered from these objects — no backend, DB, or gh needed, so the suite runs
// the same locally and on CI. The data is shaped so the two focus modes are
// observable: the FULL board shows 5 PRs; the My Turn inbox is a 3-PR SUBSET, so
// "My Turn focus shows ALL inbox PRs (not just one), fewer than the full board" is a
// checkable invariant.

const now = Date.now();
const iso = (daysAgo: number): string => new Date(now - daysAgo * 86_400_000).toISOString();

const ME: User = { id: 1, githubLogin: 'me-user', displayName: 'Me', avatarUrl: null, isBot: false };
const ALICE: User = { id: 2, githubLogin: 'alice', displayName: 'Alice', avatarUrl: null, isBot: false };
const BOB: User = { id: 3, githubLogin: 'bob', displayName: 'Bob', avatarUrl: null, isBot: false };
const USERS: User[] = [ME, ALICE, BOB];

// ── THE WORKSPACE COMES FIRST, AND THE WHOLE CONSOLE DEPENDS ON IT ─────────────────────────────
// A workspace is the app's ONLY scope. The store starts with `workspaceId: null` and NOTHING
// workspace-scoped renders or fetches until `GET /api/workspaces` lands and the sync effect fills
// it in (every scoped hook holds itself idle with `skipToken`). So this fixture is not decoration:
// without it Activity → Open PRs — the default landing view — and the Activity console stay empty and every
// spec in this directory fails with no useful message.
//
// One workspace, `isDefault: true`, owning the single repo. That mirrors a real fresh account:
// the Default workspace is auto-created server-side, is where new repos land, and is renameable
// but not deletable. The Compare-workspaces rail line is gated on `workspaces.length >= 2`, so a
// one-workspace fixture also keeps it correctly hidden.
const WORKSPACE: Workspace = {
  id: 1,
  name: 'Default',
  repoIds: [10],
  repoCount: 1,
  isDefault: true,
  createdAt: iso(60),
};

const WORKSPACES: WorkspacesResponse = { workspaces: [WORKSPACE] };

const REPO: Repo = {
  id: 10,
  owner: 'acme',
  name: 'web',
  fullName: 'acme/web',
  createdAt: iso(60),
  lastFullSyncAt: iso(1),
  lastIncrementalSyncAt: iso(0),
  lastSyncStatus: 'ok',
  lastSyncError: null,
  // A repo belongs to EXACTLY ONE workspace (`workspace_repos`, UNIQUE (account_id, repo_id)) and
  // the id is on the wire because it is the client's only repo→workspace mapping: surfaces
  // holding just a repoId (PR detail, ThreadList's bulk-resolve offer, a restored tab) must name
  // the PR's OWN workspace when they ask for a bot judgement, not the selected one.
  workspaceId: WORKSPACE.id,
};

// 5 open PRs in one repo by two authors. 101/102/103 are the My Turn inbox (awaiting
// my review); 104/105 are extra so the full board is strictly larger than the inbox.
function pr(
  id: number,
  number: number,
  authorId: number,
  title: string,
  openedDaysAgo: number,
): TimelinePr {
  return {
    id,
    repoId: REPO.id,
    number,
    // Size and review standing ride the lean timeline row (the large-PR flag and the reach chip
    // read the first three; the board's approval marks read the last two).
    additions: 12,
    deletions: 3,
    changedFiles: 2,
    isApproved: false,
    isChangesRequested: false,
    title,
    authorId,
    state: 'open',
    isDraft: false,
    isStalled: false,
    openedAt: iso(openedDaysAgo),
    firstReviewAt: null,
    lastCommitAt: iso(Math.max(0, openedDaysAgo - 1)),
    mergedAt: null,
    closedAt: null,
    updatedAt: iso(Math.max(0, openedDaysAgo - 1)),
    threadCounts: { resolved: 0, likely_addressed: 0, replied_unresolved: 0, untouched: 0 },
    ciStatus: 'success',
    mergeable: 'mergeable',
    mergeStateStatus: 'clean',
    labels: [],
    reasonTag: 'awaiting_your_review',
    reviewRequestedFromMe: true,
    newSinceLastViewed: null,
  };
}

const PRS: TimelinePr[] = [
  pr(101, 101, ALICE.id, 'Inbox: add login form', 5),
  pr(102, 102, ALICE.id, 'Inbox: fix auth race', 4),
  pr(103, 103, BOB.id, 'Inbox: tidy router', 3),
  pr(104, 104, BOB.id, 'Watched repo PR by bob', 2),
  pr(105, 105, ALICE.id, 'Other: docs pass', 1),
];
// The inbox spans MULTIPLE My Turn sections: 101-103 are "awaiting your review", 104 is a
// new PR in a WATCHED repo (a distinct inbox section). My Turn Focus Mode must show ALL of
// them — the watched-repo section was previously omitted from the focus board's id set, so
// an inbox containing a watched PR rendered it off the board (regression #54). 105 is in
// neither section, so the focus board (4) stays strictly smaller than the full board (5).
const AWAITING_IDS = [101, 102, 103];
const WATCHED_IDS = [104];
const INBOX_IDS = [...AWAITING_IDS, ...WATCHED_IDS];

// One lifecycle event per PR (drives the Feed/Activity; lifecycle events draw no
// timeline markers, which keeps the bar-count assertions clean).
const EVENTS: TimelineEvent[] = PRS.map((p, i) => ({
  id: 9000 + i,
  repoId: REPO.id,
  actorId: p.authorId,
  prId: p.id,
  type: 'pr_opened',
  occurredAt: p.openedAt,
  threadId: null,
  derivedState: null,
  refId: p.id,
  reviewState: null,
}));

// Two MARKER events (review / comment). Unlike the lifecycle pr_opened events these
// DRAW timeline markers, so a feed click on them opens the marker popover. 8001 is
// cross-person (ME reviewing ALICE's PR #101 → a feed click enters PR Focus); 8002 is
// own-work (BOB commenting on BOB's PR #103 → popover only, no focus). Dated older than
// the pr_opened feed items so the lifecycle `.first()` feed test stays unaffected.
const MARKER_EVENTS: TimelineEvent[] = [
  {
    id: 8001,
    repoId: REPO.id,
    actorId: ME.id, // cross-person: ME ≠ author ALICE
    prId: 101,
    type: 'review_submitted',
    occurredAt: iso(3),
    threadId: null,
    derivedState: null,
    refId: 5001,
    reviewState: 'commented',
  },
  {
    id: 8002,
    repoId: REPO.id,
    actorId: BOB.id, // own-work: BOB == author of #103
    prId: 103,
    type: 'pr_comment',
    occurredAt: iso(4),
    threadId: null,
    derivedState: null,
    refId: 6001,
    reviewState: null,
  },
];

const TIMELINE: TimelineResponse = { prs: PRS, events: [...EVENTS, ...MARKER_EVENTS] };
const OPEN_PRS: OpenPrsResponse = { prs: PRS };
// The Open PRs Claude Review strip's ONE batched read. Never requested while `ai.enabled` is false
// (below); typed and served so a spec that flips it gets the real shape, not the `{}` catch-all.
const CLAUDE_REVIEW_STATES: ClaudeReviewStatesResponse = { states: [] };
// The ticket review's two boot-time reads (the PR pane's Story check, the Open PRs stack pills).
// Both gate on `ai.enabled` like the strip above; typed so a spec that flips it gets real shapes.
const TICKET_REVIEW_STATES: TicketReviewStatesResponse = { states: [] };
const prTicketReviewsFor = (prId: number): PrTicketReviewsResponse => ({ prId, tickets: [] });
// The CI review's two boot-time reads (the PR pane's CI check, the Open PRs / Pending CI pill).
// Both gate on `ai.enabled` like the strip above; typed so a spec that flips it gets real shapes.
const CI_REVIEW_STATES: CiReviewStatesResponse = { states: [] };
const prCiReviewFor = (prId: number): PrCiReviewResponse => ({
  prId,
  review: null,
  state: {
    prId,
    status: 'none',
    staleBecause: null,
    latestRunId: null,
    runningRunId: null,
    headSha: null,
    counts: null,
    refused: null,
    checkedAt: null,
  },
});

const ME_RESPONSE: MeResponse = {
  user: {
    login: ME.githubLogin,
    githubId: 'MDQ6VXNlcjE=',
    avatarUrl: null,
    displayName: null,
  },
  // CORE/free surfaces that gate on their own top-level flag, all dark in these fixtures: the
  // severity badges need a severity-api, and the conflict resolver's six routes are local-only
  // and not exercised here. `blastRadius: null` = no account override, so the reach chip falls
  // back to its shipped thresholds.
  mlSeverity: false,
  conflictResolver: false,
  // The agentic AI surfaces (Claude Review, review chat, AI Fix) are FREE and local, but dark here
  // — the `LIMN_AI_DISABLED=true` state — so the Open PRs table issues no per-row Claude Review
  // states request and the Feed has no Claude pill. A spec exercising them flips `enabled` and
  // serves those routes itself.
  ai: {
    enabled: false,
    autoInstall: false,
    runtime: 'ready',
    runtimeMessage: null,
    auth: 'ok',
    authMessage: null,
    // Claude answers every run kind alike.
    kinds: aiKindsAll({ auth: 'ok', message: null }),
    provider: 'claude',
    providerSetting: { value: 'auto', source: 'settings' },
    effortSetting: { value: null, source: 'settings' },
    providers: {
      claude: { auth: 'ok', route: 'login', message: null, runtime: 'ready' },
      codex: {
        runtime: 'absent',
        runtimeMessage: null,
        auth: 'none',
        route: 'none',
        signedIn: false,
        plan: null,
        available: false,
        message: null,
        // Codex is not set up in these fixtures: every kind reads 'none'.
        kinds: aiKindsAll({ auth: 'none', message: 'Codex is not set up.' }),
      },
    },
  },
  largePrCodeLocThreshold: LARGE_PR_CODE_LOC_DEFAULT,
  largePrCodeLocThresholdIsDefault: true,
  blastRadius: null,
  // No My Turn overrides — the product defaults, resolved by the SPA through the shared resolver.
  myTurnSettings: null,
  authNotices: [],
};

// The workspace's bot listing — ONE `WorkspaceReviewer` row per actor, judgement + identity +
// price + evidence together. Empty here (the fixtures have no bots), but it must be a real
// `DetectedReviewersResponse` and not the catch-all `{}`: `useBotColors` and the feed's vendor tag
// read `reviewers`, and `reviewerListEmptyKind` reads `repoIds` to tell "this workspace has no
// repos" from "nothing detected yet".
const DETECTED_REVIEWERS: DetectedReviewersResponse = {
  workspaceId: WORKSPACE.id,
  reviewers: [],
  repoIds: [REPO.id],
  workspaceSeatCount: 0,
  generatedAt: iso(0),
};

// ---- Three account-wide reads App.tsx mounts UNCONDITIONALLY ---------------------------------
//
// The Workspace badge + welcome-back banner (daily-brief), the auto-merge banner's armed intents, and
// the global loading bar's full-mode walk feed. Every spec in this suite pays for all three, and
// ⚠ NONE of them may fall through to the catch-all `{}`: each consumer reads a field off the
// response that an empty object does not have — `counts.myTurnPersonal`, `requests.some`,
// `backfills.length`/`catchups.length` — and two of those live in a `refetchInterval`, which runs inside React's
// passive-effect commit. With no error boundary in the SPA the throw unmounts the WHOLE tree, so
// the symptom is not an error message: the Activity overlay paints, then the page goes blank a
// beat later and every locator times out.
//
// The brief is all zeros — nothing on the Activity console renders these counts now (the Feed's
// daily-brief strip was deleted), and zero keeps the banner quiet.
const DAILY_BRIEF: DailyBriefResponse = {
  workspaceId: WORKSPACE.id,
  counts: {
    myTurn: 0,
    stalled: 0,
    untouchedThreads: 0,
    needsReviewer: 0,
    resolveBacklog: 0,
    botAnomalies: [],
    trunkRed: [],
    // The Dependencies tab's security figure. Zero — the two Dependencies cards below sit on the
    // board, not in the brief.
    security: 0,
  },
  generatedAt: iso(0),
};

// ── DEFAULT-BRANCH STATUS ────────────────────────────────────────────────────────────────────────
// The Activity rail reads `/api/branch-status` at BOOT (its third line), so this was a boot-time
// route falling through to the untyped `{}`. One synced, green repo: the strip heading Activity →
// Open PRs renders (collapsed, "all green").
const BRANCH_STATUS: BranchStatusResponse = {
  repos: [
    {
      repoId: REPO.id,
      branchName: 'main',
      headSha: 'abc1234',
      ciStatus: 'success',
      lastCommitAt: iso(1),
      failingChecks: [],
      mergedPrs: [],
    },
  ],
};
// Defensive: an EXPANDED branch row reads `daily`, and a `{}` there would blank the page.
const BRANCH_TRENDS: BranchTrendsResponse = { repoId: REPO.id, daily: [] };

// ── THE PENDING BOARD ───────────────────────────────────────────────────────────────────────────
// Every Pending visit calls `GET /api/attention`. Left to the
// catch-all `{}`, the board would render off a response with no `cards` — a blank-page risk the
// moment any required field is read in render. Empty tabs are the honest fixture: the specs here
// are about the Feed, and an empty board is a state the board already renders.
// ⚠ The tabs come from `PENDING_TABS`, never a literal list, so a tab added to the shipped list
// appears here without an edit.
//
// Two cards sit in the Dependencies tab — a Dependabot security fix and a plain bump — so the
// fixture carries every REQUIRED field of the two newest kinds (`automation` included) and the
// board renders them the moment a spec opens that tab. My turn, where the app lands, stays empty.
const DEPENDABOT: User = {
  id: 4,
  githubLogin: 'dependabot[bot]',
  displayName: null,
  avatarUrl: null,
  isBot: true,
};

/** The PR half of a Dependencies card: every REQUIRED `InsightPrRef` field, Dependabot's byline. */
function dependabotPr(prId: number, number: number, title: string): InsightPrRef {
  return {
    prId,
    repoId: REPO.id,
    repoFullName: REPO.fullName,
    prNumber: number,
    prTitle: title,
    authorId: DEPENDABOT.id,
    githubUrl: `https://github.com/${REPO.fullName}/pull/${number}`,
    ciStatus: 'success',
    changedFiles: 1,
    additions: 3,
    deletions: 3,
    openedAt: iso(2),
    authorIsBot: true,
    authorBotKind: 'dependabot',
    automation: { role: 'dependency', kind: 'dependabot', source: 'account' },
    inMergeQueue: null,
    mergeQueueEntryState: null,
    reviewDecision: null,
    reviewApprovals: 0,
    reviewChangesRequested: false,
    reviewers: [],
    reviewerCount: 0,
  };
}

const SECURITY_CARD: SecurityCard = {
  ...dependabotPr(201, 81, 'Bump tornado from 6.4.1 to 6.5'),
  id: 'security:201',
  kind: 'security',
  severity: 'high',
  mergeStateStatus: 'clean',
  mergeable: 'mergeable',
  lastCommitAt: iso(2),
  relevance: 'maintained',
  viewerCanPush: true,
  dependencyUpdate: true,
  depState: 'ready',
  fix: 'proven',
  alerts: [],
  alertCount: 0,
  advisoryIds: ['GHSA-9qr9-h5gf-34mp'],
  detail: 'Fixes GHSA-9qr9-h5gf-34mp',
  stateDetail: 'Nothing is blocking this — it can land now',
};

const BUMP_CARD: DependencyBumpCard = {
  ...dependabotPr(202, 82, 'Bump eslint from 9.1.0 to 9.2.0'),
  id: 'deps:202',
  kind: 'dependency_bump',
  severity: 'info',
  mergeStateStatus: 'behind',
  mergeable: 'mergeable',
  lastCommitAt: iso(2),
  relevance: 'maintained',
  viewerCanPush: true,
  depState: 'behind',
  detail: 'GitHub blocks the merge until the branch is updated',
};

// Security before bumps — the Dependencies tab's strict group, as the server orders it.
const ATTENTION_CARDS: InsightCard[] = [SECURITY_CARD, BUMP_CARD];

/** A population split by who opened it — the server's own predicate, so the fixture's totals
 *  agree with its cards by construction (people + automation === total). */
function authorSplit(cards: InsightCard[]): PendingAuthorSplit {
  return {
    people: cards.filter((c) => pendingAuthorSideOf(c) === 'people').length,
    automation: cards.filter((c) => pendingAuthorSideOf(c) === 'automation').length,
  };
}

// The reader's My Turn settings, never changed: what `/api/my-turn` and `/api/attention` report.
const MY_TURN_DEFAULTS = resolveMyTurnSettings(null);

const ATTENTION: AttentionCardsResponse = {
  cards: ATTENTION_CARDS,
  users: [DEPENDABOT],
  tabs: PENDING_TABS.map((t): PendingTab => {
    const ranked: readonly InsightKind[] = t.kinds.filter((k) => k !== 'reviewer_load');
    const cards = ATTENTION_CARDS.filter((c) => pendingTabHolds(t, c));
    const ofKind = (k: InsightKind): InsightCard[] => cards.filter((c) => c.kind === k);
    return {
      key: t.key,
      total: cards.length,
      kindTotals: Object.fromEntries(ranked.map((k) => [k, ofKind(k).length])),
      cardIds: cards.map((c) => c.id),
      authorTotals: authorSplit(cards),
      kindAuthorTotals: Object.fromEntries(ranked.map((k) => [k, authorSplit(ofKind(k))])),
      ...(t.key === 'my_turn'
        ? {
            relevanceTotals: { mine: 0, others: 0 },
            relevanceAuthorTotals: { mine: authorSplit([]), others: authorSplit([]) },
          }
        : {}),
    };
  }),
  scores: {},
  // The ranking the server used — the product defaults, as a reader who never opened Settings
  // gets them.
  rules: {
    weights: MY_TURN_DEFAULTS.weights,
    preset: MY_TURN_DEFAULTS.preset,
    myTurnOrder: MY_TURN_DEFAULTS.order,
    myTurnOff: MY_TURN_DEFAULTS.off,
  },
};
// The board's batched liveness sweep (POST). Landing on Pending fires it on every spec's first
// paint; `changed: 0` means "nothing moved", so it never triggers a refetch loop. ⚠ NOT OPTIONAL:
// under the catch-all `{}`, the hook's `data.changed <= 0` guard reads `undefined <= 0` (false),
// and every sweep would refetch the three board keys.
const ATTENTION_LIVENESS: AttentionLivenessResponse = {
  workspaceId: WORKSPACE.id,
  checked: 0,
  mergeStateChecked: 0,
  changed: 0,
  leftOpenSet: 0,
  paused: null,
};

const ARMED_MERGES: ArmedMergeListResponse = { requests: [] };
// ⚠ BOTH ARRAYS, ALWAYS. GlobalLoadingBar reads `backfills.length` AND `catchups.length` (and
// spreads both), and it polls on a `refetchInterval` — see the blank-page note above.
const SYNC_ACTIVITY: SyncActivityResponse = {
  backfills: [],
  catchups: [],
  generatedAt: iso(0),
};

// This Sprint → "Merged so far" (GET /api/merged-prs, FREE). Served explicitly: the catch-all `{}`
// has no `window`, which the tab's header names. Nothing merged — the tab's own empty state.
const MERGED_PRS: MergedPrsResponse = {
  prs: [],
  workspaceId: WORKSPACE.id,
  window: { mode: 'rolling_14', from: iso(14), to: iso(0), end: iso(0), days: 14, elapsedDays: 14 },
  truncated: false,
};

// This Sprint (its own rail line) → the three lane boards (GET /api/sprint-graph). Typed so `pnpm typecheck` covers the shape, and
// served explicitly — the catch-all `{}` has no `nodes`/`read`, and the tab would blank. Two sprint
// tickets and one outside the sprint: ACME-2 depends on ACME-9 (a tracker link, on the stored critical
// path) and is built alongside ACME-1 (its brief); ACME-2 carries an open PR with failing CI.
const SPRINT_GRAPH: SprintGraphResponse = {
  workspaceId: WORKSPACE.id,
  trackerOn: true,
  changeToken: 'e2e0000000000001',
  provider: 'jira',
  source: { kind: 'sprint', provider: 'jira', names: ['Sprint 42'] },
  read: { readAt: iso(0.01), checkedAt: iso(0.01), error: null, truncated: false },
  aiEnabled: true,
  themes: null,
  // One stored critical path, through the ticket outside the sprint (the Critical path view's
  // "Outside the sprint" column).
  paths: {
    paths: [
      {
        title: 'Magic link waits on email',
        tickets: ['ACME-9', 'ACME-2'],
        idents: ['jira:https://acme.atlassian.net#ACME-9', 'jira:https://acme.atlassian.net#ACME-2'],
        advice: 'Finish the email service before the sign-in work.',
        risk: 'high',
      },
    ],
    callouts: [{ title: 'Nobody owns this', tickets: ['ACME-2'], idents: ['jira:https://acme.atlassian.net#ACME-2'] }],
    createdAt: iso(0.02),
  },
  pathsStatus: { state: 'current', stale: false, lastAttemptAt: iso(0.02), failure: null },
  pace: { daysElapsed: 4, daysTotal: 14, timeUsedPct: 29, tickets: 2, live: 2, done: 0, productReview: 0, codeMerged: 0, openDependencies: 1, chains: 1 },
  people: [{ name: 'Amy', names: ['Amy'], reviewsWaiting: null }],
  sprintDates: { startsAt: iso(3), endsAt: iso(-11), source: 'tracker' },
  signals: [],
  ghostsTruncated: false,
  briefs: { current: 2, pending: 1 },
  statusLayout: {
    order: [
      { name: 'To Do', category: 'new', count: 1, auto: true, stage: 'not_started', bucketId: 'not_started' },
      { name: 'In Progress', category: 'indeterminate', count: 1, auto: true, stage: 'in_progress', bucketId: 'in_progress' },
      { name: 'In Review', category: 'indeterminate', count: 0, auto: true, stage: 'in_review', bucketId: 'in_review' },
      { name: 'Done', category: 'done', count: 0, auto: true, stage: 'done', bucketId: 'done' },
    ],
    orderSource: 'jira_board',
    codingBegins: 'In Progress',
    codingEnds: 'In Review',
    evidence: [
      { status: 'In Progress', withPrs: 3, allMerged: 0 },
      { status: 'In Review', withPrs: 4, allMerged: 3 },
    ],
    buckets: [
      { id: 'not_started', name: 'Not started', meaning: 'not_started', statuses: [{ name: 'To Do', category: 'new', count: 1, auto: true, stage: 'not_started', bucketId: 'not_started' }] },
      { id: 'in_progress', name: 'In progress', meaning: 'in_progress', statuses: [{ name: 'In Progress', category: 'indeterminate', count: 1, auto: true, stage: 'in_progress', bucketId: 'in_progress' }] },
      { id: 'in_review', name: 'Code review', meaning: 'in_review', statuses: [{ name: 'In Review', category: 'indeterminate', count: 0, auto: true, stage: 'in_review', bucketId: 'in_review' }] },
      { id: 'product_review', name: 'Product review', meaning: 'product_review', statuses: [] },
      { id: 'done', name: 'Complete', meaning: 'done', statuses: [{ name: 'Done', category: 'done', count: 0, auto: true, stage: 'done', bucketId: 'done' }] },
    ],
    columns: [
      { id: 'not_started', name: 'Not started', meaning: 'not_started' },
      { id: 'in_progress', name: 'In progress', meaning: 'in_progress' },
      { id: 'in_review', name: 'Code review', meaning: 'in_review' },
      { id: 'product_review', name: 'Product review', meaning: 'product_review' },
      { id: 'done', name: 'Complete', meaning: 'done' },
    ],
    settings: { buckets: null, mergedColumn: true },
  },
  nodes: [
    {
      ident: 'jira:https://acme.atlassian.net#ACME-1',
      key: 'ACME-1',
      title: 'Export a report as CSV',
      url: 'https://acme.atlassian.net/browse/ACME-1',
      provider: 'jira',
      ghost: false,
      depth: 0,
      status: { name: 'To Do', category: 'new' },
      stage: 'not_started',
      bucketId: 'not_started',
      column: 'not_started',
      issueType: 'Story',
      assignee: { name: 'Amy', avatarUrl: null },
      epic: { key: 'ACME-100', title: 'Reports' },
      brief: { state: 'current', summary: 'Lets a manager download any report as a CSV file.', oneLiner: 'Download any report as CSV', criteriaCount: 3, criteriaDerived: true },
      check: null,
      checkRunning: false,
      prs: [],
      degree: 1,
      theme: null,
      // Not started, no pull request: the "needs code" judgement is asked about it.
      codeJudgement: { state: 'code', reason: 'Adds a CSV writer to the reports endpoint.' },
      // Not started, no pull request, no open build: the card offers "Implement" (story-build.spec.ts).
      build: null,
    },
    {
      ident: 'jira:https://acme.atlassian.net#ACME-2',
      key: 'ACME-2',
      title: 'Sign in with a magic link',
      url: 'https://acme.atlassian.net/browse/ACME-2',
      provider: 'jira',
      ghost: false,
      depth: 0,
      status: { name: 'In Progress', category: 'indeterminate' },
      stage: 'in_progress',
      bucketId: 'in_progress',
      column: 'in_progress',
      issueType: 'Story',
      assignee: null,
      epic: null,
      brief: { state: 'current', summary: 'Users sign in from a one-time link sent by email.', oneLiner: 'Sign in from an email link', criteriaCount: 2, criteriaDerived: false },
      check: { met: 1, partlyMet: 0, notMet: 1, unsettled: 0, total: 2, checkedAt: '2026-10-19T10:00:00.000Z', stale: false },
      checkRunning: false,
      prs: [
        {
          prId: PRS[0]!.id,
          number: PRS[0]!.number,
          repoFullName: REPO.fullName,
          title: PRS[0]!.title,
          state: 'open',
          draft: false,
          ciState: 'failure',
          url: `https://github.com/${REPO.fullName}/pull/${PRS[0]!.number}`,
          author: { login: 'ada', name: 'Ada Lovelace', isBot: false },
        },
      ],
      degree: 2,
      theme: null,
      codeJudgement: null,
    },
    {
      ident: 'jira:https://acme.atlassian.net#ACME-9',
      key: 'ACME-9',
      title: 'Email sending service',
      url: 'https://acme.atlassian.net/browse/ACME-9',
      provider: 'jira',
      ghost: true,
      depth: 1,
      status: { name: 'In Progress', category: 'indeterminate' },
      stage: 'in_progress',
      bucketId: 'in_progress',
      column: 'in_progress',
      issueType: 'Story',
      assignee: { name: 'Ben', avatarUrl: null },
      epic: null,
      brief: { state: 'pending', summary: null, oneLiner: null, criteriaCount: 0, criteriaDerived: false },
      check: null,
      checkRunning: false,
      prs: [],
      degree: 1,
      theme: null,
      codeJudgement: null,
    },
  ],
  edges: [
    { from: 'jira:https://acme.atlassian.net#ACME-2', to: 'jira:https://acme.atlassian.net#ACME-9', kind: 'depends_on', source: 'tracker', quote: null },
    { from: 'jira:https://acme.atlassian.net#ACME-2', to: 'jira:https://acme.atlassian.net#ACME-1', kind: 'concurrent', source: 'text', quote: 'built together with ACME-1' },
  ],
};

// "Implement story" (docs/STORY-BUILD.md): ACME-1's build session, in the states story-build.spec.ts
// walks — none → plan_ready (Start) → building → ready (Accept) → one repository pushed (Push). Typed
// so `pnpm typecheck` covers the wire shape. The route below keeps the state per page.
const ACME_1 = 'jira:https://acme.atlassian.net#ACME-1';

function storyBuildRepo(repoId: number, fullName: string, order: number, o: Partial<StoryBuildRepo> = {}): StoryBuildRepo {
  return {
    id: 900 + repoId,
    repoId,
    fullName,
    ref: `R${order + 1}`,
    include: true,
    status: 'planned',
    order,
    baseRef: 'main',
    baseSha: 'b'.repeat(40),
    stackedOnPrId: null,
    baseNote: null,
    branch: null,
    summary: null,
    commitMessage: null,
    filesChanged: [],
    changeReport: null,
    checksWanted: [],
    checks: null,
    hasPatch: false,
    prTitle: null,
    pushedBranch: null,
    pushedPrNumber: null,
    pushedPrUrl: null,
    pushedCommitSha: null,
    pushedAt: null,
    pushError: null,
    provider: 'claude',
    model: null,
    effort: null,
    costUsd: null,
    numTurns: null,
    error: null,
    startedAt: null,
    completedAt: null,
    ...o,
  };
}

export const STORY_BUILD_PLAN_READY: StoryBuild = {
  id: 41,
  workspaceId: WORKSPACE.id,
  ident: ACME_1,
  ticketKey: 'ACME-1',
  ticketTitle: 'Export a report as CSV',
  status: 'plan_ready',
  phase: null,
  error: null,
  provider: 'claude',
  model: 'claude-opus-5-5',
  effort: null,
  wantDiagram: false,
  wantDocs: false,
  criteriaSource: 'brief',
  coverage: {
    state: 'none',
    ticketReviewId: null,
    checkedAt: null,
    criteria: [
      { ref: 'AC1', text: 'Every report has a Download CSV button.', verdict: 'not_checked', coveredByPrIds: [] },
      { ref: 'AC2', text: 'The file opens in a spreadsheet with one header row.', verdict: 'not_checked', coveredByPrIds: [] },
      { ref: 'AC3', text: 'Large reports stream instead of timing out.', verdict: 'not_checked', coveredByPrIds: [] },
    ],
    missing: [],
    existingPrs: [],
    note: null,
  },
  candidates: [
    { ref: 'R1', repoId: 11, fullName: 'acme/api', source: 'picked', baseRef: 'main', baseSha: 'b'.repeat(40), stackedOnPrId: null, stackedOnPrNumber: null, baseNote: null },
    { ref: 'R2', repoId: 10, fullName: 'acme/web', source: 'picked', baseRef: 'main', baseSha: 'c'.repeat(40), stackedOnPrId: null, stackedOnPrNumber: null, baseNote: null },
  ],
  plan: {
    revision: 1,
    summary: 'The API gets a CSV endpoint that streams each report. The web app adds a Download CSV button to every report page.',
    repos: [
      {
        ref: 'R1',
        repoId: 11,
        why: 'The reports endpoint lives here.',
        branchSlug: 'reports-csv-endpoint',
        steps: [
          { title: 'Stream a report as CSV', files: ['src/reports/csv.ts'], change: 'Write rows as they are read, with one header row.', refs: ['AC2', 'AC3'] },
        ],
        tests: ['A 10,000-row report streams without buffering.'],
      },
      {
        ref: 'R2',
        repoId: 10,
        why: 'The report pages live here.',
        branchSlug: 'download-csv-button',
        steps: [{ title: 'Add the Download CSV button', files: ['src/reports/ReportHeader.tsx'], change: 'A button that links to the new endpoint.', refs: ['AC1'] }],
        tests: [],
      },
    ],
    readOnlyRepos: [],
    criteria: [
      { ref: 'AC1', how: 'planned', repo: 'R2', reason: null },
      { ref: 'AC2', how: 'planned', repo: 'R1', reason: null },
      { ref: 'AC3', how: 'planned', repo: 'R1', reason: null },
    ],
    risks: ['A report over a million rows may still take minutes to download.'],
  },
  planRevision: 1,
  transcript: [],
  design: null,
  docsStatus: 'none',
  docsError: null,
  docs: null,
  docsDecisions: {},
  acceptedRevision: null,
  acceptedDocs: null,
  repos: [
    storyBuildRepo(11, 'acme/api', 0, { branch: 'ACME-1-reports-csv-endpoint' }),
    storyBuildRepo(10, 'acme/web', 1, { branch: 'ACME-1-download-csv-button' }),
  ],
  planCostUsd: 1.2,
  docsCostUsd: null,
  totalCostUsd: 1.2,
  sessionBudgetUsd: 30,
  pushedAll: false,
  createdAt: iso(0.01),
  startedAt: iso(0.01),
  completedAt: null,
};

/** The same session once both repositories are built (Accept). */
export const STORY_BUILD_READY: StoryBuild = {
  ...STORY_BUILD_PLAN_READY,
  status: 'ready',
  acceptedRevision: 1,
  acceptedDocs: {},
  totalCostUsd: 6.4,
  repos: STORY_BUILD_PLAN_READY.repos.map((r) => ({
    ...r,
    status: 'ready',
    hasPatch: true,
    model: 'claude-opus-5-5',
    costUsd: 2.6,
    filesChanged: r.repoId === 11 ? ['src/reports/csv.ts'] : ['src/reports/ReportHeader.tsx'],
    summary: r.repoId === 11 ? 'Adds GET /reports/:id.csv, streamed.' : 'Adds the Download CSV button.',
    changeReport: {
      changes: [
        r.repoId === 11
          ? { path: 'src/reports/csv.ts', summary: 'Streams the rows with one header row.', refs: ['AC2', 'AC3'] }
          : { path: 'src/reports/ReportHeader.tsx', summary: 'The button links to the endpoint.', refs: ['AC1'] },
      ],
      unaddressed: [],
      notReported: [],
    },
    completedAt: iso(0.005),
  })),
};

const STORY_BUILD_DIFF: StoryBuildDiffResponse = {
  repoId: 11,
  baseSha: 'b'.repeat(40),
  patch: [
    'diff --git a/src/reports/csv.ts b/src/reports/csv.ts',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/src/reports/csv.ts',
    '@@ -0,0 +1,3 @@',
    '+export function csvHeader(cols: string[]): string {',
    "+  return cols.join(',');",
    '+}',
    '',
  ].join('\n'),
  filesChanged: ['src/reports/csv.ts'],
};

const STORY_BUILD_CHECKS: StoryBuildChecksPreview = {
  sandbox: 'seatbelt',
  unavailable: null,
  unsandboxed: false,
  checks: [{ name: 'test', kind: 'test', command: 'pnpm test', source: 'package.json script "test"', defaultOn: true, needsDocker: false, refused: null }],
};

function myTurnPr(id: number): MyTurnPr {
  const p = PRS.find((x) => x.id === id)!;
  return {
    prId: p.id,
    repoFullName: REPO.fullName,
    number: p.number,
    title: p.title,
    authorId: p.authorId,
    state: p.state,
    openedAt: p.openedAt,
    githubUrl: `https://github.com/${REPO.fullName}/pull/${p.number}`,
  };
}

const MY_TURN: MyTurnResponse = {
  awaitingReview: AWAITING_IDS.map((id): AwaitingReviewItem => ({
    ...myTurnPr(id),
    alsoRequested: 0,
  })),
  yourPrs: [],
  approvedPrs: [],
  threadsAwaiting: [],
  // New open PRs by others in your Watched repos — a separate inbox section that My Turn
  // Focus Mode must also show on the board (regression #54).
  watchedRepoPrs: WATCHED_IDS.map((id): WatchedRepoPrItem => myTurnPr(id)),
  claudeReviewsToAction: [],
  users: USERS,
  // The sections Settings → My Turn added, empty here, and the reader's resolved settings. The
  // three settings fields come FROM the shared resolver, so the fixture cannot drift from it.
  mentions: [],
  threadReplies: [],
  commentReplies: [],
  pushedSince: [],
  ownCiRed: [],
  ownConflicts: [],
  ownReady: [],
  ownThreads: [],
  redTrunks: [],
  order: MY_TURN_DEFAULTS.order,
  off: MY_TURN_DEFAULTS.off,
  configKey: MY_TURN_DEFAULTS.configKey,
};


// The Inbox aggregate (the rail) — one watched repo with the 5 open PRs.
const ACTIVITY: ActivityResponse = {
  repos: [
    {
      repoId: REPO.id,
      repoFullName: REPO.fullName,
      stats: {
        openPrs: PRS.length,
        draftPrs: 0,
        mergedLast7d: 0,
        stalledPrs: 0,
        botThreads: 0,
        botThreadsActedOn: 0,
        medianHoursToFirstReview: null,
        oldestUnreviewed: null,
      },
      threadTotals: { resolved: 0, likely_addressed: 0, replied_unresolved: 0, untouched: 1 },
      maintainerIds: [],
      attentionCount: 1,
      hasUnread: false,
      prs: PRS,
    },
  ],
  generatedAt: iso(0),
};

// The consolidated Feed (the Activity "Feed" entry): a flat, newest-first stream of real
// activity events, each flagged isMyTurn by participation. Covers the click paths (any item
// → the PR detail tab), a My-Turn review_comment on a thread you started (#101, yellow
// card + inline thread), and plain non-My-Turn activity events (#105).
const CONSOLIDATED_FEED: ConsolidatedFeedResponse = {
  items: [
    {
      id: 'feed:6001',
      isMyTurn: true,
      myTurnReasons: ['authored'],
      commentId: null,
      kind: 'review_comment',
      occurredAt: iso(1),
      repoId: REPO.id,
      repoFullName: REPO.fullName,
      prId: 101,
      prNumber: 101,
      prTitle: 'Activity: fix auth race',
      prState: 'open',
      actorId: BOB.id,
      content: 'Can you take another look at this?',
      threadId: 5001,
      path: 'src/login.ts',
      line: 10,
      reasonTag: 'your_pr_new_comments',
      reviewState: null,
      githubUrl: `https://github.com/${REPO.fullName}/pull/101`,
      mergedById: null,
      reviewers: null,
      ciStatus: null,
      changedFilesCount: null,
      affectedThreads: null,
      commitCount: null,
      changeSummary: null,
      mergedComments: [],
    },
    {
      id: 'feed:7000',
      isMyTurn: false,
      myTurnReasons: [],
      commentId: null,
      kind: 'pr_opened',
      occurredAt: iso(4),
      repoId: REPO.id,
      repoFullName: REPO.fullName,
      prId: 105,
      prNumber: 105,
      prTitle: 'Other: docs pass',
      prState: 'open',
      actorId: ALICE.id,
      content: null,
      threadId: null,
      path: null,
      line: null,
      reasonTag: null,
      reviewState: null,
      githubUrl: `https://github.com/${REPO.fullName}/pull/105`,
      mergedById: null,
      reviewers: null,
      ciStatus: null,
      changedFilesCount: null,
      affectedThreads: null,
      commitCount: null,
      changeSummary: null,
      mergedComments: [],
    },
    {
      id: 'feed:7001',
      isMyTurn: false,
      myTurnReasons: [],
      commentId: null,
      kind: 'pr_merged',
      occurredAt: iso(5),
      repoId: REPO.id,
      repoFullName: REPO.fullName,
      prId: 105,
      prNumber: 105,
      prTitle: 'Other: docs pass',
      prState: 'merged',
      actorId: ALICE.id,
      content: null,
      threadId: null,
      path: null,
      line: null,
      reasonTag: null,
      reviewState: null,
      githubUrl: `https://github.com/${REPO.fullName}/pull/105`,
      mergedById: ALICE.id,
      reviewers: null,
      ciStatus: null,
      changedFilesCount: null,
      affectedThreads: null,
      commitCount: null,
      changeSummary: null,
      mergedComments: [],
    },
  ] satisfies ConsolidatedFeedItem[],
  users: USERS,
  total: 3, // all mock items fit in one page (< FEED_PAGE_SIZE) → no "Load more"
  generatedAt: iso(0),
};

// The thread behind the #101 review_comment feed card. The Activity feed now renders
// review-thread cards inline (full ThreadCard), so it fetches /api/threads/:id — this
// fixture carries the comment the feed card represents so the conversation (and the
// error-boundary-less app) renders.
const THREAD_5001: ThreadDetail = {
  id: 5001,
  prId: 101,
  path: 'src/login.ts',
  line: 10,
  isResolved: false,
  isOutdated: false,
  derivedState: 'replied_unresolved',
  addressedConfidence: 'low',
  addressedReason: null,
  originalCommenterId: BOB.id,
  createdAt: iso(1),
  comments: [
    {
      id: 9001,
      authorId: BOB.id,
      body: 'Can you take another look at this?',
      diffHunk: null,
      createdAt: iso(1),
      url: null,
    },
  ],
  url: null,
  // Not a finding Limn posted (only GET /api/prs/:id ever sets it).
  limnSeverity: null,
};

// A complete-but-empty PR detail so opening a PR never crashes the (error-boundary-less)
// app. Self-contained: PrDetail renders from this object's own users/labels/etc.
export function prDetailFor(id: number): PrDetail {
  const p = PRS.find((x) => x.id === id) ?? PRS[0]!;
  return {
    id,
    repoId: REPO.id,
    repoFullName: REPO.fullName,
    number: p.number,
    title: p.title,
    body: 'Fixture PR body.',
    authorId: p.authorId,
    state: p.state,
    isDraft: false,
    isStalled: false,
    openedAt: p.openedAt,
    firstReviewAt: null,
    lastCommitAt: p.lastCommitAt,
    mergedAt: null,
    mergedById: null,
    closedAt: null,
    updatedAt: p.updatedAt,
    githubUrl: `https://github.com/${REPO.fullName}/pull/${p.number}`,
    headSha: 'deadbeef',
    ciStatus: 'success',
    mergeable: 'mergeable',
    mergeStateStatus: 'clean',
    labels: [],
    checkRuns: [],
    additions: 1,
    deletions: 0,
    changedFilesCount: 1,
    files: [],
    requestedReviewers: [],
    // Review standing rides the detail payload (and the Pending cards) — `reviewStandings` and
    // `tickets` are mapped over unguarded, so an omission here blanks the whole SPA rather than
    // one tab.
    reviewDecision: null,
    reviewStandings: [],
    reviewerCount: 0,
    tickets: [],
    headRefName: 'feature/e2e-branch',
    baseRefName: 'main',
    inMergeQueue: null,
    mergeQueueEntryState: null,
    viewerCanApprove: false,
    viewerCanPush: false,
    viewerCanClose: false,
    viewerCanReopen: false,
    viewerHasApprovedStanding: false,
    viewerReviewStanding: null,
    threads: [],
    reviews: [],
    comments: [],
    commits: [],
    users: USERS,
    lastViewedAt: null,
    newSinceLastViewed: null,
  };
}

function json(route: Route, body: unknown): Promise<void> {
  return route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

// Register the interceptor. Matches ONLY real API calls — pathname starting with
// `/api/` — via a URL predicate, NOT a `**/api/**` glob: in dev, Vite serves source
// modules under paths like `/app/src/api/client.ts` that a glob would wrongly capture
// (returning JSON for a JS module breaks the app boot). Matched by pathname, so the
// member-filtered timeline, the search timeline, etc. all resolve to the same fixture.
//
// ⚠ MATCHING IGNORES THE QUERY STRING, AND THAT IS DELIBERATE UNDER WORKSPACES. Every scoped
// route now carries `?workspace=<id>` (plus an optional `repoIds` narrowing WITHIN it), and the
// SPA emits it on `/api/timeline`, `/api/open-prs`, `/api/activity`, `/api/activity/feed`,
// `/api/branch-status`, `/api/bot-*` and the metric routes. There is exactly one workspace in
// these fixtures, so one response per pathname is the right answer for every scope the app can
// ask for — and matching on the pathname keeps it that way whether or not a given surface has
// resolved its workspace yet. If a spec ever needs two workspaces to differ, read
// `new URL(route.request().url()).searchParams.get('workspace')` here and branch on it.
// Settings → AI → Disk space (GET /api/storage/clones): two repositories cloned, no checkouts left.
const CLONE_STORAGE: CloneStorageResponse = {
  cloneBytes: 412 * 1024 * 1024,
  checkouts: 0,
  checkoutBytes: 0,
  freedBytes30d: 1.6 * 1024 ** 3,
  lastSweepAt: null,
};
// The Claude spend budget (GET /api/ai/budget): never set, so off with the shipped defaults. Read
// only while `me.ai.enabled` (dark above), but served so a spec that flips AI on gets a real shape
// rather than the catch-all `{}` (the header toast and every Run button read it).
const AI_BUDGET: AiBudgetResponse = {
  settings: {
    enabled: false,
    weekSharePct: AI_BUDGET_DEFAULTS.weekSharePct,
    // Follows the weekly share.
    fiveHourSharePct: null,
    subscription: null,
    // The login route: a subscription carries no US$ on the wire.
    weeklyUsd: null,
  },
  isDefault: true,
  status: {
    enabled: false,
    mode: 'off',
    route: 'login',
    subscription: null,
    apiKey: null,
    overBudget: false,
    limitedBy: null,
    reason: null,
    resumesAt: null,
  },
  // The header's usage item: no reading taken and no runs yet — every unknown piece absent.
  usage: {
    route: 'login',
    account: {
      reportedSubscription: null,
      subscription: null,
      fiveHour: null,
      week: null,
      models: [],
      observedAt: null,
    },
    limn: {
      weekFrom: '2026-10-18T00:00:00.000Z',
      window: 'rolling',
      weekResetsAt: null,
      fiveHourFrom: '2026-10-25T07:00:00.000Z',
      fiveHourWindow: 'rolling',
      fiveHourResetsAt: null,
      runs: 0,
      inputTokens: null,
      outputTokens: null,
      weekSharePct: null,
      fiveHourSharePct: null,
    },
    apiKey: null,
    weekPctPerUsd: null,
  },
  // No other provider signed in or run this week.
  others: [],
};

export async function installMockApi(page: Page): Promise<void> {
  // "Implement story": ACME-1's session, advanced by the writes below (one per page).
  let storyBuild: StoryBuild | null = null;
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const path = new URL(route.request().url()).pathname;
      const method = route.request().method();

      if (path.startsWith(STORY_BUILD_API.list)) {
        if (path === STORY_BUILD_API.list && method === 'GET') {
          return json(route, { workspaceId: WORKSPACE.id, build: storyBuild, earlier: [] } satisfies StoryBuildForTicketResponse);
        }
        if (path === STORY_BUILD_API.list && method === 'POST') {
          storyBuild = STORY_BUILD_PLAN_READY;
          return route.fulfill({
            status: 202,
            contentType: 'application/json',
            body: JSON.stringify({ outcome: 'started', buildId: STORY_BUILD_PLAN_READY.id } satisfies StoryBuildStartResponse),
          });
        }
        if (path.endsWith('/accept')) {
          storyBuild = STORY_BUILD_READY;
          return json(route, { status: 'building' });
        }
        if (/\/repos\/\d+\/push$/.test(path)) {
          const repoId = Number(path.split('/').at(-2));
          const prNumber = 77;
          if (storyBuild != null) {
            const repos = storyBuild.repos.map((r) =>
              r.repoId === repoId
                ? { ...r, status: 'pushed' as const, pushedPrNumber: prNumber, pushedPrUrl: `https://github.com/${r.fullName}/pull/${prNumber}`, pushedAt: iso(0) }
                : r,
            );
            storyBuild = { ...storyBuild, repos, pushedAll: repos.filter((r) => r.include).every((r) => r.status === 'pushed') };
          }
          return json(route, {
            results: [{ repoId, outcome: 'pushed', prNumber, prUrl: `https://github.com/acme/api/pull/${prNumber}`, code: null, error: null }],
          } satisfies StoryBuildPushResponse);
        }
        if (/\/repos\/\d+\/diff$/.test(path)) return json(route, STORY_BUILD_DIFF);
        if (/\/repos\/\d+\/checks$/.test(path)) return json(route, STORY_BUILD_CHECKS);
        if (path.endsWith('/stream')) return route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' });
        if (path.endsWith('/discard')) {
          storyBuild = storyBuild != null ? { ...storyBuild, status: 'discarded' } : null;
          return json(route, { status: 'discarded' });
        }
        if (/\/api\/story-builds\/\d+$/.test(path)) return json(route, storyBuild ?? STORY_BUILD_PLAN_READY);
        return json(route, { status: 'ok' });
      }
      const prDetailMatch = path.match(/\/api\/prs\/(\d+)$/);

      // Inline review-thread card fetch (Activity feed) + the @mention roster the
      // reply/comment composers pull. Must precede the catch-all so ThreadCard gets a
      // real ThreadDetail (a bare `{}` would crash `thread.comments.map`).
      if (path.match(/\/api\/threads\/\d+$/)) return json(route, THREAD_5001);
      if (path.match(/\/api\/prs\/\d+\/mention-candidates$/)) return json(route, USERS);
      // Suggested reviewers — its own live query now; empty is fine for the fixtures.
      if (path.match(/\/api\/prs\/\d+\/suggested-reviewers$/))
        return json(route, { suggestedReviewers: [], users: [] });

      if (path.endsWith('/api/me')) return json(route, ME_RESPONSE);
      if (path.endsWith('/api/ai/budget')) return json(route, AI_BUDGET);
      if (path.endsWith('/api/storage/clones')) return json(route, CLONE_STORAGE);
      // The one-time AI runtime download streams `AiRuntimeInstallEvent` SSE frames; one `done`
      // frame is a complete, successful install.
      if (path.endsWith('/api/ai/runtime/install'))
        return route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          body: 'data: {"type":"done","runtime":"ready"}\n\n',
        });
      // ⚠ MUST BE SERVED, not left to the catch-all. `workspaceId` starts null in the store and
      // every workspace-scoped query holds itself idle until this response resolves it — a `{}`
      // here leaves Activity → Open PRs (the default landing view) permanently blank.
      if (path.endsWith('/api/workspaces')) return json(route, WORKSPACES);
      // The workspace's bot listing. Shape matters even while empty: consumers read `.reviewers`
      // and `.repoIds` off it.
      if (path.endsWith('/api/bot-reviewers')) return json(route, DETECTED_REVIEWERS);
      if (path.endsWith('/api/daily-brief')) return json(route, DAILY_BRIEF);
      if (path.endsWith('/api/branch-status')) return json(route, BRANCH_STATUS);
      if (path.endsWith('/api/branch-trends')) return json(route, BRANCH_TRENDS);
      if (path.endsWith('/api/auto-merge')) return json(route, ARMED_MERGES);
      if (path.endsWith('/api/sync-activity')) return json(route, SYNC_ACTIVITY);
      if (path.endsWith('/api/my-turn')) return json(route, MY_TURN);
      // The Pending board and its liveness sweep (a POST on its own path).
      if (path.endsWith('/api/attention/liveness')) return json(route, ATTENTION_LIVENESS);
      if (path.endsWith('/api/attention')) return json(route, ATTENTION);
      if (path.endsWith('/api/activity/feed')) return json(route, CONSOLIDATED_FEED);
      if (path.endsWith('/api/activity')) return json(route, ACTIVITY);
      if (path.includes('/api/timeline')) return json(route, TIMELINE);
      if (path.includes('/api/open-prs')) return json(route, OPEN_PRS);
      if (path.endsWith('/api/claude-review/states')) return json(route, CLAUDE_REVIEW_STATES);
      // The thread cards' Claude marker (one batched POST per screen): no judged run here.
      if (path.endsWith('/api/claude-review/thread-judgements'))
        return json(route, { prs: [] } satisfies ClaudeThreadJudgementsResponse);
      // The Changes tab's Check threads status (PR detail): never run here.
      const threadCheckMatch = path.match(/\/api\/prs\/(\d+)\/claude-review\/thread-check$/);
      if (threadCheckMatch && route.request().method() === 'GET')
        return json(route, {
          prId: Number(threadCheckMatch[1]),
          check: null,
          progress: null,
        } satisfies ThreadCheckStatusResponse);
      if (path.endsWith('/api/ticket-reviews/states')) return json(route, TICKET_REVIEW_STATES);
      const ticketReviewsMatch = path.match(/\/api\/prs\/(\d+)\/ticket-reviews$/);
      if (ticketReviewsMatch) return json(route, prTicketReviewsFor(Number(ticketReviewsMatch[1])));
      if (path.endsWith('/api/ci-reviews/states')) return json(route, CI_REVIEW_STATES);
      const ciReviewMatch = path.match(/\/api\/prs\/(\d+)\/ci-review$/);
      if (ciReviewMatch) return json(route, prCiReviewFor(Number(ciReviewMatch[1])));
      if (path.endsWith('/api/users')) return json(route, USERS);
      if (path.endsWith('/api/repos')) return json(route, [REPO]);
      if (path.endsWith('/api/mergers')) return json(route, []);
      // THE ISSUE TRACKER (core, free — apiVersion 23). No tracker in e2e: the workspace answers
      // "none", so the Open PRs board is the plain list and no ticket row is requested. Typed, so a
      // spec that configures one gets the real shapes rather than the untyped catch-all `{}`.
      if (/\/api\/workspaces\/\d+\/tracker$/.test(path)) {
        return json(route, {
          workspaceId: WORKSPACE.id,
          issue: { provider: null, baseUrl: null, projectKeys: [], matchScope: 'title_branch' },
          jira: { email: null, hasToken: false },
          providerChosen: false,
          githubIssuesRepos: [],
        } satisfies WorkspaceTrackerSettings);
      }
      // SONARCLOUD (core, free; docs/SONARCLOUD.md). Not set up in e2e: the settings answer "no
      // organization, no token", and a PR's stored read answers "not configured, nothing stored" —
      // so the review tab's SonarCloud section stays absent.
      if (/\/api\/workspaces\/\d+\/sonar$/.test(path)) {
        return json(route, {
          workspaceId: WORKSPACE.id,
          organization: null,
          hasToken: false,
          tokenUnreadable: false,
          repos: [],
        } satisfies WorkspaceSonarSettings);
      }
      const sonarMatch = path.match(/\/api\/prs\/(\d+)\/sonar$/);
      if (sonarMatch) {
        return json(route, { prId: Number(sonarMatch[1]), configured: false, snapshot: null } satisfies SonarPrResponse);
      }
      // DESIGN DIAGRAMS (core, local-only; docs/CLAUDE-REVIEW.md § Design diagrams; the paths keep
      // "sequence-diagrams"). `ai.enabled` is false here, so nothing renders them; the PR read answers
      // ONE succeeded design (the real wire shape, typed) and no stories, the ticket read an empty slot.
      const diagramsMatch = path.match(/\/api\/prs\/(\d+)\/sequence-diagrams$/);
      if (diagramsMatch) {
        const prId = Number(diagramsMatch[1]);
        return json(route, {
          prId,
          pr: {
            diagram: {
              id: 1,
              kind: 'pr',
              prId,
              ticketIdent: null,
              ticketKey: null,
              status: 'succeeded',
              trigger: 'review',
              title: 'Rate import',
              caption: 'Rows are checked, then each rate is stored once.',
              design: {
                acts: [
                  { id: 'imp', title: 'Import' },
                  { id: 'save', title: 'Save' },
                ],
                layers: ['domain', 'data'],
                cells: [
                  { id: 'c1', act: 'imp', layer: 'domain', label: 'Reject rows with no account', pattern: 'Guard clause', change: 'new', pr: null, files: ['src/import.ts'] },
                  { id: 'c2', act: 'save', layer: 'data', label: 'Store each rate once', pattern: 'Repository', change: 'changed', pr: null, files: [] },
                ],
                arrows: [{ from: 'c1', to: 'c2', label: 'valid rows' }],
              },
              headSha: 'a'.repeat(40),
              members: [],
              refusal: null,
              error: null,
              current: true,
              createdAt: '2026-10-17T00:00:00.000Z',
              completedAt: '2026-10-17T00:01:00.000Z',
              costUsd: 0.4,
            },
            latest: null,
          },
          stories: [],
        } satisfies PrSequenceDiagramsResponse);
      }
      if (path.endsWith('/api/sequence-diagrams/story')) {
        return json(route, {
          ident: new URL(route.request().url()).searchParams.get('ident') ?? '',
          ticketKey: null,
          memberCount: 0,
          diagram: null,
          latest: null,
        } satisfies TicketSequenceDiagramResponse);
      }
      // The Story section's docs check (asked only from the story view's Story section).
      if (path.endsWith('/api/docs/story-alignment') && route.request().method() === 'GET') {
        return json(route, {
          workspaceId: WORKSPACE.id,
          ident: new URL(route.request().url()).searchParams.get('ident') ?? '',
          available: false,
          docCount: 0,
          run: null,
          lastSucceeded: null,
        } satisfies StoryDocsAlignmentResponse);
      }
      // REFERENCE DOCS (core, local-only; docs/REFERENCE-DOCS.md). `ai.enabled` is false here, so the
      // Docs rail line and its Settings switch are absent — these answer an EMPTY library for a spec
      // that flips it on, with the real shapes rather than the untyped catch-all `{}`.
      if (path.endsWith('/api/docs')) {
        return json(route, {
          workspaceId: WORKSPACE.id,
          docs: [],
          docsInReview: false,
          maxBytes: 25 * 1024 * 1024,
        } satisfies ReferenceDocsResponse);
      }
      if (path.endsWith('/api/docs/tree')) {
        return json(route, {
          workspaceId: WORKSPACE.id,
          index: '# Reference library\n\nNo documents yet.\n',
          doc: null,
          contents: null,
          sections: [],
        } satisfies ReferenceDocTreeResponse);
      }
      if (path.endsWith('/api/docs/section')) {
        return json(route, {
          workspaceId: WORKSPACE.id,
          path: 'INDEX.md',
          docId: null,
          docSlug: null,
          docTitle: null,
          title: 'Reference library',
          markdown: '# Reference library\n\nNo documents yet.\n',
          prev: null,
          next: null,
        } satisfies ReferenceDocSectionResponse);
      }
      if (path.endsWith('/api/docs/chats')) {
        return json(route, { workspaceId: WORKSPACE.id, conversations: [] } satisfies ReferenceDocsConversationsResponse);
      }
      // Settings → Auto Claude review (mounted only while AI is on). Every switch at its default:
      // auto review, auto fix and auto-posting off; design diagrams after each review ON.
      if (/\/api\/workspaces\/\d+\/auto-review$/.test(path)) {
        return json(route, {
          workspaceId: WORKSPACE.id,
          autoReview: {
            enabled: false,
            enabledAt: null,
            dailyCap: 20,
            autoFixEnabled: false,
            autoDiagramsEnabled: true,
            teamClaimsEnabled: false,
            autoReviewProviders: 'default',
            pairStrictness: 'strict',
            autoFix: {
              include: {
                findings: true,
                earlierFindings: true,
                judgedThreads: true,
                untouchedThreads: true,
                ciFailures: true,
                sonar: true,
                styleBots: false,
              },
              autoPush: false,
            },
            autoPost: {
              enabled: false,
              scope: 'mine',
              kinds: {
                blockers: true,
                warnings: true,
                nits: false,
                questions: true,
                ciFailures: true,
                storyGaps: true,
                sonar: true,
                notAskedFor: false,
              },
              autoVerdict: false,
              autoResolve: false,
              approveImpact: { high: true, medium: true, low: true },
              approveLeftovers: 'nits_questions',
            },
          },
        } satisfies WorkspaceAutoReviewResponse);
      }
      if (/\/api\/workspaces\/\d+\/docs-settings$/.test(path)) {
        return json(route, { workspaceId: WORKSPACE.id, docsInReview: false } satisfies ReferenceDocsSettings);
      }
      // Settings → Confluence + Notion (reference docs' wiki sources; mounted only while AI is on): nothing saved.
      if (/\/api\/workspaces\/\d+\/wiki-credentials$/.test(path)) {
        return json(route, {
          workspaceId: WORKSPACE.id,
          confluence: { siteUrl: null, email: null, hasToken: false, jiraSite: null },
          notion: { hasToken: false },
        } satisfies WikiCredentialsSettings);
      }
      if (path.endsWith('/api/ticket-links')) {
        return json(route, { prs: [], titlesComplete: true } satisfies TicketLinksResponse);
      }
      if (path.endsWith('/api/sprint-graph')) return json(route, SPRINT_GRAPH);
      // The change-token poll: the SAME token as the graph, so no "changed since you loaded it" hint.
      if (path.endsWith('/api/sprint-graph/token')) {
        return json(route, { workspaceId: WORKSPACE.id, changeToken: SPRINT_GRAPH.changeToken } satisfies SprintGraphTokenResponse);
      }
      // The story view's lean read (a story tab restored from the URL asks it at boot).
      if (path.endsWith('/api/ticket-story')) {
        return json(route, {
          workspaceId: WORKSPACE.id,
          ident: new URL(route.request().url()).searchParams.get('ident') ?? '',
          found: false,
          ticket: null,
          briefState: 'none',
          brief: null,
          story: null,
        } satisfies TicketStoryResponse);
      }
      if (path.endsWith('/api/merged-prs')) return json(route, MERGED_PRS);
      if (path.endsWith('/api/ticket-merged-prs')) {
        return json(route, { workspaceId: WORKSPACE.id, tickets: [] } satisfies TicketMergedPrsResponse);
      }
      // Settings → Workspace renders the sprint grid and the Slack section unconditionally, so
      // both reads get a real, typed answer rather than the generic stub below.
      if (path.endsWith('/api/pro/settings/workspace')) {
        return json(route, {
          workspaceId: WORKSPACE.id,
          cadenceDays: null,
          startDate: null,
          comparisonMode: 'rolling_14',
          hourlyCostUsd: null,
        } satisfies WorkspaceProSettings);
      }
      if (path.endsWith('/api/pro/slack/target')) {
        return json(route, {
          workspaceId: WORKSPACE.id,
          workspaceName: WORKSPACE.name,
          target: null,
          cap: 10,
          configuredCount: 0,
        } satisfies WorkspaceSlackTargetResponse);
      }
      // Every other `/api/pro/*` read: a harmless "switched off" stub.
      if (path.includes('/api/pro/')) {
        return json(route, { enabled: false, model: 'claude-haiku-5-5', generatedAt: iso(0) });
      }
      if (prDetailMatch) return json(route, prDetailFor(Number(prDetailMatch[1])));
      // mark-viewed, insights, and anything else: a harmless empty 200. (The two dismissal stubs
      // that used to sit here went with the `my_turn_dismissals` table and its routes.)
      return json(route, {});
    },
  );
}

export const fixtures = {
  PRS,
  INBOX_IDS,
  REPO,
  USERS,
  CONSOLIDATED_FEED,
  ACTIVITY,
  WORKSPACE,
  ATTENTION,
  DAILY_BRIEF,
  BRANCH_STATUS,
  ME_RESPONSE,
};
