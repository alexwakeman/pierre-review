// EVERY MODEL CALL GOES THROUGH THE PROVIDER (ai/provider.ts; docs/CODEX-PLAN.md § 3.1). A SOURCE SCAN,
// like the frontend's aiGating test: no module other than ai/providers/claude.ts and ai/runtime.ts may
// call the Agent SDK's `query` or load the Anthropic SDK, and every runner the seam covers reaches it.
//
// Why a scan and not an import: the runners reach db/client.ts (which opens SQLite at import time)
// and the SDKs, which a unit test has no business loading. What is guarded is the presence of a call,
// which a scan reads exactly. Comment lines are dropped first, so a comment naming `query(` or
// `loadAgentSdk` cannot read as a call. ⚠ A SCAN THAT CANNOT FAIL IS WORSE THAN NO SCAN: the last
// test mutates a runner in memory and asserts the predicate flips.
//
//   pnpm --filter @pierre-review/backend test ai/provider-seam
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('..', import.meta.url));
const rel = (f: string): string => relative(SRC, f).split('\\').join('/');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === 'node_modules' ? [] : sourceFiles(p);
    return p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.endsWith('.d.ts') ? [p] : [];
  });
}

/** The source without comment lines and trailing `//` comments (block comments too). */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .map((l) => l.replace(/\s\/\/ .*$/, ''))
    .join('\n');
}

// A call of the Agent SDK's query (bare, or off the loaded module), or a load of either SDK.
const SDK_CALL = /(?:^|[^\w.])query\(\{|\bsdk\.query\(|\bloadAgentSdk\s*\(|\bloadAnthropicSdk\s*\(/m;
const isSdkCaller = (src: string): boolean => SDK_CALL.test(code(src));

const ALLOWED = new Set(['ai/providers/claude.ts', 'ai/runtime.ts']);

// The 12 runners + the one-shot seam the provider must cover (docs/CODEX-PLAN.md § 3.1).
const RUNNERS = [
  'review/agent.ts',
  'coding/agent.ts',
  'reference-docs/agent.ts',
  'review/chat-agent.ts',
  'review/ci-review/agent.ts',
  'review/claude-review/thread-check-agent.ts',
  'review/diagrams/agent.ts',
  'review/sprint-paths/agent.ts',
  'review/story-docs/agent.ts',
  'review/ticket-review/agent.ts',
  'review/ticket-review/prepass.ts',
  'review/llm.ts',
];

describe('the provider seam', () => {
  it('no module but the Claude provider and the runtime calls query() or loads an SDK', () => {
    const offenders = sourceFiles(SRC)
      .filter((f) => !ALLOWED.has(rel(f)))
      .filter((f) => isSdkCaller(readFileSync(f, 'utf8')))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it('the Claude provider is where the calls are', () => {
    const src = readFileSync(join(SRC, 'ai/providers/claude.ts'), 'utf8');
    expect(isSdkCaller(src)).toBe(true);
    expect(code(src)).toMatch(/loadAnthropicSdk\(\)/);
  });

  it('every runner goes through the active provider', () => {
    for (const f of RUNNERS) {
      const src = code(readFileSync(join(SRC, f), 'utf8'));
      // Directly, or through the active provider asked ONCE per run (`const provider = getActiveProvider()`,
      // the Codex ports: the run's wording and its call must agree on the provider).
      const direct = /getActiveProvider\(\)\.(runAgent|complete)\(/.test(src);
      const once = /const provider = getActiveProvider\(\);/.test(src) && /\bprovider\.(runAgent|complete)\(/.test(src);
      // The fixer's run core may be handed the provider its prompt was worded for (Phase 3: one provider
      // per job, picked by the AI Fix manager / the resolver) — still the registry's, the active one
      // when none is named: `const provider = opts.provider ? getProvider(…) : getActiveProvider()`.
      const viaNamed = /getProvider\(opts\.provider\) : getActiveProvider\(\)/.test(src) && /\bprovider\.runAgent\(/.test(src);
      // Or the one its manager resolved once (review/run-provider.ts `runProvider` — the same registry,
      // so its prompt words and its runner agree).
      const viaRunProvider = /runProvider\(/.test(src) && /\bprovider\.runAgent\(/.test(src);
      expect(direct || once || viaNamed || viaRunProvider, `${f} must call the provider`).toBe(true);
    }
    // The resolver runs through the fixer's run core (coding/agent.ts runAgentInWorktree).
    expect(code(readFileSync(join(SRC, 'coding/ai-resolve/run.ts'), 'utf8'))).toMatch(/runAgentInWorktree\(/);
    // The platform's ctx.llm.complete IS cheapComplete, which is the provider's complete.
    expect(code(readFileSync(join(SRC, 'platform/context.ts'), 'utf8'))).toMatch(/complete: cheapComplete,/);
  });

  it('the scan actually catches a runner calling the SDK again', () => {
    const src = readFileSync(join(SRC, 'review/ci-review/agent.ts'), 'utf8');
    expect(isSdkCaller(src)).toBe(false);
    expect(isSdkCaller(`${src}\nconst { query } = await loadAgentSdk();\n`)).toBe(true);
    expect(isSdkCaller(`${src}\n    const q = query({ prompt: 'x' });\n`)).toBe(true);
    expect(isSdkCaller(`${src}\nconst A = await loadAnthropicSdk();\n`)).toBe(true);
    // …and is not fooled by a comment naming them.
    expect(isSdkCaller(`${src}\n// const q = query({ prompt }) via loadAgentSdk()\n`)).toBe(false);
  });
});
