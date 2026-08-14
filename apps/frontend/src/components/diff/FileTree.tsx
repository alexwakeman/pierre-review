import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { FileTreeNode } from '../../lib/diff.js';
import { isLockFile } from '../../lib/diff.js';
import { STATUS_META } from './status.js';

// The Changes tab's navigation rail: the PR's CHANGED FILES ONLY, arranged in their real
// project directory hierarchy so you can see where each file sits. Clicking a file reveals it
// in the diff panel (the caller turns that into a `DiffFocusTarget`).
//
// Styling is the house left-rail idiom (Activity/index.tsx): `border-l-2` rows with a sky
// selected state, `aria-pressed`, plain-text carets, and a `dark:` twin on every colour.
// Indentation is an inline `paddingLeft` because Tailwind has no dynamic `pl-` class.

const INDENT_PX = 10;
const BASE_PAD_PX = 6;
// Breathing room above/below the revealed row so it never lands flush against the rail's edge.
const REVEAL_MARGIN_PX = 12;

/**
 * The nearest ancestor that actually scrolls. The rail is a `max-h-[70vh] overflow-y-auto`
 * box declared in ChangesTab, so this walks up to find it rather than assuming
 * `parentElement` — the tree renders a `note` above the rows and the wrapper is not ours.
 */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p != null; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight) return p;
  }
  return null;
}


function Counts({ additions, deletions }: { additions: number; deletions: number }): JSX.Element {
  return (
    <span className="shrink-0 font-mono text-[10px] tabular-nums">
      <span className="text-green-600 dark:text-green-400">+{additions}</span>{' '}
      <span className="text-red-500 dark:text-red-400">−{deletions}</span>
    </span>
  );
}

function TreeRow({
  node,
  depth,
  collapsed,
  onToggleDir,
  selectedPath,
  onSelectFile,
  selectedRef,
}: {
  node: FileTreeNode;
  depth: number;
  collapsed: ReadonlySet<string>;
  onToggleDir: (path: string) => void;
  selectedPath: string | null;
  onSelectFile: (path: string) => void;
  // Attached to whichever file row is selected, so the rail can scroll it into view. Only one
  // row ever claims it — a path is unique in the tree.
  selectedRef: RefObject<HTMLButtonElement>;
}): JSX.Element {
  const pad = { paddingLeft: BASE_PAD_PX + depth * INDENT_PX };

  if (node.kind === 'dir') {
    const open = !collapsed.has(node.path);
    return (
      <>
        <button
          type="button"
          onClick={() => onToggleDir(node.path)}
          aria-expanded={open}
          style={pad}
          className="flex w-full items-center gap-1.5 rounded border-l-2 border-transparent py-0.5 pr-2 text-left text-xs hover:bg-gray-50 dark:hover:bg-gray-800/50"
          title={`${node.path} — ${node.fileCount} file${node.fileCount === 1 ? '' : 's'}`}
        >
          <span className="w-3 shrink-0 select-none text-gray-400">{open ? '▾' : '▸'}</span>
          <span className="min-w-0 flex-1 truncate font-mono text-gray-500 dark:text-gray-400">
            {node.name}/
          </span>
          <Counts additions={node.additions} deletions={node.deletions} />
        </button>
        {open &&
          node.children.map((child) => (
            <TreeRow
              key={child.path}
              node={child}
              depth={depth + 1}
              collapsed={collapsed}
              onToggleDir={onToggleDir}
              selectedPath={selectedPath}
              onSelectFile={onSelectFile}
              selectedRef={selectedRef}
            />
          ))}
      </>
    );
  }

  const selected = selectedPath === node.path;
  const status = node.entry?.status;
  const meta = status ? STATUS_META[status] : null;
  // Lock files are dependency noise and ALWAYS start collapsed in the diff — dim them here so
  // the rail reads the same way (a click still reveals and expands them).
  const noise = isLockFile(node.path);

  return (
    <button
      type="button"
      ref={selected ? selectedRef : undefined}
      onClick={() => onSelectFile(node.path)}
      aria-pressed={selected}
      style={pad}
      className={`flex w-full items-center gap-1.5 rounded border-l-2 py-0.5 pr-2 text-left text-xs ${
        selected
          ? 'border-sky-500 bg-sky-50 dark:bg-sky-950/30'
          : 'border-transparent hover:bg-gray-50 dark:hover:bg-gray-800/50'
      } ${noise && !selected ? 'opacity-60' : ''}`}
      title={
        node.entry?.previousPath
          ? `${node.entry.previousPath} → ${node.path}`
          : node.path
      }
    >
      <span
        className={`w-3 shrink-0 select-none text-center font-mono font-bold ${
          meta ? meta.cls : 'text-gray-400'
        }`}
        title={meta?.label}
      >
        {meta ? meta.icon : '·'}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono">{node.name}</span>
      <Counts additions={node.additions} deletions={node.deletions} />
    </button>
  );
}

