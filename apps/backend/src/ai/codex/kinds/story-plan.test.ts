// "IMPLEMENT STORY" — THE `story_plan` PASS ON CODEX (ai/codex/kinds/story-build.ts; coding/story-build/
// plan-agent.ts). Offline: the REAL runner, the REAL Codex provider, and a FAKE `codex` binary playing
// recorded-shape JSONL streams (the shape of ai/codex/__fixtures__/*.jsonl); Limn's Codex home, the hook's
// trust check, the MCP config, the thread cleanup and the ledger are mocked (their own suites cover them).
// What is pinned:
//   1. SUCCESS through the STRICT schema (`submit_story_plan`, ai/result-schemas.ts): the answer is handed
//      to the SAME judge Claude's tool runs, the payload comes back, the read roots are the scratch cwd +
//      every checkout (+ the library) and there is NO write root; the Codex model of the asked depth
//      (deep ⇒ gpt-6.1-sol), US$ 0, the ledger row the PROVIDER wrote (`ledgerByProvider`);
//   2. the effort the manager decided (Settings → AI → Effort) reaches Codex as its reasoning effort;
//   3. a JUDGE REFUSAL is retried ONCE on the same thread with the refusal (Codex words, never the tool's
//      name), then accepted; refused twice ⇒ no plan, named by the last refusal;
//   4. Codex's SECOND answer is its last: a design still wrong there is dropped, the plan kept;
//   5. a cancelled run is aborted: no plan;
//   6. the allow-list holds both "Implement story" kinds.
//
//   pnpm --filter @pierre-review/backend test ai/codex/kinds/story-plan
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/* eslint-disable @typescript-eslint/no-explicit-any */

const T = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os') as typeof import('node:os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'limn-codex-storyplan-test-'));
  // ⚠ Some imports reach db/client, which opens the database AT IMPORT: a scratch file, never the real one.
  process.env.DATABASE_URL = path.join(root, 'scratch.sqlite');
  process.env.DISABLE_SCHEDULER = 'true';
  return {
    root,
    home: path.join(root, 'codex-home'),
    bin: path.join(root, 'fake-codex.mjs'),
    side: path.join(root, 'scenario.json'),
    log: path.join(root, 'calls.jsonl'),
    recorded: [] as any[],
  };
});

vi.mock('../home.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../home.js')>()),
  codexBinary: async () => T.bin,
  codexHome: () => T.home,
  ensureCodexHomeConfig: async () => {},
}));
vi.mock('../hook.js', () => ({
  pathGuardHook: (roots: { read: string[]; write: string[] }) => ({
    override: 'hooks.PreToolUse=[{matcher=".*", hooks=[{type="command", command="/limn/guard", timeout=30}]}]',
    matcher: '.*',
    command: '/limn/guard',
    timeoutSec: 30,
    trustKey: '/<session-flags>/config.toml:pre_tool_use:0:0',
    trustedHash: 'sha256:test',
    env: { LIMN_CODEX_GUARD: JSON.stringify(roots) },
  }),
  verifyHookTrusted: async () => true,
}));
vi.mock('../workspace-mcp.js', () => ({
  workspaceMcpConfig: (roots: { read: string[] }) => ({
    id: 'workspace',
    command: '/usr/bin/node',
    args: ['/limn/mcp.js', ...roots.read],
    env: {},
    default_tools_approval_mode: 'approve',
  }),
}));
vi.mock('../app-server.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../app-server.js')>()),
  codexAccount: async () => ({ signedIn: true, plan: 'plus' }),
  codexSignedInCached: () => ({ signedIn: true, type: 'chatgpt', plan: 'plus' }),
  confirmCodexAccount: async () => {},
  recheckCodexAccount: async () => {},
}));
vi.mock('../../../db/usage.js', () => ({
  recordAiUsage: async (row: unknown) => {
    T.recorded.push(row);
  },
}));
vi.mock('../threads.js', () => ({ armCodexThreadSweeps: () => {}, queueCodexThreadCleanup: () => {} }));

const { CODEX_STORY_BUILD_KINDS } = await import('./story-build.js');
const { CODEX_AGENT_KINDS, codexKindReady } = await import('../../provider-setting.js');
const { _resetCodexTrustCacheForTest } = await import('../../providers/codex.js');
const { loadZod } = await import('../../runtime.js');
const { shapeToJsonSchema, toStrictJsonSchema, resultJsonSchemas } = await import('../../result-schemas.js');
const { runStoryPlanAgent } = await import('../../../coding/story-build/plan-agent.js');
const { buildSubmitStoryPlanShape } = await import('../../../coding/story-build/schema.js');

