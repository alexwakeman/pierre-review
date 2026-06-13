import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { AwaitingReviewItem, User } from '@pierre-review/shared';
import { api } from '../../api/client.js';
import { useFilters } from '../../store/filters.js';
import { relativeTime } from '../../lib/ui.js';
import { MyTurnRow } from './MyTurnRow.js';

export function AwaitingReviewSection({
  items,
}: {
  items: AwaitingReviewItem[];
  usersById: Map<number, User>;
}): JSX.Element | null {
  const openPrFocused = useFilters((s) => s.openPrFocused);
  const qc = useQueryClient();
  const dismiss = useMutation({
    mutationFn: (prId: number) => api.dismissMyTurn('review_request', prId),
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
        <span className="text-blue-500">●</span>
        Awaiting your review
        <span className="text-gray-400">({items.length})</span>
      </h3>
      <ul className="space-y-0.5">
        {items.map((it) => (
          <MyTurnRow
            key={it.prId}
            onOpen={() => openPrFocused(it.prId)}
            onAction={() => dismiss.mutate(it.prId)}
            actionLabel="Done"
            actionTitle="Done — reappears if the PR is updated"
            actionPending={dismiss.isPending}
            time={relativeTime(it.openedAt)}
            urgencyTs={it.openedAt}
            title={it.title}
            meta={
              <>
                {it.repoFullName} #{it.number}
                {it.alsoRequested > 0 && (
                  <> · +{it.alsoRequested} other{it.alsoRequested === 1 ? '' : 's'}</>
                )}
              </>
            }
          />
        ))}
      </ul>
    </section>
  );
}
