import type { Page, Route } from '@playwright/test';
import type {
  AwaitingReviewItem,
  FeedEvent,
  MeResponse,
  MyTurnResponse,
  OpenPrsResponse,
  PrDetail,
  Repo,
  TimelineEvent,
  TimelinePr,
  TimelineResponse,
  User,
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
  pr(104, 104, BOB.id, 'Other: bump deps', 2),
  pr(105, 105, ALICE.id, 'Other: docs pass', 1),
];
const INBOX_IDS = [101, 102, 103];

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

const TIMELINE: TimelineResponse = { prs: PRS, events: EVENTS };
const OPEN_PRS: OpenPrsResponse = { prs: PRS };

const ME_RESPONSE: MeResponse = {
  user: { login: ME.githubLogin, githubId: 'MDQ6VXNlcjE=', avatarUrl: null },
  counts: {
    awaitingReview: INBOX_IDS.length,
    yourPrsActivity: 0,
    threadsAwaiting: 0,
    watchedRepoPrs: 0,
    claudeReviewsToAction: 0,
  },
  claudeReviewEnabled: false,
  deploymentMode: 'local',
};

const MY_TURN: MyTurnResponse = {
  awaitingReview: INBOX_IDS.map((id): AwaitingReviewItem => {
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
      alsoRequested: 0,
    };
  }),
  yourPrs: [],
  threadsAwaiting: [],
  watchedRepoPrs: [],
  claudeReviewsToAction: [],
  users: USERS,
};

// Feed entries reference the NON-inbox PRs so a Feed click is clearly a full-board
// navigation (not an inbox open).
const FEED: { events: FeedEvent[]; users: User[] } = {
  events: [104, 105].map((id, i) => {
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
  users: USERS,
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

      if (path.endsWith('/api/me')) return json(route, ME_RESPONSE);
      if (path.endsWith('/api/my-turn')) return json(route, MY_TURN);
      if (path.includes('/api/timeline')) return json(route, TIMELINE);
      if (path.includes('/api/open-prs')) return json(route, OPEN_PRS);
      if (path.endsWith('/api/users')) return json(route, USERS);
      if (path.endsWith('/api/repos')) return json(route, [REPO]);
      if (path.endsWith('/api/mergers')) return json(route, []);
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

export const fixtures = { PRS, INBOX_IDS, REPO, USERS, FEED };
