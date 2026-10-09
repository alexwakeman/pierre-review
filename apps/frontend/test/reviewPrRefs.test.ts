// PR REFERENCES IN THE REVIEW TAB → THAT PR IN LIMN (lib/reviewPrRefs.ts + its wiring).
//
//   1. PARSING: "owner/repo#N", "repo#N" and "#N" are refs; paths, URL fragments, HTML entities
//      and words that merely contain "#" are not.
//   2. RESOLUTION: on-screen PRs first; a qualified ref never falls back to another repo's number;
//      a bare name resolves only when unambiguous; the rest go in ONE sorted, capped batch.
//   3. MARKDOWN: the rehype plugin marks refs in text, never inside links or code.
//   4. THE WIRING: one provider per tab, chat under Story check and open, summaries as markdown.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/reviewPrRefs.test.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PR_REF_RESOLVE_MAX } from '@pierre-review/shared';
import {
  buildPrRefIndex,
  parsePrRefs,
  queryFor,
  refsToResolve,
  rehypeReviewPrRefs,
  resolvePrRef,
  serverIndex,
  splitPrRefs,
  type KnownPr,
} from '../src/lib/reviewPrRefs.js';

const refs = (t: string) => parsePrRefs(t).map((m) => `${m.repo ?? ''}#${m.number}@${t.slice(m.start, m.end)}`);

describe('parsePrRefs', () => {
  it('finds the three spellings', () => {
    expect(refs('Covered by bng-library#66, merged.')).toEqual(['bng-library#66@bng-library#66']);
    expect(refs('See acme/api#12 and (#352).')).toEqual(['acme/api#12@acme/api#12', '#352@#352']);
    expect(refs('#7 first')).toEqual(['#7@#7']);
  });

  it('ignores what only looks like one', () => {
    expect(refs('src/a.ts#L12')).toEqual([]);
    expect(refs('https://github.com/a/b/pull/3#issuecomment-9')).toEqual([]);
    expect(refs('it&#39;s')).toEqual([]);
    expect(refs('x#12y')).toEqual([]);
    expect(refs('C##3 ##4')).toEqual([]);
    // Sentence punctuation is not part of a repo name.
    expect(refs('see api.#3')).toEqual([]);
  });

  it('splits text around refs, losslessly', () => {
    const t = 'Done in web#4 and #5.';
    const parts = splitPrRefs(t);
    expect(parts.map((p) => (typeof p === 'string' ? p : t.slice(p.start, p.end))).join('')).toBe(t);
    expect(parts.filter((p) => typeof p !== 'string')).toHaveLength(2);
  });
});

const known: KnownPr[] = [
  { prId: 1, repoFullName: 'acme/web', number: 4, title: 'Web' },
  { prId: 2, repoFullName: 'acme/bng-library', number: 66, title: 'Engine fix' },
];

describe('resolution', () => {
  const index = buildPrRefIndex('acme/web', known);

  it('resolves on-screen PRs without asking the server', () => {
    expect(resolvePrRef({ repo: 'bng-library', number: 66 }, index, null)?.prId).toBe(2);
    expect(resolvePrRef({ repo: 'ACME/web', number: 4 }, index, null)?.prId).toBe(1);
    expect(resolvePrRef({ repo: null, number: 4 }, index, null)?.prId).toBe(1);
    expect(refsToResolve(['bng-library#66 and #4'], index)).toEqual([]);
  });

  it('asks for the rest in one sorted, deduplicated batch, qualified where the screen can', () => {
    expect(refsToResolve(['#9, web#9, other#3', 'x/y#1', null, 'web#9'], index)).toEqual([
      { repo: 'acme/web', number: 9 },
      { repo: 'other', number: 3 },
      { repo: 'x/y', number: 1 },
    ]);
    const many = Array.from({ length: PR_REF_RESOLVE_MAX + 5 }, (_, i) => `#${i + 100}`).join(' ');
    expect(refsToResolve([many], index)).toHaveLength(PR_REF_RESOLVE_MAX);
  });

  it('uses the server answer, and a miss stays a miss', () => {
    const server = serverIndex([
      { repo: 'other', number: 3, prId: 30, repoFullName: 'zed/other', title: 'T' },
      { repo: 'x/y', number: 1, prId: null, repoFullName: null, title: null },
    ]);
    expect(resolvePrRef({ repo: 'other', number: 3 }, index, server)?.prId).toBe(30);
    expect(resolvePrRef({ repo: 'x/y', number: 1 }, index, server)).toBeNull();
    // Not asked yet ⇒ undefined (still a candidate), never a guess.
    expect(resolvePrRef({ repo: 'never', number: 1 }, index, server)).toBeUndefined();
  });

  it('never lets a qualified ref fall back to another repo, nor an ambiguous bare name resolve', () => {
    expect(resolvePrRef({ repo: 'beta/web', number: 4 }, index, null)).toBeUndefined();
    const two = buildPrRefIndex(null, [...known, { prId: 9, repoFullName: 'beta/web', number: 4, title: null }]);
    expect(queryFor({ repo: 'web', number: 4 }, two)).toEqual({ repo: 'web', number: 4 });
    expect(resolvePrRef({ repo: 'web', number: 4 }, two, null)).toBeUndefined();
    // No viewed repo ⇒ a bare "#N" names nothing.
    expect(resolvePrRef({ repo: null, number: 4 }, two, null)).toBeNull();
  });

  it('resolves a shared bare name when only one of its repos has that number on screen', () => {
    const split = buildPrRefIndex('acme/web', [...known, { prId: 9, repoFullName: 'beta/web', number: 7, title: null }]);
    expect(resolvePrRef({ repo: 'web', number: 7 }, split, null)?.prId).toBe(9);
    expect(resolvePrRef({ repo: 'web', number: 4 }, split, null)?.prId).toBe(1);
    // Neither has #5 on screen ⇒ still the bare name for the server, which refuses an ambiguity.
    expect(queryFor({ repo: 'web', number: 5 }, split)).toEqual({ repo: 'web', number: 5 });
  });
});

