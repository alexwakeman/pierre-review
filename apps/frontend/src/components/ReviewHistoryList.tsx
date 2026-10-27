import type { ClaudeReviewSummary } from '@pierre-review/shared';
import { aiRunLabel } from '@pierre-review/shared';
import { CLAUDE_VERDICT_LABEL, reviewRunWhen } from '../lib/claudeReviewColumn.js';
import { findingCountText, reviewStatusWord } from '../lib/reviewHistory.js';
import { AUTO_REVIEW_LABEL, FRESH_REVIEW_LABEL } from './Activity/pendingLabels.js';

const shortSha = (sha: string | null): string => (sha ? sha.slice(0, 7) : '—');

/**
 * EVERY RUN ON THE PR, always visible (all providers, all heads, newest first — the server's history
 * is uncapped). One row per run: head, what ran, status, verdict, findings, when, Auto. Pressing a
 * row shows that run; the shown run is marked. The list itself never hides a run: a new model, a
 * provider switch or a run starting adds rows, never removes them (lib/reviewHistory.ts).
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
}): JSX.Element {
  return (
    <div>
      <div className="mb-1 text-[11px] font-medium text-gray-500 dark:text-gray-400">
        All reviews of this PR ({history.length})
      </div>
      <ol className="divide-y divide-gray-200 rounded border border-gray-200 text-xs dark:divide-gray-800 dark:border-gray-800">
        {history.map((h) => {
          const shown = h.id === shownId;
          const findings = findingCountText(h);
          return (
            <li key={h.id}>
              <button
                type="button"
                onClick={() => onShow(h.id)}
                aria-current={shown ? 'true' : undefined}
                data-review-run={h.id}
                className={`flex w-full flex-wrap items-center gap-x-2 gap-y-0.5 px-2 py-1 text-left ${
                  shown
                    ? 'bg-blue-50 text-gray-900 dark:bg-blue-900/30 dark:text-gray-100'
                    : 'text-gray-700 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-800/60'
                }`}
              >
                <span className="font-mono">{shortSha(h.headSha)}</span>
                <span className="font-medium">{h.reviewMode === 'skip' ? 'Skipped (nothing to review)' : aiRunLabel(h.provider, h.model, h.effort)}</span>
                <span>{reviewStatusWord(h.status)}</span>
                {h.status === 'succeeded' && h.verdict != null && h.reviewMode !== 'skip' && <span>{CLAUDE_VERDICT_LABEL[h.verdict]}</span>}
                {findings != null && h.reviewMode !== 'skip' && <span>{findings}</span>}
                <span className="text-gray-600 dark:text-gray-400">{reviewRunWhen(h.finishedAt ?? h.createdAt)}</span>
                {h.trigger === 'auto' && (
                  <span className="rounded bg-gray-500/10 px-1.5 text-[11px] text-gray-600 dark:text-gray-300">{AUTO_REVIEW_LABEL}</span>
                )}
                {h.fresh === true && (
                  <span className="rounded bg-gray-500/10 px-1.5 text-[11px] text-gray-600 dark:text-gray-300">{FRESH_REVIEW_LABEL}</span>
                )}
                {h.id === latestId && <span className="text-gray-600 dark:text-gray-400">Latest</span>}
                {shown && <span className="ml-auto font-medium text-blue-700 dark:text-blue-300">Shown</span>}
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
