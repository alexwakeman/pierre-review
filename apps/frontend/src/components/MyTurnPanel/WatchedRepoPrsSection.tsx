import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { User, WatchedRepoPrItem } from '@pierre-review/shared';
import { api } from '../../api/client.js';
import { useFilters } from '../../store/filters.js';
import { relativeTime } from '../../lib/ui.js';
import { MyTurnRow } from './MyTurnRow.js';

// New open PRs (by others) in repos you've Watched, opened after the watch began.
// "Done" is sticky — it acknowledges that specific PR and it won't come back unless
// the repo is unwatched and re-watched.
export function WatchedRepoPrsSection({
  items,
  usersById,
}: {
  items: WatchedRepoPrItem[];
  usersById: Map<number, User>;
}): JSX.Element | null {
  const openMyTurnPr = useFilters((s) => s.openMyTurnPr);
  const qc = useQueryClient();
  const dismiss = useMutation({
    mutationFn: (prId: number) => api.dismissMyTurn('watched_repo_pr', prId),
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
        <span className="text-sky-500">●</span>
        New in watched repos
        <span className="text-gray-400">({items.length})</span>
      </h3>
      <ul className="space-y-0.5">
        {items.map((it) => {
          const author = it.authorId != null ? usersById.get(it.authorId) : undefined;
          return (
            <MyTurnRow
              key={it.prId}
              onOpen={() => openMyTurnPr(it.prId)}
              onAction={() => dismiss.mutate(it.prId)}
              actionLabel="Done"
              actionTitle="Done — acknowledge this new PR (it won't reappear)"
              actionPending={dismiss.isPending}
              time={relativeTime(it.openedAt)}
              urgencyTs={it.openedAt}
              title={it.title}
              meta={
                <>
                  {it.repoFullName} #{it.number}
                  {author && <> · by {author.githubLogin}</>}
                </>
              }
            />
          );
        })}
      </ul>
    </section>
  );
}