describe('rehypeReviewPrRefs', () => {
  type N = { type: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: N[] };
  const text = (value: string): N => ({ type: 'text', value });
  const el = (tagName: string, children: N[]): N => ({ type: 'element', tagName, properties: {}, children });

  it('marks refs in text, and leaves links and code alone', () => {
    const tree: N = {
      type: 'root',
      children: [
        el('p', [text('Fixed in api#3 — see '), el('a', [text('web#4')]), text('.')]),
        el('p', [el('code', [text('x#5')])]),
        el('pre', [el('code', [text('#6')])]),
      ],
    };
    rehypeReviewPrRefs()(tree as never);
    const p = tree.children![0]!;
    expect(p.children!.map((c) => c.tagName ?? c.value)).toEqual(['Fixed in ', 'a', ' — see ', 'a', '.']);
    expect(p.children![1]!.properties).toEqual({ dataPrRepo: 'api', dataPrNumber: '3' });
    expect(p.children![1]!.children![0]!.value).toBe('api#3');
    // The existing link is untouched (no data attributes added inside it).
    expect(p.children![3]!.children).toEqual([text('web#4')]);
    expect(tree.children![1]!.children![0]!.children).toEqual([text('x#5')]);
    expect(tree.children![2]!.children![0]!.children).toEqual([text('#6')]);
  });
});

describe('the Review tab wiring', () => {
  const src = (p: string) => readFileSync(join(__dirname, '..', 'src', p), 'utf8');
  const tab = src('components/ClaudeReviewTab.tsx');

  it('wraps the tab in ONE provider and renders the summary and findings as linked markdown', () => {
    expect(tab.match(/<ReviewTabPrRefs /g)).toHaveLength(1);
    expect(tab).toContain('<Markdown prRefs>{review.summary}</Markdown>');
    expect(tab).toContain('<Markdown prRefs>{finding.body}</Markdown>');
  });

  it('puts Review chat directly under Story check', () => {
    const story = tab.indexOf('{storyCheck({');
    const chat = tab.indexOf('<ReviewChatSection reviewId={chatReviewId} prId={review.prId} />');
    const findings = tab.indexOf('title="Findings"');
    expect(findings).toBeGreaterThan(0);
    expect(story).toBeGreaterThan(findings);
    expect(chat).toBeGreaterThan(story);
  });

  it('opens the review chat by default', () => {
    expect(src('components/ClaudeReviewChat.tsx')).toMatch(
      /export function ReviewChatSection[\s\S]*?useState\(true\)/,
    );
  });

  it('renders the ticket summary as markdown and draws Story check with the shared type scale', () => {
    // The result pieces are shared by the pane and the Open PRs stack (TicketReviewParts.tsx).
    const tc = src('components/TicketReviewParts.tsx');
    expect(tc).toContain('<Markdown prRefs>{a.summary}</Markdown>');
    expect(tc).toContain('REVIEW_ITEM_CARD');
    expect(tc).toContain('REVIEW_PROSE');
    // The old 12px grey prose is gone from every section.
    for (const f of [
      'components/TicketCoverage.tsx',
      'components/TicketReviewParts.tsx',
      'components/Activity/StackStoryCheck.tsx',
      'components/ClaudeReviewThreads.tsx',
      'components/ClaudeReviewCiFailures.tsx',
      'components/ClaudeReviewFollowUp.tsx',
    ]) {
      expect(src(f)).not.toContain('break-words text-xs text-gray-700 dark:text-gray-300');
    }
  });

  it('the resolver is one batched request through the client', () => {
    const p = src('components/ReviewPrRefs.tsx');
    expect(p.match(/api\.resolvePrRefs\(/g)).toHaveLength(1);
    expect(src('api/client.ts')).toContain("'/api/prs/resolve'");
  });
});
