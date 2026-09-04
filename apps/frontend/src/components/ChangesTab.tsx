import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PrDetail, PrFileChange } from '@pierre-review/shared';
import { usePrFiles } from '../hooks/usePr.js';
import { useUsers } from '../hooks/useTimeline.js';
import { buildFileTree, indexThreadsByPath, type FileTreeEntry } from '../lib/diff.js';
import { useResizablePane } from '../hooks/useResizablePane.js';
import { indexUsers } from '../lib/ui.js';
import {
  FileDiffView,
  type DiffFocusTarget,
  type DiffThreadContext,
} from './diff/FileDiffView.js';
import { FileTree } from './diff/FileTree.js';
import { ThreadCountChips, rollupCounts } from './ThreadList/ThreadCountChips.js';
import { ExternalLinkIcon } from './Icons.js';

// The "Changes" tab: every file the PR touches with its inline diff hunks and per-line
// review-comment affordances. The per-file rendering lives in the shared FileDiffView
// (also used, read-only, by the AI Fix tab); this file owns the data plumbing, the
// summary header, the navigation rail and the lean metadata fallback. Patches are hydrated
// on demand (usePrFiles); on a miss we fall back to the metadata file list with GitHub links.

// Below this many changed files the navigation rail is HIDDEN: a 3-file PR does not earn
// 224px of width, and the bottom detail pane is only 384px tall by default.
const TREE_MIN_FILES = 5;
// Floor for the measured rail height, so dragging the detail split almost shut leaves the tree
// scrollable rather than collapsing it to a sliver.
const MIN_RAIL_PX = 160;

// ---- the rail's user-draggable WIDTH ----
// The rail shipped at a fixed `md:w-56`, which is fine for `src/api/foo.ts` and useless for the
// deeply-nested paths a monorepo produces. The width is now dragged and REMEMBERED (localStorage,
// never the filter store — a filter reset must not move the furniture).
const RAIL_W_KEY = 'pierre:changesRailWidth';
const DEFAULT_RAIL_W_PX = 224; // exactly the old `md:w-56`, so nothing moves until you drag it
const MIN_RAIL_W_PX = 140;
const MAX_RAIL_W_PX = 720;
// The diff is the point of the tab: the rail's ceiling yields to it, so neither pane can be
// dragged (or restored from a wider window's stored value) down to nothing.
const MIN_DIFF_W_PX = 320;

// ---- fallback metadata row (when patches aren't available) ----

function MetaFileRow({ file }: { file: PrFileChange }): JSX.Element {
  const segments = file.path.split('/');
  const fileName = segments.at(-1);
  const dir = segments.slice(0, -1).join('/');
  return (
    <a
      href={file.githubUrl}
      target="_blank"
      rel="noreferrer noopener"
      className="group flex items-center gap-3 px-4 py-1.5 text-sm hover:bg-gray-50 dark:hover:bg-gray-900"
      title={`${file.path} — view this file's diff on GitHub`}
    >
      <code className="min-w-0 flex-1 truncate font-mono text-xs">
        {dir && <span className="text-gray-400">{dir}/</span>}
        <span className="font-semibold">{fileName}</span>
      </code>
      <span className="shrink-0 font-mono text-xs tabular-nums">
        <span className="text-green-600 dark:text-green-400">+{file.additions}</span>{' '}
        <span className="text-red-500 dark:text-red-400">−{file.deletions}</span>
      </span>
      <span className="shrink-0 decorative-mark text-gray-300 group-hover:text-blue-500 dark:text-gray-600">
        <ExternalLinkIcon size={12} />
      </span>
    </a>
  );
}

function Header({ pr, extra }: { pr: PrDetail; extra?: JSX.Element }): JSX.Element {
  return (
    <div className="flex items-center gap-3 border-b border-gray-200 px-4 py-2 text-xs dark:border-gray-800">
      <span className="font-semibold text-gray-600 dark:text-gray-300">
        {pr.changedFilesCount} file{pr.changedFilesCount === 1 ? '' : 's'} changed
      </span>
      <span className="text-green-600 dark:text-green-400">
        +{pr.additions.toLocaleString()}
      </span>
      <span className="text-red-500 dark:text-red-400">
        −{pr.deletions.toLocaleString()}
      </span>
      {extra}
      <a
        href={`${pr.githubUrl}/files`}
        target="_blank"
        rel="noreferrer noopener"
        className="ml-auto text-blue-500 hover:underline"
      >
        Files changed <ExternalLinkIcon size={11} className="inline-block align-[-0.1em]" />
      </a>
    </div>
  );
}

