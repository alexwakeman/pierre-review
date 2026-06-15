import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ThreadAwaitingItem, User } from '@pierre-review/shared';
import { api } from '../../api/client.js';
import { useFilters } from '../../store/filters.js';
import { relativeTime } from '../../lib/ui.js';
import { MyTurnRow } from './MyTurnRow.js';

export function ThreadsAwaitingSection({
  items,
}: {
  items: ThreadAwaitingItem[];
  usersById: Map<number, User>;
}): JSX.Element | null {
  const openMyTurnPr = useFilters((s) => s.openMyTurnPr);
  const qc = useQueryClient();
  const dismiss = useMutation({
    mutationFn: (threadId: number) => api.dismissMyTurn('thread', threadId),
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
        <span className="text-amber-500">●</span>
        Threads awaiting your response
        <span className="text-gray-400">({items.length})</span>
      </h3>
      <ul className="space-y-0.5">
        {items.map((it) => {
          const file = `${it.path.split('/').at(-1)}${it.line != null ? `:${it.line}` : ''}`;
          return (
            <MyTurnRow
              key={it.threadId}
              onOpen={() =>
                // Enter My Turn Focus Mode on this PR and glow the thread's
                // review_comment marker on the (now isolated) board — mirrors the
                // thread "Show" link.
                openMyTurnPr(it.prId, it.threadId, it.lastReplyAt, {
                  type: 'review_comment',
                  refId: it.threadId,
                })
              }
              onAction={() => dismiss.mutate(it.threadId)}
              actionLabel="Done"
              actionTitle="Done — reappears on a newer reply"
              actionPending={dismiss.isPending}
              time={relativeTime(it.lastReplyAt)}
              urgencyTs={it.lastReplyAt}
              title={`“${it.lastReplyExcerpt}”`}
              meta={
                <>
                  {it.repoFullName} #{it.prNumber} ·{' '}
                  <span className="font-mono" title={it.path}>
                    {file}
                  </span>
                </>
              }
            />
          );
        })}
      </ul>
    </section>
  );
}
