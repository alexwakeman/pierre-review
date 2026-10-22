// THE QUOTE FOLD (docs/REFERENCE-DOCS.md § Use in reviews, § The SPA → highlighting a quote). ONE
// place decides what "this quote is in this section" means, for BOTH halves:
//
//   • the SERVER checks a quote against a section's raw MARKDOWN before a reference, a story-docs
//     point or a chat citation is stored (`foldForQuote` + `quoteAppearsIn`);
//   • the SPA finds the same quote in the RENDERED section to highlight it (`foldRenderedText`, the
//     mapped twin, read by apps/frontend/src/lib/docQuoteMatch.ts).
//
// ⚠ The two folds must agree on PLAIN text (a frontend test pins `foldRenderedText(x).folded ===
// foldForQuote(x)` over samples). The markdown-syntax steps (link targets, escapes, list and quote
// markers) exist only in `foldForQuote`: rendered text has none of that syntax left. Change a
// character rule in one and you must change it in the other, or a passage the server checked stops
// highlighting.
//
// ⚠ `foldRenderedText` walks characters (no RegExp over the document's text), so a hostile page cannot
// make it backtrack.

/** Fold the text a quote is compared on: emphasis, escapes, link targets, typography, whitespace. */
export function foldForQuote(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, '$1')
    .replace(/[*_`~]/g, '')
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/ /g, ' ')
    .replace(/^\s*(?:[>|]|[-+]\s|\d+[.)]\s)+/gm, ' ')
    .replace(/\s*\|\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** A quote's pieces, folded: "…" / "..." skips words, so each piece is found in order. */
export function quotePieces(quote: string): string[] {
  return quote
    .split(/…|\.{3,}/)
    .map(foldForQuote)
    .filter((p) => p !== '');
}

/** Does `quote` appear in `body`? "…" / "..." in the quote skips words (the pieces must be in order). */
export function quoteAppearsIn(body: string, quote: string): boolean {
  return quoteAppearsInFolded(foldForQuote(body), quote);
}

/** `quoteAppearsIn` over a body already folded with `foldForQuote` (fold once, check many quotes). */
export function quoteAppearsInFolded(hay: string, quote: string): boolean {
  const pieces = quotePieces(quote);
  if (pieces.length === 0) return false;
  let from = 0;
  for (const p of pieces) {
    const at = hay.indexOf(p, from);
    if (at < 0) return false;
    from = at + p.length;
  }
  return true;
}

// ---- the mapped fold, for RENDERED text ----

/** One run of rendered text (a DOM text node), and the block or table cell it sits in. */
export interface QuoteTextSegment {
  text: string;
  /** Two segments in different blocks get a space between them (a table row's cells, two paragraphs). */
  block: number;
}

/** A folded character's source: which segment, and its [start, end) offsets there. -1 = a boundary space. */
export interface FoldedRendered {
  folded: string;
  seg: Int32Array;
  start: Int32Array;
  end: Int32Array;
}

const DROPPED = new Set(['*', '_', '`', '~']);

function foldChar(c: string): string {
  if (DROPPED.has(c)) return '';
  switch (c) {
    case '‘':
    case '’':
    case '‛':
    case '′':
      return "'";
    case '“':
    case '”':
    case '‟':
    case '″':
      return '"';
    case ' ':
    case '|':
      return ' ';
  }
  const code = c.codePointAt(0)!;
  if ((code >= 0x2010 && code <= 0x2015) || code === 0x2212) return '-';
  if (c.trim() === '') return ' ';
  return c.toLowerCase();
}

function isMark(code: number): boolean {
  // Combining marks (the common blocks): kept with the character before them, so NFKC composes them.
  return (
    (code >= 0x0300 && code <= 0x036f) ||
    (code >= 0x1ab0 && code <= 0x1aff) ||
    (code >= 0x1dc0 && code <= 0x1dff) ||
    (code >= 0x20d0 && code <= 0x20ff) ||
    (code >= 0xfe20 && code <= 0xfe2f)
  );
}

/**
 * Fold rendered text segments the way `foldForQuote` folds plain text, keeping, for every folded
 * character, where it came from. Linear: one pass over the characters.
 */
export function foldRenderedText(segments: readonly QuoteTextSegment[]): FoldedRendered {
  const out: string[] = [];
  const seg: number[] = [];
  const start: number[] = [];
  const end: number[] = [];
  let lastSpace = true; // nothing yet: a leading space is trimmed
  const push = (ch: string, si: number, a: number, b: number): void => {
    if (ch === ' ') {
      if (lastSpace) return;
      lastSpace = true;
    } else lastSpace = false;
    out.push(ch);
    seg.push(si);
    start.push(a);
    end.push(b);
  };
  let prevBlock: number | null = null;
  segments.forEach((s, si) => {
    if (prevBlock != null && s.block !== prevBlock) push(' ', -1, -1, -1);
    prevBlock = s.block;
    const t = s.text;
    let i = 0;
    while (i < t.length) {
      const a = i;
      i += t.codePointAt(i)! > 0xffff ? 2 : 1;
      while (i < t.length && isMark(t.charCodeAt(i))) i += 1;
      const unit = t.slice(a, i).normalize('NFKC');
      for (const c of unit) {
        const f = foldChar(c);
        for (const fc of f) push(fc, si, a, i);
      }
    }
  });
  // A trailing space is trimmed too.
  if (out.length > 0 && out[out.length - 1] === ' ') {
    out.pop();
    seg.pop();
    start.pop();
    end.pop();
  }
  return { folded: out.join(''), seg: Int32Array.from(seg), start: Int32Array.from(start), end: Int32Array.from(end) };
}
