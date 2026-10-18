// THE LIBRARY IN REVIEWS — the shared validator, prompt block and tool fields (review-refs.ts), plus
// the "switch off ⇒ nothing changes" guarantee for the two review runs that use it.
//
//   ./node_modules/.bin/vitest run src/reference-docs/review-refs.test.ts   (from apps/backend)
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { REVIEW_DOC_QUOTE_MAX_CHARS } from '@pierre-review/shared';
import { renderSection } from './render.js';
import {
  buildDocReferencesField,
  docsReviewPromptBlock,
  foldForQuote,
  libraryRelativeLink,
  quoteAppearsIn,
  sectionBodyOf,
  validateDocCitations,
  validateDocReferences,
  type LibrarySnapshot,
} from './review-refs.js';
import { parseLibraryPath } from './paths.js';

let dir = '';
let lib: LibrarySnapshot;

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

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'review-refs-'));
  mkdirSync(join(dir, 'billing-handbook', 'sections'), { recursive: true });
  writeFileSync(join(dir, 'INDEX.md'), '# Reference library\n');
  writeFileSync(join(dir, 'billing-handbook', 'CONTENTS.md'), '# Billing handbook\n\nRefunds are paid within fourteen days.\n');
  writeFileSync(join(dir, 'billing-handbook', 'sections', '04-refunds.md'), REFUNDS);
  const files = new Map<string, string>([
    ['INDEX.md', '# Reference library\n'],
    ['billing-handbook/CONTENTS.md', '# Billing handbook\n\nRefunds are paid within fourteen days.\n'],
    ['billing-handbook/sections/04-refunds.md', REFUNDS],
  ]);
  lib = {
    workspaceId: 7,
    dir,
    docs: [
      {
        slug: 'billing-handbook',
        title: 'Billing handbook',
        sections: [
          { path: 'billing-handbook/sections/04-refunds.md', title: 'Refunds', summary: '', depth: 2, trail: ['Payments'], headings: [], words: 40 },
        ],
      },
    ],
    // The real reader holds paths to the strict grammar; the fake does the same.
    read: (p) => (parseLibraryPath(p) != null ? (files.get(p) ?? null) : null),
  };
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const ref = (over: Record<string, unknown>) => ({
  link: 'billing-handbook/sections/04-refunds.md#partial-refunds',
  quote: 'A partial refund needs a manager’s approval',
  verdict: 'contradicts',
  note: 'The PR refunds partials with no approval step.',
  ...over,
});

