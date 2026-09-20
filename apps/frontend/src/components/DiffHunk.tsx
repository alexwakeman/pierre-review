import { useMemo } from 'react';
import {
  highlightDiffRows,
  parsePatch,
  splitDiffMarker,
  type DiffRowKind,
} from '../lib/diff.js';
import { languageForPath } from '../lib/hljsLines.js';

// Renders the unified-diff fragment GitHub returns in `diffHunk`. Prefix-based
// colouring for +/-/context lines; the @@ hunk header is dimmed. With a `path`
// the code itself is syntax-highlighted (`highlightDiffRows`, two passes over the
// reconstructed old and new sides); without one it renders plain, exactly as before.
type LineKind = 'add' | 'del' | 'meta' | 'ctx';

function classify(line: string): LineKind {
  if (line.startsWith('@@')) return 'meta';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  return 'ctx';
}

const ROW_KIND: Record<LineKind, DiffRowKind> = {
  add: 'add',
  del: 'del',
  meta: 'hunk',
  ctx: 'context',
};

// ⚠ BACKGROUND AND INK ARE SEPARATE BECAUSE ONLY ONE OF THEM SURVIVES HIGHLIGHTING. The tint is
// what says "added" / "removed", and it keeps saying it whatever the lexer does. The green/red
// TEXT colour says the same thing a second time, and on a highlighted row it fights the syntax
// colours for the same pixels — so it is dropped there (see `lineClass`). The `@@` header and
// context rows keep theirs: neither is an add/del claim, and both are deliberately quieter.
const LINE_BG: Record<LineKind, string> = {
  add: 'bg-green-500/10 dark:bg-green-500/15',
  del: 'bg-red-500/10 dark:bg-red-500/15',
  meta: 'bg-sky-500/5 dark:bg-transparent',
  ctx: '',
};
const LINE_INK: Record<LineKind, string> = {
  add: 'text-green-700 dark:text-green-300',
  del: 'text-red-700 dark:text-red-300',
  meta: 'text-sky-600 dark:text-sky-400',
  ctx: 'text-gray-600 dark:text-gray-400',
};

function lineClass(kind: LineKind, highlighted: boolean): string {
  const ink = highlighted && (kind === 'add' || kind === 'del') ? '' : LINE_INK[kind];
  return `${LINE_BG[kind]} ${ink}`;
}

/**
 * The highlighted HTML for each line of a hunk, index-aligned with its own `split('\n')`.
 *
 * `parsePatch` splits on exactly the same rule, so row `i` is line `i` — the length check is the
 * belt: if that ever stops being true, the whole hunk falls back to plain text rather than
 * shifting every colour by a row.
 *
 * Exported because three other one-line-from-a-hunk surfaces need the same thing — a thread's
 * `CodeAnchor` and the timeline's `MarkerPopover` each render `lines.at(-1)`, and ⚠ HIGHLIGHTING
 * THAT LINE ALONE IS THE FORBIDDEN THING (`hljsLines.ts`'s header): a lexer started mid-file has
 * no state, so a line inside a block comment or a template literal comes back coloured as code.
 * They highlight the WHOLE hunk through this hook and take the last entry.
 */
export function useHunkHighlight(
  hunk: string | null,
  path?: string | null,
): (string | null)[] | null {
  return useMemo(() => {
    if (!hunk || path == null || path === '') return null;
    const lineCount = hunk.replace(/\n$/, '').split('\n').length;
    const out = highlightDiffRows(parsePatch(hunk), languageForPath(path));
    return out != null && out.length === lineCount ? out : null;
  }, [hunk, path]);
}

/**
 * The +/-/space marker a raw hunk line carries, for printing plain beside its highlighted body.
 * ⚠ IT IS DIFF NOTATION, NOT CODE, and `highlightDiffRows` already stripped it before the lexer —
 * a `-` in front of a line is not a minus operator.
 */
export function hunkLineMarker(line: string): string {
  return splitDiffMarker({ kind: ROW_KIND[classify(line)], text: line }).marker;
}

export function DiffHunk({
  hunk,
  path,
  onCollapse,
}: {
  hunk: string | null;
  /** The file this hunk came from — the ONLY source of a language. Absent ⇒ no highlighting. */
  path?: string | null;
  // Optional, because only the expanded-inline-comment call site can fold this
  // hunk away again. When supplied, the @@ header line becomes a second collapse
  // target next to whatever text control the caller renders — and ONLY that line:
  // clicking a code line to read or select it must never fold the hunk away.
  onCollapse?: () => void;
}): JSX.Element | null {
  const html = useHunkHighlight(hunk, path);
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
          const code = html?.[i] ?? null;
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
                className={`block w-full whitespace-pre px-3 text-left hover:bg-sky-500/15 dark:hover:bg-sky-500/10 ${lineClass(kind, false)}`}
              >
                {line || ' '}
              </button>
            );
          }
          return (
            <span
              key={i}
              className={`block whitespace-pre px-3 ${lineClass(kind, code != null)}`}
            >
              {code != null ? (
                <>
                  {/* The marker prints plain — a reader copies these rows out as a diff.
                      ⚠ ONLY highlight.js OUTPUT REACHES `dangerouslySetInnerHTML`. */}
                  {hunkLineMarker(line)}
                  <span className="code-hl" dangerouslySetInnerHTML={{ __html: code }} />
                </>
              ) : (
                line || ' '
              )}
            </span>
          );
        })}
      </code>
    </pre>
  );
}
