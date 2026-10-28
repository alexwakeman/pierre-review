// WHO WROTE WHAT in a review (lib/reviewAuthor.ts), shared by the AI Review tab and AI Fix's picker:
// a pair is "Claude + Codex" as a whole, each finding names the half that raised it, and the thread
// judgements name the ONE half they came from.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend reviewAuthor
import { describe, expect, it } from 'vitest';
import type { ClaudeReview } from '@pierre-review/shared';
import { findingAuthorName, reviewByName, threadsByName } from '../src/lib/reviewAuthor.js';

type Who = Pick<ClaudeReview, 'provider' | 'model' | 'pair'>;
const half = (reviewId: number, provider: 'claude' | 'codex') => ({
  reviewId,
  provider,
  model: provider === 'codex' ? 'gpt-6.1-sol' : 'claude-opus-5-5',
  effort: null,
  status: 'succeeded' as const,
  costUsd: null,
  inputTokens: null,
  outputTokens: null,
});
// The view spreads the latest SUCCEEDED half: Codex here.
const pair = {
  provider: 'codex',
  model: 'gpt-6.1-sol',
  pair: { pairId: 10, role: 'second', otherReviewId: 10, halves: [half(10, 'claude'), half(11, 'codex')] },
} as Who;
const single = { provider: 'claude', model: 'claude-opus-5-5', pair: null } as unknown as Who;

describe('reviewAuthor', () => {
  it('a pair is "Claude + Codex"; a single run is its provider', () => {
    expect(reviewByName(pair)).toBe('Claude + Codex');
    expect(reviewByName(single)).toBe('Claude');
    expect(reviewByName(null)).toBe('Claude');
  });
  it('each finding names the half that raised it', () => {
    expect(findingAuthorName(pair, { reviewId: 10 })).toBe('Claude');
    expect(findingAuthorName(pair, { reviewId: 11 })).toBe('Codex');
    expect(findingAuthorName(single, { reviewId: 99 })).toBe('Claude');
  });
  it('the threads name the one half that judged them, never the pair', () => {
    expect(threadsByName(pair)).toBe('Codex');
    expect(threadsByName(single)).toBe('Claude');
  });
});
