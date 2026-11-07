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

// The 13 runners + the one-shot seam the provider must cover (docs/CODEX-PLAN.md § 3.1).
const RUNNERS = [
  'review/agent.ts',
  'coding/agent.ts',
  'reference-docs/agent.ts',
  'review/chat-agent.ts',
  'review/ci-review/agent.ts',
  'review/claude-review/thread-check-agent.ts',
  'review/claude-review/replies-check-agent.ts',
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

  // NO SESSION FILES (ai/agent-isolation.ts): every query() options block spreads NO_SESSION_FILES,
  // so no Limn run saves a transcript under ~/.claude/projects. The runtime's tap forces it too.
  it('every query() call in the Claude provider turns session files off', () => {
    const src = code(readFileSync(join(SRC, 'ai/providers/claude.ts'), 'utf8'));
    const blocks = queryBlocks(src);
    expect(blocks.length).toBeGreaterThanOrEqual(4);
    for (const b of blocks) expect(b, b.slice(0, 80)).toMatch(/\.\.\.NO_SESSION_FILES,/);
    // The scan can fail: drop the spread from one block and it is caught.
    const mutated = src.replace('...NO_SESSION_FILES,', '');
    expect(queryBlocks(mutated).some((b) => !/\.\.\.NO_SESSION_FILES,/.test(b))).toBe(true);
  });

  it('the runtime tap forces persistSession off whatever the call site sent', async () => {
    const { withoutSessionFiles } = await import('./runtime.js');
    expect(withoutSessionFiles({ prompt: 'x', options: { persistSession: true, maxTurns: 1 } })).toEqual({
      prompt: 'x',
      options: { persistSession: false, maxTurns: 1 },
    });
    const bare: { prompt: string; options?: object } = { prompt: 'x' };
    expect(withoutSessionFiles(bare)).toEqual({ prompt: 'x', options: { persistSession: false } });
    expect(code(readFileSync(join(SRC, 'ai/runtime.ts'), 'utf8'))).toMatch(/mod\.query\(withoutSessionFiles\(params\)\)/);
  });
});

// THE SANDBOX'S AGENTS (sandbox/drivers/; docs/SANDBOX.md § Agent drivers): a workspace session's agent
// is a `claude` or `codex` CLI started INSIDE the sandbox, never an SDK query — so the scan above cannot
// see it. This one does: an argv that starts the CLI (`['claude', '-p', …]`, `['codex', 'app-server', …]`)
// appears ONLY in the two drivers, and the session's model and effort come from the run choice.
const SANDBOX_LAUNCH = /\[\s*['"](?:claude|codex)['"]\s*,\s*['"](?:-p|--print|app-server|exec)['"]/;
const isSandboxLauncher = (src: string): boolean => SANDBOX_LAUNCH.test(code(src));
const SANDBOX_DRIVERS = new Set(['sandbox/drivers/claude.ts', 'sandbox/drivers/codex.ts']);

describe('the sandbox agents', () => {
  it('no module but the two drivers starts claude or codex in a sandbox', () => {
    const offenders = sourceFiles(SRC)
      .filter((f) => !SANDBOX_DRIVERS.has(rel(f)))
      .filter((f) => isSandboxLauncher(readFileSync(f, 'utf8')))
      .map(rel);
    expect(offenders).toEqual([]);
    for (const f of SANDBOX_DRIVERS) expect(isSandboxLauncher(readFileSync(join(SRC, f), 'utf8')), f).toBe(true);
  });

  it("the session's model and effort come from the run choice, never from a driver", () => {
    const index = code(readFileSync(join(SRC, 'sandbox/drivers/index.ts'), 'utf8'));
    expect(index).toMatch(/requestModelOf\(/);
    expect(index).toMatch(/getProvider\(choice\.provider\)\.resolveModel\(/);
    expect(index).toMatch(/agenticRunEffort\(/);
    for (const f of SANDBOX_DRIVERS) {
      const src = code(readFileSync(join(SRC, f), 'utf8'));
      expect(src, f).toMatch(/o\.choice\.model/);
      expect(src, f).toMatch(/o\.choice\.effort/);
      expect(src, f).not.toMatch(/agenticRunEffort|resolveModel|MODEL_FOR_ROLE/);
    }
  });

  it('the scan catches a new launch, and is not fooled by a comment', () => {
    const src = readFileSync(join(SRC, 'sandbox/runtime/docker.ts'), 'utf8');
    expect(isSandboxLauncher(src)).toBe(false);
    expect(isSandboxLauncher(`${src}\nruntime.exec(box, ['claude', '-p', '--verbose']);\n`)).toBe(true);
    expect(isSandboxLauncher(`${src}\nconst argv = [\n  "codex",\n  "app-server",\n];\n`)).toBe(true);
    expect(isSandboxLauncher(`${src}\n// runtime.exec(box, ['codex', 'exec'])\n`)).toBe(false);
  });
});

/** Each `query({` … up to the call's closing `});` (the options blocks of the provider). */
function queryBlocks(src: string): string[] {
  const out: string[] = [];
  const re = /\bquery\(\{/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    let depth = 0;
    let i = m.index + m[0].length - 1;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) break;
    }
    out.push(src.slice(m.index, i + 1));
  }
  return out;
}
