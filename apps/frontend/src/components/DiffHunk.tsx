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

export function DiffHunk({ hunk }: { hunk: string | null }): JSX.Element | null {
  if (!hunk) return null;
  const lines = hunk.replace(/\n$/, '').split('\n');
  return (
    <pre className="overflow-x-auto rounded-md border border-gray-200 bg-gray-50 text-[12px] leading-[1.45] dark:border-gray-800 dark:bg-gray-900">
      <code className="block font-mono">
        {lines.map((line, i) => {
          const kind = classify(line);
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
