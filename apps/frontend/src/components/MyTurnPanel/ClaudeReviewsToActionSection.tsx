import type { ClaudeReviewToAction } from '@pierre-review/shared';
import { useFilters } from '../../store/filters.js';
import { relativeTime } from '../../lib/ui.js';
import { MyTurnRow } from './MyTurnRow.js';

const VERDICT_LABEL: Record<string, string> = {
  APPROVE: 'approve',
  REQUEST_CHANGES: 'changes',
  COMMENT: 'comment',
};

// My Turn section for completed Claude reviews that haven't been actioned yet (no
// review/comments posted). Opening a row jumps to that PR's Claude Review tab so you
// can post or discard it. Local-only — empty (and hidden) when Claude Review is off.
export function ClaudeReviewsToActionSection({
  items,
}: {
  items: ClaudeReviewToAction[];
}): JSX.Element | null {
  const openClaudeReview = useFilters((s) => s.openClaudeReview);
  if (items.length === 0) return null;

  return (
    <section>
      <h3 className="mb-1 flex items-center gap-1.5 text-xs font-semibold">
        <span className="text-purple-500">●</span>
        Claude reviews to action
        <span className="text-gray-400">({items.length})</span>
      </h3>
      <ul className="space-y-0.5">
        {items.map((it) => (
          <MyTurnRow
            key={it.reviewId}
            onOpen={() => openClaudeReview(it.prId)}
            onAction={() => openClaudeReview(it.prId)}
            actionLabel="Open"
            actionTitle="Open this PR's Claude Review tab to post or discard it"
            time={
              it.finishedAt != null ? `reviewed ${relativeTime(it.finishedAt)}` : 'completed'
            }
            urgencyTs={it.finishedAt ?? undefined}
            title={it.prTitle}
            meta={
              <>
                {it.repoFullName} #{it.prNumber}
                {it.verdict != null && (
                  <> · {VERDICT_LABEL[it.verdict] ?? it.verdict.toLowerCase()}</>
                )}
                {it.headStale && <> · head moved since review</>}
              </>
            }
          />
        ))}
      </ul>
    </section>
  );
}
