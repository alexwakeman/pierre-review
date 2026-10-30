import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Ref,
} from 'react';
import type { PrDetail, PrFileChange, PrFileDiff } from '@pierre-review/shared';
import { usePrFiles, usePrMoreFiles } from '../hooks/usePr.js';
import { useUsers } from '../hooks/useTimeline.js';
import { buildFileTree, indexThreadsByPath, type FileTreeEntry } from '../lib/diff.js';
import { useResizablePane } from '../hooks/useResizablePane.js';
import { indexUsers } from '../lib/ui.js';
import {
  DiffWrapToggle,
  FileDiffView,
  type DiffFocusTarget,
  type DiffThreadContext,
} from './diff/FileDiffView.js';
import { FileTree } from './diff/FileTree.js';
import { ThreadCountChips, rollupCounts } from './ThreadList/ThreadCountChips.js';
import { ExternalLinkIcon, ThreadsIcon } from './Icons.js';
import {
  createThreadResolveBus,
  useResolveEvents,
} from '../hooks/useResolveEvents.js';
import { CopyButton } from './CopyButton.js';
import { cx, FOCUS_RING, Menu, shortcutBlocked, useRegisterCommands, type Command, type MenuEntry } from './ui/index.js';
import { FileTypeIcon } from './FileTypeIcons.js';

// The "Changes" tab: every file the PR touches with its inline diff hunks and per-line
// review-comment affordances. The per-file rendering lives in the shared FileDiffView
// (also used, read-only, by the AI Fix tab); this file owns the data plumbing, the
// summary header, the navigation rail and the lean metadata fallback. Patches are hydrated
// on demand (usePrFiles); on a miss we fall back to the metadata file list with GitHub links.

// ⚠ THE RAIL HAS NO FILE-COUNT THRESHOLD, AND MUST NOT GROW ONE AGAIN. It used to hide under
// `TREE_MIN_FILES = 5` because "a 3-file PR does not earn 224px of width". That argument is about
// WIDTH; what shipped was about IDENTITY — two pull requests open side by side, one with a file
// list and one without, and nothing on screen saying why. It was reported as "sometimes the file
// browser is not visible, and I don't know why", which is what an invisible threshold always
// produces: not a complaint about the rail, a complaint about the app being unpredictable. The
// width objection already has an answer the reader controls — the drag handle below, and it
// persists; a reader should not have to know a number to predict whether a panel exists.
//
// The ONE remaining reason it can be absent is the `md` breakpoint on the rail itself: a viewport
// too narrow for a rail AND a diff. That one is self-evident, and reverses when the window grows.

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
  // The copy button sits BESIDE the link, never inside it: a <button> inside an <a> is invalid
  // markup, and a click on it would navigate as well as copy.
  return (
    <div className="flex items-center pr-3 hover:bg-ui-hover">
      <a
        href={file.githubUrl}
        target="_blank"
        rel="noreferrer noopener"
        className="hit group flex min-w-0 flex-1 items-center gap-3 px-4 py-1.5 text-body"
        title={`${file.path} — view this file's diff on GitHub`}
      >
        <code className="min-w-0 flex-1 truncate font-mono text-meta">
          {dir && <span className="text-ui-faint">{dir}/</span>}
          <span className="font-semibold">{fileName}</span>
        </code>
        <span className="shrink-0 font-mono text-meta tabular-nums">
          <span className="text-ui-success">+{file.additions}</span>{' '}
          <span className="text-ui-danger">−{file.deletions}</span>
        </span>
        <span className="shrink-0 decorative-mark text-ui-faint group-hover:text-ui-accent">
          <ExternalLinkIcon size={12} />
        </span>
      </a>
      <CopyButton text={file.path} what="file path" title="Copy file path" />
    </div>
  );
}

/**
 * "Load next 100 files" — the Changes tab's way past the first page of a big PR. One click is one
 * page (one GitHub call); nothing loads on its own. Past GitHub's 3,000-file listing ceiling it
 * says so and keeps the GitHub link, which is then the only way to see the rest.
 */
