// THE QUOTE BESIDE A CHAT LINK (chat-quotes.ts): candidates from the answer's markdown, the server
// check that keeps only a quote the section really holds, and the defensive re-read of stored rows.
//
//   ./node_modules/.bin/vitest run src/reference-docs/chat-quotes.test.ts   (from apps/backend)
import { describe, expect, it } from 'vitest';
import { chatCitationsFromStored, foldForQuote, foldRenderedText, REVIEW_DOC_QUOTE_MAX_CHARS } from '@pierre-review/shared';
import { clipQuote, extractCitations, quoteCandidates, quotedSpans } from './chat-quotes.js';
import { renderSection } from './render.js';

const PATH = 'billing-handbook/sections/04-refunds.md';

const REFUNDS = renderSection({
  docTitle: 'Billing handbook',
  index: 3,
  total: 9,
  section: {
    title: 'Refunds',
    trail: ['Payments'],
    body: [
      '## Refunds',
      '',
      'Refunds are paid **within fourteen days** of the request being approved.',
      '',
      '### Partial refunds',
      '',
      'A partial refund needs a manager’s approval, and is never paid to a different card.',
      '',
      '| Kind | Days |',
      '| --- | --- |',
      '| Full | 14 |',
    ].join('\n'),
  },
  prevFile: '03-payments.md',
  nextFile: '05-invoices.md',
});

const DOCS = [
  {
    slug: 'billing-handbook',
    title: 'Billing handbook',
    builtAt: new Date(),
    sections: [{ path: PATH, title: 'Refunds', summary: '', depth: 2, trail: ['Payments'], headings: [], words: 40 }],
  },
] as unknown as Parameters<typeof extractCitations>[1];

const read = (p: string): string | null => (p === PATH ? REFUNDS : p === 'billing-handbook/CONTENTS.md' ? '# Billing handbook\n' : null);

const linkOf = (text: string, target: string): [number, number] => {
  const at = text.indexOf(`](${target}`);
  const start = text.lastIndexOf('[', at);
  return [start, text.indexOf(')', at) + 1];
};

describe('quotedSpans', () => {
  it('finds straight and curly quotes, in order, and stops at an unclosed one', () => {
    const t = 'say "one" and “two” then "never closed';
    expect(quotedSpans(t, 0, t.length).map((s) => s.text)).toEqual(['one', 'two']);
  });

  it('never pairs across a blank line', () => {
    const t = 'a "b\n\nc" d';
    expect(quotedSpans(t, 0, t.length)).toEqual([]);
  });
});

describe('quoteCandidates', () => {
  it('takes the italic quote on the link’s own line first', () => {
    const t = `Refunds take two weeks: *"paid within fourteen days"* ([Refunds](${PATH}#refunds)).`;
    const [s, e] = linkOf(t, PATH);
    expect(quoteCandidates(t, s, e)[0]).toBe('paid within fourteen days');
  });

  it('reads a blockquote just above the link', () => {
    const t = `> "A partial refund needs a manager’s approval"\n\nSee [Partial refunds](${PATH}#partial-refunds).`;
    const [s, e] = linkOf(t, PATH);
    expect(quoteCandidates(t, s, e)).toContain('A partial refund needs a manager’s approval');
  });

  it('orders the nearer quote first when a line has two', () => {
    const t = `"far away words here" then "near words here" [x](${PATH})`;
    const [s, e] = linkOf(t, PATH);
    expect(quoteCandidates(t, s, e).slice(0, 2)).toEqual(['near words here', 'far away words here']);
  });
});

