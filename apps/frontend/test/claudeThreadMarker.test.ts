// Which pill a thread wears: its own derived state, or the latest Claude review's judgement in its
// place (lib/claudeThreadMarker.ts), plus the source guards that keep every surface on that ONE rule.
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
  claudeThreadVerdict,
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
    explanation: 'The null check was added.',
    assessedAtHead: HEAD,
    carried: false,
    ...extra,
  };
}

function pr(judgements: ClaudeThreadJudgement[], currentHeadSha: string | null = HEAD): ClaudeThreadJudgementsForPr {
  return {
    prId: 7,
    reviewId: 41,
    reviewedHeadSha: HEAD,
    finishedAt: '2026-10-12T10:00:00.000Z',
    currentHeadSha,
    judgements,
  };
}

const t = (id: number, derivedState: DerivedState) => ({ id, derivedState });

describe('the Threads tab state chips count what the cards show', () => {
  const threads = [t(1, 'likely_addressed'), t(2, 'likely_addressed'), t(3, 'untouched'), t(4, 'resolved'), t(5, 'replied_unresolved')];
  const judged = pr([
    judgement(1, 'valid', 'not_addressed'),
    judgement(3, 'not_valid', 'not_checked'),
    judgement(4, 'valid', 'addressed'),
  ]);

  it('a Claude-judged thread leaves its derived chip for "Claude judged"; resolved stays resolved', () => {
    expect(threadStateBucketCounts(threads, judged)).toEqual({
      likely_addressed: 1,
      untouched: 0,
      resolved: 1,
      replied_unresolved: 1,
      claude: 2,
    });
  });

  it('each chip holds exactly the threads whose card wears that pill', () => {
    for (const th of threads) {
      const pill = threadPillFor(th, judged);
      expect(threadStateBucket(th, judged)).toBe(pill.kind === 'claude' ? 'claude' : th.derivedState);
    }
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

  it('keeps the derived pills for a thread the review did not judge', () => {
    expect(threadPillFor(t(2, 'likely_addressed'), pr([judgement(1, 'valid', 'addressed')]))).toEqual({
      kind: 'derived',
    });
    // Both halves not_checked is no claim at all.
    expect(
      threadPillFor(t(1, 'likely_addressed'), pr([judgement(1, 'not_checked', 'not_checked')])),
    ).toEqual({ kind: 'derived' });
  });

  it('a resolved thread keeps "Resolved" whatever Claude said', () => {
    expect(threadPillFor(t(1, 'resolved'), pr([judgement(1, 'valid', 'not_addressed')]))).toEqual({
      kind: 'derived',
    });
  });

  it('replaces the pill for every judged state, whatever the heuristic said', () => {
    const cases: Array<[ClaudeThreadValidity, ClaudeThreadAddressed, string]> = [
      ['valid', 'addressed', 'Claude: addressed'],
      ['valid', 'not_addressed', 'Claude: not addressed'],
      ['partly_valid', 'partly_addressed', 'Claude: partly addressed'],
      ['not_valid', 'not_addressed', 'Claude: not valid'],
      ['not_valid', 'addressed', 'Claude: not valid'],
      ['valid', 'unclear', 'Claude: unsure'],
      ['not_checked', 'addressed', 'Claude: addressed'],
    ];
    for (const state of ['likely_addressed', 'untouched', 'replied_unresolved'] as const) {
      for (const [v, a, label] of cases) {
        const pill = threadPillFor(t(1, state), pr([judgement(1, v, a)]));
        expect(pill.kind).toBe('claude');
        if (pill.kind === 'claude') expect(pill.marker.label).toBe(label);
      }
    }
  });

  it('carries which run, the reason and the commit for the popover', () => {
    const pill = threadPillFor(t(1, 'untouched'), pr([judgement(1, 'valid', 'addressed')]));
    expect(pill).toMatchObject({
      kind: 'claude',
      marker: {
        verdict: 'addressed',
        reviewId: 41,
        finishedAt: '2026-10-12T10:00:00.000Z',
        assessedAtHead: HEAD,
        explanation: 'The null check was added.',
        stale: false,
      },
    });
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
    else throw new Error('expected a Claude marker');
  });
});

describe('claudeThreadVerdict', () => {
  it('not valid wins over any addressed answer', () => {
    expect(claudeThreadVerdict('not_valid', 'not_checked')).toBe('not_valid');
    expect(claudeThreadVerdict('not_valid', 'partly_addressed')).toBe('not_valid');
  });
  it('a validity answer alone is unsure about the code, not silent', () => {
    expect(claudeThreadVerdict('valid', 'not_checked')).toBe('unsure');
  });
  it('nothing judged is null', () => {
    expect(claudeThreadVerdict('not_checked', 'not_checked')).toBeNull();
  });
});

describe('every thread surface goes through the one rule', () => {
  const src = (p: string) => readFileSync(join(__dirname, '../src', p), 'utf8');
  it('ThreadCard and the Timeline popover render ThreadStatePill, not a bare StateBadge', () => {
    for (const p of ['components/ThreadView/ThreadCard.tsx', 'components/Timeline/MarkerPopover.tsx']) {
      const s = src(p);
      expect(s).toContain('<ThreadStatePill');
      expect(s).not.toContain('<StateBadge');
      expect(s).not.toContain('<ConfidenceBadge');
    }
  });
  it('the Threads tab filters and counts through threadStateBucket, never the bare derived state', () => {
    const list = src('components/ThreadList/index.tsx');
    expect(list).toContain('threadStateBucketCounts(threads, claudeJudgements)');
    expect(list).toContain('activeStates.has(threadStateBucket(t, claudeJudgements))');
    expect(list).not.toContain('activeStates.has(t.derivedState)');
  });

  it('the inline diff thread reads the same judgements', () => {
    expect(src('components/diff/FileDiffView.tsx')).toContain('threadPillFor(thread, useClaudeThreadJudgements(');
  });
});
