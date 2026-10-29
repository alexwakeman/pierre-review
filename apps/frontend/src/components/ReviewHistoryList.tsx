import type { ClaudeReviewSummary } from '@pierre-review/shared';
import { Select } from './ui/index.js';
import { reviewRunWhen } from '../lib/claudeReviewColumn.js';
import { historyOptionIdFor, reviewHistoryOptions } from '../lib/reviewHistory.js';

/**
 * THE AI REVIEW TAB'S HISTORY: one drop-down (the custom Select) of EVERY review of the PR (all providers, all heads,
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
  // The redesign's custom Select (a bottom sheet on a phone): scripts open it and pick an option by
  // its words (`role="option"`), never `selectOption()`.
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 text-meta text-ui-mute">
      <span aria-hidden>Showing</span>
      <Select
        label="Showing"
        value={String(value)}
        onChange={(v) => onShow(Number(v))}
        options={options.map((o) => ({ value: String(o.id), label: o.label }))}
        className="max-w-full"
      />
    </div>
  );
}
