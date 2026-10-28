// THE PER-RUN MODEL MENU AND THE FULL REVIEW HISTORY (docs/CODEX-PLAN.md § 6, revised 2026-10-26).
//
//   1. The model menu of a manual surface (AI Review, AI Fix) lists the models of EVERY provider that
//      can run its kind — both only when both are set up and signed in — the DEFAULT provider's
//      (Settings → AI) first, opening on its model at the surface's usual depth; with one provider it
//      is the menu it always was. A pick of a provider that stops being ready falls back.
//   2. The follow-up rule (chat, plan passes): the stored run's provider while it is ready, else the default.
//   3. The AI Review tab lists EVERY run (all providers, all heads) and the shown run never moves on its
//      own — except to a run the reader just started.
//
// No JSX: this directory is plain `.ts`, so components are built with `createElement`.
//
// Run from the workspace that HAS vitest:
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend perRunModelPicker
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AiKindStatus, AiRunKind, ClaudeReviewSummary, MeResponse } from '@pierre-review/shared';
import { aiGateReadyFor, aiRunnableProviders, aiProviderReadyFor } from '../src/lib/aiCapabilities.js';
import { followUpProviderOf, resolveModelPick } from '../src/lib/modelPick.js';
import { nextShownReviewId } from '../src/lib/reviewHistory.js';
import { ReviewHistoryList } from '../src/components/ReviewHistoryList.js';

const KINDS: AiRunKind[] = ['review', 'review_chat', 'fix', 'plan', 'complete'];
const kinds = (s: AiKindStatus): Record<AiRunKind, AiKindStatus> =>
  Object.fromEntries(KINDS.map((k) => [k, s])) as Record<AiRunKind, AiKindStatus>;

function me(o: { def?: 'claude' | 'codex'; claude?: boolean; codex?: boolean; codexNoPlan?: boolean }): MeResponse {
  const ok = { auth: 'ok' as const, message: null };
  const none = { auth: 'none' as const, message: 'no' };
  const codexKinds = kinds(o.codex ? ok : none);
  if (o.codexNoPlan) codexKinds.plan = none;
  return {
    ai: {
      enabled: true,
      runtime: 'ready',
      runtimeMessage: null,
      auth: 'ok',
      authMessage: null,
      provider: o.def ?? 'claude',
      providerSetting: { value: o.def ?? 'auto', source: 'settings' },
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
          kinds: codexKinds,
        },
      },
    },
  } as unknown as MeResponse;
}