export function ChangesTab({
  pr,
  focus: externalFocus,
  onOpenThread,
}: {
  pr: PrDetail;
  // An outside-in reveal request (today: a Claude Review finding's code anchor, and a thread
  // card's "In Changes"). The tree's own clicks feed the same state, so there is exactly ONE
  // focus target at a time.
  focus?: DiffFocusTarget | null;
  /** The return leg: open one of these inline threads in the Threads tab. */
  onOpenThread?: (threadId: number) => void;
}): JSX.Element {
  const { data, isLoading, isError } = usePrFiles(pr.id);
  const { data: users } = useUsers();
  const usersById = useMemo(() => indexUsers(users), [users]);
  // EVERY thread, resolved included (each renders as a collapsed pill — see InlineThread; the
  // old `.filter((t) => !t.isResolved)` made 40% of threads invisible here). ONE rename-aware
  // fold, built once and shared by the diff blocks, the tree rollups and the header mix: it
  // keys threads on the RENDERED file path, so a thread written before a rename lands under
  // the file's current path instead of silently vanishing from Changes.
  const threadsByPath = useMemo(
    () => indexThreadsByPath(pr.threads, data?.files ?? []),
    [pr.threads, data?.files],
  );
  const threadCtx: DiffThreadContext = {
    threadsByPath,
    usersById,
    prUrl: pr.githubUrl,
    onOpenThread,
  };

  // The focus target is STICKY (never cleared once shown): it doubles as the rail's selected
  // row, and the highlight fades on its own timer inside FileDiffView. `nonce` is what makes
  // clicking the same file twice re-scroll.
  const [focus, setFocus] = useState<DiffFocusTarget | null>(externalFocus ?? null);
  useEffect(() => {
    if (externalFocus != null) setFocus(externalFocus);
  }, [externalFocus]);

  // The split row's own width bounds the rail's ceiling — measured, because the tab lives in a
  // pane the user resizes (and, pinned full-screen, in a much wider one).
  const rowRef = useRef<HTMLDivElement>(null);
  const [rowW, setRowW] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = rowRef.current;
    if (el == null) return;
    const measure = (): void => setRowW(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
    // The row only exists once files have loaded — on the first run the ref is still null.
  }, [data]);

  const {
    width: railW,
    paneRef: railRef,
    separatorProps,
  } = useResizablePane({
    storageKey: RAIL_W_KEY,
    defaultWidth: DEFAULT_RAIL_W_PX,
    minWidth: MIN_RAIL_W_PX,
    maxWidth:
      rowW != null && rowW > 0
        ? Math.min(MAX_RAIL_W_PX, rowW - MIN_DIFF_W_PX)
        : MAX_RAIL_W_PX,
    label: 'Resize the changed-files list',
  });

  // The rail is `sticky top-0` inside PrDetail's scrolling pane, so the height available to it
  // is that pane's client height — NOT a fraction of the window. A fixed `70vh` overflows the
  // pane whenever the PR detail is a bottom split (measured: an 851px rail in a 405px pane),
  // and because the box's bottom then sits below the fold, its final ~446px of rows can never
  // be scrolled into sight — the tail of the tree is simply unreachable. Measure instead.
  const [railMaxH, setRailMaxH] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = railRef.current;
    if (el == null) return;
    let pane: HTMLElement | null = el.parentElement;
    while (pane != null) {
      const oy = getComputedStyle(pane).overflowY;
      if (oy === 'auto' || oy === 'scroll') break;
      pane = pane.parentElement;
    }
    const measure = (): void => {
      // MIN_RAIL_PX keeps the rail usable if the user drags the split almost shut.
      setRailMaxH(Math.max(MIN_RAIL_PX, pane != null ? pane.clientHeight : window.innerHeight));
    };
    measure();
    // The pane is user-resizable (the split drag), so a one-shot measure goes stale.
    const ro = new ResizeObserver(measure);
    if (pane != null) ro.observe(pane);
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
    // `data` is the dependency because the rail only exists once files have loaded — on the
    // first run the ref is still null.
  }, [data]);

  // Computed BEFORE the early returns below — hooks-order rule.
  const files = data?.files ?? [];
  const tree = useMemo(
    () =>
      buildFileTree(
        files.map(
          (f): FileTreeEntry => ({
            path: f.path,
            additions: f.additions,
            deletions: f.deletions,
            status: f.status,
            previousPath: f.previousPath ?? null,
            threadCounts: rollupCounts(threadsByPath.get(f.path) ?? []),
          }),
        ),
      ),
    // `files` is a fresh array each render; the query's data identity is the real input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data?.files, threadsByPath],
  );

  // No changes at all on this PR — same empty state as before.
  if (pr.files.length === 0 && pr.changedFilesCount === 0 && !isLoading) {
    return (
      <div className="px-3 py-6 text-center text-sm text-gray-500 dark:text-gray-400">
        No file changes on this PR.
      </div>
    );
  }

  if (isLoading) {
    return (
      <div>
        <Header pr={pr} />
        <div className="px-3 py-6 text-center text-sm text-gray-500 dark:text-gray-400">
          Loading diff…
        </div>
      </div>
    );
  }

  const havePatches = !isError && files.length > 0;
  const showTree = files.length >= TREE_MIN_FILES;
  // A reveal request for a file this view isn't rendering — the live diff is capped at 100
  // files, and a Claude Review finding describes the head SHA its run read, not necessarily
  // this one. Say so rather than letting the click land as a silent no-op.
  const focusMissing =
    focus != null &&
    !files.some((f) => f.path === focus.path || f.previousPath === focus.path);
  // The rail is keyed on CURRENT paths, but a reveal request can name the old one — a Claude
  // Review finding cites the path its run read, and `focusMissing` above already treats a
  // `previousPath` hit as present. Without this the renamed file's row would never take the
  // selected style and never scroll into view, while the diff pane below jumped correctly.
  const selectedTreePath =
    focus == null
      ? null
      : (files.find((f) => f.previousPath === focus.path && f.path !== focus.path)?.path ??
        focus.path);

  // Fallback: no patches came back but the PR has changed files — show the lean
  // metadata list (per-file links) + a note, keeping the GitHub deep-links.
  if (!havePatches) {
    return (
      <div>
        <Header pr={pr} />
        <div className="px-4 py-2 text-xs text-gray-400">
          {isError
            ? 'The full diff couldn’t be loaded — showing the changed-file list.'
            : 'Inline diffs aren’t available for this PR — showing the changed-file list.'}{' '}
          <a
            href={`${pr.githubUrl}/files`}
            target="_blank"
            rel="noreferrer noopener"
            className="text-blue-500 hover:underline"
          >
            View on GitHub <ExternalLinkIcon size={11} className="inline-block align-[-0.1em]" />
          </a>
        </div>
        {pr.files.length > 0 && (
          <div className="divide-y divide-gray-100 dark:divide-gray-800">
            {pr.files.map((f) => (
              <MetaFileRow key={f.path} file={f} />
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      <Header
        pr={pr}
        extra={
          // The PR-grain version of the file-header read: count + the 4-state mix. Over
          // `pr.threads` (not the indexed map), so the aggregate never under-reports a
          // thread whose file fell outside the 100-file diff cap.
          pr.threads.length > 0 ? (
            <span className="flex items-center gap-2">
              <span className="rounded bg-gray-500/10 px-1.5 py-0.5 text-[11px] font-medium text-gray-600 dark:text-gray-300">
                {pr.threads.length} thread{pr.threads.length === 1 ? '' : 's'}
              </span>
              <ThreadCountChips counts={rollupCounts(pr.threads)} />
            </span>
          ) : undefined
        }
      />
      <div ref={rowRef} className="flex items-start">
        {/* NAVIGATION RAIL — the changed files in their real directory hierarchy. Sticky
            rather than its own `h-full overflow-auto` column: the Changes tab has NO scroll
            container of its own (PrDetail's `min-h-0 flex-1 overflow-auto` is what every
            per-file `sticky top-0` header sticks to), so a nested full-height scroller here
            would move that containing block. Hidden below `md` and below TREE_MIN_FILES.
            The rail + its drag handle share ONE sticky flex wrapper so the handle inherits
            the rail's height (and its stickiness) instead of needing its own measurement. */}
        {showTree && (
          <div className="sticky top-0 z-20 hidden shrink-0 self-start md:flex">
            <div
              ref={railRef}
              // `max-h-[70vh]` is the pre-measure fallback only; the inline value below is the
              // real cap and wins. See the measuring effect for why a viewport fraction is wrong.
              // The WIDTH is the user's dragged value (useResizablePane), which is why the old
              // `md:w-56` is gone — an inline style and a utility class would fight.
              style={{ width: railW, ...(railMaxH != null ? { maxHeight: railMaxH } : null) }}
              className="max-h-[70vh] min-w-0 shrink-0 overflow-y-auto overscroll-contain border-r border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-950"
            >
              <FileTree
                nodes={tree}
                selectedPath={selectedTreePath}
                revealNonce={focus?.nonce}
                railHeight={railMaxH}
                onSelectFile={(path) => setFocus({ path, nonce: Date.now() })}
                note={
                  data?.truncated ? (
                    <div className="px-2 pb-1 pt-0.5 text-[10px] leading-snug text-amber-600 dark:text-amber-400">
                      Showing {files.length} of {pr.changedFilesCount} files.{' '}
                      <a
                        href={`${pr.githubUrl}/files`}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="text-blue-500 hover:underline"
                      >
                        All on GitHub{' '}
                        <ExternalLinkIcon size={10} className="inline-block align-[-0.1em]" />
                      </a>
                    </div>
                  ) : null
                }
              />
            </div>
            {/* THE SPLITTER. `touch-none` so a touch drag resizes instead of scrolling the
                pane. 6px wide: enough to grab without an overlay that would steal clicks
                from the diff's gutter, and it reads as the rail's own edge next to the rail's
                1px border. Keyboard: ←/→ (×4 with Shift), Home/End, Enter to reset — the same
                reset as a double-click. */}
            <div
              {...separatorProps}
              className="w-1.5 shrink-0 cursor-col-resize touch-none bg-gray-200 transition-colors hover:bg-blue-400 focus-visible:bg-blue-500 focus-visible:outline-none dark:bg-gray-800 dark:hover:bg-blue-500"
            />
          </div>
        )}
        {/* No divide-y: each file's (sticky) header carries its own bottom border. */}
        <div className="min-w-0 flex-1">
          {focusMissing && focus != null && (
            <div className="border-b border-amber-500/30 bg-amber-500/10 px-4 py-1.5 text-xs text-amber-700 dark:text-amber-300">
              <code className="font-mono">{focus.path}</code> isn’t in the diff shown here —
              it may be outside this PR&apos;s changed files, or beyond the {files.length}-file
              limit.{' '}
              <a
                href={`${pr.githubUrl}/files`}
                target="_blank"
                rel="noreferrer noopener"
                className="text-blue-500 hover:underline"
              >
                View on GitHub <ExternalLinkIcon size={11} className="inline-block align-[-0.1em]" />
              </a>
            </div>
          )}
          <FileDiffView
            files={files}
            commenting={{ prId: pr.id }}
            threadCtx={threadCtx}
            focus={focus}
          />
        </div>
      </div>
      {data?.truncated && (
        <div className="px-4 py-2 text-xs text-gray-400">
          Large diff — not all files are shown.{' '}
          <a
            href={`${pr.githubUrl}/files`}
            target="_blank"
            rel="noreferrer noopener"
            className="text-blue-500 hover:underline"
          >
            View all on GitHub <ExternalLinkIcon size={11} className="inline-block align-[-0.1em]" />
          </a>
        </div>
      )}
    </div>
  );
}
