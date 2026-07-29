import type { ReactNode } from 'react';

// Escape a string for safe use inside a RegExp (each search term is user input).
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Wrap every case-insensitive occurrence of any whitespace-separated query term in `text`
// with a <mark>. Returns the original text unchanged when the query has no usable terms, so
// callers can render the result directly. Terms are regex-escaped, so a query like "foo(bar)"
// highlights literally rather than throwing.
export function highlightTerms(text: string, query: string): ReactNode {
  const terms = query.trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0 || text === '') return text;

  const pattern = new RegExp(`(${terms.map(escapeRegExp).join('|')})`, 'gi');
  const parts = text.split(pattern);
  if (parts.length === 1) return text; // no match — avoid needless spans

  // String.split with a capturing group yields [between, match, between, match, …], so the
  // odd indices are exactly the captured matches (terms are non-empty, so no empty captures).
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      // The UA sheet gives <mark> a hardcoded `color: black` (the HTML rendering spec mandates
      // it — it is not `inherit`), and Tailwind's preflight has no `mark` rule to reset it. So
      // the surrounding `dark:text-gray-100` never reaches this element and the foreground MUST
      // be set explicitly: dark mode was rendering black on a dark-amber wash at ~1.9:1.
      <mark
        key={i}
        className="rounded bg-yellow-200 px-0.5 text-gray-900 dark:bg-yellow-400/30 dark:text-yellow-100"
      >
        {part}
      </mark>
    ) : (
      part
    ),
  );
}
