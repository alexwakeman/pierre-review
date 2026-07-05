import type { Page, Route } from '@playwright/test';
import type {
  AwaitingReviewItem,
  ConsolidatedFeedItem,
  ConsolidatedFeedResponse,
  FeedEvent,
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
  inboxWatch: true,
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
  counts: {
    awaitingReview: AWAITING_IDS.length,
    yourPrsActivity: 0,
    approvedPrs: 0,
    threadsAwaiting: 0,
    watchedRepoPrs: WATCHED_IDS.length,
    claudeReviewsToAction: 0,
  },
  deploymentMode: 'local',
  // Pro off in e2e — the consolidated Feed (core) renders without the AI digest panel.
  // Claude Review is now a Pro capability (claudeReview) rather than a top-level flag.
  pro: { activityDigest: false, reviewMemory: false, claudeReview: false },
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
};

// Feed entries; the first references a non-inbox board PR, so clicking it is clearly a
// full-board navigation (never an inbox/focus open) regardless of inbox membership.
const FEED: { events: FeedEvent[]; users: User[] } = {
  events: [
    ...[105, 104].map((id, i): FeedEvent => {
      const p = PRS.find((x) => x.id === id)!;
      return {
        id: 7000 + i,
        type: 'pr_opened',
        occurredAt: p.openedAt,
        repoId: REPO.id,
        repoFullName: REPO.fullName,
        prId: p.id,
        prNumber: p.number,
        prTitle: p.title,
        prState: p.state,
        actorId: p.authorId,
        refId: p.id,
        reviewState: null,
        excerpt: null,
      };
    }),
    // The two MARKER feed items (mirror MARKER_EVENTS by id). A feed click on these opens
    // the popover; the cross-person one (8001) also enters PR Focus.
    ...MARKER_EVENTS.map((e): FeedEvent => {
      const p = PRS.find((x) => x.id === e.prId)!;
      return {
        id: e.id,
        type: e.type,
        occurredAt: e.occurredAt,
        repoId: REPO.id,
        repoFullName: REPO.fullName,
        prId: p.id,
        prNumber: p.number,
        prTitle: p.title,
        prState: p.state,
        actorId: e.actorId,
        refId: e.refId,
        reviewState: e.reviewState,
        excerpt: e.type === 'pr_comment' ? 'a standalone PR comment' : null,
      };
    }),
  ],
  users: USERS,
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
    viewerCanApprove: false,
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

      if (path.endsWith('/api/me')) return json(route, ME_RESPONSE);
      if (path.endsWith('/api/my-turn')) return json(route, MY_TURN);
      // The consolidated Feed (new) — MUST precede the generic `/api/feed` check below,
      // since `/api/activity/feed` also contains the substring `/api/feed`.
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
      if (path.includes('/api/feed')) return json(route, FEED);
      if (prDetailMatch) return json(route, prDetailFor(Number(prDetailMatch[1])));
      // mark-viewed, my-turn-done, insights, and anything else: a harmless empty 200.
      if (path.includes('/api/my-turn-done') || path.includes('/dismiss-history')) {
        return json(route, { reviews: [], threads: [], watchedRepoPrs: [], claudeReviews: [], users: [] });
      }
      return json(route, {});
    },
  );
}

export const fixtures = { PRS, INBOX_IDS, REPO, USERS, FEED, CONSOLIDATED_FEED, ACTIVITY };
