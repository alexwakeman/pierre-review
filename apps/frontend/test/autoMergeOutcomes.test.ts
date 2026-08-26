// The global auto-merge stack's POLL FOLD — which armed intents just resolved, and which older
// rows that supersedes.
//
// What this pins (and why it exists): the capture used to be keyed `${prId}:${state}`, on the
// theory that a re-arm after a dismissal "must show the new run". But a PR reaches the SAME
// terminal state twice routinely — arm, a teammate pushes ('disarmed_head_moved'), re-arm on the
// new head, the branch moves again — and the list keeps resolved rows for 24h, so both captures
// live in one page's state. That pair shared ONE React key (duplicate-key warning, two rows for
// one PR) and one dismissal key, so dismissing the first run permanently silenced the second —
// the exact contract the key was written to protect. Every capture now carries its own id, and a
// newer capture (or a re-arm) supersedes the PR's older row: ONE CARD PER MERGE.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import type { ArmedMergeRequest, ArmedMergeState } from '@pierre-review/shared';
import { foldArmedPoll } from '../src/components/AutoMergeBanner.js';

function row(prId: number, state: ArmedMergeState, over: Partial<ArmedMergeRequest> = {}) {
  return {
    prId,
    repoOwner: 'acme',
    repoName: 'api',
    prNumber: 400 + prId,
    prTitle: `PR ${prId}`,
    mergeMethod: 'squash',
    updateStrategy: 'none',
    viaMergeQueue: false,
    enqueuedAt: null,
    armedAt: '2026-08-26T10:00:00.000Z',
    expectedHeadOid: 'aaaaaaa',
    state,
    lastCheckedAt: '2026-08-26T10:01:00.000Z',
    lastReason: null,
    phase: null,
    expiresAt: '2026-08-29T10:00:00.000Z',
    ...over,
  } as ArmedMergeRequest;
}

const seen = (...pairs: [number, ArmedMergeState][]): Map<number, ArmedMergeState> =>
  new Map(pairs);

describe('foldArmedPoll', () => {
  it('captures a transition out of armed into a terminal state', () => {
    const fold = foldArmedPoll(seen([412, 'armed']), [row(412, 'merged')]);
    expect(fold.fresh.map((f) => f.state)).toEqual(['merged']);
    expect(fold.landed).toBe(true);
    expect(fold.fresh[0]?.repoFullName).toBe('acme/api');
  });

  it('skips an intent it never saw ARMED — a row already resolved when the tab loaded', () => {
    // Without a prior 'armed' observation, "resolved between two polls" and "resolved two hours
    // ago" are indistinguishable, and the second must not raise a toast on load.
    const fold = foldArmedPoll(seen(), [row(412, 'merged')]);
    expect(fold.fresh).toEqual([]);
    expect(fold.landed).toBe(false);
  });

  it('`landed` fires only for a real merge, not for any terminal', () => {
    const fold = foldArmedPoll(seen([412, 'armed']), [row(412, 'disarmed_head_moved')]);
    expect(fold.fresh).toHaveLength(1);
    expect(fold.landed).toBe(false);
  });

  // ── the identity rule ─────────────────────────────────────────────────────────────────────
  it('gives the SAME PR reaching the SAME terminal state twice two DISTINCT ids', () => {
    // arm → the branch moves → re-arm on the new head → it moves again. Both captures are alive
    // in one page's `outcomes`; a shared key would collide as a React key and let one dismissal
    // suppress both.
    const first = foldArmedPoll(seen([412, 'armed']), [row(412, 'disarmed_head_moved')]);
    const second = foldArmedPoll(seen([412, 'armed']), [row(412, 'disarmed_head_moved')]);
    expect(first.fresh[0]?.id).not.toBe(second.fresh[0]?.id);
  });

  it('gives two PRs resolving in ONE poll distinct ids', () => {
    const fold = foldArmedPoll(seen([412, 'armed'], [77, 'armed']), [
      row(412, 'merged'),
      row(77, 'expired'),
    ]);
    expect(new Set(fold.fresh.map((f) => f.id)).size).toBe(2);
  });

  // ── ONE CARD PER MERGE ────────────────────────────────────────────────────────────────────
  it('supersedes the PR’s older row when a NEW outcome is captured', () => {
    const fold = foldArmedPoll(seen([412, 'armed']), [row(412, 'disarmed_head_moved')]);
    expect(fold.superseded.has(412)).toBe(true);
  });

  it('supersedes a captured outcome the moment the PR is ARMED again', () => {
    // The old terminal stopped being news on the re-arm: the live row is the whole story now,
    // and showing both would put one PR on two rows of a four-row stack.
    const fold = foldArmedPoll(seen([412, 'disarmed_head_moved']), [row(412, 'armed')]);
    expect(fold.fresh).toEqual([]);
    expect(fold.superseded.has(412)).toBe(true);
  });

  it('supersedes nothing while an unrelated PR is armed', () => {
    const fold = foldArmedPoll(seen([77, 'armed']), [row(77, 'armed')]);
    expect(fold.fresh).toEqual([]);
    expect(fold.superseded).toEqual(new Set([77]));
  });
});