// ---- the fake binary (the tickets.test.ts one: a sidecar scenario, one JSONL stream per turn) -----------
const FAKE = `#!${process.execPath}
import { appendFileSync, readFileSync } from 'node:fs';
const argv = process.argv.slice(2);
const stdin = readFileSync(0, 'utf8');
const side = JSON.parse(readFileSync(${JSON.stringify(T.side)}, 'utf8'));
const at = (f) => argv[argv.indexOf(f) + 1];
const resumed = argv.includes('resume');
appendFileSync(${JSON.stringify(T.log)}, JSON.stringify({
  argv, stdin, resumed,
  guard: process.env.LIMN_CODEX_GUARD ?? null,
  schema: argv.includes('--output-schema') ? JSON.parse(readFileSync(at('--output-schema'), 'utf8')) : null,
}) + '\\n');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
out({ type: 'thread.started', thread_id: 'th-1' });
out({ type: 'turn.started' });
out({ type: 'item.started', item: { id: 'i1', type: 'mcp_tool_call', server: 'workspace', tool: 'read_file', arguments: { path: 'REPOS.md' }, result: null, error: null, status: 'in_progress' } });
if (side.hang) { process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000); }
else {
  const text = resumed ? side.resume : side.first;
  out({ type: 'item.completed', item: { id: 'm', type: 'agent_message', text } });
  out({ type: 'turn.completed', usage: { input_tokens: resumed ? 300 : 100, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: resumed ? 30 : 10, reasoning_output_tokens: 0 } });
}
`;
writeFileSync(T.bin, FAKE);
chmodSync(T.bin, 0o755);

