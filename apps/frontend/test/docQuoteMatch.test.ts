// Finding a server-checked quote in the RENDERED section (lib/docQuoteMatch.ts), and the finding
// citation's borrowed quote (lib/docReferences.ts `borrowedQuote`). Segments stand in for the viewer's
// text nodes; `block` is the paragraph or table cell each sits in.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend docQuoteMatch
import { describe, expect, it } from 'vitest';
import { foldForQuote, foldRenderedText } from '@pierre-review/shared';
import { findQuoteRanges, type QuoteMatchRange, type QuoteTextSegment } from '../src/lib/docQuoteMatch.js';
import { borrowedQuote } from '../src/lib/docReferences.js';

const seg = (text: string, block: number): QuoteTextSegment => ({ text, block });

/** The highlighted text of each range, read back off the segments. */
function textOf(segments: readonly QuoteTextSegment[], ranges: readonly QuoteMatchRange[] | null): string[] | null {
  if (ranges == null) return null;
  return ranges.map((r) => {
    if (r.startSeg === r.endSeg) return segments[r.startSeg]!.text.slice(r.startOffset, r.endOffset);
    const parts = [segments[r.startSeg]!.text.slice(r.startOffset)];
    for (let i = r.startSeg + 1; i < r.endSeg; i += 1) parts.push(segments[i]!.text);
    parts.push(segments[r.endSeg]!.text.slice(0, r.endOffset));
    return parts.join('|');
  });
}

describe('findQuoteRanges', () => {
  it('finds a table-row quote across its cells', () => {
    const s = [seg('Priority', 0), seg('Weight', 1), seg('High (Formally identified in local strategy)', 2), seg('1.15', 3)];
    const r = findQuoteRanges(s, 'High (Formally identified in local strategy) | 1.15');
    expect(textOf(s, r)).toEqual(['High (Formally identified in local strategy)|1.15']);
  });

  it('highlights each piece of an ellipsis quote, in order', () => {
    const s = [seg('A partial refund needs a manager’s approval, and is never paid to a different card.', 0)];
    const r = findQuoteRanges(s, 'A partial refund … never paid to a different card');
    expect(textOf(s, r)).toEqual(['A partial refund', 'never paid to a different card']);
    expect(findQuoteRanges(s, 'never paid … A partial refund')).toBeNull();
  });

  it('folds typographic quotes, dashes and non-breaking spaces', () => {
    const s = [seg('The “grace period” — fourteen days', 0)];
    expect(textOf(s, findQuoteRanges(s, 'the "grace period" - fourteen days'))).toEqual(['The “grace period” — fourteen days']);
  });

  it('folds NFKC ligatures and decomposed accents', () => {
    const s = [seg('The ﬁnal Café rule applies', 0)];
    expect(textOf(s, findQuoteRanges(s, 'final Café rule'))).toEqual(['ﬁnal Café rule']);
  });

  it('matches across emphasis split into several text nodes, and markdown in the quote', () => {
    // `Refunds are paid **within fourteen days** of approval` renders as three text nodes in one <p>.
    const s = [seg('Refunds are paid ', 0), seg('within fourteen days', 0), seg(' of approval.', 0)];
    const r = findQuoteRanges(s, 'paid **within fourteen days** of approval');
    expect(textOf(s, r)).toEqual(['paid |within fourteen days| of approval']);
  });

  it('decodes entities a quote copied from the markdown source may carry', () => {
    const s = [seg('Terms & conditions apply to all refunds', 0)];
    expect(findQuoteRanges(s, 'Terms &amp; conditions apply')).not.toBeNull();
  });

  it('prefers the occurrence at or after the anchor heading, else the first in the body', () => {
    const s = [seg('Intro', 0), seg('Fees are waived for members.', 1), seg('Partial refunds', 2), seg('Fees are waived for members.', 3)];
    const anchored = findQuoteRanges(s, 'fees are waived for members', { preferFrom: 2 });
    expect(anchored?.[0]?.startSeg).toBe(3);
    const plain = findQuoteRanges(s, 'fees are waived for members');
    expect(plain?.[0]?.startSeg).toBe(1);
    // An anchor after the only occurrence falls back to the body.
    const late = findQuoteRanges(s.slice(0, 3), 'fees are waived for members', { preferFrom: 2 });
    expect(late?.[0]?.startSeg).toBe(1);
  });

  it('never matches in the server-written header', () => {
    const s = [seg('Refunds', 0), seg('Billing handbook › Payments', 1), seg('Something else entirely.', 2)];
    expect(findQuoteRanges(s, 'Billing handbook › Payments', { bodyFrom: 2 })).toBeNull();
  });

  it('is null when the words are gone, or the quote is empty', () => {
    const s = [seg('Refunds are paid within fourteen days.', 0)];
    expect(findQuoteRanges(s, 'paid within thirty days')).toBeNull();
    expect(findQuoteRanges(s, '…')).toBeNull();
    expect(findQuoteRanges([], 'anything at all here')).toBeNull();
  });

  it('a block boundary is a space, so words in two paragraphs do not run together', () => {
    const s = [seg('end of one', 0), seg('start of two', 1)];
    expect(findQuoteRanges(s, 'oneStart')).toBeNull();
    expect(textOf(s, findQuoteRanges(s, 'one start'))).toEqual(['one|start']);
  });
});

describe('the mapped fold agrees with the server fold on plain text', () => {
  it.each([
    'Refunds are paid within fourteen days.',
    '  A “quoted” — dash and   spaces ',
    'ﬁnal Café Café ÉCOLE',
    'snake_case and `code` and ~strike~',
    'Tabs\tand\nnewlines',
  ])('%s', (s) => {
    expect(foldRenderedText([{ text: s, block: 0 }]).folded).toBe(foldForQuote(s));
  });
});

describe('borrowedQuote', () => {
  const ref = (path: string, anchor: string | null, quote: string) => ({ path, anchor, quote });
  const c = { path: 'h/sections/01-a.md', anchor: null };

  it('borrows when exactly one reference names the section', () => {
    expect(borrowedQuote(c, [ref('h/sections/01-a.md', 'x', 'the one passage'), ref('h/sections/02-b.md', null, 'other')])).toBe('the one passage');
  });

  it('refuses when two references with different words match', () => {
    expect(borrowedQuote(c, [ref('h/sections/01-a.md', null, 'one'), ref('h/sections/01-a.md', null, 'two')])).toBeNull();
  });

  it('the same words cited twice are still one passage', () => {
    expect(borrowedQuote(c, [ref('h/sections/01-a.md', null, 'same'), ref('h/sections/01-a.md', 'x', 'same')])).toBe('same');
  });

  it('when both name an anchor, the anchors must agree', () => {
    const anchored = { path: 'h/sections/01-a.md', anchor: 'fees' };
    const refs = [ref('h/sections/01-a.md', 'fees', 'fee words'), ref('h/sections/01-a.md', 'refunds', 'refund words')];
    expect(borrowedQuote(anchored, refs)).toBe('fee words');
    expect(borrowedQuote({ path: 'h/sections/01-a.md', anchor: 'other' }, refs)).toBeNull();
  });

  it('no references, or none for this section: nothing', () => {
    expect(borrowedQuote(c, null)).toBeNull();
    expect(borrowedQuote(c, [ref('h/sections/09-z.md', null, 'x')])).toBeNull();
  });
});
