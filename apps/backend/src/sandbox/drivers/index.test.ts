// THE SESSION'S RUN CHOICE (drivers/index.ts): the request's `{provider, model}` (already validated by
// ai/run-choice.ts) → the provider's own model and THE effort setting, read once.
import { afterEach, describe, expect, it } from 'vitest';
import { setStoredAiEffort } from '../../ai/effort.js';
import { resolveSandboxAgentChoice } from './index.js';

afterEach(() => setStoredAiEffort(null));

describe('resolveSandboxAgentChoice', () => {
  it('Claude keeps the exact model; Default effort is a worktree run\'s (medium)', () => {
    expect(resolveSandboxAgentChoice({ provider: 'claude', model: 'claude-opus-5-5' }, {})).toEqual({ provider: 'claude', model: 'claude-opus-5-5', effort: 'medium' });
    expect(resolveSandboxAgentChoice({ provider: 'claude', model: 'claude-sonnet-5' }, {})).toEqual({ provider: 'claude', model: 'claude-sonnet-5', effort: 'medium' });
  });

  it('Codex resolves the DEPTH to its own model, at its own Default depth', () => {
    expect(resolveSandboxAgentChoice({ provider: 'codex', model: 'claude-opus-5-5' }, {})).toEqual({ provider: 'codex', model: 'gpt-6.1-sol', effort: 'high' });
    expect(resolveSandboxAgentChoice({ provider: 'codex', model: 'claude-sonnet-5' }, {})).toEqual({ provider: 'codex', model: 'gpt-6.1-terra', effort: 'medium' });
  });

  it('a STORED model maps back through requestModelOf (a Codex id under Claude, a retired one too)', () => {
    expect(resolveSandboxAgentChoice({ provider: 'claude', model: 'gpt-6.1-terra' }, {}).model).toBe('claude-sonnet-5');
    expect(resolveSandboxAgentChoice({ provider: 'codex', model: 'gpt-6-astra' }, {}).model).toBe('gpt-6.1-sol');
  });

  it('the Settings level and REVIEW_EFFORT reach both providers', () => {
    setStoredAiEffort('xhigh');
    expect(resolveSandboxAgentChoice({ provider: 'claude', model: 'claude-sonnet-5' }, {}).effort).toBe('xhigh');
    expect(resolveSandboxAgentChoice({ provider: 'codex', model: 'claude-sonnet-5' }, {}).effort).toBe('xhigh');
    expect(resolveSandboxAgentChoice({ provider: 'codex', model: 'claude-sonnet-5' }, { REVIEW_EFFORT: 'low' }).effort).toBe('low');
  });
});
