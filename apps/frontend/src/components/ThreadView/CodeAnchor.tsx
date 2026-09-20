import { useFilters } from '../../store/filters.js';
import { DiffHunk, hunkLineMarker, useHunkHighlight } from '../DiffHunk.js';
import { ChevronIcon } from '../Icons.js';

type LineKind = 'add' | 'del' | 'ctx';

function classify(line: string): LineKind {
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  return 'ctx';
}

// ⚠ THE BORDER CARRIES ADD/DEL; THE TEXT COLOUR ONLY DOES SO WHEN THE CODE IS NOT HIGHLIGHTED.
// On a highlighted line the green/red ink and the syntax colours fight over the same characters,
// and the 2px border already says which side the anchor is on. Split so one can be dropped.
const BORDER: Record<LineKind, string> = {
  add: 'border-green-500',
  del: 'border-red-500',
  ctx: 'border-gray-400',
};
const INK: Record<LineKind, string> = {
  add: 'text-green-600 dark:text-green-300',
  del: 'text-red-600 dark:text-red-300',
  ctx: 'text-gray-600 dark:text-gray-300',
};

// The single line a thread is anchored to, with the full surrounding hunk
// available behind "Show full code context". Mirrors how you'd quote the code
// you're replying to in an email thread.
export function CodeAnchor({
  diffHunk,
  path,
  threadId,
}: {
  diffHunk: string | null;
  /** The thread's file — the only source of a language. Absent ⇒ the anchor renders plain. */
  path?: string | null;
  threadId: number;
}): JSX.Element | null {
  const expanded = useFilters((s) => s.expandedDiffHunks.includes(threadId));
  const toggle = useFilters((s) => s.toggleDiffHunk);
  // ⚠ THE WHOLE HUNK IS HIGHLIGHTED AND THE LAST ENTRY TAKEN, never the anchor line on its own.
  // A lexer started at one line has no state: a line inside a block comment or a template literal
  // comes back coloured as ordinary code. Hooks run before the early returns below.
  const html = useHunkHighlight(diffHunk, path);
  if (!diffHunk) return null;

  const lines = diffHunk.replace(/\n$/, '').split('\n');
  const anchorLine = lines.at(-1) ?? '';
  const kind = classify(anchorLine);
  const anchorHtml = html?.at(-1) ?? null;

  if (expanded) {
    return (
      <div className="space-y-1">
        <DiffHunk hunk={diffHunk} path={path} onCollapse={() => toggle(threadId)} />
        <button
          type="button"
          onClick={() => toggle(threadId)}
          aria-expanded={true}
          className="inline-flex items-center gap-1 text-[11px] text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
        >
          <ChevronIcon dir="up" size={11} />
          Hide code context
        </button>
      </div>
    );
  }

  // The anchor line itself: marker printed plain, body coloured. ⚠ ONLY highlight.js OUTPUT
  // REACHES `dangerouslySetInnerHTML`; the else-branch is React's normal text rendering.
  const body =
    anchorHtml != null ? (
      <>
        {hunkLineMarker(anchorLine)}
        <span className="code-hl" dangerouslySetInnerHTML={{ __html: anchorHtml }} />
      </>
    ) : (
      anchorLine || ' '
    );
  const ink = anchorHtml != null && kind !== 'ctx' ? '' : INK[kind];

  // Single-line hunk: the anchor IS the whole context, nothing to expand.
  if (lines.length <= 1) {
    return (
      <pre
        className={`overflow-x-auto border-l-2 bg-gray-50 py-0.5 pl-2 font-mono text-[12px] leading-snug dark:bg-gray-900/60 ${BORDER[kind]} ${ink}`}
      >
        {body}
      </pre>
    );
  }

  // Collapsed, multi-line: the whole anchor preview is clickable to expand (mirrors
  // the Claude-review finding hunk). Once open, only the @@ header line and "Hide
  // code context" collapse it again — the code lines never do, so clicking the
  // expanded code to read/select it can't fold it away.
  return (
    <button
      type="button"
      onClick={() => toggle(threadId)}
      aria-expanded={false}
      title="Show the full code context"
      className={`flex w-full items-center gap-2 overflow-hidden rounded-r border-l-2 bg-gray-50 py-0.5 pl-2 pr-2 text-left font-mono text-[12px] leading-snug hover:bg-gray-100 dark:bg-gray-900/60 dark:hover:bg-gray-800/60 ${BORDER[kind]} ${ink}`}
    >
      <span className="min-w-0 flex-1 truncate">{body}</span>
      <span className="inline-flex shrink-0 items-center gap-1 font-sans text-[10px] text-gray-400">
        <ChevronIcon dir="down" size={10} />
        {lines.length} lines
      </span>
    </button>
  );
}
