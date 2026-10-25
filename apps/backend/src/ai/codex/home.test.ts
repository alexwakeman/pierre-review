// LIMN'S OWN CODEX HOME (ai/codex/home.ts) and the CODEX CREDENTIAL LADDER (ai/credentials.ts):
//   1. the home is <LIMN_DATA_DIR>/codex — never ~/.codex, which nothing here creates or reads;
//   2. config.toml: file-store auth, no forced login method, no prompt history, no analytics, and the
//      path-guard hook's trust entry; entries already trusted are KEPT; the write is skipped when
//      nothing changed; concurrent writers lose nothing;
//   3. the ladder: a sign-in in Limn's home ⇒ login; else OPENAI_API_KEY ⇒ api_key;
//      LIMN_AI_USE_API_KEY=true flips it; a key stored in the home counts as the key rung; the reader's
//      ~/.codex/auth.json counts for NOTHING; a run's environment carries exactly one key or none.
//
//   pnpm --filter @pierre-review/backend test ai/codex/home
import type { CodexHookConfig } from './types.js';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let root: string;
const saved = { ...process.env };

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'limn-codex-home-'));
  process.env.LIMN_DATA_DIR = join(root, 'data');
  process.env.HOME = join(root, 'home');
  mkdirSync(process.env.HOME, { recursive: true });
});
afterAll(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
  rmSync(root, { recursive: true, force: true });
});

const H = await import('./home.js');
const C = await import('../credentials.js');

const hook = (n: number): CodexHookConfig => ({
  override: `hooks.PreToolUse=[{matcher="apply_patch", hooks=[{type="command", command="/guard-${n}", timeout=30}]}]`,
  matcher: 'apply_patch',
  command: `/guard-${n}`,
  timeoutSec: 30,
  trustKey: '/<session-flags>/config.toml:pre_tool_use:0:0',
  trustedHash: `sha256:${String(n).repeat(64).slice(0, 64)}`,
  env: {},
});

