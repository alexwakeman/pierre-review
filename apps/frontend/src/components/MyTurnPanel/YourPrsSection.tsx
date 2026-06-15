import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { User, YourPrActivityItem } from '@pierre-review/shared';
import { api } from '../../api/client.js';
import { useFilters } from '../../store/filters.js';
import { relativeTime } from '../../lib/ui.js';
import { MyTurnRow } from './MyTurnRow.js';

export function YourPrsSection({
  items,
}: {
  items: YourPrActivityItem[];
  usersById: Map<number, User>;
}): JSX.Element | null {
  const openMyTurnPr = useFilters((s) => s.openMyTurnPr);
  const qc = useQueryClient();
  // "Seen" = mark the PR viewed; its new-activity badge clears and it drops out.
  const dismiss = useMutation({
    mutationFn: (prId: number) => api.dismissPr(prId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['my-turn'] });
      void qc.invalidateQueries({ queryKey: ['me'] });
      void qc.invalidateQueries({ queryKey: ['open-prs'] });
      void qc.invalidateQueries({ queryKey: ['timeline'] });
    },
  });
  if (items.length === 0) return null;

  return (
    <section>
      <h3 className="mb-1 flex items-center gap-1.5 text-xs font-semibold">
        <span className="text-green-500">●</span>
        Your PRs with new activity
        <span className="text-gray-400">({items.length})</span>
      </h3>
      <ul className="space-y-0.5">
        {items.map((it) => (
          <MyTurnRow
            key={it.prId}
            onOpen={() => openMyTurnPr(it.prId)}
            onAction={() => dismiss.mutate(it.prId)}
            actionLabel="Seen"
            actionTitle="Mark seen — clears the new-activity badge"
            actionPending={dismiss.isPending}
            time={relativeTime(it.openedAt)}
            title={it.title}
            meta={
              <>
                {it.repoFullName} #{it.number}
              </>
            }
            sub={<span className="font-medium text-sky-500">{it.summary}</span>}
          />
        ))}
      </ul>
    </section>
  );
}
