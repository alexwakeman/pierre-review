// THE SESSION'S RUN CHOICE (drivers/index.ts): the request's `{provider, model}` (already validated by
// ai/run-choice.ts) → the provider's own model and THE effort setting, read once.
import { afterEach, describe, expect, it } from 'vitest';
import { setStoredAiEffort } from '../../ai/effort.js';
import { setStoredAiRunProfiles } from '../../ai/run-profile.js';
import { resolveSandboxAgentChoice } from './index.js';

afterEach(() => {
  setStoredAiEffort(null);
  setStoredAiRunProfiles(null);
});

describe('resolveSandboxAgentChoice', () => {
  it('Claude keeps the exact model; Default effort is a worktree run\'s (medium)', () => {
    expect(resolveSandboxAgentChoice({ provider: 'claude', model: 'claude-opus-5-5', surface: 'fix' }, {})).toEqual({ provider: 'claude', model: 'claude-opus-5-5', effort: 'medium' });
    expect(resolveSandboxAgentChoice({ provider: 'claude', model: 'claude-sonnet-5', surface: 'fix' }, {})).toEqual({ provider: 'claude', model: 'claude-sonnet-5', effort: 'medium' });
  });

  it('Codex resolves the DEPTH to its own model, at its own Default depth', () => {
    expect(resolveSandboxAgentChoice({ provider: 'codex', model: 'claude-opus-5-5', surface: 'fix' }, {})).toEqual({ provider: 'codex', model: 'gpt-6.1-sol', effort: 'high' });
    expect(resolveSandboxAgentChoice({ provider: 'codex', model: 'claude-sonnet-5', surface: 'fix' }, {})).toEqual({ provider: 'codex', model: 'gpt-6.1-terra', effort: 'medium' });
  });

  it('a STORED model maps back through requestModelOf (a Codex id under Claude, a retired one too)', () => {
    expect(resolveSandboxAgentChoice({ provider: 'claude', model: 'gpt-6.1-terra', surface: 'fix' }, {}).model).toBe('claude-sonnet-5');
    expect(resolveSandboxAgentChoice({ provider: 'codex', model: 'gpt-6-astra', surface: 'fix' }, {}).model).toBe('gpt-6.1-sol');
  });

  it('the Settings level and REVIEW_EFFORT reach both providers', () => {
    setStoredAiEffort('xhigh');
    expect(resolveSandboxAgentChoice({ provider: 'claude', model: 'claude-sonnet-5', surface: 'fix' }, {}).effort).toBe('xhigh');
    expect(resolveSandboxAgentChoice({ provider: 'codex', model: 'claude-sonnet-5', surface: 'fix' }, {}).effort).toBe('xhigh');
    expect(resolveSandboxAgentChoice({ provider: 'codex', model: 'claude-sonnet-5', surface: 'fix' }, { REVIEW_EFFORT: 'low' }).effort).toBe('low');
  });

  it('the SURFACE decides the effort: AI Fix\'s profile for a fix, Implement story\'s for a build', () => {
    setStoredAiRunProfiles({ fix: { provider: 'claude', effort: 'max' }, build: { provider: 'codex', effort: 'low' } });
    expect(resolveSandboxAgentChoice({ provider: 'claude', model: 'claude-opus-5-5', surface: 'fix' }, {}).effort).toBe('max');
    expect(resolveSandboxAgentChoice({ provider: 'claude', model: 'claude-opus-5-5', surface: 'build' }, {}).effort).toBe('medium');
    expect(resolveSandboxAgentChoice({ provider: 'codex', model: 'claude-opus-5-5', surface: 'build' }, {}).effort).toBe('low');
  });
});