const scenario = (s: { first?: unknown; resume?: unknown; hang?: boolean }): void => {
  const asText = (v: unknown): string | null => (v === undefined ? null : typeof v === 'string' ? v : JSON.stringify(v));
  writeFileSync(T.side, JSON.stringify({ first: asText(s.first), resume: asText(s.resume), hang: !!s.hang }));
};
const calls = (): any[] =>
  existsSync(T.log)
    ? readFileSync(T.log, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
const cfg = (argv: string[], key: string): string | undefined => {
  const kv = argv.find((a, i) => argv[i - 1] === '-c' && a.startsWith(`${key}=`));
  return kv?.slice(key.length + 1);
};

const z = await loadZod();
function strictify(schema: any, value: any): any {
  const s = !schema.properties && !schema.items && Array.isArray(schema.anyOf) ? (schema.anyOf.find((b: any) => b && b.type !== 'null') ?? schema) : schema;
  if (Array.isArray(value)) return value.map((v) => strictify(s.items ?? {}, v));
  if (value === null || typeof value !== 'object') return value;
  if (!s.properties) return value;
  const out: Record<string, unknown> = {};
  for (const [k, sub] of Object.entries(s.properties)) out[k] = k in value ? strictify(sub, value[k]) : null;
  return out;
}
const answer = (args: unknown): any => strictify(toStrictJsonSchema(shapeToJsonSchema(z, buildSubmitStoryPlanShape(z))), args);

const PLAN = {
  summary: 'The API gains a refund endpoint. The web app calls it.',
  repos: [
    { ref: 'R2', why: 'The endpoint.', branchSlug: 'refunds', steps: [{ title: 'Add POST /refunds', files: ['src/refunds.ts'], change: 'Add it.', refs: ['AC1'] }], tests: [] },
    { ref: 'R1', why: 'The button.', branchSlug: 'refund-button', steps: [{ title: 'Button', files: ['web/Order.tsx'], change: 'Call it.', refs: ['AC2'] }], tests: [] },
  ],
  criteria: [
    { ref: 'AC1', how: 'planned', repo: 'R2' },
    { ref: 'AC2', how: 'planned', repo: 'R1' },
  ],
};
const DESIGN = {
  title: 'Refunds',
  caption: 'A refund flows from the page to the API.',
  acts: [{ id: 'ask', title: 'Ask' }],
  layers: ['ui', 'api'],
  cells: [
    { id: 'btn', act: 'ask', layer: 'ui', label: 'Refund button', pattern: 'Command', change: 'new', pr: 'R1', files: ['web/Order.tsx'] },
    { id: 'ep', act: 'ask', layer: 'api', label: 'Refund endpoint', change: 'new', pr: 'R2', files: ['src/refunds.ts'] },
  ],
  arrows: [{ from: 'btn', to: 'ep', label: 'POST' }],
};
const CTX = {
  candidates: [
    { ref: 'R1', repoId: 1 },
    { ref: 'R2', repoId: 2 },
  ],
  gapRefs: ['AC1', 'AC2'],
  wantDiagram: false,
};

const CHATGPT_AUTH = JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { id_token: 'fixture', access_token: 'fixture', refresh_token: 'fixture' } });
const savedProvider = process.env.LIMN_AI_PROVIDER;
const dirs: string[] = [];
const scratch = (name: string): string => {
  const d = mkdtempSync(join(tmpdir(), `limn-storyplan-${name}-`));
  dirs.push(d);
  return d;
};
beforeEach(() => {
  mkdirSync(T.home, { recursive: true });
  writeFileSync(join(T.home, 'auth.json'), CHATGPT_AUTH);
  process.env.LIMN_AI_PROVIDER = 'codex';
  T.recorded.length = 0;
  _resetCodexTrustCacheForTest();
});
afterEach(() => {
  if (existsSync(T.log)) unlinkSync(T.log);
  if (savedProvider === undefined) delete process.env.LIMN_AI_PROVIDER;
  else process.env.LIMN_AI_PROVIDER = savedProvider;
});
afterAll(() => {
  rmSync(T.root, { recursive: true, force: true });
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const run = async (over: Record<string, unknown> = {}) => {
  const cwd = scratch('cwd');
  const web = scratch('web');
  const api = scratch('api');
  const progress: any[] = [];
  const res = await runStoryPlanAgent({
    accountId: 7,
    cwd,
    readRoots: [cwd, web, api],
    systemPrompt: 'SYS',
    prompt: 'PROMPT',
    context: CTX,
    model: 'claude-opus-5-5',
    provider: 'codex',
    effort: 'high',
    maxBudgetUsd: 4,
    maxTurns: 40,
    abortController: new AbortController(),
    onProgress: (p) => progress.push(p),
    usageRecord: { accountId: 7, seam: 'agent', feature: 'story_plan' },
    applyAuthEnv: false,
    ...over,
  });
  return { res, cwd, web, api, progress };
};

describe('story_plan on Codex', () => {
  it('the strict schema converts (nested design and all)', async () => {
    const { strict } = await resultJsonSchemas('submit_story_plan', {}, z);
    expect((strict as any).required).toEqual(['summary', 'repos', 'readOnlyRepos', 'criteria', 'risks', 'reply', 'design']);
    expect(JSON.stringify(strict)).toContain('"additionalProperties":false');
  });

  it('succeeds through the strict schema: the SAME judge, read-only roots, the deep model, the provider’s ledger row', async () => {
    scenario({ first: answer(PLAN) });
    const { res, cwd, web, api, progress } = await run();
    expect(res.failureReason).toBeUndefined();
    expect(res.plan).toMatchObject({ summary: PLAN.summary, repos: [{ ref: 'R2' }, { ref: 'R1' }] });
    // A strict `null` for an optional, non-nullable key is ABSENT for the handler (as from Claude's tool);
    // a nullable one stays null.
    expect((res.plan as any).readOnlyRepos).toBeUndefined();
    expect((res.plan as any).design).toBeNull();
    expect(res).toMatchObject({ aborted: false, costUsd: 0, model: 'gpt-6.1-sol', ledgerByProvider: true, designDropped: false });
    const [call] = calls();
    expect(call.stdin).toBe('PROMPT');
    expect(call.schema.required).toContain('repos');
    const guard = JSON.parse(call.guard);
    expect(new Set(guard.read)).toEqual(new Set([cwd, web, api]));
    expect(guard.write).toEqual([]);
    expect(T.recorded).toEqual([expect.objectContaining({ provider: 'codex', feature: 'story_plan', accountId: 7 })]);
    expect(progress.some((p) => p.phase === 'planning')).toBe(true);
  });

  it('runs at the effort the manager decided (Settings → AI → Effort)', async () => {
    scenario({ first: answer(PLAN) });
    await run({ effort: 'low' });
    expect(cfg(calls()[0].argv, 'model_reasoning_effort')).toBe('"low"');
  });

  it('a judge refusal is retried ONCE with it (Codex words), then accepted', async () => {
    const bad = answer({ ...PLAN, criteria: [PLAN.criteria[0]] });
    scenario({ first: bad, resume: answer(PLAN) });
    const { res } = await run();
    expect(res.plan).not.toBeNull();
    const [, retry] = calls();
    expect(retry.resumed).toBe(true);
    expect(retry.stdin).toContain('`criteria` is missing AC2');
    expect(retry.stdin).toContain('answer again with the whole plan');
    expect(retry.stdin).not.toContain('submit_story_plan');
  });

  it('refused twice: no plan, named by the last refusal', async () => {
    const bad = answer({ ...PLAN, repos: [] });
    scenario({ first: bad, resume: bad });
    const { res } = await run();
    expect(res.plan).toBeNull();
    expect(res.failureReason).toMatch(/^no usable plan: .*`repos` is empty/);
  });

  it("Codex's second answer is its last: a design still wrong is dropped, the plan kept", async () => {
    const badDesign = answer({ ...PLAN, design: { ...DESIGN, cells: [{ ...DESIGN.cells[0], pr: 'R9' }] } });
    scenario({ first: badDesign, resume: badDesign });
    const { res } = await run({ context: { ...CTX, wantDiagram: true } });
    expect(res.plan).not.toBeNull();
    expect(res.designDropped).toBe(true);
  });

  it('a cancelled run is aborted', async () => {
    scenario({ hang: true });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 400);
    const { res } = await run({ abortController: ac });
    expect(res).toMatchObject({ plan: null, aborted: true });
  });
});

describe('the allow-list', () => {
  it('holds both "Implement story" kinds', () => {
    expect([...CODEX_STORY_BUILD_KINDS].sort()).toEqual(['story_build', 'story_plan']);
    for (const k of CODEX_STORY_BUILD_KINDS) {
      expect(CODEX_AGENT_KINDS.has(k)).toBe(true);
      expect(codexKindReady(k)).toBe(true);
    }
  });
});
