// CLAUDE + CODEX in the AI Review tab (docs/CLAUDE-REVIEW.md § Claude + Codex).
//
//   1. The menu offers "Claude + Codex" only while BOTH providers can review; picked, it is a pair on
//      Claude's default model; a provider signing out falls back to the opening choice.
//   2. The history groups a pair's two runs under one "Claude + Codex" header, the second marked
//      "after Claude"; every run is still listed once.
//   3. "Post both" is offered only on the pair's second half when both halves finished.
//   4. The progress line says which half is running.
//
// No JSX: this directory is plain `.ts`, so components are built with `createElement`.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend reviewPair
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AiKindStatus, AiRunKind, ClaudeReviewSummary, MeResponse } from '@pierre-review/shared';
import { PAIR_PICK_LABEL, PAIR_PICK_VALUE, pairRunningLabel, resolveReviewModelPick } from '../src/lib/modelPick.js';
import { canPostBoth, groupReviewHistory } from '../src/lib/reviewHistory.js';
import { ReviewHistoryList } from '../src/components/ReviewHistoryList.js';

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

describe('the history', () => {
  const first = run(10, { pair: { pairId: 10, role: 'first', otherReviewId: 11 } });
  const second = run(11, { provider: 'codex', model: 'gpt-6.1-sol', pair: { pairId: 10, role: 'second', otherReviewId: 10, dropped: 1 } });
  const history = [run(12), second, first, run(9)];

  it('groups a pair, first then second, at its newest half; every run once', () => {
    const g = groupReviewHistory(history);
    expect(g.map((e) => (e.kind === 'run' ? e.run.id : `pair:${e.first?.id},${e.second?.id}`))).toEqual([12, 'pair:10,11', 9]);
  });

  it('renders one "Claude + Codex" header, the second marked "after Claude"', () => {
    const html = renderToStaticMarkup(
      createElement(ReviewHistoryList, { history, shownId: 11, latestId: 12, onShow: () => {} }),
    );
    expect(html.match(/Claude \+ Codex/g)?.length).toBe(1);
    expect(html).toContain('after Claude');
    expect(html).toContain('All reviews of this PR (4)');
    expect(html.match(/data-review-run=/g)?.length).toBe(4);
  });

  it('"Post both" only on the second half, both finished', () => {
    expect(canPostBoth(second, history)).toBe(true);
    expect(canPostBoth(first, history)).toBe(false);
    expect(canPostBoth(second, [run(12), second, { ...first, status: 'failed' }])).toBe(false);
    expect(canPostBoth({ ...second, status: 'running' }, history)).toBe(false);
    expect(canPostBoth(run(12), history)).toBe(false);
  });
});

describe('the progress line', () => {
  it('says which half is running', () => {
    expect(pairRunningLabel('Claude', null)).toBe('Running Claude review');
    expect(pairRunningLabel('Claude', 'first')).toBe('Running Claude review, then Codex');
    expect(pairRunningLabel('Codex', 'second')).toBe('Running Codex review, after Claude');
  });
});
