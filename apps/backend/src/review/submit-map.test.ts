// mapSubmittedReview — the anchoring loop moved out of agent.ts, plus the follow-up / user-story
// pass-through. The anchoring half is the load-bearing posting input (anchored / fileInDiff /
// diffHunk), so this pins it against post-review.ts's own helpers on a small diff.
import { describe, expect, it } from 'vitest';
import type { SubmitReviewPayload } from './schema.js';
import { buildAnchorIndex, extractHunk, isFindingAnchored } from './post-review.js';
import { mapSubmittedReview } from './submit-map.js';

const DIFF = [
  'diff --git a/src/foo.ts b/src/foo.ts',
  'index 1111111..2222222 100644',
  '--- a/src/foo.ts',
  '+++ b/src/foo.ts',
  '@@ -10,3 +10,4 @@',
  ' const a = 1;',
  '+const added = 2;',
  '-const removed = 3;',
  ' const b = 4;',
].join('\n');

const payload = (over: Partial<SubmitReviewPayload> = {}): SubmitReviewPayload => ({
  summary: 'sum',
  verdict: 'COMMENT',
  scopeUsed: 'diff_only',
  findings: [
    { path: 'src/foo.ts', line: 11, side: 'RIGHT', severity: 'warning', title: 'anchored', body: 'b' },
    { path: 'src/foo.ts', line: 99, severity: 'nit', title: 'off the diff', body: 'b', priorRef: 'P2' },
    { path: 'src/other.ts', severity: 'question', title: 'outside', body: 'b', suggestion: 'x' },
    { path: 'src/foo.ts', line: 11, side: 'LEFT', severity: 'blocker', title: 'left', body: 'b', priorRef: null },
  ],
  ...over,
});

describe('mapSubmittedReview', () => {
  it('anchors exactly as the old inline loop did', () => {
    const out = mapSubmittedReview(payload(), DIFF);
    const index = buildAnchorIndex(DIFF);
    for (const [i, f] of payload().findings.entries()) {
      const side = f.side === 'LEFT' ? 'LEFT' : 'RIGHT';
      const line = f.line ?? null;
      const got = out.findings[i]!;
      expect(got.side).toBe(side);
      expect(got.line).toBe(line);
      expect(got.anchored).toBe(isFindingAnchored(index, f.path, line, side));
      expect(got.fileInDiff).toBe(index.has(f.path));
      expect(got.diffHunk).toBe(extractHunk(DIFF, f.path, line, side));
      expect(got.suggestion).toBe(f.suggestion ?? null);
    }
    // Sanity, so the loop above is not comparing nothing to nothing.
    expect(out.findings[0]!.anchored).toBe(true);
    expect(out.findings[1]!.anchored).toBe(false);
    expect(out.findings[2]!.fileInDiff).toBe(false);
  });

  it('carries priorRef through (null when absent)', () => {
    const out = mapSubmittedReview(payload(), DIFF);
    expect(out.findings.map((f) => f.priorRef)).toEqual([null, 'P2', null, null]);
  });

  it('passes followUp and ticket through verbatim, and omits them when absent', () => {
    const followUp = [{ ref: 'P1', status: 'addressed' as const, explanation: 'Fixed.' }];
    const ticket = { alignment: 'aligned' as const, summary: 'Matches.', criteria: [] };
    const withBoth = mapSubmittedReview(payload({ followUp, ticket }), DIFF);
    expect(withBoth.followUp).toEqual(followUp);
    expect(withBoth.ticket).toEqual(ticket);
    const without = mapSubmittedReview(payload(), DIFF);
    expect('followUp' in without).toBe(false);
    expect('ticket' in without).toBe(false);
    expect(without).toMatchObject({ scope: 'diff_only', summary: 'sum', verdict: 'COMMENT' });
  });
});
