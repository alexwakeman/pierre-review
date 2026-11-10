// CLAUDE + CODEX in the AI Review tab (docs/CLAUDE-REVIEW.md § Claude + Codex).
//
//   1. The menu offers "Claude + Codex" only while BOTH providers can review; picked, it is a pair on
//      Claude's default model; a provider signing out falls back to the opening choice.
//   2. Reviews on this PR: a pair is ONE row (addressed by its latest half), replies passes and every
//      other run are listed; either half's id shows the pair's row.
//   3. The progress line says which step a pair is on (Claude, Codex, merging).
//   4. The consolidated review is ONE view: one header naming both models, one summary, one findings
//      list with a quiet source label on each, one line for a half that did not finish.
//
// No JSX: this directory is plain `.ts`, so components are built with `createElement`.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend reviewPair
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AiKindStatus, AiRunKind, ClaudeFinding, ClaudeReview, ClaudeReviewSummary, MeResponse } from '@pierre-review/shared';
import { PAIR_PICK_LABEL, PAIR_PICK_VALUE, pairRunningLabel, resolveReviewModelPick } from '../src/lib/modelPick.js';
import { itemShows, nowReviewKey, reviewListLine, reviewsOnPr } from '../src/lib/teamReview.js';
import { shortDayTime } from '../src/lib/claudeReviewColumn.js';
import { pairHalfFailedLine } from '@pierre-review/shared';
import { ReviewsOnPrSection } from '../src/components/TeamReviewLayout.js';
import { ClaudesReview } from '../src/components/ClaudeReviewTab.js';

const KINDS: AiRunKind[] = ['review', 'review_chat', 'fix', 'plan', 'complete'];
const kinds = (s: AiKindStatus): Record<AiRunKind, AiKindStatus> =>
  Object.fromEntries(KINDS.map((k) => [k, s])) as Record<AiRunKind, AiKindStatus>;

function me(o: { claude?: boolean; codex?: boolean }): MeResponse {
  const ok = { auth: 'ok' as const, message: null };
  const none = { auth: 'none' as const, message: 'no' };
  return {
    ai: {
      enabled: true,
      runtime: 'ready',
      runtimeMessage: null,
      auth: 'ok',
      authMessage: null,
      provider: 'claude',
      providerSetting: { value: 'auto', source: 'settings' },
      providers: {
        claude: { auth: o.claude ? 'ok' : 'none', route: o.claude ? 'login' : 'none', message: null, runtime: 'ready' },
        codex: {
          runtime: 'ready',
          runtimeMessage: null,
          auth: o.codex ? 'ok' : 'none',
          route: o.codex ? 'login' : 'none',
          signedIn: !!o.codex,
          plan: null,
          available: !!o.codex,
          message: null,
          kinds: kinds(o.codex ? ok : none),
        },
      },
    },
  } as unknown as MeResponse;
}

describe('the AI Review menu', () => {
  it('offers "Claude + Codex" only while both can review', () => {
    const both = resolveReviewModelPick(me({ claude: true, codex: true }), 'claude-opus-5-5', null);
    expect(both.pairOffered).toBe(true);
    expect(both.picks.at(-1)).toMatchObject({ value: PAIR_PICK_VALUE, label: PAIR_PICK_LABEL });
    // Nothing picked yet: Claude + Codex is the default while both can review.
    expect(both.pair).toBe(true);
    expect(both.chosen.value).toBe(PAIR_PICK_VALUE);
    // A model picked from the menu runs alone.
    expect(resolveReviewModelPick(me({ claude: true, codex: true }), 'claude-opus-5-5', 'claude:claude-opus-5-5').pair).toBe(false);
    for (const one of [me({ claude: true }), me({ codex: true }), me({})]) {
      const s = resolveReviewModelPick(one, 'claude-opus-5-5', null);
      expect(s.pairOffered).toBe(false);
      expect(s.picks.some((p) => p.value === PAIR_PICK_VALUE)).toBe(false);
    }
  });

  it('picked, it is a pair on Claude’s default model; a sign-out falls back to the opening choice', () => {
    const s = resolveReviewModelPick(me({ claude: true, codex: true }), 'claude-opus-5-5', PAIR_PICK_VALUE);
    expect(s.pair).toBe(true);
    expect(s.chosen).toMatchObject({ provider: 'claude', model: 'claude-opus-5-5', label: 'Claude + Codex' });
    const gone = resolveReviewModelPick(me({ claude: true }), 'claude-opus-5-5', PAIR_PICK_VALUE);
    expect(gone.pair).toBe(false);
    expect(gone.chosen.value).toBe('claude:claude-opus-5-5');
  });
});

