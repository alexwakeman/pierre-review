import { useFilters } from '../../store/filters.js';
import { DiffHunk } from '../DiffHunk.js';

type LineKind = 'add' | 'del' | 'ctx';

function classify(line: string): LineKind {
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  return 'ctx';
}

const BORDER: Record<LineKind, string> = {
  add: 'border-green-500 text-green-600 dark:text-green-300',
  del: 'border-red-500 text-red-600 dark:text-red-300',
  ctx: 'border-gray-400 text-gray-600 dark:text-gray-300',
};

// The single line a thread is anchored to, with the full surrounding hunk
// available behind "Show full code context". Mirrors how you'd quote the code
// you're replying to in an email thread.
export function CodeAnchor({
  diffHunk,
  threadId,
}: {
  diffHunk: string | null;
  threadId: number;
}): JSX.Element | null {
  const expanded = useFilters((s) => s.expandedDiffHunks.includes(threadId));
  const toggle = useFilters((s) => s.toggleDiffHunk);
  if (!diffHunk) return null;

  const lines = diffHunk.replace(/\n$/, '').split('\n');
  const anchorLine = lines.at(-1) ?? '';
  const kind = classify(anchorLine);

  if (expanded) {
    return (
      <div className="space-y-1">
        <DiffHunk hunk={diffHunk} />
        <button
          type="button"
          onClick={() => toggle(threadId)}
          className="text-[11px] text-gray-400 hover:text-gray-600"
        >
          ⌃ Hide code context
        </button>
      </div>
    );
  }

  // Single-line hunk: the anchor IS the whole context, nothing to expand.
  if (lines.length <= 1) {
    return (
      <pre
        className={`overflow-x-auto border-l-2 bg-gray-50 py-0.5 pl-2 font-mono text-[12px] leading-snug dark:bg-gray-900/60 ${BORDER[kind]}`}
      >
        {anchorLine || ' '}
      </pre>
    );
  }

  // Collapsed, multi-line: the whole anchor preview is clickable to expand (mirrors
  // the Claude-review finding hunk) — only "Hide code context" collapses it again,
  // so clicking the expanded code to read/select it never folds it away.
  return (
    <button
      type="button"
      onClick={() => toggle(threadId)}
      title="Show the full code context"
      className={`flex w-full items-center gap-2 overflow-hidden rounded-r border-l-2 bg-gray-50 py-0.5 pl-2 pr-2 text-left font-mono text-[12px] leading-snug hover:bg-gray-100 dark:bg-gray-900/60 dark:hover:bg-gray-800/60 ${BORDER[kind]}`}
    >
      <span className="min-w-0 flex-1 truncate">{anchorLine || ' '}</span>
      <span className="shrink-0 font-sans text-[10px] text-gray-400">
        ⌄ {lines.length} lines
      </span>
    </button>
  );
}
