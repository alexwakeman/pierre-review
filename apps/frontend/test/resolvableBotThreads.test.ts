// The PR-detail bulk-resolve target set.
//
// The regression this exists for: the button states a COUNT and then asks the user to confirm
// resolving exactly that many threads on GitHub, but the client derived the set from the vendor
// LOGIN (`reviewBotKind`) while `POST /api/prs/:id/resolve-bot-threads` re-derives it from the
// STORED JUDGEMENT. Once a login is marked "quality check" (which the shared type deliberately
// keeps flippable for deepsource-io / github-code-quality / github-advanced-security, all of which
// stay in REVIEW_BOTS) or "not a bot", the server drops it and answers {resolved:0,failed:0} — and
// the result banner only renders when something was resolved, so the confirm collapsed and the
// same count reappeared. A dead button with no explanation.
//
// ── THE GRAIN THE TWO SIDES MUST AGREE AT IS NOW THE WORKSPACE ─────────────────────────────────
// A bot object is one `workspace_reviewers` row keyed (account, WORKSPACE, actor), so the server
// re-derives eligibility from the workspace THE PR'S REPO BELONGS TO. Two consequences, and both
// are pinned below:
//
//   1. `classification` must be one workspace's listing — a plain userId → judgement lookup, with
//      no per-repo rows left to fold. (Under the old per-repo grain this map was built by
//      filtering `rows` to the PR's own `repoId`.)
//   2. It must be the PR'S workspace, not the SELECTED one. A PR can be open from another
//      workspace via `?pr=<id>`, a restored `pierre:tabs` entry or a search hit; building the
//      offer from `filters.workspaceId` then reads workspace X's judgements while the resolve
//      evaluates workspace Y's — the identical dead-button failure, reintroduced.
//
// ⚠ WHAT THIS FILE CANNOT REACH. (2) is decided in `ThreadList/index.tsx`, which looks the PR's
// repo up in `useRepos()` and passes `repo.workspaceId` to `useDetectedReviewers` — a component
// `useMemo`, not an exported function. What IS testable here is that the choice MATTERS: the same
// threads, the same vendor lens and two different workspaces' listings produce two different
// offers, so a wrong workspace is a wrong count and not a harmless one.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import type { ThreadDetail, User, WorkspaceReviewer } from '@pierre-review/shared';
import {
  resolvableBotThreadIds,
  type ReviewerRoleInfo,
} from '../src/components/ThreadList/resolvable.js';

const BOT_ID = 7; // deepsource-io — a REVIEW_BOTS vendor, so reviewBotKind() classifies it
const HUMAN_ID = 8;

const users = new Map<number, User>([
  [BOT_ID, { id: BOT_ID, githubLogin: 'deepsource-io', displayName: null, avatarUrl: null, isBot: true }],
  [HUMAN_ID, { id: HUMAN_ID, githubLogin: 'alex', displayName: null, avatarUrl: null, isBot: false }],
]);

const thread = (id: number, authorId: number, over: Partial<ThreadDetail> = {}): ThreadDetail => ({
  id,
  prId: 1,
  path: 'src/a.ts',
  line: 1,
  isResolved: false,
  isOutdated: false,
  derivedState: 'likely_addressed',
  addressedConfidence: 'high',
  addressedReason: null,
  originalCommenterId: authorId,
  createdAt: '2026-07-01T00:00:00.000Z',
  comments: [],
  url: null,
  ...over,
});

const roles = (over: Partial<ReviewerRoleInfo>): Map<number, ReviewerRoleInfo> =>
  new Map([[BOT_ID, { automated: true, role: 'review', ...over }]]);