describe('validateDocReferences', () => {
  it('keeps a reference whose link is a section of the library and whose quote is in it', () => {
    const { references, dropped } = validateDocReferences([ref({})], lib);
    expect(dropped).toBe(0);
    expect(references).toEqual([
      {
        path: 'billing-handbook/sections/04-refunds.md',
        workspaceId: 7,
        anchor: 'partial-refunds',
        docSlug: 'billing-handbook',
        docTitle: 'Billing handbook',
        sectionTitle: 'Refunds',
        quote: 'A partial refund needs a manager’s approval',
        verdict: 'contradicts',
        note: 'The PR refunds partials with no approval step.',
        about: null,
      },
    ]);
  });

  it('matches through emphasis, whitespace, typographic quotes, case and a "…" skip', () => {
    const quotes = [
      'Refunds are paid within fourteen days of the request',
      'refunds are paid   WITHIN fourteen days',
      "A partial refund needs a manager's approval",
      'A partial refund needs … never paid to a different card',
    ];
    const { references, dropped } = validateDocReferences(quotes.map((quote) => ref({ quote, verdict: 'supports' })), lib);
    expect(dropped).toBe(0);
    expect(references).toHaveLength(4);
  });

  it('REJECTS a quote that is not in the cited section', () => {
    const r = validateDocReferences(
      [
        ref({ quote: 'Refunds are paid within thirty days of the request' }),
        ref({ quote: 'never paid to a different card … A partial refund needs' }), // pieces out of order
      ],
      lib,
    );
    expect(r.references).toEqual([]);
    expect(r.dropped).toBe(2);
  });

  it('REJECTS a quote that only matches the server-written header, not the text', () => {
    expect(sectionBodyOf(REFUNDS)).not.toContain('Previous');
    const r = validateDocReferences([ref({ quote: 'Previous · Contents · Next' })], lib);
    expect(r.dropped).toBe(1);
  });

  it('REJECTS a link outside the library folder, or anything that is not a built section', () => {
    const links = [
      '../../etc/passwd',
      '/etc/passwd',
      join(dir, '..', 'staging', 'x.md'),
      'billing-handbook/sections/../../INDEX.md',
      'INDEX.md',
      'billing-handbook/CONTENTS.md',
      'billing-handbook/sections/99-missing.md',
      'other-doc/sections/04-refunds.md',
      'billing-handbook/sections/04-refunds.md%00',
      'https://example.com/billing-handbook/sections/04-refunds.md',
      42,
    ];
    const r = validateDocReferences(
      links.map((link) => ref({ link, quote: 'Refunds are paid within fourteen days' })),
      lib,
    );
    expect(r.references).toEqual([]);
    expect(r.dropped).toBe(links.length);
  });

  it('accepts an absolute path inside the library and a markdown link, re-expressed relative', () => {
    const r = validateDocReferences(
      [
        ref({ link: join(dir, 'billing-handbook', 'sections', '04-refunds.md') }),
        ref({ link: '[Refunds](./billing-handbook/sections/04-refunds.md#refunds)', quote: 'Refunds are paid within fourteen days' }),
      ],
      lib,
    );
    expect(r.dropped).toBe(0);
    expect(r.references.map((x) => [x.path, x.anchor])).toEqual([
      ['billing-handbook/sections/04-refunds.md', null],
      ['billing-handbook/sections/04-refunds.md', 'refunds'],
    ]);
  });

  // CONTENTS.md writes `sections/NN-name.md` and a section's nav a bare `NN-name.md`: a model that
  // copies a link as the file shows it must not lose a valid reference.
  it('resolves a DOCUMENT-RELATIVE link when one document has that section', () => {
    const r = validateDocReferences(
      [ref({ link: 'sections/04-refunds.md#partial-refunds' }), ref({ link: '04-refunds.md', verdict: 'supports', quote: 'Refunds are paid within fourteen days' })],
      lib,
    );
    expect(r.dropped).toBe(0);
    expect(r.references.map((x) => [x.path, x.anchor])).toEqual([
      ['billing-handbook/sections/04-refunds.md', 'partial-refunds'],
      ['billing-handbook/sections/04-refunds.md', null],
    ]);
    expect(validateDocCitations(['sections/04-refunds.md#partial-refunds'], lib).map((c) => c.path)).toEqual([
      'billing-handbook/sections/04-refunds.md',
    ]);
  });

  it('a document-relative link in TWO documents: the quote picks one, a citation alone refuses', () => {
    const other = renderSection({
      docTitle: 'Support guide',
      index: 3,
      total: 5,
      section: { title: 'Refunds', trail: [], body: '## Refunds\n\nSupport may refund a customer once per order.' },
      prevFile: null,
      nextFile: null,
    });
    const files = new Map<string, string>([
      ['billing-handbook/sections/04-refunds.md', REFUNDS],
      ['support-guide/sections/04-refunds.md', other],
    ]);
    const two: LibrarySnapshot = {
      workspaceId: 7,
      dir,
      docs: [
        lib.docs[0]!,
        { slug: 'support-guide', title: 'Support guide', sections: [{ path: 'support-guide/sections/04-refunds.md', title: 'Refunds', summary: '', depth: 1, trail: [], headings: [], words: 9 }] },
      ],
      read: (p) => (parseLibraryPath(p) != null ? (files.get(p) ?? null) : null),
    };
    const r = validateDocReferences(
      [
        ref({ link: 'sections/04-refunds.md', verdict: 'supports', quote: 'refund a customer once per order' }),
        ref({ link: 'sections/04-refunds.md', verdict: 'context', quote: 'Refunds' + ' are paid within thirty days' }),
      ],
      two,
    );
    expect(r.references.map((x) => x.path)).toEqual(['support-guide/sections/04-refunds.md']);
    expect(r.dropped).toBe(1);
    expect(validateDocCitations(['sections/04-refunds.md'], two)).toEqual([]);
    expect(validateDocCitations(['support-guide/sections/04-refunds.md'], two).map((c) => c.docSlug)).toEqual(['support-guide']);
  });

  it('drops an anchor that names no heading, keeping the link', () => {
    const r = validateDocReferences([ref({ link: 'billing-handbook/sections/04-refunds.md#nowhere' })], lib);
    expect(r.references[0]?.anchor).toBeNull();
  });

  it('refuses a too-short or over-long quote and an unknown verdict; dedupes; contradictions first', () => {
    const r = validateDocReferences(
      [
        ref({ quote: 'refunds' }),
        ref({ quote: 'x'.repeat(REVIEW_DOC_QUOTE_MAX_CHARS + 1) }),
        ref({ verdict: 'agrees' }),
        ref({ verdict: 'context', quote: 'Refunds are paid within fourteen days' }),
        ref({ verdict: 'supports', quote: 'never paid to a different card' }),
        ref({}),
        ref({}),
      ],
      lib,
    );
    expect(r.dropped).toBe(3);
    expect(r.references.map((x) => x.verdict)).toEqual(['contradicts', 'supports', 'context']);
  });

  it('anything that is not a list is no references', () => {
    expect(validateDocReferences(undefined, lib)).toEqual({ references: [], dropped: 0 });
    expect(validateDocReferences('x', lib)).toEqual({ references: [], dropped: 0 });
  });
});

