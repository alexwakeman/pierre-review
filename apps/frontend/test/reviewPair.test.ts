// CLAUDE + CODEX in the AI Review tab (docs/CLAUDE-REVIEW.md § Claude + Codex).
//
//   1. The menu offers "Claude + Codex" only while BOTH providers can review; picked, it is a pair on
//      Claude's default model; a provider signing out falls back to the opening choice.
//   2. The history is a native select: a pair is ONE option (addressed by its latest half), replies
//      passes and every other run are listed; either half's id selects the pair's option.
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
import { historyOptionIdFor, reviewHistoryOptions } from '../src/lib/reviewHistory.js';
import { ReviewHistoryList } from '../src/components/ReviewHistoryList.js';
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
    expect(both.pair).toBe(false);
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

describe('the history select', () => {
  const first = run(10, { pair: { pairId: 10, role: 'first', otherReviewId: 11 } });
  const second = run(11, { provider: 'codex', model: 'gpt-6.1-sol', pair: { pairId: 10, role: 'second', otherReviewId: 10, dropped: 1 } });
  const replies = run(13, { kind: 'replies', findingCount: 0 });
  const history = [replies, run(12), second, first, run(9)];
  const when = (iso: string) => iso.slice(0, 10);

  it('lists a pair ONCE, at its newest half, addressed by its latest half; replies passes and every other run listed', () => {
    const opts = reviewHistoryOptions(history, 12, when);
    expect(opts.map((o) => o.id)).toEqual([13, 12, 11, 9]);
    expect(opts.find((o) => o.id === 11)).toMatchObject({ runIds: [11, 10], label: 'Claude + Codex · abcdef1 · 2026-10-27' });
    expect(opts[0]!.label).toBe('Replies checked · abcdef1 · 2026-10-27');
    expect(opts[1]!.label).toBe('Claude Opus 5.5 · abcdef1 · 2026-10-27 (latest)');
    // Either half's id picks the pair's option.
    expect(historyOptionIdFor(opts, 10)).toBe(11);
    expect(historyOptionIdFor(opts, 11)).toBe(11);
    expect(historyOptionIdFor(opts, 9)).toBe(9);
  });

  it('a pair in flight reads as running; a pair with no second half yet is still one option', () => {
    const running = reviewHistoryOptions([run(21, { status: 'running', pair: { pairId: 20, role: 'second', otherReviewId: 20 } }), run(20, { pair: { pairId: 20, role: 'first', otherReviewId: 21 } })], null, when);
    expect(running).toEqual([{ id: 21, runIds: [21, 20], label: 'Claude + Codex · abcdef1 · 2026-10-27 · Running' }]);
    const lone = reviewHistoryOptions([run(30, { status: 'running', pair: { pairId: 30, role: 'first', otherReviewId: null } })], null, when);
    expect(lone.map((o) => o.id)).toEqual([30]);
  });

  // The redesign swapped the native <select> for the custom Select (its options exist only while
  // open): the closed control is labelled "Showing" and shows the shown run's option — for the
  // first half of a pair, the pair's ONE option.
  it('renders the custom Select (labelled "Showing"), showing the shown run’s option', () => {
    const html = renderToStaticMarkup(
      createElement(ReviewHistoryList, { history, shownId: 10, latestId: 12, onShow: () => {} }),
    );
    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-label="Showing"');
    expect(html.match(/Claude \+ Codex/g)?.length).toBe(1);
    expect(html).toContain('Claude + Codex · abcdef1');
  });

  it('no select for a single review', () => {
    expect(renderToStaticMarkup(createElement(ReviewHistoryList, { history: [run(1)], shownId: 1, latestId: 1, onShow: () => {} }))).toBe('');
  });
});

describe('the progress line', () => {
  it('says which step a pair is on', () => {
    expect(pairRunningLabel('Claude', null)).toBe('Running Claude review');
    expect(pairRunningLabel('Claude', 'first', 'reviewing')).toBe('Claude reviewing…');
    expect(pairRunningLabel('Codex', 'second', 'reviewing')).toBe('Codex reviewing…');
    expect(pairRunningLabel('Codex', 'second', 'merging')).toBe('Merging the two reviews…');
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

  it('one header, both models, one summary, ONE findings list with a quiet source label on each', () => {
    const html = render(review());
    expect(html).toContain('Claude + Codex review');
    expect(html).toContain('Claude Opus 5.5 + Codex · GPT-6.1 Sol');
    expect(html.match(/The lookup can crash\./g)?.length).toBe(1);
    expect(html.match(/data-finding-source="/g)?.length).toBe(3);
    expect(html).toMatch(/data-finding-source="both"[^>]*>Claude \+ Codex</);
    expect(html).toMatch(/data-finding-source="claude"[^>]*>Claude</);
    expect(html).toMatch(/data-finding-source="codex"[^>]*>Codex</);
    // The source label is the same neutral 11px chip as the lens: no colour per provider.
    expect(html).toMatch(/class="rounded bg-gray-500\/10 px-1\.5 py-0\.5 text-\[11px\] text-gray-600 dark:text-gray-300" data-finding-source/);
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

  it('an ordinary run carries no source labels', () => {
    const html = render(review({ pair: null, findings: [{ ...finding(1, 11, undefined, 'nit', 'Rename x') }] }));
    expect(html).not.toContain('data-finding-source');
    expect(html).toContain('Codex&#x27;s review');
  });
});
