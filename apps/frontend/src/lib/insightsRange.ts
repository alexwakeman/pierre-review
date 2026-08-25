import type {
  InsightsAnswerWindow,
  InsightsRangeKey,
  SprintComparisonMode,
} from '@pierre-review/shared';
import { formatDate } from './ui.js';

// The Insights chat's range vocabulary, client side. Pure — no store, no query — so the FilterBar
// chips, the answer caption and the History rows all read one implementation.

// Which chip is live when the user has picked nothing. `insightsRange === null` means "use the
// account's configured window", so the bar must show that window as the selection rather than
// showing nothing selected.
//
// ⚠ THIS MIRRORS THE SERVER'S `resolveInsightsRange` (packages/pro/src/settings/store.ts) AND MUST
// AGREE WITH IT. If it drifts, the bar highlights one range while the answer covers another — the
// worst kind of disagreement, because both halves look confident. In particular the `'sprint'`
// mode WITHOUT stored dates falls back to a rolling fortnight in both places; the chip isn't even
// offered then, but the configured mode can still name it.
export function defaultInsightsRange(
  mode: SprintComparisonMode | null,
  hasSprintDates: boolean,
): InsightsRangeKey {
  if (mode === 'sprint') return hasSprintDates ? 'sprint' : '14d';
  if (mode === 'rolling_7') return '7d';
  return '14d'; // rolling_14 is the documented default, and covers an unread/absent setting
}

// Chip text. Short, because these sit in the filter bar next to the Timeline's own presets.
export const INSIGHTS_RANGE_LABEL: Record<InsightsRangeKey, string> = {
  sprint: 'Sprint to date',
  '7d': '7d',
  '14d': '14d',
  '30d': '30d',
  '90d': '90d',
  // Never a chip (FilterBar's key lists don't include it): 'period' only ever appears on answers
  // the Reports "Ask about this period" mount grounded in an explicit reporting period.
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
