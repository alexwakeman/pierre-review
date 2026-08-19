import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  AI_FIX_MAX_COMMENT_TARGETS,
  type AiFixCommentTargetRef,
  type PrDetail,
  type User,
} from '@pierre-review/shared';
import {
  buildPickerModel,
  capNotice,
  movableAll,
  pickerKey,
  type PickerComment,
} from '../../lib/aiFixCommentModel.js';
import { indexUsers, relativeTime, safeExternalUrl } from '../../lib/ui.js';
import { useRepos } from '../../hooks/useTimeline.js';
import { useDetectedReviewers } from '../../hooks/useBotTriage.js';
import { useMlLabelIndex, useMlSeverityEnabled } from '../../hooks/useMlLabels.js';
import {
  useAiFixCommentActions,
  useAiFixSelection,
} from '../../store/aiFixComments.js';
import { Markdown } from '../Markdown.js';
import { MlSeverityBadge } from '../MlSeverityBadge.js';
import { UserName } from '../UserName.js';

// "Fix from comments": the picker that seeds an AI-Fix run with the PR's OWN review comments.
// A scrollable list of every comment on the right, a basket on the left, drag either way.
//
// Everything that decides WHAT is offered lives in lib/aiFixCommentModel.ts (pure, tested). This
// file is chrome, drag plumbing and copy.
//
// Two rules the copy has to keep, because both are claims the data cannot support:
//   • the body shown may be a ~160-char EXCERPT, not the comment (`CommentDetail.body` is
//     `body ?? excerpt ?? ''` under lean storage, with no flag distinguishing them) — so nothing
//     here says "the full comment";
//   • the list is capped at GitHub's page size per kind, so "Move all" is not "everything"
//     (`capNotice`).

// ── drag transport ─────────────────────────────────────────────────────────────────────────────
// POINTER EVENTS, NOT HTML5 DRAG-AND-DROP, and this is a decision rather than an accident. An
// earlier version of this file used `dataTransfer` with two MIME types and worked; it was replaced
// for two reasons that outlive it:
//
//   1. ONE drag model in one codebase. Every other drag in the SPA is pointer-driven — the tab
//      strip's reorder (PinnedTabsBar, which sets `draggable={false}` outright), MarkerPopover's
//      move, App's split resize — so a second mechanism here means two sets of bugs to learn.
//   2. HTML5 DnD DOES NOT FIRE ON TOUCH AT ALL. Pointer events do, which is the difference between
//      "the basket is unusable on a tablet" and "it works".
//
// This is PinnedTabsBar's implementation with the reorder preview replaced by a two-zone hit test,
// including each of its hard-won details (4px threshold, capture only after it, window-level
// listeners, capture-phase Escape, the async click-swallow clear) commented at its own site.
//
// Drag is never the only path: every row keeps its real +/− button and the header keeps "Move all",
// which is what a keyboard reaches, and both zones are labelled.

type Zone = 'basket' | 'list';

/** Installed on a row's GRIP — the handlers read the row's identity off its data attributes. */
/**
 * ONE handler, by design: `pointerdown` records the press and arms window-level listeners that own
 * the rest of the gesture. React handlers for move/up/cancel on the grip itself would only ever
 * fire while the pointer is still inside an ~11px glyph, which a mouse leaves on its first move.
 */
interface GripHandlers {
  onPointerDown: (e: React.PointerEvent<HTMLElement>) => void;
}

interface DragRecord {
  key: string;
  from: Zone;
  pointerId: number;
  startX: number;
  startY: number;
  el: HTMLElement;
  dragging: boolean;
}

const BTN_MINI =
  'shrink-0 rounded border border-gray-300 px-1.5 py-0.5 text-[11px] leading-none text-gray-600 hover:border-gray-400 disabled:opacity-40 dark:border-gray-700 dark:text-gray-300 dark:hover:border-gray-500';

const BODY_COLLAPSED_MAX = 220;

/** Enough to stay usable when the user has dragged the PR-detail split almost shut. */
const MIN_PANE_PX = 200;
/**
 * The share of the scrolling pane the two columns may take.
 *
 * ⚠ NEITHER a `vh` fraction NOR a fixed `rem` cap. PrDetail is routinely a SHORT bottom split pane
 * (measured: 405px), and any viewport- or constant-derived height overflows it — the box's bottom
 * then sits below the fold and its tail can never be scrolled into sight, which is the exact bug
 * the Changes-tab rail's measuring effect exists to fix. Not the FULL measured height either, which
 * is what that rail can afford: the launch control sits directly below this section, and a
 * full-height picker would push "Generate fix" behind a scroll.
 */
const PANE_SHARE = 0.5;

/**
 * A comment body under a height clamp with a "Show more" escape.
 *
 * The user is choosing what to send to an agent, so the default is the WHOLE body we hold rather
 * than a truncated preview — bounded by a clamp, never a hard cut, so nothing is silently lost.
 *
 * The ResizeObserver watches the UNCLAMPED inner content, copied from BotCommentCard for the same
 * reason it exists there: images and rendered tables contribute 0 height at first paint, so a
 * one-shot measurement decides "no toggle needed" and the clamp then truncates in silence.
 */
