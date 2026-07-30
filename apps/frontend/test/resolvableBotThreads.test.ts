// The PR-detail bulk-resolve target set.
//
// The regression this pins: the button offers a COUNT and then asks the user to confirm
// resolving exactly that many threads on GitHub, but the client derived the set from the vendor
// LOGIN (`reviewBotKind`) while `POST /api/prs/:id/resolve-bot-threads` re-derives it from
// `bot_review_classification` via `automatedReviewerUserIds(accountId, NO_TEAM_KEY, 'review')`.
// Once a login is marked "quality check" (which the shared type deliberately keeps flippable for
// deepsource-io / github-code-quality / github-advanced-security, all of which stay in
// REVIEW_BOTS) or "not a bot", the server drops it and answers {resolved:0,failed:0} — and the
// result banner only renders when something was resolved, so the confirm collapsed and the same
// count reappeared. A dead button with no explanation.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import type { ThreadDetail, User } from '@pierre-review/shared';
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
    // Same divergence, older trigger: automatedReviewerUserIds deletes a manual human override.
    expect(
      resolvableBotThreadIds(threads, users, 'deepsource', roles({ automated: false })),
    ).toEqual([]);
  });

  it('falls back to the vendor login when the classification has not loaded / has no row', () => {
    // Absent data must not SHRINK the offer: the server's own fallback for an unclassified
    // known vendor is the login, so excluding here would hide threads it would have accepted.
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