const run = (id: number, o: Partial<ClaudeReviewSummary> = {}): ClaudeReviewSummary => ({
  id,
  headSha: 'abcdef1234',
  status: 'succeeded',
  model: 'claude-opus-5-5',
  provider: 'claude',
  scope: 'diff_only',
  reviewMode: 'diff_only',
  verdict: 'COMMENT',
  userVerdict: null,
  costUsd: null,
  postedAt: null,
  createdAt: '2026-10-27T10:00:00Z',
  finishedAt: '2026-10-27T10:05:00Z',
  findingCount: 1,
  ...o,
});

describe('reviews on this PR', () => {
  const first = run(10, { pair: { pairId: 10, role: 'first', otherReviewId: 11 } });
  const second = run(11, { provider: 'codex', model: 'gpt-6.1-sol', pair: { pairId: 10, role: 'second', otherReviewId: 10, dropped: 1 } });
  const replies = run(13, { kind: 'replies', findingCount: 0 });
  const history = [replies, run(12), second, first, run(9)];

  it('lists a pair ONCE, at its newest half, addressed by its latest half; replies passes and every other run listed', () => {
    const items = reviewsOnPr(history, []);
    expect(items.map((i) => i.target)).toEqual([13, 12, 11, 9].map((id) => ({ kind: 'own', id })));
    expect(items.find((i) => i.runIds.includes(10))).toMatchObject({ runIds: [11, 10], what: 'Claude + Codex' });
    expect(reviewListLine(items[0]!)).toBe(`${shortDayTime(items[0]!.at)} · abcdef1 · Replies checked`);
    expect(shortDayTime(items[0]!.at)).toMatch(/^27 Oct \d{2}:\d{2}$/);
    // Either half's id shows the pair's row.
    const pair = items.find((i) => i.what === 'Claude + Codex')!;
    expect(itemShows(pair, { kind: 'own', id: 10 })).toBe(true);
    expect(itemShows(pair, { kind: 'own', id: 11 })).toBe(true);
  });

  it('a pair in flight reads as running; a pair with no second half yet is still one row', () => {
    const running = reviewsOnPr([run(21, { status: 'running', pair: { pairId: 20, role: 'second', otherReviewId: 20 } }), run(20, { pair: { pairId: 20, role: 'first', otherReviewId: 21 } })], []);
    expect(running.map((i) => [i.runIds, reviewListLine(i)])).toEqual([[[21, 20], `Running · ${shortDayTime(running[0]!.at)} · abcdef1 · Claude + Codex`]]);
    const lone = reviewsOnPr([run(30, { status: 'running', pair: { pairId: 30, role: 'first', otherReviewId: null } })], []);
    expect(lone.map((i) => i.runIds)).toEqual([[30]]);
  });

  it('renders one button per review, the latest FULL review current; nothing but the count for a single review', () => {
    const qc = new QueryClient();
    const render = (items: ReturnType<typeof reviewsOnPr>, nowKey: string | null) =>
      renderToStaticMarkup(
        createElement(QueryClientProvider, { client: qc }, createElement(ReviewsOnPrSection, { items, nowKey, shown: null, countLine: null, onShow: () => {} })),
      );
    const items = reviewsOnPr(history, []);
    // The replies pass (13) is listed first, but now is the latest full review (12).
    const now = nowReviewKey(items, 12);
    expect(now).toBe('own-12');
    const html = render(items, now);
    expect(html).toContain('Reviews on this PR');
    expect(html.match(/<button/g)?.length).toBeGreaterThanOrEqual(4);
    expect(html.match(/aria-current="true"/g)?.length).toBe(1);
    const buttons = html.split('<li>').slice(1);
    expect(buttons[0]).not.toContain('aria-current');
    expect(buttons[1]).toContain('aria-current="true"');
    expect(render(reviewsOnPr([run(1)], []), 'own-1')).toBe('');
  });

  it('now is found by identity: a pair by either half; with no review of the reader’s, the newest teammate review', () => {
    const items = reviewsOnPr(history, []);
    expect(nowReviewKey(items, 10)).toBe(items.find((i) => i.runIds.includes(11))!.key);
    expect(nowReviewKey(items, 999)).toBeNull();
    expect(nowReviewKey([], null)).toBeNull();
  });
});

