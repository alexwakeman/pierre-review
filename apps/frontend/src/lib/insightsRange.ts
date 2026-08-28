import type { InsightsAnswerWindow, InsightsRangeKey } from '@pierre-review/shared';
import { formatDate } from './ui.js';

// The Insights chat's range vocabulary, client side. Pure — no store, no query — so the answer
// caption and the History rows read one implementation.
//
// ⚠ `defaultInsightsRange` USED TO LIVE HERE and is deliberately gone. It existed for the
// FilterBar "Range" chips, which the chat's window precedence made unreachable (its only mount
// always passes an explicit period window). The SERVER's `resolveInsightsRange`
// (packages/pro/src/settings/store.ts) survives and is now pinned on that side only — there is
// no longer a client mirror for it to drift from.

// Range label, short. No longer chip text — it captions an answer's window.
export const INSIGHTS_RANGE_LABEL: Record<InsightsRangeKey, string> = {
  sprint: 'Sprint to date',
  '7d': '7d',
  '14d': '14d',
  '30d': '30d',
  '90d': '90d',
  // What every answer from the Reports "Ask about this period" mount is labelled with, now that
  // it is the only mount there is.
  period: 'Period',
};

// Sentence-case prose for a caption under an answer, where "7d" would read as a typo.
const PROSE: Record<InsightsRangeKey, string> = {
  sprint: 'Sprint to date',
  '7d': 'Last 7 days',
  '14d': 'Last 14 days',
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
  // The caption's dates carry the specifics; this just names the KIND of window.
  period: 'Report period',
};

// Caption one answer's window: what it covered and over which dates.
//
// Returns null for a missing window rather than a guess — history rows written before ranges were
// selectable carry none, and captioning those with today's default would attach a period nobody
// chose to somebody's stored answer. The caller renders nothing.
//
// When `requested` is present the ask and the answer disagree ('Sprint to date' with no cadence +
// start stored), and the caption says so instead of quietly relabelling a rolling fortnight.
export function describeAnswerWindow(
  w: InsightsAnswerWindow | null | undefined,
): string | null {
  if (w == null) return null;
  const dates = `${formatDate(w.from)} – ${formatDate(w.to)}`;
  if (w.requested === 'sprint' && w.kind !== 'sprint')
    return `${PROSE[w.kind]} · ${dates} — no sprint cadence configured`;
  return `${PROSE[w.kind]} · ${dates}`;
}
