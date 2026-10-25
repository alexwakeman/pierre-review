import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  codexHookTrustHash,
  hookDeniesCanary,
  hookTrustToml,
  inspectHookTrust,
  PATH_GUARD_MATCHER,
  pathGuardHook,
  SESSION_FLAG_PRE_TOOL_USE_KEY,
} from './hook.js';
import { CODEX_ENV_ALLOW } from './config.js';
import { decideCodexToolCall, decodeGuardRoots, encodeGuardRoots, GUARD_ENV, writePaths } from './hook-rule.js';

let dir: string;
let wt: string;
let lib: string;

beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'limn-hook-')));
  wt = join(dir, 'wt');
  lib = join(dir, 'lib');
  mkdirSync(join(wt, 'src'), { recursive: true });
  mkdirSync(lib);
  mkdirSync(join(dir, 'outside'));
  writeFileSync(join(wt, 'src', 'a.ts'), 'x\n');
  symlinkSync(join(dir, 'outside'), join(wt, 'escape'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('codexHookTrustHash — pinned to what Codex 0.164.0 hooks/list reported', () => {
  // Each `currentHash` below was read from `codex app-server` → `hooks/list` (CODEX-SPIKE.md § 5
  // and stream B's scratch runs, 2026-10-25). A CLI bump that changes the scheme fails here first.
  it.each([
    ['apply_patch', '/bin/echo', undefined, 'sha256:ef141841f150fc26c2a95ab4c585bbb1ce95c93899c637902b06705d18e492cd'],
    ['apply_patch', '/bin/echo', 600, 'sha256:ef141841f150fc26c2a95ab4c585bbb1ce95c93899c637902b06705d18e492cd'],
    ['apply_patch', '/bin/echo', 30, 'sha256:1c6c2051f0e2e40f3ea17d058e64ccdb40719e247184ae0540b7e6053ec976b6'],
    ['Write', '/bin/echo', undefined, 'sha256:48082d3b991858f52466c6f7c167e7016442d0a7fd890a92ffd37b7a71ce2d5c'],
    [
      'apply_patch|Edit|Write|mcp__workspace__.*',
      '/tmp/limn-codex-spike/scripts/hook.sh',
      undefined,
      'sha256:0b8fde24c1b177198f2066bc3b1af8a513c479d58c8b299f587e49eed29a42c8',
    ],
    ['apply_patch', `/usr/bin/env FOO=1 /bin/echo "a b" 'x'`, undefined, 'sha256:50dd98a3b94a4180fbe01ce7887a075f435ab2d0a28bc085ecb16e8f8300b6bf'],
    // The guard's matcher since it became an allow-list over EVERY tool (read from hooks/list, 0.164.0).
    ['.*', '/bin/echo', 30, 'sha256:d563d4c7362c9ca298e50f0edc2612bab876a6bdfa1b02909eb75fb540d1f8d8'],
    ['.*', '/bin/echo', undefined, 'sha256:6e7fb09afa9514d14db4a63a73a6c4a9632b9efe8cc2b071728c29937b725c1e'],
  ])('%s · %s · timeout %s', (matcher, command, timeoutSec, expected) => {
    expect(codexHookTrustHash({ event: 'pre_tool_use', matcher, command, timeoutSec })).toBe(expected);
  });
});

describe('pathGuardHook', () => {
  it('builds the -c override, the trust entry and the roots env', () => {
    const h = pathGuardHook({ read: [wt, lib], write: [wt] });
    expect(h.matcher).toBe(PATH_GUARD_MATCHER);
    expect(h.timeoutSec).toBe(30);
    expect(h.trustKey).toBe(SESSION_FLAG_PRE_TOOL_USE_KEY);
    expect(h.command).toContain(process.execPath);
    expect(h.command).toMatch(/path-guard-hook-main\.ts$/);
    expect(h.override).toBe(
      `hooks.PreToolUse=[{matcher="${PATH_GUARD_MATCHER}", hooks=[{type="command", command=${JSON.stringify(h.command)}, timeout=30}]}]`,
    );
    expect(h.trustedHash).toBe(codexHookTrustHash({ event: 'pre_tool_use', matcher: h.matcher, command: h.command, timeoutSec: 30 }));
    expect(decodeGuardRoots(h.env[GUARD_ENV])).toEqual({ read: [wt, lib], write: [wt] });
  });

  it('keeps the command (so the trust hash) the same whatever the roots', () => {
    const a = pathGuardHook({ read: [wt], write: [wt] });
    const b = pathGuardHook({ read: [lib], write: [] });
    expect(a.command).toBe(b.command);
    expect(a.trustedHash).toBe(b.trustedHash);
    expect(a.env).not.toEqual(b.env);
  });

  it('writes the trust block in the format the spike proved', () => {
    expect(hookTrustToml({ trustKey: SESSION_FLAG_PRE_TOOL_USE_KEY, trustedHash: 'sha256:abc' })).toBe(
      '[hooks.state."/<session-flags>/config.toml:pre_tool_use:0:0"]\ntrusted_hash = "sha256:abc"\n',
    );
  });
});

describe('decideCodexToolCall', () => {
  const rw = () => ({ read: [wt, lib], write: [wt] });
  const ro = () => ({ read: [wt, lib], write: [] });
  const patch = (...headers: string[]) => ({ input: `*** Begin Patch\n${headers.join('\n')}\n+x\n*** End Patch\n` });

  it('allows a patch inside the write roots (relative to cwd, or absolute)', () => {
    expect(decideCodexToolCall('apply_patch', patch('*** Update File: src/a.ts'), rw(), wt)).toEqual({ allow: true });
    expect(decideCodexToolCall('apply_patch', patch(`*** Add File: ${join(wt, 'new.ts')}`), rw(), wt)).toEqual({ allow: true });
    expect(decideCodexToolCall('apply_patch', `*** Begin Patch\n*** Delete File: src/a.ts\n*** End Patch`, rw(), wt)).toEqual({ allow: true });
    expect(decideCodexToolCall('Edit', { file_path: 'src/a.ts' }, rw(), wt)).toEqual({ allow: true });
  });

  it('denies a write outside: ../, absolute, through a symlink, a Move to, the read-only library', () => {
    const out = (input: unknown, tool = 'apply_patch') => {
      const d = decideCodexToolCall(tool, input, rw(), wt);
      expect(d.allow, JSON.stringify(input)).toBe(false);
      return (d as { reason: string }).reason;
    };
    expect(out(patch('*** Add File: ../outside/pwned.txt'))).toMatch(/^Limn path guard: refused: \.\.\/outside\/pwned\.txt is outside/);
    expect(out(patch('*** Add File: /tmp/pwned.txt'))).toMatch(/outside the folders this run may change/);
    expect(out(patch('*** Add File: escape/pwned.txt'))).toMatch(/outside/);
    expect(out(patch('*** Update File: src/a.ts', '*** Move to: ../outside/a.ts'))).toMatch(/outside/);
    expect(out(patch(`*** Add File: ${join(lib, 'x.md')}`))).toMatch(/outside/);
    expect(out({ file_path: '/etc/hosts' }, 'Write')).toMatch(/outside/);
    expect(out({ command: ['apply_patch', patch('  ***  Add File:   ../x  ').input] })).toMatch(/outside/); // nested + loose spacing
  });

  it('fails closed: no path found, a read-only run', () => {
    expect(decideCodexToolCall('apply_patch', { input: 'garbage' }, rw(), wt)).toMatchObject({ allow: false, reason: expect.stringMatching(/no file path/) });
    expect(decideCodexToolCall('apply_patch', patch('*** Update File: src/a.ts'), ro(), wt)).toMatchObject({ allow: false, reason: expect.stringMatching(/read-only/) });
  });

  it('allows only Limn workspace MCP tools, and only inside the read roots', () => {
    expect(decideCodexToolCall('mcp__workspace__read_file', { path: 'src/a.ts' }, ro(), wt)).toEqual({ allow: true });
    expect(decideCodexToolCall('mcp__workspace__read_file', { path: join(lib, 'x') }, ro(), wt)).toEqual({ allow: true });
    expect(decideCodexToolCall('mcp__workspace__list_files', {}, ro(), wt)).toEqual({ allow: true });
    expect(decideCodexToolCall('mcp__workspace__read_file', { path: '../outside/secret.env' }, ro(), wt)).toMatchObject({ allow: false });
    expect(decideCodexToolCall('mcp__workspace__read_file', { path: 'escape/secret.env' }, ro(), wt)).toMatchObject({ allow: false });
    expect(decideCodexToolCall('mcp__railway__deploy', {}, ro(), wt)).toMatchObject({ allow: false, reason: expect.stringMatching(/only Limn's workspace tools/) });
    expect(decideCodexToolCall('mcp__workspaceX__read', {}, ro(), wt)).toMatchObject({ allow: false });
  });

  it('is an ALLOW-list: a tool nobody listed is DENIED; only the known-harmless built-ins pass', () => {
    expect(decideCodexToolCall('update_plan', { plan: [] }, ro(), wt)).toEqual({ allow: true });
    for (const tool of ['clock__curr_time', 'shell', 'exec_command', 'view_image', 'read_mcp_resource', 'list_mcp_resources', 'spawn_agent', '']) {
      expect(decideCodexToolCall(tool, {}, rw(), wt), tool).toMatchObject({ allow: false, reason: expect.stringMatching(/is not one Limn allows/) });
    }
  });

  it('reads a patch the way Codex does: a header inside a file’s BODY is not a header', () => {
    // A context line and an added line that merely CONTAIN header text: a valid patch, not refused.
    const valid = [
      '*** Begin Patch',
      '*** Update File: src/a.ts',
      '@@',
      ' *** Add File: /etc/passwd',
      '-old',
      '+new *** Delete File: /etc/hosts',
      '*** End of File',
      '*** Add File: docs/b.md',
      '+*** Update File: /etc/hosts',
      '+plain',
      '*** End Patch',
    ].join('\n');
    expect(writePaths({ input: valid })).toEqual(['src/a.ts', 'docs/b.md']);
    expect(decideCodexToolCall('apply_patch', { input: valid }, rw(), wt)).toEqual({ allow: true });
    // A real header after the body (in header position again) is still read — and refused.
    const sneaky = valid.replace('*** End Patch', '*** Delete File: ../outside/x\n*** End Patch');
    expect(decideCodexToolCall('apply_patch', { input: sneaky }, rw(), wt)).toMatchObject({ allow: false });
    // CRLF patches too.
    expect(writePaths({ input: valid.replace(/\n/g, '\r\n') })).toEqual(['src/a.ts', 'docs/b.md']);
  });

  it('reads the payload shape Codex 0.164.0 sends for apply_patch (recorded in the live run)', () => {
    const recorded = { command: '*** Begin Patch\n*** Add File: ../outside/pwned.txt\n+pwned\n*** End Patch' };
    expect(writePaths(recorded)).toEqual(['../outside/pwned.txt']);
    expect(decideCodexToolCall('apply_patch', recorded, rw(), wt)).toEqual({
      allow: false,
      reason: 'Limn path guard: refused: ../outside/pwned.txt is outside the folders this run may change.',
    });
    expect(decideCodexToolCall('apply_patch', { command: '*** Begin Patch\n*** Add File: ok.txt\n+fine\n*** End Patch' }, rw(), wt)).toEqual({ allow: true });
  });

  it('reads patch paths from every header', () => {
    expect(writePaths({ input: '*** Begin Patch\n*** Update File: a\n*** Move to: b\n*** Add File: c\n*** Delete File: d\n' })).toEqual(['a', 'b', 'c', 'd']);
  });

  it('decodes the roots strictly', () => {
    expect(decodeGuardRoots(encodeGuardRoots({ read: ['/a'], write: [] }))).toEqual({ read: ['/a'], write: [] });
    expect(decodeGuardRoots(undefined)).toBeNull();
    expect(decodeGuardRoots('{')).toBeNull();
    expect(decodeGuardRoots('{"read":["rel"],"write":[]}')).toBeNull();
  });
});

describe('the hook process (dev entry under tsx)', () => {
  const run = (payload: unknown, env: Record<string, string | undefined>) => {
    const h = pathGuardHook({ read: [wt], write: [wt] });
    const r = spawnSync('/bin/sh', ['-c', h.command], {
      input: typeof payload === 'string' ? payload : JSON.stringify(payload),
      env: { ...process.env, ...env },
      encoding: 'utf8',
      timeout: 30_000,
    });
    return { code: r.status, stderr: r.stderr };
  };
  const env = () => pathGuardHook({ read: [wt], write: [wt] }).env;

  it('exits 2 with the reason on stderr for a write outside', () => {
    const r = run({ hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: { input: '*** Begin Patch\n*** Add File: ../outside/p.txt\n+x\n*** End Patch' }, cwd: wt }, env());
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/^Limn path guard: refused: \.\.\/outside\/p\.txt is outside/);
  });

  it('exits 0 for a write inside', () => {
    const r = run({ hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: { input: '*** Begin Patch\n*** Update File: src/a.ts\n*** End Patch' }, cwd: wt }, env());
    expect(r).toEqual({ code: 0, stderr: '' });
  });

  it('fails closed: no roots, unreadable input, no tool name', () => {
    expect(run({ tool_name: 'mcp__workspace__read_file', tool_input: {} }, { [GUARD_ENV]: undefined }).code).toBe(2);
    expect(run('not json', env()).code).toBe(2);
    expect(run({ tool_input: {} }, env()).code).toBe(2);
  });

  it('denies the canary', async () => {
    expect(await hookDeniesCanary(pathGuardHook({ read: [wt], write: [] }))).toBe(true);
  });
}, 60_000);

describe('verifyHookTrusted / inspectHookTrust — the SILENT-SKIP check', () => {
  // A fake `codex` whose `app-server` answers hooks/list with what fake-hooks.json says, and records
  // the environment it was given (fake-env.json).
  let fake: string;
  const hooksFile = (): string => join(dir, 'fake-hooks.json');
  const envFile = (): string => join(dir, 'fake-env.json');
  beforeAll(() => {
    fake = join(dir, 'fake-codex');
    writeFileSync(
      fake,
      `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(join(dir, 'fake-env.json'))}, JSON.stringify(Object.keys(process.env).sort()));
const rl = require('node:readline').createInterface({ input: process.stdin });
rl.on('line', (l) => {
  const m = JSON.parse(l);
  if (m.id === 1) process.stdout.write(JSON.stringify({ id: 1, result: {} }) + '\\n');
  if (m.id === 2) process.stdout.write(JSON.stringify({ id: 2, result: { data: [{ hooks: JSON.parse(fs.readFileSync(${JSON.stringify(join(dir, 'fake-hooks.json'))}, 'utf8')) }] } }) + '\\n');
});
`,
    );
    chmodSync(fake, 0o755);
  });

  const withFake = async (hooks: unknown[]) => {
    writeFileSync(hooksFile(), JSON.stringify(hooks));
    return inspectHookTrust(dir, pathGuardHook({ read: [wt], write: [] }), { binary: fake });
  };

  it("the trust probe sees the run allow-list + CODEX_HOME, never Limn's secrets", async () => {
    process.env.LIMN_TEST_SECRET_SENTINEL = 'x';
    process.env.OPENAI_API_KEY_SAVED = process.env.OPENAI_API_KEY ?? '';
    process.env.OPENAI_API_KEY = 'sk-should-not-pass';
    try {
      await withFake([]);
    } finally {
      delete process.env.LIMN_TEST_SECRET_SENTINEL;
      if (process.env.OPENAI_API_KEY_SAVED) process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY_SAVED;
      else delete process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_API_KEY_SAVED;
    }
    const keys = JSON.parse(readFileSync(envFile(), 'utf8')) as string[];
    expect(keys).toContain('CODEX_HOME');
    expect(keys).not.toContain('LIMN_TEST_SECRET_SENTINEL');
    expect(keys).not.toContain('OPENAI_API_KEY');
    expect(keys.every((k) => ['CODEX_HOME', ...CODEX_ENV_ALLOW].includes(k) || k === '__CF_USER_TEXT_ENCODING')).toBe(true);
  }, 30_000);
  const h = () => pathGuardHook({ read: [wt], write: [] });
  const entry = (over: object) => ({ key: SESSION_FLAG_PRE_TOOL_USE_KEY, source: 'sessionFlags', currentHash: h().trustedHash, trustStatus: 'trusted', enabled: true, ...over });

  it('trusted + current hash + canary denied ⇒ true', async () => {
    expect(await withFake([entry({})])).toMatchObject({ trusted: true, reason: null });
  }, 30_000);

  it('untrusted ⇒ false (the case Codex would skip without a word)', async () => {
    expect(await withFake([entry({ trustStatus: 'untrusted' })])).toMatchObject({ trusted: false, reason: expect.stringMatching(/untrusted, so it would be skipped/) });
  }, 30_000);

  it('modified, a different hash, disabled, missing ⇒ false', async () => {
    expect((await withFake([entry({ trustStatus: 'modified' })])).trusted).toBe(false);
    expect((await withFake([entry({ currentHash: 'sha256:00' })])).reason).toMatch(/hashes the hook as sha256:00/);
    expect((await withFake([entry({ enabled: false })])).reason).toMatch(/disabled/);
    expect((await withFake([])).reason).toMatch(/did not load/);
  }, 30_000);

  it('no answer ⇒ false', async () => {
    expect((await inspectHookTrust(dir, h(), { binary: join(dir, 'no-such-codex') })).trusted).toBe(false);
  });
});
