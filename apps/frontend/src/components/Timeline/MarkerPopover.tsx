import { useEffect, useState } from 'react';
import {
  autoUpdate,
  flip,
  offset,
  shift,
  useDismiss,
  useFloating,
  useInteractions,
} from '@floating-ui/react';
import type { TimelineEvent, User } from '@gh-team-monitor/shared';
import { useThread } from '../../hooks/usePr.js';
import { useFilters } from '../../store/filters.js';
import { relativeTime, userLabel } from '../../lib/ui.js';
import { markerVisual } from './markerTemplate.js';
import { StateBadge } from '../StateBadge.js';
import { Markdown } from '../Markdown.js';

export interface PopoverState {
  x: number;
  y: number;
  eventIds: number[];
}

function firstHunkLine(hunk: string | null): string | null {
  if (!hunk) return null;
  const lines = hunk.replace(/\n$/, '').split('\n');
  // Last line of the hunk is the line the comment anchors to.
  return lines.at(-1) ?? null;
}

function SingleEvent({
  ev,
  usersById,
  onNavigate,
}: {
  ev: TimelineEvent;
  usersById: Map<number, User>;
  onNavigate: () => void;
}): JSX.Element {
  const selectThread = useFilters((s) => s.selectThread);
  const selectPr = useFilters((s) => s.selectPr);
  const vis = markerVisual(ev);
  const actor = ev.actorId != null ? usersById.get(ev.actorId) : undefined;
  const who = userLabel(actor, ev.actorId);

  const isReviewComment = ev.type === 'review_comment' && ev.threadId != null;
  const { data: thread } = useThread(isReviewComment ? ev.threadId : null);
  const anchor = thread ? firstHunkLine(thread.comments[0]?.diffHunk ?? null) : null;

  const openInDetail = () => {
    if (ev.threadId != null) selectThread(ev.prId, ev.threadId);
    else if (ev.prId != null) selectPr(ev.prId);
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

      {thread?.comments[0] && (
        <div className="max-h-32 overflow-y-auto text-xs">
          <Markdown>{thread.comments[0].body}</Markdown>
          {thread.comments.length > 1 && (
            <div className="mt-1 text-[11px] text-gray-400">
              +{thread.comments.length - 1} more in thread
            </div>
          )}
        </div>
      )}

      <div className="flex items-center gap-3 pt-0.5 text-[11px]">
        <button
          type="button"
          onClick={openInDetail}
          className="text-blue-500 hover:underline"
        >
          Open in detail pane
        </button>
      </div>
    </div>
  );
}

function EventList({
  events,
  usersById,
  onPick,
}: {
  events: TimelineEvent[];
  usersById: Map<number, User>;
  onPick: (id: number) => void;
}): JSX.Element {
  return (
    <div className="max-h-64 space-y-0.5 overflow-y-auto">
      <div className="px-1 pb-1 text-[11px] font-semibold text-gray-400">
        {events.length} events
      </div>
      {events.map((ev) => {
        const vis = markerVisual(ev);
        const actor = ev.actorId != null ? usersById.get(ev.actorId) : undefined;
        return (
          <button
            key={ev.id}
            type="button"
            onClick={() => onPick(ev.id)}
            className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[11px] hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            <span
              className="inline-block h-3 w-3 shrink-0"
              dangerouslySetInnerHTML={{ __html: vis.svg }}
            />
            <span className="font-medium">
              {userLabel(actor, ev.actorId)}
            </span>
            <span className="truncate text-gray-500">{vis.label}</span>
            <span className="ml-auto shrink-0 text-gray-400">
              {relativeTime(ev.occurredAt)}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function MarkerPopover({
  state,
  eventsById,
  usersById,
  onClose,
}: {
  state: PopoverState;
  eventsById: Map<number, TimelineEvent>;
  usersById: Map<number, User>;
  onClose: () => void;
}): JSX.Element {
  // When a cluster is opened we start in list mode; picking an item drills in.
  const [picked, setPicked] = useState<number | null>(
    state.eventIds.length === 1 ? state.eventIds[0]! : null,
  );

  const { refs, floatingStyles, context } = useFloating({
    open: true,
    onOpenChange: (o) => {
      if (!o) onClose();
    },
    placement: 'bottom',
    middleware: [offset(10), flip(), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });
  const dismiss = useDismiss(context);
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
    .filter((e): e is TimelineEvent => e != null);
  const pickedEvent = picked != null ? eventsById.get(picked) : undefined;

  // Reset to the cluster list when a different marker/cluster is opened.
  useEffect(() => {
    setPicked(state.eventIds.length === 1 ? state.eventIds[0]! : null);
  }, [state.eventIds]);

  return (
    <div
      ref={refs.setFloating}
      style={floatingStyles}
      {...getFloatingProps()}
      className="z-50 w-72 rounded-lg border border-gray-200 bg-white p-2 shadow-xl dark:border-gray-700 dark:bg-gray-900"
    >
      {pickedEvent ? (
        <div className="space-y-1.5">
          {events.length > 1 && (
            <button
              type="button"
              onClick={() => setPicked(null)}
              className="text-[11px] text-gray-400 hover:text-gray-600"
            >
              ‹ back to {events.length} events
            </button>
          )}
          <SingleEvent ev={pickedEvent} usersById={usersById} onNavigate={onClose} />
        </div>
      ) : (
        <EventList events={events} usersById={usersById} onPick={setPicked} />
      )}
    </div>
  );
}
