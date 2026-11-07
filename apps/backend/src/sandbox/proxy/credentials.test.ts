import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_ALLOWED_HOSTS, effectiveRules, validateReaderRule } from './allow-list.js';
import {
  claudeSandboxEnv,
  codexInjectedConfigToml,
  codexSandboxAuth,
  credentialModeLine,
  fakeJwt,
  hostClaudeSecret,
  readClaudeLoginToken,
  sandboxToolProxyEnv,
  SANDBOX_CREDENTIAL_MODE,
} from './credentials.js';

describe('allow-list defaults', () => {
  it('finalised from spike 4: registries, Node, Maven, GitHub read; no provider host when injected', () => {
    const rules = effectiveRules({ provider: 'claude', credentialMode: 'injected' });
    for (const h of ['registry.npmjs.org', 'github.com', 'codeload.github.com', 'nodejs.org', 'repo1.maven.org', 'pypi.org']) expect(rules).toContain(h);
    expect(rules).not.toContain('api.anthropic.com');
    expect(rules).not.toContain('auth.openai.com');
    expect(rules.some((r) => /docker|ghcr/.test(r))).toBe(false);
    expect(effectiveRules({ provider: 'codex', credentialMode: 'token-in-sandbox' })).toContain('chatgpt.com');
    expect(DEFAULT_ALLOWED_HOSTS.every((h) => h.why.length > 0)).toBe(true);
  });

  it('unions workspace and session rules, normalised, and drops a bare *', () => {
    const rules = effectiveRules({ provider: 'claude', credentialMode: 'injected', workspaceRules: ['Nexus.Corp.Example'], sessionRules: ['*', 'x.test:8443'] });
    expect(rules).toContain('nexus.corp.example');
    expect(rules).toContain('x.test:8443');
    expect(rules).not.toContain('*');
  });

  it('reader rules: what may be added', () => {
    expect(validateReaderRule('*.Example.org')).toEqual({ ok: true, rule: '*.example.org' });
    for (const bad of ['*', '*.org', 'localhost', 'a.localhost', '127.0.0.2', '169.254.169.254', '::1', '[::1]', 'two words']) {
      expect(validateReaderRule(bad).ok, bad).toBe(false);
    }
    expect(validateReaderRule('10.0.0.5:8081')).toEqual({ ok: true, rule: '10.0.0.5:8081' });
  });
});

describe('credentials', () => {
  it('ships injected for both providers, said in one line', () => {
    expect(SANDBOX_CREDENTIAL_MODE).toEqual({ claude: 'injected', codex: 'injected' });
    expect(credentialModeLine('claude')).toMatch(/stays on this computer/);
    expect(credentialModeLine('codex').split('. ').length).toBeLessThanOrEqual(2);
  });

  it("the sandbox's Claude env holds only the injector and the placeholder", () => {
    expect(claudeSandboxEnv('oauth', 'ph')).toEqual({ ANTHROPIC_BASE_URL: 'http://limn-proxy:8081', CLAUDE_CODE_OAUTH_TOKEN: 'ph' });
    expect(claudeSandboxEnv('api_key', 'ph')).toEqual({ ANTHROPIC_BASE_URL: 'http://limn-proxy:8081', ANTHROPIC_API_KEY: 'ph' });
  });

  it('the host secret follows the ONE ladder', () => {
    const login = () => ({ kind: 'oauth' as const, token: 'tok', expiresAt: Date.now() + 60_000 });
    expect(hostClaudeSecret({}, { route: 'api_key', method: 'api_key', apiKey: 'k' }, login)).toEqual({ kind: 'api_key', key: 'k' });
    expect(hostClaudeSecret({}, { route: 'login', method: 'ambient' }, login)).toMatchObject({ kind: 'oauth', token: 'tok' });
    expect(hostClaudeSecret({}, { route: 'login', method: 'ambient' }, () => ({ kind: 'oauth', token: 't', expiresAt: 1 }))).toMatchObject({ kind: 'none' });
    expect(hostClaudeSecret({}, { route: 'none' }, login).kind).toBe('none');
  });

  it('reads the login token from the env, then the credentials file', () => {
    expect(readClaudeLoginToken({ CLAUDE_CODE_OAUTH_TOKEN: 'env-token' }, '/nonexistent')).toMatchObject({ kind: 'oauth', token: 'env-token' });
    const cfg = mkdtempSync(join(tmpdir(), 'limn-claude-cfg-'));
    writeFileSync(join(cfg, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'file-token', expiresAt: 123 } }));
    expect(readClaudeLoginToken({ CLAUDE_CONFIG_DIR: cfg }, '/nonexistent')).toEqual({ kind: 'oauth', token: 'file-token', expiresAt: 123 });
  });

  it("Codex's sandbox auth.json keeps the shape and claims, and no secret", () => {
    const claim = { chatgpt_plan_type: 'plus', chatgpt_account_id: 'acct-1' };
    const realAccess = fakeJwt({ exp: 2_000_000_000, iat: 1, sub: 'user-secret-sub', email: 'r@example.invalid', 'https://api.openai.com/auth': claim });
    const real = { auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { access_token: realAccess, id_token: realAccess, refresh_token: 'REAL-REFRESH', account_id: 'acct-1' }, last_refresh: '2026-11-07T00:00:00Z' };
    const out = codexSandboxAuth(real, 'nonce1')!;
    const parsed = JSON.parse(out.authJson);
    expect(parsed.tokens.access_token).toBe(out.placeholder);
    expect(parsed.tokens.refresh_token).toBe('limn-placeholder-nonce1');
    expect(out.authJson).not.toContain('REAL-REFRESH');
    expect(out.authJson).not.toContain(realAccess);
    const claims = JSON.parse(Buffer.from(out.placeholder.split('.')[1]!, 'base64url').toString());
    expect(claims).toEqual({ exp: 2_000_000_000, iat: 1, 'https://api.openai.com/auth': claim, limn: 'nonce1' });
    expect(codexSandboxAuth(null, 'n')).toBeNull();
    expect(codexInjectedConfigToml()).toContain('base_url = "http://limn-proxy:8082/backend-api/codex"');
  });

  it('tools get the proxy one by one; the global variables only on request (spike 4 rule 2)', () => {
    const env = sandboxToolProxyEnv();
    expect(env.npm_config_https_proxy).toBe('http://limn-proxy:3128');
    expect(env.GIT_CONFIG_VALUE_2).toBe('git@github.com:');
    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(sandboxToolProxyEnv({ globalProxyEnv: true }).HTTPS_PROXY).toBe('http://limn-proxy:3128');
  });
});