describe('extractCitations', () => {
  it('stores a quote the section really holds', () => {
    const t = `They are paid *"within fourteen days of the request"* ([Refunds](${PATH}#refunds)).`;
    const [c] = extractCitations(t, DOCS, read);
    expect(c).toMatchObject({ path: PATH, anchor: 'refunds', quote: 'within fourteen days of the request' });
  });

  it('drops a quote the section does not hold (anchor only)', () => {
    const t = `They are paid *"within thirty working days of the request"* ([Refunds](${PATH}#refunds)).`;
    const [c] = extractCitations(t, DOCS, read);
    expect(c?.path).toBe(PATH);
    expect(c && 'quote' in c).toBe(false);
  });

  it('never verifies a quote against the server-written header', () => {
    const t = `"Billing handbook › Payments" ([Refunds](${PATH}))`;
    const [c] = extractCitations(t, DOCS, read);
    expect(c?.quote).toBeUndefined();
  });

  it('a quote too short to mean anything is dropped', () => {
    const t = `"Refunds" ([Refunds](${PATH}))`;
    expect(extractCitations(t, DOCS, read)[0]?.quote).toBeUndefined();
  });

  it('a later link to the same place fills in the quote; the first verified one wins', () => {
    const t = [
      `See [Refunds](${PATH}#refunds).`,
      '',
      `"A partial refund needs a manager's approval" ([Refunds](${PATH}#refunds))`,
      '',
      `"is never paid to a different card" ([Refunds](${PATH}#refunds))`,
    ].join('\n');
    const out = extractCitations(t, DOCS, read);
    expect(out).toHaveLength(1);
    expect(out[0]?.quote).toBe("A partial refund needs a manager's approval");
  });

  it('an ellipsis skips words, the pieces in order', () => {
    const t = `*"A partial refund … never paid to a different card"* ([Refunds](${PATH}))`;
    expect(extractCitations(t, DOCS, read)[0]?.quote).toBe('A partial refund … never paid to a different card');
    const backwards = `*"never paid to a different card … A partial refund"* ([Refunds](${PATH}))`;
    expect(extractCitations(backwards, DOCS, read)[0]?.quote).toBeUndefined();
  });

  it('a CONTENTS link carries no quote, and an unknown path is no citation', () => {
    const t = `"within fourteen days of the request" [c](billing-handbook/CONTENTS.md) [x](billing-handbook/sections/09-nope.md)`;
    const out = extractCitations(t, DOCS, read);
    expect(out.map((c) => c.path)).toEqual(['billing-handbook/CONTENTS.md']);
    expect(out[0]?.quote).toBeUndefined();
  });
});

describe('clipQuote', () => {
  it('collapses whitespace, strips controls and caps the length', () => {
    expect(clipQuote(' a\n\tb\u0007c ')).toBe('a bc');
    const long = clipQuote('x'.repeat(REVIEW_DOC_QUOTE_MAX_CHARS + 50));
    expect(long.length).toBe(REVIEW_DOC_QUOTE_MAX_CHARS);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('chatCitationsFromStored', () => {
  it('reads an old row with no quote, keeps a short quote, drops junk', () => {
    const out = chatCitationsFromStored([
      { path: PATH, anchor: null, docSlug: 'billing-handbook', docTitle: 'Billing handbook', sectionTitle: 'Refunds' },
      { path: PATH, anchor: 'refunds', docSlug: 'billing-handbook', docTitle: 'Billing handbook', sectionTitle: null, quote: 'paid within fourteen days' },
      { path: PATH, anchor: null, docSlug: 'billing-handbook', docTitle: 'B', sectionTitle: null, quote: 'q'.repeat(REVIEW_DOC_QUOTE_MAX_CHARS + 1) },
      { path: 3 },
      'nope',
    ]);
    expect(out).toHaveLength(3);
    expect(out[0]!.quote).toBeUndefined();
    expect(out[1]!.quote).toBe('paid within fourteen days');
    expect(out[2]!.quote).toBeUndefined();
    expect(chatCitationsFromStored(null)).toEqual([]);
  });
});

describe('the shared fold', () => {
  it('the rendered-text fold agrees with the server fold on plain text', () => {
    for (const s of ['Refunds are paid within fourteen days.', '  A “quoted” — dash and  spaces ', 'ﬁnal Café É Cafe\u0301', 'snake_case and `code`']) {
      expect(foldRenderedText([{ text: s, block: 0 }]).folded).toBe(foldForQuote(s));
    }
  });
});