export function FileTree({
  nodes,
  selectedPath,
  onSelectFile,
  note,
  revealNonce,
  railHeight,
}: {
  nodes: FileTreeNode[];
  // The file currently revealed in the diff panel (null = none).
  selectedPath: string | null;
  onSelectFile: (path: string) => void;
  // Bumped by the caller every time a reveal is REQUESTED, including a repeat of the path
  // already selected. Without it, re-clicking the same Claude Review finding after scrolling
  // the rail away would leave the row off-screen: `selectedPath` did not change, so nothing
  // would re-fire. Same reason `DiffFocusTarget` carries a nonce.
  revealNonce?: number;
  // The rail's measured max height. Included in the reveal's dependencies because the rail is
  // sized by an effect in the caller that necessarily runs AFTER this component's first
  // layout effect: the reveal would otherwise compute a scroll against the pre-measure
  // geometry and be left pointing at the wrong row the instant the rail resizes. Observed
  // exactly that — the row ended up 177px BELOW the resized box.
  railHeight?: number | null;
  // Rendered at the top of the rail — used for the "Showing 100 of N" truncation
  // disclosure, which belongs INSIDE the tree: a tree implies a completeness a scrolling
  // list does not.
  note?: JSX.Element | null;
}): JSX.Element {
  // Directory collapse is EPHEMERAL local state, deliberately not the global
  // expandedFileGroups/collapsedFileGroups slice: those are unkeyed by PR, and directory
  // paths collide across repos far more than file paths do. Default: everything open.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set<string>());
  const toggleDir = (path: string): void => {
    setCollapsed((cur) => {
      const next = new Set(cur);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const selectedRef = useRef<HTMLButtonElement>(null);

  // STEP 1 — a revealed file inside a directory the user collapsed has no row to scroll to at
  // all. Re-open its ancestors first. Prefix matching rather than walking the tree: chain
  // collapsing means a dir node's `path` may be `src/api/routes` in one row, so any collapsed
  // entry that is a proper path prefix of the target is an ancestor of it.
  useEffect(() => {
    if (selectedPath == null) return;
    setCollapsed((cur) => {
      const stale = [...cur].filter((d) => selectedPath.startsWith(`${d}/`));
      if (stale.length === 0) return cur; // identity preserved — no re-render
      const next = new Set(cur);
      for (const d of stale) next.delete(d);
      return next;
    });
  }, [selectedPath, revealNonce]);

  // STEP 2 — scroll the row into view inside the RAIL, and only the rail. `scrollIntoView`
  // would also scroll every ancestor, including PrDetail's main scroll container, which
  // FileDiffView is concurrently driving to the same file — the two fight and the diff pane
  // lands in the wrong place. Adjusting `scrollTop` by hand touches nothing else.
  // Runs after the expansion above has rendered, hence the dependency on `collapsed`.
  useLayoutEffect(() => {
    const row = selectedRef.current;
    if (selectedPath == null || row == null) return;
    const box = scrollParent(row);
    if (box == null) return; // rail is short enough to show everything
    const r = row.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    // The target is the rail ∩ WINDOW, not the rail's own box. The rail is `sticky top-0
    // max-h-[70vh]` inside PrDetail's pane, which in a bottom-split layout is routinely
    // shorter than 70vh — so the rail's lower half can sit below the fold. Scrolling a row to
    // the middle of the BOX then leaves it perfectly "visible" by every measurement and still
    // off-screen for the user. Measured: rail 810→1661 in a 1215px window.
    const viewTop = Math.max(b.top, 0);
    const viewBottom = Math.min(b.bottom, window.innerHeight);
    const viewH = viewBottom - viewTop;
    if (viewH <= 0) return; // rail scrolled out of the pane entirely
    // Already on screen (the common case — the user clicked the row itself): leave the rail
    // exactly where it is. Scrolling a row that is already visible is pure jitter.
    if (r.top >= viewTop + REVEAL_MARGIN_PX && r.bottom <= viewBottom - REVEAL_MARGIN_PX) return;
    // Out of view means we ARRIVED here from somewhere else — a Claude Review finding, most
    // likely. Rest the row a third of the way down rather than nudging it just inside the
    // edge: minimal scrolling leaves the thing you navigated to flush against the boundary
    // with no surrounding context, which reads as "barely made it" rather than "here it is".
    box.scrollTop += r.top - viewTop - viewH * 0.3;
  }, [selectedPath, revealNonce, collapsed, railHeight]);

  return (
    <nav aria-label="Changed files" className="py-1">
      {note}
      {nodes.map((node) => (
        <TreeRow
          key={node.path}
          node={node}
          depth={0}
          collapsed={collapsed}
          onToggleDir={toggleDir}
          selectedPath={selectedPath}
          onSelectFile={onSelectFile}
          selectedRef={selectedRef}
        />
      ))}
    </nav>
  );
}