function MoreFilesNote({
  shown,
  total,
  canLoadMore,
  ceilingReached,
  loading,
  error,
  onLoadMore,
  githubUrl,
  compact = false,
}: {
  shown: number;
  total: number;
  canLoadMore: boolean;
  ceilingReached: boolean;
  loading: boolean;
  error: boolean;
  onLoadMore: () => void;
  githubUrl: string;
  /** The rail's narrow version. */
  compact?: boolean;
}): JSX.Element {
  const ofTotal = `${shown.toLocaleString()} of ${Math.max(total, shown).toLocaleString()} shown`;
  return (
    <div
      className={
        compact
          ? 'space-y-0.5 px-2 pb-1 pt-0.5 text-meta leading-snug text-ui-warn'
          : 'flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-meta text-ui-mute'
      }
    >
      {canLoadMore ? (
        <button
          type="button"
          onClick={onLoadMore}
          disabled={loading}
          className="hit rounded-ui border border-ui-accent/50 px-2 py-0.5 text-ui-accent hover:bg-ui-accent/10 disabled:opacity-60"
        >
          {loading ? 'Loading files…' : `Load next 100 files (${ofTotal})`}
        </button>
      ) : (
        <span>{ofTotal}.</span>
      )}
      {error && <span className="text-ui-warn">Couldn’t load more files.</span>}
      {ceilingReached && <span>GitHub lists at most 3,000 files.</span>}
      <a
        href={`${githubUrl}/files`}
        target="_blank"
        rel="noreferrer noopener"
        className={`text-ui-accent hover:underline ${compact ? 'block' : ''}`}
      >
        All on GitHub <ExternalLinkIcon size={11} className="inline-block align-[-0.1em]" />
      </a>
    </div>
  );
}

/**
 * THE CHANGES TAB'S STICKY BAR. It stays on screen while the code scrolls (`sticky top-0`
 * inside PrDetail's scroll pane), and everything else that sticks in this tab — the rail, each
 * file's header, the Threads only filter header — pins BELOW it through `--diff-sticky-top`,
 * which ChangesTab measures off this bar.
 *
 * ⚠ It carries NO file delta (file count, +/− lines): the PR header above every tab already
 * states it, and two copies an inch apart is one too many.
 */
function Header({
  pr,
  barRef,
  threadsOnly,
  onThreadsOnlyChange,
  wrapToggle = false,
  filesMenu,
}: {
  pr: PrDetail;
  barRef?: Ref<HTMLDivElement>;
  threadsOnly: boolean;
  onThreadsOnlyChange: (on: boolean) => void;
  /** Only while code is on screen — the metadata list and the Threads only view have none. */
  wrapToggle?: boolean;
  /** Below md, where the rail is hidden: the changed files as a menu (a sheet on a phone). */
  filesMenu?: ReactNode;
}): JSX.Element {
  const threadCount = pr.threads.length;
  return (
    <div
      ref={barRef}
      data-testid="changes-bar"
      className="sticky top-0 z-30 flex flex-wrap items-center gap-x-3 gap-y-1 bg-ui-bg px-4 py-1.5 text-meta text-ui-mute md:px-5"
    >
      {filesMenu}
      {/* "Threads only": the review threads without the code. A toggle, so it says its state to
          a screen reader. Absent on a PR with no threads (there is nothing to show). The 4-state
          mix beside it counts `pr.threads`, not the indexed map, so a thread on a file not loaded
          yet is still counted. */}
      {threadCount > 0 && (
        <>
          <button
            type="button"
            aria-pressed={threadsOnly}
            onClick={() => onThreadsOnlyChange(!threadsOnly)}
            data-testid="changes-threads-only"
            title="Show the review threads without the code"
            aria-keyshortcuts="t"
            className={cx(
              'inline-flex h-7 items-center gap-1.5 rounded-ui px-2 text-meta font-medium touch:h-10 touch:px-3',
              'motion-safe:transition-colors motion-safe:duration-ui-fast',
              threadsOnly ? 'bg-ui-sel text-ui-ink' : 'bg-ui-raise text-ui-mute hover:bg-ui-hover hover:text-ui-ink',
              FOCUS_RING,
            )}
          >
            <ThreadsIcon size={12} className="shrink-0" />
            Threads only
            <span className="tabular-nums text-ui-faint">{threadCount}</span>
          </button>
          <ThreadCountChips counts={rollupCounts(pr.threads)} />
        </>
      )}
      <span className="ml-auto flex items-center gap-3">
        {wrapToggle && <DiffWrapToggle />}
        <a
          href={`${pr.githubUrl}/files`}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex items-center gap-1 text-ui-accent hover:underline touch:min-h-10"
        >
          Files changed <ExternalLinkIcon size={11} className="inline-block align-[-0.1em]" />
        </a>
      </span>
    </div>
  );
}

