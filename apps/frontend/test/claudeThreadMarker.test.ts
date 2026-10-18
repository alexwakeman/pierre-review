// Which pills a thread wears: its own derived state, or the freshest Claude judgement as TWO pills
// (validity + state) in its place (lib/claudeThreadMarker.ts), plus the source guards that keep
// every surface on that ONE rule and ONE vocabulary.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/claudeThreadMarker.test.ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ClaudeThreadAddressed,
  ClaudeThreadJudgement,
  ClaudeThreadJudgementsForPr,
  ClaudeThreadValidity,
  DerivedState,
} from '@pierre-review/shared';
import {
  CLAUDE_STATE_LABEL,
  CLAUDE_VALIDITY_LABEL,
  claudeStatePill,
  claudeValidityPill,
  threadPillFor,
  threadStateBucket,
  threadStateBucketCounts,
} from '../src/lib/claudeThreadMarker.js';

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);

function judgement(
  threadId: number,
  validity: ClaudeThreadValidity,
  addressed: ClaudeThreadAddressed,
  extra: Partial<ClaudeThreadJudgement> = {},
): ClaudeThreadJudgement {
  return {
    threadId,
    validity,
    addressed,
    explanation: 'The null check was added in the second commit, after the comment.',
    reason: 'The null check was added.',
    resolved: false,
    assessedAtHead: HEAD,
    carried: false,
    ...extra,
  };
}

function pr(
  judgements: ClaudeThreadJudgement[],
  currentHeadSha: string | null = HEAD,
): ClaudeThreadJudgementsForPr {
  return {
    prId: 7,
    reviewId: 41,
    checkId: null,
    reviewedHeadSha: HEAD,
    finishedAt: '2026-10-12T10:00:00.000Z',
    currentHeadSha,
    judgements,
  };
}

const t = (id: number, derivedState: DerivedState) => ({ id, derivedState });

describe('the one vocabulary', () => {
  it('names validity in four words and leaves an unjudged comment without a pill', () => {
    expect(CLAUDE_VALIDITY_LABEL).toEqual({
      holds_up: 'Holds up',
      partly: 'Partly',
      doesnt_hold: 'Doesn’t hold',
      unclear: 'Unclear',
    });
    expect(claudeValidityPill('valid')).toBe('holds_up');
    expect(claudeValidityPill('partly_valid')).toBe('partly');
    expect(claudeValidityPill('not_valid')).toBe('doesnt_hold');
    expect(claudeValidityPill('unclear')).toBe('unclear');
    expect(claudeValidityPill('not_checked')).toBeNull();
  });

  it('names state in four words; the thread being resolved NOW always wins', () => {
    expect(CLAUDE_STATE_LABEL).toEqual({
      resolved: 'Resolved',
      addressed: 'Addressed',
      partly_addressed: 'Partly addressed',
      open: 'Open',
    });
    expect(claudeStatePill('addressed', false)).toBe('addressed');
    expect(claudeStatePill('partly_addressed', false)).toBe('partly_addressed');
    expect(claudeStatePill('not_addressed', false)).toBe('open');
    expect(claudeStatePill('unclear', false)).toBe('open');
    // Claude did not read the code: no state claim at all.
    expect(claudeStatePill('not_checked', false)).toBeNull();
    for (const a of ['addressed', 'not_addressed', 'unclear', 'not_checked'] as const) {
      expect(claudeStatePill(a, true)).toBe('resolved');
    }
  });
});

describe('the Threads tab state chips count what the cards show', () => {
  const threads = [
    t(1, 'likely_addressed'),
    t(2, 'likely_addressed'),
    t(3, 'untouched'),
    t(4, 'resolved'),
    t(5, 'replied_unresolved'),
  ];
  const judged = pr([
    judgement(1, 'valid', 'not_addressed'),
    judgement(3, 'not_valid', 'not_checked'),
    judgement(4, 'valid', 'addressed', { resolved: true }),
  ]);

  it('an unresolved judged thread leaves its derived chip for "Claude judged"; resolved stays resolved', () => {
    expect(threadStateBucketCounts(threads, judged)).toEqual({
      likely_addressed: 1,
      untouched: 0,
      resolved: 1,
      replied_unresolved: 1,
      claude: 2,
    });
  });

  it('a resolved judged thread wears the Claude pills and still reads "Resolved"', () => {
    const pill = threadPillFor(t(4, 'resolved'), judged);
    expect(pill.kind).toBe('claude');
    if (pill.kind === 'claude') expect(pill.marker.state).toBe('resolved');
    expect(threadStateBucket(t(4, 'resolved'), judged)).toBe('resolved');
  });

  it('unknown judgements change nothing', () => {
    expect(threadStateBucketCounts(threads, undefined)).toEqual({
      likely_addressed: 2,
      untouched: 1,
      resolved: 1,
      replied_unresolved: 1,
      claude: 0,
    });
  });
});

