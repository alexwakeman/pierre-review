import type { Page, Route } from '@playwright/test';
import type {
  PrTabSummariesResponse,
  ActiveReviewsResponse,
  AiFix,
  AiFixPickerPreview,
  AiFixResponse,
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
  AiReviewCard,
  AiReviewsSeenResponse,
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
  PrPushSummariesResponse,
  ClaudeThreadJudgementsResponse,
  PrTicketReviewsResponse,
  TicketReviewStatesResponse,
  TicketReview,
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
  TicketAssignablesResponse,
  TicketAssignResponse,
  WorkspaceTrackerSettings,
  TrackerCopySourcesResponse,
  WorkspaceSonarSettings,
  WikiCredentialsSettings,
  SonarPrResponse,
  PrSequenceDiagramsResponse,
  TicketSequenceDiagramResponse,
  StoryDocsAlignmentResponse,
  SprintGraphResponse,
  SprintGraphTokenResponse,
  StoryBuild,
  StoryBuildDiffResponse,
  StoryBuildDiscardResponse,
  PrReviewWaitsResponse,
  ReviewerCandidateResponse,
  StoryBuildForTicketResponse,
  StoryBuildPushResponse,
  StoryBuildRepo,
  StoryBuildSession,
  StoryBuildStartResponse,
  SandboxNetworkAllowResponse,
  SandboxRunningStatus,
  SandboxRuntimeStatus,
  SandboxStopAllResult,
  SandboxSessionActionResponse,
  SandboxSessionDiffResponse,
  SandboxSessionStreamEvent,
  SandboxComposeFiles,
  SandboxFolderCheck,
  SandboxProjectSkills,
  SandboxWorkspaceSettings,
  WorkspaceProSettings,
  WorkspaceSlackTargetResponse,
  RepoDocsCheckResponse,
  RepoDocsOffersAddResponse,
  RepoDocsOffersDismissResponse,
  BuildPlanDecisionBody,
  BuildPlanReplyBody,
  BuildPlanRevision,
  BuildPlanRevisionResponse,
  BuildPlanView,
  StoryBuildPr,
  StoryBuildPrDiffResponse,
  SandboxSessionStartBody,
} from '@pierre-review/shared';
// VALUES, not types — the fixtures quote the shipped default rather than re-typing 1500, and
// build the Pending tabs from the shipped list rather than re-typing it.
import {
  AI_BUDGET_DEFAULTS,
  aiKindsAll,
  DO_NEXT_RULES,
  LARGE_PR_CODE_LOC_DEFAULT,
  PENDING_TABS,
  pendingTabHolds,
  pendingAuthorSideOf,
  resolveFeatures,
  resolveMyTurnSettings,
  SANDBOX_SESSION_API,
  STORY_BUILD_API,
  BUILD_PLAN_API,
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
// PR CHIPS (docs/FRONTEND.md § PR chips): only /api/open-prs carries them. #105 lands after #104
// (a stack of two), and #101 has one ticket check (3 of 4 criteria met, at an older commit).
const OPEN_PRS: OpenPrsResponse = {
  prs: PRS.map((p) => {
    const m104 = { prId: 104, number: 104, title: 'Watched repo PR by bob' };
    const m105 = { prId: 105, number: 105, title: 'Other: docs pass' };
    if (p.id === 104) return { ...p, branchStack: { position: 1, chain: [m104, m105], parent: null, children: [m105] }, criteria: [] };
    if (p.id === 105) return { ...p, branchStack: { position: 2, chain: [m104, m105], parent: m104, children: [] }, criteria: [] };
    if (p.id === 101) {
      return {
        ...p,
        branchStack: null,
        criteria: [
          {
            ident: 'jira:https://acme.atlassian.net#ACME-7',
            key: 'ACME-7',
            title: 'Login form',
            reviewId: 1,
            met: 3,
            partlyMet: 0,
            notMet: 1,
            unsettled: 0,
            total: 4,
            checkedAt: iso(1),
            olderHead: true,
          },
        ],
      };
    }
    return { ...p, branchStack: null, criteria: [] };
  }),
};
// The Open PRs Claude Review strip's ONE batched read. Never requested while `ai.enabled` is false
// (below); typed and served so a spec that flips it gets the real shape, not the `{}` catch-all.
const CLAUDE_REVIEW_STATES: ClaudeReviewStatesResponse = { states: [] };
// The open-tabs hover card's batch (hover only): nothing stored, so a card shows its tab meta.
const PR_TAB_SUMMARIES: PrTabSummariesResponse = { prs: [] };
// The ticket review's two boot-time reads (the PR pane's Story check, the Open PRs stack pills).
// Both gate on `ai.enabled` like the strip above; typed so a spec that flips it gets real shapes.
// No tracker in e2e, so no ticket states. A spec that adds one carries `autoCheck` (the automatic
// check's plan) — see story-build.spec.ts.
const TICKET_REVIEW_STATES: TicketReviewStatesResponse = { states: [] };
/** ACME-2's latest story check (`GET /api/ticket-reviews/501`): one criterion met, one not, one missing item. */
const ACME_2_CHECK: TicketReview = {
  id: 501,
  ident: 'jira:https://acme.atlassian.net#ACME-2',
  ticketKey: 'ACME-2',
  ticketTitle: 'Sign in with a magic link',
  ticket: null,
  workspaceId: 1,
  originPrId: null,
  trigger: 'manual',
  status: 'succeeded',
  model: 'claude-opus-5-5',
  costUsd: 0.4,
  error: null,
  refused: null,
  createdAt: '2026-10-19T09:58:00.000Z',
  startedAt: '2026-10-19T09:58:00.000Z',
  completedAt: '2026-10-19T10:00:00.000Z',
  alignment: 'partly_aligned',
  summary: 'The link is sent, but it never expires.',
  assessment: {
    alignment: 'partly_aligned',
    summary: 'The link is sent, but it never expires.',
    criteria: [
      { ref: 'AC1', index: 0, text: 'A sign-in link is emailed', status: 'met', explanation: null, deliveredBy: [], evidence: [], expectedIn: null },
      { ref: 'AC2', index: 1, text: 'The link expires after 15 minutes', status: 'not_met', explanation: null, deliveredBy: [], evidence: [], expectedIn: null },
    ],
    missing: [{ ref: 'M1', title: 'A rate limit on link requests', explanation: null, expectedIn: null }],
    notRequested: [],
  },
  members: [],
  items: [],
};
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
  myTurnSettings: { showNewPrs: false },
  // Settings → Features: an existing install with the Timeline switched ON, so every destination
  // shows (specs navigate to all of them through the sidebar, and several drive the board and Focus
  // tabs). The Timeline's real default is OFF: `installMockApi(page, { timeline: false })` serves it.
  features: resolveFeatures({ timeline: true }, { existingInstall: true, reportsReady: true, sprintSource: true }),
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
// "AI reviews" — the newest AI review per PR: one review by the reader's own Limn, every REQUIRED field.
const AI_REVIEW_CARD: AiReviewCard = {
  id: 'ai_review:9001',
  kind: 'ai_review',
  severity: 'info',
  reviewId: 9001,
  prId: 9101,
  repoId: REPO.id,
  repoFullName: REPO.fullName,
  prNumber: 42,
  prTitle: 'Tighten the retry budget',
  githubUrl: `https://github.com/${REPO.fullName}/pull/42`,
  ranByUserId: null,
  auto: false,
  verdict: 'COMMENT',
  findingCount: 2,
  at: iso(1),
};

const ATTENTION_CARDS: InsightCard[] = [SECURITY_CARD, BUMP_CARD, AI_REVIEW_CARD];

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
      // "AI reviews" badges the rows since the last look (never looked: all of them).
      ...(t.key === 'claude' ? { newTotal: cards.length } : {}),
      ...(t.key === 'my_turn'
        ? {
            relevanceTotals: { mine: 0, others: 0 },
            relevanceAuthorTotals: { mine: authorSplit([]), others: authorSplit([]) },
          }
        : {}),
    };
  }),
  scores: {},
  // The ranking the server used — the fixed weights, and the survey off (the default).
  rules: {
    weights: { ...DO_NEXT_RULES.weights },
    myTurnOrder: MY_TURN_DEFAULTS.order,
    myTurnOff: MY_TURN_DEFAULTS.off,
  },
  aiReviewsSeenAt: null,
};
// Opening "AI reviews" stamps "last looked" (a POST on its own path, under the board's).
const AI_REVIEWS_SEEN: AiReviewsSeenResponse = { workspaceId: WORKSPACE.id, seenAt: iso(0) };
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
      // Started, with a CURRENT story check that found gaps: the card offers "Fill gaps" (story-build.spec.ts),
      // and the build tab lists them from the run (`ACME_2_CHECK`).
      check: { met: 1, partlyMet: 0, notMet: 1, unsettled: 0, total: 2, missing: 1, reviewId: 501, checkedAt: '2026-10-19T10:00:00.000Z', stale: false },
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

