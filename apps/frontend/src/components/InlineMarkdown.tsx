import type { ReactNode } from 'react';

// INLINE MARKDOWN for ONE-LINE / short model text — an impact note, a finding's title, a story
// criterion. These used to print raw: "`review_threads`", "_⚠️ Potential issue_ —". The full
// `Markdown` renderer is a block (paragraphs, lists) and too heavy for a sentence inside a row.
//
// It understands only `code`, **strong** / __strong__ and *em* / _em_, and emits React TEXT
// nodes and three elements — never HTML, so nothing in the string can inject markup. Code spans
// wear the same `.md-body code` look as the Summary (index.css `.md-inline code`). Anything else passes through.

const TOKEN = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*|__[^_\n]+__)|(\*[^*\s][^*\n]*\*|(?<![\w])_[^_\s][^_\n]*_(?![\w]))/g;

export function inlineMarkdownNodes(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(TOKEN)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const [whole, code, strong] = m;
    if (code != null) out.push(<code key={i++}>{whole.slice(1, -1)}</code>);
    else if (strong != null) out.push(<strong key={i++} className="font-semibold">{whole.slice(2, -2)}</strong>);
    else out.push(<em key={i++}>{whole.slice(1, -1)}</em>);
    last = at + whole.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Inline markdown as a span (`md-inline`: the Summary's code-span look, no block type size). */
export function InlineMarkdown({ children, className }: { children: string; className?: string }): JSX.Element {
  return <span className={`md-inline${className ? ` ${className}` : ''}`}>{inlineMarkdownNodes(children)}</span>;
}
