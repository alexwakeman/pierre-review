import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ClaudeReviewToAction } from '@pierre-review/shared';
import { api } from '../../api/client.js';
import { useFilters } from '../../store/filters.js';
import { relativeTime } from '../../lib/ui.js';
import { MyTurnRow } from './MyTurnRow.js';

const VERDICT_LABEL: Record<string, string> = {
  APPROVE: 'approve',
  REQUEST_CHANGES: 'changes',
  COMMENT: 'comment',
};

// My Turn section for completed Claude reviews that haven't been actioned yet (no
// review/comments posted). Clicking a row jumps to that PR's Claude Review tab so you
// can post or discard it; "Done" dismisses the entry like any other (it returns when a
// newer run finishes). Local-only — empty (and hidden) when Claude Review is off.
export function ClaudeReviewsToActionSection({
  items,
}: {
  items: ClaudeReviewToAction[];
}): JSX.Element | null {
  const openMyTurnClaudeReview = useFilters((s) => s.openMyTurnClaudeReview);
  const qc = useQueryClient();
  const dismiss = useMutation({
    mutationFn: (reviewId: number) => api.dismissMyTurn('claude_review', reviewId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['my-turn'] });
      void qc.invalidateQueries({ queryKey: ['my-turn-done'] });
      void qc.invalidateQueries({ queryKey: ['me'] });
    },
  });
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
            onOpen={() => openMyTurnClaudeReview(it.prId)}
            onAction={() => dismiss.mutate(it.reviewId)}
            actionLabel="Done"
            actionTitle="Done — reappears when a newer review finishes"
            actionPending={dismiss.isPending}
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
