import { describe, expect, it } from 'vitest';
import {
  CHAT_TMP_MAX_PATH,
  DENY_ENV,
  agentEnv,
  chatSandboxPolicy,
  chatTmpBase,
  chatTmpPrefix,
  trimNoProxy,
} from './policy.js';
import { sdkSandboxSettings, sessionTools } from '../ai/providers/claude.js';

describe('the agent environment (spike finding 1: srt passes it to every command)', () => {
  const host = {
    PATH: '/usr/bin',
    HOME: '/home/me',
    LANG: 'en_GB.UTF-8',
    LC_ALL: 'en_GB.UTF-8',
    GH_TOKEN: 'gho_secret',
    GITHUB_TOKEN: 'ghp_secret',
    AWS_SECRET_ACCESS_KEY: 'aws',
    AWS_ACCESS_KEY_ID: 'AKIA',
    NPM_TOKEN: 'npm',
    DATABASE_URL: 'postgres://x',
    CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
    ANTHROPIC_API_KEY: 'sk-ant',
    HTTPS_PROXY: 'http://proxy:3128',
    NO_PROXY: 'localhost,registry.npmjs.org,.pythonhosted.org,internal.corp',
  };
  const env = agentEnv(host, { tmpDir: '/tmp/limn-q-abc-1', allowedDomains: ['registry.npmjs.org', 'files.pythonhosted.org'] });

  it('is an allow-list: tokens, keys and app settings never reach the agent', () => {
    for (const k of ['GH_TOKEN', 'GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'AWS_ACCESS_KEY_ID', 'NPM_TOKEN', 'DATABASE_URL']) {
      expect(env[k]).toBeUndefined();
    }
    expect(env.PATH).toBe('/usr/bin');
    expect(env.LC_ALL).toBe('en_GB.UTF-8');
    expect(env.TMPDIR).toBe('/tmp/limn-q-abc-1');
  });

  it('keeps the model credential for the agent process, and the sandbox denies it to commands', () => {
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth');
    expect(DENY_ENV).toEqual(expect.arrayContaining(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY']));
    const s = sdkSandboxSettings(
      chatSandboxPolicy({ home: '/home/me', checkouts: [], borrowed: [], tmpDir: '/tmp/x', extraRead: [], allowedDomains: [] }),
    ) as { credentials: { envVars: Array<{ name: string; mode: string }> } };
    expect(s.credentials.envVars.map((v) => v.name)).toEqual([...DENY_ENV]);
    expect(new Set(s.credentials.envVars.map((v) => v.mode))).toEqual(new Set(['deny']));
  });

  it('takes the allowed hosts out of NO_PROXY (finding 3), keeping the rest', () => {
    expect(env.NO_PROXY).toBe('localhost,internal.corp');
    expect(trimNoProxy('*.npmjs.org,example.com', ['registry.npmjs.org'])).toBe('example.com');
    expect(trimNoProxy('registry.npmjs.org', ['registry.npmjs.org'])).toBe('');
  });
});

describe('the sandbox policy', () => {
  const p = chatSandboxPolicy({
    home: '/home/me',
    checkouts: [{ path: '/home/me/.limn/clones/acme__api/.worktrees/w1', commonDir: '/home/me/.limn/clones/acme__api/.git', gitDir: '/home/me/.limn/clones/acme__api/.git/worktrees/w1' }],
    borrowed: ['/home/me/code/api/node_modules'],
    tmpDir: '/tmp/limn-q-abc-1',
    extraRead: ['/home/me/certs'],
    allowedDomains: ['registry.npmjs.org'],
  });

  it('hides the home folder and lets back in only what the chat needs', () => {
    expect(p.denyRead).toEqual(['/home/me']);
    expect(p.allowRead).toEqual(
      expect.arrayContaining([
        '/home/me/.limn/clones/acme__api/.worktrees/w1',
        '/home/me/.limn/clones/acme__api/.git',
        '/home/me/code/api/node_modules',
        '/home/me/certs',
        '/tmp/limn-q-abc-1',
      ]),
    );
    expect(p.allowRead.some((x) => x === '/home/me/code/api')).toBe(false);
  });

  it('writes only the checkout, its own git folder and the temp folder; borrowed folders stay read-only', () => {
    expect(p.allowWrite.sort()).toEqual(
      ['/home/me/.limn/clones/acme__api/.worktrees/w1', '/home/me/.limn/clones/acme__api/.git/worktrees/w1', '/tmp/limn-q-abc-1'].sort(),
    );
    // The clone's shared git folder (hooks, config, objects) is read, never written.
    expect(p.allowWrite).not.toContain('/home/me/.limn/clones/acme__api/.git');
    expect(p.denyWrite).toEqual(['/home/me/code/api/node_modules']);
  });

  it('is FAIL CLOSED in the SDK: no sandbox, no command; the model cannot ask out', () => {
    const s = sdkSandboxSettings(p) as Record<string, unknown>;
    expect(s.enabled).toBe(true);
    expect(s.failIfUnavailable).toBe(true);
    expect(s.allowUnsandboxedCommands).toBe(false);
    expect((s.network as { allowedDomains: string[] }).allowedDomains).toEqual(['registry.npmjs.org']);
  });
});

describe('the session tools', () => {
  it('a sandboxed session gets the shell and edits; an unsandboxed one only reads', () => {
    const on = sessionTools({ sandbox: { allowWrite: [], denyWrite: [], allowRead: [], denyRead: [], allowedDomains: [], denyEnv: [] }, claude: { allowedTools: [], disallowedTools: ['WebFetch'] } });
    expect(on.tools).toEqual(['Read', 'Glob', 'Grep', 'Bash', 'Edit', 'Write']);
    expect(on.disallowed).toContain('WebFetch');
    const off = sessionTools({ sandbox: null, claude: { allowedTools: ['Bash'], disallowedTools: [] } });
    expect(off.tools).toEqual(['Read', 'Glob', 'Grep']);
    expect(off.allowed).not.toContain('Bash');
    expect(off.disallowed).toEqual(expect.arrayContaining(['Bash', 'Edit', 'Write']));
  });
});

describe('the temp folder (finding 2: srt sockets live under TMPDIR, ≤ ~108 bytes)', () => {
  it('is under /tmp on macOS and Linux, short whatever the data folder', () => {
    expect(chatTmpBase('linux', '/var/folders/xx/very/long/T', true)).toBe('/tmp');
    expect(chatTmpBase('darwin', '/var/folders/xx/T', true)).toBe('/tmp');
    expect(chatTmpBase('win32', 'C:\\Temp', true)).toBe('C:\\Temp');
    const prefix = chatTmpPrefix('/Users/someone/with/a/very/long/path/to/their/limn/data/folder/.limn');
    expect(prefix).toMatch(/^limn-q-[0-9a-z]{1,5}-$/);
    // mkdtemp adds six characters.
    expect(`/tmp/${prefix}XXXXXX`.length).toBeLessThanOrEqual(CHAT_TMP_MAX_PATH);
  });
  it('names this install, so one install never sweeps another one’s folders', () => {
    expect(chatTmpPrefix('/home/a/.limn')).not.toBe(chatTmpPrefix('/home/b/.limn'));
  });
});
