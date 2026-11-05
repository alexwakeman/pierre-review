import type { AiReviewCard } from '@pierre-review/shared';

// PENDING → "AI REVIEWS": THE LAST-LOOKED STAMP, SPA HALF (docs/FRONTEND.md § The AI reviews list).
// Pure, for test/aiReviewsSeen.test.ts; the hook is hooks/useAiReviewsSeen.ts.
//
// The list is a STABLE REFERENCE (the newest AI review per PR): looking never removes a row. The
// workspace's stamp only decides which rows wear "New" — against the stamp the VISIT started with,
// so a tag does not vanish while the reader reads — and the tab's badge (`PendingTab.newTotal`).

/** Is this row newer than the reader's last look? `baseline` null = never looked: every row is. */
export function isNewAiReview(card: Pick<AiReviewCard, 'at'>, baseline: number | null): boolean {
  return baseline == null || Date.parse(card.at) > baseline;
}

/**
 * The stamp to send after a response, or null to send nothing: the newest row's time, only when it
 * is newer than BOTH the response's own stamp (`serverSeenAt`, ms; null = never) and what this visit
 * already sent (`sent`).
 * ⚠ NO REFETCH LOOP: the POST refetches the board, whose stamp is then exactly this value, so the
 * next response sends nothing. An empty list sends nothing (there is nothing new to have seen), and
 * the stamp is a REVIEW time, never a fetch time that would move on every response.
 */
export function aiReviewsStampToSend(
  cards: readonly Pick<AiReviewCard, 'at'>[],
  serverSeenAt: number | null,
  sent: number | null,
): number | null {
  let newest = Number.NEGATIVE_INFINITY;
  for (const c of cards) newest = Math.max(newest, Date.parse(c.at));
  if (!Number.isFinite(newest)) return null;
  if (serverSeenAt != null && newest <= serverSeenAt) return null;
  if (sent != null && newest <= sent) return null;
  return newest;
}