describe('validateDocCitations (a finding’s docRefs)', () => {
  it('keeps real sections only, deduped and capped', () => {
    const c = validateDocCitations(
      [
        'billing-handbook/sections/04-refunds.md#partial-refunds',
        'billing-handbook/sections/04-refunds.md#partial-refunds',
        '../secret.md',
        'billing-handbook/CONTENTS.md',
      ],
      lib,
    );
    expect(c).toEqual([
      {
        path: 'billing-handbook/sections/04-refunds.md',
        workspaceId: 7,
        anchor: 'partial-refunds',
        docSlug: 'billing-handbook',
        docTitle: 'Billing handbook',
        sectionTitle: 'Refunds',
      },
    ]);
    expect(validateDocCitations(null, lib)).toEqual([]);
  });
});

describe('helpers', () => {
  it('libraryRelativeLink refuses an absolute path outside the library', () => {
    expect(libraryRelativeLink('/etc/passwd', dir)).toBeNull();
    expect(libraryRelativeLink(join(dir, 'a', 'sections', '01-x.md#h'), dir)).toBe('a/sections/01-x.md#h');
    expect(libraryRelativeLink('a\\sections\\01-x.md', dir)).toBeNull();
  });

  it('foldForQuote folds markup and typography', () => {
    expect(foldForQuote('**Bold** _and_ `code` — “quoted”')).toBe('bold and code - "quoted"');
  });

  it('quoteAppearsIn needs at least one piece', () => {
    expect(quoteAppearsIn('text', '…')).toBe(false);
  });
});

describe('the prompt block and the tool field', () => {
  it('the block carries the navigation rules and how to report', () => {
    for (const kind of ['pr', 'pr_diff_only', 'ticket'] as const) {
      const b = docsReviewPromptBlock('/lib', kind);
      expect(b).toContain('Start at INDEX.md');
      expect(b).toContain('Never read a whole document');
      expect(b).toContain('docReferences');
      expect(b).toContain('/lib');
    }
    expect(docsReviewPromptBlock('/lib', 'ticket')).toContain('CONTRADICTION');
    expect(docsReviewPromptBlock('/lib', 'pr')).toContain('docRefs');
    expect(docsReviewPromptBlock('/lib', 'pr_diff_only')).toContain('reach the library only');
    // The ticket block names the library as an extra readable directory and the field's tool.
    expect(docsReviewPromptBlock('/lib', 'ticket')).toContain('one more READ-ONLY directory');
    expect(docsReviewPromptBlock('/lib', 'ticket')).toContain('field of your submit_ticket_review call');
    expect(docsReviewPromptBlock('/lib', 'pr')).toContain('field of your submit_review call');
  });

  it('the diff-only PR prompt with the library does not also say it has no Read/Glob/Grep', async () => {
    const p = await import('../review/claude-review/prompts.js');
    const on = p.systemPromptForMode('diff_only', [], '/lib');
    expect(on).not.toContain('no Read, Glob, Grep');
    expect(on).not.toContain('The ONLY tool available to you is submit_review');
    expect(on).toContain('Read, Glob and Grep reach ONLY');
    expect(on.startsWith(`${p.REVIEW_SYSTEM_PROMPT_DIFF_ONLY_WITH_LIBRARY}\n\n`)).toBe(true);
    expect(p.REVIEW_SYSTEM_PROMPT_DIFF_ONLY).toContain('no Read, Glob, Grep');
  });

  it('a diff-only run reading the library gets room for the INDEX → CONTENTS → sections walk', async () => {
    const { reviewMaxTurnsFor, DIFF_ONLY_DOCS_MIN_TURNS } = await import('../review/agent.js');
    const caps = { worktree: 30, diffOnly: 6 };
    expect(reviewMaxTurnsFor('diff_only', false, caps)).toBe(6);
    expect(reviewMaxTurnsFor('diff_only', true, caps)).toBe(DIFF_ONLY_DOCS_MIN_TURNS);
    expect(DIFF_ONLY_DOCS_MIN_TURNS).toBeGreaterThanOrEqual(12);
    expect(reviewMaxTurnsFor('diff_only', true, { worktree: 30, diffOnly: 40 })).toBe(40);
    expect(reviewMaxTurnsFor('worktree', true, caps)).toBe(30);
    expect(reviewMaxTurnsFor('worktree', false, caps)).toBe(30);
  });

  it('the field refuses an over-long quote at the tool, so the model rewrites it', () => {
    const f = buildDocReferencesField(z);
    expect(f.safeParse([{ link: 'a', quote: 'x'.repeat(REVIEW_DOC_QUOTE_MAX_CHARS + 1), verdict: 'supports', note: 'n' }]).success).toBe(false);
    expect(f.safeParse([{ link: 'a', quote: 'ok quote here', verdict: 'supports', note: 'n' }]).success).toBe(true);
    expect(f.safeParse(undefined).success).toBe(true);
  });
});

