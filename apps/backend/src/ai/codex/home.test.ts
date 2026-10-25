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

  it('a non-run process gets CODEX_HOME and no API key', () => {
    const env = H.codexProcessEnv({ PATH: '/bin', OPENAI_API_KEY: 'sk', CODEX_API_KEY: 'sk2', LIMN_DATA_DIR: '/d' });
    expect(env).toEqual({ PATH: '/bin', LIMN_DATA_DIR: '/d', CODEX_HOME: join('/d', 'codex') });
  });

  it('codexBinary() refuses with the setup sentence when Codex is not installed', async () => {
    delete process.env.LIMN_CODEX_PATH;
    await expect(H.codexBinary()).rejects.toThrow('Codex is not set up yet. Run: limn ai install codex');
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
  it('LIMN_AI_USE_API_KEY=true puts the key first', () => {
    expect(C.resolveCodexCredential({ OPENAI_API_KEY: 'sk', LIMN_AI_USE_API_KEY: 'true' }, signedIn)).toEqual({
      route: 'api_key',
      method: 'api_key',
      apiKey: 'sk',
    });
  });
  it('a key stored in the home by hand is the key rung (no ChatGPT windows to read)', () => {
    expect(C.resolveCodexCredential({}, () => ({ signedIn: true, type: 'apiKey' }))).toEqual({ route: 'api_key', method: 'stored_api_key' });
  });
  it("the reader's own ~/.codex/auth.json counts for nothing; Limn's home's does (until the probe answers)", () => {
    mkdirSync(join(process.env.HOME!, '.codex'), { recursive: true });
    writeFileSync(join(process.env.HOME!, '.codex', 'auth.json'), '{}');
    const env = { ...process.env, LIMN_DATA_DIR: join(root, 'fresh-data') };
    expect(C.codexLoginKnown(env)).toEqual({ signedIn: false, type: null });
    mkdirSync(join(root, 'fresh-data', 'codex'), { recursive: true });
    writeFileSync(join(root, 'fresh-data', 'codex', 'auth.json'), '{}');
    expect(C.codexLoginKnown(env)).toEqual({ signedIn: true, type: null });
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
