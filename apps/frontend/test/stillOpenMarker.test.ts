// STILL-OPEN POINTS ON THE THREAD CARDS AND THE OVERVIEW (docs/CLAUDE-REVIEW.md § Still-open points):
// a teammate's Limn's still-open wears ONE labelled pill and leads the reason; a thread only a
// teammate's Limn judged wears that pill alone (never the reader's validity/state words); the
// Overview's "Still open" list puts unresolved first.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/stillOpenMarker.test.ts
import { describe, expect, it } from 'vitest';
import type { ClaudeThreadJudgement, ClaudeThreadJudgementsForPr, ClaudeThreadStillOpen } from '@pierre-review/shared';
import { stillOpenLabel } from '@pierre-review/shared';
import { stillOpenPoints, threadPillFor, threadStateBucket } from '../src/lib/claudeThreadMarker.js';

const HEAD = 'a'.repeat(40);
const robin = { you: false as const, login: 'robin-dunn', name: 'Robin Dunn' };

function so(over: Partial<ClaudeThreadStillOpen> = {}): ClaudeThreadStillOpen {
  return {
    by: robin,
    reason: 'The null case is still not handled.',
    at: '2026-11-05T09:00:00.000Z',
    headSha: HEAD,
    severity: 'warning',
    path: 'src/a.ts',
    line: 4,
    threadResolved: false,
    ...over,
  };
}

function j(threadId: number, over: Partial<ClaudeThreadJudgement> = {}): ClaudeThreadJudgement {
  return {
    threadId,
    validity: 'valid',
    addressed: 'not_addressed',
    explanation: null,
    reason: 'Mine.',
    resolved: false,
    assessedAtHead: HEAD,
    carried: false,
    ...over,
  };
}

function pr(judgements: ClaudeThreadJudgement[]): ClaudeThreadJudgementsForPr {
  return { prId: 1, reviewId: 7, checkId: null, reviewedHeadSha: HEAD, finishedAt: null, currentHeadSha: HEAD, judgements };
}

describe("a teammate's still-open on a thread", () => {
  it('labels the owner by first name', () => {
    expect(stillOpenLabel(robin)).toBe('Robin’s Limn: still open');
    expect(stillOpenLabel({ you: false, login: 'robin-dunn', name: null })).toBe('robin-dunn’s Limn: still open');
    expect(stillOpenLabel({ you: true })).toBe('Your Limn: still open');
  });

  it('only a teammate judged it: the one pill, never the reader’s validity / state words', () => {
    const pill = threadPillFor({ id: 1, derivedState: 'untouched' }, pr([j(1, { teammateOnly: true, stillOpen: so() })]));
    expect(pill.kind).toBe('claude');
    if (pill.kind !== 'claude') return;
    expect(pill.marker.validity).toBeNull();
    expect(pill.marker.state).toBeNull();
    expect(pill.marker.stillOpen).toEqual({ label: 'Robin’s Limn: still open', reason: 'The null case is still not handled.' });
    expect(threadStateBucket({ id: 1, derivedState: 'untouched' }, pr([j(1, { teammateOnly: true, stillOpen: so() })]))).toBe('claude');
  });

  it("beside the reader's own judgement: both pills plus the teammate's label", () => {
    const pill = threadPillFor({ id: 1, derivedState: 'untouched' }, pr([j(1, { stillOpen: so() })]));
    if (pill.kind !== 'claude') throw new Error('expected a claude pill');
    expect(pill.marker.validity).toBe('holds_up');
    expect(pill.marker.stillOpen?.label).toBe('Robin’s Limn: still open');
  });

  it("the reader's own still-open adds no extra pill (the pills say it)", () => {
    const pill = threadPillFor({ id: 1, derivedState: 'untouched' }, pr([j(1, { stillOpen: so({ by: { you: true } }) })]));
    if (pill.kind !== 'claude') throw new Error('expected a claude pill');
    expect(pill.marker.stillOpen).toBeNull();
  });
});

describe('the Overview list', () => {
  it('unresolved first, then newest', () => {
    const list = stillOpenPoints(
      pr([
        j(1, { stillOpen: so({ threadResolved: true, at: '2026-11-05T12:00:00.000Z' }) }),
        j(2, { stillOpen: so({ at: '2026-11-04T09:00:00.000Z' }) }),
        j(3),
        j(4, { stillOpen: so({ at: '2026-11-05T10:00:00.000Z' }) }),
      ]),
    );
    expect(list.map((p) => p.threadId)).toEqual([4, 2, 1]);
    expect(stillOpenPoints(null)).toEqual([]);
  });
});
