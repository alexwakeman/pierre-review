// THE STORY DOCS PIPELINE'S BUILD MODE ("Implement story" → docs consideration). Pinned:
//   1. THE PRECEDENCE RULE in the prompt (the story is the spec; superseded is never a fix to the story;
//      suggestions only where the story is silent; grounded when the docs agree) — on both providers;
//   2. SHAPE refused with what to fix: kinds, `about` only from the listed values, a suggestion ONLY on a
//      'suggestion' item (machine-held precedence), the summary's sentences, the item cap;
//   3. GROUNDING drops (never refuses): an item with no checked reference, or citing a document outside
//      the shortlist, is gone; nothing left ⇒ `nothingGrounded` with the summary hidden; ids D1… on survivors;
//   4. the tool policy: Read/Glob/Grep + submit_build_docs, Bash and every write tool denied.
import { describe, expect, it } from 'vitest';
import type { StoryBuildPlan, StoryDocsShortlistEntry } from '@pierre-review/shared';
import { promptTools } from '../../ai/prompt-tools.js';
import type { LibrarySnapshot } from '../../reference-docs/review-refs.js';
import { buildDocsToolPolicy, judgeBuildDocsSubmission, MAX_SUBMIT_ATTEMPTS } from './agent.js';
import { buildBuildDocsPrompt, buildDocsAbouts, buildDocsSystemPrompt, buildDocsUntrustedTexts } from './build-prompts.js';
import { buildDocsShapeProblems, canonicalAbout, validateBuildDocs } from './build-validate.js';