// "Implement story" as a WORKSPACE SESSION (docs/SANDBOX.md § Sessions): ACME-1's session in the states
// story-build.spec.ts walks — none → ready (Start; the boot is over at once in the mock) → a chat turn
// (Send) → built (Start build) → one repository pushed (Push). Typed so `pnpm typecheck` covers the wire
// shape. The route below keeps the state per page.
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
    branch: 'limn/ACME-1',
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

const BOOT_DONE: StoryBuildSession['boot'] = (
  [
    ['runtime', 'Finding the container runtime'],
    ['image', 'Getting the sandbox image'],
    ['ticket', 'Reading the ticket'],
    ['network', 'Making the private network'],
    ['proxy', 'Starting the network filter'],
    ['sandbox', 'Starting the sandbox'],
    ['repos', 'Loading the repositories'],
    ['services', 'Getting the services ready'],
    ['agent', 'Starting the agent'],
  ] as const
).map(([key, label]) => ({ key, label, state: key === 'services' ? ('skipped' as const) : ('done' as const), detail: null }));

/** A session that has just booted: the agent waits for the reader. */
export const STORY_SESSION_READY_SESSION: StoryBuildSession = {
  phase: 'ready',
  runtime: 'docker',
  runtimeNote: null,
  provider: 'claude',
  model: 'claude-opus-5-5',
  effort: null,
  agentState: 'ready',
  mode: 'chat',
  live: true,
  resumable: false,
  boot: BOOT_DONE,
  notes: ['acme/infra is in your folder but not in this workspace, so it is left out.'],
  conversation: [],
  repos: [
    { repoId: 11, fullName: 'acme/api', path: '/Users/me/acme/api', branch: 'limn/ACME-1', baseSha: 'b'.repeat(40) },
    { repoId: 10, fullName: 'acme/web', path: '/Users/me/acme/web', branch: 'limn/ACME-1', baseSha: 'c'.repeat(40) },
  ],
  startDir: '/Users/me/acme/api',
  credentialLine: 'The model’s sign-in stays on your computer: Limn adds it to each request on the way out.',
  services: null,
  network: [
    { key: 'agent|api.anthropic.com|443|1', source: 'agent', host: 'api.anthropic.com', port: 443, allowed: true, reason: null, via: 'anthropic', count: 6, up: 4200, down: 81000, lastStatus: 200, firstAt: iso(0.01), lastAt: iso(0.001) },
    { key: 'agent|telemetry.example.com|443|0', source: 'agent', host: 'telemetry.example.com', port: 443, allowed: false, reason: 'Not on the allow-list', via: 'forward', count: 2, up: 0, down: 0, lastStatus: null, firstAt: iso(0.01), lastAt: iso(0.001) },
  ],
  spend: { costUsd: 0.04, inputTokens: 1200, outputTokens: 300, turns: 0 },
  idleCloseAt: null,
  ticket: {
    criteria: ['AC1: Every report has a Download CSV button.', 'AC2: The file opens in a spreadsheet with one header row.', 'AC3: Large reports stream instead of timing out.'],
    openPoints: ['Which reports are in scope for the first release?'],
  },
  // A session from before plan first (chat, then Start build). A plan-first session: STORY_SESSION_PLAN_READY.
  plan: null,
};

export const STORY_SESSION_READY: StoryBuild = {
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
  coverage: null,
  candidates: [],
  plan: null,
  planRevision: 0,
  transcript: [],
  flow: null,
  design: null,
  docsStatus: 'none',
  docsError: null,
  docs: null,
  docsDecisions: {},
  acceptedRevision: null,
  acceptedDocs: null,
  repos: [storyBuildRepo(11, 'acme/api', 0), storyBuildRepo(10, 'acme/web', 1)],
  planCostUsd: 0.04,
  docsCostUsd: null,
  totalCostUsd: 0.04,
  sessionBudgetUsd: 30,
  pushedAll: false,
  session: STORY_SESSION_READY_SESSION,
  createdAt: iso(0.01),
  startedAt: iso(0.01),
  completedAt: null,
};

/** The session after one chat turn. */
export function withChatTurn(b: StoryBuild, text: string): StoryBuild {
  const s = b.session!;
  const n = s.conversation.length;
  return {
    ...b,
    session: {
      ...s,
      spend: { ...s.spend, turns: s.spend.turns + 1 },
      conversation: [
        ...s.conversation,
        { kind: 'reader', id: `r${n}`, text, at: iso(0), build: false },
        { kind: 'tool', id: `t${n}`, tool: 'Bash', summary: 'rg -l "export" src/reports', ok: true, output: 'src/reports/index.ts\nsrc/reports/ReportHeader.tsx', at: iso(0) },
        { kind: 'agent', id: `m-${n}`, text: 'The reports endpoint is in **acme/api** `src/reports/index.ts`. I would add a streamed CSV route there and a button in acme/web.', at: iso(0) },
        { kind: 'turn', id: `e${n}`, turn: s.spend.turns + 1, mode: 'chat', outcome: 'completed', costUsd: 0.06, at: iso(0) },
      ],
    },
  };
}

/** The same session once Start build ran: both repositories have a stored patch. */
export function builtFrom(b: StoryBuild): StoryBuild {
  const s = b.session!;
  return {
    ...b,
    status: 'ready',
    totalCostUsd: 0.9,
    repos: b.repos.map((r) => ({
      ...r,
      status: 'ready',
      hasPatch: true,
      model: 'claude-opus-5-5',
      filesChanged: r.repoId === 11 ? ['src/reports/csv.ts'] : ['src/reports/ReportHeader.tsx'],
      summary: r.repoId === 11 ? 'Adds GET /reports/:id.csv, streamed.' : 'Adds the Download CSV button.',
      commitMessage: r.repoId === 11 ? 'Stream reports as CSV' : 'Add the Download CSV button',
      completedAt: iso(0.001),
    })),
    session: {
      ...s,
      phase: 'built',
      mode: 'build',
      spend: { ...s.spend, costUsd: 0.9, turns: s.spend.turns + 1 },
      conversation: [
        ...s.conversation,
        { kind: 'reader', id: 'rb', text: 'Start the build.', at: iso(0), build: true },
        { kind: 'tool', id: 'tb', tool: 'Bash', summary: 'pnpm test', ok: true, output: '12 passed', at: iso(0) },
        { kind: 'agent', id: 'm-b', text: 'AC1, AC2 and AC3 are done. Tests pass in both repositories.', at: iso(0) },
        { kind: 'turn', id: 'eb', turn: s.spend.turns + 1, mode: 'build', outcome: 'completed', costUsd: 0.8, at: iso(0) },
      ],
    },
  };
}

