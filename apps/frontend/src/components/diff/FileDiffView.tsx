import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type {
  AddReviewCommentResult,
  PrFileDiffStatus,
  ThreadDetail,
  User,
} from '@pierre-review/shared';
import { useAddReviewComment } from '../../hooks/usePrWrites.js';
import { ApiError } from '../../api/client.js';
import {
  anchorRowFor,
  commentTarget,
  isLockFile,
  lineRowIndex,
  parsePatch,
  patchLineCount,
  type DiffRow,
} from '../../lib/diff.js';
import { DERIVED_STATE_META, relativeTime, safeExternalUrl, userLabel } from '../../lib/ui.js';
import { MentionTextarea } from '../MentionTextarea.js';
import { ThreadCard } from '../ThreadView/index.js';
import { ThreadCountChips, rollupCounts } from '../ThreadList/ThreadCountChips.js';
import { STATUS_META } from './status.js';

// The shared per-file diff renderer used by BOTH the Changes tab (with inline
// commenting) and the AI Fix tab (read-only, pre-push). Per-file collapsible blocks
// with a sticky header, line-number gutters, and the >400-line auto-collapse. Inline
// commenting + the GitHub links are OPTIONAL: the AI-Fix changeset's files don't exist
// on GitHub yet, so it passes neither. The Changes tab additionally passes its review
// threads (`threadCtx`, resolved included) so they render inline at their diff line as
// collapsed pills, like GitHub.

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
  /** The return leg — open a thread in the Threads tab. Absent outside PrDetail's Changes tab. */
  onOpenThread?: (threadId: number) => void;
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
  // The review thread this reveal came FROM (a thread card's "In Changes"): the matching
  // inline pill opens + flashes as part of the same reveal — every thread renders collapsed
  // now, and a jump that lands beside a shut pill reads as a broken link. Consumed per
  // `nonce`, never persistently: the focus target is STICKY in ChangesTab, and a sticky
  // thread focus would yank the view back here after every posted-comment fade. Optional —
  // file/line reveals (tree clicks, Claude Review findings) carry none.
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
  hunk: 'bg-sky-500/5 text-sky-600 dark:text-sky-400 select-none',
  add: 'bg-green-500/10',
  del: 'bg-red-500/10',
  context: '',
};

function gutterText(n: number | undefined): string {
  return n == null ? '' : String(n);
}

function DiffLine({
  row,
  filePath,
  fileUrl,
  commenting,
  onPosted,
  open,
  onOpen,
  onClose,
  focused,
  focusNonce,
}: {
  row: DiffRow;
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
}): JSX.Element {
  const target = commenting ? commentTarget(row) : null;
  const display = row.kind === 'hunk' ? row.text : row.text.slice(1) || ' ';

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
    rowRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setFlash(true);
    const t = setTimeout(() => setFlash(false), FOCUS_HIGHLIGHT_MS);
    return () => clearTimeout(t);
  }, [focused, focusNonce]);

  return (
    <>
      <tr
        ref={rowRef}
        className={`group transition-colors ${
          flash ? 'bg-amber-300/40 dark:bg-amber-400/25' : ROW_BG[row.kind]
        }`}
      >
        <td className="w-9 select-none border-r border-gray-200 px-1 text-right align-top text-gray-400 dark:border-gray-800">
          {row.kind === 'hunk' ? '' : gutterText(row.oldLine)}
        </td>
        <td className="w-9 select-none border-r border-gray-200 px-1 text-right align-top text-gray-400 dark:border-gray-800">
          {row.kind === 'hunk' ? '' : gutterText(row.newLine)}
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
                className="rounded bg-blue-500 px-1 text-[10px] font-bold leading-tight text-white opacity-0 transition-opacity hover:bg-blue-600 group-hover:opacity-100"
              >
                +
              </button>
            )}
          </div>
        </td>
        <td className="w-full whitespace-pre px-2 align-top">
          {row.kind !== 'hunk' && (
            <span className="select-none text-gray-400">
              {row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '}
            </span>
          )}
          {display}
        </td>
      </tr>
      {open && commenting && target && (
        <tr>
          <td colSpan={4} className="px-2 py-1.5">
            <InlineCommentBox
              prId={commenting.prId}
              filePath={filePath}
              fileUrl={fileUrl}
              line={target.line}
              side={target.side}
              onPosted={onPosted}
              onClose={onClose}
            />
          </td>
        </tr>
      )}
    </>
  );
}

