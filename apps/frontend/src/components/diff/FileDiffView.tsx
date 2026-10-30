import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type {
  AddReviewCommentResult,
  PrFileDiffStatus,
  ThreadDetail,
  User,
} from '@pierre-review/shared';
import { useAddReviewComment } from '../../hooks/usePrWrites.js';
import { usePrFileContent, usePrFileFullDiff } from '../../hooks/usePr.js';
import { useDiffWrap } from '../../hooks/useDiffWrap.js';
import { Switch } from '../ui/index.js';
import { ApiError } from '../../api/client.js';
import {
  anchorRowFor,
  chunkIndexOf,
  commentTarget,
  diffChunks,
  highlightDiffRows,
  inlineThreadStartsOpen,
  isLockFile,
  isNoNewlineRow,
  lineRowIndex,
  parsePatch,
  patchEnd,
  patchLineCount,
  patchMatchesFile,
  patchReachesEnd,
  clampReveal,
  expandGapReveal,
  gapControlLabel,
  gapControls,
  gapPlace,
  gapRemaining,
  gapSlice,
  gapSummary,
  NO_REVEAL,
  type GapControl,
  type GapPlace,
  type GapReveal,
  revealScrollsFileHeader,
  splitDiffMarker,
  type DiffGap,
  type DiffRow,
} from '../../lib/diff.js';
import {
  MAX_FILE_DIFF_HIGHLIGHT_LINES,
  highlightLines,
  languageForPath,
} from '../../lib/hljsLines.js';
import { revealIntoView } from '../../lib/settleScroll.js';
import { DERIVED_STATE_META, relativeTime, safeExternalUrl, userLabel } from '../../lib/ui.js';
import {
  CheckIcon,
  ChevronIcon,
  ExternalLinkIcon,
  FoldIcon,
  PendingClaudeReviewIcon,
  UnfoldIcon,
} from '../Icons.js';
import { useClaudeThreadJudgements } from '../../hooks/useClaudeThreadJudgements.js';
import { threadPillFor } from '../../lib/claudeThreadMarker.js';
import { ClaudeThreadPills } from '../ThreadView/ClaudeThreadBadge.js';
import { LimnSeverityChip } from '../LimnSeverityChip.js';
import { CopyButton } from '../CopyButton.js';
import { MentionTextarea } from '../MentionTextarea.js';
import { ThreadCard } from '../ThreadView/index.js';
import { ThreadCountChips, rollupCounts } from '../ThreadList/ThreadCountChips.js';
import { SELECTED_BORDER, SELECTED_FILL, STATUS_META, UNSELECTED_BORDER } from './status.js';
import { FileTypeIcon } from '../FileTypeIcons.js';
import type { ThreadResolveBus } from '../../hooks/useResolveEvents.js';
import { LazyMountContext, createLazyMounter, useMountWhenNear } from './lazyMount.js';

// The shared per-file diff renderer used by BOTH the Changes tab (with inline
// commenting) and the AI Fix tab (read-only, pre-push). Per-file collapsible blocks
// with a sticky header, line-number gutters, and the >400-line auto-collapse. Inline
// commenting + the GitHub links are OPTIONAL: the AI-Fix changeset's files don't exist
// on GitHub yet, so it passes neither. The Changes tab additionally passes its review
// threads (`threadCtx`, resolved included) so they render inline at their diff line as
// pills — unresolved open, resolved shut, like GitHub.
//
// The rows MOUNT LAZILY: each file's rows are cut into chunks (`diffChunks`) that render as they
// near the scroll pane and then stay (`DiffChunk`, `lazyMount.ts`); a reveal forces its target's
// chunk and scrolls through `revealIntoView`, which holds the target while the placeholders around
// it settle (docs/FRONTEND.md § Lazy mounting).
//
// The code is syntax-highlighted per chunk as it mounts, language resolved from the PATH
// (`highlightDiffRows` — two passes over the reconstructed old and new sides, one hunk at a time,
// because a unified diff is not valid source). ⚠ The add/del signal is carried by `ROW_BG`'s TINT and the gutters
// (a removed line has only an old number, an added one only a new number), plus an sr-only
// "added"/"removed" word — NO DIFF NOTATION IS PRINTED: no `+`/`-` column, no `@@` header and no
// `\ No newline at end of file`. Each `@@` header is drawn as GitHub's HUNK EXPANDER instead —
// fold arrows in the gutter, "26 hidden lines · function foo() {" muted in the code column; in the
// Changes tab (`fileSource`) the arrows reveal 20 lines at a time in place, from the file at the PR
// head (`GapRow`). The `hunk` rows stay in `rows` — anchoring addresses rows by index.
//
// ⚠ NO LINE MAY LEAVE ITS BOX, IN EITHER WRAP MODE (`useDiffWrap`, ON by default). The table used
// to be `w-full` under AUTO layout with a `whitespace-pre` code cell, so one long line set the
// table's minimum width and the whole diff ran out past the pane's right edge — the file header
// stopped at the pane, the code did not. Now:
//   • WRAP ON: `table-fixed` + a `<colgroup>`, so the columns are decided by the pane's width and
//     never by the content, and the code cell breaks anywhere (`overflow-wrap: anywhere` — a long
//     URL or a minified line has no spaces to break at).
//   • WRAP OFF: the table is `w-max min-w-full` inside its OWN `overflow-x-auto` box, so a long
//     line scrolls INSIDE the diff. The full-width rows (inline threads, the comment box) are
//     pinned to the visible width (`FullWidthCell`), or a thread card would be as wide as the
//     longest line in the file.
// ⚠ THE `<colgroup>` IS LOAD-BEARING UNDER `table-fixed`: fixed layout takes its widths from the
// FIRST ROW, and the first row is often a `colSpan={4}` thread pill, which would split the table
// into four equal columns.

// One changed file with its unified-diff patch. A superset of the Changes tab's
// PrFileDiff and the AI-Fix `parseGitPatch` output (githubUrl optional).
export interface DiffFile {
  path: string;
  previousPath?: string | null;
  status: PrFileDiffStatus;
  additions: number;
  deletions: number;
  patch: string | null;
  githubUrl?: string | null;
}

/**
 * Where a block may load MORE of its own file — the Changes tab only (the AI Fix changeset's files
 * are not on GitHub yet). Every read is CLICK-GATED inside the block: a gap's expand arrow
 * reads the file at the PR head, a no-patch file's "Load full diff" reads both sides. `headSha` is
 * the head the patches were read at, so a push re-keys both reads.
 */
export interface DiffFileSource {
  prId: number;
  headSha: string | null;
}

// Review threads to render inline in the diff (Changes tab only), pre-bucketed by RENDERED
// file path — ChangesTab builds the one rename-aware fold (`indexThreadsByPath`), so a
// thread written before a rename lands under the file's current path instead of silently
// vanishing (the old per-view fold keyed on `t.path` while blocks looked up `f.path`).
// Threads carry (path, line) but no side; `anchorRowFor` places each at its live row, at
// the hunk-reconstructed row (approximate), or at file grain atop the file — never lost.
// `focusThreadId` scrolls to + highlights one thread (the just-posted self-focus).
export interface DiffThreadContext {
  threadsByPath: Map<string, ThreadDetail[]>;
  usersById: Map<number, User>;
  prUrl: string;
  focusThreadId?: number | null;
  onThreadShown?: () => void;
  /**
   * The reader's open/shut DECISIONS for the inline pills, keyed by thread id — a plain Map owned
   * by PrDetail (`threadOpenMemory`), written by every open/close (click, reveal, posted
   * self-focus, the reader's own resolve) and read ONCE, when a pill mounts. Only decisions are
   * recorded, never the default (`inlineThreadStartsOpen`). Mutated in place, never replaced: a
   * click must re-render one pill, not the diff. It outlives the pill because a pill remounts on a
   * file collapse, the Wrap toggle, an anchor move, the Threads only round trip and a tab switch.
   */
  openMemory: Map<number, boolean>;
  /**
   * A SUCCESSFUL resolve collapses its pill; an unresolve opens it (ChangesTab's one
   * `useResolveEvents` subscription, fanned out per thread). Absent outside the Changes tab.
   */
  resolveBus?: ThreadResolveBus;
}

// THE outside-in "reveal this file/line" signal. There are exactly TWO focus grains in this
// component and they are not interchangeable: `DiffThreadContext.focusThreadId` addresses a
// THREAD (driven internally by the just-posted-comment self-focus) and this addresses a
// FILE, optionally a LINE. Every caller-side reveal goes through this one prop — the Changes
// tab's file tree and the Claude-Review finding deep-link both drive it. Do not add a third.
//
// `nonce` is load-bearing: an effect keyed on a boolean cannot re-fire for the same target
// twice, so clicking the SAME file/line again would do nothing. Give it any monotonically
// changing value (`Date.now()`).
export interface DiffFocusTarget {
  path: string;
  // null / omitted ⇒ reveal the file (scroll its header into view), not a line.
  line?: number | null;
  // Which side of the diff the line number belongs to. Defaults to RIGHT (the new file).
  side?: 'LEFT' | 'RIGHT';
  // The review thread this reveal came FROM (a thread card's "Show in context"): the matching
  // inline pill opens + flashes as part of the same reveal — a resolved thread starts shut, and
  // the reader may have shut any other; a jump that lands beside a shut pill reads as a broken
  // link. Consumed per `nonce`, never persistently: the focus target is STICKY in ChangesTab,
  // and a sticky thread focus would yank the view back here after every posted-comment fade.
  // Optional — file/line reveals (tree clicks, Claude Review findings) carry none.
  threadId?: number | null;
  nonce: number;
}