export const STORY_SESSION_BUILT: StoryBuild = builtFrom(STORY_SESSION_READY);

/** A session closed by the idle teardown, with its changes kept: Resume and Push. */
export const STORY_SESSION_CLOSED: StoryBuild = {
  ...STORY_SESSION_BUILT,
  session: { ...STORY_SESSION_BUILT.session!, live: false, resumable: true, agentState: null },
};

// ── PLAN FIRST (docs/STORY-BUILD.md § Plan first) ─────────────────────────────────────────────────
//
// What a NEW session is now: Limn sends the planning turn itself, and the agent's checked plan waits for the
// reader. Revision 2 (revision 1 is the history entry): three criteria, two points to settle (code + docs
// evidence on C1, a data run on C2), a three-PR stack (two stacked in acme/api, one in acme/web) and a draft
// ticket update. Approve turns it into STORY_SESSION_STACK_BUILT: three planned PRs, ready to push in order.

const PLAN_CODE_EVIDENCE = {
  kind: 'code' as const,
  repoId: 11,
  fullName: 'acme/api',
  path: 'src/reports/export.ts',
  startLine: 14,
  endLine: 16,
  baseSha: 'b'.repeat(40),
  excerpt: '// Reports over this size are refused.\nexport const MAX_EXPORT_ROWS = 500;\nexport const EXPORT_TIMEOUT_MS = 30_000;\n',
  linesCorrected: false,
};

export function storyPlanRevision(revision: number, o: Partial<BuildPlanRevision> = {}): BuildPlanRevision {
  return {
    revision,
    source: revision === 1 ? 'opening' : 'reply',
    createdAt: iso(0.002),
    summary: 'Add a streamed CSV route to acme/api and a Download CSV button to acme/web. The export cap in acme/api is changed first, in its own pull request.',
    repos: [
      { repoId: 11, fullName: 'acme/api', why: 'The reports endpoint and the export cap.' },
      { repoId: 10, fullName: 'acme/web', why: 'The Download CSV button on each report.' },
    ],
    criteria: [
      { ref: 'AC1', text: 'Every report has a Download CSV button.', status: 'planned', how: 'A button in ReportHeader that calls the new route.', prs: ['P3'], openPoints: [] },
      { ref: 'AC2', text: 'The file opens in a spreadsheet with one header row.', status: 'planned', how: 'The route writes the column names first.', prs: ['P2'], openPoints: [] },
      { ref: 'AC3', text: 'Large reports stream instead of timing out.', status: 'planned', how: 'Stream rows from a cursor; lift the 500-row cap.', prs: ['P1', 'P2'], openPoints: [1] },
    ],
    contentions: [
      {
        id: 'C1',
        fingerprint: 'f-c1',
        about: ['AC3'],
        storySays: 'Large reports stream instead of timing out.',
        problem: 'acme/api refuses any export over 500 rows, so a large report never reaches the stream. The export guide also says exports are capped.',
        proposal: 'Remove the 500-row cap for CSV and stream every row.',
        ifKept: 'Stream up to 500 rows and keep the refusal above that.',
        evidence: [
          PLAN_CODE_EVIDENCE,
          {
            kind: 'docs',
            path: 'export-guide/sections/02-row-limits.md',
            anchor: null,
            docSlug: 'export-guide',
            docTitle: 'Export guide',
            sectionTitle: 'Row limits',
            quote: 'An export may hold at most 500 rows.',
            verdict: 'contradicts',
            note: 'The guide caps every export at 500 rows.',
            about: 'AC3',
            workspaceId: WORKSPACE.id,
          },
        ],
      },
      {
        id: 'C2',
        fingerprint: 'f-c2',
        about: ['AC1'],
        storySays: 'Every report has a Download CSV button.',
        problem: 'Two of the nine report types have no rows table, so a CSV of them would be empty.',
        proposal: 'Show the button only on the seven report types with rows.',
        ifKept: 'Show the button on every report, and send a header row only for the two without rows.',
        evidence: [
          {
            kind: 'data_run',
            run: 'svc-1',
            stack: 'dev',
            service: 'postgres',
            command: ['psql', '-c', 'select kind, count(*) from report_rows group by kind'],
            exitCode: 0,
            at: iso(0.002),
            excerpt: ' kind     | count\n----------+-------\n summary  |     0\n pipeline |     0\n(7 more rows)',
          },
        ],
      },
    ],
    stack: [
      { key: 'P1', repoId: 11, fullName: 'acme/api', stackIndex: 1, title: 'Lift the export row cap', contains: 'The cap constant and its test.', criteria: ['AC3'], dependsOn: [], branch: 'limn/ACME-1' },
      { key: 'P2', repoId: 11, fullName: 'acme/api', stackIndex: 2, title: 'Stream reports as CSV', contains: 'GET /reports/:id.csv, streamed from a cursor.', criteria: ['AC2', 'AC3'], dependsOn: ['P1'], branch: 'limn/ACME-1-2' },
      { key: 'P3', repoId: 10, fullName: 'acme/web', stackIndex: 1, title: 'Add the Download CSV button', contains: 'The button in ReportHeader.', criteria: ['AC1'], dependsOn: ['P2'], branch: 'limn/ACME-1' },
    ],
    stackReason: 'The cap change touches every export, so it is reviewed on its own before the new route.',
    ticketUpdate: {
      description: null,
      acceptanceCriteria: 'AC3: GIVEN a report with more than 500 rows\nWHEN I select Download CSV\nTHEN the file streams every row',
      why: 'The story does not say what happens above the current 500-row cap.',
      contentions: ['C1'],
    },
    dropped: { contentions: 1, evidence: 0, reasons: ['A quote was not in the file at the session start.'] },
    ...o,
  };
}

export const STORY_PLAN_VIEW: BuildPlanView = {
  latest: storyPlanRevision(2),
  revisions: 2,
  decisions: {},
  replies: [{ contentionId: 'C1', text: 'Is the cap used anywhere else?', at: iso(0.003), revision: 1 }],
  unanswered: 2,
  approvedRevision: null,
  approvedAt: null,
  status: 'ready',
  problem: null,
  withDocs: true,
  fillGaps: false,
};

/** A plan-first session waiting for the reader to settle its plan. */
export const STORY_SESSION_PLAN_READY: StoryBuild = {
  ...STORY_SESSION_READY,
  session: {
    ...STORY_SESSION_READY_SESSION,
    phase: 'plan_ready',
    plan: STORY_PLAN_VIEW,
    conversation: [
      { kind: 'reader', id: 'r0', text: 'Plan with docs', at: iso(0.004), build: false },
      { kind: 'tool', id: 't0', tool: 'Read', summary: 'src/reports/export.ts', ok: true, output: 'export const MAX_EXPORT_ROWS = 500;', at: iso(0.004) },
      { kind: 'agent', id: 'm-0', text: 'I read the ticket, both repositories and the export guide. The plan is above.', at: iso(0.003) },
      { kind: 'turn', id: 'e0', turn: 1, mode: 'chat', outcome: 'completed', costUsd: 0.12, at: iso(0.003) },
    ],
  },
};

function storyBuildPr(id: number, key: string, position: number, o: Partial<StoryBuildPr>): StoryBuildPr {
  return {
    id,
    key,
    repoId: 11,
    fullName: 'acme/api',
    position,
    stackIndex: 1,
    title: '',
    contains: '',
    criteria: [],
    dependsOn: [],
    branch: 'limn/ACME-1',
    status: 'ready',
    error: null,
    stat: { files: 1, insertions: 3, deletions: 0, commits: 1 },
    filesChanged: ['src/reports/csv.ts'],
    summary: null,
    checks: null,
    reported: null,
    pushedBranch: null,
    pushedPrNumber: null,
    pushedPrUrl: null,
    pushError: null,
    ...o,
  };
}