describe('the per-run model menu', () => {
  it('one provider signed in ⇒ the menu it always was (that provider only)', () => {
    const claudeOnly = resolveModelPick(me({ claude: true }), 'review', 'claude-opus-5-5', null);
    expect(claudeOnly.picks.map((p) => p.label)).toEqual(['Claude Opus 5.5 (most thorough)', 'Claude Sonnet 5 (best value)']);
    expect(claudeOnly.mixed).toBe(false);
    expect(claudeOnly.chosen).toMatchObject({ provider: 'claude', model: 'claude-opus-5-5' });

    const codexOnly = resolveModelPick(me({ def: 'codex', codex: true }), 'review', 'claude-opus-5-5', null);
    expect(codexOnly.picks.map((p) => p.label)).toEqual([
      'Codex · GPT-6.1 Sol (most thorough)',
      'Codex · GPT-6.1 Terra (best value)',
    ]);
    expect(codexOnly.chosen).toMatchObject({ provider: 'codex', model: 'gpt-6.1-sol' });
  });

  it('both signed in ⇒ both providers listed, the default first, opening on its model', () => {
    const both = resolveModelPick(me({ claude: true, codex: true }), 'review', 'claude-opus-5-5', null);
    expect(both.mixed).toBe(true);
    expect(both.picks.map((p) => p.value)).toEqual([
      'claude:claude-opus-5-5',
      'claude:claude-sonnet-5',
      'codex:gpt-6.1-sol',
      'codex:gpt-6.1-terra',
    ]);
    expect(both.chosen.value).toBe('claude:claude-opus-5-5');
    // The default is Codex: Codex leads and opens.
    const codexFirst = resolveModelPick(me({ def: 'codex', claude: true, codex: true }), 'fix', 'claude-opus-5-5', null);
    expect(codexFirst.picks[0]!.provider).toBe('codex');
    expect(codexFirst.chosen.value).toBe('codex:gpt-6.1-sol');
  });

  it('a pick sticks while its provider is ready, and falls back to the opening choice when it is not', () => {
    const picked = 'codex:gpt-6.1-terra';
    expect(resolveModelPick(me({ claude: true, codex: true }), 'review', 'claude-opus-5-5', picked).chosen).toMatchObject({
      provider: 'codex',
      model: 'gpt-6.1-terra',
    });
    expect(resolveModelPick(me({ claude: true }), 'review', 'claude-opus-5-5', picked).chosen.value).toBe(
      'claude:claude-opus-5-5',
    );
  });

  it('a provider is listed only for the kinds it can run, with its own download ready', () => {
    const m = me({ claude: true, codex: true, codexNoPlan: true });
    expect(aiRunnableProviders(m, 'fix')).toEqual(['claude', 'codex']);
    expect(aiRunnableProviders(m, 'plan')).toEqual(['claude']);
    const noClaudeSdk = me({ def: 'codex', claude: true, codex: true });
    noClaudeSdk.ai.providers.claude.runtime = 'absent';
    expect(aiRunnableProviders(noClaudeSdk, 'review')).toEqual(['codex']);
    expect(aiProviderReadyFor(me({}), 'claude', 'review')).toBe(false);
  });

  it('nobody ready ⇒ the default provider’s own models (the gate shows its sign-in line)', () => {
    const none = resolveModelPick(me({}), 'review', 'claude-opus-5-5', null);
    expect(none.picks.every((p) => p.provider === 'claude')).toBe(true);
  });
});

describe('the follow-up rule (the chat on its review, another plan pass)', () => {
  it("the stored run's provider while it is ready, else the default", () => {
    expect(followUpProviderOf(me({ claude: true, codex: true }), 'codex', 'review_chat')).toBe('codex');
    expect(followUpProviderOf(me({ claude: true }), 'codex', 'review_chat')).toBe('claude');
    expect(followUpProviderOf(me({ def: 'codex', codex: true, claude: true }), 'claude', 'plan')).toBe('claude');
    expect(followUpProviderOf(me({ def: 'codex', codex: true }), null, 'plan')).toBe('codex');
  });
});

describe('the Run gate of a follow-up', () => {
  // ⚠ The bug: the chat gate used "any provider ready". Default Claude (signed out), Codex signed in,
  // a Claude-run review: the chat runs on Claude (the follow-up rule's fallback) and failed with "Claude
  // did not answer", where the gate used to show the sign-in line. A follow-up gate reads ITS provider.
  it('is ready only when the provider the follow-up runs on can run it', () => {
    const m = me({ def: 'claude', codex: true });
    const chatOn = followUpProviderOf(m, 'claude', 'review_chat');
    expect(chatOn).toBe('claude');
    expect(aiGateReadyFor(m, { kind: 'review_chat', followUp: true, provider: chatOn })).toBe(false);
    // The picker surface (a new run) is still ready: its menu offers Codex.
    expect(aiGateReadyFor(m, { kind: 'review', anyProvider: true, provider: 'codex' })).toBe(true);
    // A Codex review, Codex signed in: the chat runs on Codex and the gate says so.
    expect(aiGateReadyFor(m, { kind: 'review_chat', followUp: true, provider: followUpProviderOf(m, 'codex', 'review_chat') })).toBe(true);
    // Plan pass and build: the same rule.
    expect(aiGateReadyFor(m, { kind: 'plan', followUp: true, provider: followUpProviderOf(m, 'claude', 'plan') })).toBe(false);
    expect(aiGateReadyFor(m, { kind: 'fix', followUp: true, provider: followUpProviderOf(m, 'codex', 'fix') })).toBe(true);
  });
  it('falls back to the default provider’s own checks when no rule applies', () => {
    expect(aiGateReadyFor(me({ claude: true }), { kind: 'review' })).toBeNull();
    expect(aiGateReadyFor(me({}), { kind: 'review', anyProvider: true })).toBeNull();
    expect(aiGateReadyFor(me({ claude: true }), { followUp: true, provider: 'claude' })).toBeNull();
  });
});

