import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  ConsolidatedFeedItem,
  DismissedItem,
  EventType,
  FeedItemTier,
  MyTurnDismissKind,
} from '@pierre-review/shared';
import { useConsolidatedFeed } from '../../hooks/useConsolidatedFeed.js';
import { useMyTurnDone } from '../../hooks/useTriage.js';
import { useFilters } from '../../store/filters.js';
import { usePinnedTabs } from '../../store/pinnedTabs.js';
import { api } from '../../api/client.js';
import {
  DERIVED_STATE_META,
  EVENT_META,
  REASON_META,
  indexUsers,
  relativeTime,
  userLabel,
} from '../../lib/ui.js';
import { FeedDigestPanel } from './FeedDigestPanel.js';

const TIER_HEADERS: Record<FeedItemTier, { label: string; hint: string }> = {
  0: { label: 'Needs attention', hint: 'Unresolved threads sitting more than 2 days' },
  1: { label: 'Your turn', hint: 'Reviews, your PRs, approvals and threads awaiting you' },
  2: { label: 'Recent activity', hint: 'Latest events across your repos' },
};

// A small coloured dot + label describing what an item is.
function itemGlyph(item: ConsolidatedFeedItem): { color: string; label: string } {
  if (item.source === 'thread') {
    const meta = item.derivedState != null ? DERIVED_STATE_META[item.derivedState] : null;
    return { color: meta?.color ?? '#f59e0b', label: meta?.label ?? 'Thread' };
  }
  if (item.source === 'my_turn') {
    if (item.reasonTag != null) {
      const meta = REASON_META[item.reasonTag];
      return { color: meta.color, label: meta.label };
    }
    if (item.kind === 'claude_review') return { color: '#a78bfa', label: 'Claude review' };
    if (item.kind === 'watched_repo_pr') return { color: '#0ea5e9', label: 'New in watched repo' };
    return { color: '#3b82f6', label: 'Your turn' };
  }
  // feed event
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

  const dismiss = useMutation({
    mutationFn: (v: { kind: MyTurnDismissKind; refId: number }) =>
      api.dismissMyTurn(v.kind, v.refId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['consolidated-feed'] });
      void qc.invalidateQueries({ queryKey: ['my-turn'] });
      void qc.invalidateQueries({ queryKey: ['me'] });
    },
  });

  // Open an item: My Turn items → My Turn Focus (the inbox-scoped timeline); threads
  // and feed events → PR Focus (isolate that one PR on the timeline). Both leave the
  // Inbox overlay (showTimeline / focusPrOnTimeline's own showTimeline).
  function open(item: ConsolidatedFeedItem): void {
    if (item.prId == null) return;
    if (item.source === 'my_turn') {
      showTimeline();
      if (item.kind === 'claude_review') openMyTurnClaudeReview(item.prId);
      else openMyTurnPr(item.prId, null);
      return;
    }
    // thread | feed → PR isolation focus (focusPrOnTimeline calls showTimeline itself).
    focusPrOnTimeline(item.prId);
    if (item.threadId != null) selectThread(item.prId, item.threadId);
  }

  // Group into the three tiers, preserving the server's deterministic order.
  const tiers: { tier: FeedItemTier; items: ConsolidatedFeedItem[] }[] = useMemo(() => {
    const out: { tier: FeedItemTier; items: ConsolidatedFeedItem[] }[] = [];
    for (const t of [0, 1, 2] as FeedItemTier[]) {
      const group = items.filter((i) => i.tier === t);
      if (group.length > 0) out.push({ tier: t, items: group });
    }
    return out;
  }, [items]);

  return (
    <div className="space-y-3">
      <FeedDigestPanel />

      {items.length === 0 ? (
        <div className="flex h-32 items-center justify-center text-sm text-gray-400">
          Nothing needs your attention right now.
        </div>
      ) : (
        tiers.map(({ tier, items: group }) => (
          <section key={tier} className="space-y-1.5">
            <h3
              className="flex items-baseline gap-2 px-0.5 text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400"
              title={TIER_HEADERS[tier].hint}
            >
              {TIER_HEADERS[tier].label}
              <span className="text-[10px] font-normal text-gray-400">{group.length}</span>
            </h3>
            <ul className="space-y-1">
              {group.map((item) => (
                <FeedRow
                  key={item.id}
                  item={item}
                  actor={userLabel(
                    item.actorId != null ? usersById.get(item.actorId) : undefined,
                    item.actorId,
                  )}
                  onOpen={() => open(item)}
                  onDismiss={
                    item.dismiss != null
                      ? () => dismiss.mutate(item.dismiss as { kind: MyTurnDismissKind; refId: number })
                      : null
                  }
                />
              ))}
            </ul>
          </section>
        ))
      )}

      <DoneDisclosure />
    </div>
  );
}

