// THE STORY DOCS VALIDATOR: shape is refused (the tool), grounding is DROPPED (storage), and nothing
// outside the shortlisted documents can be cited.
import { describe, expect, it } from 'vitest';
import type { StoryDocsShortlistEntry } from '@pierre-review/shared';
import type { LibrarySnapshot } from '../../reference-docs/review-refs.js';
import { alignmentShapeProblems, sentenceCount, validateAlignment, type AlignmentContext } from './validate.js';
import { judgeSubmission, MAX_SUBMIT_ATTEMPTS } from './agent.js';

const sec = (slug: string, file: string, title: string) => ({ path: `${slug}/sections/${file}`, title, summary: '', depth: 1, trail: [], headings: [], words: 10 });
const files: Record<string, string> = {
  'refunds/sections/01-refunds.md': '# Refunds\n\nRefunds are paid within fourteen days of the request being approved.',
  'billing/sections/01-invoices.md': 'Invoices are issued on the first working day of each month.',
};
const LIB: LibrarySnapshot = {
  workspaceId: 3,
  dir: '/abs/library',
  docs: [
    { slug: 'refunds', title: 'Refund policy', sections: [sec('refunds', '01-refunds.md', 'Refunds')] },
    { slug: 'billing', title: 'Billing', sections: [sec('billing', '01-invoices.md', 'Invoices')] },
  ],
  read: (p) => files[p] ?? null,
};
// Only the refund policy was shortlisted.
const SHORTLIST: StoryDocsShortlistEntry[] = [
  { path: 'refunds/sections/01-refunds.md', workspaceId: 3, anchor: null, docSlug: 'refunds', docTitle: 'Refund policy', sectionTitle: 'Refunds', reason: 'timing' },
];
const CTX: AlignmentContext = {
  criteriaSource: 'brief',
  criteria: [
    { n: 1, text: 'Refunds are paid within 30 days' },
    { n: 2, text: 'The button is blue' },
  ],
};

const good = { link: 'refunds/sections/01-refunds.md', quote: 'Refunds are paid within fourteen days' };
const wrongQuote = { link: 'refunds/sections/01-refunds.md', quote: 'Refunds are paid within thirty days' };
const notShortlisted = { link: 'billing/sections/01-invoices.md', quote: 'Invoices are issued on the first working day' };

/* eslint-disable @typescript-eslint/no-explicit-any */
const payload = (over: any = {}): any => ({
  overall: {
    verdict: 'mixed',
    summary: 'The story mostly matches the refund policy. It sets the wrong deadline.',
    actions: [
      { text: 'Change the deadline to 14 days.', refs: [good] },
      { text: 'Keep the approval step.', refs: [good] },
    ],
  },
  criteria: [{ n: 1, verdict: 'diverges', note: 'The story says 30 days; the policy says 14.', refs: [good] }],
  storyParts: [],
  ...over,
});

describe('shape (the submit tool)', () => {
  it('accepts a well-formed answer', () => {
    expect(alignmentShapeProblems(payload(), CTX)).toEqual([]);
  });
  it('refuses a criterion number out of range, bad verdicts, a 1-sentence summary and too few actions', () => {
    const p = payload({
      overall: { verdict: 'great', summary: 'One sentence only.', actions: [{ text: 'x', refs: [good] }] },
      criteria: [{ n: 3, verdict: 'aligned', note: 'n', refs: [good] }, { n: 1, verdict: 'yes', note: 'n', refs: [good] }],
    });
    const problems = alignmentShapeProblems(p, CTX);
    expect(problems.join(' ')).toMatch(/overall\.verdict/);
    expect(problems.join(' ')).toMatch(/1 sentences/);
    expect(problems.join(' ')).toMatch(/actions has 1/);
    expect(problems.join(' ')).toMatch(/from 1 to 2/);
    expect(problems.join(' ')).toMatch(/criteria\[1\]\.verdict/);
  });
  it('refuses an item with no reference at all, and stops after the last attempt', () => {
    const p = payload({ criteria: [{ n: 1, verdict: 'aligned', note: 'ok', refs: [] }] });
    const j = judgeSubmission(p, MAX_SUBMIT_ATTEMPTS, CTX);
    expect('reply' in j && j.reply).toMatch(/no reference/);
    expect('reply' in j && j.reply).toMatch(/last attempt/);
  });
  it('does NOT refuse a quote that would fail grounding (that is dropped at storage, never looped)', () => {
    expect('accepted' in judgeSubmission(payload({ criteria: [{ n: 1, verdict: 'aligned', note: 'ok', refs: [wrongQuote] }] }), 1, CTX)).toBe(true);
  });
  it('refuses a quote too short to ground, naming the minimum', () => {
    const short = { link: good.link, quote: '14 days' };
    const problems = alignmentShapeProblems(payload({ criteria: [{ n: 1, verdict: 'aligned', note: 'ok', refs: [short] }] }), CTX);
    expect(problems.join(' ')).toMatch(/criteria\[0\] has a quote shorter than 12 letters/);
  });
  it('refuses an over-long action, note or part label so the model rewrites it (never cut off)', () => {
    const long = 'word '.repeat(120).trim();
    const p = payload({
      overall: { verdict: 'mixed', summary: 'It mostly matches. It sets the wrong deadline.', actions: [{ text: long, refs: [good] }, { text: 'Keep it.', refs: [good] }] },
      criteria: [{ n: 1, verdict: 'aligned', note: long, refs: [good] }],
      storyParts: [{ part: long, verdict: 'aligned', note: 'ok', refs: [good] }],
    });
    const text = alignmentShapeProblems(p, CTX).join(' ');
    expect(text).toMatch(/overall\.actions\[0\]\.text is \d+ characters: rewrite it in 240 or fewer/);
    expect(text).toMatch(/criteria\[0\]\.note is \d+ characters/);
    expect(text).toMatch(/storyParts\[0\]\.part is \d+ characters/);
  });
  it('counts sentences', () => {
    expect(sentenceCount('One. Two! Three?')).toBe(3);
    expect(sentenceCount('No full stop')).toBe(1);
  });
});