/** After Approve: the build followed the stack and every planned PR is ready to push, in order. */
export function stackBuiltFrom(b: StoryBuild): StoryBuild {
  const s = b.session!;
  const plan = s.plan!;
  const decisions = Object.keys(plan.decisions).length > 0 ? plan.decisions : { C1: { decision: 'agree' as const, at: iso(0) }, C2: { decision: 'keep_story' as const, at: iso(0) } };
  return {
    ...builtFrom(b),
    prs: [
      storyBuildPr(501, 'P1', 0, { title: 'Lift the export row cap', criteria: ['AC3'], summary: 'Removes the 500-row cap for CSV.', reported: 'done', checks: [{ command: 'pnpm test', result: 'passed', note: null }] }),
      storyBuildPr(502, 'P2', 1, { stackIndex: 2, branch: 'limn/ACME-1-2', title: 'Stream reports as CSV', criteria: ['AC2', 'AC3'], dependsOn: ['P1'], summary: 'Adds GET /reports/:id.csv, streamed.', reported: 'done', checks: [{ command: 'pnpm test', result: 'passed', note: null }] }),
      storyBuildPr(503, 'P3', 2, { repoId: 10, fullName: 'acme/web', title: 'Add the Download CSV button', criteria: ['AC1'], dependsOn: ['P2'], filesChanged: ['src/reports/ReportHeader.tsx'], reported: 'partly', checks: [{ command: 'pnpm lint', result: 'not_run', note: 'No lint config.' }] }),
    ],
    session: { ...builtFrom(b).session!, plan: { ...plan, decisions, unanswered: 0, status: 'approved', approvedRevision: plan.latest?.revision ?? 1, approvedAt: iso(0) } },
  };
}

export const STORY_SESSION_STACK_BUILT: StoryBuild = stackBuiltFrom(STORY_SESSION_PLAN_READY);

const STORY_PR_DIFF = (prId: number): StoryBuildPrDiffResponse => ({ prId, key: `P${prId - 500}`, repoId: 11, patch: CSV_PATCH, filesChanged: ['src/reports/csv.ts'], stat: { files: 1, insertions: 3, deletions: 0, commits: 1 } });

// ── AI FIX ON THE WORKSPACE SESSION (docs/SANDBOX.md § AI Fix sessions) ──────────────────────────────

/** The CI-only picker (no AI review): two failures the CI check says this PR can fix. */
export const AI_FIX_PREVIEW: AiFixPickerPreview = {
  sourceReviewId: null,
  items: [
    { key: 'ci:1', section: 'ci_failures', label: 'test: csv.spec.ts fails on an empty report', detail: null, path: 'src/reports/csv.ts', line: 12, severity: null, defaultIncluded: true, chars: 400 },
    { key: 'ci:2', section: 'ci_failures', label: 'lint: unused import in ReportHeader.tsx', detail: null, path: 'src/reports/ReportHeader.tsx', line: 3, severity: null, defaultIncluded: true, chars: 200 },
  ],
  budgetChars: 60_000,
  cutByBudget: [],
};

const AI_FIX_PATCH = [
  'diff --git a/src/reports/csv.ts b/src/reports/csv.ts',
  'index 1111111..2222222 100644',
  '--- a/src/reports/csv.ts',
  '+++ b/src/reports/csv.ts',
  '@@ -10,3 +10,4 @@ export function toCsv(rows: Row[]): string {',
  '   const header = columns.join(",");',
  '+  if (rows.length === 0) return `${header}\n`;',
  '   return [header, ...rows.map(line)].join("\n");',
  ' }',
  '',
].join('\n');

/** A manual fix whose first build turn has finished: the sandbox runs, the patch is stored. */
export function aiFixBuilt(prId: number): AiFix {
  const s = STORY_SESSION_READY_SESSION;
  return {
    id: 71,
    prId,
    status: 'succeeded',
    model: 'claude-opus-5-5',
    provider: 'claude',
    effort: null,
    seed: 'review',
    summary: 'An empty report now gets its header row. The unused import is gone.',
    commitMessage: 'Write the CSV header for an empty report',
    patch: AI_FIX_PATCH,
    filesChanged: ['src/reports/csv.ts'],
    baseSha: 'd'.repeat(40),
    sourceReviewId: null,
    trigger: 'manual',
    reviewItems: [
      { ref: 'C1', kind: 'ci_failure', title: 'test: csv.spec.ts fails on an empty report', path: 'src/reports/csv.ts', line: 12, findingId: null, threadId: null, ticketIndex: null, included: true },
      { ref: 'C2', kind: 'ci_failure', title: 'lint: unused import in ReportHeader.tsx', path: 'src/reports/ReportHeader.tsx', line: 3, findingId: null, threadId: null, ticketIndex: null, included: true },
    ],
    changeReport: {
      changes: [{ path: 'src/reports/csv.ts', summary: 'Returns the header row when there are no rows.', refs: ['C1'] }],
      unaddressed: [{ ref: 'C2', reason: 'The import is used by a type; the lint rule is wrong here.' }],
      notReported: [],
    },
    plan: null,
    checks: null,
    session: {
      ...s,
      phase: 'built',
      mode: 'build',
      ticket: { criteria: [], openPoints: [] },
      notes: [],
      repos: [
        { repoId: REPO.id, fullName: REPO.fullName, path: '/Users/me/acme/web', branch: 'limn/fix-pr-1', baseSha: 'd'.repeat(40) },
        { repoId: 11, fullName: 'acme/api', path: '/Users/me/acme/api', branch: 'main', baseSha: 'b'.repeat(40) },
      ],
      startDir: '/Users/me/acme/web',
      spend: { costUsd: 0.62, inputTokens: 9000, outputTokens: 1400, turns: 1 },
      conversation: [
        { kind: 'reader', id: 'r1', text: 'Start fix', at: iso(0.001), build: true },
        { kind: 'tool', id: 't1', tool: 'Bash', summary: 'pnpm test src/reports', ok: true, output: '42 passed', at: iso(0.001) },
        { kind: 'notice', id: 'n1', text: 'Changes in acme/api (1 file) are left out. AI Fix pushes only acme/web.', at: iso(0.001) },
        { kind: 'agent', id: 'm-1', text: 'C1 is fixed. I left C2: the import is used by a type. Ran npm test: 42 passed.', at: iso(0.001) },
        { kind: 'turn', id: 'e1', turn: 1, mode: 'build', outcome: 'completed', costUsd: 0.62, at: iso(0.001) },
      ],
    },
    leftOut: [{ repoId: 11, fullName: 'acme/api', files: ['src/reports/route.ts'] }],
    unattended: false,
    costUsd: 0.62,
    numTurns: 12,
    error: null,
    pushedBranch: null,
    pushedPrNumber: null,
    pushedPrUrl: null,
    pushedAt: null,
    createdAt: iso(0.002),
    finishedAt: iso(0.001),
  };
}

/** The picker of a PR that conflicts with main: the merge item first (ticked), then the CI failures. */
export const AI_FIX_PREVIEW_MERGE: AiFixPickerPreview = {
  ...AI_FIX_PREVIEW,
  items: [
    { key: 'conflict:merge', section: 'conflicts', label: 'Resolve merge conflicts with main', detail: 'The agent merges the base first, then fixes the other items on top.', path: null, line: null, severity: null, defaultIncluded: true, chars: 900 },
    ...AI_FIX_PREVIEW.items,
  ],
};

