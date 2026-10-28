// WHO WROTE WHAT in a review, for every surface that shows one (the AI Review tab, AI Fix's picker):
// one rule, so the two never drift.
//   • the review as a whole: its provider, or "Claude + Codex" for a pair's ONE consolidated review;
//   • a finding: the provider of the half that raised it (its own text is that half's);
//   • the thread judgements: the provider of the ONE half they come from (the view's own provider —
//     pair-view.ts spreads the latest SUCCEEDED half), never the pair label.
import {
  aiProviderName,
  aiRunProviderName,
  PAIR_RUN_LABEL,
  type AiProviderName,
  type ClaudeReview,
} from '@pierre-review/shared';

type ReviewWho = Pick<ClaudeReview, 'provider' | 'model' | 'pair'>;

/** The review's author: "Claude" / "Codex", or "Claude + Codex" for a pair. */
export function reviewByName(review: ReviewWho | null | undefined): string {
  return review?.pair != null ? PAIR_RUN_LABEL : aiRunProviderName(review);
}

/** A finding's author: the half that raised it, else the review's own provider. */
export function findingAuthorName(review: ReviewWho | null | undefined, finding: { reviewId: number }): AiProviderName {
  const half = review?.pair?.halves?.find((h) => h.reviewId === finding.reviewId);
  return half != null ? aiProviderName(half.provider) : aiRunProviderName(review);
}

/** Who judged the review's threads: one provider, the half they were taken from. */
export function threadsByName(review: ReviewWho | null | undefined): AiProviderName {
  return aiRunProviderName(review);
}
