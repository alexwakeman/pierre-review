import { useEffect, useRef, useState } from 'react';
import {
  autoUpdate,
  flip,
  offset,
  shift,
  useDismiss,
  useFloating,
  useInteractions,
} from '@floating-ui/react';
import type { TimelineEvent, TimelinePr, User } from '@gh-team-monitor/shared';
import { usePr, useThread } from '../../hooks/usePr.js';
import { useLocalStorage } from '../../hooks/useLocalStorage.js';
import { useFilters } from '../../store/filters.js';
import { relativeTime, userLabel } from '../../lib/ui.js';
import { markerVisual } from './markerTemplate.js';
import { StateBadge } from '../StateBadge.js';
import { Markdown } from '../Markdown.js';

export interface PopoverState {
  x: number;
  y: number;
  // Every event the clicked marker/cluster holds. A cluster is single-PR after
  // PR-partitioned bucketing, so they all share one PR. All are shown expanded +
  // scrollable — there's no "drill into one" step any more.
  eventIds: number[];
}

// The combined-context overlay the popover asks Timeline to apply: the two
// focused rows, the linked-PR glow, and the clicked-marker glow.
export interface ContextFocus {
  groupIds: string[] | null;
  prId: number | null;
  eventId: number | null;
}

function firstHunkLine(hunk: string | null): string | null {
  if (!hunk) return null;
  const lines = hunk.replace(/\n$/, '').split('\n');
  // Last line of the hunk is the line the comment anchors to.
  return lines.at(-1) ?? null;
}

// "on <owner>'s #<number> <title>" — the PR an activity concerns. When the actor
// is the PR's own author we drop the possessive ("on #123") since it's their row.
function PrContext({
  ev,
  pr,
  usersById,
  onOpen,
}: {
  ev: TimelineEvent;
  pr: TimelinePr;
  usersById: Map<number, User>;
  onOpen: () => void;
}): JSX.Element {
  const owner = pr.authorId != null ? usersById.get(pr.authorId) : undefined;
  const isForeign =
    ev.actorId != null && pr.authorId != null && ev.actorId !== pr.authorId;
  return (
    <div className="flex items-baseline gap-1 text-[11px] text-gray-500">
      <span>on</span>
      {isForeign && (
        <span className="font-medium text-gray-600 dark:text-gray-300">
          {userLabel(owner, pr.authorId)}&rsquo;s
        </span>
      )}
      <button
        type="button"
        onClick={onOpen}
        className="font-medium text-blue-500 hover:underline"
      >
        #{pr.number}
      </button>
      <span className="truncate text-gray-400" title={pr.title}>
        {pr.title}
      </span>
    </div>
  );
}

