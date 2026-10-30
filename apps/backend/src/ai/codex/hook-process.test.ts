// The PreToolUse path guard RUN AS CODEX RUNS IT: the hook as a spawned process, and the trust probe
// that refuses a run unless Codex will really call it (Codex skips an untrusted hook SILENTLY). Each
// case starts a process, so this file is in the slow project (vitest.workspace.ts, docs/TESTING.md);
// the guard's rules, in process, are in hook.test.ts.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  hookDeniesCanary,
  inspectHookTrust,
  pathGuardHook,
  SESSION_FLAG_PRE_TOOL_USE_KEY,
} from './hook.js';
import { CODEX_ENV_ALLOW } from './config.js';
import { GUARD_ENV } from './hook-rule.js';

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
