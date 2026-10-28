import type { ClaudeReviewSummary } from '@pierre-review/shared';
import { reviewRunWhen } from '../lib/claudeReviewColumn.js';
import { historyOptionIdFor, reviewHistoryOptions } from '../lib/reviewHistory.js';

/**
 * THE AI REVIEW TAB'S HISTORY: a native drop-down of EVERY review of the PR (all providers, all heads,
 * newest first — the server's history is uncapped), so a long history stays one control. One option
 * per review (`reviewHistoryOptions`): a Claude + Codex pair is ONE option ("Claude + Codex · abc1234 ·
 * <when>"), a replies pass reads "Replies checked · …", any other run its run label. Picking one shows
 * it; the list itself never hides a review (lib/reviewHistory.ts). Shown only when there is more than
 * one review to pick from.
 */
export function ReviewHistoryList({
  history,
  shownId,
  latestId,
  onShow,
}: {
  history: readonly ClaudeReviewSummary[];
  shownId: number | null;
  latestId: number | null;
  onShow: (id: number) => void;
}): JSX.Element | null {
  const options = reviewHistoryOptions(history, latestId, reviewRunWhen);
  if (options.length < 2) return null;
  const value = historyOptionIdFor(options, shownId ?? latestId) ?? options[0]!.id;
  return (
    <label className="flex flex-wrap items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
      Showing
      <select
        value={value}
        onChange={(e) => onShow(Number(e.target.value))}
        className="max-w-full rounded border border-gray-300 bg-white px-2 py-1 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
      >
        {options.map((o) => (
          <option key={o.id} value={o.id} data-review-run={o.id}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
