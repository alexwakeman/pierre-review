// THE SHORTLIST: only sections of BUILT documents of this library, named under the strict grammar,
// listed in the document's stored sections and on disk, survive; the prompt fences every untrusted
// text and stays inside its CONTENTS budget.
import { describe, expect, it } from 'vitest';
import { STORY_DOCS_SHORTLIST_MAX } from '@pierre-review/shared';
import type { LibrarySnapshot } from '../../reference-docs/review-refs.js';
import { buildShortlistPrompt, firstJsonObject, runShortlist, splitContents, validateShortlist, type ShortlistDoc } from './shortlist.js';

const sec = (slug: string, file: string, title: string) => ({
  path: `${slug}/sections/${file}`,
  title,
  summary: '',
  depth: 1,
  trail: [],
  headings: [],
  words: 10,
});

const files: Record<string, string> = {
  'refunds/sections/01-refunds.md': 'Refunds are paid within fourteen days of approval.',
  'refunds/sections/02-partial.md': 'A partial refund needs a manager approval.',
  'refunds/CONTENTS.md': '# Refunds\n- [Refunds](sections/01-refunds.md)',
  'billing/sections/01-invoices.md': 'Invoices go out on the first working day.',
  'INDEX.md': '# Library',
};

const LIB: LibrarySnapshot = {
  workspaceId: 7,
  dir: '/lib',
  docs: [
    // `03-missing.md` is listed but not on disk.
    { slug: 'refunds', title: 'Refund policy', sections: [sec('refunds', '01-refunds.md', 'Refunds'), sec('refunds', '02-partial.md', 'Partial'), sec('refunds', '03-missing.md', 'Gone')] },
    { slug: 'billing', title: 'Billing', sections: [sec('billing', '01-invoices.md', 'Invoices')] },
  ],
  read: (p) => files[p] ?? null,
};

const answer = (sections: unknown) => `Here you go: ${JSON.stringify({ sections })} thanks`;

describe('validateShortlist', () => {
  it('keeps a valid library-root section link, with its titles from the rows and the workspace stamped', () => {
    const v = validateShortlist(answer([{ link: 'refunds/sections/01-refunds.md', reason: 'Refund timing' }]), LIB);
    expect(v).toEqual({
      ok: true,
      dropped: 0,
      entries: [
        { path: 'refunds/sections/01-refunds.md', workspaceId: 7, anchor: null, docSlug: 'refunds', docTitle: 'Refund policy', sectionTitle: 'Refunds', reason: 'Refund timing' },
      ],
    });
  });

  it('drops bad paths, unbuilt documents, unlisted or missing sections, and non-section files', () => {
    const v = validateShortlist(
      answer([
        { link: '../../etc/passwd' },
        { link: '/etc/passwd' },
        { link: 'unbuilt/sections/01-x.md' }, // not a built document of this library
        { link: 'refunds/sections/09-nope.md' }, // not in the stored sections
        { link: 'refunds/sections/03-missing.md' }, // listed, but not on disk
        { link: 'refunds/CONTENTS.md' }, // not a section
        { link: 'INDEX.md' },
        { link: 'refunds\\sections\\01-refunds.md' },
        'just a string',
        { link: 'billing/sections/01-invoices.md', reason: 'x' },
      ]),
      LIB,
    );
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.entries.map((e) => e.path)).toEqual(['billing/sections/01-invoices.md']);
    expect(v.dropped).toBe(9);
  });

  it('dedupes, resolves a unique document-relative link, clips reasons and caps the list', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ path: `big/sections/${String(i + 1).padStart(2, '0')}-s.md`, title: `S${i}` }));
    const big: LibrarySnapshot = {
      ...LIB,
      docs: [{ slug: 'big', title: 'Big', sections: many.map((m) => ({ ...sec('big', m.path.split('/')[2]!, m.title) })) }],
      read: (p) => (p.startsWith('big/sections/') ? 'text' : null),
    };
    const v = validateShortlist(answer(many.map((m) => ({ link: m.path, reason: 'r'.repeat(500) }))), big);
    expect(v.ok && v.entries.length).toBe(STORY_DOCS_SHORTLIST_MAX);
    expect(v.ok && v.entries[0]!.reason.length).toBeLessThanOrEqual(160);
    const rel = validateShortlist(answer([{ link: 'sections/02-partial.md' }, { link: 'refunds/sections/02-partial.md' }]), LIB);
    expect(rel.ok && rel.entries.map((e) => e.path)).toEqual(['refunds/sections/02-partial.md']);
  });

  it('an empty list is a valid answer; prose or a wrong shape is not', () => {
    expect(validateShortlist('{"sections":[]}', LIB)).toEqual({ ok: true, entries: [], dropped: 0 });
    expect(validateShortlist('I could not decide.', LIB)).toEqual({ ok: false });
    expect(validateShortlist('{"links":[]}', LIB)).toEqual({ ok: false });
    expect(firstJsonObject('x {"a":"}"} y')).toEqual({ a: '}' });
  });

  it('a non-empty list whose every link fails the check is unusable, never "nothing relevant"', () => {
    expect(validateShortlist(answer([{ link: 'refunds/sections/09-nope.md' }, { link: '../x' }]), LIB)).toEqual({ ok: false });
  });
});