describe('resolvableBotThreadIds', () => {
  const threads = [thread(1, BOT_ID), thread(2, BOT_ID), thread(3, HUMAN_ID)];

  it('offers a review-roled vendor’s likely-addressed threads', () => {
    expect(resolvableBotThreadIds(threads, users, 'deepsource', roles({}))).toEqual([1, 2]);
  });

  it('offers NOTHING once that vendor is marked a quality check — the server refuses them', () => {
    // The bug: classifying by login alone still returned [1, 2] here.
    expect(
      resolvableBotThreadIds(threads, users, 'deepsource', roles({ role: 'quality_check' })),
    ).toEqual([]);
  });

  it('offers nothing once the vendor is marked "not a bot"', () => {
    // Same divergence, older trigger: the server's automated-reviewer set excludes a manual
    // human override, so every offered thread is refused.
    expect(
      resolvableBotThreadIds(threads, users, 'deepsource', roles({ automated: false })),
    ).toEqual([]);
  });

  it('falls back to the vendor login when the classification has not loaded / has no row', () => {
    // Absent data must not SHRINK the offer: the server's own fallback for an unclassified
    // known vendor is the login, so excluding here would hide threads it would have accepted.
    // `null` is also the "no workspace in hand" state (a thread list rendered without a repoId,
    // or before useRepos() lands), which must behave the same way.
    expect(resolvableBotThreadIds(threads, users, 'deepsource', null)).toEqual([1, 2]);
    expect(resolvableBotThreadIds(threads, users, 'deepsource', new Map())).toEqual([1, 2]);
  });

  it('never offers a human’s thread, or one that is resolved / not likely-addressed', () => {
    expect(resolvableBotThreadIds([thread(9, HUMAN_ID)], users, null, roles({}))).toEqual([]);
    expect(
      resolvableBotThreadIds([thread(9, BOT_ID, { isResolved: true })], users, null, roles({})),
    ).toEqual([]);
    expect(
      resolvableBotThreadIds(
        [thread(9, BOT_ID, { derivedState: 'untouched' })],
        users,
        null,
        roles({}),
      ),
    ).toEqual([]);
  });

  it('honours the vendor lens', () => {
    expect(resolvableBotThreadIds(threads, users, 'coderabbit', roles({}))).toEqual([]);
  });
});

// ── The grain, stated as data ──────────────────────────────────────────────────────────────────
// Mirrors the map ThreadList builds from `DetectedReviewersResponse.reviewers`: one row per actor,
// nothing to fold. (`useMemo` in ThreadList/index.tsx — kept as a one-liner there precisely
// because there is no longer any per-repo filtering to get wrong.)
function rolesFromListing(reviewers: readonly WorkspaceReviewer[]): Map<number, ReviewerRoleInfo> {
  const m = new Map<number, ReviewerRoleInfo>();
  for (const r of reviewers) m.set(r.userId, { automated: r.automated, role: r.role });
  return m;
}

function listedBot(workspaceId: number, over: Partial<WorkspaceReviewer>): WorkspaceReviewer {
  return {
    workspaceId,
    userId: BOT_ID,
    login: 'deepsource-io',
    displayName: null,
    avatarUrl: null,
    automated: true,
    role: 'review',
    confidence: 'high',
    source: 'vendor_login',
    reasons: [],
    isManualOverride: false,
    kind: 'deepsource',
    label: 'DeepSource',
    identitySource: 'auto',
    costMonthlyUsd: null,
    costModel: 'flat',
    effectiveMonthlyUsd: null,
    footprint: { reviews: 1, threads: 2, comments: 0, lastActiveAt: null },
    repoFootprints: [{ repoId: 1, reviews: 1, threads: 2, comments: 0, lastActiveAt: null }],
    sampleReviewBody: null,
    ...over,
  };
}

describe('the offer is derived at the SAME grain the server re-derives at', () => {
  const threads = [thread(1, BOT_ID), thread(2, BOT_ID)];

  // ONE row per actor per workspace — so the map the caller builds is a plain lookup and the
  // client's rule is `automated && role === 'review'`, exactly the server's.
  it('one workspace’s listing is a plain userId → judgement lookup, with nothing to fold', () => {
    const listing = [listedBot(3, {})];
    const m = rolesFromListing(listing);
    expect(m.size).toBe(1);
    expect(resolvableBotThreadIds(threads, users, 'deepsource', m)).toEqual([1, 2]);
  });

  // ⚠ THE POINT. Workspace 3 calls this vendor a reviewer; workspace 4 calls it a quality check.
  // Both listings are well-formed and neither is "stale" — they are answers to different
  // questions. Whichever one the client fetches is the count it offers, and the server will
  // evaluate the PR's OWN workspace regardless: fetch the wrong one and the button is dead again.
  it('two workspaces give two different offers for the same threads', () => {
    const inThree = rolesFromListing([listedBot(3, { role: 'review' })]);
    const inFour = rolesFromListing([listedBot(4, { role: 'quality_check' })]);
    expect(resolvableBotThreadIds(threads, users, 'deepsource', inThree)).toEqual([1, 2]);
    expect(resolvableBotThreadIds(threads, users, 'deepsource', inFour)).toEqual([]);
  });

  // The same divergence via the other provenance flag, because "not a bot" and "quality check"
  // are independent edits and either one, made in the wrong workspace, produces the same dead
  // control.
  it('…including when the difference is "not a bot" rather than the role', () => {
    const inFour = rolesFromListing([
      listedBot(4, { automated: false, isManualOverride: true, source: 'manual' }),
    ]);
    expect(resolvableBotThreadIds(threads, users, 'deepsource', inFour)).toEqual([]);
  });
});