const AI_FIX_RESOLUTION = [
  'diff --git a/src/reports/limits.ts b/src/reports/limits.ts',
  'index 3333333..4444444 100644',
  '--- a/src/reports/limits.ts',
  '+++ b/src/reports/limits.ts',
  '@@ -1,7 +1,2 @@',
  '-<<<<<<< HEAD',
  '-export const limit = 25;',
  '-=======',
  '-export const limit = 50; // the API caps it at 100',
  '->>>>>>> main',
  '+export const limit = 25; // the API caps it at 100',
  ' export const pageSize = limit;',
  '',
].join('\n');

/**
 * A fix with the "Resolve merge conflicts" item after its first build turn: the merge of main (valid, or
 * refused by Limn's check) and the CI fix on top.
 */
export function aiFixMerged(prId: number, status: 'valid' | 'invalid' = 'valid'): AiFix {
  const b = aiFixBuilt(prId);
  const valid = status === 'valid';
  return {
    ...b,
    reviewItems: [
      { ref: 'MERGE', kind: 'merge_conflicts', title: 'Resolve merge conflicts with main', path: null, line: null, findingId: null, threadId: null, ticketIndex: null, included: true },
      ...(b.reviewItems ?? []),
    ],
    changeReport: valid
      ? { ...b.changeReport!, changes: [{ path: 'src/reports/limits.ts', summary: 'Kept the PR’s limit and main’s comment, once.', refs: ['MERGE'] }, ...b.changeReport!.changes] }
      : { ...b.changeReport!, unaddressed: [{ ref: 'MERGE', reason: 'Limn: conflict markers are left in src/reports/limits.ts.' }, ...b.changeReport!.unaddressed] },
    merge: {
      baseRef: 'main',
      baseSha: 'e'.repeat(40),
      conflictedFiles: ['src/reports/limits.ts'],
      status,
      reason: valid ? null : 'conflict markers are left in src/reports/limits.ts.',
      resolutionDiff: AI_FIX_RESOLUTION,
      resolutionFiles: ['src/reports/limits.ts'],
    },
  };
}

/** Plan first: the session booted in chat mode, made its plan and waits for Start fix. */
export function aiFixPlanned(prId: number): AiFix {
  const b = aiFixBuilt(prId);
  return {
    ...b,
    status: 'planned',
    summary: null,
    commitMessage: null,
    patch: null,
    filesChanged: [],
    changeReport: null,
    leftOut: [],
    session: {
      ...b.session!,
      phase: 'ready',
      mode: 'chat',
      spend: { ...b.session!.spend, costUsd: 0.08, turns: 1 },
      conversation: [
        { kind: 'reader', id: 'r1', text: 'Plan first', at: iso(0.001), build: false },
        { kind: 'agent', id: 'm-1', text: 'C1: return the header when there are no rows. C2: I will not change it; the import is used by a type.', at: iso(0.001) },
        { kind: 'turn', id: 'e1', turn: 1, mode: 'chat', outcome: 'completed', costUsd: 0.08, at: iso(0.001) },
      ],
    },
  };
}

/** The memory check (`POST /api/workspaces/:id/sandbox/check`): one project with notes, ticked. */
export const SANDBOX_FOLDER_CHECK: SandboxFolderCheck = {
  workspaceId: WORKSPACE.id,
  folder: '/Users/reader/code',
  matched: [{ repoId: 1, fullName: 'acme/api', localPath: '/Users/reader/code/api', alsoAt: [] }],
  notCloned: [],
  outside: [],
  memories: [{ dir: '/Users/reader/code/api', key: '-Users-reader-code-api', memoryCount: 12, ticked: true }],
  userClaudeMd: true,
  folderClaudeMd: false,
  userSkills: [],
  startDir: '/Users/reader/code/api',
  truncated: false,
};

/** The computer's container runtime (`GET /api/sandbox/runtime`). */
export const SANDBOX_RUNTIME_OK: SandboxRuntimeStatus = {
  available: true,
  kind: 'docker',
  label: 'Colima 0.8.1',
  licenceNote: null,
  problem: null,
  cpus: 4,
  memoryGb: 8,
};
export const SANDBOX_RUNTIME_NONE: SandboxRuntimeStatus = {
  available: false,
  kind: null,
  label: null,
  licenceNote: null,
  problem: 'No container runtime is installed. Limn needs one to run the AI in a sandbox.',
  cpus: null,
  memoryGb: null,
};

const SANDBOX_SETTINGS: SandboxWorkspaceSettings = {
  workspaceId: WORKSPACE.id,
  memoryProjects: null,
  userClaudeMd: true,
  userSkills: false,
  globalProxyEnv: false,
  resources: { cpus: null, memoryGb: null, diskGb: null },
  services: [],
  alwaysAllowedHosts: [],
};

const CSV_PATCH = [
  'diff --git a/src/reports/csv.ts b/src/reports/csv.ts',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/src/reports/csv.ts',
  '@@ -0,0 +1,3 @@',
  '+export function csvHeader(cols: string[]): string {',
  "+  return cols.join(',');",
  '+}',
  '',
].join('\n');

const STORY_BUILD_DIFF: StoryBuildDiffResponse = {
  repoId: 11,
  baseSha: 'b'.repeat(40),
  patch: CSV_PATCH,
  filesChanged: ['src/reports/csv.ts'],
};

