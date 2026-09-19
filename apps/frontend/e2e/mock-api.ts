import type { Page, Route } from '@playwright/test';
import type {
  AttentionCardsResponse,
  AttentionLivenessResponse,
  AwaitingReviewItem,
  ConsolidatedFeedItem,
  ConsolidatedFeedResponse,
  ActivityResponse,
  MeResponse,
  MyTurnPr,
  MyTurnResponse,
  OpenPrsResponse,
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
} from '@pierre-review/shared';
// VALUES, not types — the fixtures quote the shipped default rather than re-typing 1500, and
// build the Pending tabs from the shipped list rather than re-typing it.
import {
  LARGE_PR_CODE_LOC_DEFAULT,
  PENDING_TABS,
  pendingAuthorSideOf,
  resolveMyTurnSettings,
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
// without it the Activity console — the default landing view — stays permanently empty and every
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

const ME_RESPONSE: MeResponse = {
  user: {
    login: ME.githubLogin,
    githubId: 'MDQ6VXNlcjE=',
    avatarUrl: null,
    displayName: null,
  },
  deploymentMode: 'local',
  // CORE/free surfaces that gate on their own top-level flag, all dark in these fixtures: the
  // severity badges need a severity-api, and the conflict resolver's six routes are local-only
  // and not exercised here. `blastRadius: null` = no account override, so the reach chip falls
  // back to its shipped thresholds.
  mlSeverity: false,
  conflictResolver: false,
  largePrCodeLocThreshold: LARGE_PR_CODE_LOC_DEFAULT,
  largePrCodeLocThresholdIsDefault: true,
  blastRadius: null,
  // Pro tier for e2e: all AI features (digests, Claude Review, AI Fix) stay off so the console
  // renders without the AI panels/tabs. "My Turn" is CORE / free now (not a Pro capability), so
  // the Feed's isMyTurn cards/toggle render regardless of these flags. `workspaceInsights` (the
  // former `teamInsights`) off keeps the Insights rail line hidden.
  pro: {
    activityDigest: false,
    botAdvisor: false,
    periodReports: false,
    botDepth: false,
    workPlan: false,
    reviewMemory: false,
    aiAnalysis: false,
    prSummary: false,
    aiFix: false,
    workspaceInsights: false,
    claudeReview: false,
    slackDigest: false,
    issueLinks: false,
    botTriage: false,
  },
  benchmarkOptIn: false,
  // No My Turn overrides — the product defaults, resolved by the SPA through the shared resolver.
  myTurnSettings: null,
  authNotices: [],
  // AI balances (summary turns + agent credits). Unmetered/none for the e2e local tier.
  aiUsage: null,
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
// The counts strip + Workspace badge (daily-brief), the auto-merge banner's armed intents, and
// the global loading bar's full-mode walk feed. Every spec in this suite pays for all three, and
// ⚠ NONE of them may fall through to the catch-all `{}`: each consumer reads a field off the
// response that an empty object does not have — `counts.myTurnPersonal`, `requests.some`,
// `backfills.length`/`catchups.length` — and two of those live in a `refetchInterval`, which runs inside React's
// passive-effect commit. With no error boundary in the SPA the throw unmounts the WHOLE tree, so
// the symptom is not an error message: the Activity overlay paints, then the page goes blank a
// beat later and every locator times out.
//
// The brief is all zeros — these fixtures exercise the FEED, and a zero strip leaves the
// overlay's only `<ul>` the feed list the specs count.
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
    // The Dependencies tab's security chip. Zero, so the strip stays empty (see above) — the two
    // Dependencies cards below sit on the board, not in the brief.
    security: 0,
  },
  generatedAt: iso(0),
};

// ── THE PENDING BOARD — THE DEFAULT LANDING ─────────────────────────────────────────────────────
// The app opens on Pending, so EVERY spec's first paint calls `GET /api/attention`. Left to the
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
    const cards = ATTENTION_CARDS.filter((c) => ranked.includes(c.kind));
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
      claudeReviewId: null,
      claudeVerdict: null,
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
      claudeReviewId: null,
      claudeVerdict: null,
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
      claudeReviewId: null,
      claudeVerdict: null,
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
};

// A complete-but-empty PR detail so opening a PR never crashes the (error-boundary-less)
// app. Self-contained: PrDetail renders from this object's own users/labels/etc.
function prDetailFor(id: number): PrDetail {
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
    inMergeQueue: null,
    mergeQueueEntryState: null,
    viewerCanApprove: false,
    viewerCanPush: false,
    viewerCanClose: false,
    viewerCanReopen: false,
    viewerHasApprovedStanding: false,
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
export async function installMockApi(page: Page): Promise<void> {
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const path = new URL(route.request().url()).pathname;
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
      // ⚠ MUST BE SERVED, not left to the catch-all. `workspaceId` starts null in the store and
      // every workspace-scoped query holds itself idle until this response resolves it — a `{}`
      // here leaves the Activity console (the default landing view) permanently blank.
      if (path.endsWith('/api/workspaces')) return json(route, WORKSPACES);
      // The workspace's bot listing. Shape matters even while empty: consumers read `.reviewers`
      // and `.repoIds` off it.
      if (path.endsWith('/api/bot-reviewers')) return json(route, DETECTED_REVIEWERS);
      if (path.endsWith('/api/daily-brief')) return json(route, DAILY_BRIEF);
      if (path.endsWith('/api/auto-merge')) return json(route, ARMED_MERGES);
      if (path.endsWith('/api/sync-activity')) return json(route, SYNC_ACTIVITY);
      if (path.endsWith('/api/my-turn')) return json(route, MY_TURN);
      // The Pending board, where the app lands, and its liveness sweep (a POST on its own path).
      if (path.endsWith('/api/attention/liveness')) return json(route, ATTENTION_LIVENESS);
      if (path.endsWith('/api/attention')) return json(route, ATTENTION);
      if (path.endsWith('/api/activity/feed')) return json(route, CONSOLIDATED_FEED);
      if (path.endsWith('/api/activity')) return json(route, ACTIVITY);
      if (path.includes('/api/timeline')) return json(route, TIMELINE);
      if (path.includes('/api/open-prs')) return json(route, OPEN_PRS);
      if (path.endsWith('/api/users')) return json(route, USERS);
      if (path.endsWith('/api/repos')) return json(route, [REPO]);
      if (path.endsWith('/api/mergers')) return json(route, []);
      // Pro digest endpoints — disabled in e2e (pro:{activityDigest:false}); harmless stub.
      if (path.includes('/api/pro/')) {
        return json(route, { enabled: false, model: 'claude-haiku-4-5', digests: [], digest: null, generatedAt: iso(0) });
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
};