export function ChangesTab({
  pr,
  focus: externalFocus,
  threadOpenMemory,
  threadsOnly,
  onThreadsOnlyChange,
  renderThreads,
  keysEnabled = false,
}: {
  pr: PrDetail;
  // An outside-in reveal request (today: a Claude Review finding's code anchor, and a thread
  // card's "Show in context"). The tree's own clicks feed the same state, so there is exactly ONE
  // focus target at a time.
  focus?: DiffFocusTarget | null;
  /**
   * The inline pills' open/shut DECISIONS, keyed by thread id — owned by PrDetail so they survive
   * this tab remounting (a tab switch). See DiffThreadContext.openMemory.
   */
  threadOpenMemory: Map<number, boolean>;
  /**
   * The "Threads only" view: the review threads without the code. PrDetail owns it (LOCAL state,
   * per PR pane), because its deep links switch it: a thread whose file left the diff, the
   * Overview's Bots chip, a state-pill preset from the Bots pane.
   */
  threadsOnly: boolean;
  onThreadsOnlyChange: (on: boolean) => void;
  /**
   * The Threads only view's list, built by PrDetail (which holds the selection, the guarded
   * filters and the thread → code ladder). `visibleThreadIds` is the rail's file pick, null for
   * every file.
   */
  /**
   * n / p (next / previous file), ] / [ (next / previous thread), t (Threads only) and their ⌘K
   * commands — only while this PR is the one on screen (PrDetail's `liveVisible`).
   */
  keysEnabled?: boolean;
  renderThreads: (visibleThreadIds: ReadonlySet<number> | null) => JSX.Element;
}): JSX.Element {
  const { data, isLoading, isError } = usePrFiles(pr.id);
  // Pages 2+ ("Load next 100 files"), click-gated. Appended after page 1, deduplicated by path in
  // case the listing shifted between clicks (a push re-keys both).
  const more = usePrMoreFiles(pr.id, data);
  const allFiles = useMemo((): PrFileDiff[] => {
    const first = data?.files ?? [];
    if (more.files.length === 0) return first;
    const seen = new Set(first.map((f) => f.path));
    return [...first, ...more.files.filter((f) => !seen.has(f.path))];
  }, [data?.files, more.files]);
  // A diff cached before paging existed carries `truncated` but no `nextPage`: say there is more,
  // with only the GitHub link to offer.
  const truncated =
    more.canLoadMore || more.ceilingReached || (data?.truncated === true && data.nextPage === undefined);
  const { data: users } = useUsers();
  const usersById = useMemo(() => indexUsers(users), [users]);
  // EVERY thread, resolved included (each renders as a pill — unresolved open, resolved shut;
  // see InlineThread; the old `.filter((t) => !t.isResolved)` made 40% of threads invisible
  // here). ONE rename-aware fold, built once and shared by the diff blocks, the tree rollups and
  // the header mix: it keys threads on the RENDERED file path, so a thread written before a
  // rename lands under the file's current path instead of silently vanishing from Changes.
  const threadsByPath = useMemo(
    () => indexThreadsByPath(pr.threads, allFiles),
    [pr.threads, allFiles],
  );
  // A RESOLVE COLLAPSES ITS THREAD, whichever view it was made in. ONE subscription to the
  // successful resolve writes (every resolve shares RESOLVE_THREAD_MUTATION_KEY): the decision is
  // written to `threadOpenMemory` first, so a pill that is not mounted (a collapsed file, the
  // Threads only view on screen) comes back shut, then the mounted pill hears it on the bus. The
  // Threads only list collapses its own (ThreadList, same hook). The bus is created once, so it
  // is stable by construction for `threadCtx`.
  const [resolveBus] = useState(createThreadResolveBus);
  useResolveEvents(pr.id, (events) => {
    for (const e of events) {
      threadOpenMemory.set(e.threadId, !e.resolved);
      resolveBus.emit(e);
    }
  });
  // Memoised, like `commenting` below: FileDiffView is memo'd (see the ⚠ there), and a fresh
  // literal here would repaint every diff row — and every open thread card — on each poll tick
  // and rail-drag frame. Every input is data or stable by construction; keep it that way.
  const threadCtx = useMemo<DiffThreadContext>(
    () => ({
      threadsByPath,
      usersById,
      prUrl: pr.githubUrl,
      openMemory: threadOpenMemory,
      resolveBus,
    }),
    [threadsByPath, usersById, pr.githubUrl, threadOpenMemory, resolveBus],
  );
  // Stable for the same reason: FileDiffView is memo'd, and an inline `{ prId }` literal would
  // defeat it on every render.
  const commenting = useMemo(() => ({ prId: pr.id }), [pr.id]);
  // Where a block may load more of its own file (a gap's hidden lines, a full diff GitHub would not
  // send) — every read click-gated inside the block. Stable for the memo, like the two above.
  const fileSource = useMemo(
    () => ({ prId: pr.id, headSha: data?.headSha ?? null }),
    [pr.id, data?.headSha],
  );

  // The focus target is STICKY (never cleared once shown): it doubles as the rail's selected
  // row AND marks the file's block in the diff with the same sky border, both for as long as
  // the file stays selected. Only the line-grained flash inside FileDiffView fades on a timer.
  // `nonce` is what makes clicking the same file twice re-scroll.
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

  // THE STICKY BAR'S HEIGHT, measured, because everything else that sticks in this tab pins BELOW
  // it: the rail (inline `top`), each file header and the Threads only filter header (both read
  // `--diff-sticky-top`, set on this tab's root). A callback ref because the bar is rendered by
  // whichever branch is on screen (loading, the metadata list, the diff), each a new element.
  const [barH, setBarH] = useState(0);
  const barObserver = useRef<ResizeObserver | null>(null);
  const barRef = useCallback((el: HTMLDivElement | null) => {
    barObserver.current?.disconnect();
    barObserver.current = null;
    if (el == null) return;
    const measure = (): void => setBarH(el.offsetHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    barObserver.current = ro;
  }, []);
  const rootStyle = { '--diff-sticky-top': `${barH}px` } as CSSProperties;

  // The Threads only view's file pick (the rail's click there): which file's threads to list.
  // EPHEMERAL, and dropped whenever the view is switched off, so turning it back on starts from
  // every file. Rename-aware through the same `threadsByPath` fold the diff uses.
  const [threadsPath, setThreadsPath] = useState<string | null>(null);
  useEffect(() => {
    if (!threadsOnly) setThreadsPath(null);
  }, [threadsOnly]);
  const visibleThreadIds = useMemo(
    () =>
      threadsPath == null
        ? null
        : new Set((threadsByPath.get(threadsPath) ?? []).map((t) => t.id)),
    [threadsPath, threadsByPath],
  );

  // Computed BEFORE the early returns below — hooks-order rule.
  const files = allFiles;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allFiles, threadsByPath],
  );

  // No changes at all on this PR — same empty state as before.
  // KEYBOARD: n / p walk the files, ] / [ walk the threads in file order, t toggles Threads only.
  // The cursor is the last file / thread a key (or a rail click, via `focus`) went to. Every move
  // goes through `setFocus`, the same reveal a rail click or a finding anchor uses. Hooks sit above
  // the early returns; the handler reads the latest values through a ref.
  const orderedThreads = useMemo(() => {
    const out: { path: string; id: number; line: number | null }[] = [];
    for (const f of files) {
      const ts = [...(threadsByPath.get(f.path) ?? [])].sort(
        (a, b) => (a.line ?? Number.MAX_SAFE_INTEGER) - (b.line ?? Number.MAX_SAFE_INTEGER) || a.id - b.id,
      );
      for (const t of ts) out.push({ path: f.path, id: t.id, line: t.line ?? null });
    }
    return out;
  }, [files, threadsByPath]);
  const threadCursor = useRef(-1);
  const navLive = useRef({ files, orderedThreads, focus, threadsOnly, threadsPath });
  navLive.current = { files, orderedThreads, focus, threadsOnly, threadsPath };
  const stepFile = useCallback(
    (delta: 1 | -1): void => {
      const { files: fs, focus: f, threadsOnly: only, threadsPath: tp } = navLive.current;
      if (fs.length === 0) return;
      if (only) {
        // In the Threads only view the rail lists a file's threads: step through files that have some.
        const withThreads = fs.filter((x) => (threadsByPath.get(x.path)?.length ?? 0) > 0);
        if (withThreads.length === 0) return;
        const at = withThreads.findIndex((x) => x.path === tp);
        const next = withThreads[(at + delta + withThreads.length) % withThreads.length] ?? withThreads[0]!;
        setThreadsPath(next.path);
        return;
      }
      const at = f == null ? -1 : fs.findIndex((x) => x.path === f.path || x.previousPath === f.path);
      const nextIdx = at < 0 ? (delta === 1 ? 0 : fs.length - 1) : (at + delta + fs.length) % fs.length;
      const next = fs[nextIdx];
      if (next) setFocus({ path: next.path, nonce: Date.now() });
    },
    [threadsByPath],
  );
  const stepThread = useCallback(
    (delta: 1 | -1): void => {
      const { orderedThreads: ts } = navLive.current;
      if (ts.length === 0) return;
      const at = threadCursor.current;
      const nextIdx = at < 0 ? (delta === 1 ? 0 : ts.length - 1) : (at + delta + ts.length) % ts.length;
      const t = ts[nextIdx];
      if (!t) return;
      threadCursor.current = nextIdx;
      // The code comes back: a thread jump is "Show in context".
      if (navLive.current.threadsOnly) onThreadsOnlyChange(false);
      setFocus({ path: t.path, line: t.line, side: 'RIGHT', threadId: t.id, nonce: Date.now() });
    },
    [onThreadsOnlyChange],
  );
  const toggleThreadsOnly = useCallback((): void => {
    if (pr.threads.length > 0) onThreadsOnlyChange(!navLive.current.threadsOnly);
  }, [pr.threads.length, onThreadsOnlyChange]);
  useEffect(() => {
    if (!keysEnabled) return;
    const onKey = (e: KeyboardEvent): void => {
      if (shortcutBlocked(e)) return;
      if (e.key === 'n') stepFile(1);
      else if (e.key === 'p') stepFile(-1);
      else if (e.key === ']') stepThread(1);
      else if (e.key === '[') stepThread(-1);
      else if (e.key === 't') toggleThreadsOnly();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [keysEnabled, stepFile, stepThread, toggleThreadsOnly]);
  const hasThreads = pr.threads.length > 0;
  const changesCommands = useMemo((): Command[] | null => {
    if (!keysEnabled) return null;
    return [
      { id: 'changes:next-file', title: 'Next file', group: 'Actions', shortcut: 'n', keywords: ['diff', 'changes'], run: () => stepFile(1) },
      { id: 'changes:prev-file', title: 'Previous file', group: 'Actions', shortcut: 'p', keywords: ['diff', 'changes'], run: () => stepFile(-1) },
      ...(hasThreads
        ? [
            { id: 'changes:next-thread', title: 'Next review thread', group: 'Actions' as const, shortcut: ']', keywords: ['comment'], run: () => stepThread(1) },
            { id: 'changes:prev-thread', title: 'Previous review thread', group: 'Actions' as const, shortcut: '[', keywords: ['comment'], run: () => stepThread(-1) },
            { id: 'changes:threads-only', title: 'Threads only: show or hide the code', group: 'Actions' as const, shortcut: 't', run: toggleThreadsOnly },
          ]
        : []),
    ];
  }, [keysEnabled, hasThreads, stepFile, stepThread, toggleThreadsOnly]);
  useRegisterCommands('pr-changes', changesCommands);

  if (pr.files.length === 0 && pr.changedFilesCount === 0 && pr.threads.length === 0 && !isLoading) {
    return (
      <div className="px-5 py-6 text-center text-body text-ui-mute">
        No file changes on this PR.
      </div>
    );
  }

  // BELOW md THE RAIL IS HIDDEN: the same files, as a menu (a bottom sheet on a phone) — a pick
  // does what a rail click does.
  const filesMenu =
    files.length > 0 ? (
      <span className="md:hidden">
        <Menu
          label="Changed files"
          items={files.map(
            (f): MenuEntry => ({
              id: f.path,
              label: f.path.split('/').at(-1) ?? f.path,
              text: f.path.split('/').at(-1) ?? f.path,
              icon: <FileTypeIcon path={f.path} size={14} />,
              hint: (
                <span className="tabular-nums">
                  {(threadsByPath.get(f.path)?.length ?? 0) > 0 && (
                    <span className="mr-2">{threadsByPath.get(f.path)!.length} threads</span>
                  )}
                  +{f.additions} −{f.deletions}
                </span>
              ),
              onSelect: () =>
                threadsOnly ? setThreadsPath(f.path) : setFocus({ path: f.path, nonce: Date.now() }),
            }),
          )}
          trigger={(p) => (
            <button
              {...p}
              type="button"
              className={cx(
                'inline-flex h-7 items-center gap-1.5 rounded-ui bg-ui-raise px-2 text-meta font-medium text-ui-ink hover:bg-ui-hover touch:h-10 touch:px-3',
                FOCUS_RING,
              )}
            >
              Files <span className="tabular-nums text-ui-faint">{files.length}</span>
            </button>
          )}
        />
      </span>
    ) : null;

  const bar = (wrapToggle: boolean): JSX.Element => (
    <Header
      pr={pr}
      barRef={barRef}
      threadsOnly={threadsOnly}
      onThreadsOnlyChange={onThreadsOnlyChange}
      wrapToggle={wrapToggle && !threadsOnly}
      filesMenu={wrapToggle ? filesMenu : null}
    />
  );

  const havePatches = !isLoading && !isError && files.length > 0;

  // THREADS ONLY with no rail to show (the diff is still loading, or never came): the list alone.
  // The threads do not need the patches — every one of them is on the PR payload.
  if (threadsOnly && !havePatches) {
    return (
      <div style={rootStyle}>
        {bar(false)}
        {renderThreads(null)}
      </div>
    );
  }

  if (isLoading) {
    return (
      <div style={rootStyle}>
        {bar(false)}
        <div className="px-5 py-6 text-center text-body text-ui-mute">
          Loading diff…
        </div>
      </div>
    );
  }

  // A reveal request for a file this view isn't rendering — the live diff loads 100 files a
  // page, and a Claude Review finding describes the head SHA its run read, not necessarily
  // this one. Say so rather than letting the click land as a silent no-op.
  const focusMissing =
    focus != null &&
    !files.some((f) => f.path === focus.path || f.previousPath === focus.path);
  // The rail is keyed on CURRENT paths, but a reveal request can name the old one — a Claude
  // Review finding cites the path its run read, and `focusMissing` above already treats a
  // `previousPath` hit as present. Without this the renamed file's row would never take the
  // selected style and never scroll into view, while the diff pane below jumped correctly.
  // In the Threads only view the selected row is the file whose threads are listed.
  const selectedTreePath = threadsOnly
    ? threadsPath
    : focus == null
      ? null
      : (files.find((f) => f.previousPath === focus.path && f.path !== focus.path)?.path ??
        focus.path);

  // Fallback: no patches came back but the PR has changed files — show the lean
  // metadata list (per-file links) + a note, keeping the GitHub deep-links.
  if (!havePatches) {
    return (
      <div style={rootStyle}>
        {bar(false)}
        <div className="px-4 py-2 text-meta text-ui-mute">
          {isError
            ? 'The full diff couldn’t be loaded — showing the changed-file list.'
            : 'Inline diffs aren’t available for this PR — showing the changed-file list.'}{' '}
          <a
            href={`${pr.githubUrl}/files`}
            target="_blank"
            rel="noreferrer noopener"
            className="hit text-ui-accent hover:underline"
          >
            View on GitHub <ExternalLinkIcon size={11} className="inline-block align-[-0.1em]" />
          </a>
        </div>
        {pr.files.length > 0 && (
          <div className="divide-y divide-ui-line">
            {pr.files.map((f) => (
              <MetaFileRow key={f.path} file={f} />
            ))}
          </div>
        )}
      </div>
    );
  }

  // The rail's height budget is the pane's, less the sticky bar it pins under.
  const railCap = railMaxH != null ? Math.max(MIN_RAIL_PX, railMaxH - barH) : null;

  return (
    <div style={rootStyle}>
      {bar(true)}
      <div ref={rowRef} className="flex items-start">
        {/* NAVIGATION RAIL — the changed files in their real directory hierarchy. Sticky
            rather than its own `h-full overflow-auto` column: the Changes tab has NO scroll
            container of its own (PrDetail's `min-h-0 flex-1 overflow-auto` is what every
            per-file sticky header sticks to), so a nested full-height scroller here would move
            that containing block. It pins BELOW the sticky bar (`top: barH`). Hidden below `md`,
            and NOT otherwise — see the ⚠ at the top of this file. Past here `files` is non-empty
            by `havePatches`, so there is always something to list. The rail + its drag handle
            share ONE sticky flex wrapper so the handle inherits the rail's height (and its
            stickiness) instead of needing its own measurement. It stays in the Threads only view,
            where a click lists that file's threads instead of scrolling the code. */}
        <div
          className="sticky z-20 hidden shrink-0 self-start md:flex"
          style={{ top: barH }}
        >
          <div
            ref={railRef}
            // `max-h-[70vh]` is the pre-measure fallback only; the inline value below is the
            // real cap and wins. See the measuring effect for why a viewport fraction is wrong.
            // The WIDTH is the user's dragged value (useResizablePane), which is why the old
            // `md:w-56` is gone — an inline style and a utility class would fight.
            style={{ width: railW, ...(railCap != null ? { maxHeight: railCap } : null) }}
            className="max-h-[70vh] min-w-0 shrink-0 overflow-y-auto overscroll-contain bg-ui-surface"
          >
            <FileTree
              nodes={tree}
              selectedPath={selectedTreePath}
              revealNonce={threadsOnly ? undefined : focus?.nonce}
              railHeight={railCap}
              onSelectFile={(path) =>
                threadsOnly
                  ? // A second click on the listed file goes back to every file.
                    setThreadsPath((cur) => (cur === path ? null : path))
                  : setFocus({ path, nonce: Date.now() })
              }
              note={
                truncated ? (
                  <MoreFilesNote
                    compact
                    shown={files.length}
                    total={pr.changedFilesCount}
                    canLoadMore={more.canLoadMore}
                    ceilingReached={more.ceilingReached}
                    loading={more.loading}
                    error={more.error}
                    onLoadMore={more.loadMore}
                    githubUrl={pr.githubUrl}
                  />
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
            className="w-1.5 shrink-0 cursor-col-resize touch-none bg-ui-bg motion-safe:transition-colors hover:bg-ui-accent/40 focus-visible:bg-ui-accent focus-visible:outline-none"
          />
        </div>
        {threadsOnly && (
          <div className="min-w-0 flex-1" data-testid="changes-threads-view">
            {threadsPath != null && (
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-4 py-1.5 text-meta text-ui-mute md:px-5">
                <span>Threads on</span>
                <code className="min-w-0 truncate font-mono font-semibold" title={threadsPath}>
                  {threadsPath.split('/').at(-1)}
                </code>
                <button
                  type="button"
                  onClick={() => setThreadsPath(null)}
                  className="rounded-ui px-1.5 py-0.5 text-ui-accent underline-offset-2 hover:underline touch:min-h-10"
                >
                  All files
                </button>
              </div>
            )}
            {renderThreads(visibleThreadIds)}
          </div>
        )}
        {/* THE CODE STAYS MOUNTED (hidden) under the Threads only view. Unmounting it would drop
            every file's expand state and each block's record of the reveal it already delivered,
            so switching the view off by hand would re-run the LAST reveal (the focus target is
            sticky) and teleport the reader to an old line. "Show in context" sets a NEW target in
            the same render that shows the code, so its reveal runs once the code is visible.
            No divide-y: each file's (sticky) header carries its own bottom border. */}
        <div className={threadsOnly ? 'hidden' : 'min-w-0 flex-1'}>
          {focusMissing && focus != null && (
            <div className="border-b border-ui-warn/40 bg-ui-warn/10 px-4 py-1.5 text-meta text-ui-warn">
              <code className="font-mono">{focus.path}</code> isn’t in the diff shown here.
              {truncated
                ? ' It may be in the files not loaded yet.'
                : ' It may be outside this PR’s changed files.'}{' '}
              <a
                href={`${pr.githubUrl}/files`}
                target="_blank"
                rel="noreferrer noopener"
                className="hit text-ui-accent hover:underline"
              >
                View on GitHub <ExternalLinkIcon size={11} className="inline-block align-[-0.1em]" />
              </a>
            </div>
          )}
          <FileDiffView
            files={files}
            commenting={commenting}
            threadCtx={threadCtx}
            focus={focus}
            fileSource={fileSource}
          />
        </div>
      </div>
      {truncated && !threadsOnly && (
        <MoreFilesNote
          shown={files.length}
          total={pr.changedFilesCount}
          canLoadMore={more.canLoadMore}
          ceilingReached={more.ceilingReached}
          loading={more.loading}
          error={more.error}
          onLoadMore={more.loadMore}
          githubUrl={pr.githubUrl}
        />
      )}
    </div>
  );
}