describe("Limn's Codex home", () => {
  it('is <LIMN_DATA_DIR>/codex', () => {
    expect(H.codexHome()).toBe(join(root, 'data', 'codex'));
    expect(H.codexHome({ LIMN_DATA_DIR: '/x/y' })).toBe(join('/x/y', 'codex'));
  });

  it('writes the whole config.toml: file auth, no forced login method, no history, no analytics', async () => {
    await H.ensureCodexHomeConfig(null);
    const file = join(H.codexHome(), 'config.toml');
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('cli_auth_credentials_store = "file"');
    expect(text).toContain('check_for_update_on_startup = false');
    expect(text).toMatch(/\[history\]\npersistence = "none"/);
    expect(text).toMatch(/\[analytics\]\nenabled = false/);
    expect(text).not.toContain('forced_login_method');
    expect(text).not.toContain('hooks.state');
    if (process.platform !== 'win32') {
      expect(statSync(H.codexHome()).mode & 0o777).toBe(0o700);
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it('writes THE WHOLE LOCKDOWN into config.toml, so every process in the home (the app-server too) inherits it', async () => {
    const { LOCKED_SETTINGS, tomlValue } = await import('./config.js');
    await H.ensureCodexHomeConfig(null);
    const text = readFileSync(join(H.codexHome(), 'config.toml'), 'utf8');
    // Each table's rows, as written.
    const tables = new Map<string, Map<string, string>>([['', new Map()]]);
    let cur = '';
    for (const line of text.split('\n')) {
      const t = /^\[([a-z_]+)\]$/.exec(line);
      if (t) tables.set((cur = t[1]!), new Map());
      else if (/^\[/.test(line)) cur = '<other>';
      else {
        const kv = /^([a-z_]+) = (.*)$/.exec(line);
        if (kv && cur !== '<other>') tables.get(cur)!.set(kv[1]!, kv[2]!);
      }
    }
    for (const [key, value] of LOCKED_SETTINGS) {
      const [a, b] = key.split('.');
      const got = b === undefined ? tables.get('')!.get(a!) : tables.get(a!)?.get(b);
      expect(got, key).toBe(tomlValue(value));
    }
    // The ones that reached the network from a bare app-server (measured on 0.164), by name.
    for (const k of ['apps', 'plugins', 'remote_plugin', 'tool_suggest', 'memories', 'goals', 'daemon_auto_start']) {
      expect(tables.get('features')!.get(k), k).toBe('false');
    }
    // Top-level keys come before the first table (TOML would read them as the table's otherwise).
    expect(text.indexOf('approval_policy')).toBeLessThan(text.indexOf('['));
  });

  it("adds the hook's trust entry and keeps it through a later write without a hook", async () => {
    await H.ensureCodexHomeConfig(hook(1));
    await H.ensureCodexHomeConfig(null);
    const text = readFileSync(join(H.codexHome(), 'config.toml'), 'utf8');
    expect(text).toContain('[hooks.state."/<session-flags>/config.toml:pre_tool_use:0:0"]');
    expect(text).toContain(`trusted_hash = "${hook(1).trustedHash}"`);
    expect(H.parseTrustEntries(text)).toEqual(new Map([[hook(1).trustKey, hook(1).trustedHash]]));
    // A new hash for the same key replaces it.
    await H.ensureCodexHomeConfig(hook(2));
    expect(H.parseTrustEntries(readFileSync(join(H.codexHome(), 'config.toml'), 'utf8'))).toEqual(
      new Map([[hook(2).trustKey, hook(2).trustedHash]]),
    );
  });

  it('two writers at once lose nothing', async () => {
    const a = { ...hook(3), trustKey: 'k-a' };
    const b = { ...hook(4), trustKey: 'k-b' };
    await Promise.all([H.ensureCodexHomeConfig(a), H.ensureCodexHomeConfig(b)]);
    const entries = H.parseTrustEntries(readFileSync(join(H.codexHome(), 'config.toml'), 'utf8'));
    expect(entries.get('k-a')).toBe(a.trustedHash);
    expect(entries.get('k-b')).toBe(b.trustedHash);
  });

  it('a key that needs escaping round-trips', () => {
    const toml = H.codexHomeConfigToml(new Map([['/a "quoted"\\path:0', 'sha256:ab']]));
    expect(H.parseTrustEntries(toml)).toEqual(new Map([['/a "quoted"\\path:0', 'sha256:ab']]));
  });

  it('never creates or reads ~/.codex', async () => {
    await H.ensureCodexHomeConfig(hook(5));
    expect(existsSync(join(process.env.HOME!, '.codex'))).toBe(false);
  });

  it('a non-run process gets the run allow-list + CODEX_HOME: no API key, nothing else of Limn’s', () => {
    const env = H.codexProcessEnv({
      PATH: '/bin',
      OPENAI_API_KEY: 'sk',
      CODEX_API_KEY: 'sk2',
      LIMN_DATA_DIR: '/d',
      ANTHROPIC_API_KEY: 'a',
      GITHUB_TOKEN: 'g',
      SESSION_SECRET: 's',
      TERM: 'xterm',
    });
    expect(env).toEqual({ PATH: '/bin', CODEX_HOME: join('/d', 'codex') });
    // The interactive CLI sign-in adds the terminal's own variables, still no secret.
    expect(H.codexProcessEnv({ PATH: '/bin', LIMN_DATA_DIR: '/d', TERM: 'xterm', GITHUB_TOKEN: 'g' }, { interactive: true })).toEqual({
      PATH: '/bin',
      TERM: 'xterm',
      CODEX_HOME: join('/d', 'codex'),
    });
  });

  it('codexBinary() refuses with the setup sentence when Codex is not installed — as an AiRuntimeMissingError', async () => {
    delete process.env.LIMN_CODEX_PATH;
    await expect(H.codexBinary()).rejects.toThrow('Codex is not set up yet. Run: limn ai install codex');
    const { AiRuntimeMissingError } = await import('../runtime.js');
    const err = await H.codexBinary().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiRuntimeMissingError);
    expect(err).toBeInstanceOf(H.CodexNotInstalledError);
  });
});

describe('the Codex credential ladder', () => {
  const signedIn = () => ({ signedIn: true, type: 'chatgpt' });
  const signedOut = () => ({ signedIn: false, type: null });

  it('a sign-in in Limn’s home ⇒ login, even with a key around', () => {
    expect(C.resolveCodexCredential({ OPENAI_API_KEY: 'sk' }, signedIn)).toEqual({ route: 'login', method: 'chatgpt' });
  });
  it('no sign-in ⇒ OPENAI_API_KEY; neither ⇒ none', () => {
    expect(C.resolveCodexCredential({ OPENAI_API_KEY: ' sk ' }, signedOut)).toEqual({ route: 'api_key', method: 'api_key', apiKey: 'sk' });
    expect(C.resolveCodexCredential({}, signedOut)).toEqual({ route: 'none' });
  });
  it('LIMN_AI_USE_API_KEY=true (shared with Claude) never pushes a ChatGPT sign-in onto the REFUSED key route', () => {
    const env = { OPENAI_API_KEY: 'sk', LIMN_AI_USE_API_KEY: 'true' };
    expect(C.resolveCodexCredential(env, signedIn)).toEqual({ route: 'login', method: 'chatgpt' });
    // Nor a sign-in a probe has yet to name (the run waits for that probe first).
    expect(C.resolveCodexCredential(env, () => ({ signedIn: true, type: null }))).toEqual({ route: 'login', method: 'unconfirmed' });
    // With no ChatGPT sign-in it still puts the environment's key ahead of a key stored in the home.
    expect(C.resolveCodexCredential(env, () => ({ signedIn: true, type: 'apiKey' }))).toEqual({ route: 'api_key', method: 'api_key', apiKey: 'sk' });
    expect(C.resolveCodexCredential(env, signedOut)).toEqual({ route: 'api_key', method: 'api_key', apiKey: 'sk' });
  });
  it('a key stored in the home by hand is the key rung (no ChatGPT windows to read)', () => {
    expect(C.resolveCodexCredential({}, () => ({ signedIn: true, type: 'apiKey' }))).toEqual({ route: 'api_key', method: 'stored_api_key' });
  });
  it('FAIL CLOSED: only a sign-in KNOWN to be ChatGPT is runnable; an unknown kind is "unconfirmed", another kind is no rung', () => {
    const unknown = C.resolveCodexCredential({}, () => ({ signedIn: true, type: null }));
    expect(unknown).toEqual({ route: 'login', method: 'unconfirmed' });
    expect(C.codexCredentialRunnable(unknown)).toBe(false);
    expect(C.codexCredentialRunnable(C.resolveCodexCredential({}, signedIn))).toBe(true);
    expect(C.codexCredentialRunnable({ route: 'api_key', method: 'stored_api_key' })).toBe(false);
    expect(C.resolveCodexCredential({}, () => ({ signedIn: true, type: 'chatgptAuthTokens' }))).toEqual({ route: 'none' });
  });
  it("auth.json's KIND, from its non-secret fields only (fixtures — never a real sign-in)", () => {
    const f = join(root, 'auth-kind.json');
    const kind = (o: unknown): string | null => {
      writeFileSync(f, typeof o === 'string' ? o : JSON.stringify(o));
      return C.codexAuthFileKind(f);
    };
    expect(kind({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { access_token: 'fixture' } })).toBe('chatgpt');
    expect(kind({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-fixture' })).toBe('apiKey');
    expect(kind({ auth_mode: 'ApiKey' })).toBe('apiKey');
    // No auth_mode: a filled-in key is a key (Codex's own default); nothing else is known.
    expect(kind({ OPENAI_API_KEY: 'sk-fixture' })).toBe('apiKey');
    expect(kind({ tokens: { access_token: 'fixture' } })).toBeNull();
    expect(kind({})).toBeNull();
    // ChatGPT mode WITH a key filled in, another mode, or a broken file: not known (a probe decides).
    expect(kind({ auth_mode: 'chatgpt', OPENAI_API_KEY: 'sk-fixture' })).toBeNull();
    expect(kind({ auth_mode: 'agentIdentity' })).toBeNull();
    expect(kind({ auth_mode: 7 })).toBeNull();
    expect(kind('{ not json')).toBeNull();
    expect(kind('[]')).toBeNull();
    expect(C.codexAuthFileKind(join(root, 'no-such-auth.json'))).toBeNull();
  });
  it("the reader's own ~/.codex/auth.json counts for nothing; Limn's home's does (until the probe answers)", () => {
    mkdirSync(join(process.env.HOME!, '.codex'), { recursive: true });
    writeFileSync(join(process.env.HOME!, '.codex', 'auth.json'), '{}');
    const env = { ...process.env, LIMN_DATA_DIR: join(root, 'fresh-data') };
    expect(C.codexLoginKnown(env)).toEqual({ signedIn: false, type: null });
    mkdirSync(join(root, 'fresh-data', 'codex'), { recursive: true });
    writeFileSync(join(root, 'fresh-data', 'codex', 'auth.json'), '{}');
    expect(C.codexLoginKnown(env)).toEqual({ signedIn: true, type: null });
    writeFileSync(join(root, 'fresh-data', 'codex', 'auth.json'), JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-fixture' }));
    expect(C.codexLoginKnown(env)).toEqual({ signedIn: true, type: 'apiKey' });
    expect(C.resolveCodexCredential({ ...env, OPENAI_API_KEY: '', LIMN_AI_USE_API_KEY: '' })).toEqual({ route: 'api_key', method: 'stored_api_key' });
    rmSync(join(process.env.HOME!, '.codex'), { recursive: true, force: true });
  });
  it("a run's environment: CODEX_HOME always; the login strips every key; the key rung passes CODEX_API_KEY only", () => {
    const base = { PATH: '/bin', OPENAI_API_KEY: 'sk', CODEX_API_KEY: 'old', LIMN_DATA_DIR: '/d' };
    expect(C.codexRunEnv(base, { route: 'login', method: 'chatgpt' })).toEqual({ PATH: '/bin', LIMN_DATA_DIR: '/d', CODEX_HOME: join('/d', 'codex') });
    expect(C.codexRunEnv(base, { route: 'api_key', method: 'api_key', apiKey: 'sk' })).toEqual({
      PATH: '/bin',
      LIMN_DATA_DIR: '/d',
      CODEX_HOME: join('/d', 'codex'),
      CODEX_API_KEY: 'sk',
    });
    expect(C.codexRunEnv(base, { route: 'api_key', method: 'stored_api_key' })).not.toHaveProperty('CODEX_API_KEY');
    expect(C.codexRunEnv(base, { route: 'none' })).not.toHaveProperty('OPENAI_API_KEY');
  });
});
