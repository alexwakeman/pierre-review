import { useMemo } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  ConsolidatedFeedItem,
  EventType,
  MyTurnDismissKind,
} from '@pierre-review/shared';
import { useConsolidatedFeed } from '../../hooks/useConsolidatedFeed.js';
import { useFilters } from '../../store/filters.js';
import { usePinnedTabs } from '../../store/pinnedTabs.js';
import { api } from '../../api/client.js';
import { EVENT_META, REASON_META, indexUsers, relativeTime, userLabel } from '../../lib/ui.js';
import { FeedDigestPanel } from './FeedDigestPanel.js';

// A small coloured dot + label describing what an item is.
function itemGlyph(item: ConsolidatedFeedItem): { color: string; label: string } {
  if (item.source === 'my_turn') {
    if (item.reasonTag != null) {
      const meta = REASON_META[item.reasonTag];
      return { color: meta.color, label: meta.label };
    }
    if (item.kind === 'claude_review') return { color: '#a78bfa', label: 'Claude review' };
    if (item.kind === 'watched_repo_pr') return { color: '#0ea5e9', label: 'New in watched repo' };
    if (item.kind === 'thread') return { color: '#f59e0b', label: 'Reply awaiting you' };
    return { color: '#3b82f6', label: 'Your turn' };
  }
  const meta = EVENT_META[item.kind as EventType];
  return { color: meta?.color ?? '#6b7280', label: meta?.label ?? item.kind };
}

export function FeedView(): JSX.Element {
  const { data } = useConsolidatedFeed(true);
  const qc = useQueryClient();

  const showTimeline = usePinnedTabs((s) => s.showTimeline);
  const openMyTurnPr = useFilters((s) => s.openMyTurnPr);
  const openMyTurnClaudeReview = useFilters((s) => s.openMyTurnClaudeReview);
  const focusPrOnTimeline = useFilters((s) => s.focusPrOnTimeline);
  const selectThread = useFilters((s) => s.selectThread);

  const usersById = useMemo(() => indexUsers(data?.users), [data?.users]);
  const items = data?.items ?? [];

  // The seen/unseen toggle. Marking seen does NOT remove the item — it's an
  // acknowledgement (reuses the dismissal store, which reverts on newer activity).
  const invalidate = (): void => {
    void qc.invalidateQueries({ queryKey: ['consolidated-feed'] });
    void qc.invalidateQueries({ queryKey: ['my-turn'] });
    void qc.invalidateQueries({ queryKey: ['my-turn-done'] });
    void qc.invalidateQueries({ queryKey: ['me'] });
  };
  const markSeen = useMutation({
    mutationFn: (v: { kind: MyTurnDismissKind; refId: number }) => api.dismissMyTurn(v.kind, v.refId),
    onSuccess: invalidate,
  });
  const markUnseen = useMutation({
    mutationFn: (v: { kind: MyTurnDismissKind; refId: number }) => api.undismissMyTurn(v.kind, v.refId),
    onSuccess: invalidate,
  });

  // Open an item: My Turn items → My Turn Focus (the inbox-scoped timeline); feed events
  // → PR Focus (isolate that one PR). Both leave the Inbox overlay.
  function open(item: ConsolidatedFeedItem): void {
    if (item.prId == null) return;
    if (item.source === 'my_turn') {
      showTimeline();
      if (item.kind === 'claude_review') openMyTurnClaudeReview(item.prId);
      else openMyTurnPr(item.prId, item.threadId);
      return;
    }
    focusPrOnTimeline(item.prId);
    if (item.threadId != null) selectThread(item.prId, item.threadId);
  }

  return (
    <div className="space-y-3">
      <FeedDigestPanel />

      {items.length === 0 ? (
        <div className="flex h-32 items-center justify-center text-sm text-gray-400">
          Nothing to show yet — activity across your repos will appear here.
        </div>
      ) : (
        <ul className="space-y-0.5">
          {items.map((item) => (
            <FeedRow
              key={item.id}
              item={item}
              actor={userLabel(
                item.actorId != null ? usersById.get(item.actorId) : undefined,
                item.actorId,
              )}
              onOpen={() => open(item)}
              onToggleSeen={
                item.dismiss != null
                  ? () => {
                      const d = item.dismiss as { kind: MyTurnDismissKind; refId: number };
                      if (item.acknowledged) markUnseen.mutate(d);
                      else markSeen.mutate(d);
                    }
                  : null
              }
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function FeedRow({
  item,
  actor,
  onOpen,
  onToggleSeen,
}: {
  item: ConsolidatedFeedItem;
  actor: string;
  onOpen: () => void;
  onToggleSeen: (() => void) | null;
}): JSX.Element {
  const glyph = itemGlyph(item);
  const prLabel =
    item.prNumber != null
      ? `#${item.prNumber}${item.prTitle != null ? ` ${item.prTitle}` : ''}`
      : '';

  return (
    <li
      className={`group flex items-start gap-2 rounded border-l-2 border-transparent px-2 py-1.5 hover:border-sky-400 hover:bg-gray-50 dark:hover:bg-gray-800/40 ${
        item.acknowledged ? 'opacity-55' : ''
      }`}
    >
      <span
        aria-hidden="true"
        className="mt-1 inline-block h-2 w-2 shrink-0 rounded-full"
        style={{ background: glyph.color }}
        title={glyph.label}
      />
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
        <div className="flex items-baseline gap-1.5 text-xs">
          <span className="shrink-0 font-medium text-gray-500 dark:text-gray-400">
            {glyph.label}
          </span>
          <span className="ml-auto shrink-0 text-[10px] text-gray-400">
            {relativeTime(item.occurredAt)}
          </span>
        </div>
        <div className="truncate text-xs text-gray-700 dark:text-gray-200">
          <span className="text-gray-400">{item.repoFullName}</span>
          {prLabel !== '' && <span className="ml-1 font-medium">{prLabel}</span>}
          {item.path != null && (
            <span className="ml-1 text-gray-400">· {item.path.split('/').pop()}</span>
          )}
        </div>
        {item.content != null && item.content.trim() !== '' && (
          <div className="mt-0.5 line-clamp-2 rounded bg-gray-100 px-1.5 py-0.5 text-[11px] leading-snug text-gray-600 dark:bg-gray-800/60 dark:text-gray-300">
            <span className="text-gray-400">{actor}: </span>
            {item.content}
          </div>
        )}
      </button>
      {onToggleSeen != null && (
        <button
          type="button"
          onClick={onToggleSeen}
          className={`shrink-0 self-center rounded border px-1 py-0.5 text-xs leading-none transition-opacity ${
            item.acknowledged
              ? 'border-emerald-400 text-emerald-500 dark:border-emerald-600'
              : 'border-transparent text-gray-300 opacity-0 hover:bg-gray-200 hover:text-gray-600 group-hover:opacity-100 dark:hover:bg-gray-700'
          }`}
          title={item.acknowledged ? 'Marked seen — click to un-mark' : 'Mark seen (acknowledge; it stays, and resurfaces on new activity)'}
          aria-pressed={item.acknowledged}
          aria-label={item.acknowledged ? 'Mark unseen' : 'Mark seen'}
        >
          ✓
        </button>
      )}
    </li>
  );
}
