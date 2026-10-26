// THE PER-RUN CHOICE (ai/run-choice.ts; docs/CODEX-PLAN.md § 6, revised 2026-10-26): a manual run's
// `{ provider, model }` is validated and resolved here; follow-ups keep their stored run's provider
// while it is signed in. Pure: the default provider and the pre-flight are handed in.
import { describe, expect, it } from 'vitest';
import type { AiProviderId } from '@pierre-review/shared';
import { anyProviderPreflight, followUpProvider, preflightFor, resolveManualRunChoice } from './run-choice.js';

const detectWith =
  (ready: Partial<Record<AiProviderId, boolean>>) =>
  (p: AiProviderId): { status: 'ok' | 'none'; message?: string } =>
    ready[p] ? { status: 'ok' } : { status: 'none', message: `${p} is not signed in` };

const opts = (ready: Partial<Record<AiProviderId, boolean>>, def: AiProviderId = 'claude') => ({
  defaultModel: 'claude-opus-5-5' as const,
  detect: detectWith(ready),
  defaultProvider: () => def,
});

describe('resolveManualRunChoice', () => {
  const both = { claude: true, codex: true };

  it('nothing named ⇒ the default provider at the default depth', () => {
    expect(resolveManualRunChoice({}, 'review', opts(both))).toEqual({ ok: true, provider: 'claude', model: 'claude-opus-5-5' });
    expect(resolveManualRunChoice({}, 'review', opts(both, 'codex'))).toEqual({ ok: true, provider: 'codex', model: 'claude-opus-5-5' });
  });

  it('a named provider wins over the default; a Codex model maps to the Claude model of its depth', () => {
    expect(resolveManualRunChoice({ provider: 'codex', model: 'gpt-6.1-terra' }, 'fix', opts(both))).toEqual({
      ok: true,
      provider: 'codex',
      model: 'claude-sonnet-5',
    });
    expect(resolveManualRunChoice({ provider: 'claude', model: 'claude-sonnet-5' }, 'fix', opts(both, 'codex'))).toEqual({
      ok: true,
      provider: 'claude',
      model: 'claude-sonnet-5',
    });
  });

  it('a Codex model with no provider runs on Codex; a Claude model with none runs on the default', () => {
    expect(resolveManualRunChoice({ model: 'gpt-6.1-sol' }, 'review', opts(both))).toMatchObject({ provider: 'codex' });
    // The Open PRs table sends Claude's default model and no provider: the DEFAULT provider runs it.
    expect(resolveManualRunChoice({ model: 'claude-opus-5-5' }, 'review', opts(both, 'codex'))).toMatchObject({
      provider: 'codex',
      model: 'claude-opus-5-5',
    });
  });

  it('refuses in one plain sentence', () => {
    expect(resolveManualRunChoice({ provider: 'openai' }, 'review', opts(both))).toEqual({
      ok: false,
      error: 'UnknownProvider',
      message: 'Pick Claude or Codex.',
    });
    expect(resolveManualRunChoice({ model: 'claude-opus-4-8' }, 'review', opts(both))).toEqual({
      ok: false,
      error: 'ModelNotOffered',
      message: 'That model is no longer offered.',
    });
    expect(resolveManualRunChoice({ model: 42 }, 'review', opts(both))).toMatchObject({ error: 'ModelNotOffered' });
    expect(resolveManualRunChoice({ provider: 'claude', model: 'gpt-6.1-sol' }, 'review', opts(both))).toEqual({
      ok: false,
      error: 'ModelNotOnProvider',
      message: 'GPT-6.1 Sol runs on Codex, not Claude.',
    });
    expect(resolveManualRunChoice({ provider: 'codex' }, 'plan', opts({ claude: true }))).toEqual({
      ok: false,
      error: 'NoClaudeAuth',
      message: 'codex is not signed in',
    });
  });

  it('asks the pre-flight for the NAMED provider and the run kind', () => {
    const asked: Array<[AiProviderId, string]> = [];
    resolveManualRunChoice({ provider: 'codex' }, 'plan', {
      defaultModel: 'claude-opus-5-5',
      defaultProvider: () => 'claude',
      detect: (p, k) => {
        asked.push([p, k]);
        return { status: 'ok' };
      },
    });
    expect(asked).toEqual([['codex', 'plan']]);
  });
});

describe('followUpProvider (the chat on its review, another pass of a plan)', () => {
  it("the stored run's provider while it is signed in, else the default", () => {
    expect(followUpProvider('codex', 'review_chat', detectWith({ codex: true }), () => 'claude')).toBe('codex');
    expect(followUpProvider('codex', 'review_chat', detectWith({ claude: true }), () => 'claude')).toBe('claude');
    expect(followUpProvider('claude', 'plan', detectWith({ claude: true, codex: true }), () => 'codex')).toBe('claude');
  });
});

describe('anyProviderPreflight (a picker surface is ready when any provider is)', () => {
  it("the default's answer when ready; 'ok' when only the other is; the default's sentence when neither", () => {
    expect(anyProviderPreflight(detectWith({}), 'review', { status: 'ok' })).toEqual({ status: 'ok' });
    expect(anyProviderPreflight(detectWith({ codex: true }), 'review', { status: 'none', message: 'x' })).toEqual({ status: 'ok' });
    expect(anyProviderPreflight(detectWith({}), 'review', { status: 'none', message: 'x' })).toEqual({ status: 'none', message: 'x' });
  });
});

describe('preflightFor', () => {
  it("uses the context's per-provider pre-flight, else its one answer for both", () => {
    const named = preflightFor({
      llm: { detectAuth: () => ({ status: 'none' }), detectProviderAuth: (p) => ({ status: p === 'codex' ? 'ok' : 'none' }) },
    });
    expect(named('codex', 'review').status).toBe('ok');
    expect(named('claude', 'review').status).toBe('none');
    const plain = preflightFor({ llm: { detectAuth: () => ({ status: 'ok' }) } });
    expect(plain('codex', 'review').status).toBe('ok');
  });
});
