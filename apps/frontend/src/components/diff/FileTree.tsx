import { useState } from 'react';
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
}: {
  node: FileTreeNode;
  depth: number;
  collapsed: ReadonlySet<string>;
  onToggleDir: (path: string) => void;
  selectedPath: string | null;
  onSelectFile: (path: string) => void;
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
}: {
  nodes: FileTreeNode[];
  // The file currently revealed in the diff panel (null = none).
  selectedPath: string | null;
  onSelectFile: (path: string) => void;
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
        />
      ))}
    </nav>
  );
}
