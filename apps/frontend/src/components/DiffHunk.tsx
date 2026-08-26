// Renders the unified-diff fragment GitHub returns in `diffHunk`. Prefix-based
// colouring for +/-/context lines; the @@ hunk header is dimmed.
type LineKind = 'add' | 'del' | 'meta' | 'ctx';

function classify(line: string): LineKind {
  if (line.startsWith('@@')) return 'meta';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  return 'ctx';
}

const LINE_STYLE: Record<LineKind, string> = {
  add: 'bg-green-500/10 text-green-700 dark:bg-green-500/15 dark:text-green-300',
  del: 'bg-red-500/10 text-red-700 dark:bg-red-500/15 dark:text-red-300',
  meta: 'bg-sky-500/5 text-sky-600 dark:bg-transparent dark:text-sky-400',
  ctx: 'text-gray-600 dark:text-gray-400',
};

export function DiffHunk({
  hunk,
  onCollapse,
}: {
  hunk: string | null;
  // Optional, because only the expanded-inline-comment call site can fold this
  // hunk away again. When supplied, the @@ header line becomes a second collapse
  // target next to whatever text control the caller renders — and ONLY that line:
  // clicking a code line to read or select it must never fold the hunk away.
  onCollapse?: () => void;
}): JSX.Element | null {
  if (!hunk) return null;
  const lines = hunk.replace(/\n$/, '').split('\n');
  // Gate on the first line REALLY being the @@ header. A truncated hunk starts on
  // real code, which has to stay plain, selectable text.
  const collapse =
    onCollapse != null && classify(lines[0] ?? '') === 'meta' ? onCollapse : null;
  return (
    <pre className="overflow-x-auto rounded-md border border-gray-200 bg-gray-50 text-[12px] leading-[1.45] dark:border-gray-800 dark:bg-gray-900">
      {/* w-max min-w-full so a row's tint (and the header's hover) spans the whole
          scrolled width, not just the visible content box. */}
      <code className="block w-max min-w-full font-mono">
        {lines.map((line, i) => {
          const kind = classify(line);
          if (i === 0 && collapse != null) {
            return (
              <button
                key={i}
                type="button"
                onClick={() => {
                  // A click that ENDED a drag-select is the reader copying the
                  // header, not asking to fold the hunk away.
                  if (window.getSelection()?.isCollapsed === false) return;
                  collapse();
                }}
                aria-expanded={true}
                aria-label="Hide code context"
                title="Hide code context"
                className={`block w-full whitespace-pre px-3 text-left hover:bg-sky-500/15 dark:hover:bg-sky-500/10 ${LINE_STYLE[kind]}`}
              >
                {line || ' '}
              </button>
            );
          }
          return (
            <span
              key={i}
              className={`block whitespace-pre px-3 ${LINE_STYLE[kind]}`}
            >
              {line || ' '}
            </span>
          );
        })}
      </code>
    </pre>
  );
}