// How long a just-posted thread keeps its highlight ring after it scrolls into view. Long
// enough to catch the eye, short enough that it doesn't linger as permanent decoration.
const POSTED_HIGHLIGHT_MS = 6000;

// Same idea for a focused diff LINE: flash it, then let it go. Shorter than the posted-thread
// ring because the scroll itself already says "here".
const FOCUS_HIGHLIGHT_MS = 4000;

// ---- collapse-by-default heuristic (GitHub-style: big files + lock files start collapsed) ----
const LARGE_PATCH_LINES = 250;
const LARGE_CHANGED_LINES = 400;

function startsCollapsed(file: DiffFile): boolean {
  if (isLockFile(file.path)) return true;
  if (file.patch == null) return true;
  if (patchLineCount(file.patch) > LARGE_PATCH_LINES) return true;
  if (file.additions + file.deletions > LARGE_CHANGED_LINES) return true;
  return false;
}

const ROW_BG: Record<DiffRow['kind'], string> = {
  hunk: 'bg-ui-sel text-ui-accent select-none',
  add: 'bg-ui-raise',
  del: 'bg-ui-danger/10',
  context: '',
};

function gutterText(n: number | undefined): string {
  return n == null ? '' : String(n);
}

function DiffLine({
  row,
  html,
  filePath,
  fileUrl,
  commenting,
  onPosted,
  open,
  onOpen,
  onClose,
  focused,
  focusNonce,
  wrap,
}: {
  row: DiffRow;
  /** This row's highlighted body, or null to render it as plain text — see the render below. */
  html: string | null;
  filePath: string;
  // When null, inline commenting is disabled (read-only AI-Fix diff).
  fileUrl: string | null;
  commenting: { prId: number } | null;
  // Fires with the new thread's LOCAL id once a posted comment is confirmed in our DB.
  onPosted?: (threadId: number | null) => void;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  // This row is the current `focus` target: scroll it into view and flash it.
  focused: boolean;
  // Changes on every focus request so re-focusing the SAME row re-fires the effect.
  focusNonce: number | null;
  /** Wrap long lines to the pane (the default) or keep them on one line and scroll. */
  wrap: boolean;
}): JSX.Element {
  const target = commenting ? commentTarget(row) : null;
  // `splitDiffMarker` rather than a bare `slice(1)`: an unmarked context row (a patch whose first
  // line is real code) would otherwise lose its first character, and the plain and highlighted
  // branches must print the same text.
  const display = splitDiffMarker(row).body || ' ';

  // Scroll-and-flash. Ordinary DOM here (the gated scroll rules are the vis TIMELINE's), so a
  // ref + scrollIntoView is the whole mechanism — never write scrollTop by hand. `block:
  // 'center'` and not 'start' because the per-file header is `sticky top-0` and would cover a
  // top-aligned row.
  const rowRef = useRef<HTMLTableRowElement>(null);
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (!focused) {
      setFlash(false);
      return;
    }
    // Held until the lazily-mounted rows around it settle (`revealIntoView`).
    const stop = rowRef.current != null ? revealIntoView(rowRef.current, 'center') : null;
    setFlash(true);
    const t = setTimeout(() => setFlash(false), FOCUS_HIGHLIGHT_MS);
    return () => {
      clearTimeout(t);
      stop?.();
    };
  }, [focused, focusNonce]);

  return (
    <>
      <tr
        ref={rowRef}
        data-diff-row=""
        className={`group transition-colors ${
          flash ? 'bg-ui-raise' : ROW_BG[row.kind]
        }`}
      >
        {/* Widths come from the table's `<colgroup>` (see `DiffColumns`), never from these cells. */}
        <td className="select-none border-r border-ui-line px-1 text-right align-top text-ui-faint">
          {gutterText(row.oldLine)}
        </td>
        <td className="select-none border-r border-ui-line px-1 text-right align-top text-ui-faint">
          {gutterText(row.newLine)}
        </td>
        <td className="select-none px-1 align-top">
          {/* Fixed-width wrapper reserves the gutter so the +-button revealing on
              hover (via opacity, which doesn't reflow) never shifts the code. */}
          <div className="flex w-4 justify-center">
            {commenting && target && !open && (
              <button
                type="button"
                onClick={onOpen}
                title="Comment on this line"
                className="hit rounded-ui bg-ui-accent-fill px-1 text-meta font-bold leading-tight text-ui-on-accent opacity-0 transition-opacity hover:bg-ui-accent-fill group-hover:opacity-100"
              >
                +
              </button>
            )}
          </div>
        </td>
        <td
          className={`px-2 align-top ${
            wrap ? 'whitespace-pre-wrap [overflow-wrap:anywhere]' : 'whitespace-pre'
          }`}
        >
          {/* NO `+`/`-` MARKER. It is diff notation, not code, and the row's tint and gutters
              already say it — so it is neither lexed (`highlightDiffRows` strips it) nor printed.
              The tint is colour-only, so a screen reader gets the word instead. */}
          {row.kind === 'add' && <span className="sr-only">added </span>}
          {row.kind === 'del' && <span className="sr-only">removed </span>}
          {html != null ? (
            // ⚠ ONLY highlight.js OUTPUT REACHES HERE. `highlightDiffRows` escapes through hljs's
            // own emitter and returns null on every gate it cannot clear; the branch below is
            // React's normal text rendering.
            <span className="code-hl" dangerouslySetInnerHTML={{ __html: html }} />
          ) : (
            display
          )}
        </td>
      </tr>
      {open && commenting && target && (
        <tr>
          <td colSpan={4} className="px-2 py-1.5">
            <FullWidthCell wrap={wrap}>
              <InlineCommentBox
                prId={commenting.prId}
                filePath={filePath}
                fileUrl={fileUrl}
                line={target.line}
                side={target.side}
                onPosted={onPosted}
                onClose={onClose}
              />
            </FullWidthCell>
          </td>
        </tr>
      )}
    </>
  );
}

