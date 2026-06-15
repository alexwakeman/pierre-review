import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { MyTurnDismissKind } from '@pierre-review/shared';
import { api } from '../../api/client.js';
import { useFilters } from '../../store/filters.js';
import { useMyTurnDone } from '../../hooks/useTriage.js';
import { relativeTime } from '../../lib/ui.js';
import { MyTurnRow } from './MyTurnRow.js';

const VERDICT_LABEL: Record<string, string> = {
  APPROVE: 'approve',
  REQUEST_CHANGES: 'changes',
  COMMENT: 'comment',
};

// The "Done" tab: entries dismissed in the past 90 days, each restorable to the
// inbox via "To do" (un-dismiss). Data is fetched lazily (only while the tab is
// active).
export function DismissedSection({ active }: { active: boolean }): JSX.Element {
  const openPrFocused = useFilters((s) => s.openPrFocused);
  const openClaudeReview = useFilters((s) => s.openClaudeReview);
  const { data, isLoading } = useMyTurnDone(active);
  const qc = useQueryClient();
  const undismiss = useMutation({
    mutationFn: (v: { kind: MyTurnDismissKind; refId: number }) =>
      api.undismissMyTurn(v.kind, v.refId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['my-turn'] });
      void qc.invalidateQueries({ queryKey: ['my-turn-done'] });
      void qc.invalidateQueries({ queryKey: ['me'] });
    },
  });

  if (isLoading && !data) {
    return <div className="px-1 py-4 text-sm text-gray-500">Loading…</div>;
  }
  const items = data?.items ?? [];
  if (items.length === 0) {
    return (
      <div className="px-1 py-6 text-sm text-gray-500">
        Nothing marked done in the last 90 days.
      </div>
    );
  }

  return (
    <ul className="space-y-0.5">
      {items.map((it) => {
        if (it.kind === 'review_request') {
          return (
            <MyTurnRow
              key={`r:${it.prId}`}
              onOpen={() => openPrFocused(it.prId)}
              onAction={() =>
                undismiss.mutate({ kind: 'review_request', refId: it.prId })
              }
              actionLabel="To do"
              actionTitle="Move back to your inbox"
              actionPending={undismiss.isPending}
              time={`done ${relativeTime(it.dismissedAt)}`}
              title={it.title}
              meta={
                <>
                  {it.repoFullName} #{it.number}
                </>
              }
            />
          );
        }
        if (it.kind === 'claude_review') {
          return (
            <MyTurnRow
              key={`c:${it.reviewId}`}
              onOpen={() => openClaudeReview(it.prId)}
              onAction={() =>
                undismiss.mutate({ kind: 'claude_review', refId: it.reviewId })
              }
              actionLabel="To do"
              actionTitle="Move back to your inbox"
              actionPending={undismiss.isPending}
              time={`done ${relativeTime(it.dismissedAt)}`}
              title={it.prTitle}
              meta={
                <>
                  {it.repoFullName} #{it.prNumber}
                  {it.verdict != null && (
                    <> · {VERDICT_LABEL[it.verdict] ?? it.verdict.toLowerCase()}</>
                  )}
                </>
              }
            />
          );
        }
        return (
          <MyTurnRow
            key={`t:${it.threadId}`}
            onOpen={() => openPrFocused(it.prId, it.threadId)}
            onAction={() => undismiss.mutate({ kind: 'thread', refId: it.threadId })}
            actionLabel="To do"
            actionTitle="Move back to your inbox"
            actionPending={undismiss.isPending}
            time={`done ${relativeTime(it.dismissedAt)}`}
            title={`“${it.lastReplyExcerpt}”`}
            meta={
              <>
                {it.repoFullName} #{it.prNumber} ·{' '}
                <span className="font-mono" title={it.path}>
                  {`${it.path.split('/').at(-1)}${it.line != null ? `:${it.line}` : ''}`}
                </span>
              </>
            }
          />
        );
      })}
    </ul>
  );
}