describe('the shortlist prompt', () => {
  const doc = (slug: string, size: number): ShortlistDoc => ({ slug, title: slug, contents: 'c'.repeat(size), sections: [{ path: `${slug}/sections/01-a.md`, title: 'A' }] });
  it('carries CONTENTS within the budget and lists the rest by section title', () => {
    const { full, overflow } = splitContents([doc('a', 40_000), doc('b', 30_000), doc('c', 10_000)]);
    expect(full.map((d) => d.slug)).toEqual(['a', 'c']);
    expect(overflow.map((d) => d.slug)).toEqual(['b']);
    const p = buildShortlistPrompt(
      {
        story: { title: 'Refund in 30 days', description: 'desc', acceptanceCriteria: '' },
        criteriaSource: 'brief',
        criteria: [{ n: 1, text: 'Refunds go out in 30 days' }],
        index: '# INDEX',
        docs: [doc('a', 40_000), doc('b', 30_000)],
      },
      'n0nce',
    );
    expect(p).toContain('---BEGIN STORY n0nce---');
    expect(p).toContain('---BEGIN CONTENTS a n0nce---');
    expect(p).not.toContain('---BEGIN CONTENTS b n0nce---');
    expect(p).toContain('---BEGIN SECTIONS b n0nce---');
    expect(p).toContain('1. Refunds go out in 30 days');
  });

  it('retries ONCE on an unusable answer and records both calls', async () => {
    let calls = 0;
    const usage: number[] = [];
    const r = await runShortlist({
      input: { story: { title: 't', description: 'd', acceptanceCriteria: '' }, criteriaSource: 'derived', criteria: [], index: '', docs: [] },
      lib: LIB,
      complete: async () => {
        calls += 1;
        return { text: calls === 1 ? 'nope' : '{"sections":[{"link":"refunds/sections/01-refunds.md"}]}', usage: { inputTokens: 1000, outputTokens: 100 } };
      },
      onUsage: (u) => {
        usage.push(u.costUsd);
      },
    });
    expect(calls).toBe(2);
    expect(usage).toHaveLength(2);
    expect(r.entries?.map((e) => e.path)).toEqual(['refunds/sections/01-refunds.md']);
    const never = await runShortlist({
      input: { story: { title: 't', description: 'd', acceptanceCriteria: '' }, criteriaSource: 'derived', criteria: [], index: '', docs: [] },
      lib: LIB,
      complete: async () => ({ text: 'nope' }),
    });
    expect(never.entries).toBeNull();
    // Every named link invalid on both tries: a failed shortlist (null), never an empty one.
    let tries = 0;
    const allBad = await runShortlist({
      input: { story: { title: 't', description: 'd', acceptanceCriteria: '' }, criteriaSource: 'derived', criteria: [], index: '', docs: [] },
      lib: LIB,
      complete: async () => {
        tries += 1;
        return { text: '{"sections":[{"link":"refunds/sections/09-nope.md"}]}' };
      },
    });
    expect(tries).toBe(2);
    expect(allBad.entries).toBeNull();
  });
});
