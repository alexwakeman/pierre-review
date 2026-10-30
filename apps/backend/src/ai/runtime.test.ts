// The AI runtime loader (ai/runtime.ts), over temp directories only — never the developer's
// ~/.limn. Every runtime here is built with `workspaceFrom` pointed at an EMPTY directory, which is
// what an `npx limn-review` install looks like: no AI SDK in its own node_modules.
//
// The temp-directory fixtures (fake packages laid down on disk) are in runtime.test-support.ts; the
// INSTALLER, which runs a stand-in npm process per case, is in runtime-install.test.ts (the slow
// project, vitest.workspace.ts).
import { realpathSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AI_RUNTIME_MANIFEST_FIELD,
  AiRuntimeMissingError,
  claudeExecutableOptions,
  codexBinaryIn,
  createAiRuntime,
  esmEntryOf,
} from './runtime.js';
import {
  PINS,
  CODEX_PIN,
  root,
  dataDir,
  packageRoot,
  write,
  seedPackages,
  runtime,
} from './runtime.test-support.js';

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