// Coordinates to un-dismiss a "Done" entry (mirrors MyTurnDismissBody).
function dismissedRefId(it: DismissedItem): number {
  if (it.kind === 'thread') return it.threadId;
  if (it.kind === 'claude_review') return it.reviewId;
  return it.prId;
}
function dismissedLabel(it: DismissedItem): string {
  if (it.kind === 'thread') {
    return `${it.repoFullName} #${it.prNumber}${it.path ? ` · ${it.path.split('/').pop()}` : ''}`;
  }
  if (it.kind === 'claude_review') {
    return `${it.repoFullName} #${it.prNumber} ${it.prTitle}`;
  }
  return `${it.repoFullName} #${it.number} ${it.title}`;
}

// "Keep dismiss/Done": a compact, lazily-loaded disclosure of recently-cleared items
// with a Restore action (auto-resurface on newer activity still happens server-side;
// this is the manual undo). Only fetches once opened.
function DoneDisclosure(): JSX.Element {
  const [open, setOpen] = useState(false);
  const { data } = useMyTurnDone(open);
  const qc = useQueryClient();
  const restore = useMutation({
    mutationFn: (v: { kind: MyTurnDismissKind; refId: number }) =>
      api.undismissMyTurn(v.kind, v.refId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['consolidated-feed'] });
      void qc.invalidateQueries({ queryKey: ['my-turn'] });
      void qc.invalidateQueries({ queryKey: ['my-turn-done'] });
      void qc.invalidateQueries({ queryKey: ['me'] });
    },
  });
  const items = data?.items ?? [];

  return (
    <div className="border-t border-gray-100 pt-2 dark:border-gray-800">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
      >
        <span aria-hidden="true">{open ? '▾' : '▸'}</span>
        Recently cleared{open && items.length > 0 ? ` · ${items.length}` : ''}
      </button>
      {open && (
        <ul className="mt-1 space-y-0.5">
          {items.length === 0 ? (
            <li className="px-2 py-1 text-xs text-gray-400">Nothing cleared recently.</li>
          ) : (
            items.map((it) => (
              <li
                key={`${it.kind}:${dismissedRefId(it)}`}
                className="flex items-center gap-2 rounded px-2 py-1 text-xs hover:bg-gray-50 dark:hover:bg-gray-800/40"
              >
                <span className="min-w-0 flex-1 truncate text-gray-600 dark:text-gray-300">
                  {dismissedLabel(it)}
                </span>
                {it.restorable ? (
                  <button
                    type="button"
                    onClick={() => restore.mutate({ kind: it.kind, refId: dismissedRefId(it) })}
                    className="shrink-0 rounded border border-gray-300 px-1.5 py-0.5 text-[10px] font-medium text-gray-500 hover:border-gray-400 hover:text-gray-700 dark:border-gray-700 dark:hover:border-gray-500"
                    title="Restore to the Feed"
                  >
                    Restore
                  </button>
                ) : (
                  <span className="shrink-0 text-[10px] text-gray-400">{it.reason ?? 'gone'}</span>
                )}
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

function FeedRow({
  item,
  actor,
  onOpen,
  onDismiss,
}: {
  item: ConsolidatedFeedItem;
  actor: string;
  onOpen: () => void;
  onDismiss: (() => void) | null;
}): JSX.Element {
  const glyph = itemGlyph(item);
  const prLabel =
    item.prNumber != null
      ? `#${item.prNumber}${item.prTitle != null ? ` ${item.prTitle}` : ''}`
      : '';

  return (
    <li className="group flex items-start gap-2 rounded border-l-2 border-transparent px-2 py-1.5 hover:border-sky-400 hover:bg-gray-50 dark:hover:bg-gray-800/40">
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
          {item.ageDays != null && item.ageDays >= 2 && (
            <span className="shrink-0 rounded bg-red-500/15 px-1 text-[10px] font-semibold text-red-600 dark:text-red-400">
              {item.ageDays}d
            </span>
          )}
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
      {onDismiss != null && (
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 self-center rounded px-1 py-0.5 text-xs leading-none text-gray-300 opacity-0 transition-opacity hover:bg-gray-200 hover:text-gray-600 group-hover:opacity-100 dark:hover:bg-gray-700"
          title="Mark seen (dismiss — resurfaces on newer activity)"
          aria-label="Mark seen"
        >
          ✓
        </button>
      )}
    </li>
  );
}
