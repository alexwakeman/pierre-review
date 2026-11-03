// The hidden metadata a posted review carries about HOW it ran (shared `limnReviewMarker`;
// docs/CLAUDE-REVIEW.md § Teammates' reviews). ONE builder for every post of a full review — the
// manual Post, auto-posting — so a teammate's Limn reads the same shape from each.
import { aiRunProvider, type ClaudeReview, type LimnReviewMeta } from '@pierre-review/shared';

export function limnMetaForReview(
  review: Pick<ClaudeReview, 'trigger' | 'provider' | 'model' | 'effort' | 'pair'>,
): Pick<LimnReviewMeta, 'run' | 'pair' | 'runs'> {
  const halves = review.pair?.halves ?? [];
  const pair = review.pair != null && halves.length > 1;
  return {
    run: review.trigger === 'auto' ? 'auto' : 'manual',
    pair,
    runs: pair
      ? halves.slice(0, 2).map((h) => ({ provider: h.provider, model: h.model, effort: h.effort ?? null }))
      : [{ provider: aiRunProvider(review.provider, review.model), model: review.model || null, effort: review.effort ?? null }],
  };
}