// ⚠ SWITCH OFF (or an empty library) ⇒ PROMPTS, TOOLS AND OUTPUT BYTE-FOR-BYTE UNCHANGED. Each run's
// builders take the library as an optional argument; with none they must return exactly the
// pre-feature prompt / shape / policy.
describe('without the library, every review run is unchanged', () => {
  it('Claude Review: the system prompt, the tool policy and the submit_review shape', async () => {
    const p = await import('../review/claude-review/prompts.js');
    expect(p.systemPromptForMode('diff_only')).toBe(p.REVIEW_SYSTEM_PROMPT_DIFF_ONLY);
    expect(p.systemPromptForMode('diff_only', [], null)).toBe(p.REVIEW_SYSTEM_PROMPT_DIFF_ONLY);
    expect(p.systemPromptForMode('worktree', [], null)).toBe(p.REVIEW_SYSTEM_PROMPT_WORKTREE);
    expect(p.systemPromptForMode('worktree', ['security'], null)).toBe(p.systemPromptForMode('worktree', ['security']));
    expect(p.systemPromptForMode('worktree')).not.toContain('reference library');
    expect(p.systemPromptForMode('worktree', [], '/lib')).toContain(p.REVIEW_SYSTEM_PROMPT_WORKTREE);
    expect(p.systemPromptForMode('worktree', [], '/lib')).toContain('# The reference library');

    const { reviewToolPolicy } = await import('../review/agent.js');
    expect(reviewToolPolicy('diff_only', undefined)).toEqual(reviewToolPolicy('diff_only', undefined, false));
    expect(reviewToolPolicy('diff_only', undefined).allowedTools).toEqual(['mcp__review__submit_review']);
    expect(reviewToolPolicy('worktree', ['tests'], true)).toEqual(reviewToolPolicy('worktree', ['tests']));
    // With the library, a diff-only run gains ONLY the read tools (and never a write or a shell).
    const withDocs = reviewToolPolicy('diff_only', undefined, true);
    expect(withDocs.allowedTools).toEqual(['Read', 'Glob', 'Grep', 'mcp__review__submit_review']);
    for (const t of ['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']) expect(withDocs.disallowedTools).toContain(t);

    const { buildSubmitReviewShape } = await import('../review/schema.js');
    const off = buildSubmitReviewShape(z);
    expect(Object.keys(off)).toEqual(['summary', 'verdict', 'scopeUsed', 'findings', 'followUp', 'threads']);
    expect(JSON.stringify(z.toJSONSchema(z.object(off)))).toBe(JSON.stringify(z.toJSONSchema(z.object(buildSubmitReviewShape(z, { docs: false })))));
    expect(JSON.stringify(z.toJSONSchema(z.object(off)))).not.toContain('docRefs');
    const on = buildSubmitReviewShape(z, { docs: true });
    expect(Object.keys(on)).toEqual(['summary', 'verdict', 'scopeUsed', 'findings', 'followUp', 'threads', 'docReferences']);
    expect(JSON.stringify(z.toJSONSchema(z.object(on)))).toContain('docRefs');
  });

  it('the ticket review: the system prompt and the submit_ticket_review shape', async () => {
    const p = await import('../review/ticket-review/prompts.js');
    expect(p.ticketReviewSystemPrompt()).toBe(p.TICKET_REVIEW_SYSTEM_PROMPT);
    expect(p.ticketReviewSystemPrompt(null)).toBe(p.TICKET_REVIEW_SYSTEM_PROMPT);
    expect(p.ticketReviewSystemPrompt('/lib').startsWith(`${p.TICKET_REVIEW_SYSTEM_PROMPT}\n\n`)).toBe(true);
    const { buildSubmitTicketReviewShape } = await import('../review/ticket-review/schema.js');
    expect(Object.keys(buildSubmitTicketReviewShape(z))).toEqual(['alignment', 'summary', 'criteria', 'missing', 'notRequested', 'cards']);
    expect(Object.keys(buildSubmitTicketReviewShape(z, { docs: true }))).toContain('docReferences');
    const { ticketToolPolicy } = await import('../review/ticket-review/agent.js');
    expect(ticketToolPolicy().allowedTools).toEqual(['Read', 'Glob', 'Grep', 'mcp__ticket__submit_ticket_review']);
  });
});