describe('grounding (storage)', () => {
  it('keeps grounded items and stamps the workspace on each reference', () => {
    const v = validateAlignment(payload(), LIB, CTX, SHORTLIST);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.value.result.outcome).toBe('checked');
    expect(v.value.result.criteria).toEqual([
      {
        n: 1,
        verdict: 'diverges',
        note: 'The story says 30 days; the policy says 14.',
        refs: [{ path: 'refunds/sections/01-refunds.md', workspaceId: 3, anchor: null, docSlug: 'refunds', docTitle: 'Refund policy', sectionTitle: 'Refunds', quote: good.quote }],
      },
    ]);
    expect(v.value.result.shortlist).toEqual(SHORTLIST);
  });

  it('drops an item whose quote is not in the section, or whose section was not shortlisted', () => {
    const v = validateAlignment(
      payload({
        criteria: [
          { n: 1, verdict: 'diverges', note: 'a', refs: [wrongQuote] },
          { n: 2, verdict: 'aligned', note: 'b', refs: [notShortlisted] },
        ],
        storyParts: [{ part: 'The refund flow', verdict: 'aligned', note: 'c', refs: [good, wrongQuote] }],
      }),
      LIB,
      CTX,
      SHORTLIST,
    );
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.value.result.criteria).toEqual([]);
    expect(v.value.result.storyParts).toHaveLength(1);
    expect(v.value.result.storyParts[0]!.refs).toHaveLength(1);
    expect(v.value.result.dropped).toBeGreaterThanOrEqual(3);
  });

  it('drops a criterion number out of range and a duplicate number at storage', () => {
    const v = validateAlignment(
      payload({
        criteria: [
          { n: 0, verdict: 'aligned', note: 'a', refs: [good] },
          { n: 9, verdict: 'aligned', note: 'a', refs: [good] },
          { n: 1.5, verdict: 'aligned', note: 'a', refs: [good] },
          { n: 2, verdict: 'aligned', note: 'first', refs: [good] },
          { n: 2, verdict: 'diverges', note: 'second', refs: [good] },
        ],
      }),
      LIB,
      CTX,
      SHORTLIST,
    );
    expect(v.ok && v.value.result.criteria.map((c) => [c.n, c.note])).toEqual([[2, 'first']]);
  });

  it('nothing grounded ⇒ no overall summary is kept', () => {
    const v = validateAlignment(
      payload({
        overall: { verdict: 'aligned', summary: 'All good here. Nothing to change.', actions: [{ text: 'a', refs: [wrongQuote] }, { text: 'b', refs: [notShortlisted] }] },
        criteria: [],
      }),
      LIB,
      CTX,
      SHORTLIST,
    );
    expect(v.ok && v.value.result).toMatchObject({ outcome: 'nothing_grounded', overall: null, criteria: [], storyParts: [] });
  });

  it('a derived run numbers against its own derived list', () => {
    const derived: AlignmentContext = { criteriaSource: 'derived', criteria: [] };
    const p = payload({ derivedCriteria: ['Refunds are paid within 30 days.'], criteria: [{ n: 1, verdict: 'diverges', note: 'x', refs: [good] }, { n: 2, verdict: 'aligned', note: 'y', refs: [good] }] });
    expect(alignmentShapeProblems(p, derived).join(' ')).toMatch(/from 1 to 1/);
    const v = validateAlignment(p, LIB, derived, SHORTLIST);
    expect(v.ok && v.value.criteria).toEqual([{ n: 1, text: 'Refunds are paid within 30 days.' }]);
    expect(v.ok && v.value.result.criteria.map((c) => c.n)).toEqual([1]);
  });

  it('drops an item whose quote matches only an AI-written figure description (docs/REFERENCE-DOCS.md § Figures)', () => {
    const withFigure: LibrarySnapshot = {
      ...LIB,
      read: (p) =>
        p === 'refunds/sections/01-refunds.md'
          ? `${files[p]}\n\n[Figure (described by AI): flow.png — Every refund is approved by the finance lead before payout.]`
          : (files[p] ?? null),
    };
    const fromFigure = { link: 'refunds/sections/01-refunds.md', quote: 'approved by the finance lead before payout' };
    const v = validateAlignment(
      payload({ criteria: [{ n: 1, verdict: 'aligned', note: 'from the picture', refs: [fromFigure] }, { n: 2, verdict: 'diverges', note: 'from the text', refs: [good] }] }),
      withFigure,
      CTX,
      SHORTLIST,
    );
    expect(v.ok && v.value.result.criteria.map((c) => c.n)).toEqual([2]);
  });

  it('an unusable overall fails the answer', () => {
    expect(validateAlignment(payload({ overall: null }), LIB, CTX, SHORTLIST).ok).toBe(false);
  });
});
