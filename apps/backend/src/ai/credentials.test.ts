// THE ONE CREDENTIAL LADDER: the Claude Code login first, else ANTHROPIC_API_KEY; the opt-in
// LIMN_AI_USE_API_KEY=true puts the key first. Every input is passed explicitly (an env object and
// a login probe), so nothing here reads the real home directory.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentSdkEnv, hasClaudeLogin, prefersApiKey, resolveAiCredential } from './credentials.js';

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

// The login probe reads the disk; every case here points it at a scratch home, never the real one.
describe('hasClaudeLogin', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'limn-cred-home-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });
  const probe = (env: NodeJS.ProcessEnv) => hasClaudeLogin(env, home);

  it('an empty home is no login', () => {
    expect(probe({})).toBe(false);
  });

  it('a bare ~/.claude dir and a ~/.claude.json without oauthAccount are NOT a login — the key is kept', () => {
    // Exactly what an Agent SDK run on the API-key route leaves behind.
    mkdirSync(join(home, '.claude'));
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ numStartups: 3, userID: 'x' }));
    expect(probe({})).toBe(false);
    expect(resolveAiCredential({ ANTHROPIC_API_KEY: 'sk-ant' }, probe)).toEqual({
      route: 'api_key',
      method: 'api_key',
      apiKey: 'sk-ant',
    });
  });

  it('an empty or null oauthAccount, or an unparseable file, is not a login', () => {
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: {} }));
    expect(probe({})).toBe(false);
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: null }));
    expect(probe({})).toBe(false);
    writeFileSync(join(home, '.claude.json'), '{not json');
    expect(probe({})).toBe(false);
  });

  it('~/.claude.json recording a signed-in oauthAccount IS a login (the macOS Keychain case)', () => {
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'u' } }));
    expect(probe({})).toBe(true);
    expect(resolveAiCredential({ ANTHROPIC_API_KEY: 'sk-ant' }, probe)).toEqual({
      route: 'login',
      method: 'ambient',
    });
  });

  it('a credentials file is a login (both default paths)', () => {
    mkdirSync(join(home, '.claude'));
    writeFileSync(join(home, '.claude', '.credentials.json'), '{}');
    expect(probe({})).toBe(true);
    rmSync(join(home, '.claude'), { recursive: true });
    mkdirSync(join(home, '.config', 'claude'), { recursive: true });
    writeFileSync(join(home, '.config', 'claude', '.credentials.json'), '{}');
    expect(probe({})).toBe(true);
  });

  it('CLAUDE_CODE_OAUTH_TOKEN is a login; a blank one is not', () => {
    expect(probe({ CLAUDE_CODE_OAUTH_TOKEN: 'tok' })).toBe(true);
    expect(probe({ CLAUDE_CODE_OAUTH_TOKEN: '  ' })).toBe(false);
  });

  it('CLAUDE_CONFIG_DIR is honoured: its .claude.json (with oauthAccount) or .credentials.json', () => {
    const cfg = join(home, 'custom-cfg');
    mkdirSync(cfg);
    // A bare config dir is not a login either.
    expect(probe({ CLAUDE_CONFIG_DIR: cfg })).toBe(false);
    writeFileSync(join(cfg, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'u' } }));
    expect(probe({ CLAUDE_CONFIG_DIR: cfg })).toBe(true);
    expect(resolveAiCredential({ CLAUDE_CONFIG_DIR: cfg }, probe)).toEqual({ route: 'login', method: 'ambient' });
    rmSync(join(cfg, '.claude.json'));
    writeFileSync(join(cfg, '.credentials.json'), '{}');
    expect(probe({ CLAUDE_CONFIG_DIR: cfg })).toBe(true);
    // Without the variable, the same files are not looked at.
    expect(probe({})).toBe(false);
  });
});