function SingleEvent({
  ev,
  usersById,
  prsById,
  onNavigate,
}: {
  ev: TimelineEvent;
  usersById: Map<number, User>;
  prsById: Map<number, TimelinePr>;
  onNavigate: () => void;
}): JSX.Element {
  const selectThread = useFilters((s) => s.selectThread);
  const selectPr = useFilters((s) => s.selectPr);
  const showActivityEntry = useFilters((s) => s.showActivityEntry);
  const showPrComment = useFilters((s) => s.showPrComment);
  const vis = markerVisual(ev);
  const actor = ev.actorId != null ? usersById.get(ev.actorId) : undefined;
  const who = userLabel(actor, ev.actorId);

  const isReviewComment = ev.type === 'review_comment' && ev.threadId != null;
  const { data: thread } = useThread(isReviewComment ? ev.threadId : null);
  // A thread holds many comments; this event represents exactly ONE of them. The
  // backend emits a review_comment event per comment with occurredAt = that comment's
  // createdAt and actorId = its author, so resolve the exact comment by (time, author)
  // rather than always rendering the thread root. Fall back to the root if unmatched.
  const evMs = Date.parse(ev.occurredAt);
  const threadComment =
    thread?.comments.find(
      (c) => Date.parse(c.createdAt) === evMs && c.authorId === ev.actorId,
    ) ?? thread?.comments[0];
  // The code anchor is the thread's location; prefer the clicked comment's hunk but
  // fall back to the root's (replies often carry no diffHunk).
  const anchor = thread
    ? firstHunkLine(threadComment?.diffHunk ?? thread.comments[0]?.diffHunk ?? null)
    : null;

  // Commit + PR-comment markers resolve their detail (sha / message / body /
  // GitHub link) from the PR detail, joined by the event's ref id — keeps the
  // timeline payload lean (no bodies on /api/timeline).
  const isCommit = ev.type === 'commit_pushed';
  const isPrComment = ev.type === 'pr_comment';
  const { data: prDetail } = usePr(
    (isCommit || isPrComment) && ev.prId != null ? ev.prId : null,
  );
  const commit =
    isCommit && prDetail ? prDetail.commits.find((c) => c.id === ev.refId) : undefined;
  const prComment =
    isPrComment && prDetail
      ? prDetail.comments.find((c) => c.id === ev.refId)
      : undefined;

  const pr = ev.prId != null ? prsById.get(ev.prId) : undefined;

  const openInDetail = () => {
    if (ev.threadId != null) selectThread(ev.prId, ev.threadId);
    // A PR comment lives in the Overview tab's "PR comments" section — select the
    // PR and ask PrDetail to scroll to + flash that specific card (refId is the
    // comment row id), mirroring how a review comment opens its thread.
    else if (isPrComment && ev.prId != null && ev.refId != null)
      showPrComment(ev.prId, ev.refId);
    else if (ev.prId != null) selectPr(ev.prId);
    onNavigate();
  };

  // Jump to this commit's row in the PR-detail Activity tab.
  const viewInActivity = () => {
    if (ev.prId == null) return;
    showActivityEntry(ev.prId, { type: ev.type, refId: ev.refId });
    onNavigate();
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 text-[11px]">
        <span
          className="inline-block h-3 w-3"
          dangerouslySetInnerHTML={{ __html: vis.svg }}
        />
        <span className="font-semibold">{who}</span>
        <span className="text-gray-500">· {vis.label}</span>
        <span className="ml-auto text-gray-400">{relativeTime(ev.occurredAt)}</span>
      </div>

      {pr && (
        <PrContext ev={ev} pr={pr} usersById={usersById} onOpen={openInDetail} />
      )}

      {isCommit && (
        <div className="text-[11px]">
          {commit ? (
            <div className="flex items-center gap-1.5">
              <code className="rounded bg-gray-100 px-1 font-mono text-gray-600 dark:bg-gray-800 dark:text-gray-300">
                {commit.sha.slice(0, 7)}
              </code>
              {commit.message && (
                <span className="truncate text-gray-600 dark:text-gray-300">
                  {commit.message.split('\n')[0]}
                </span>
              )}
            </div>
          ) : (
            <span className="text-gray-400">loading commit…</span>
          )}
        </div>
      )}

      {thread && (
        <div className="flex items-center gap-1.5 text-[11px]">
          <code className="truncate font-mono text-gray-600 dark:text-gray-300">
            {thread.path}
            {thread.line != null ? `:${thread.line}` : ''}
          </code>
          <span className="ml-auto shrink-0">
            <StateBadge state={thread.derivedState} />
          </span>
        </div>
      )}

      {anchor && (
        <pre className="overflow-x-auto rounded border border-gray-200 bg-gray-50 px-2 py-1 font-mono text-[11px] leading-snug text-gray-600 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-300">
          {anchor}
        </pre>
      )}

      {threadComment && (
        <div className="text-xs">
          <Markdown>{threadComment.body}</Markdown>
          {thread && thread.comments.length > 1 && (
            <div className="mt-1 text-[11px] text-gray-400">
              +{thread.comments.length - 1} more in thread
            </div>
          )}
        </div>
      )}

      {isPrComment && (
        <div className="text-xs">
          {prComment ? (
            <Markdown>{prComment.body}</Markdown>
          ) : (
            <span className="text-gray-400">loading comment…</span>
          )}
        </div>
      )}

      <div className="flex items-center gap-3 pt-0.5 text-[11px]">
        {/* Commits (and lifecycle events, which never render a marker) drop the
            "Open in detail pane" link — clicking the marker already opens the PR
            in the detail pane, and commits get "View in Activity" instead. Other
            types keep it: a review comment opens its specific thread, etc. */}
        {!isCommit && (
          <button
            type="button"
            onClick={openInDetail}
            className="text-blue-500 hover:underline"
          >
            Open in detail pane
          </button>
        )}
        {isCommit && ev.prId != null && (
          <button
            type="button"
            onClick={viewInActivity}
            className="text-blue-500 hover:underline"
            title="Show this commit in the PR's Activity tab"
          >
            View in Activity
          </button>
        )}
        {isCommit && commit && prDetail && (
          <a
            href={`${prDetail.githubUrl}/commits/${commit.sha}`}
            target="_blank"
            rel="noreferrer noopener"
            className="text-blue-500 hover:underline"
          >
            Open commit on GitHub ↗
          </a>
        )}
        {isPrComment && prComment && prDetail && (
          <a
            href={prComment.url ?? prDetail.githubUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="text-blue-500 hover:underline"
          >
            Open on GitHub ↗
          </a>
        )}
      </div>
    </div>
  );
}

export function MarkerPopover({
  state,
  eventsById,
  usersById,
  prsById,
  focusPrId,
  onContextFocus,
  onDismiss,
  onNavigate,
}: {
  state: PopoverState;
  eventsById: Map<number, TimelineEvent>;
  usersById: Map<number, User>;
  prsById: Map<number, TimelinePr>;
  // When a sticky PR-isolation focus is active, the popover is trimmed to just that
  // PR's events — the focus view shows only the PR's activity.
  focusPrId?: number | null;
  onContextFocus: (ctx: ContextFocus) => void;
  onDismiss: () => void;
  onNavigate: () => void;
}): JSX.Element {
  // Persisted across reloads so the user's chosen size becomes the default for
  // every marker modal going forward (Fix 2).
  const [popoverSize, setPopoverSize] = useLocalStorage<{
    width: number;
    height: number;
  } | null>('ghtm:popoverSize', null);

  const { refs, floatingStyles, context, isPositioned } = useFloating({
    open: true,
    onOpenChange: (o) => {
      if (!o) onDismiss();
    },
    // Open to the SIDE of the click, not on top of it: `right-start` puts the
    // modal's top-left just past the cursor so the clicked marker stays visible,
    // and being top-aligned it extends downward — never up over an own-work PR
    // bar (which sits on the line directly above the marker). flip() swings it
    // left when there's no room on the right; `bottom` is the last resort on a
    // narrow viewport. shift() keeps it on-screen vertically.
    placement: 'right-start',
    middleware: [
      // Sit clear of the clicked marker — the virtual reference is a zero-size
      // point at the click coords, so this gap is the only thing keeping the modal
      // edge off the marker. Kept generous enough that the marker stays fully
      // visible beside the popover.
      offset(24),
      flip({ fallbackPlacements: ['left-start', 'bottom'] }),
      shift({ padding: 8 }),
    ],
    whileElementsMounted: autoUpdate,
  });
  // Outside-press is disabled: clicking the timeline must NOT close the modal
  // (the user explores while it stays open). Escape + the header X still close it.
  const dismiss = useDismiss(context, { outsidePress: false });
  const { getFloatingProps } = useInteractions([dismiss]);

  // Anchor to the click coordinates via a virtual reference element.
  useEffect(() => {
    refs.setReference({
      getBoundingClientRect: () =>
        ({
          x: state.x,
          y: state.y,
          top: state.y,
          left: state.x,
          right: state.x,
          bottom: state.y,
          width: 0,
          height: 0,
        }) as DOMRect,
    });
  }, [refs, state.x, state.y]);

  const events = state.eventIds
    .map((id) => eventsById.get(id))
    .filter((e): e is TimelineEvent => e != null)
    // In PR-isolation focus, only the focused PR's events are visible.
    .filter((e) => focusPrId == null || e.prId === focusPrId);

  // Every event in the popover belongs to ONE PR (clusters are PR-partitioned), so
  // report that PR to Timeline to glow its band. We never request a row collapse
  // (`groupIds: null`): the unified PR-isolation focus is entered by Timeline's click
  // handler for cross-user markers/clusters, and there `onPopoverContext` ignores
  // popover context while a focus is up. Outside focus this just glows the own-work
  // PR band without collapsing anything.
  const popoverPrId = events[0]?.prId ?? null;
  useEffect(() => {
    onContextFocus({ groupIds: null, prId: popoverPrId, eventId: null });
  }, [popoverPrId, onContextFocus]);

  const persistSize = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    setPopoverSize({ width: el.offsetWidth, height: el.offsetHeight });
  };

  // Drag-to-move: an offset added on top of floating-ui's computed position.
  // Listeners are mounted once and gated by dragRef, so they're cleaned up on
  // unmount and never leak even if a drag ends off-screen.
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);
  useEffect(() => {
    const move = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      setDragOffset({ x: d.ox + (ev.clientX - d.sx), y: d.oy + (ev.clientY - d.sy) });
    };
    const up = () => {
      dragRef.current = null;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, []);
  const onDragStart = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dragRef.current = { sx: e.clientX, sy: e.clientY, ox: dragOffset.x, oy: dragOffset.y };
  };

  const composedTransform = `${floatingStyles.transform ?? ''} translate(${dragOffset.x}px, ${dragOffset.y}px)`.trim();

  return (
    <div
      ref={refs.setFloating}
      style={{
        ...floatingStyles,
        transform: composedTransform,
        // Hidden until floating-ui has measured against the virtual click reference,
        // so the modal never flashes at the top-left (0,0) before settling beside the
        // cursor. visibility (not display:none) keeps it measurable meanwhile.
        visibility: isPositioned ? 'visible' : 'hidden',
        width: popoverSize?.width ?? 420,
        height: popoverSize?.height ?? 340,
        minWidth: 240,
        minHeight: 120,
        maxWidth: '92vw',
        maxHeight: '80vh',
        resize: 'both',
        overflow: 'hidden',
      }}
      {...getFloatingProps()}
      onPointerUp={persistSize}
      className="z-50 flex flex-col rounded-lg border border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-900"
    >
      <div className="tl-modal-header" onPointerDown={onDragStart}>
        <svg className="tl-grip" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <g fill="currentColor">
            <circle cx="2" cy="2" r="1" />
            <circle cx="8" cy="2" r="1" />
            <circle cx="2" cy="5" r="1" />
            <circle cx="8" cy="5" r="1" />
            <circle cx="2" cy="8" r="1" />
            <circle cx="8" cy="8" r="1" />
          </g>
        </svg>
        <span className="tl-modal-title">
          {events.length > 1 ? `${events.length} events` : 'Activity'}
        </span>
        <button
          type="button"
          className="tl-modal-close"
          // Stop the pointerdown so it doesn't start a header drag; the click closes.
          onPointerDown={(e) => e.stopPropagation()}
          onClick={onDismiss}
          aria-label="Close"
          title="Close"
        >
          ✕
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2">
        {/* Every event in the marker/cluster is shown fully expanded and stacked,
            scrollable — no intermediate list to click through. */}
        {events.length === 1 ? (
          <SingleEvent
            ev={events[0]!}
            usersById={usersById}
            prsById={prsById}
            onNavigate={onNavigate}
          />
        ) : (
          <div className="divide-y divide-gray-200 dark:divide-gray-800">
            {events.map((ev) => (
              <div key={ev.id} className="py-2 first:pt-0 last:pb-0">
                <SingleEvent
                  ev={ev}
                  usersById={usersById}
                  prsById={prsById}
                  onNavigate={onNavigate}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
