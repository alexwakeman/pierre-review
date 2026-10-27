// CLAUDE + CODEX — the pure half (pair.ts) and the prompt block (prompts.ts). What is pinned:
//   1. who may run a pair: both providers ⇒ Claude then Codex; one ⇒ that one; none ⇒ none;
//   2. THE CODE DEDUPE: same file, near line (or a file-level one), similar title ⇒ dropped;
//   3. the second run's prompt block is present ONLY when there is pair input, fenced, and the
//      prompt is byte-identical without it;
//   4. the pair's verdict and the one body naming both providers.
//
//   pnpm --filter @pierre-review/backend test claude-review/pair.test
import { describe, expect, it } from 'vitest';
import { AUTO_POST_FOOTERS, hasAutoPostFooter, PAIR_AUTO_POST_FOOTER } from '@pierre-review/shared';
import {
  dropPairRepeats,
  isPairRepeat,
  pairInputOf,
  pairProvidersReady,
  pairRaisedByLead,
  pairReviewBody,
  pairVerdict,
  resolveAutoReviewProviders,
} from './pair.js';
import { buildUserPrompt, PAIR_SHOWN_MAX, untrustedTexts } from './prompts.js';

describe('who runs a pair', () => {
  const ok = { status: 'ok' as const };
  const none = { status: 'none' as const, message: 'no' };
  it('both signed in ⇒ Claude first, then Codex', () => {
    expect(pairProvidersReady(() => ok)).toEqual(['claude', 'codex']);
  });
  it('one signed in ⇒ just that one; none ⇒ none', () => {
    expect(pairProvidersReady((p) => (p === 'codex' ? ok : none))).toEqual(['codex']);
    expect(pairProvidersReady((p) => (p === 'claude' ? ok : none))).toEqual(['claude']);
    expect(pairProvidersReady(() => none)).toEqual([]);
  });
  it("the workspace setting reads 'both' only from a stored 'both'", () => {
    expect(resolveAutoReviewProviders('both')).toBe('both');
    for (const v of [null, undefined, '', 'default', 'BOTH', 1]) expect(resolveAutoReviewProviders(v)).toBe('default');
  });
});

describe('the code dedupe', () => {
  const a = { path: 'src/a.ts', line: 10, title: 'Null check missing on the user lookup' };
  it('same file, a near line, a similar title ⇒ a repeat', () => {
    expect(isPairRepeat(a, { path: 'src/a.ts', line: 13, title: 'Missing null check on user lookup' })).toBe(true);
    // A file-level finding on either side is "the same place".
    expect(isPairRepeat(a, { path: 'src/a.ts', line: null, title: 'Null check missing on the user lookup' })).toBe(true);
  });
  it('another file, a far line or another point ⇒ kept', () => {
    expect(isPairRepeat(a, { path: 'src/b.ts', line: 10, title: a.title })).toBe(false);
    expect(isPairRepeat(a, { path: 'src/a.ts', line: 40, title: a.title })).toBe(false);
    expect(isPairRepeat(a, { path: 'src/a.ts', line: 10, title: 'The retry loop never backs off' })).toBe(false);
  });
  it('drops only the repeats and keeps order', () => {
    const second = [
      { path: 'src/a.ts', line: 11, title: 'Null check missing on user lookup', id: 1 },
      { path: 'src/a.ts', line: 30, title: 'Off-by-one in the page count', id: 2 },
      { path: 'src/c.ts', line: 10, title: 'Null check missing on the user lookup', id: 3 },
    ];
    const { kept, dropped } = dropPairRepeats(second, [a]);
    expect(kept.map((f) => f.id)).toEqual([2, 3]);
    expect(dropped.map((f) => f.id)).toEqual([1]);
  });
});