describe('threadPillFor', () => {
  it('keeps the derived pills while the judgements are unknown or there is no judged run', () => {
    expect(threadPillFor(t(1, 'likely_addressed'), undefined)).toEqual({ kind: 'derived' });
    expect(threadPillFor(t(1, 'likely_addressed'), null)).toEqual({ kind: 'derived' });
    expect(threadPillFor(t(1, 'untouched'), pr([]))).toEqual({ kind: 'derived' });
  });

  it('keeps the derived pills for a thread no run judged', () => {
    expect(threadPillFor(t(2, 'likely_addressed'), pr([judgement(1, 'valid', 'addressed')]))).toEqual({
      kind: 'derived',
    });
    // Both halves not_checked is no claim at all.
    expect(
      threadPillFor(t(1, 'likely_addressed'), pr([judgement(1, 'not_checked', 'not_checked')])),
    ).toEqual({ kind: 'derived' });
  });

  it('wears exactly two pills for every judged state, whatever the heuristic said', () => {
    const cases: Array<[ClaudeThreadValidity, ClaudeThreadAddressed, string]> = [
      ['valid', 'addressed', 'Holds up · Addressed'],
      ['valid', 'not_addressed', 'Holds up · Open'],
      ['partly_valid', 'partly_addressed', 'Partly · Partly addressed'],
      ['not_valid', 'not_addressed', 'Doesn’t hold · Open'],
      ['unclear', 'unclear', 'Unclear · Open'],
      // Only the code was judged: the state pill stands alone.
      ['not_checked', 'addressed', 'Addressed'],
      // Only the comment was judged: no state pill — "Open" would claim a code reading never made.
      ['not_valid', 'not_checked', 'Doesn’t hold'],
    ];
    for (const state of ['likely_addressed', 'untouched', 'replied_unresolved'] as const) {
      for (const [v, a, label] of cases) {
        const pill = threadPillFor(t(1, state), pr([judgement(1, v, a)]));
        expect(pill.kind).toBe('claude');
        if (pill.kind === 'claude') expect(pill.marker.label).toBe(label);
      }
    }
  });

  it('carries the one-line reason, the explanation, which run and the commit', () => {
    const pill = threadPillFor(t(1, 'untouched'), pr([judgement(1, 'valid', 'addressed')]));
    expect(pill).toMatchObject({
      kind: 'claude',
      marker: {
        validity: 'holds_up',
        state: 'addressed',
        reason: 'The null check was added.',
        explanation: 'The null check was added in the second commit, after the comment.',
        reviewId: 41,
        checkId: null,
        finishedAt: '2026-10-12T10:00:00.000Z',
        assessedAtHead: HEAD,
        stale: false,
      },
    });
  });

  it('an older judgement with no reason carries null, never an empty line', () => {
    const pill = threadPillFor(t(1, 'untouched'), pr([judgement(1, 'valid', 'addressed', { reason: '  ' })]));
    if (pill.kind === 'claude') expect(pill.marker.reason).toBeNull();
    else throw new Error('expected Claude pills');
  });

  it('marks a judgement made at an older head as from an earlier commit, still shown', () => {
    const pill = threadPillFor(
      t(1, 'likely_addressed'),
      pr([judgement(1, 'valid', 'not_addressed', { assessedAtHead: OLD, carried: true })]),
    );
    expect(pill.kind).toBe('claude');
    if (pill.kind === 'claude') expect(pill.marker.stale).toBe(true);
  });

  it('an unknown synced head never reads as moved', () => {
    const pill = threadPillFor(
      t(1, 'untouched'),
      pr([judgement(1, 'valid', 'addressed', { assessedAtHead: OLD })], null),
    );
    if (pill.kind === 'claude') expect(pill.marker.stale).toBe(false);
    else throw new Error('expected Claude pills');
  });
});

describe('every thread surface goes through the one rule', () => {
  const src = (p: string) => readFileSync(join(__dirname, '../src', p), 'utf8');
  it('ThreadCard and the Timeline popover render ThreadStatePill + the reason, not a bare StateBadge', () => {
    for (const p of ['components/ThreadView/ThreadCard.tsx', 'components/Timeline/MarkerPopover.tsx']) {
      const s = src(p);
      expect(s).toContain('<ThreadStatePill');
      expect(s).toContain('<ClaudeThreadReason');
      expect(s).not.toContain('<StateBadge');
      expect(s).not.toContain('<ConfidenceBadge');
    }
  });
  it('the Feed\'s collapsed thread row wears the same pills', () => {
    const s = src('components/Activity/FeedView.tsx');
    expect(s).toContain('<ThreadStatePill');
    expect(s).not.toContain('<StateBadge');
  });
  it('the Threads tab filters and counts through threadStateBucket, never the bare derived state', () => {
    const list = src('components/ThreadList/index.tsx');
    expect(list).toContain('threadStateBucketCounts(threads, claudeJudgements)');
    expect(list).toContain('activeStates.has(threadStateBucket(t, claudeJudgements))');
    expect(list).not.toContain('activeStates.has(t.derivedState)');
  });

  it('the inline diff thread reads the same judgements and pills', () => {
    const s = src('components/diff/FileDiffView.tsx');
    expect(s).toContain('threadPillFor(thread, useClaudeThreadJudgements(');
    expect(s).toContain('<ClaudeThreadPills');
  });

  it('the Claude Review tab\'s thread rows print the same words', () => {
    const s = src('components/ClaudeReviewThreads.tsx');
    expect(s).toContain('CLAUDE_VALIDITY_LABEL[');
    expect(s).toContain('CLAUDE_STATE_LABEL[');
    expect(s).not.toContain('THREAD_ADDRESSED_LABEL[');
  });
});
