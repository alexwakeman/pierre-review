import { foldRenderedText, quotePieces, REVIEW_DOC_QUOTE_MAX_CHARS, type QuoteTextSegment } from '@pierre-review/shared';

// FIND A CHECKED QUOTE IN THE RENDERED SECTION (docs/REFERENCE-DOCS.md § The SPA → the quote
// highlight). The pure half: no DOM, so the unit test feeds it text segments directly. The viewer
// (Activity/DocsViewer.tsx) walks its own box's text nodes into segments, calls this, and paints the
// ranges with the CSS Custom Highlight API — it never changes the DOM React owns.
//
// ⚠ ONE FOLD. The quote is folded by the SAME `foldForQuote` the server checked it with
// (`quotePieces`), and the rendered text by its mapped twin `foldRenderedText` (both in shared
// reference-docs-quote.ts). A table-row quote ("High | 1.15") matches across cells because every
// block or cell boundary in the rendered text folds to one space, and `|` folds to a space too.
//
// ⚠ No RegExp runs over the document's text: the fold is a character walk and the search is indexOf.

export type { QuoteTextSegment };

/** One highlighted run: from (segment, offset) to (segment, offset), end exclusive. */
export interface QuoteMatchRange {
  startSeg: number;
  startOffset: number;
  endSeg: number;
  endOffset: number;
}

export interface QuoteMatchOptions {
  /** The first segment at or after the link's anchor heading: an occurrence from here wins. */
  preferFrom?: number | null;
  /** The first segment of the section's own text (the server-written header is never matched). */
  bodyFrom?: number;
}

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };

/** A quote as the server stored it (markdown source words), ready to fold: entities decoded, capped. */
export function prepareQuote(quote: string): string {
  let q = quote.length > REVIEW_DOC_QUOTE_MAX_CHARS + 10 ? quote.slice(0, REVIEW_DOC_QUOTE_MAX_CHARS + 10) : quote;
  for (const [e, c] of Object.entries(ENTITIES)) q = q.split(e).join(c);
  return q;
}

/**
 * The ranges of `quote` in the rendered `segments` — one per piece ("…" skips words), in order — or
 * null when the quote is not there. The search starts at the anchor heading when given (falling back
 * to the whole body), and never in the header before `bodyFrom`.
 */
export function findQuoteRanges(
  segments: readonly QuoteTextSegment[],
  quote: string,
  opts: QuoteMatchOptions = {},
): QuoteMatchRange[] | null {
  const pieces = quotePieces(prepareQuote(quote));
  if (pieces.length === 0 || segments.length === 0) return null;
  const f = foldRenderedText(segments);
  const n = f.folded.length;

  // The folded position where segment `si` starts (the first folded char from it or a later one).
  const foldedAt = (si: number): number => {
    for (let k = 0; k < n; k += 1) if (f.seg[k]! >= si) return k;
    return n;
  };

  const tryFrom = (from: number): QuoteMatchRange[] | null => {
    const out: QuoteMatchRange[] = [];
    let pos = from;
    for (const p of pieces) {
      const at = f.folded.indexOf(p, pos);
      if (at < 0) return null;
      let a = at;
      while (a < at + p.length && f.seg[a]! < 0) a += 1;
      let b = at + p.length - 1;
      while (b > a && f.seg[b]! < 0) b -= 1;
      out.push({ startSeg: f.seg[a]!, startOffset: f.start[a]!, endSeg: f.seg[b]!, endOffset: f.end[b]! });
      pos = at + p.length;
    }
    return out;
  };

  const body = foldedAt(Math.max(0, opts.bodyFrom ?? 0));
  if (opts.preferFrom != null) {
    const preferred = tryFrom(Math.max(body, foldedAt(opts.preferFrom)));
    if (preferred != null) return preferred;
  }
  return tryFrom(body);
}