const SESSION_DIFF: SandboxSessionDiffResponse = {
  repos: [{ repoId: 11, fullName: 'acme/api', baseSha: 'b'.repeat(40), patch: CSV_PATCH, filesChanged: ['src/reports/csv.ts'], insertions: 3, deletions: 0 }],
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
  approvedPrs: [],
  threadsAwaiting: [],
  // New open PRs by others in your Watched repos — a separate inbox section that My Turn
  // Focus Mode must also show on the board (regression #54).
  watchedRepoPrs: WATCHED_IDS.map((id): WatchedRepoPrItem => myTurnPr(id)),
  users: USERS,
  // The other sections, empty here, and the reader's resolved settings. The three settings fields
  // come FROM the shared resolver, so the fixture cannot drift from it.
  mentions: [],
  threadReplies: [],
  commentReplies: [],
  pushedSince: [],
  ownCiRed: [],
  ownConflicts: [],
  ownReady: [],
  ownThreads: [],
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
      unreadPrs: [],
      // The docs-offer look's stored failure (null = none): the repo status panel's one line.
      docsUnreadable: null,
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
// STILL-OPEN POINTS (docs/CLAUDE-REVIEW.md § Still-open points): PR 1's one thread, held open by a
// teammate's Limn only — the wire shape the Threads tab, Changes and the Overview's "Still open" list read.
export const STILL_OPEN_JUDGEMENTS = {
  prId: 1,
  reviewId: null,
  checkId: null,
  reviewedHeadSha: '',
  finishedAt: null,
  currentHeadSha: 'a'.repeat(40),
  judgements: [
    {
      threadId: 9001,
      validity: 'valid',
      addressed: 'not_addressed',
      explanation: null,
      reason: 'The null case is still not handled.',
      resolved: false,
      assessedAtHead: 'a'.repeat(40),
      carried: false,
      teammateOnly: true,
      stillOpen: {
        by: { you: false, login: 'robin-dunn', name: 'Robin Dunn' },
        reason: 'The null case is still not handled.',
        at: '2026-11-05T09:00:00.000Z',
        headSha: 'a'.repeat(40),
        severity: 'warning',
        path: 'src/metric.ts',
        line: 42,
        threadResolved: false,
      },
    },
  ],
} satisfies ClaudeThreadJudgementsResponse['prs'][number];

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
    // Green head: no failing check, so none is flaky (db/flaky-checks.ts).
    flakyChecks: [],
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
    branchStack: null,
    criteria: [],
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

function json(route: Route, body: unknown, status = 200): Promise<void> {
  return route.fulfill({
    status,
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

export async function installMockApi(
  page: Page,
  opts: {
    storyBuild?: StoryBuild | null;
    runtime?: SandboxRuntimeStatus;
    aiFix?: AiFix | null;
    // The picker the preview answers (default AI_FIX_PREVIEW) and the fix a Start fix produces (default aiFixBuilt).
    aiFixPreview?: AiFixPickerPreview;
    aiFixOnStart?: (prId: number) => AiFix;
    // Settings → Features → Timeline. Default true (the fixtures above); false = the product default.
    timeline?: boolean;
  } = {},
): Promise<void> {
  // AI Fix on the workspace session: served only when a spec names it (`opts.aiFix`, null = no fix yet),
  // advanced by the writes below (one per page).
  const aiFixOn = opts.aiFix !== undefined;
  let aiFix: AiFix | null = opts.aiFix ?? null;
  // "Implement story": ACME-1's session, advanced by the writes below (one per page). A spec may start
  // from a session (`opts.storyBuild`) and name the container runtime (`opts.runtime`).
  let storyBuild: StoryBuild | null = opts.storyBuild ?? null;
  const runtime = opts.runtime ?? SANDBOX_RUNTIME_OK;
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const path = new URL(route.request().url()).pathname;
      const method = route.request().method();

      // The container runtime and Settings → Sandbox (boot-time reads of the build tab and the modal).
      if (path === '/api/sandbox/runtime') return json(route, runtime);
      if (path === '/api/sandbox/running') return json(route, { running: runtime.available ? 0 : null, problem: null } satisfies SandboxRunningStatus);
      if (path === '/api/sandbox/stop-all') return json(route, { stopped: 0, running: 0, problem: null } satisfies SandboxStopAllResult);
      if (/\/api\/workspaces\/\d+\/sandbox$/.test(path)) return json(route, SANDBOX_SETTINGS);
      if (/\/api\/workspaces\/\d+\/sandbox\/compose-files$/.test(path)) {
        return json(route, { workspaceId: WORKSPACE.id, repos: [{ repo: 'acme/api', files: ['compose.yml', 'docker/compose.test.yml'], copied: true }] } satisfies SandboxComposeFiles);
      }
      // The start panel's "The agent also gets …" line: the memory check and the repositories' own skills.
      if (/\/api\/workspaces\/\d+\/sandbox\/check$/.test(path)) return json(route, SANDBOX_FOLDER_CHECK);
      if (/\/api\/workspaces\/\d+\/sandbox\/project-skills$/.test(path)) {
        return json(route, { workspaceId: WORKSPACE.id, repos: [{ repo: 'acme/api', skills: [{ name: 'run-tests', path: '.claude/skills/run-tests/SKILL.md' }], copied: true }] } satisfies SandboxProjectSkills);
      }

      if (path.startsWith(STORY_BUILD_API.list)) {
        const id = storyBuild?.id ?? STORY_SESSION_READY.id;
        const at = (route: keyof typeof SANDBOX_SESSION_API): boolean => path === SANDBOX_SESSION_API[route].replace(':id', String(id));
        if (path === STORY_BUILD_API.list && method === 'GET') {
          return json(route, { workspaceId: WORKSPACE.id, build: storyBuild, earlier: [] } satisfies StoryBuildForTicketResponse);
        }
        if (path === STORY_BUILD_API.list && method === 'POST') {
          if (!runtime.available) return json(route, { error: 'NoRuntime', message: runtime.problem }, 409);
          // The boot and the planning turn are over at once in the mock: a NEW session is plan first, and
          // its checked plan waits for the reader ("with docs" only when the start asked for them).
          const body = route.request().postDataJSON() as SandboxSessionStartBody;
          const plan = { ...STORY_PLAN_VIEW, withDocs: body.docs === true, fillGaps: body.action === 'fill_gaps' };
          storyBuild = { ...STORY_SESSION_PLAN_READY, session: { ...STORY_SESSION_PLAN_READY.session!, plan } };
          return json(route, { outcome: 'started', buildId: STORY_SESSION_READY.id } satisfies StoryBuildStartResponse, 202);
        }
        if (at('messages')) {
          const body = route.request().postDataJSON() as { text: string };
          if (storyBuild != null) storyBuild = withChatTurn(storyBuild, body.text);
          return json(route, { buildId: id } satisfies SandboxSessionActionResponse, 202);
        }
        if (at('build')) {
          if (storyBuild != null) storyBuild = builtFrom(storyBuild);
          return json(route, { buildId: id } satisfies SandboxSessionActionResponse, 202);
        }
        if (at('interrupt')) return json(route, { status: 'idle' });
        if (at('networkAllow')) {
          const body = route.request().postDataJSON() as { rule: string; scope: 'session' | 'workspace' };
          if (storyBuild?.session != null) {
            const network = storyBuild.session.network.map((n) => (n.host === body.rule ? { ...n, allowed: true, reason: null } : n));
            storyBuild = { ...storyBuild, session: { ...storyBuild.session, network } };
          }
          return json(route, { rule: body.rule, scope: body.scope } satisfies SandboxNetworkAllowResponse);
        }
        if (at('diff')) return json(route, SESSION_DIFF);
        if (at('resume')) {
          if (storyBuild?.session != null) storyBuild = { ...storyBuild, session: { ...storyBuild.session, live: true, resumable: false, agentState: 'ready' } };
          return json(route, { buildId: id } satisfies SandboxSessionActionResponse, 202);
        }
        // PLAN FIRST: the plan's routes (shared BUILD_PLAN_API) and the planned PRs' diff and push.
        const planAt = (r: keyof typeof BUILD_PLAN_API): boolean => path === BUILD_PLAN_API[r].replace(':id', String(id));
        if (planAt('plan')) {
          const n = Number(new URL(route.request().url()).searchParams.get('revision') ?? '1');
          return json(route, { revision: storyPlanRevision(n, { summary: `Revision ${n}: the first plan.`, contentions: [] }), decisions: {} } satisfies BuildPlanRevisionResponse);
        }
        if (planAt('decisions')) {
          const body = route.request().postDataJSON() as BuildPlanDecisionBody;
          const s = storyBuild?.session;
          if (s?.plan == null || s.plan.latest == null) return json(route, { error: 'NoPlan', message: 'No plan yet.' }, 409);
          if (body.revision !== s.plan.latest.revision) return json(route, { error: 'PlanStale', message: 'The plan changed.' }, 409);
          const decisions = { ...s.plan.decisions };
          if (body.decision == null) delete decisions[body.contentionId];
          else decisions[body.contentionId] = { decision: body.decision, at: iso(0) };
          const plan: BuildPlanView = { ...s.plan, decisions, unanswered: s.plan.latest.contentions.filter((c) => decisions[c.id] == null).length };
          storyBuild = { ...storyBuild!, session: { ...s, plan } };
          return json(route, plan);
        }
        if (planAt('reply')) {
          // The revision turn is over at once: revision n+1, the decisions carried forward (same ids).
          const body = route.request().postDataJSON() as BuildPlanReplyBody;
          const s = storyBuild?.session;
          if (s?.plan?.latest != null) {
            const n = s.plan.latest.revision + 1;
            const latest = storyPlanRevision(n, { summary: `${s.plan.latest.summary} Revised after your reply.` });
            const replies = [...s.plan.replies, { contentionId: body.contentionId, text: body.text, at: iso(0), revision: s.plan.latest.revision }];
            storyBuild = { ...storyBuild!, session: { ...s, plan: { ...s.plan, latest, revisions: n, replies } } };
          }
          return json(route, { buildId: id } satisfies SandboxSessionActionResponse, 202);
        }
        if (planAt('approve')) {
          const s = storyBuild?.session;
          if (s?.plan?.latest == null) return json(route, { error: 'NoPlan', message: 'No plan yet.' }, 409);
          if (s.plan.latest.contentions.some((c) => s.plan!.decisions[c.id] == null)) return json(route, { error: 'PlanUnanswered', message: 'Answer every point first.' }, 409);
          storyBuild = stackBuiltFrom(storyBuild!);
          return json(route, { buildId: id } satisfies SandboxSessionActionResponse, 202);
        }
        const prPush = /\/prs\/(\d+)\/push$/.exec(path);
        if (prPush != null) {
          const prId = Number(prPush[1]);
          const prNumber = 80 + (prId - 500);
          const pr = storyBuild?.prs?.find((p) => p.id === prId);
          if (storyBuild != null && pr != null) {
            const url = `https://github.com/${pr.fullName}/pull/${prNumber}`;
            storyBuild = { ...storyBuild, prs: storyBuild.prs!.map((p) => (p.id === prId ? { ...p, status: 'pushed' as const, pushedBranch: p.branch, pushedPrNumber: prNumber, pushedPrUrl: url } : p)) };
          }
          return json(route, {
            results: [],
            prs: [{ prId, key: pr?.key ?? 'P1', repoId: pr?.repoId ?? 11, outcome: 'pushed', prNumber, prUrl: `https://github.com/acme/api/pull/${prNumber}`, code: null, error: null }],
          } satisfies StoryBuildPushResponse);
        }
        const prDiff = /\/prs\/(\d+)\/diff$/.exec(path);
        if (prDiff != null) return json(route, STORY_PR_DIFF(Number(prDiff[1])));
        if (/\/repos\/\d+\/push$/.test(path)) {
          const repoId = Number(path.split('/').at(-2));
          const prNumber = 77;
          if (storyBuild != null) {
            const repos = storyBuild.repos.map((r) =>
              r.repoId === repoId
                ? { ...r, status: 'pushed' as const, pushedPrNumber: prNumber, pushedPrUrl: `https://github.com/${r.fullName}/pull/${prNumber}`, pushedAt: iso(0) }
                : r,
            );
            storyBuild = { ...storyBuild, repos, pushedAll: repos.filter((r) => r.include).every((r) => r.status === 'pushed' || !r.hasPatch) };
          }
          return json(route, {
            results: [{ repoId, outcome: 'pushed', prNumber, prUrl: `https://github.com/acme/api/pull/${prNumber}`, code: null, error: null }],
          } satisfies StoryBuildPushResponse);
        }
        if (/\/repos\/\d+\/diff$/.test(path)) return json(route, STORY_BUILD_DIFF);
        if (path.endsWith('/stream')) {
          // Nothing runs in the mock, so a live session's stream sends nothing and ends (the tab opens it
          // again after a pause; the query's read is the truth — the fold itself is pinned by
          // test/sandboxSession.test.ts). A closed session gets its snapshot and `done`.
          const frames: SandboxSessionStreamEvent[] =
            storyBuild?.session == null ? [{ type: 'done' }] : storyBuild.session.live ? [] : [{ type: 'snapshot', session: storyBuild.session }, { type: 'done' }];
          return route.fulfill({ status: 200, contentType: 'text/event-stream', body: frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('') });
        }
        if (path.endsWith('/discard')) {
          storyBuild =
            storyBuild != null ? { ...storyBuild, status: 'discarded', session: storyBuild.session != null ? { ...storyBuild.session, phase: 'discarded', live: false } : null } : null;
          return json(route, { status: 'discarded' } satisfies StoryBuildDiscardResponse);
        }
        if (/\/api\/story-builds\/\d+$/.test(path)) return json(route, storyBuild ?? STORY_SESSION_READY);
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
      // The PR pane's "Requested" row reads each request's wait against the review target on mount
      // (a bare `{}` would leave `waits` undefined). Nobody waiting is fine for the fixtures.
      if (path.match(/\/api\/prs\/\d+\/review-waits$/))
        return json(route, { waits: [], targetHours: 4, viewerCanRequest: false } satisfies PrReviewWaitsResponse);
      // "Ask someone else" — click-gated; nobody to suggest in the fixtures.
      if (path.match(/\/api\/prs\/\d+\/reviewer-candidate$/))
        return json(route, { candidate: null, users: [] } satisfies ReviewerCandidateResponse);

      if (path.endsWith('/api/me')) {
        if (opts.timeline !== false) return json(route, ME_RESPONSE);
        return json(route, {
          ...ME_RESPONSE,
          features: resolveFeatures(null, { existingInstall: true, reportsReady: true, sprintSource: true }),
        } satisfies MeResponse);
      }
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
      if (path.endsWith('/api/attention/ai-reviews/seen')) return json(route, AI_REVIEWS_SEEN);
      if (path.endsWith('/api/attention')) return json(route, ATTENTION);
      if (path.endsWith('/api/activity/feed')) return json(route, CONSOLIDATED_FEED);
      if (path.endsWith('/api/activity')) return json(route, ACTIVITY);
      if (path.includes('/api/timeline')) return json(route, TIMELINE);
      if (path.includes('/api/open-prs')) return json(route, OPEN_PRS);
      if (path.endsWith('/api/claude-review/states')) return json(route, CLAUDE_REVIEW_STATES);
      if (path.endsWith('/api/prs/tab-summaries')) return json(route, PR_TAB_SUMMARIES);
      // The review banner's poll (AI on): nothing running.
      if (path.endsWith('/api/claude-reviews/active')) return json(route, { reviews: [] } satisfies ActiveReviewsResponse);
      // The thread cards' Claude marker (one batched POST per screen): no judged run here, except
      // the still-open fixture's PR (a teammate's Limn holds one point open; served only when a spec
      // turns AI on and asks for that PR).
      if (path.endsWith('/api/claude-review/thread-judgements')) {
        const asked = ((route.request().postDataJSON() as { prIds?: number[] } | null)?.prIds ?? []).filter(
          (id) => id === STILL_OPEN_JUDGEMENTS.prId,
        );
        return json(route, { prs: asked.length > 0 ? [STILL_OPEN_JUDGEMENTS] : [] } satisfies ClaudeThreadJudgementsResponse);
      }
      // The AI Review tab's per-run "seen" stamp (sent once while a finished run's `seenAt` is null).
      if (/\/api\/prs\/\d+\/claude-review\/seen$/.test(path) && route.request().method() === 'POST')
        return json(route, { status: 'ok', stamped: 1 });
      // The Changes tab's Check threads status (PR detail): never run here.
      const threadCheckMatch = path.match(/\/api\/prs\/(\d+)\/claude-review\/thread-check$/);
      if (threadCheckMatch && route.request().method() === 'GET')
        return json(route, {
          prId: Number(threadCheckMatch[1]),
          check: null,
          progress: null,
        } satisfies ThreadCheckStatusResponse);
      // The PR Activity tab's push summaries (docs/FRONTEND.md § Push summaries): none here.
      const pushSummariesMatch = path.match(/\/api\/prs\/(\d+)\/push-summaries$/);
      if (pushSummariesMatch)
        return json(route, { prId: Number(pushSummariesMatch[1]), summaries: [] } satisfies PrPushSummariesResponse);
      if (path.endsWith('/api/ticket-reviews/states')) return json(route, TICKET_REVIEW_STATES);
      if (path.endsWith(`/api/ticket-reviews/${ACME_2_CHECK.id}`)) return json(route, ACME_2_CHECK);
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
      // "Copy from another workspace": no other workspace has a tracker, so the control stays hidden.
      if (/\/api\/workspaces\/\d+\/tracker\/copy-sources$/.test(path)) {
        return json(route, { workspaceId: WORKSPACE.id, sources: [] } satisfies TrackerCopySourcesResponse);
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
              flow: {
                participants: [
                  { id: 'imp', kind: 'service', label: 'Rate importer', change: 'new', pr: null },
                  { id: 'db', kind: 'db', label: 'rates table', change: 'unchanged', pr: null },
                ],
                steps: [
                  { n: 1, from: 'imp', to: 'imp', kind: 'validate', label: 'rows with no account are dropped', pr: null, files: ['src/import.ts'] },
                  { n: 2, from: 'imp', to: 'db', kind: 'write', label: 'one rate per currency', pr: null, files: [] },
                ],
              },
              design: null,
              headSha: 'a'.repeat(40),
              members: [],
              refusal: null,
              refusalDetail: null,
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
      // The add-documents wizard's "From your repositories" (POST, click-gated): one qualifying folder and
      // one too large for one document, so a spec can tick, review and see the "Choose part of it" pointer.
      if (path.endsWith('/api/docs/offers/check') && route.request().method() === 'POST') {
        return json(route, {
          workspaceId: WORKSPACE.id,
          folders: [
            { id: 901, repoId: 1, repoFullName: 'acme/api', path: 'docs', docs: 12, words: 9400, tooLarge: false },
            { id: 902, repoId: 1, repoFullName: 'acme/api', path: 'handbook', docs: 140, words: 88_000, tooLarge: true },
          ],
          notLookedAt: 0,
          // A repository whose files Limn could not read (the stored failure): one line after the list.
          unreadable: [{ repoId: 2, repoFullName: 'acme/legacy', reason: 'no_access', failedAt: iso(0) }],
          budgetUsd: 6,
        } satisfies RepoDocsCheckResponse);
      }
      if (path.endsWith('/api/docs/offers/add') && route.request().method() === 'POST') {
        return json(route, { added: [], failed: [] } satisfies RepoDocsOffersAddResponse);
      }
      if (path.endsWith('/api/docs/offers/dismiss') && route.request().method() === 'POST') {
        return json(route, { dismissed: 0 } satisfies RepoDocsOffersDismissResponse);
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
            autoReviewProviders: 'default',
            pairStrictness: 'strict',
            autoFix: {
              include: {
                conflicts: false,
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
              // Posting and the auto verdict are ON by default (2026-11-04).
              enabled: true,
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
              autoVerdict: true,
              resolveOwnPrs: true,
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
          comments: [],
        } satisfies TicketStoryResponse);
      }
      // The story view's assignee picker (click-gated: only when it opens) and its pick.
      if (path.endsWith('/api/ticket-assignees')) {
        return json(route, {
          workspaceId: WORKSPACE.id,
          ident: new URL(route.request().url()).searchParams.get('ident') ?? '',
          users: [{ id: 'acc:demo-1', name: 'Amy Pond', detail: null, avatarUrl: null }],
          truncated: false,
        } satisfies TicketAssignablesResponse);
      }
      if (path.endsWith('/api/ticket-assignee')) {
        const body = (route.request().postDataJSON() ?? {}) as { ident?: string; assigneeId?: string | null };
        return json(route, {
          workspaceId: WORKSPACE.id,
          ident: body.ident ?? '',
          assignee: body.assigneeId != null ? { name: 'Amy Pond', avatarUrl: null } : null,
        } satisfies TicketAssignResponse);
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
      // AI FIX (only when the spec asked for it): the tab's read, the CI-only picker, the session presses.
      if (aiFixOn) {
        const prFix = path.match(/^\/api\/pro\/prs\/(\d+)\/ai-fix(\/[a-z/]+)?$/);
        if (prFix) {
          const prId = Number(prFix[1]);
          const rest = prFix[2] ?? '';
          if (rest === '' && method === 'GET') {
            const body: AiFixResponse = {
              enabled: true,
              auth: 'ok',
              viewerCanPush: true,
              headInfo: {
                headSha: 'd'.repeat(40),
                headRef: 'feature/e2e-branch',
                headRepoFullName: REPO.fullName,
                isFork: false,
                maintainerCanModify: true,
                baseRef: 'main',
                canPushSameBranch: true,
                suggestedBranch: 'feature/e2e-branch-ai-fix',
              },
              fix: aiFix,
              history: [],
            };
            return json(route, body);
          }
          if (rest === '/preview') return json(route, opts.aiFixPreview ?? AI_FIX_PREVIEW);
          if (rest === '' && method === 'POST') {
            if (!runtime.available) return json(route, { error: 'NoRuntime', message: runtime.problem }, 409);
            aiFix = (opts.aiFixOnStart ?? aiFixBuilt)(prId);
            return json(route, { fixId: aiFix.id, status: 'queued' }, 202);
          }
          if (rest === '/plan' && method === 'POST') {
            aiFix = aiFixPlanned(prId);
            return json(route, { fixId: aiFix.id, status: 'queued' }, 202);
          }
          if (rest === '/cancel') return json(route, { status: 'cancelled' });
          if (rest === '/stream' || rest === '/status') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: `data: ${JSON.stringify({ type: 'done', status: aiFix?.status ?? 'idle', fixId: aiFix?.id ?? null })}\n\n` });
        }
        const fixRoute = path.match(/^\/api\/pro\/ai-fixes\/(\d+)\/([a-z/]+)$/);
        if (fixRoute && aiFix != null) {
          const what = fixRoute[2];
          if (what === 'session/stream') {
            const frames: SandboxSessionStreamEvent[] = aiFix.session == null || !aiFix.session.live ? [{ type: 'done' }] : [];
            return route.fulfill({ status: 200, contentType: 'text/event-stream', body: frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('') });
          }
          if (what === 'plan/approve') {
            const built = aiFixBuilt(aiFix.prId);
            aiFix = { ...built, session: { ...built.session!, conversation: [...aiFix.session!.conversation, ...built.session!.conversation] } };
            return json(route, { fixId: aiFix.id, status: 'queued' }, 202);
          }
          if (what === 'message') {
            const body = route.request().postDataJSON() as { text: string };
            const cur: AiFix = aiFix;
            const s = cur.session!;
            const n = s.conversation.length;
            aiFix = {
              ...cur,
              session: {
                ...s,
                spend: { ...s.spend, turns: s.spend.turns + 1 },
                conversation: [
                  ...s.conversation,
                  { kind: 'reader', id: `r${n}`, text: body.text, at: iso(0), build: s.mode === 'build' },
                  { kind: 'agent', id: `m-${n}`, text: 'Done. The report covers the whole change.', at: iso(0) },
                  { kind: 'turn', id: `e${n}`, turn: s.spend.turns + 1, mode: s.mode, outcome: 'completed', costUsd: 0.1, at: iso(0) },
                ],
              },
            };
            return json(route, { fixId: cur.id, status: 'queued' }, 202);
          }
          if (what === 'discard') {
            aiFix = { ...aiFix, status: 'cancelled', session: { ...aiFix.session!, phase: 'discarded', live: false, resumable: false } };
            return json(route, { status: 'discarded' });
          }
          if (what === 'resume') {
            aiFix = { ...aiFix, session: { ...aiFix.session!, live: true, resumable: false, agentState: 'ready' } };
            return json(route, { fixId: aiFix.id, status: 'queued' }, 202);
          }
          if (what === 'push') {
            // As the server: a fix with the merge pushes only a VALID merge, and only to the PR's own branch.
            const pushBody = route.request().postDataJSON() as { target?: string } | null;
            if (aiFix.merge != null && (aiFix.merge.status !== 'valid' || pushBody?.target !== 'existing'))
              return json(route, { error: 'NotPushable', message: 'Nothing is pushed.' }, 409);
            aiFix = { ...aiFix, pushedBranch: 'feature/e2e-branch', pushedAt: iso(0), session: { ...aiFix.session!, phase: 'pushed', live: false, resumable: false } };
            return json(route, { pushedBranch: 'feature/e2e-branch', commitSha: 'e'.repeat(40) });
          }
        }
        if (/^\/api\/prs\/\d+\/claude-review$/.test(path)) return json(route, { enabled: true, auth: 'ok', review: null, history: [] });
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