describe("the second run's prompt", () => {
  const base = {
    repoFullName: 'acme/api',
    prNumber: 7,
    title: 'Add lookup',
    body: null,
    headSha: 'abc',
    baseRef: 'main',
    changedFiles: ['src/a.ts'],
    excludedFiles: [],
    diff: '+a',
    mode: 'diff_only' as const,
  };
  const input = pairInputOf('claude', [
    { title: 'Null check missing', path: 'src/a.ts', line: 10, severity: 'warning', body: 'The lookup can return null.' },
    { title: 'Nice tests', path: 'src/a.test.ts', line: 1, severity: 'praise', body: 'Good.' },
  ]);

  it('carries the first run’s findings, fenced, naming who raised them; praise is left out', () => {
    const p = buildUserPrompt({ ...base, pair: input, nonce: 'n0nce' });
    expect(p).toContain('## Already raised by Claude in this review');
    expect(p).toContain('Do NOT repeat them.');
    expect(p).toContain('---BEGIN ALREADY RAISED A1 n0nce---');
    expect(p).toContain('Where: src/a.ts:10');
    expect(p).toContain('Severity: warning');
    expect(p).not.toContain('Nice tests');
    expect(p).not.toContain('ALREADY RAISED A2');
  });

  it('without pair input (or with none raised) the prompt is byte-identical', () => {
    const plain = buildUserPrompt(base);
    expect(buildUserPrompt({ ...base, pair: null })).toBe(plain);
    expect(buildUserPrompt({ ...base, pair: { by: 'Claude', findings: [] } })).toBe(plain);
  });

  it('needs a nonce, and the nonce scan reads its text', () => {
    expect(() => buildUserPrompt({ ...base, pair: input })).toThrow(/nonce/);
    expect(untrustedTexts(null, null, null, null, null, null, input)).toContain('The lookup can return null.');
  });

  it('is capped', () => {
    const many = pairInputOf(
      'claude',
      Array.from({ length: PAIR_SHOWN_MAX + 3 }, (_, i) => ({ title: `t${i}`, path: 'x.ts', line: i, severity: 'nit', body: 'b' })),
    );
    const p = buildUserPrompt({ ...base, pair: many, nonce: 'n' });
    expect(p).toContain(`ALREADY RAISED A${PAIR_SHOWN_MAX} n`);
    expect(p).not.toContain(`ALREADY RAISED A${PAIR_SHOWN_MAX + 1} n`);
    expect(p).toContain('(3 more not shown.)');
  });
});

describe('the one post', () => {
  it('the verdict: approve only when both approved; changes when either asked', () => {
    expect(pairVerdict('APPROVE', 'APPROVE')).toBe('APPROVE');
    expect(pairVerdict('APPROVE', 'COMMENT')).toBe('COMMENT');
    expect(pairVerdict('COMMENT', 'REQUEST_CHANGES')).toBe('REQUEST_CHANGES');
    expect(pairVerdict(null, 'APPROVE')).toBe('COMMENT');
  });
  it('one body naming both providers, then the footer; an empty part is left out', () => {
    expect(
      pairReviewBody(
        [
          { by: 'Claude', text: 'Two problems.' },
          { by: 'Codex', text: 'One more.' },
        ],
        PAIR_AUTO_POST_FOOTER,
      ),
    ).toBe(`**Claude:** Two problems.\n\n**Codex:** One more.\n\n${PAIR_AUTO_POST_FOOTER}`);
    expect(pairReviewBody([{ by: 'Claude', text: '' }, { by: 'Codex', text: 'Only me.' }], null)).toBe('**Codex:** Only me.');
  });
  it('the pair footer counts as an auto post; each comment names who raised it', () => {
    expect(AUTO_POST_FOOTERS).toContain(PAIR_AUTO_POST_FOOTER);
    expect(hasAutoPostFooter(`x\n\n${PAIR_AUTO_POST_FOOTER}`)).toBe(true);
    expect(pairRaisedByLead('Codex')).toBe('_Raised by Codex._');
  });
});