describe('the progress line', () => {
  it('says which step a pair is on', () => {
    expect(pairRunningLabel('Claude', null)).toBe('Running Claude review');
    expect(pairRunningLabel('Claude', 'first', 'reviewing')).toBe('Claude reviewing…');
    expect(pairRunningLabel('Codex', 'second', 'reviewing')).toBe('Codex reviewing…');
    expect(pairRunningLabel('Codex', 'second', 'merging')).toBe('Merging the two reviews…');
    expect(pairRunningLabel('Claude', 'first', 'reviewing', true)).toBe('Claude and Codex reviewing…');
    expect(pairRunningLabel('Claude', 'first', 'merging', true)).toBe('Merging the two reviews…');
  });
});

describe('the consolidated review (one view)', () => {
  const finding = (id: number, reviewId: number, source: ClaudeFinding['source'], severity: ClaudeFinding['severity'], title: string): ClaudeFinding => ({
    id, reviewId, path: 'src/a.ts', line: id, side: 'RIGHT', diffAnchorId: 'x', severity, title, body: `${title}.`, editedBody: null,
    suggestion: null, diffHunk: null, anchored: true, fileInDiff: true, included: true, postedAt: null, githubCommentId: null,
    postedCommentKind: null, createdAt: '2026-10-27T10:00:00Z', source,
  });
  const review = (o: Partial<ClaudeReview> = {}): ClaudeReview => ({
    id: 11, prId: 5, headSha: 'abcdef1234', status: 'succeeded', model: 'gpt-6.1-sol', provider: 'codex', scope: 'diff_only',
    reviewMode: 'diff_only', routeReason: null, summary: 'The lookup can crash.', verdict: 'REQUEST_CHANGES', userBody: null,
    userVerdict: null, costUsd: null, inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheCreationTokens: null,
    numTurns: null, diffBytes: null, diffCapped: null, error: null, excludedFiles: [], postedReviewId: null, postedAt: null,
    createdAt: '2026-10-27T10:00:00Z', finishedAt: '2026-10-27T10:05:00Z',
    findings: [
      finding(1, 10, 'claude', 'nit', 'Rename x'),
      finding(2, 11, 'both', 'blocker', 'Missing null guard'),
      finding(3, 11, 'codex', 'warning', 'Slow loop'),
    ],
    pair: {
      pairId: 10, role: 'second', otherReviewId: 10, how: 'pass', failedHalf: null, verdict: 'REQUEST_CHANGES',
      halves: [
        { reviewId: 10, provider: 'claude', model: 'claude-opus-5-5', effort: null, status: 'succeeded', costUsd: null, inputTokens: null, outputTokens: null },
        { reviewId: 11, provider: 'codex', model: 'gpt-6.1-sol', effort: null, status: 'succeeded', costUsd: null, inputTokens: null, outputTokens: null },
      ],
    },
    ...o,
  });
  const render = (r: ClaudeReview): string =>
    renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(ClaudesReview, {
          review: r, editable: true, prUrl: 'https://github.com/acme/api/pull/5', repoFullName: 'acme/api', prHeadSha: 'abcdef1234',
          postingFindingId: null, postErrorFindingId: null, postErrorMessage: null, changedPaths: new Set<string>(),
          onToggleFinding: () => {}, onRewordFinding: async () => {}, onPostFinding: async () => {},
          storyCheck: () => null, ciCheck: null,
        }),
      ),
    );

  it('one "Summary" header (no run name, no "reviewed … ago"), one summary, ONE findings list with a quiet source label on each', () => {
    const html = render(review());
    expect(html).toContain('>Summary</h3>');
    expect(html).not.toContain('Claude + Codex review');
    expect(html).not.toMatch(/reviewed .* ago/);
    // Both models are behind the header's ⓘ, never on the page.
    expect(html).not.toContain('Claude Opus 5.5 + Codex · GPT-6.1 Sol');
    expect(html.match(/The lookup can crash\./g)?.length).toBe(1);
    expect(html.match(/data-finding-source="/g)?.length).toBe(3);
    expect(html).toMatch(/data-finding-source="both"[^>]*>Claude \+ Codex</);
    expect(html).toMatch(/data-finding-source="claude"[^>]*>Claude</);
    expect(html).toMatch(/data-finding-source="codex"[^>]*>Codex</);
    // The source label is the same neutral 11px chip as the lens: no colour per provider.
    expect(html).toMatch(/class="rounded-ui bg-ui-raise px-1\.5 py-0\.5 text-meta text-ui-mute" data-finding-source/);
    // One list (never a grouped view per half), and the consolidation is not narrated.
    expect(html.match(/id="claude-finding-/g)?.length).toBe(3);
    expect(html).not.toMatch(/consolidat|merged by/i);
    expect(html).not.toContain('data-pair-failed-half');
  });

  it('a half that did not finish: one plain line under the header', () => {
    const html = render(
      review({
        findings: [finding(1, 10, 'claude', 'nit', 'Rename x')],
        pair: { ...review().pair!, how: 'single', failedHalf: { provider: 'codex', reason: 'usage limit reached' } },
      }),
    );
    expect(html).toMatch(/data-pair-failed-half="true">Codex didn&#x27;t finish: usage limit reached</);
  });

  it('PR 221272: the failed half reads its lead ONCE ("Codex didn’t finish: you’ve hit your usage limit")', () => {
    expect(pairHalfFailedLine({ provider: 'codex', reason: 'Codex could not finish: You’ve hit your usage limit' })).toBe(
      'Codex didn\'t finish: you’ve hit your usage limit',
    );
    expect(pairHalfFailedLine({ provider: 'claude', reason: 'Claude didn’t finish. The run was cancelled.' })).toBe(
      'Claude didn\'t finish: the run was cancelled.',
    );
    // A reason that names something else keeps its capital; one without the lead is kept as it is.
    expect(pairHalfFailedLine({ provider: 'codex', reason: 'Codex took too long and was stopped.' })).toBe(
      'Codex didn\'t finish: Codex took too long and was stopped.',
    );
    expect(pairHalfFailedLine({ provider: 'codex', reason: 'GitHub refused the request' })).toBe('Codex didn\'t finish: GitHub refused the request');
    expect(pairHalfFailedLine({ provider: 'codex', reason: 'Codex could not finish:' })).toBe('Codex didn\'t finish: no reason given');
  });

  it('the reader\'s OWN PR: a finding already on GitHub offers no "Post reminder"', () => {
    const posted = { ...finding(1, 11, undefined, 'warning', 'Rename x'), postedAt: '2026-10-27T10:06:00Z', githubCommentId: '77', postedCommentKind: 'inline' as const };
    const withProps = (ownPr: boolean): string =>
      renderToStaticMarkup(
        createElement(
          QueryClientProvider,
          { client: new QueryClient() },
          createElement(ClaudesReview, {
            review: review({ pair: null, findings: [posted] }), editable: true, prUrl: 'https://github.com/acme/api/pull/5', repoFullName: 'acme/api',
            prHeadSha: 'abcdef1234', postingFindingId: null, postErrorFindingId: null, postErrorMessage: null, changedPaths: new Set<string>(),
            onToggleFinding: () => {}, onRewordFinding: async () => {}, onPostFinding: async () => {},
            storyCheck: () => null, ciCheck: null, ownPr,
          }),
        ),
      );
    expect(withProps(false)).toContain('Post reminder');
    expect(withProps(true)).not.toContain('Post reminder');
  });

  it('an ordinary run carries no source labels', () => {
    const html = render(review({ pair: null, findings: [{ ...finding(1, 11, undefined, 'nit', 'Rename x') }] }));
    expect(html).not.toContain('data-finding-source');
    expect(html).not.toContain('Codex&#x27;s review');
    expect(html).toContain('>Summary</h3>');
  });
});
