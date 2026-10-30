// The AI runtime INSTALLER (ai/runtime.ts `install`), over temp directories only: each case runs a
// stand-in npm as a real child process, which is why this file is in the slow project
// (vitest.workspace.ts, docs/TESTING.md). The loader's tests are in runtime.test.ts.
import { mkdirSync, readFileSync, realpathSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AI_RUNTIME_MANIFEST_FIELD,
  AI_RUNTIME_PACKAGES,
  AiRuntimeMissingError,
  CODEX_PACKAGE,
  createAiRuntime,
} from './runtime.js';
import {
  PINS,
  PLATFORM_PKG,
  CODEX_PLATFORM_PKG,
  CODEX_TRIPLE,
  CODEX_PIN,
  root,
  dataDir,
  emptyWorkspace,
  packageRoot,
  write,
  seedPackages,
  runtime,
} from './runtime.test-support.js';

describe('installing the AI runtime', () => {
  /** A stand-in for npm: honours `--prefix`, installs the package.json's dependencies as fakes. */
  function fakeNpm(
    behaviour: 'ok' | 'fail' | 'wrong-version' | 'no-binary' | 'codex-fail',
  ): { command: string; args: string[] } {
    const script = join(root, `fake-npm-${behaviour}.mjs`);
    const counter = join(root, 'npm-calls');
    write(
      script,
      `
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
appendFileSync(${JSON.stringify(counter)}, 'x');
const args = process.argv.slice(2);
const prefix = args[args.indexOf('--prefix') + 1];
if (${JSON.stringify(behaviour)} === 'fail') {
  console.error('npm ERR! code ENOTFOUND');
  console.error('npm ERR! network request failed');
  process.exit(1);
}
console.log('http fetch GET 200 https://registry.npmjs.org/zod');
const deps = JSON.parse(readFileSync(join(prefix, 'package.json'), 'utf8')).dependencies;
if (${JSON.stringify(behaviour)} === 'codex-fail' && '@openai/codex' in deps) {
  console.error('npm ERR! 404 @openai/codex-darwin-arm64 not found');
  process.exit(1);
}
for (const [name, version] of Object.entries(deps)) {
  const dir = join(prefix, 'node_modules', name);
  mkdirSync(dir, { recursive: true });
  const v = ${JSON.stringify(behaviour)} === 'wrong-version' ? '9.9.9' : version;
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name, version: v, type: 'module', exports: { '.': './index.js', './server': './index.js' } }),
  );
  writeFileSync(join(dir, 'index.js'), 'export const ok = true;\\n');
}
// The SDK's optional native package: skipped by --omit=optional, or lost to a non-fatal failure.
if (${JSON.stringify(behaviour)} !== 'no-binary' && !args.includes('--omit=optional')) {
  const bin = join(prefix, 'node_modules', ${JSON.stringify(PLATFORM_PKG)});
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'package.json'), JSON.stringify({ name: ${JSON.stringify(PLATFORM_PKG)}, version: '0.0.0' }));
  writeFileSync(join(bin, process.platform === 'win32' ? 'claude.exe' : 'claude'), 'binary');
}
// The Codex CLI's native program: an OPTIONAL dependency too, one platform package (npm alias).
if ('@openai/codex' in deps && ${JSON.stringify(behaviour)} !== 'no-binary') {
  const plat = join(prefix, 'node_modules', ${JSON.stringify(CODEX_PLATFORM_PKG)});
  mkdirSync(join(plat, 'vendor', ${JSON.stringify(CODEX_TRIPLE)}, 'bin'), { recursive: true });
  writeFileSync(join(plat, 'package.json'), JSON.stringify({ name: '@openai/codex', version: deps['@openai/codex'] + '-plat' }));
  writeFileSync(join(plat, 'vendor', ${JSON.stringify(CODEX_TRIPLE)}, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex'), 'binary');
}
await new Promise((r) => setTimeout(r, 50));
`,
    );
    return { command: process.execPath, args: [script] };
  }
  const npmCalls = (): number =>
    existsSync(join(root, 'npm-calls')) ? readFileSync(join(root, 'npm-calls'), 'utf8').length : 0;

  it('downloads the exact pins into ai-runtime and reports ready', async () => {
    const rt = runtime();
    const phases: string[] = [];
    const result = await rt.install((p) => phases.push(p.phase), { npm: fakeNpm('ok') });
    expect(result).toEqual({ ok: true });
    expect(rt.status()).toEqual({ runtime: 'ready', runtimeMessage: null });
    const manifest = JSON.parse(readFileSync(join(dataDir, 'ai-runtime', 'package.json'), 'utf8'));
    expect(manifest.dependencies).toEqual(PINS);
    expect(phases[0]).toBe('starting');
    expect(phases).toContain('downloading');
    expect(phases.at(-1)).toBe('done');
    // No staging or old directory is left behind.
    expect(readdirSync(dataDir)).toEqual(['ai-runtime']);
  });

  it('is single-flight: a second press joins the running download', async () => {
    const rt = runtime();
    const npm = fakeNpm('ok');
    const a = rt.install(undefined, { npm });
    expect(rt.status().runtime).toBe('installing');
    const b = rt.install(undefined, { npm });
    expect(await a).toEqual({ ok: true });
    expect(await b).toEqual({ ok: true });
    expect(npmCalls()).toBe(1);
  });

  it('a failed download says what to do, keeps nothing, and reports failed', async () => {
    const rt = runtime();
    const result = await rt.install(undefined, { npm: fakeNpm('fail') });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/limn ai install/);
    expect(result.message).toMatch(/npm ERR!/);
    expect(rt.status()).toEqual({ runtime: 'failed', runtimeMessage: result.message });
    expect(readdirSync(dataDir)).toEqual([]);
  });

  it('refuses a download that did not deliver the pinned versions', async () => {
    const rt = runtime();
    const result = await rt.install(undefined, { npm: fakeNpm('wrong-version') });
    expect(result.ok).toBe(false);
    expect(existsSync(join(dataDir, 'ai-runtime'))).toBe(false);
  });

  it('⚠ refuses a download whose native Claude Code program is missing (npm exits 0 on that)', async () => {
    const rt = runtime();
    const result = await rt.install(undefined, { npm: fakeNpm('no-binary') });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/Claude Code program/);
    expect(existsSync(join(dataDir, 'ai-runtime'))).toBe(false);
  });

  it('⚠ an install made with LIMN_CLAUDE_PATH is no longer ready once it is unset', async () => {
    const withPath = createAiRuntime({
      dataDir,
      workspaceFrom: emptyWorkspace,
      packageRoot,
      env: { LIMN_CLAUDE_PATH: '/usr/local/bin/claude' },
    });
    expect(await withPath.install(undefined, { npm: fakeNpm('ok') })).toEqual({ ok: true });
    expect(withPath.status().runtime).toBe('ready');
    const without = runtime();
    expect(without.status()).toEqual({
      runtime: 'absent',
      runtimeMessage: expect.stringMatching(/Claude Code program is missing/),
    });
    await expect(without.load('zod')).rejects.toBeInstanceOf(AiRuntimeMissingError);
  });

  it('says so when npm cannot be found', async () => {
    const rt = runtime();
    const result = await rt.install(undefined, {
      npm: { command: join(root, 'no-such-npm'), args: [] },
    });
    expect(result).toEqual({ ok: false, message: expect.stringMatching(/npm was not found/) });
  });

  it('refuses to guess when this copy carries no pins', async () => {
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: 'limn-review' }));
    const result = await runtime().install(undefined, { npm: fakeNpm('ok') });
    expect(result.ok).toBe(false);
    expect(npmCalls()).toBe(0);
  });

  it('lists exactly the four SDKs and the three docs converters', () => {
    expect([...AI_RUNTIME_PACKAGES].sort()).toEqual(Object.keys(PINS).sort());
  });

  it('an install from before the docs converters is STALE, still loads the SDK, and refuses only a converter', async () => {
    seedPackages(join(dataDir, 'ai-runtime'), PINS, { later: false });
    const rt = runtime();
    expect(rt.status().runtime).toBe('absent');
    expect(rt.status().runtimeMessage).toMatch(/Set up AI again/);
    const sdk = (await rt.load('@anthropic-ai/claude-agent-sdk')) as { query(): string };
    expect(sdk.query()).toBe('fake');
    await expect(rt.load('mammoth')).rejects.toBeInstanceOf(AiRuntimeMissingError);
  });

  it('loads a CommonJS converter from the runtime directory by its main file', async () => {
    seedPackages(join(dataDir, 'ai-runtime'));
    const mod = (await runtime().load('turndown')) as { default?: { which: string } };
    expect(mod.default?.which).toBe('turndown');
  });

  // ---- Codex (docs/CODEX-PLAN.md § 3.7): the CLI rides the same directory, only when asked ----

  const withCodexPin = (): void =>
    writeFileSync(
      join(packageRoot, 'package.json'),
      JSON.stringify({ name: 'limn-review', [AI_RUNTIME_MANIFEST_FIELD]: { ...PINS, [CODEX_PACKAGE]: CODEX_PIN } }),
    );

  it('a Claude install never downloads Codex, even when this copy pins it', async () => {
    withCodexPin();
    const rt = runtime();
    expect(await rt.install(undefined, { npm: fakeNpm('ok') })).toEqual({ ok: true });
    const manifest = JSON.parse(readFileSync(join(dataDir, 'ai-runtime', 'package.json'), 'utf8'));
    expect(manifest.dependencies).toEqual(PINS);
    expect(rt.codexStatus()).toEqual({ runtime: 'absent', runtimeMessage: null });
    expect(rt.codexBinary()).toBeNull();
  });

  it('install with codex: the exact pin, verified, and its native program located', async () => {
    withCodexPin();
    const rt = runtime();
    const phases: string[] = [];
    expect(await rt.install((p) => phases.push(p.message), { npm: fakeNpm('ok'), providers: ['codex'] })).toEqual({ ok: true });
    const manifest = JSON.parse(readFileSync(join(dataDir, 'ai-runtime', 'package.json'), 'utf8'));
    expect(manifest.dependencies).toEqual({ ...PINS, [CODEX_PACKAGE]: CODEX_PIN });
    expect(rt.codexStatus()).toEqual({ runtime: 'ready', runtimeMessage: null });
    expect(rt.status()).toEqual({ runtime: 'ready', runtimeMessage: null });
    const bin = rt.codexBinary();
    expect(bin).toBe(
      join(realpathSync(rt.runtimeDir), 'node_modules', CODEX_PLATFORM_PKG, 'vendor', CODEX_TRIPLE, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex'),
    );
    expect(phases.at(-1)).toBe('AI is set up, with Codex.');
    // Claude and Codex are staged APART: two downloads.
    expect(npmCalls()).toBe(2);
    // A later Claude-only install (an update, "Set up AI again") KEEPS Codex — and never re-downloads it.
    expect(await rt.install(undefined, { npm: fakeNpm('ok') })).toEqual({ ok: true });
    expect(npmCalls()).toBe(3);
    expect(JSON.parse(readFileSync(join(dataDir, 'ai-runtime', 'package.json'), 'utf8')).dependencies[CODEX_PACKAGE]).toBe(CODEX_PIN);
    expect(rt.codexStatus().runtime).toBe('ready');
    expect(rt.codexBinary()).toBe(bin);
    expect(readdirSync(dataDir)).toEqual(['ai-runtime']);
  });

  it('⚠ a Claude-only "Set up AI" never fails for Codex: a broken Codex download is not even attempted', async () => {
    withCodexPin();
    const rt = runtime();
    expect(await rt.install(undefined, { npm: fakeNpm('ok'), providers: ['codex'] })).toEqual({ ok: true });
    // Codex's registry is down now; Claude's repair must still go through, keeping the old Codex.
    expect(await rt.install(undefined, { npm: fakeNpm('codex-fail') })).toEqual({ ok: true });
    expect(rt.status()).toEqual({ runtime: 'ready', runtimeMessage: null });
    expect(rt.codexStatus()).toEqual({ runtime: 'ready', runtimeMessage: null });
  });

  it('⚠ a failed Codex download is CODEX’s failure alone: Claude is set up, an old Codex is kept', async () => {
    withCodexPin();
    const rt = runtime();
    // No Codex yet: Claude installs; Codex reports the failure and nothing else does.
    const first = await rt.install(undefined, { npm: fakeNpm('codex-fail'), providers: ['codex'] });
    expect(first).toEqual({ ok: false, message: expect.stringMatching(/limn ai install codex/) });
    expect(rt.status()).toEqual({ runtime: 'ready', runtimeMessage: null });
    expect(rt.codexStatus()).toEqual({ runtime: 'failed', runtimeMessage: (first as { message: string }).message });
    expect(readdirSync(dataDir)).toEqual(['ai-runtime']);
    // With a working Codex in place, a failed re-download KEEPS it.
    expect(await rt.install(undefined, { npm: fakeNpm('ok'), providers: ['codex'] })).toEqual({ ok: true });
    const bin = rt.codexBinary();
    const again = await rt.install(undefined, { npm: fakeNpm('codex-fail'), providers: ['codex'] });
    expect(again.ok).toBe(false);
    expect(rt.status().runtime).toBe('ready');
    expect(rt.codexBinary()).toBe(bin);
    expect(rt.codexStatus().runtime).toBe('ready');
  });

  it('a Codex download without its platform program fails, naming it, and keeps the old runtime', async () => {
    withCodexPin();
    const rt = runtime();
    const result = await rt.install(undefined, { npm: fakeNpm('no-binary'), providers: ['codex'] });
    expect(result.ok).toBe(false);
    // The Claude binary is missing too in this mode, and is checked first; either way nothing swapped in.
    expect(existsSync(join(dataDir, 'ai-runtime'))).toBe(false);
    expect(rt.codexStatus().runtime).toBe('failed');
  });

  it('refuses to download Codex when this copy does not pin it — as Codex’s failure, never Claude’s', async () => {
    const rt = runtime();
    const result = await rt.install(undefined, { npm: fakeNpm('ok'), providers: ['codex'] });
    expect(result).toEqual({ ok: false, message: expect.stringMatching(/which Codex version/) });
    expect(npmCalls()).toBe(0);
    expect(rt.status().runtime).not.toBe('failed');
    expect(rt.codexStatus().runtime).toBe('failed');
  });

  it('a Codex at another pin still runs, and says "set up again"', async () => {
    withCodexPin();
    const rt = runtime();
    await rt.install(undefined, { npm: fakeNpm('ok'), providers: ['codex'] });
    writeFileSync(
      join(packageRoot, 'package.json'),
      JSON.stringify({ name: 'limn-review', [AI_RUNTIME_MANIFEST_FIELD]: { ...PINS, [CODEX_PACKAGE]: '0.165.0' } }),
    );
    const later = runtime();
    expect(later.codexStatus()).toEqual({ runtime: 'absent', runtimeMessage: expect.stringMatching(/Set up Codex again/) });
    expect(later.codexBinary()).not.toBeNull();
  });

  it('LIMN_CODEX_PATH stands in for the download', () => {
    const rt = createAiRuntime({ dataDir, workspaceFrom: emptyWorkspace, packageRoot, env: { LIMN_CODEX_PATH: 'bin/my-codex' } });
    expect(rt.codexStatus()).toEqual({ runtime: 'ready', runtimeMessage: null });
    expect(rt.codexBinary()).toBe(join(process.cwd(), 'bin', 'my-codex'));
  });
});