const sec = (slug: string, file: string, title: string) => ({ path: `${slug}/sections/${file}`, title, summary: '', depth: 1, trail: [], headings: [], words: 10 });
const files: Record<string, string> = {
  'refunds/sections/01-refunds.md': '# Refunds\n\nRefunds are paid within fourteen days of the request being approved. Every refund is logged in the audit trail.',
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
const SHORTLIST: StoryDocsShortlistEntry[] = [
  { path: 'refunds/sections/01-refunds.md', workspaceId: 3, anchor: null, docSlug: 'refunds', docTitle: 'Refund policy', sectionTitle: 'Refunds', reason: 'timing' },
];
const PLAN: StoryBuildPlan = {
  revision: 2,
  summary: 'Add card refunds to the API. Show them in the web app.',
  repos: [
    { ref: 'R1', repoId: 11, why: 'The refund endpoint lives here.', branchSlug: 'card-refunds', steps: [{ title: 'Add the refund endpoint', files: ['src/refunds.ts'], change: 'POST /refunds', refs: ['AC1'] }, { title: 'Log refunds', files: [], change: '', refs: [] }], tests: ['refunds.test.ts'] },
  ],
  readOnlyRepos: [],
  criteria: [{ ref: 'AC1', how: 'planned', repo: 'R1', reason: null }],
  risks: [],
};
const CRITERIA = [
  { ref: 'AC1', text: 'Refunds are paid within 30 days', verdict: 'not_met' as const },
  { ref: 'AC2', text: 'The refund button is shown', verdict: 'met' as const },
];
const MISSING = [{ ref: 'M1', text: 'Email the customer' }];
const CTX = { abouts: buildDocsAbouts(CRITERIA, MISSING, PLAN) };

const good = { link: 'refunds/sections/01-refunds.md', quote: 'Refunds are paid within fourteen days' };
const wrongQuote = { link: 'refunds/sections/01-refunds.md', quote: 'Refunds are paid within thirty days' };
const notShortlisted = { link: 'billing/sections/01-invoices.md', quote: 'Invoices are issued on the first working day' };

/* eslint-disable @typescript-eslint/no-explicit-any */
const payload = (over: any = {}): any => ({
  summary: 'The plan follows the refund policy except for the deadline. The story sets a longer one on purpose.',
  items: [
    { kind: 'superseded', about: 'AC1', note: 'The story pays within 30 days; the refund policy says 14.', refs: [good] },
    { kind: 'suggestion', about: 'R1:step 2', note: 'The policy logs every refund.', suggestion: 'Write each refund to the audit trail.', refs: [{ link: 'refunds/sections/01-refunds.md', quote: 'Every refund is logged in the audit trail' }] },
    { kind: 'grounded', about: 'story', note: 'Refunds need an approved request, as the policy says.', refs: [good] },
  ],
  ...over,
});

describe('the abouts', () => {
  it('lists story, every criterion, every ask outside them and every plan step', () => {
    expect(CTX.abouts).toEqual(['story', 'AC1', 'AC2', 'M1', 'R1:step 1', 'R1:step 2']);
  });
  it('reads loose spellings as the canonical value, and nothing unlisted', () => {
    expect(canonicalAbout('ac1', CTX)).toBe('AC1');
    expect(canonicalAbout(' r1: Step 2 ', CTX)).toBe('R1:step 2');
    expect(canonicalAbout('R1 step 1', CTX)).toBe('R1:step 1');
    expect(canonicalAbout('Story', CTX)).toBe('story');
    expect(canonicalAbout('AC9', CTX)).toBeNull();
    expect(canonicalAbout('R1:step 3', CTX)).toBeNull();
    expect(canonicalAbout(7, CTX)).toBeNull();
  });
});

describe('shape (the submit tool)', () => {
  it('accepts a well-formed answer, and an empty list', () => {
    expect(buildDocsShapeProblems(payload(), CTX)).toEqual([]);
    expect(buildDocsShapeProblems(payload({ items: [] }), CTX)).toEqual([]);
  });

  it('refuses a bad kind, an unlisted about, a one-sentence summary and a missing reference', () => {
    const p = buildDocsShapeProblems(
      payload({
        summary: 'One sentence.',
        items: [
          { kind: 'conflict', about: 'AC1', note: 'n', refs: [good] },
          { kind: 'grounded', about: 'AC7', note: 'n', refs: [good] },
          { kind: 'grounded', about: 'AC1', note: 'n', refs: [] },
        ],
      }),
      CTX,
    );
    expect(p.join('\n')).toMatch(/summary has 1 sentences/);
    expect(p.join('\n')).toMatch(/items\[0\]\.kind must be one of: grounded, superseded, suggestion/);
    expect(p.join('\n')).toMatch(/items\[1\]\.about must be one of the values the message lists \(story, AC1/);
    expect(p.join('\n')).toMatch(/items\[2\] has no reference/);
  });

  it('THE PRECEDENCE RULE, machine-held: only a suggestion proposes work', () => {
    const superseded = buildDocsShapeProblems(payload({ items: [{ kind: 'superseded', about: 'AC1', note: 'n', suggestion: 'Change the story to 14 days.', refs: [good] }] }), CTX);
    expect(superseded).toEqual([expect.stringMatching(/'superseded': leave `suggestion` out.*the story is never changed to match the docs/)]);
    const bare = buildDocsShapeProblems(payload({ items: [{ kind: 'suggestion', about: 'M1', note: 'n', refs: [good] }] }), CTX);
    expect(bare).toEqual([expect.stringMatching(/suggestion with no `suggestion`/)]);
    // A null suggestion (Codex's strict form for "absent") is fine on a non-suggestion.
    expect(buildDocsShapeProblems(payload({ items: [{ kind: 'grounded', about: 'AC2', note: 'n', suggestion: null, refs: [good] }] }), CTX)).toEqual([]);
  });

  it('refuses too many items and over-long text', () => {
    const many = Array.from({ length: 13 }, () => ({ kind: 'grounded', about: 'story', note: 'n', refs: [good] }));
    expect(buildDocsShapeProblems(payload({ items: many }), CTX).join(' ')).toMatch(/items has 13: give at most 12/);
    expect(buildDocsShapeProblems(payload({ items: [{ kind: 'grounded', about: 'story', note: 'x'.repeat(401), refs: [good] }] }), CTX).join(' ')).toMatch(/note is 401 characters/);
  });

  it('the judge refuses with what to fix, worded per provider, and stops after the last attempt', () => {
    const bad = payload({ summary: 'One.' });
    const c = judgeBuildDocsSubmission(bad, 1, CTX);
    expect('reply' in c && c.reply).toMatch(/Fix every point and call submit_build_docs again/);
    const x = judgeBuildDocsSubmission(bad, 1, CTX, promptTools('codex'));
    expect('reply' in x && x.reply).not.toMatch(/submit_build_docs/);
    const last = judgeBuildDocsSubmission(bad, MAX_SUBMIT_ATTEMPTS, CTX);
    expect('reply' in last && last.reply).toMatch(/That was the last attempt/);
    expect(judgeBuildDocsSubmission(payload(), 1, CTX)).toEqual({ accepted: payload() });
  });
});

describe('grounding (storage)', () => {
  it('keeps grounded items with their checked refs and ids D1… in order', () => {
    const v = validateBuildDocs(payload(), LIB, CTX, SHORTLIST, 2);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.value.docs.planRevision).toBe(2);
    expect(v.value.docs.nothingGrounded).toBe(false);
    expect(v.value.docs.items.map((i) => [i.id, i.kind, i.about])).toEqual([
      ['D1', 'superseded', 'AC1'],
      ['D2', 'suggestion', 'R1:step 2'],
      ['D3', 'grounded', 'story'],
    ]);
    expect(v.value.docs.items[0]!.suggestion).toBeNull();
    expect(v.value.docs.items[1]!.suggestion).toBe('Write each refund to the audit trail.');
    expect(v.value.docs.items[0]!.refs[0]).toMatchObject({ path: 'refunds/sections/01-refunds.md', workspaceId: 3, docTitle: 'Refund policy' });
  });

  it('DROPS an item whose quote does not check out or cites a document outside the shortlist; ids close up', () => {
    const v = validateBuildDocs(
      payload({
        items: [
          { kind: 'grounded', about: 'story', note: 'Wrong quote.', refs: [wrongQuote] },
          { kind: 'grounded', about: 'AC2', note: 'Not shortlisted.', refs: [notShortlisted] },
          { kind: 'superseded', about: 'ac1', note: 'Kept.', refs: [wrongQuote, good] },
        ],
      }),
      LIB,
      CTX,
      SHORTLIST,
      2,
    );
    expect(v.ok && v.value.docs.items.map((i) => [i.id, i.about, i.refs.length])).toEqual([['D1', 'AC1', 1]]);
    expect(v.ok && v.value.dropped).toBeGreaterThanOrEqual(3);
  });

  it('nothing grounded ⇒ nothingGrounded, the summary hidden; an empty answer is not "nothing grounded"', () => {
    const none = validateBuildDocs(payload({ items: [{ kind: 'grounded', about: 'story', note: 'x', refs: [wrongQuote] }] }), LIB, CTX, SHORTLIST, 1);
    expect(none.ok && none.value.docs).toEqual({ summary: '', items: [], nothingGrounded: true, planRevision: 1 });
    const empty = validateBuildDocs(payload({ items: [] }), LIB, CTX, SHORTLIST, 1);
    expect(empty.ok && empty.value.docs.nothingGrounded).toBe(false);
    expect(empty.ok && empty.value.docs.summary).toMatch(/^The plan follows/);
  });

  it('fails only on an unusable summary; a malformed item is dropped, a duplicate too', () => {
    expect(validateBuildDocs(payload({ summary: '' }), LIB, CTX, SHORTLIST, 1).ok).toBe(false);
    const v = validateBuildDocs(
      payload({ items: [{ kind: 'superseded', about: 'AC1', note: 'Same.', refs: [good] }, { kind: 'superseded', about: 'AC1', note: 'same.', refs: [good] }, { kind: 'nope', about: 'AC1', note: 'n', refs: [good] }] }),
      LIB,
      CTX,
      SHORTLIST,
      1,
    );
    expect(v.ok && v.value.docs.items).toHaveLength(1);
  });
});

describe('the prompt', () => {
  const sections = [{ path: 'refunds/sections/01-refunds.md', text: 'Refunds are paid within fourteen days.', cut: false }];
  const input = {
    story: { key: 'ACME-214', title: 'Card refunds', text: 'Customers get refunds by card within 30 days.' },
    comments: 'Dana Lee, 2026-03-04:\nCSV only.',
    criteria: CRITERIA,
    missing: MISSING,
    plan: PLAN,
    repoNames: new Map([['R1', 'acme/api']]),
    shortlist: SHORTLIST,
    sections,
    libraryDir: '/abs/library',
  };

  it('states THE PRECEDENCE RULE', () => {
    for (const t of [promptTools('claude'), promptTools('codex')]) {
      const sys = buildDocsSystemPrompt(t);
      expect(sys).toMatch(/# The story is the spec/);
      expect(sys).toMatch(/superseded: .*The story wins.*NEVER suggest changing the story or the plan to match the docs/);
      expect(sys).toMatch(/suggestion: the docs require something the story says NOTHING about/);
      expect(sys).toMatch(/grounded: the docs agree/);
      expect(sys).toMatch(/There is NO shell, NO network and NO write tool/);
    }
    expect(buildDocsSystemPrompt(promptTools('claude'))).toMatch(/Call submit_build_docs ONCE/);
    expect(buildDocsSystemPrompt(promptTools('codex'))).not.toMatch(/submit_build_docs/);
  });

  it('fences every untrusted block with the nonce, lists the abouts, and names each repo', () => {
    const p = buildBuildDocsPrompt({ ...input, nonce: 'abc123' }, promptTools('claude'));
    for (const label of ['STORY', 'TICKET COMMENTS', 'CRITERIA', 'PLAN', 'SHORTLIST', 'SECTION refunds/sections/01-refunds.md']) {
      expect(p).toContain(`---BEGIN ${label} abc123---`);
      expect(p).toContain(`---END ${label} abc123---`);
    }
    expect(p).toContain('`about` takes exactly one of: story, AC1, AC2, M1, R1:step 1, R1:step 2.');
    expect(p).toContain('R1 acme/api — The refund endpoint lives here.');
    expect(p).toContain('  R1:step 1: Add the refund endpoint [AC1]');
    expect(p).toContain('AC2 (already delivered): The refund button is shown');
    expect(p).toMatch(/Call submit_build_docs now\.$/);
    expect(buildBuildDocsPrompt({ ...input, nonce: 'abc123' }, promptTools('codex'))).toMatch(/Give your final JSON answer now\.$/);
  });

  it('scans every untrusted text for the nonce', () => {
    const texts = buildDocsUntrustedTexts(input);
    expect(texts.join('\n')).toContain('CSV only.');
    expect(texts.join('\n')).toContain('Add the refund endpoint');
    expect(texts.join('\n')).toContain('Refunds are paid within fourteen days.');
  });
});

describe('the tool policy', () => {
  it('reads and submits only: no shell, no write, no dispatch', () => {
    const p = buildDocsToolPolicy();
    expect(p.allowedTools).toEqual(['Read', 'Glob', 'Grep', 'mcp__storydocs__submit_build_docs']);
    for (const t of ['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']) expect(p.disallowedTools).toContain(t);
    expect(p.allowedTools).not.toContain('Bash');
  });
});
