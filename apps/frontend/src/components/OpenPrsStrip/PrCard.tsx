import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { TimelinePr, User } from '@gh-team-monitor/shared';
import { isMyTurnReason } from '@gh-team-monitor/shared';
import { api } from '../../api/client.js';
import { Avatar } from '../CommentCard.js';
import { relativeTime, userLabel } from '../../lib/ui.js';
import { useFilters } from '../../store/filters.js';
import { StatusRow } from './StatusRow.js';
import { ReasonTag } from './ReasonTag.js';

export function PrCard({
  pr,
  repoFullName,
  usersById,
}: {
  pr: TimelinePr;
  repoFullName: string;
  usersById: Map<number, User>;
}): JSX.Element {
  const openPrFocused = useFilters((s) => s.openPrFocused);
  const selectedPrId = useFilters((s) => s.selectedPrId);
  const qc = useQueryClient();
  const dismiss = useMutation({
    mutationFn: (id: number) => api.dismissPr(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['open-prs'] });
      void qc.invalidateQueries({ queryKey: ['timeline'] });
      void qc.invalidateQueries({ queryKey: ['my-turn'] });
      void qc.invalidateQueries({ queryKey: ['me'] });
    },
  });
  const author = pr.authorId != null ? usersById.get(pr.authorId) : undefined;
  const myTurn = isMyTurnReason(pr.reasonTag);
  const selected = selectedPrId === pr.id;
  const n = pr.newSinceLastViewed;
  const hasNew = !!n && n.commits + n.comments + n.reviews > 0;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => openPrFocused(pr.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') openPrFocused(pr.id);
      }}
      className={`relative flex w-52 shrink-0 cursor-pointer flex-col gap-1 rounded-lg border p-2 text-left transition ${
        selected
          ? 'border-blue-500 ring-1 ring-blue-500'
          : 'border-gray-200 hover:border-gray-400 dark:border-gray-700 dark:hover:border-gray-500'
      } ${myTurn ? 'my-turn-ring' : ''} bg-white dark:bg-gray-900`}
    >
      {hasNew && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            dismiss.mutate(pr.id);
          }}
          disabled={dismiss.isPending}
          className="absolute right-1.5 top-1.5 rounded px-1 text-[10px] text-gray-400 hover:bg-gray-200/60 hover:text-gray-600 dark:hover:bg-gray-700/60"
          title="Mark viewed (clear the new badge)"
        >
          ✓ seen
        </button>
      )}
      <div className="flex items-center gap-1 text-[10px] text-gray-400">
        <span className="truncate">{repoFullName}</span>
        <span>·</span>
        <span className="shrink-0">#{pr.number}</span>
        <a
          href={`https://github.com/${repoFullName}/pull/${pr.number}`}
          target="_blank"
          rel="noreferrer noopener"
          onClick={(e) => e.stopPropagation()}
          className="shrink-0 text-gray-400 hover:text-blue-500"
          title="Open on GitHub"
        >
          ↗
        </a>
        {pr.isDraft && (
          <span className="ml-1 rounded bg-gray-500/20 px-1 text-[9px] uppercase">draft</span>
        )}
      </div>

      <div className="line-clamp-2 text-xs font-semibold leading-snug" title={pr.title}>
        {pr.title}
      </div>

      <div className="flex items-center gap-1.5 text-[11px] text-gray-500">
        <Avatar user={author} size={14} />
        <span className="truncate">{userLabel(author, pr.authorId)}</span>
        <span>·</span>
        <span className="shrink-0">{relativeTime(pr.openedAt)}</span>
      </div>

      <StatusRow pr={pr} />

      <div className="mt-auto pt-0.5">
        <ReasonTag tag={pr.reasonTag} />
      </div>
    </div>
  );
}
