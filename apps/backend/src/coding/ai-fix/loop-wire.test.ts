// The AI Fix loop wire (pure): a round's place in ITS run comes from the stored step/rounds, so a reader's
// follow-up runs (contiguous round numbers) never read as "Round 6" or a closing review.
import { describe, expect, it } from 'vitest';
import { toAiFixLoop } from './loop-wire.js';
import type { FixLoopReviewRow } from './loop-persist.js';

const review = (id: number, round: number, step: number | null, rounds: number | null): FixLoopReviewRow => ({
  id,
  accountId: 1,
  fixId: 9,
  round,
  repoId: 1,
  baseSha: 'b'.repeat(40),
  headSha: String(round % 10).repeat(40),
  localRef: null,
  workKey: null,
  provider: 'claude',
  model: 'm',
  effort: null,
  pairRole: null,
  step,
  rounds,
  status: 'succeeded',
  reviewMode: 'diff_only',
  summary: null,
  verdict: 'APPROVE',
  followUp: null,
  pairConsolidation: null,
  failureReason: null,
  costUsd: null,
  inputTokens: null,
  outputTokens: null,
  numTurns: null,
  createdAt: null,
  completedAt: null,
  targetKind: 'fix',
  targetId: 0,
});

describe('toAiFixLoop: a round’s place in its run', () => {
  it('three contiguous runs (3 + 3 + current): the middle run’s rounds are steps 1..3, its closing one flagged by ITS N', () => {
    // Run 1: rounds 1-3 (N=2: steps 1, 2, closing 3). Run 2: rounds 4-6 (N=5, ended clean at step 3). Run 3: 7.. (N=5).
    const reviews = [review(1, 1, 1, 2), review(2, 2, 2, 2), review(3, 3, 3, 2), review(4, 4, 1, 5), review(5, 5, 2, 5), review(6, 6, 3, 5), review(7, 7, 1, 5)];
    const w = toAiFixLoop({
      fix: { loopState: 'done', loopRound: 7, loopFirstRound: 7, loopRounds: 5, loopStop: 'clean', loopReviewId: null },
      reviews,
      findings: [],
      checks: [],
      acResponses: [],
      running: false,
    })!;
    expect(w.history.map((h) => [h.round, h.step, h.closing])).toEqual([
      [1, 1, false],
      [2, 2, false],
      [3, 3, true],
      [4, 1, false],
      [5, 2, false],
      [6, 3, false],
      [7, 1, false],
    ]);
  });
});
