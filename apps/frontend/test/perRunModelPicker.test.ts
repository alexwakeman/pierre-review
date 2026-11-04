// THE PER-RUN MODEL MENU (docs/CODEX-PLAN.md § 6, revised 2026-10-26).
//
//   1. The model menu of a manual surface (AI Review, AI Fix) lists the models of EVERY provider that
//      can run its kind — both only when both are set up and signed in — the DEFAULT provider's
//      (Settings → AI) first, opening on its model at the surface's usual depth; with one provider it
//      is the menu it always was. A pick of a provider that stops being ready falls back.
//   2. The follow-up rule (chat, plan passes): the stored run's provider while it is ready, else the default.
//   (The AI Review tab's list of every review and which one shows: test/teamReview.test.ts.)
//
// Run from the workspace that HAS vitest:
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend perRunModelPicker
import { describe, expect, it } from 'vitest';
import type { AiKindStatus, AiRunKind, MeResponse } from '@pierre-review/shared';
import { aiGateReadyFor, aiRunnableProviders, aiProviderReadyFor } from '../src/lib/aiCapabilities.js';
import { chatPreferredProviderOf, followUpProviderOf, resolveModelPick } from '../src/lib/modelPick.js';

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

// A CLAUDE + CODEX PAIR'S CHAT (the server's rule, review/claude-review/chat.ts `chatPreferredProvider`):
// the default provider when its half succeeded, else the half that did; the header names it.
describe('chatPreferredProviderOf', () => {
  const pair = (halves: Array<['claude' | 'codex', 'succeeded' | 'failed']>) =>
    ({ provider: 'codex', model: 'gpt-6.1-sol', pair: { halves: halves.map(([provider, status]) => ({ provider, status })) } }) as never;
  it('a pair: the default provider when its half succeeded, else the half that did', () => {
    const both = me({ def: 'claude', claude: true, codex: true });
    expect(chatPreferredProviderOf(both, pair([['claude', 'succeeded'], ['codex', 'succeeded']]))).toBe('claude');
    expect(chatPreferredProviderOf(me({ def: 'codex', claude: true, codex: true }), pair([['claude', 'succeeded'], ['codex', 'succeeded']]))).toBe('codex');
    expect(chatPreferredProviderOf(both, pair([['claude', 'failed'], ['codex', 'succeeded']]))).toBe('codex');
    // Then the follow-up rule checks it can answer (Codex signed out ⇒ the default answers).
    const claudeOnly = me({ def: 'claude', claude: true });
    expect(followUpProviderOf(claudeOnly, chatPreferredProviderOf(claudeOnly, pair([['claude', 'failed'], ['codex', 'succeeded']])), 'review_chat')).toBe(
      'claude',
    );
  });
  it('an ordinary run: its own provider', () => {
    expect(chatPreferredProviderOf(me({ def: 'claude', claude: true }), { provider: 'codex', model: 'gpt-6.1-sol', pair: null } as never)).toBe('codex');
  });
});