// One review thread rendered inline in the diff: a one-line pill (state dot + author + age +
// excerpt) that discloses the full ThreadCard in place, the pill staying as its collapse header.
// UNRESOLVED threads (untouched / replied / likely addressed) start OPEN and RESOLVED ones start
// SHUT (`inlineThreadStartsOpen`), so live discussion reads in place while settled ones stay out
// of the way. It used to be every thread shut, against a 47-card wall. The volume guard is now:
// resolved stays shut, a one-click Hide remembered per thread, the file chevron, and lock files,
// which start collapsed whatever they hold. The OPEN STATE is the READER's (`ctx.openMemory`):
// read once at mount, latched while mounted (a refetch that resolves the thread under the reader
// does not snap it shut), and every open/close is written through so a remount restores it.
// ThreadCard mounts only while open; its ML queries are one per PR and its reaction
// bars batch per tick, so an open pill fetches nothing of its own. No store field, no URL.
function InlineThread({
  thread,
  ctx,
  approximate = false,
  fileChip = false,
  focusNonce = null,
  consumedFocus,
}: {
  thread: ThreadDetail;
  ctx: DiffThreadContext;
  /** Anchored via the hunk reconstruction (`anchorRowFor` rung 2) — hedged with `~`. */
  approximate?: boolean;
  /** Rendered at FILE grain (outdated / line not in this diff / binary), not at a row. */
  fileChip?: boolean;
  /** Non-null when this thread is the reveal's target (`DiffFocusTarget.threadId`). */
  focusNonce?: number | null;
  /**
   * The block's record of the last DELIVERED reveal nonce. It must outlive this component:
   * the focus target is STICKY in ChangesTab and collapsing the file unmounts the pill, so a
   * re-expand remounts it against the old nonce — without this record the effect below would
   * re-open a pill the user deliberately closed and teleport the view back to it. A ref (read
   * at effect time), not a nulled prop: the mounted pill's props must stay stable mid-flash,
   * or any re-render (the ~5s PR poll) would trip the reset branch and cut the ring short.
   */
  consumedFocus?: MutableRefObject<number | null>;
}): JSX.Element {
  // The pill's HEADER is the scroll target, not the card: an open card can be taller than the
  // pane, and `block: 'center'` on the whole card put its header above the fold.
  const headerRef = useRef<HTMLButtonElement>(null);
  const focused = ctx.focusThreadId != null && ctx.focusThreadId === thread.id;
  const memory = ctx.openMemory;
  // Read ONCE, at mount — the reader's remembered decision, else the thread's CURRENT state.
  const [open, setOpen] = useState(() => inlineThreadStartsOpen(thread, memory));
  // EVERY open/close is a DECISION, written through so a remount restores it. Stable for the
  // pill's life (PrDetail's one Map + this key's id) — and deliberately NOT in the reveal
  // effect's deps: a re-run there hits the `consumed` early return AFTER its cleanup cancelled
  // the fade timer, leaving the ring stuck on.
  const decide = useCallback(
    (next: boolean): void => {
      setOpen(next);
      memory.set(thread.id, next);
    },
    [memory, thread.id],
  );
  // The reader resolved this thread (here, in the Threads only view, anywhere): shut it, after
  // GitHub said yes. ChangesTab has already written the decision to `openMemory`, so a pill that
  // is not mounted right now comes back shut too.
  const bus = ctx.resolveBus;
  useEffect(() => {
    if (bus == null) return;
    return bus.subscribe(thread.id, (resolved) => decide(!resolved));
  }, [bus, thread.id, decide]);
  // The deep-link flash (thread card → "Show in context"): timed like the diff-row flash, never
  // persistent — the focus target is sticky in ChangesTab, and a persistent thread focus
  // would yank the view back here after every later posted-comment fade.
  const [flash, setFlash] = useState(false);
  // Focus LATCHES the pill open rather than gating `expanded = open || focused`: the
  // just-posted self-focus clears on a 6s timer, and a card the reader is midway through
  // must not snap shut when the highlight fades. Ring + scroll behaviour unchanged.
  useEffect(() => {
    if (!focused) return;
    decide(true);
    if (headerRef.current != null) revealIntoView(headerRef.current, 'center');
    ctx.onThreadShown?.();
    // Only re-run when this thread becomes the focus target.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focused]);
  useEffect(() => {
    if (focusNonce == null) {
      // Reset, not just return: the cleanup below cancels the fade timer, so a focus that
      // moves elsewhere mid-flash would otherwise leave the ring stuck on (DiffLine's pattern).
      setFlash(false);
      return;
    }
    // Already delivered — this is a REMOUNT, not a new reveal. Do nothing: the pill starts as
    // the reader left it (openMemory), unringed.
    if (consumedFocus?.current === focusNonce) return;
    if (consumedFocus != null) consumedFocus.current = focusNonce;
    decide(true);
    // Held until the lazily-mounted code around it settles — the pill is often in a file that
    // mounted for this very reveal, between placeholders of estimated height. ⚠ NOT stopped by this
    // cleanup: the `consumedFocus` guard makes a re-run a no-op, so StrictMode's mount-cleanup-mount
    // would cancel the settle for good. It ends itself (a newer reveal, reader input, the target
    // leaving the DOM, or its own cap).
    if (headerRef.current != null) revealIntoView(headerRef.current, 'center');
    setFlash(true);
    const t = setTimeout(() => setFlash(false), FOCUS_HIGHLIGHT_MS);
    return () => clearTimeout(t);
    // `decide` is stable for the pill's life and deliberately left out (see its comment).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusNonce, consumedFocus]);

  const meta = DERIVED_STATE_META[thread.derivedState];
  const resolved = thread.derivedState === 'resolved';
  // The latest Claude review's judgement, when it made one, replaces the state dot (the same rule
  // and the same ONE batched read as the card's pill — lib/claudeThreadMarker.ts).
  const pill = threadPillFor(thread, useClaudeThreadJudgements(thread.prId));
  const claude = pill.kind === 'claude' ? pill.marker : null;
  const root = thread.comments[0];
  // TOTAL over stored data (no error boundary): a null/unsynced author, an empty comments
  // array and an empty body all degrade to text, never throw.
  const author = userLabel(
    root?.authorId != null ? ctx.usersById.get(root.authorId) : undefined,
    root?.authorId ?? null,
  );
  const replies = thread.comments.length - 1;
  const excerpt = (root?.body ?? '')
    .split('\n')
    .find((l) => l.trim() !== '')
    ?.slice(0, 120);
  const ringed = focused || flash;

  return (
    <div data-thread-id={thread.id} className={`rounded-ui font-sans ${ringed ? 'ring-2 ring-ui-warn/40' : ''}`}>
      <button
        ref={headerRef}
        type="button"
        onClick={() => decide(!open)}
        // A disclosure, like the tree's dir rows: the ⌄/⌃ glyph is visual-only, so without
        // this a screen reader hears a state description on a button whose action is unstated.
        aria-expanded={open}
        title={
          claude != null
            ? `${claude.label}${claude.stale ? ' (earlier commit)' : ''}`
            : `${meta.label} — ${meta.description}`
        }
        // Inline colour, not a class pair: border-l colour classes lose to the shorthand
        // border-colour class depending on utility order. Transparent (not absent) when
        // resolved so the pills stay column-aligned.
        // A Claude judgement replaces the state colour too, or the edge keeps saying "Likely
        // addressed" beside the marker that replaced it.
        style={{
          borderLeftColor: resolved
            ? 'transparent'
            : claude != null
              ? 'rgb(var(--ai-signal-fill))'
              : meta.color,
        }}
        className={`flex w-full items-center gap-1.5 rounded-ui border-l-2 bg-ui-surface px-2 py-1 text-left text-meta hover:bg-ui-hover ${
          resolved
            ? 'text-ui-faint opacity-70'
            : 'text-ui-mute'
        }`}
      >
        {resolved ? (
          <CheckIcon
            size={11}
            className="shrink-0 text-ui-success"
          />
        ) : claude != null ? (
          // Shut, the Claude pills below carry the mark themselves.
          open ? <PendingClaudeReviewIcon size={12} className="shrink-0 text-ai-signal" /> : null
        ) : (
          <span
            className="inline-block h-2 w-2 shrink-0 rounded-full"
            style={{ backgroundColor: meta.color }}
          />
        )}
        {/* `outdated` drops once open — ThreadCard's own header prints it. "line not in this diff"
            stays: it is a fact about where this pill had to be PARKED, which the card never states. */}
        {fileChip && !(open && thread.isOutdated) && (
          <span className="shrink-0 text-ui-faint">
            {thread.isOutdated ? 'outdated' : 'line not in this diff'} ·
          </span>
        )}
        {/* ── COLLAPSE-ONLY CHROME ────────────────────────────────────────────────────────────
            Author, age, reply count and the body excerpt are the pill's whole job while it is
            SHUT: they are what lets a reader decide whether to open it. The moment it is open the
            ThreadCard below states every one of them properly — the author and the timestamp on
            each comment's own header, the replies as themselves, the excerpt as the rendered body
            ~30px lower — so keeping them here printed the same four facts twice, with the excerpt
            as a truncated copy of the paragraph directly beneath it.

            ⚠ SCOPED TO `open`. Do NOT drop them outright: the shut pill is the only description of
            the thread a reader gets while scrolling the diff, and a bare state dot describes
            nothing. */}
        {!open && claude != null && <ClaudeThreadPills marker={claude} noInfo />}
        {/* Limn's own posted finding: its severity. Open, the ThreadCard header shows it. */}
        {!open && <LimnSeverityChip severity={thread.limnSeverity} />}
        {!open && (
          <>
            <span className="shrink-0 font-medium">{author}</span>
            <span className="shrink-0 text-ui-faint">
              · {relativeTime(thread.createdAt)}
            </span>
          </>
        )}
        {/* Stays in BOTH states: it is a claim about where this pill was PLACED in the diff, which
            the conversation below never makes. */}
        {approximate && (
          <span
            className="shrink-0 text-ui-faint"
            title="Reconstructed from the code it was written against — may be a few lines off"
          >
            ~
          </span>
        )}
        {!open && replies > 0 && (
          <span className="shrink-0 text-ui-faint">
            · {replies} repl{replies === 1 ? 'y' : 'ies'}
          </span>
        )}
        {!open && excerpt && (
          // Plain text ONLY — bodies are untrusted, so markdown/images/links stay inert here.
          <span className="min-w-0 flex-1 truncate text-ui-faint">
            · {excerpt}
          </span>
        )}
        {/* The open pill keeps a label — a lone dot + chevron is an unreadable control. It names
            the ACTION rather than the thread: every description of the thread is now in the card
            below, and a state word here would just be the StateBadge again. */}
        {open && (
          <span className="min-w-0 flex-1 truncate text-ui-faint">
            Hide thread
          </span>
        )}
        <ChevronIcon
          dir={open ? 'up' : 'down'}
          size={11}
          className="ml-auto shrink-0 text-ui-faint"
        />
      </button>
      {open && (
        <div className="mt-1">
          <ThreadCard
            thread={thread}
            usersById={ctx.usersById}
            prUrl={ctx.prUrl}
            selected={ringed}
          />
        </div>
      )}
    </div>
  );
}

// Table wrapper for InlineThread — a full-width row in the diff table. The binary/no-patch
// branch renders the same pill unit in a plain <div> instead.
function InlineThreadRow({
  thread,
  ctx,
  approximate,
  fileChip,
  focusNonce,
  consumedFocus,
  wrap,
}: {
  thread: ThreadDetail;
  ctx: DiffThreadContext;
  approximate?: boolean;
  fileChip?: boolean;
  focusNonce?: number | null;
  consumedFocus?: MutableRefObject<number | null>;
  wrap: boolean;
}): JSX.Element {
  return (
    <tr>
      <td colSpan={4} className="bg-ui-surface px-2 py-1">
        <FullWidthCell wrap={wrap}>
          <InlineThread
            thread={thread}
            ctx={ctx}
            approximate={approximate}
            fileChip={fileChip}
            focusNonce={focusNonce}
            consumedFocus={consumedFocus}
          />
        </FullWidthCell>
      </td>
    </tr>
  );
}

/**
 * The content of a `colSpan={4}` row — a thread or the comment box — sized to the VISIBLE diff.
 *
 * Wrapping, the table is the pane's width already and this is a plain box. Not wrapping, the
 * table is as wide as its longest line, so the row is too: the box is pinned to the left edge of
 * the horizontal scroller (`sticky`) and held to its width (`100cqw` of the scroller, which is a
 * size container for exactly this — see the ⚠ on `DiffTable`). Without it a review thread on a
 * file with one 400-character line renders 400 characters wide, off-screen to the right.
 */
function FullWidthCell({
  wrap,
  children,
}: {
  wrap: boolean;
  children: React.ReactNode;
}): JSX.Element {
  if (wrap) return <>{children}</>;
  // `1rem` is the cell's own `px-2`, both sides.
  return (
    <div className="sticky left-2" style={{ width: 'calc(100cqw - 1rem)' }}>
      {children}
    </div>
  );
}

/** Wide enough for the file's longest line number, and never narrower than the old `w-9`. */
function gutterWidth(rows: readonly DiffRow[]): string {
  let max = 0;
  for (const r of rows) {
    if (r.oldLine != null && r.oldLine > max) max = r.oldLine;
    if (r.newLine != null && r.newLine > max) max = r.newLine;
  }
  const digits = Math.max(4, String(max).length);
  // `ch` resolves against the table's monospace font; `0.5rem` is the cell's `px-1`, `1px` its
  // right border.
  return `calc(${digits}ch + 0.5rem + 1px)`;
}

/**
 * The diff table, in both wrap modes.
 *
 * ⚠ THE SCROLLER IS A SIZE CONTAINER (`container-type: inline-size`) so `FullWidthCell` can say
 * "the visible width" in CSS (`100cqw`) instead of measuring it. It is safe here because the box
 * takes its width from its parent anyway — containment only stops its CONTENT from widening it,
 * which is the whole point.
 */
function DiffTable({
  rows,
  wrap,
  children,
}: {
  rows: readonly DiffRow[];
  wrap: boolean;
  children: React.ReactNode;
}): JSX.Element {
  const gutter = gutterWidth(rows);
  const table = (
    <table
      className={`border-collapse font-mono text-meta leading-[1.45] ${
        wrap ? 'w-full table-fixed' : 'w-max min-w-full'
      }`}
    >
      <colgroup>
        <col style={{ width: gutter }} />
        <col style={{ width: gutter }} />
        {/* The comment button's column: `w-4` + the cell's `px-1`. */}
        <col style={{ width: '1.5rem' }} />
        <col />
      </colgroup>
      {/* One <tbody> per lazily-mounted chunk (`DiffChunk`), plus one for the file-grain pills. */}
      {children}
    </table>
  );
  if (wrap) return table;
  return (
    <div className="overflow-x-auto" style={{ containerType: 'inline-size' }}>
      {table}
    </div>
  );
}

/**
 * The wrap switch. Rendered by the viewer's CALLERS (the Changes tab's header, the AI Fix tab's
 * file count), because `FileDiffView` is a list of blocks with no header of its own — every mount
 * reads the same `useDiffWrap` value, so one press repaints them all.
 */
export function DiffWrapToggle(): JSX.Element {
  const [wrap, setWrap] = useDiffWrap();
  return (
    // A Switch: it takes effect at once (docs/redesign/DESIGN.md § Components). ON by default.
    <Switch label="Wrap lines" checked={wrap} onChange={(e) => setWrap(e.target.checked)} className="text-meta" />
  );
}

function InlineCommentBox({
  prId,
  filePath,
  fileUrl,
  line,
  side,
  onPosted,
  onClose,
}: {
  prId: number;
  filePath: string;
  fileUrl: string | null;
  line: number;
  side: 'LEFT' | 'RIGHT';
  onPosted?: (threadId: number | null) => void;
  onClose: () => void;
}): JSX.Element {
  const [body, setBody] = useState('');
  // Every notice this box can show is cautionary (the comment moved, or couldn't be
  // placed, or is on GitHub but not mirrored yet) — a plain "posted" toast is never one of
  // them, because in the normal case the thread itself renders below and says so. `posted`
  // only picks the dismiss button's wording.
  const [notice, setNotice] = useState<{
    text: string;
    url: string | null;
    posted: boolean;
  } | null>(null);
  // Posting is a TWO-phase action: the POST reaches GitHub (and the server resyncs +
  // verifies the comment landed in our DB), then we refetch the PR so the real thread
  // renders. `refreshing` is the second phase — the composer stays mounted and disabled
  // through it, so the user isn't handed a "posted, wait for the sync" promise.
  const [refreshing, setRefreshing] = useState(false);
  const add = useAddReviewComment(prId);
  const qc = useQueryClient();

  const error =
    add.error instanceof ApiError
      ? add.error.message
      : add.error
        ? 'Failed to post the comment.'
        : null;

  const busy = add.isPending || refreshing;

  const handleResult = async (result: AddReviewCommentResult): Promise<void> => {
    if (result.commentId === null) {
      // Nothing was posted at all (no addable diff line, or GitHub rejected the line).
      setNotice({
        text: "Couldn't place this comment in the diff — open it on GitHub instead.",
        url: fileUrl,
        posted: false,
      });
      return;
    }
    setBody('');

    if (result.visible) {
      // The server has the real GitHub state of this comment in our DB, so a refetch is
      // GUARANTEED to render the thread. useAddReviewComment already invalidated
      // ['pr', prId]; join that in-flight refetch (cancelRefetch:false — cancelling it
      // would cost a second round trip) and AWAIT it, so the thread is on screen before
      // we hand it to onPosted / close the composer.
      setRefreshing(true);
      try {
        await qc.refetchQueries(
          { queryKey: ['pr', prId], exact: true },
          { cancelRefetch: false },
        );
      } finally {
        setRefreshing(false);
      }
      onPosted?.(result.threadId);
      if (result.anchored === false) {
        // It moved — say so, and keep the composer open so the note is read. The thread
        // itself is now rendered below at the line GitHub chose.
        setNotice({
          text: `Posted on the nearest changed line (${
            result.side === 'LEFT' ? 'old' : 'new'
          } line ${result.line}) — shown below.`,
          url: result.url,
          posted: true,
        });
        return;
      }
      // The thread appearing IS the confirmation; a "posted" toast beside a visible
      // comment is noise.
      onClose();
      return;
    }

    // THE COMMENT IS ON GITHUB — the resync just couldn't confirm it here (it failed,
    // raced, or this PR has more review threads than one sync page returns). Never say
    // "failed" and never invite a retry: retrying would double-post.
    setNotice({
      text:
        result.anchored === false
          ? `Posted on GitHub on the nearest changed line (${
              result.side === 'LEFT' ? 'old' : 'new'
            } line ${result.line}). It couldn’t be loaded back just now — it’ll show up here shortly.`
          : 'Posted on GitHub. It couldn’t be loaded back just now — it’ll show up here shortly.',
      url: result.url,
      posted: true,
    });
  };

  const send = (): void => {
    const trimmed = body.trim();
    if (!trimmed || busy) return;
    setNotice(null);
    add.mutate(
      { path: filePath, line, side, body: trimmed },
      { onSuccess: (result) => void handleResult(result) },
    );
  };

  return (
    <div className="space-y-1 rounded-ui bg-ui-surface p-2 font-sans">
      <div className="text-meta text-ui-faint">
        Commenting on {side === 'LEFT' ? 'old' : 'new'} line {line}
      </div>
      <MentionTextarea
        prId={prId}
        value={body}
        onChange={setBody}
        rows={3}
        autoFocus
        placeholder="Add an inline review comment (markdown)…"
        className="w-full rounded-ui bg-ui-surface px-2 py-1.5 text-meta"
      />
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={send}
          disabled={busy || body.trim().length === 0}
          className="hit bg-ui-raise whitespace-nowrap rounded-ui px-2 py-0.5 text-meta text-ui-ink hover:bg-ui-hover disabled:opacity-50"
        >
          {refreshing ? 'Loading it…' : add.isPending ? 'Posting…' : 'Send'}
        </button>
        <button
          type="button"
          onClick={() => {
            setBody('');
            setNotice(null);
            add.reset();
            onClose();
          }}
          disabled={busy}
          className="hit bg-ui-raise whitespace-nowrap rounded-ui px-2 py-0.5 text-meta hover:bg-ui-hover disabled:opacity-50"
        >
          {notice?.posted ? 'Close' : 'Cancel'}
        </button>
        {error && <span className="text-meta text-ui-danger">{error}</span>}
      </div>
      {notice && (
        <div className="text-meta text-ui-warn">
          {notice.text}
          {notice.url && (
            <>
              {' '}
              <a
                href={safeExternalUrl(notice.url)}
                target="_blank"
                rel="noreferrer noopener"
                className="hit text-ui-ink hover:underline"
              >
                Open on GitHub
                <ExternalLinkIcon
                  size={10}
                  className="ml-0.5 inline-block align-[-0.1em]"
                />
              </a>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A file GitHub sent no patch for — its diff is too large for the files listing, or it is binary,
 * and the listing does not say which. "Load full diff" asks the server to fetch both sides and
 * diff them (refused past ~1 MB a side), on click only.
 */
function NoPatchNote({
  status,
  onLoad,
  githubUrl,
}: {
  status: 'idle' | 'loading' | 'error' | 'too_large' | 'binary' | 'missing';
  onLoad: () => void;
  githubUrl: string | null;
}): JSX.Element {
  const text =
    status === 'too_large'
      ? 'This file is over 1 MB — too large to diff here.'
      : status === 'binary'
        ? 'Binary file — no text diff.'
        : status === 'missing'
          ? 'This file isn’t on GitHub at either commit.'
          : status === 'error'
            ? 'Couldn’t load the full diff.'
            : 'GitHub didn’t send this diff. It is too large, or a binary file.';
  return (
    <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1">
      <span>{text}</span>
      {(status === 'idle' || status === 'loading') && (
        <button
          type="button"
          onClick={onLoad}
          disabled={status === 'loading'}
          className="hit bg-ui-raise rounded-ui px-2 py-0.5 text-ui-ink hover:bg-ui-hover disabled:opacity-60"
        >
          {status === 'loading' ? 'Loading full diff…' : 'Load full diff'}
        </button>
      )}
      {githubUrl && (
        <a
          href={githubUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="hit text-ui-ink hover:underline"
        >
          View on GitHub
          <ExternalLinkIcon size={10} className="ml-0.5 inline-block align-[-0.1em]" />
        </a>
      )}
    </div>
  );
}

/**
 * The row drawn in place of a `@@` header — GitHub's hunk expander. The arrows sit in the
 * line-number gutter (`gapControls`: one up arrow before the first hunk, one down arrow after the
 * last, both between two hunks, or ONE expand-all once a click would empty it); the code column
 * carries the hidden count and the enclosing function git names after the header, muted. No
 * "Show N hidden lines" prose: the count is the fact, the arrows are the verbs, and each arrow's
 * accessible name says what it reveals. With no file source (AI Fix) the gutter is empty.
 * `status` replaces the count once the reader has asked and the one file read has not succeeded.
 */
function GapRow({
  gap,
  place,
  remaining,
  expandable,
  status,
  onExpand,
  wrap,
}: {
  gap: DiffGap;
  place: GapPlace;
  /** Lines still hidden, or null while unknown (a trailing gap before the file is loaded). */
  remaining: number | null;
  expandable: boolean;
  status: GapLoadStatus;
  onExpand: (control: GapControl) => void;
  wrap: boolean;
}): JSX.Element {
  const controls = expandable && status === 'idle' ? gapControls(place, remaining) : [];
  const summary =
    status === 'idle'
      ? gapSummary(remaining, gap.context)
      : [GAP_STATUS_TEXT[status] ?? '', gap.context].filter((p) => p !== '').join(' · ');
  return (
    <tr className="bg-ui-sel">
      <td colSpan={2} className="border-r border-ui-line p-0 align-middle">
        {controls.length > 0 && (
          <div className="flex flex-col">
            {controls.map((c) => {
              const label = gapControlLabel(c, remaining);
              return (
                <button
                  key={c}
                  type="button"
                  onClick={() => onExpand(c)}
                  aria-label={label}
                  title={label}
                  className="hit flex h-5 w-full items-center justify-center text-ui-mute hover:bg-ui-accent-fill hover:text-white focus-visible:bg-ui-accent-fill focus-visible:text-white focus-visible:outline-none"
                >
                  {c === 'all' ? <UnfoldIcon size={16} /> : <FoldIcon dir={c} size={16} />}
                </button>
              );
            })}
          </div>
        )}
      </td>
      <td
        colSpan={2}
        className={`px-2 py-0.5 align-middle text-ui-mute ${
          wrap ? 'whitespace-pre-wrap [overflow-wrap:anywhere]' : 'whitespace-pre'
        }`}
      >
        {summary || ' '}
      </td>
    </tr>
  );
}

type GapLoadStatus = 'idle' | 'loading' | 'error' | 'too_large' | 'binary' | 'missing' | 'moved';

const GAP_STATUS_TEXT: Partial<Record<GapLoadStatus, string>> = {
  loading: 'Loading…',
  error: 'Couldn’t load these lines.',
  too_large: 'This file is too large to show here.',
  binary: 'Binary file.',
  missing: 'This file isn’t on GitHub at this commit.',
  moved: 'This file has changed since the diff was loaded.',
};

/** Unchanged lines expanded into a gap, read from the whole file. Read-only: GitHub only takes an
 *  inline comment on a line the diff shows. */
function ExpandedLines({
  gap,
  lines,
  html,
  side,
  wrap,
}: {
  gap: DiffGap;
  lines: readonly string[];
  /** Per-line highlighted HTML for the WHOLE file, or null to render plain. */
  html: readonly string[] | null;
  side: 'head' | 'base';
  wrap: boolean;
}): JSX.Element {
  const out: JSX.Element[] = [];
  for (let k = 0; k < gap.count; k += 1) {
    const oldLine = gap.oldFrom + k;
    const newLine = gap.newFrom + k;
    const at = (side === 'head' ? newLine : oldLine) - 1;
    const text = lines[at] ?? '';
    const h = html?.[at] ?? null;
    out.push(
      <tr key={k}>
        <td className="select-none border-r border-ui-line px-1 text-right align-top text-ui-faint">
          {oldLine}
        </td>
        <td className="select-none border-r border-ui-line px-1 text-right align-top text-ui-faint">
          {newLine}
        </td>
        <td className="select-none px-1 align-top" />
        <td
          className={`px-2 align-top ${
            wrap ? 'whitespace-pre-wrap [overflow-wrap:anywhere]' : 'whitespace-pre'
          }`}
        >
          {h != null ? (
            // ⚠ ONLY highlight.js OUTPUT REACHES HERE (`highlightLines`), as in DiffLine.
            <span className="code-hl" dangerouslySetInnerHTML={{ __html: h }} />
          ) : (
            text || ' '
          )}
        </td>
      </tr>,
    );
  }
  return <>{out}</>;
}

/**
 * One gap, expanded or not: the lines revealed from its top, the expander row while anything is
 * still hidden, then the lines revealed from its bottom (just above the next hunk's code). Nothing
 * is drawn from the file until it has loaded AND matched the patch (`lines` non-null) — until then
 * the gap is drawn whole, with the load's status in place of the count.
 */
function GapExpansion({
  gap,
  place,
  reveal,
  lines,
  html,
  side,
  expandable,
  status,
  onExpand,
  wrap,
}: {
  /** `count: null` is a trailing gap whose file is not loaded yet. */
  gap: Omit<DiffGap, 'count'> & { count: number | null };
  place: GapPlace;
  reveal: GapReveal | undefined;
  lines: readonly string[] | null;
  html: readonly string[] | null;
  side: 'head' | 'base';
  expandable: boolean;
  status: GapLoadStatus;
  onExpand: (control: GapControl, count: number | null) => void;
  wrap: boolean;
}): JSX.Element {
  const count = gap.count;
  const shown = lines != null ? clampReveal(count, reveal ?? NO_REVEAL) : NO_REVEAL;
  const remaining = gapRemaining(count, shown);
  const whole: DiffGap = { ...gap, count: count ?? 0 };
  return (
    <>
      {lines != null && shown.top > 0 && (
        <ExpandedLines
          gap={gapSlice(whole, 0, shown.top)}
          lines={lines}
          html={html}
          side={side}
          wrap={wrap}
        />
      )}
      {remaining !== 0 && (
        <GapRow
          gap={whole}
          place={place}
          remaining={remaining}
          expandable={expandable}
          status={status}
          onExpand={(c) => onExpand(c, count)}
          wrap={wrap}
        />
      )}
      {lines != null && count != null && shown.bottom > 0 && (
        <ExpandedLines
          gap={gapSlice(whole, count - shown.bottom, shown.bottom)}
          lines={lines}
          html={html}
          side={side}
          wrap={wrap}
        />
      )}
    </>
  );
}

// ---- lazy mounting: one file's rows in chunks (`diffChunks`), each mounted as it nears the pane ----
// A placeholder's height is ESTIMATED from what it will hold, so the scrollbar and the rail's jumps
// are about right before anything mounts; `revealIntoView` absorbs the error on a jump. The figures
// are RENDERED sizes, MEASURED in Chrome on the e2e big diff (`e2e/big-diff.ts`): a one-line code
// row 19.4px, a gap row 21px with one arrow and 40px with two, a shut pill's row 32px, an open one
// (a ThreadCard with one short comment) 173px. Longer conversations make an open pill taller, which
// only makes a placeholder a little short.
const ROW_PX = 19.4;
const GAP_ROW_PX = 21;
const GAP_ROW_TWO_ARROWS_PX = 40;
const SHUT_PILL_PX = 32;
const OPEN_PILL_PX = 175;
// With Wrap on, a line longer than this many characters takes another visual line (a rough
// average over pane widths; the estimate only has to be close).
const WRAP_CHARS = 110;

function estimateChunkPx(
  rows: readonly DiffRow[],
  from: number,
  to: number,
  byRow: ReadonlyMap<number, readonly { thread: ThreadDetail }[]>,
  memory: Map<number, boolean> | null,
  wrap: boolean,
): number {
  let px = 0;
  for (let i = from; i < to; i += 1) {
    const row = rows[i]!;
    if (row.kind === 'hunk') {
      if (row.gap != null && row.gap.count > 0) {
        px +=
          gapControls(gapPlace(rows, i), row.gap.count).length > 1 ? GAP_ROW_TWO_ARROWS_PX : GAP_ROW_PX;
      }
    } else if (!isNoNewlineRow(row)) {
      const lines = wrap ? Math.max(1, Math.ceil(row.text.length / WRAP_CHARS)) : 1;
      px += lines * ROW_PX;
    }
    for (const a of byRow.get(i) ?? []) {
      px += memory != null && inlineThreadStartsOpen(a.thread, memory) ? OPEN_PILL_PX : SHUT_PILL_PX;
    }
  }
  return Math.round(px);
}

/**
 * One chunk of a file's diff: its rows once LIVE, an estimated-height placeholder until then. It is
 * its own `<tbody>` so a placeholder is one table row and the columns never move. Highlighting
 * happens HERE, per chunk (`highlightDiffRows` with a range), so code that has never been near the
 * screen is never lexed. `force` mounts it at once (a reveal's target row is inside).
 */
function DiffChunk({
  rows,
  from,
  to,
  language,
  force,
  estimatePx,
  renderRows,
}: {
  rows: readonly DiffRow[];
  from: number;
  to: number;
  language: string | null;
  force: boolean;
  estimatePx: number;
  renderRows: (from: number, to: number, html: (string | null)[] | null) => React.ReactNode;
}): JSX.Element {
  const { live, ref } = useMountWhenNear<HTMLTableSectionElement>(force);
  const html = useMemo(
    () => (live ? highlightDiffRows(rows, language, MAX_FILE_DIFF_HIGHLIGHT_LINES, { from, to }) : null),
    [live, rows, language, from, to],
  );
  if (!live) {
    return (
      <tbody ref={ref} data-diff-placeholder="" aria-hidden>
        <tr>
          <td colSpan={4} className="p-0" style={{ height: estimatePx }} />
        </tr>
      </tbody>
    );
  }
  return <tbody>{renderRows(from, to, html)}</tbody>;
}

function FileDiffBlock({
  file,
  commenting,
  onPosted,
  threads,
  threadCtx,
  focus,
  wrap,
  fileSource,
}: {
  file: DiffFile;
  commenting: { prId: number } | null;
  fileSource: DiffFileSource | null;
  onPosted?: (threadId: number | null) => void;
  threads: ThreadDetail[];
  threadCtx: DiffThreadContext | null;
  // Non-null ONLY when this block is the focus target (FileDiffView does the matching).
  focus: DiffFocusTarget | null;
  wrap: boolean;
}): JSX.Element {
  // "Load full diff" — a file GitHub sent no patch for (too large) is diffed server-side, on click.
  const [wantFullDiff, setWantFullDiff] = useState(false);
  const fullDiff = usePrFileFullDiff(
    fileSource?.prId ?? null,
    file.path,
    file.previousPath ?? null,
    fileSource?.headSha ?? null,
    wantFullDiff && file.patch == null && fileSource != null,
  );
  const patch = file.patch ?? fullDiff.data?.patch ?? null;
  const rows = useMemo(() => parsePatch(patch), [patch]);

  // Gap expansion: the whole file, read ONCE per block on the first arrow click (never on mount). A deleted file only has its base; everything else reads the head, whose line
  // numbers the new side of every gap indexes directly.
  const side: 'head' | 'base' = file.status === 'removed' ? 'base' : 'head';
  const contentPath = side === 'base' ? (file.previousPath ?? file.path) : file.path;
  const [wantContent, setWantContent] = useState(false);
  const content = usePrFileContent(
    fileSource?.prId ?? null,
    contentPath,
    side,
    fileSource?.headSha ?? null,
    wantContent && fileSource != null,
  );
  // Each gap's reveal (`GapReveal`: lines shown from its top and from its bottom), keyed by its
  // hunk row's index, or -1 for the lines after the last hunk. A key is present once the reader
  // has clicked that gap — which is also what makes the gap show the load's status.
  const [reveals, setReveals] = useState<ReadonlyMap<number, GapReveal>>(() => new Map());
  const fileLines = content.data?.lines ?? null;
  const linesFit = useMemo(
    () => (fileLines != null ? patchMatchesFile(rows, fileLines, side) : false),
    [fileLines, rows, side],
  );
  const gapStatus: GapLoadStatus = !wantContent
    ? 'idle'
    : content.isLoading
      ? 'loading'
      : content.isError
        ? 'error'
        : content.data?.refused != null
          ? content.data.refused
          : fileLines != null && !linesFit
            ? 'moved'
            : 'idle';
  const usableLines = gapStatus === 'idle' && linesFit ? fileLines : null;
  // The trailing gap: its START is known from the patch, its SIZE only once the file is loaded
  // (`count: null` until then). Offered before the load only when the patch does not provably
  // reach the end of the file (`patchReachesEnd`) and the block can load it; after the load, only
  // when lines really follow.
  const trailingGap = useMemo((): (Omit<DiffGap, 'count'> & { count: number | null }) | null => {
    if (rows.length === 0) return null;
    const end = patchEnd(rows);
    if (usableLines == null) {
      if (fileSource == null || patchReachesEnd(rows)) return null;
      return { count: null, oldFrom: end.oldNext, newFrom: end.newNext, context: '' };
    }
    const next = side === 'head' ? end.newNext : end.oldNext;
    const count = usableLines.length - (next - 1);
    return count > 0 ? { count, oldFrom: end.oldNext, newFrom: end.newNext, context: '' } : null;
  }, [usableLines, rows, side, fileSource]);
  // One arrow click: load the file (the first time) and grow that gap's reveal. While the file is
  // loading, a click on a known-size gap is held at its reveal and drawn once the lines arrive.
  const expandGap = (key: number, control: GapControl, count: number | null): void => {
    setWantContent(true);
    setReveals((prev) => {
      const next = new Map(prev);
      next.set(key, expandGapReveal(prev.get(key) ?? NO_REVEAL, control, count));
      return next;
    });
  };
  // Expanded lines are coloured from the WHOLE file — the one lex that is right everywhere.
  const fileHtml = useMemo(
    () =>
      usableLines != null && reveals.size > 0
        ? highlightLines([...usableLines], languageForPath(file.path), MAX_FILE_DIFF_HIGHLIGHT_LINES)
        : null,
    [usableLines, reveals.size, file.path],
  );
  // Anchor each thread to a diff row via the shared ladder (`anchorRowFor`: live line, else
  // the hunk reconstruction — marked approximate). Threads with no matching row render as
  // FILE-level chips above the diff, so a thread never disappears.
  const { byRow, unanchored } = useMemo(() => {
    const byRow = new Map<number, { thread: ThreadDetail; approximate: boolean }[]>();
    const unanchored: ThreadDetail[] = [];
    for (const t of threads) {
      const hit = anchorRowFor(rows, t);
      if (hit == null) unanchored.push(t);
      else {
        const a = byRow.get(hit.index) ?? [];
        a.push({ thread: t, approximate: hit.approximate });
        byRow.set(hit.index, a);
      }
    }
    return { byRow, unanchored };
  }, [rows, threads]);

  const unresolvedCount = threads.filter((t) => !t.isResolved).length;

  const hasFocus =
    threadCtx?.focusThreadId != null && threads.some((t) => t.id === threadCtx.focusThreadId);
  // Files with threads (or the deep-link target) start expanded, mirroring GitHub —
  // EXCEPT lock files, which always start collapsed even with threads (the header's
  // thread-count badge still advertises them, and the deep-link effect below still opens).
  const [expanded, setExpanded] = useState(
    // `unresolvedCount`, not `threads.length`: this heuristic meant "a file with live discussion
    // opens itself", and resolved threads joining the array must not start expanding files whose
    // conversations are all settled.
    () => !isLockFile(file.path) && (!startsCollapsed(file) || unresolvedCount > 0),
  );
  useEffect(() => {
    if (hasFocus) setExpanded(true);
  }, [hasFocus]);

  // Language-aware colouring, two passes per hunk (`highlightDiffRows`) — now done PER CHUNK, by
  // each `DiffChunk` as it mounts, so only code that has come near the screen is ever lexed. Null —
  // an unlisted extension, a patch past the line gate, a lexer that threw — means plain text.
  //
  // ⚠ STILL ONLY WHEN EXPANDED (the table is behind `{expanded && …}`): `startsCollapsed` fires at
  // `LARGE_PATCH_LINES` (250), and every file in the 251-to-~800-row band, `pnpm-lock.yaml`
  // included, used to be fully lexed on mount for output nobody could see (MEASURED ~17-20ms per
  // file at the gate). The chunks now go further: an expanded file far down the PR is not lexed
  // until it is scrolled near.
  //
  // ⚠ THIS SITE HAS ITS OWN LINE LIMIT (`MAX_FILE_DIFF_HIGHLIGHT_LINES`, not the shared 400): with
  // the lex paid on demand, the 400 bought nothing here and left every ADDED file past 400 lines —
  // whose patch is all new side — completely uncoloured.
  const language = useMemo(() => languageForPath(file.path), [file.path]);
  const chunks = useMemo(() => diffChunks(rows), [rows]);

  // Which row (if any) the focus target addresses. Known even while collapsed — `rows` is
  // parsed from the patch, not from what's rendered — so the block can decide up front
  // whether the LINE will scroll itself or whether it must scroll the file header instead.
  const focusRow = useMemo(() => {
    if (focus == null || focus.line == null) return null;
    return lineRowIndex(rows, focus.line, focus.side ?? 'RIGHT');
  }, [rows, focus]);

  // The chunks a reveal needs MOUNTED NOW, whatever their position: the addressed line's, the
  // target thread's (a "Show in context" jump, a deep link), the just-posted thread's. A thread's
  // row comes from the same anchoring ladder that places its pill.
  const focusThreadId = focus?.threadId ?? null;
  const postedThreadId = threadCtx?.focusThreadId ?? null;
  const forcedChunks = useMemo(() => {
    const out = new Set<number>();
    if (focusRow != null) out.add(chunkIndexOf(chunks, focusRow));
    for (const [row, list] of byRow) {
      if (list.some((a) => a.thread.id === focusThreadId || a.thread.id === postedThreadId)) {
        out.add(chunkIndexOf(chunks, row));
      }
    }
    return out;
  }, [chunks, focusRow, byRow, focusThreadId, postedThreadId]);

  // An explicit reveal ALWAYS wins over the collapse heuristic — including lock files and
  // >250-line patches. A deliberate click that scrolls to a closed `▸` header reads as a
  // broken link, which is worse than overriding a default.
  const blockRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focus == null) return;
    setExpanded(true);
    // No addressable row (file-level target, a line that isn't in the current diff, or a
    // binary/too-large file) ⇒ reveal the FILE. Never do nothing. EXCEPT when the reveal names a
    // thread this block renders: its pill scrolls its own header (in this commit, or on mount in
    // the next if the file was shut), and this effect runs AFTER the pill's (child-first), so a
    // header scroll here would cancel it — see `revealScrollsFileHeader`. That also makes a
    // same-nonce re-run (a new `focus` object, same reveal) a no-op rather than a jump back up.
    if (
      revealScrollsFileHeader(focus, focusRow, threadCtx != null ? threads : []) &&
      blockRef.current != null
    ) {
      // Held while the placeholders above it mount and change height (`revealIntoView`).
      return revealIntoView(blockRef.current, 'start');
    }
    // focusRow is derived from `focus`; re-running on it would double-scroll. `threads` and
    // `threadCtx` are read as they stand when the reveal arrives — a refetch is not a reveal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

  const [openRow, setOpenRow] = useState<number | null>(null);

  // The last thread-reveal nonce a pill in this block has DELIVERED. Lives here — not in the
  // pill — because collapsing the file unmounts the table (and the pill's state with it) while
  // this block survives; see `consumedFocus` on InlineThread for the failure it prevents.
  const consumedThreadFocus = useRef<number | null>(null);

  const meta = STATUS_META[file.status];
  const path = file.previousPath ? `${file.previousPath} → ${file.path}` : file.path;
  const githubUrl = file.githubUrl ?? null;

  // One chunk's rows (`DiffChunk` calls this once it is live, with that chunk's highlighting).
  // Indices are the FILE's row indices, so anchoring, the reveal and the gap reveals address rows
  // exactly as they did before the chunks.
  const renderRows = (from: number, to: number, html: (string | null)[] | null): JSX.Element[] => {
    const out: JSX.Element[] = [];
    for (let i = from; i < to; i += 1) {
      const row = rows[i]!;
      out.push(
        <Fragment key={i}>
          {row.kind === 'hunk' ? (
            row.gap != null && row.gap.count > 0 ? (
              <GapExpansion
                gap={row.gap}
                place={gapPlace(rows, i)}
                reveal={reveals.get(i)}
                lines={usableLines}
                html={fileHtml}
                side={side}
                expandable={fileSource != null}
                status={reveals.has(i) ? gapStatus : 'idle'}
                onExpand={(c, count) => expandGap(i, c, count)}
                wrap={wrap}
              />
            ) : null
          ) : isNoNewlineRow(row) ? null : (
            <DiffLine
              row={row}
              html={html?.[i] ?? null}
              filePath={file.path}
              fileUrl={githubUrl}
              commenting={commenting}
              onPosted={onPosted}
              open={openRow === i}
              onOpen={() => setOpenRow(i)}
              onClose={() => setOpenRow(null)}
              focused={focusRow === i}
              focusNonce={focus?.nonce ?? null}
              wrap={wrap}
            />
          )}
          {threadCtx &&
            byRow.get(i)?.map((a) => (
              <InlineThreadRow
                key={a.thread.id}
                thread={a.thread}
                ctx={threadCtx}
                approximate={a.approximate}
                focusNonce={
                  focus != null && focus.threadId === a.thread.id ? focus.nonce : null
                }
                consumedFocus={consumedThreadFocus}
                wrap={wrap}
              />
            ))}
        </Fragment>,
      );
    }
    return out;
  };

  // The two no-table branches (binary / too large, and an empty textual diff) still list every
  // thread — the same pill unit as the table path, in a <div> instead of a row. A thread never
  // disappears, and `revealScrollsFileHeader` relies on it: it hands the scroll to the target's
  // pill whenever the thread belongs to this block, so a branch that dropped the pills would turn
  // a "Show in context" jump into no scroll at all.
  const fileGrainPills =
    threadCtx && threads.length > 0 ? (
      <div className="mt-2 space-y-1 text-left">
        {threads.map((t) => (
          <InlineThread
            key={t.id}
            thread={t}
            ctx={threadCtx}
            fileChip
            focusNonce={focus != null && focus.threadId === t.id ? focus.nonce : null}
            consumedFocus={consumedThreadFocus}
          />
        ))}
      </div>
    ) : null;

  return (
    // The same 2px cyan line (and the same fill behind the sticky name row) the rail's selected row carries, so a click marks the file in the
    // code view too. Fires whenever this file is the focus target — including a reveal from
    // outside the tab that carries no line to flash. `border-l-2` is unconditional and only
    // the colour changes, so no block moves when the selection does.
    <div
      ref={blockRef}
      data-file-block={file.path}
      // `--diff-sticky-top` is the Changes tab's own sticky bar (ChangesTab measures it); unset
      // (the AI Fix tab) it is 0. The scroll margin keeps a 'start' reveal out from under it.
      className={`scroll-mt-[var(--diff-sticky-top,0px)] border-l-2 ${focus != null ? SELECTED_BORDER : UNSELECTED_BORDER}`}
    >
      {/* Sticky per-file header (mirrors the Changes-tab behaviour): the name stays
          pinned as you scroll and is pushed up by the next file's header. Needs an
          opaque background + a z-index above the diff table. It pins BELOW the Changes tab's
          sticky bar. */}
      <div
        className={`sticky top-[var(--diff-sticky-top,0px)] z-10 flex items-center gap-2 border-b px-3 py-1.5 text-meta ${
          focus != null
            ? `${SELECTED_FILL} border-ui-line`
            : 'border-ui-line bg-ui-surface hover:bg-ui-hover'
        }`}
      >
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="hit flex min-w-0 flex-1 items-center gap-2 text-left"
          title={expanded ? 'Collapse this file' : 'Expand this file'}
        >
          <span className="flex w-3 shrink-0 select-none items-center text-ui-faint">
            <ChevronIcon dir={expanded ? 'down' : 'right'} />
          </span>
          <span
            className={`w-3 shrink-0 select-none text-center font-mono font-bold ${meta.cls}`}
            title={meta.label}
          >
            {meta.icon}
          </span>
          <FileTypeIcon path={file.path} />
          <code className="min-w-0 flex-1 truncate font-mono">{path}</code>
        </button>
        {/* Beside the name button, never inside it (nested buttons). Copies the CURRENT path —
            the new one for a rename — not the "old → new" display string. */}
        <CopyButton text={file.path} what="file path" title="Copy file path" />
        {/* The full 4-state mix with counts — the old binary split (amber `N 💬` + grey `✓N`)
            blended untouched, replied and likely-addressed into one number. Same footprint,
            strictly more information; the `unresolvedCount > 0` auto-expand heuristic below
            keeps its `isResolved`-based definition, so this is display-only. */}
        {threads.length > 0 && (
          <span className="shrink-0">
            <ThreadCountChips counts={rollupCounts(threads)} />
          </span>
        )}
        <span className="shrink-0 font-mono tabular-nums">
          <span className="text-ui-success">+{file.additions}</span>{' '}
          <span className="text-ui-danger">−{file.deletions}</span>
        </span>
        {githubUrl && (
          <a
            href={githubUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="hit inline-flex shrink-0 items-center text-ui-ink hover:underline"
            title="View this file's diff on GitHub"
          >
            <ExternalLinkIcon size={12} />
          </a>
        )}
      </div>

      {expanded && (
        <div className="border-b border-ui-line">
          {patch == null ? (
            <div className="px-3 py-3 text-center text-meta text-ui-mute">
              {fileSource != null ? (
                <NoPatchNote
                  status={
                    !wantFullDiff
                      ? 'idle'
                      : fullDiff.isLoading
                        ? 'loading'
                        : fullDiff.isError
                          ? 'error'
                          : (fullDiff.data?.refused ?? 'idle')
                  }
                  onLoad={() => setWantFullDiff(true)}
                  githubUrl={githubUrl}
                />
              ) : githubUrl ? (
                <>
                  Diff is too large or binary —{' '}
                  <a
                    href={githubUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="hit text-ui-ink hover:underline"
                  >
                    view on GitHub
                    <ExternalLinkIcon
                      size={10}
                      className="ml-0.5 inline-block align-[-0.1em]"
                    />
                  </a>
                </>
              ) : (
                'Binary file — no textual diff.'
              )}
              {fileGrainPills}
            </div>
          ) : rows.length === 0 ? (
            <div className="px-3 py-3 text-center text-meta text-ui-mute">
              No textual diff for this file.
              {fileGrainPills}
            </div>
          ) : (
            <DiffTable rows={rows} wrap={wrap}>
              {threadCtx && unanchored.length > 0 && (
                <tbody>
                  {unanchored.map((t) => (
                    <InlineThreadRow
                      key={`u-${t.id}`}
                      thread={t}
                      ctx={threadCtx}
                      fileChip
                      focusNonce={
                        focus != null && focus.threadId === t.id ? focus.nonce : null
                      }
                      consumedFocus={consumedThreadFocus}
                      wrap={wrap}
                    />
                  ))}
                </tbody>
              )}
              {chunks.map((c, ci) => (
                <DiffChunk
                  key={c.from}
                  rows={rows}
                  from={c.from}
                  to={c.to}
                  language={language}
                  force={forcedChunks.has(ci)}
                  estimatePx={estimateChunkPx(
                    rows,
                    c.from,
                    c.to,
                    byRow,
                    threadCtx?.openMemory ?? null,
                    wrap,
                  )}
                  renderRows={renderRows}
                />
              ))}
              {trailingGap != null && (
                <tbody>
                  <GapExpansion
                    gap={trailingGap}
                    place="trailing"
                    reveal={reveals.get(-1)}
                    lines={usableLines}
                    html={fileHtml}
                    side={side}
                    expandable={fileSource != null}
                    status={reveals.has(-1) ? gapStatus : 'idle'}
                    onExpand={(c, count) => expandGap(-1, c, count)}
                    wrap={wrap}
                  />
                </tbody>
              )}
            </DiffTable>
          )}
        </div>
      )}
    </div>
  );
}

// Render a list of changed files. Pass `commenting:{prId}` to enable the Changes-tab
// inline-comment affordances (omit it — AI Fix — for a read-only view), and `threadCtx`
// to render review threads inline at their diff line as pills (unresolved open, resolved shut).
//
// ⚠ MEMOISED, and ChangesTab keeps every prop it passes stable (`threadCtx`, `commenting`,
// `focus`, `files`). PrDetail re-renders at least twice per ~5s poll tick (`isRefreshing` flips)
// and ChangesTab on every rail-drag frame. Unmemoised, each of those repainted every diff row and,
// since unresolved threads start open, every open ThreadCard (532 on the largest real PR). A new
// unstable prop silently switches this off. Nothing fails; it just gets slow — which is why
// `test/inlineThreadOpen.test.ts` pins `threadCtx`'s dependencies from source (it once missed on
// every CI/merge-state refetch through a caller callback closing over the whole `pr`: 1.3–1.5s of
// long tasks per tick). The AI Fix tab's two mounts pass only `files`; memo is harmless there.
export const FileDiffView = memo(function FileDiffView({
  files,
  commenting,
  threadCtx,
  focus,
  fileSource,
}: {
  files: DiffFile[];
  commenting?: { prId: number } | null;
  threadCtx?: DiffThreadContext | null;
  // Optional by contract: the AI Fix tab mounts this component twice with only `files`.
  focus?: DiffFocusTarget | null;
  /** Changes tab only: lets a block load more of its own file, on click (`DiffFileSource`). */
  fileSource?: DiffFileSource | null;
}): JSX.Element {
  // The thread a comment posted from this view just created. Held HERE rather than pushed
  // up to the caller so the focus works from any mount point without extra wiring: it
  // expands the file (FileDiffBlock's hasFocus effect), scrolls the row into view and rings
  // it, then fades. A caller-supplied deep-link focus always wins over it.
  const [postedThreadId, setPostedThreadId] = useState<number | null>(null);
  const [wrap] = useDiffWrap();
  // ONE IntersectionObserver for every chunk of every file (`lazyMount.ts`), rooted on the pane.
  const [mounter] = useState(createLazyMounter);
  useEffect(() => () => mounter.disconnect(), [mounter]);
  const fadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (fadeTimer.current) clearTimeout(fadeTimer.current);
    },
    [],
  );
  const focusPostedThread = (threadId: number | null): void => {
    if (threadId == null) return; // posted, but we have no local row to point at
    setPostedThreadId(threadId);
    if (fadeTimer.current) clearTimeout(fadeTimer.current);
    fadeTimer.current = setTimeout(() => {
      fadeTimer.current = null;
      setPostedThreadId((cur) => (cur === threadId ? null : cur));
    }, POSTED_HIGHLIGHT_MS);
  };

  const effectiveCtx: DiffThreadContext | null = threadCtx
    ? {
        ...threadCtx,
        focusThreadId: threadCtx.focusThreadId ?? postedThreadId,
        // Our own highlight fades on the timer above, so don't let the row's
        // scrolled-into-view callback clear it the instant it lands.
        onThreadShown:
          threadCtx.focusThreadId != null ? threadCtx.onThreadShown : undefined,
      }
    : null;

  // Match the focus target to at most ONE block. A renamed file is addressable under either
  // name: blocks are keyed on the NEW path, but a caller (a Claude-Review finding recorded
  // before the rename, a tree row) may still hold the old one.
  const focusPath = focus?.path ?? null;
  const focusedBlockPath = useMemo(() => {
    if (focusPath == null) return null;
    const exact = files.find((f) => f.path === focusPath);
    if (exact) return exact.path;
    const renamed = files.find((f) => f.previousPath === focusPath);
    return renamed?.path ?? null;
  }, [files, focusPath]);

  // ⚠ `relative` IS LOAD-BEARING: it makes this list the containing block of every absolutely
  // positioned descendant — above all the `sr-only` "added"/"removed" word on each changed line
  // (Tailwind's sr-only is `position: absolute`). PrDetail's scrolling pane is NOT positioned, so
  // without this the nearest containing block was the viewport: hundreds of 1px spans sat at their
  // static positions ~29,000px down, OUTSIDE the pane's clip, and grew the DOCUMENT's scroll height
  // to match. A file-tree click's `scrollIntoView` then scrolled the document as well as the pane —
  // the whole app shell jumped ~265px up and left a gap at the bottom. MEASURED: html scrollHeight
  // 29,462 against a 1,000px window before; equal to the window after.
  return (
    <LazyMountContext.Provider value={mounter}>
    <div className="relative">
      {files.map((f) => (
        <FileDiffBlock
          key={f.path}
          file={f}
          commenting={commenting ?? null}
          onPosted={focusPostedThread}
          threads={threadCtx?.threadsByPath.get(f.path) ?? []}
          threadCtx={effectiveCtx}
          focus={focus != null && f.path === focusedBlockPath ? focus : null}
          wrap={wrap}
          fileSource={fileSource ?? null}
        />
      ))}
    </div>
    </LazyMountContext.Provider>
  );
});
