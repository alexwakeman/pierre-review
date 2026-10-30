// The AI runtime loader (ai/runtime.ts), over temp directories only — never the developer's
// ~/.limn. Every runtime here is built with `workspaceFrom` pointed at an EMPTY directory, which is
// what an `npx limn-review` install looks like: no AI SDK in its own node_modules.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AI_RUNTIME_MANIFEST_FIELD,
  AI_RUNTIME_PACKAGES,
  AiRuntimeMissingError,
  CODEX_PACKAGE,
  claudeExecutableOptions,
  codexBinaryIn,
  createAiRuntime,
  esmEntryOf,
} from './runtime.js';

const PINS = {
  '@anthropic-ai/claude-agent-sdk': '0.3.1',
  '@anthropic-ai/sdk': '0.90.0',
  '@modelcontextprotocol/sdk': '1.2.3',
  zod: '4.0.1',
  mammoth: '1.13.0',
  turndown: '7.2.4',
  'turndown-plugin-gfm': '1.0.2',
} as const;

const PLATFORM_PKG = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
const CODEX_PLATFORM_PKG = `@openai/codex-${process.platform}-${process.arch}`;
const CODEX_TRIPLE = (
  {
    'darwin-x64': 'x86_64-apple-darwin',
    'darwin-arm64': 'aarch64-apple-darwin',
    'linux-x64': 'x86_64-unknown-linux-musl',
    'linux-arm64': 'aarch64-unknown-linux-musl',
    'win32-x64': 'x86_64-pc-windows-msvc',
    'win32-arm64': 'aarch64-pc-windows-msvc',
  } as Record<string, string>
)[`${process.platform}-${process.arch}`]!;
const CODEX_PIN = '0.164.0';

let root: string;
let dataDir: string;
let emptyWorkspace: string;
let packageRoot: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'limn-ai-runtime-'));
  dataDir = join(root, 'data');
  emptyWorkspace = join(root, 'workspace');
  packageRoot = join(root, 'pkg');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(emptyWorkspace, { recursive: true });
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    join(packageRoot, 'package.json'),
    JSON.stringify({ name: 'limn-review', [AI_RUNTIME_MANIFEST_FIELD]: PINS }),
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const write = (file: string, text: string): void => {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, text);
};

/** Lay down fake copies of the four packages, shaped like the real ones where it matters. */
function seedPackages(
  prefix: string,
  versions: Record<string, string> = PINS,
  { binary = true, later = true }: { binary?: boolean; later?: boolean } = {},
): void {
  const nm = join(prefix, 'node_modules');
  // The reference-docs converters: plain CommonJS, `main` only, like the real ones.
  if (later) {
    for (const name of ['mammoth', 'turndown', 'turndown-plugin-gfm'] as const) {
      write(join(nm, name, 'package.json'), JSON.stringify({ name, version: versions[name], main: './lib/index.js' }));
      write(join(nm, name, 'lib', 'index.js'), `module.exports = { which: '${name}' };\n`);
    }
  }
  // The Agent SDK's native program: an OPTIONAL dependency, one package per platform.
  if (binary) {
    const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
    write(join(nm, PLATFORM_PKG, 'package.json'), JSON.stringify({ name: PLATFORM_PKG, version: '0.0.0' }));
    write(join(nm, PLATFORM_PKG, exe), 'binary');
  }
  // zod: DUAL — `require` gets index.cjs, `import` gets index.js. Loading the wrong one is the
  // two-instances bug, so the two files say which they are.
  write(
    join(nm, 'zod', 'package.json'),
    JSON.stringify({
      name: 'zod',
      version: versions.zod,
      type: 'module',
      exports: { '.': { types: './index.d.cts', import: './index.js', require: './index.cjs' } },
    }),
  );
  write(join(nm, 'zod', 'index.js'), "export const z = { flavour: 'esm' };\n");
  write(join(nm, 'zod', 'index.cjs'), "module.exports = { z: { flavour: 'cjs' } };\n");
  // The Agent SDK imports zod ITSELF, by bare specifier, from its own install.
  write(
    join(nm, '@anthropic-ai', 'claude-agent-sdk', 'package.json'),
    JSON.stringify({
      name: '@anthropic-ai/claude-agent-sdk',
      version: versions['@anthropic-ai/claude-agent-sdk'],
      type: 'module',
      exports: { '.': { types: './sdk.d.ts', default: './sdk.mjs' } },
    }),
  );
  write(
    join(nm, '@anthropic-ai', 'claude-agent-sdk', 'sdk.mjs'),
    "import { z } from 'zod';\nexport const zodSeenBySdk = z;\nexport function query() { return 'fake'; }\n",
  );
  write(
    join(nm, '@anthropic-ai', 'sdk', 'package.json'),
    JSON.stringify({
      name: '@anthropic-ai/sdk',
      version: versions['@anthropic-ai/sdk'],
      exports: { '.': { require: { default: './index.js' }, types: './index.d.mts', default: './index.mjs' } },
    }),
  );
  write(join(nm, '@anthropic-ai', 'sdk', 'index.mjs'), 'export default class Anthropic {}\n');
  write(join(nm, '@anthropic-ai', 'sdk', 'index.js'), 'module.exports = {};\n');
  write(
    join(nm, '@modelcontextprotocol', 'sdk', 'package.json'),
    JSON.stringify({
      name: '@modelcontextprotocol/sdk',
      version: versions['@modelcontextprotocol/sdk'],
      type: 'module',
      // Like the real 1.29: the ROOT export names a file that is not shipped; `./server` is real.
      exports: {
        '.': { import: './dist/esm/index.js', require: './dist/cjs/index.js' },
        './server': { import: './dist/esm/server/index.js', require: './dist/cjs/server/index.js' },
      },
    }),
  );
  write(join(nm, '@modelcontextprotocol', 'sdk', 'dist', 'esm', 'server', 'index.js'), 'export const mcp = true;\n');
  write(join(prefix, 'package.json'), JSON.stringify({ name: 'limn-ai-runtime', private: true }));
}