// One review thread rendered inline in the diff — EVERY thread starts as a one-line
// collapsed pill (state dot + author + age + excerpt) that expands to the full ThreadCard in
// place, the pill staying as the collapse header. One mechanism for all four states, resolved
// merely quieter (no coloured border, dimmed, ✓ for the dot): the file-block auto-expand
// already flags live discussion at file grain, the pill's state colour carries urgency at
// line grain, and full cards at ~200–600px each are exactly the "eats the diff" failure this
// replaces (a 47-unresolved-thread PR rendered ~47 cards interleaved in the hunks). Pills use
// no hooks beyond local expand state — ThreadCard, with its shared per-PR annotation/ML
// queries, mounts only on expand. Expansion is EPHEMERAL component state on purpose (no
// store/URL field — the "derived, never written back" rule).
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
  const ref = useRef<HTMLDivElement>(null);
  const focused = ctx.focusThreadId != null && ctx.focusThreadId === thread.id;
  const [open, setOpen] = useState(false);
  // The deep-link flash (thread card → "In Changes"): timed like the diff-row flash, never
  // persistent — the focus target is sticky in ChangesTab, and a persistent thread focus
  // would yank the view back here after every later posted-comment fade.
  const [flash, setFlash] = useState(false);
  // Focus LATCHES the pill open rather than gating `expanded = open || focused`: the
  // just-posted self-focus clears on a 6s timer, and a card the reader is midway through
  // must not snap shut when the highlight fades. Ring + scroll behaviour unchanged.
  useEffect(() => {
    if (!focused) return;
    setOpen(true);
    ref.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
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
    // Already delivered — this is a REMOUNT (the file was collapsed and re-expanded), not a
    // new reveal. Do nothing: the pill starts closed and unringed, exactly as the user left it.
    if (consumedFocus?.current === focusNonce) return;
    if (consumedFocus != null) consumedFocus.current = focusNonce;
    setOpen(true);
    ref.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setFlash(true);
    const t = setTimeout(() => setFlash(false), FOCUS_HIGHLIGHT_MS);
    return () => clearTimeout(t);
  }, [focusNonce, consumedFocus]);

  const meta = DERIVED_STATE_META[thread.derivedState];
  const resolved = thread.derivedState === 'resolved';
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
    <div ref={ref} className={`rounded font-sans ${ringed ? 'ring-2 ring-amber-400/70' : ''}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        // A disclosure, like the tree's dir rows: the ⌄/⌃ glyph is visual-only, so without
        // this a screen reader hears a state description on a button whose action is unstated.
        aria-expanded={open}
        title={`${meta.label} — ${meta.description}`}
        // Inline colour, not a class pair: border-l colour classes lose to the shorthand
        // border-colour class depending on utility order. Transparent (not absent) when
        // resolved so the pills stay column-aligned.
        style={{ borderLeftColor: resolved ? 'transparent' : meta.color }}
        className={`flex w-full items-center gap-1.5 rounded border border-l-2 border-gray-200 bg-white px-2 py-1 text-left text-[11px] hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:hover:bg-gray-800 ${
          resolved
            ? 'text-gray-400 opacity-70 dark:text-gray-500'
            : 'text-gray-600 dark:text-gray-300'
        }`}
      >
        {resolved ? (
          <span className="shrink-0 text-emerald-600 dark:text-emerald-400">✓</span>
        ) : (
          <span
            className="inline-block h-2 w-2 shrink-0 rounded-full"
            style={{ backgroundColor: meta.color }}
          />
        )}
        {fileChip && (
          <span className="shrink-0 text-gray-400 dark:text-gray-500">
            {thread.isOutdated ? 'outdated' : 'line not in this diff'} ·
          </span>
        )}
        <span className="shrink-0 font-medium">{author}</span>
        <span className="shrink-0 text-gray-400 dark:text-gray-500">
          · {relativeTime(thread.createdAt)}
        </span>
        {approximate && (
          <span
            className="shrink-0 text-gray-400 dark:text-gray-500"
            title="Reconstructed from the code it was written against — may be a few lines off"
          >
            ~
          </span>
        )}
        {replies > 0 && (
          <span className="shrink-0 text-gray-400 dark:text-gray-500">
            · {replies} repl{replies === 1 ? 'y' : 'ies'}
          </span>
        )}
        {excerpt && (
          // Plain text ONLY — bodies are untrusted, so markdown/images/links stay inert here.
          <span className="min-w-0 flex-1 truncate text-gray-400 dark:text-gray-500">
            · {excerpt}
          </span>
        )}
        <span className="ml-auto shrink-0 text-gray-400">{open ? '⌃' : '⌄'}</span>
      </button>
      {open && (
        <div className="mt-1">
          <ThreadCard
            thread={thread}
            usersById={ctx.usersById}
            prUrl={ctx.prUrl}
            selected={ringed}
            onOpenInThreads={
              ctx.onOpenThread != null ? () => ctx.onOpenThread?.(thread.id) : undefined
            }
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
}: {
  thread: ThreadDetail;
  ctx: DiffThreadContext;
  approximate?: boolean;
  fileChip?: boolean;
  focusNonce?: number | null;
  consumedFocus?: MutableRefObject<number | null>;
}): JSX.Element {
  return (
    <tr>
      <td colSpan={4} className="bg-gray-50 px-2 py-1 dark:bg-gray-900/40">
        <InlineThread
          thread={thread}
          ctx={ctx}
          approximate={approximate}
          fileChip={fileChip}
          focusNonce={focusNonce}
          consumedFocus={consumedFocus}
        />
      </td>
    </tr>
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
    <div className="space-y-1 rounded border border-gray-300 bg-white p-2 font-sans dark:border-gray-700 dark:bg-gray-900">
      <div className="text-[10px] text-gray-400">
        Commenting on {side === 'LEFT' ? 'old' : 'new'} line {line}
      </div>
      <MentionTextarea
        prId={prId}
        value={body}
        onChange={setBody}
        rows={3}
        autoFocus
        placeholder="Add an inline review comment (markdown)…"
        className="w-full rounded border border-gray-300 bg-white px-2 py-1.5 text-xs dark:border-gray-700 dark:bg-gray-950"
      />
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={send}
          disabled={busy || body.trim().length === 0}
          className="whitespace-nowrap rounded border border-blue-400 px-2 py-0.5 text-xs text-blue-600 hover:bg-blue-50 disabled:opacity-50 dark:border-blue-600 dark:text-blue-400 dark:hover:bg-blue-900/30"
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
          className="whitespace-nowrap rounded border border-gray-300 px-2 py-0.5 text-xs hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:hover:border-gray-500"
        >
          {notice?.posted ? 'Close' : 'Cancel'}
        </button>
        {error && <span className="text-[10px] text-red-500">{error}</span>}
      </div>
      {notice && (
        <div className="text-[10px] text-amber-600 dark:text-amber-400">
          {notice.text}
          {notice.url && (
            <>
              {' '}
              <a
                href={safeExternalUrl(notice.url)}
                target="_blank"
                rel="noreferrer noopener"
                className="text-blue-500 hover:underline"
              >
                Open on GitHub ↗
              </a>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function FileDiffBlock({
  file,
  commenting,
  onPosted,
  threads,
  threadCtx,
  focus,
}: {
  file: DiffFile;
  commenting: { prId: number } | null;
  onPosted?: (threadId: number | null) => void;
  threads: ThreadDetail[];
  threadCtx: DiffThreadContext | null;
  // Non-null ONLY when this block is the focus target (FileDiffView does the matching).
  focus: DiffFocusTarget | null;
}): JSX.Element {
  const rows = useMemo(() => parsePatch(file.patch), [file.patch]);
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

  // Which row (if any) the focus target addresses. Known even while collapsed — `rows` is
  // parsed from the patch, not from what's rendered — so the block can decide up front
  // whether the LINE will scroll itself or whether it must scroll the file header instead.
  const focusRow = useMemo(() => {
    if (focus == null || focus.line == null) return null;
    return lineRowIndex(rows, focus.line, focus.side ?? 'RIGHT');
  }, [rows, focus]);

  // An explicit reveal ALWAYS wins over the collapse heuristic — including lock files and
  // >250-line patches. A deliberate click that scrolls to a closed `▸` header reads as a
  // broken link, which is worse than overriding a default.
  const blockRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focus == null) return;
    setExpanded(true);
    // No addressable row (file-level target, a line that isn't in the current diff, or a
    // binary/too-large file) ⇒ reveal the FILE. Never do nothing.
    if (focusRow == null) {
      blockRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
    // focusRow is derived from `focus`; re-running on it would double-scroll.
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

  return (
    <div ref={blockRef}>
      {/* Sticky per-file header (mirrors the Changes-tab behaviour): the name stays
          pinned as you scroll and is pushed up by the next file's header. Needs an
          opaque background + a z-index above the diff table. */}
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-gray-100 bg-white px-3 py-1.5 text-xs hover:bg-gray-50 dark:border-gray-800 dark:bg-gray-950 dark:hover:bg-gray-900">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          title={expanded ? 'Collapse this file' : 'Expand this file'}
        >
          <span className="w-3 shrink-0 select-none text-gray-400">
            {expanded ? '▾' : '▸'}
          </span>
          <span
            className={`w-3 shrink-0 select-none text-center font-mono font-bold ${meta.cls}`}
            title={meta.label}
          >
            {meta.icon}
          </span>
          <code className="min-w-0 flex-1 truncate font-mono">{path}</code>
        </button>
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
          <span className="text-green-600 dark:text-green-400">+{file.additions}</span>{' '}
          <span className="text-red-500 dark:text-red-400">−{file.deletions}</span>
        </span>
        {githubUrl && (
          <a
            href={githubUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="shrink-0 text-blue-500 hover:underline"
            title="View this file's diff on GitHub"
          >
            ↗
          </a>
        )}
      </div>

      {expanded && (
        <div className="border-b border-gray-100 dark:border-gray-800">
          {file.patch == null ? (
            <div className="px-3 py-3 text-center text-xs text-gray-500">
              {githubUrl ? (
                <>
                  Diff is too large or binary —{' '}
                  <a
                    href={githubUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-blue-500 hover:underline"
                  >
                    view on GitHub ↗
                  </a>
                </>
              ) : (
                'Binary file — no textual diff.'
              )}
              {/* Even without a textual diff, surface any threads so they aren't lost — the
                  same collapsed pill as the table path, wrapped in a <div> instead of a row. */}
              {threadCtx && threads.length > 0 && (
                <div className="mt-2 space-y-1 text-left">
                  {threads.map((t) => (
                    <InlineThread
                      key={t.id}
                      thread={t}
                      ctx={threadCtx}
                      fileChip
                      focusNonce={
                        focus != null && focus.threadId === t.id ? focus.nonce : null
                      }
                      consumedFocus={consumedThreadFocus}
                    />
                  ))}
                </div>
              )}
            </div>
          ) : rows.length === 0 ? (
            <div className="px-3 py-3 text-center text-xs text-gray-500">
              No textual diff for this file.
            </div>
          ) : (
            <table className="w-full border-collapse font-mono text-[12px] leading-[1.45]">
              <tbody>
                {threadCtx &&
                  unanchored.map((t) => (
                    <InlineThreadRow
                      key={`u-${t.id}`}
                      thread={t}
                      ctx={threadCtx}
                      fileChip
                      focusNonce={
                        focus != null && focus.threadId === t.id ? focus.nonce : null
                      }
                      consumedFocus={consumedThreadFocus}
                    />
                  ))}
                {rows.map((row, i) => (
                  <Fragment key={i}>
                    <DiffLine
                      row={row}
                      filePath={file.path}
                      fileUrl={githubUrl}
                      commenting={commenting}
                      onPosted={onPosted}
                      open={openRow === i}
                      onOpen={() => setOpenRow(i)}
                      onClose={() => setOpenRow(null)}
                      focused={focusRow === i}
                      focusNonce={focus?.nonce ?? null}
                    />
                    {threadCtx &&
                      byRow.get(i)?.map((a) => (
                        <InlineThreadRow
                          key={a.thread.id}
                          thread={a.thread}
                          ctx={threadCtx}
                          approximate={a.approximate}
                          focusNonce={
                            focus != null && focus.threadId === a.thread.id
                              ? focus.nonce
                              : null
                          }
                          consumedFocus={consumedThreadFocus}
                        />
                      ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

// Render a list of changed files. Pass `commenting:{prId}` to enable the Changes-tab
// inline-comment affordances (omit it — AI Fix — for a read-only view), and `threadCtx`
// to render review threads inline at their diff line as collapsed pills.
export function FileDiffView({
  files,
  commenting,
  threadCtx,
  focus,
}: {
  files: DiffFile[];
  commenting?: { prId: number } | null;
  threadCtx?: DiffThreadContext | null;
  // Optional by contract: the AI Fix tab mounts this component twice with only `files`.
  focus?: DiffFocusTarget | null;
}): JSX.Element {
  // The thread a comment posted from this view just created. Held HERE rather than pushed
  // up to the caller so the focus works from any mount point without extra wiring: it
  // expands the file (FileDiffBlock's hasFocus effect), scrolls the row into view and rings
  // it, then fades. A caller-supplied deep-link focus always wins over it.
  const [postedThreadId, setPostedThreadId] = useState<number | null>(null);
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

  return (
    <div>
      {files.map((f) => (
        <FileDiffBlock
          key={f.path}
          file={f}
          commenting={commenting ?? null}
          onPosted={focusPostedThread}
          threads={threadCtx?.threadsByPath.get(f.path) ?? []}
          threadCtx={effectiveCtx}
          focus={focus != null && f.path === focusedBlockPath ? focus : null}
        />
      ))}
    </div>
  );
}
