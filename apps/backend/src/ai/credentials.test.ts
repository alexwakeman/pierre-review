// THE ONE CREDENTIAL LADDER: the Claude Code login first, else ANTHROPIC_API_KEY; the opt-in
// LIMN_AI_USE_API_KEY=true puts the key first. Every input is passed explicitly (an env object and
// a login probe), so nothing here reads the real home directory.
import { describe, expect, it } from 'vitest';
import { agentSdkEnv, prefersApiKey, resolveAiCredential } from './credentials.js';

const loggedIn = () => true;
const loggedOut = () => false;

describe('resolveAiCredential', () => {
  it('login present → the login, even with a key set', () => {
    expect(resolveAiCredential({ ANTHROPIC_API_KEY: 'sk-ant' }, loggedIn)).toEqual({
      route: 'login',
      method: 'ambient',
    });
    expect(resolveAiCredential({ CLAUDE_CODE_OAUTH_TOKEN: 'tok' }, loggedOut)).toEqual({
      route: 'login',
      method: 'oauth_token',
    });
  });

  it('no login + key → the API key', () => {
    expect(resolveAiCredential({ ANTHROPIC_API_KEY: ' sk-ant ' }, loggedOut)).toEqual({
      route: 'api_key',
      method: 'api_key',
      apiKey: 'sk-ant',
    });
  });

  it('LIMN_AI_USE_API_KEY=true → the key first, over a login and an OAuth token', () => {
    const env = { ANTHROPIC_API_KEY: 'sk-ant', CLAUDE_CODE_OAUTH_TOKEN: 'tok', LIMN_AI_USE_API_KEY: 'true' };
    expect(resolveAiCredential(env, loggedIn)).toEqual({ route: 'api_key', method: 'api_key', apiKey: 'sk-ant' });
    expect(prefersApiKey(env)).toBe(true);
  });

  it('the opt-in without a key falls back to the login', () => {
    expect(resolveAiCredential({ LIMN_AI_USE_API_KEY: 'true' }, loggedIn).route).toBe('login');
  });

  it('nothing → none (an empty key is no key)', () => {
    expect(resolveAiCredential({ ANTHROPIC_API_KEY: '  ' }, loggedOut)).toEqual({ route: 'none' });
  });
});

describe('agentSdkEnv', () => {
  it('login → the run never sees ANTHROPIC_API_KEY, everything else is inherited', () => {
    const env = { PATH: '/bin', ANTHROPIC_API_KEY: 'sk-ant' };
    const out = agentSdkEnv(env, { route: 'login', method: 'ambient' });
    expect(out.ANTHROPIC_API_KEY).toBeUndefined();
    expect(out.PATH).toBe('/bin');
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant'); // the caller's object is untouched
  });

  it('API key → the key is passed and the OAuth token hidden', () => {
    const env = { PATH: '/bin', ANTHROPIC_API_KEY: 'sk-ant', CLAUDE_CODE_OAUTH_TOKEN: 'tok' };
    const out = agentSdkEnv(env, { route: 'api_key', method: 'api_key', apiKey: 'sk-ant' });
    expect(out.ANTHROPIC_API_KEY).toBe('sk-ant');
    expect(out.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it('none → the environment unchanged', () => {
    expect(agentSdkEnv({ PATH: '/bin' }, { route: 'none' })).toEqual({ PATH: '/bin' });
  });
});