const runtime = () => createAiRuntime({ dataDir, workspaceFrom: emptyWorkspace, packageRoot, env: {} });

describe('esmEntryOf', () => {
  it('takes the ESM condition, never `require`', () => {
    seedPackages(join(root, 'probe'));
    const zodDir = join(root, 'probe', 'node_modules', 'zod');
    expect(esmEntryOf(zodDir)).toBe(join(zodDir, 'index.js'));
    const sdkDir = join(root, 'probe', 'node_modules', '@anthropic-ai', 'sdk');
    expect(esmEntryOf(sdkDir)).toBe(join(sdkDir, 'index.mjs'));
    const mcpDir = join(root, 'probe', 'node_modules', '@modelcontextprotocol', 'sdk');
    expect(esmEntryOf(mcpDir)).toBeNull(); // the root export's file is not shipped
    expect(esmEntryOf(mcpDir, './server')).toBe(join(mcpDir, 'dist', 'esm', 'server', 'index.js'));
  });
});

describe('the AI runtime loader', () => {
  it('is absent on a fresh install, and a loader says how to fix that', async () => {
    const rt = runtime();
    expect(rt.status()).toEqual({ runtime: 'absent', runtimeMessage: null });
    await expect(rt.load('@anthropic-ai/claude-agent-sdk')).rejects.toBeInstanceOf(AiRuntimeMissingError);
    await expect(rt.load('zod')).rejects.toThrow(/limn ai install/);
  });

  it('loads every package from <dataDir>/ai-runtime once it is there', async () => {
    seedPackages(join(dataDir, 'ai-runtime'));
    const rt = runtime();
    expect(rt.status()).toEqual({ runtime: 'ready', runtimeMessage: null });
    const mcp = await rt.load<{ mcp: boolean }>('@modelcontextprotocol/sdk');
    expect(mcp.mcp).toBe(true);
    const anthropic = await rt.load<{ default: unknown }>('@anthropic-ai/sdk');
    expect(typeof anthropic.default).toBe('function');
  });

  it('hands out the SAME zod instance the Agent SDK imports for itself', async () => {
    seedPackages(join(dataDir, 'ai-runtime'));
    const rt = runtime();
    const zod = await rt.load<{ z: { flavour: string } }>('zod');
    const sdk = await rt.load<{ zodSeenBySdk: unknown }>('@anthropic-ai/claude-agent-sdk');
    expect(zod.z.flavour).toBe('esm');
    expect(sdk.zodSeenBySdk).toBe(zod.z);
  });

  it('a miss is not remembered: setting AI up later makes the next load work', async () => {
    const rt = runtime();
    await expect(rt.load('zod')).rejects.toBeInstanceOf(AiRuntimeMissingError);
    seedPackages(join(dataDir, 'ai-runtime'));
    await expect(rt.load<{ z: unknown }>('zod')).resolves.toHaveProperty('z');
  });

  it('asks for a fresh download when an upgrade moved the pins', () => {
    seedPackages(join(dataDir, 'ai-runtime'), { ...PINS, '@anthropic-ai/claude-agent-sdk': '0.2.0' });
    const s = runtime().status();
    expect(s.runtime).toBe('absent');
    expect(s.runtimeMessage).toMatch(/Set up AI again/);
  });

  it('reads EXACT pins from the manifest field and refuses a range', () => {
    expect(runtime().pins()).toEqual(PINS);
    writeFileSync(
      join(packageRoot, 'package.json'),
      JSON.stringify({ [AI_RUNTIME_MANIFEST_FIELD]: { ...PINS, zod: '^4' } }),
    );
    expect(runtime().pins()).toBeNull();
  });
});

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
    // The current STEP rides the status, so a download nobody pressed for (the first-boot one) shows it.
    expect(rt.status().runtimeMessage).toBe('Downloading Claude (about 110 MB).');
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
    expect(phases).toContain('Downloading Codex (about 360 MB unpacked).');
    // The step is cleared once the download ends.
    expect(rt.codexStatus().runtimeMessage).toBeNull();
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

  it('⚠ a Claude that is already ready stays ready while a download runs (the first boot adding Codex)', async () => {
    withCodexPin();
    const rt = runtime();
    expect(await rt.install(undefined, { npm: fakeNpm('ok') })).toEqual({ ok: true });
    const running = rt.install(undefined, { npm: fakeNpm('ok'), providers: ['claude', 'codex'] });
    expect(rt.status()).toEqual({ runtime: 'ready', runtimeMessage: null });
    expect(rt.codexStatus().runtime).toBe('installing');
    expect(await running).toEqual({ ok: true });
    expect(rt.codexStatus().runtime).toBe('ready');
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

describe('codexBinaryIn', () => {
  it('finds the platform program from the CLI package, and nothing on an unknown platform', () => {
    const prefix = join(root, 'codex-prefix');
    write(join(prefix, 'node_modules', '@openai', 'codex', 'package.json'), JSON.stringify({ name: '@openai/codex', version: CODEX_PIN }));
    expect(codexBinaryIn(prefix)).toBeNull();
    const exe = join(prefix, 'node_modules', '@openai', 'codex-linux-arm64', 'vendor', 'aarch64-unknown-linux-musl', 'bin', 'codex');
    write(exe, 'binary');
    write(join(prefix, 'node_modules', '@openai', 'codex-linux-arm64', 'package.json'), JSON.stringify({ name: '@openai/codex' }));
    expect(codexBinaryIn(prefix, 'linux', 'arm64')).toBe(realpathSync(exe));
    expect(codexBinaryIn(prefix, 'sunos', 'x64')).toBeNull();
  });

  it('never finds a Codex installed ABOVE the prefix (a parent folder, a global prefix)', () => {
    // A Codex (CLI + platform program) in a PARENT folder's node_modules; the prefix itself is empty.
    const parent = join(root, 'codex-parent');
    const prefix = join(parent, 'inner', 'ai-runtime');
    write(join(prefix, 'package.json'), '{}');
    write(join(parent, 'node_modules', '@openai', 'codex', 'package.json'), JSON.stringify({ name: '@openai/codex', version: CODEX_PIN }));
    const exe = join(parent, 'node_modules', '@openai', 'codex-linux-arm64', 'vendor', 'aarch64-unknown-linux-musl', 'bin', 'codex');
    write(exe, 'binary');
    write(join(parent, 'node_modules', '@openai', 'codex-linux-arm64', 'package.json'), JSON.stringify({ name: 'x' }));
    expect(codexBinaryIn(prefix, 'linux', 'arm64')).toBeNull();
    // The CLI inside the prefix, its platform program only ABOVE it: still nothing.
    write(join(prefix, 'node_modules', '@openai', 'codex', 'package.json'), JSON.stringify({ name: '@openai/codex', version: CODEX_PIN }));
    expect(codexBinaryIn(prefix, 'linux', 'arm64')).toBeNull();
    // Hoisted to the prefix: found.
    const inner = join(prefix, 'node_modules', '@openai', 'codex-linux-arm64', 'vendor', 'aarch64-unknown-linux-musl', 'bin', 'codex');
    write(inner, 'binary');
    write(join(prefix, 'node_modules', '@openai', 'codex-linux-arm64', 'package.json'), JSON.stringify({ name: 'x' }));
    expect(codexBinaryIn(prefix, 'linux', 'arm64')).toBe(realpathSync(inner));
  });
});

describe('LIMN_CLAUDE_PATH', () => {
  it('is opt-in: unset means the SDK uses its bundled binary', () => {
    expect(claudeExecutableOptions({})).toEqual({});
    expect(claudeExecutableOptions({ LIMN_CLAUDE_PATH: '  ' })).toEqual({});
  });

  it('becomes pathToClaudeCodeExecutable, absolute', () => {
    expect(claudeExecutableOptions({ LIMN_CLAUDE_PATH: '/usr/local/bin/claude' })).toEqual({
      pathToClaudeCodeExecutable: '/usr/local/bin/claude',
    });
    const rel = claudeExecutableOptions({ LIMN_CLAUDE_PATH: 'bin/claude' }).pathToClaudeCodeExecutable;
    expect(rel && rel.startsWith('/')).toBe(true);
  });
});

describe('dev is unchanged', () => {
  it('the workspace node_modules resolve the SDKs with no runtime directory at all', async () => {
    const rt = createAiRuntime({ dataDir, packageRoot, env: {} });
    expect(rt.status().runtime).toBe('ready');
    const sdk = await rt.load<{ query: unknown }>('@anthropic-ai/claude-agent-sdk');
    expect(typeof sdk.query).toBe('function');
    expect(existsSync(join(dataDir, 'ai-runtime'))).toBe(false);
  });
});