const run = (id: number, over: Partial<ClaudeReviewSummary> = {}): ClaudeReviewSummary => ({
  id,
  headSha: `${id}`.repeat(40).slice(0, 40),
  status: 'succeeded',
  model: 'claude-opus-5-5',
  provider: 'claude',
  scope: 'diff_only',
  reviewMode: 'diff_only',
  verdict: 'COMMENT',
  userVerdict: null,
  costUsd: null,
  postedAt: null,
  createdAt: '2026-10-26T10:00:00.000Z',
  finishedAt: '2026-10-26T10:05:00.000Z',
  trigger: 'manual',
  findingCount: 2,
  ...over,
});

describe('which run the AI Review tab shows', () => {
  const history = [run(3, { provider: 'codex', model: 'gpt-6.1-sol' }), run(2), run(1)];

  it('opens on the latest run', () => {
    expect(nextShownReviewId({ shown: null, latest: { id: 3, status: 'succeeded' }, previousLatestId: null, history })).toBe(3);
  });

  it('keeps the reader’s pick when the latest run finishes or an auto run starts', () => {
    // The reader picked run 1; the latest (3) finishes.
    expect(nextShownReviewId({ shown: 1, latest: { id: 3, status: 'succeeded' }, previousLatestId: 3, history })).toBe(1);
    // An AUTO run (4) starts on top: nothing moves, and it never blanks the pane.
    const withAuto = [run(4, { status: 'running', trigger: 'auto' }), ...history];
    expect(
      nextShownReviewId({ shown: 3, latest: { id: 4, status: 'running', trigger: 'auto' }, previousLatestId: 3, history: withAuto }),
    ).toBe(3);
    // …and when it finishes, the reader still sees the run they were reading.
    expect(
      nextShownReviewId({ shown: 3, latest: { id: 4, status: 'succeeded', trigger: 'auto' }, previousLatestId: 4, history: withAuto }),
    ).toBe(3);
  });

  it('a run the reader starts becomes the shown run', () => {
    const started = [run(4, { status: 'queued', provider: 'codex', model: 'gpt-6.1-sol' }), ...history];
    expect(
      nextShownReviewId({ shown: 1, latest: { id: 4, status: 'queued', trigger: 'manual' }, previousLatestId: 3, history: started }),
    ).toBe(4);
  });

  it('opening while an auto run is in flight shows the newest FINISHED run', () => {
    const withAuto = [run(4, { status: 'running', trigger: 'auto' }), ...history];
    expect(
      nextShownReviewId({ shown: null, latest: { id: 4, status: 'running', trigger: 'auto' }, previousLatestId: null, history: withAuto }),
    ).toBe(3);
  });
});

describe('the history select', () => {
  const history = [
    run(3, { provider: 'codex', model: 'gpt-6.1-sol', trigger: 'auto', findingCount: 1, verdict: 'REQUEST_CHANGES' }),
    run(2, { status: 'failed', verdict: null, findingCount: 0 }),
    run(1, { model: 'claude-sonnet-5', findingCount: 0, headSha: 'abcdef1234'.padEnd(40, '0') }),
  ];
  const html = renderToStaticMarkup(
    createElement(ReviewHistoryList, { history, shownId: 1, latestId: 3, onShow: () => {} }),
  );

  it('lists every run, every provider, newest first, each with what ran, its head, status and Auto', () => {
    expect(html.match(/<option /g)).toHaveLength(3);
    expect(html.indexOf('value="3"')).toBeLessThan(html.indexOf('value="1"'));
    expect(html).toContain('Codex · GPT-6.1 Sol');
    expect(html).toContain('Auto review');
    expect(html).toContain('Failed');
    expect(html).toContain('Claude Sonnet 5');
    expect(html).toContain('abcdef1');
    expect(html).toContain('(latest)');
  });

  it('selects the shown run, and only it', () => {
    expect(html.match(/selected=""/g)).toHaveLength(1);
    expect(html).toMatch(/<option value="1"[^>]*selected=""/);
  });
});
