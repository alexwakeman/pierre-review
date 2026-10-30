// The shared temp-directory fixtures for runtime.test.ts and runtime-install.test.ts: a fresh root
// per case (the hooks below register in whichever suite imports this), fake packages laid down
// on disk, and a runtime pointed at an EMPTY workspace — what an `npx limn-review` install looks
// like. Never the developer's ~/.limn.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach } from 'vitest';
import { AI_RUNTIME_MANIFEST_FIELD, createAiRuntime } from './runtime.js';

export const PINS = {
  '@anthropic-ai/claude-agent-sdk': '0.3.1',
  '@anthropic-ai/sdk': '0.90.0',
  '@modelcontextprotocol/sdk': '1.2.3',
  zod: '4.0.1',
  mammoth: '1.13.0',
  turndown: '7.2.4',
  'turndown-plugin-gfm': '1.0.2',
} as const;

export const PLATFORM_PKG = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
export const CODEX_PLATFORM_PKG = `@openai/codex-${process.platform}-${process.arch}`;
export const CODEX_TRIPLE = (
  {
    'darwin-x64': 'x86_64-apple-darwin',
    'darwin-arm64': 'aarch64-apple-darwin',
    'linux-x64': 'x86_64-unknown-linux-musl',
    'linux-arm64': 'aarch64-unknown-linux-musl',
    'win32-x64': 'x86_64-pc-windows-msvc',
    'win32-arm64': 'aarch64-pc-windows-msvc',
  } as Record<string, string>
)[`${process.platform}-${process.arch}`]!;
export const CODEX_PIN = '0.164.0';

export let root: string;
export let dataDir: string;
export let emptyWorkspace: string;
export let packageRoot: string;

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

export const write = (file: string, text: string): void => {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, text);
};

/** Lay down fake copies of the four packages, shaped like the real ones where it matters. */
export function seedPackages(
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

export const runtime = () => createAiRuntime({ dataDir, workspaceFrom: emptyWorkspace, packageRoot, env: {} });