function CardBody({ body }: { body: string }): JSX.Element {
  const outerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);

  useEffect(() => {
    const outer = outerRef.current;
    const inner = innerRef.current;
    if (!outer || !inner) return;
    const measure = (): void => {
      if (expanded) return; // expanded shows everything — nothing to clamp or measure
      setOverflows(outer.scrollHeight > outer.clientHeight + 4);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(inner);
    return () => ro.disconnect();
  }, [body, expanded]);

  return (
    <div className="mt-1 text-sm">
      <div
        ref={outerRef}
        className={expanded ? '' : 'overflow-hidden'}
        style={expanded ? undefined : { maxHeight: BODY_COLLAPSED_MAX }}
      >
        <div ref={innerRef}>
          <Markdown>{body}</Markdown>
        </div>
      </div>
      {(overflows || expanded) && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 text-[11px] font-medium text-sky-600 hover:underline dark:text-sky-400"
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}

/**
 * Where a comment sits, or the honest statement that it sits nowhere.
 *
 * A review comment's position lives on its THREAD, and `line` is null for ~90% of outdated threads
 * — in which case the only answer available is reconstructed from the anchor hunk, i.e. the line in
 * the commit the comment was WRITTEN against. That is rendered as `~<line>` and says so on hover;
 * it is never presented as the current line. PR comments and review bodies have no location at all
 * and are named rather than shown with an empty anchor.
 */
function AnchorLabel({ c }: { c: PickerComment }): JSX.Element {
  if (c.kind === 'pr_comment') {
    return (
      <span className="text-gray-400" title="A top-level PR comment — not tied to a file or line.">
        PR comment
      </span>
    );
  }
  if (c.kind === 'review') {
    return (
      <span className="text-gray-400" title="A review's summary body — not tied to a file or line.">
        review summary
      </span>
    );
  }
  const approximate = c.line == null && c.approxLine != null;
  const line = c.line ?? c.approxLine;
  return (
    <span
      className="truncate font-mono text-gray-500 dark:text-gray-400"
      title={
        approximate
          ? `${c.path} — line ~${line ?? '?'} reconstructed from the anchor hunk, so it is the line in the commit this was written against, not the current one.`
          : `${c.path}${line != null ? `:${line}` : ' — GitHub no longer reports a line for this thread.'}`
      }
    >
      {c.path}
      {line != null ? `:${approximate ? '~' : ''}${line}` : ''}
    </span>
  );
}

/**
 * The drag handle.
 *
 * ⚠ `touch-none select-none` (PinnedTabsBar's pair, mirrored in index.css) is on the GRIP and not on
 * the row: without it the enclosing overflow scroll and text selection swallow the gesture before
 * any handler sees it — but a row here contains a rendered comment body, and killing selection over
 * that would stop a reader copying the code snippet they are being asked to judge. Hence a
 * dedicated handle; the +/− button beside it is the keyboard path.
 */
function Grip({
  itemKey,
  from,
  drag,
}: {
  itemKey: string;
  from: Zone;
  drag: GripHandlers;
}): JSX.Element {
  return (
    <span
      role="presentation"
      data-pickerkey={itemKey}
      data-pickerfrom={from}
      {...drag}
      title={
        from === 'list'
          ? 'Drag into the fix scope (or press +)'
          : 'Drag out of the fix scope (or press −)'
      }
      className="shrink-0 cursor-grab touch-none select-none px-0.5 text-xs leading-none text-gray-300 hover:text-gray-500 dark:text-gray-600 dark:hover:text-gray-400"
    >
      ⠿
    </span>
  );
}

interface RowProps {
  c: PickerComment;
  usersById: Map<number, User>;
  repoId: number;
  /** True in the basket (renders the − control and drags out); false in the list. */
  inScope: boolean;
  /** List side only: already in the basket, so the + is spent. */
  selected: boolean;
  /** The basket is full — the + must stop working rather than let the tail be dropped. */
  atCap: boolean;
  disabled: boolean;
  /** Undefined while `disabled` — no grip is rendered at all then. */
  drag: GripHandlers | undefined;
  /** This row is the one currently being dragged. */
  dragging: boolean;
  onAddToScope: (refs: AiFixCommentTargetRef[]) => void;
  onRemoveFromScope: (refs: AiFixCommentTargetRef[]) => void;
}

function CommentRowImpl({
  c,
  usersById,
  repoId,
  inScope,
  selected,
  atCap,
  disabled,
  drag,
  dragging,
  onAddToScope,
  onRemoveFromScope,
}: RowProps): JSX.Element {
  const user = c.authorId != null ? usersById.get(c.authorId) : undefined;
  const muted = c.isResolved || c.isOutdated;
  const ref: AiFixCommentTargetRef = { kind: c.kind, id: c.id };
  const href = safeExternalUrl(c.url);

  return (
    <div
      className={`flex items-stretch overflow-hidden rounded border ${
        c.isReply ? 'ml-4 border-dashed' : ''
      } ${
        selected && !inScope
          ? 'border-blue-300 bg-blue-50/40 dark:border-blue-800 dark:bg-blue-950/20'
          : 'border-gray-200 dark:border-gray-800'
      } ${muted ? 'opacity-60' : ''}${dragging ? ' opacity-50' : ''}`}
    >
      <div className="min-w-0 flex-1 px-2 py-1.5">
      <div className="flex items-center gap-1.5 text-[11px]">
        {drag != null && <Grip itemKey={c.key} from={inScope ? 'basket' : 'list'} drag={drag} />}
        <UserName user={user} fallbackId={c.authorId} repoId={repoId} className="font-semibold" />
        {c.isReply && (
          <span className="rounded bg-gray-100 px-1 text-[10px] uppercase tracking-wide text-gray-500 dark:bg-gray-800 dark:text-gray-400">
            reply
          </span>
        )}
        <span className="text-gray-400">{relativeTime(c.createdAt)}</span>
        <span className="min-w-0 flex-1 truncate">
          <AnchorLabel c={c} />
        </span>
        {c.isResolved && <span className="shrink-0 text-gray-400">resolved</span>}
        {c.isOutdated && <span className="shrink-0 text-gray-400">outdated</span>}
        {href && (
          <a
            href={href}
            target="_blank"
            rel="noreferrer noopener"
            className="shrink-0 text-gray-400 hover:text-sky-600 dark:hover:text-sky-400"
            title="Open on GitHub"
          >
            ↗
          </a>
        )}
      </div>
      {c.isBot && c.label && (
        <div className="mt-1">
          <MlSeverityBadge label={c.label} />
        </div>
      )}
      <CardBody body={c.body} />
      </div>
      {/* THE MOVE CONTROL IS A FULL-HEIGHT COLUMN, not a 21px glyph in the header row.
          It is the primary way into the fix scope (drag is the shortcut, not the reverse), so it
          gets a target proportional to that: the whole right edge of the card, which is also the
          direction the comment travels on this layout — list on the left, scope on the right. */}
      {inScope ? (
        <button
          type="button"
          className="flex w-10 shrink-0 items-center justify-center self-stretch border-l border-gray-200 bg-gray-50 text-xl font-light leading-none text-gray-500 transition-colors hover:bg-red-100 hover:text-red-700 disabled:opacity-40 disabled:hover:bg-gray-50 dark:border-gray-800 dark:bg-gray-800/60 dark:text-gray-400 dark:hover:bg-red-950/50 dark:hover:text-red-300"
          disabled={disabled}
          onClick={() => onRemoveFromScope([ref])}
          aria-label={`Remove ${c.authorLogin}'s comment from the fix scope`}
          title="Remove from the fix scope"
        >
          −
        </button>
      ) : (
        <button
          type="button"
          className={`flex w-10 shrink-0 items-center justify-center self-stretch border-l text-xl font-light leading-none transition-colors ${
            selected
              ? 'border-blue-200 bg-blue-100 text-blue-600 dark:border-blue-900 dark:bg-blue-950/60 dark:text-blue-300'
              : 'border-gray-200 bg-gray-50 text-gray-500 hover:bg-blue-100 hover:text-blue-700 disabled:opacity-40 disabled:hover:bg-gray-50 dark:border-gray-800 dark:bg-gray-800/60 dark:text-gray-400 dark:hover:bg-blue-950/50 dark:hover:text-blue-300'
          }`}
          disabled={disabled || selected || atCap}
          onClick={() => onAddToScope([ref])}
          aria-label={`Add ${c.authorLogin}'s comment to the fix scope`}
          title={
            selected
              ? 'Already in the fix scope'
              : atCap
                ? `The fix scope is full (${AI_FIX_MAX_COMMENT_TARGETS} comments)`
                : 'Add to the fix scope'
          }
        >
          {/* A tick, not a disabled +: "already in scope" is a STATE worth reading at a glance
              down a 60-row list, and a greyed-out + reads as "broken" rather than "done". */}
          {selected ? '✓' : '+'}
        </button>
      )}
    </div>
  );
}

// An explicit comparator over exactly the render inputs: markdown + syntax highlighting is the
// dominant cost on this surface, and a bot-flooded PR puts 60+ of these on a tab that also renders
// diffs. `c` is stable while the memoised model is, the maps/callbacks/grip handlers are memoised by
// the parent, and `Markdown` is itself memoised on its body string — so even a model rebuild with
// unchanged text skips the re-parse. `dragging` is the one prop that flips mid-gesture, and only for
// the single row being dragged.
const CommentRow = memo(
  CommentRowImpl,
  (a, b) =>
    a.c === b.c &&
    a.usersById === b.usersById &&
    a.repoId === b.repoId &&
    a.inScope === b.inScope &&
    a.selected === b.selected &&
    a.atCap === b.atCap &&
    a.disabled === b.disabled &&
    a.drag === b.drag &&
    a.dragging === b.dragging &&
    a.onAddToScope === b.onAddToScope &&
    a.onRemoveFromScope === b.onRemoveFromScope,
);

// `self-start` + a MEASURED cap (below), never `h-full overflow-auto`: PrDetail's
// `min-h-0 flex-1 overflow-auto` tab body is the ONLY scroll container on the page, and every
// `sticky top-0` header on it resolves against that box — a nested full-height scroller here would
// move their containing block.
const PANE = 'self-start overflow-y-auto overscroll-contain rounded border p-1.5';

export function CommentPicker({
  pr,
  disabled,
}: {
  pr: PrDetail;
  disabled: boolean;
}): JSX.Element {
  // ⚠ THE PR'S OWN WORKSPACE, NOT THE SELECTED ONE. Who counts as a bot is a per-workspace fact
  // (`workspace_reviewers`), and this PR can be open from a different workspace entirely — a
  // `?pr=<id>` deep link, a restored `pierre:tabs` entry, a search hit. Reading
  // `filters.workspaceId` here would group the list from workspace X's judgements while the PR
  // lives in workspace Y: the dead-control class of bug ThreadList/resolvable.ts documents.
  // `Repo.workspaceId` is the only repo→workspace mapping the client has.
  //
  // Fetched UNNARROWED (no repoIds): the judgement is workspace-wide, and that unscoped key is the
  // entry FeedView + useBotColors already keep warm, so opening this tab usually costs no request.
  // Until it resolves the split falls back to the global `users.isBot` flag — a graceful degrade,
  // not a read from the wrong workspace.
  const { data: repos } = useRepos();
  const prWorkspaceId = useMemo(
    () => (repos ?? []).find((r) => r.id === pr.repoId)?.workspaceId ?? null,
    [repos, pr.repoId],
  );
  const { data: detected } = useDetectedReviewers(prWorkspaceId);
  const mlEnabled = useMlSeverityEnabled();
  const labels = useMlLabelIndex(pr.id, mlEnabled);

  const usersById = useMemo(() => indexUsers(pr.users), [pr.users]);
  const reviewerByUserId = useMemo(() => {
    const m = new Map<number, { automated: boolean; isManualOverride: boolean }>();
    for (const r of detected?.reviewers ?? []) m.set(r.userId, r);
    return m;
  }, [detected]);
  // The UNION verdict, identical to FeedView's `isUnionBot`: the workspace's stored row wins in
  // BOTH directions (a manual "this is a human" beats the global isBot flag), `users.isBot`
  // decides everything else.
  const isBot = useCallback(
    (userId: number | null): boolean => {
      if (userId == null) return false;
      const r = reviewerByUserId.get(userId);
      if (r != null) {
        if (r.automated) return true;
        if (r.isManualOverride) return false;
      }
      return usersById.get(userId)?.isBot ?? false;
    },
    [reviewerByUserId, usersById],
  );

  const [showReplies, setShowReplies] = useState(false);
  const model = useMemo(
    () => buildPickerModel(pr, { labels, isBot, includeReplies: showReplies }),
    [pr, labels, isBot, showReplies],
  );

  const selection = useAiFixSelection(pr.id);
  const { add, remove, clear } = useAiFixCommentActions();
  const selectedKeys = useMemo(
    () => new Set(selection.map((r) => pickerKey(r.kind, r.id))),
    [selection],
  );
  const atCap = selection.length >= AI_FIX_MAX_COMMENT_TARGETS;

  const onAddToScope = useCallback(
    (refs: AiFixCommentTargetRef[]) => add(pr.id, refs),
    [add, pr.id],
  );
  const onRemoveFromScope = useCallback(
    (refs: AiFixCommentTargetRef[]) => remove(pr.id, refs),
    [remove, pr.id],
  );

  // Rendered from `byKey`, which carries replies even while they are hidden — otherwise a reply
  // the user deliberately dragged in would disappear the moment they collapsed the reply rows,
  // leaving a selection they cannot see or remove. A ref with no row at all (the PR refetched and
  // the comment is gone) still gets a removable stub rather than vanishing silently.
  const basket = useMemo(
    () =>
      selection.map((r) => ({
        ref: r,
        comment: model.byKey.get(pickerKey(r.kind, r.id)) ?? null,
      })),
    [selection, model],
  );

  const movable = useMemo(() => movableAll(model), [model]);
  const unselectedMovable = useMemo(
    () => movable.filter((r) => !selectedKeys.has(pickerKey(r.kind, r.id))),
    [movable, selectedKeys],
  );
  // ⚠ CLAMPED TO THE REMAINING CAPACITY, and both the label and the click use the same slice.
  // The store stops adding at AI_FIX_MAX_COMMENT_TARGETS, so an unclamped "Move all (10)" with 24
  // already in scope added ONE and dropped nine — the only feedback being a bar that says the
  // scope is full, which is not the same sentence as "nine of the comments you just asked for were
  // discarded". A count a click cannot deliver is worse than a smaller honest one.
  const moveAllBatch = useMemo(
    () => unselectedMovable.slice(0, Math.max(0, AI_FIX_MAX_COMMENT_TARGETS - selection.length)),
    [unselectedMovable, selection.length],
  );

  // ── drag state ───────────────────────────────────────────────────────────────────────────────
  const basketRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragRecord | null>(null);
  // True from drag-mode entry until just after the drop's own click — guards the +/− buttons so a
  // drop landing over one doesn't also toggle it.
  const draggedRef = useRef(false);
  const [drag, setDrag] = useState<{ key: string; from: Zone } | null>(null);
  // DRAG PREVIEW ONLY, never written to the store: a store write per pointer frame would run every
  // subscriber, and the commit happens exactly once, on drop. The ref mirrors the state for the
  // synchronous read in `endDrag`, where the state closure would be stale.
  const hoverRef = useRef<Zone | null>(null);
  const [hoverZone, setHoverZone] = useState<Zone | null>(null);
  // The lookup `endDrag` needs, off the render path so a model rebuild mid-gesture can't tear it.
  const byKeyRef = useRef(model.byKey);
  useEffect(() => {
    byKeyRef.current = model.byKey;
  }, [model]);

  const zoneAt = useCallback((x: number, y: number): Zone | null => {
    const hit = (el: HTMLElement | null): boolean => {
      if (el == null) return false;
      const r = el.getBoundingClientRect();
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    };
    if (hit(basketRef.current)) return 'basket';
    if (hit(listRef.current)) return 'list';
    return null;
  }, []);

  const endDrag = useCallback(
    (commit: boolean) => {
      const d = dragRef.current;
      dragRef.current = null;
      if (d?.dragging) {
        try {
          d.el.releasePointerCapture(d.pointerId);
        } catch {
          /* already released */
        }
        // Dropping back on the column it came from — or anywhere outside both — is a cancel.
        const zone = commit ? hoverRef.current : null;
        const c = zone != null && zone !== d.from ? byKeyRef.current.get(d.key) : undefined;
        if (c != null) {
          const refs = [{ kind: c.kind, id: c.id }];
          if (zone === 'basket') onAddToScope(refs);
          else onRemoveFromScope(refs);
        }
      }
      hoverRef.current = null;
      setHoverZone(null);
      setDrag(null);
      // Cleared once the drop's own click (which fires after pointerup) has been consumed. Clearing
      // it on the next pointerdown instead would also swallow KEYBOARD activation — Enter/Space
      // produce a click with no preceding pointerdown.
      if (draggedRef.current) {
        setTimeout(() => {
          draggedRef.current = false;
        }, 0);
      }
    },
    [onAddToScope, onRemoveFromScope],
  );

  // Escape cancels an in-flight drag. Capture-phase + stopPropagation so the global `esc`
  // (useKeyboard → showTimeline) doesn't also fire and yank the reader off the PR.
  useEffect(() => {
    if (drag == null) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      endDrag(false);
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [drag, endDrag]);

  // WINDOW-level listeners own the WHOLE gesture — the 4px threshold phase INCLUDED — armed
  // imperatively from `onPointerDown` and torn down by `endDrag`.
  //
  // ⚠ THE THRESHOLD TEST CANNOT LIVE ON THE GRIP. It did, and that made a normal-speed drag do
  // nothing at all. The grip is one ⠿ glyph, ~11×12px. A MOUSE gets no implicit pointer capture
  // (the spec grants it only to direct-manipulation pointers — touch and pen), and capture must
  // not be taken on pointerdown because that retargets the resulting click and breaks plain
  // activation. So at any real drag speed (~8px/frame at 500px/s) the first pointermove after
  // pointerdown already lands OUTSIDE the glyph: a handler attached to the grip never fires again,
  // `dragging` stays false, and no drag-phase listener is ever mounted — no ghost, no hover ring,
  // no write, and a stale pending record left behind. It works only when dragged slowly from the
  // glyph's centre, which is exactly why a hand test passes it. (PinnedTabsBar's version of this
  // pattern is safe because its handlers sit on the whole chip wrapper, a target wide enough that
  // the threshold move still lands on it — shrinking the element to a glyph is what breaks it.)
  //
  // Arming BOTH phases in one imperative set also closes a gap the state-keyed version had: with
  // the drag-phase listeners mounted by an effect keyed on `drag`, a pointerup landing between the
  // threshold move and that render would have been seen by nobody, and the drag would never end.
  //
  // Pressing still writes NO state — the pending record is a ref, so a plain click costs no
  // re-render. And the ghost is positioned by a DIRECT STYLE WRITE rather than state: a setState
  // per pointermove would reconcile every row on screen ~60 times a second, while `hoverZone`
  // re-renders on the only transitions that matter.
  const disarmRef = useRef<(() => void) | null>(null);
  const zoneAtRef = useRef(zoneAt);
  const endDragRef = useRef(endDrag);
  useEffect(() => {
    zoneAtRef.current = zoneAt;
    endDragRef.current = endDrag;
  }, [zoneAt, endDrag]);
  const disarm = useCallback(() => {
    disarmRef.current?.();
    disarmRef.current = null;
  }, []);
  // endDrag is the single teardown point for the drag phase, so it must also disarm.
  useEffect(() => {
    endDragRef.current = (commit: boolean) => {
      endDrag(commit);
      disarm();
    };
  }, [endDrag, disarm]);

  const armGesture = useCallback(() => {
    disarm(); // a previous press that never resolved must not keep listening
    const move = (e: PointerEvent): void => {
      const d = dragRef.current;
      if (!d || e.pointerId !== d.pointerId) return;
      if (!d.dragging) {
        // A mouse keeps ONE pointerId across presses, so a stale down-state from a press that
        // ended elsewhere would otherwise start a drag on a mere hover.
        if ((e.buttons & 1) === 0) {
          dragRef.current = null;
          disarm();
          return;
        }
        if (Math.abs(e.clientX - d.startX) <= 4 && Math.abs(e.clientY - d.startY) <= 4) return;
        d.dragging = true;
        draggedRef.current = true;
        // Capture only NOW, past the threshold — see the note above on why not on pointerdown.
        try {
          d.el.setPointerCapture(d.pointerId);
        } catch {
          /* pointer already gone */
        }
        setDrag({ key: d.key, from: d.from });
      } else if ((e.buttons & 1) === 0) {
        // Missed pointerup (released over a context menu, say): treat it as a drop.
        endDragRef.current(true);
        return;
      }
      const g = ghostRef.current;
      if (g != null) g.style.transform = `translate3d(${e.clientX + 12}px, ${e.clientY + 12}px, 0)`;
      const zone = zoneAtRef.current(e.clientX, e.clientY);
      if (zone !== hoverRef.current) {
        hoverRef.current = zone;
        setHoverZone(zone);
      }
    };
    const up = (e: PointerEvent): void => {
      const d = dragRef.current;
      if (!d || e.pointerId !== d.pointerId) return;
      // A press that never crossed the threshold is a plain click: drop the record and let the
      // button's own onClick run (draggedRef was never set, so nothing swallows it).
      if (!d.dragging) {
        dragRef.current = null;
        disarm();
        return;
      }
      endDragRef.current(true);
    };
    const cancel = (e: PointerEvent): void => {
      const d = dragRef.current;
      if (!d || e.pointerId !== d.pointerId) return;
      if (!d.dragging) {
        dragRef.current = null;
        disarm();
        return;
      }
      endDragRef.current(false);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    disarmRef.current = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
    };
  }, [disarm]);

  // Unmounting mid-gesture must not leave window listeners behind.
  useEffect(() => disarm, [disarm]);

  const gripHandlers: GripHandlers = useMemo(
    () => ({
      onPointerDown: (e) => {
        // A second pointer landing mid-drag must not clobber the in-flight record — the original
        // drag's pointerId would stop matching and its endDrag would never run.
        if (dragRef.current?.dragging) return;
        if (e.button !== 0) return;
        const key = e.currentTarget.dataset.pickerkey;
        const from = e.currentTarget.dataset.pickerfrom;
        if (key == null || (from !== 'basket' && from !== 'list')) return;
        draggedRef.current = false;
        dragRef.current = {
          key,
          from,
          pointerId: e.pointerId,
          startX: e.clientX,
          startY: e.clientY,
          el: e.currentTarget,
          dragging: false,
        };
        // Everything else — the 4px threshold, capture, the ghost, the drop — is handled by the
        // window listeners armed here. Deliberately NOT by handlers on this element: the grip is
        // one ⠿ glyph and a mouse's next move has already left it (see the note on armGesture).
        armGesture();
      },
    }),
    [armGesture],
  );

  // The buttons share the drop's click-swallow: a gesture that ends over one must not also toggle it.
  const guardedAdd = useCallback(
    (refs: AiFixCommentTargetRef[]) => {
      if (draggedRef.current) return;
      onAddToScope(refs);
    },
    [onAddToScope],
  );
  const guardedRemove = useCallback(
    (refs: AiFixCommentTargetRef[]) => {
      if (draggedRef.current) return;
      onRemoveFromScope(refs);
    },
    [onRemoveFromScope],
  );

  // ── the measured height cap (see PANE_SHARE) ─────────────────────────────────────────────────
  const notice = capNotice(model.atPageCap);
  const isEmpty = model.byKey.size === 0;
  const rowRef = useRef<HTMLDivElement>(null);
  const [paneMaxH, setPaneMaxH] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = rowRef.current;
    if (el == null) return;
    let pane: HTMLElement | null = el.parentElement;
    while (pane != null) {
      const oy = getComputedStyle(pane).overflowY;
      if (oy === 'auto' || oy === 'scroll') break;
      pane = pane.parentElement;
    }
    const measure = (): void => {
      const h = pane != null ? pane.clientHeight : window.innerHeight;
      setPaneMaxH(Math.max(MIN_PANE_PX, Math.round(h * PANE_SHARE)));
    };
    measure();
    // The pane is user-resizable (the PR-detail split drag), so a one-shot measure goes stale.
    const ro = new ResizeObserver(measure);
    if (pane != null) ro.observe(pane);
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
    // The columns only exist once there is something to list — on an empty PR the ref is null.
  }, [isEmpty]);

  if (isEmpty) {
    // One honest line, no empty containers, no basket to drag into.
    return (
      <p className="mb-2 text-xs text-gray-500 dark:text-gray-400">
        No comments on this PR yet — nothing to fix from.
      </p>
    );
  }

  const dragged = drag != null ? model.byKey.get(drag.key) : undefined;
  // Highlight only the zone a drop would ACT on: releasing over the column the card came from is a
  // cancel, and a ring there would promise something.
  const activeZone = drag != null && hoverZone != null && hoverZone !== drag.from ? hoverZone : null;
  const paneStyle = paneMaxH != null ? { maxHeight: paneMaxH } : undefined;
  const rowDrag = disabled ? undefined : gripHandlers;

  return (
    <section className="mb-3 rounded-md border border-gray-200 dark:border-gray-800">
      {/* Controls are LEFT-PACKED, over the comment list they act on — no spacer pushing them to
          the far edge. Two of the three ("Show N replies", "Move all") operate on the list, which
          is the left column now, and a control parked above the OTHER column reads as belonging to
          it. */}
      <div className="flex flex-wrap items-center gap-2 border-b border-gray-100 px-2 py-1.5 dark:border-gray-800">
        <span className="text-xs font-semibold">Fix from comments</span>
        <span className="text-[11px] text-gray-500 dark:text-gray-400">
          {selection.length} of {AI_FIX_MAX_COMMENT_TARGETS} in the fix scope
        </span>
        {model.replyCount > 0 && (
          <button
            type="button"
            className={BTN_MINI}
            onClick={() => setShowReplies((v) => !v)}
            aria-expanded={showReplies}
          >
            {showReplies ? `Hide ${model.replyCount} replies` : `Show ${model.replyCount} replies`}
          </button>
        )}
        <button
          type="button"
          className={BTN_MINI}
          disabled={disabled || atCap || moveAllBatch.length === 0}
          onClick={() => onAddToScope(moveAllBatch)}
          title={
            moveAllBatch.length < unselectedMovable.length
              ? `Add ${moveAllBatch.length} of the ${unselectedMovable.length} comments shown — the fix scope holds ${AI_FIX_MAX_COMMENT_TARGETS}. Resolved and outdated comments are skipped; a deliberate drag still includes those.`
              : 'Add every comment shown, except the resolved and outdated ones — a deliberate drag still includes those.'
          }
        >
          Move all{moveAllBatch.length > 0 ? ` (${moveAllBatch.length})` : ''}
        </button>
        <button
          type="button"
          className={BTN_MINI}
          disabled={disabled || selection.length === 0}
          onClick={() => clear(pr.id)}
        >
          Clear
        </button>
      </div>

      {(notice || atCap) && (
        <div className="border-b border-gray-100 px-2 py-1 text-[11px] text-gray-500 dark:border-gray-800 dark:text-gray-400">
          {atCap && (
            <span className="text-amber-600 dark:text-amber-400">
              The fix scope is full ({AI_FIX_MAX_COMMENT_TARGETS} comments) — remove one to add
              another.{' '}
            </span>
          )}
          {notice}
        </div>
      )}

      {/* Reading order is the same as the movement: the PR's comments on the LEFT, the fix scope
          they move INTO on the right. The DOM order matches, so a keyboard/screen-reader pass walks
          the list before the basket too. */}
      <div ref={rowRef} className="flex flex-col items-stretch gap-2 p-2 md:flex-row md:items-start">
        {/* ── the full list ──────────────────────────────────────────────────────────────── */}
        <div className="min-w-0 flex-1">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
            The PR's comments
          </div>
          <div
            ref={listRef}
            role="region"
            aria-label="Comment list — drop a comment here to take it out of the fix scope"
            style={paneStyle}
            className={`${PANE} space-y-2 ${
              activeZone === 'list'
                ? 'border-blue-400 bg-blue-50/50 dark:border-blue-600 dark:bg-blue-950/20'
                : 'border-gray-200 dark:border-gray-800'
            }`}
          >
            <Group
              title="Bots"
              rows={model.bots}
              // The order label is a claim about the data, so it tracks whether there is anything
              // to rank: ML labels exist only for bot text and only where the severity service is
              // configured, and calling an arbitrary order "worst first" would be a lie on an
              // `npx` install or an unenriched PR.
              order={model.botsSortedBySeverity ? 'worst first' : 'newest first'}
              usersById={usersById}
              repoId={pr.repoId}
              selectedKeys={selectedKeys}
              atCap={atCap}
              disabled={disabled}
              drag={rowDrag}
              dragKey={drag?.key ?? null}
              onAddToScope={guardedAdd}
              onRemoveFromScope={guardedRemove}
            />
            <Group
              title="People"
              rows={model.humans}
              order="newest first"
              usersById={usersById}
              repoId={pr.repoId}
              selectedKeys={selectedKeys}
              atCap={atCap}
              disabled={disabled}
              drag={rowDrag}
              dragKey={drag?.key ?? null}
              onAddToScope={guardedAdd}
              onRemoveFromScope={guardedRemove}
            />
          </div>
        </div>

        {/* ── the basket ─────────────────────────────────────────────────────────────────── */}
        <div className="md:w-1/3">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
            In the fix scope
          </div>
          <div
            ref={basketRef}
            role="region"
            aria-label="Fix scope — drop a comment here to include it"
            style={paneStyle}
            className={`${PANE} space-y-1.5 ${
              activeZone === 'basket'
                ? 'border-blue-400 bg-blue-50/50 dark:border-blue-600 dark:bg-blue-950/20'
                : 'border-dashed border-gray-300 dark:border-gray-700'
            }`}
          >
            {basket.length === 0 ? (
              <p className="p-1 text-[11px] text-gray-500 dark:text-gray-400">
                Press the + on a comment, or drag it across. The fixer assesses each one before
                changing anything, and reports back per comment.
              </p>
            ) : (
              basket.map(({ ref, comment }, i) =>
                comment ? (
                  <div key={pickerKey(ref.kind, ref.id)} className="flex items-start gap-1">
                    {/* The prompt label the run assigns (C1, C2, …) is POSITIONAL, so showing the
                        position is what lets a report card be matched back to the row picked. */}
                    <span className="pt-1.5 font-mono text-[10px] text-gray-400">C{i + 1}</span>
                    <div className="min-w-0 flex-1">
                      <CommentRow
                        c={comment}
                        usersById={usersById}
                        repoId={pr.repoId}
                        inScope
                        selected
                        atCap={atCap}
                        disabled={disabled}
                        drag={rowDrag}
                        dragging={drag?.key === comment.key}
                        onAddToScope={guardedAdd}
                        onRemoveFromScope={guardedRemove}
                      />
                    </div>
                  </div>
                ) : (
                  <div
                    key={pickerKey(ref.kind, ref.id)}
                    className="flex items-center gap-2 rounded border border-gray-200 px-2 py-1.5 text-[11px] text-gray-500 dark:border-gray-800 dark:text-gray-400"
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {ref.kind} #{ref.id} — no longer in the PR's comment list
                    </span>
                    <button
                      type="button"
                      className={BTN_MINI}
                      disabled={disabled}
                      onClick={() => guardedRemove([ref])}
                      aria-label="Remove this comment from the fix scope"
                    >
                      −
                    </button>
                  </div>
                ),
              )
            )}
          </div>
        </div>
      </div>

      {/* The drag ghost. Positioned imperatively (see the window-listener effect) and
          pointer-events-none, so it can never become its own drop target. */}
      {dragged != null && (
        <div
          ref={ghostRef}
          className="pointer-events-none fixed left-0 top-0 z-[70] max-w-xs truncate rounded border border-blue-400 bg-white px-2 py-1 text-[11px] shadow-lg dark:bg-gray-900"
          style={{ transform: 'translate3d(-9999px, -9999px, 0)' }}
        >
          <span className="font-semibold">{dragged.authorLogin}</span>{' '}
          <span className="text-gray-500 dark:text-gray-400">
            {dragged.body.split('\n').find((l) => l.trim() !== '')?.slice(0, 60) ?? ''}
          </span>
        </div>
      )}
    </section>
  );
}

/** One labelled group. Renders nothing at all when empty — no header over an empty box. */
function Group({
  title,
  rows,
  order,
  usersById,
  repoId,
  selectedKeys,
  atCap,
  disabled,
  drag,
  dragKey,
  onAddToScope,
  onRemoveFromScope,
}: {
  title: string;
  rows: PickerComment[];
  order: string;
  usersById: Map<number, User>;
  repoId: number;
  selectedKeys: Set<string>;
  atCap: boolean;
  disabled: boolean;
  drag: GripHandlers | undefined;
  dragKey: string | null;
  onAddToScope: (refs: AiFixCommentTargetRef[]) => void;
  onRemoveFromScope: (refs: AiFixCommentTargetRef[]) => void;
}): JSX.Element | null {
  if (rows.length === 0) return null;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 text-[11px] text-gray-500 dark:text-gray-400">
        <span className="font-semibold">
          {title} ({rows.length})
        </span>
        <span>· {order}</span>
      </div>
      {rows.map((c) => (
        <CommentRow
          key={c.key}
          c={c}
          usersById={usersById}
          repoId={repoId}
          inScope={false}
          selected={selectedKeys.has(c.key)}
          atCap={atCap}
          disabled={disabled}
          drag={drag}
          dragging={dragKey === c.key}
          onAddToScope={onAddToScope}
          onRemoveFromScope={onRemoveFromScope}
        />
      ))}
    </div>
  );
}
