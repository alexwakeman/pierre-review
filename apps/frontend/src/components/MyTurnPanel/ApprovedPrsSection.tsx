import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ApprovedPrItem, User } from '@pierre-review/shared';
import { api } from '../../api/client.js';
import { useFilters } from '../../store/filters.js';
import { mergeWarning, relativeTime } from '../../lib/ui.js';
import { MyTurnRow } from './MyTurnRow.js';

// "Your PR was approved" — authored, open PRs with a standing approval (ready to
// merge). "Done" reappears only when a NEW approval lands (not on every commit). The
// merge-state warning surfaces when GitHub would still block the merge despite the
// approval.
export function ApprovedPrsSection({
  items,
}: {
  items: ApprovedPrItem[];
  usersById: Map<number, User>;
}): JSX.Element | null {
  const openMyTurnPr = useFilters((s) => s.openMyTurnPr);
  const qc = useQueryClient();
  const dismiss = useMutation({
    mutationFn: (prId: number) => api.dismissMyTurn('pr_approved', prId),
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
        <span className="text-emerald-500">●</span>
        Approved · ready to merge
        <span className="text-gray-400">({items.length})</span>
      </h3>
      <ul className="space-y-0.5">
        {items.map((it) => {
          const warn = mergeWarning(it.mergeable, it.mergeStateStatus);
          return (
            <MyTurnRow
              key={it.prId}
              onOpen={() => openMyTurnPr(it.prId)}
              onAction={() => dismiss.mutate(it.prId)}
              actionLabel="Done"
              actionTitle="Done — reappears if a new approval lands"
              actionPending={dismiss.isPending}
              time={relativeTime(it.openedAt)}
              title={it.title}
              meta={
                <>
                  {it.repoFullName} #{it.number} · {it.approvals} approval
                  {it.approvals === 1 ? '' : 's'}
                </>
              }
              sub={
                warn ? (
                  <span className="text-amber-600 dark:text-amber-400">
                    ⚠ merge: {warn}
                  </span>
                ) : undefined
              }
            />
          );
        })}
      </ul>
    </section>
  );
}
