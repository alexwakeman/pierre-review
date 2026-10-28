// PHASE 3 STREAM (c) ON CODEX — the ticket review, its card pre-pass, the CI review and Check against
// docs (ai/codex/kinds/tickets.ts). Offline: the REAL runners, the REAL Codex provider, and a FAKE
// `codex` binary playing recorded-shape JSONL streams (the shape of ai/codex/__fixtures__/*.jsonl);
// Limn's Codex home, the hook's trust check, the MCP config, the app-server, the thread cleanup and
// the ledger are mocked (their own suites cover them). What is pinned:
//   1. ⚠ CLAUDE IS BYTE-IDENTICAL: every prompt of the stream, rendered for Claude, equals
//      __fixtures__/tickets-claude-prompts.json — written from the code BEFORE the port;
//   2. the Codex words: no Claude tool name, no `submit_*` call, the workspace tools by name;
//   3. per kind, under LIMN_AI_PROVIDER=codex: SUCCESS through the strict schema (the answer handed to
//      the SAME handler, the payload the runner returns, the read roots the Claude path guard allows
//      — and no write root —, the Codex model, US$ 0, the ledger row the PROVIDER wrote and
//      `ledgerByProvider`, the neutral progress); a SCHEMA FAILURE retried ONCE on the same thread;
//      CANCELLATION (aborted, no answer, NULL tokens in the ledger);
//   4. the BUDGET SKIP: the ticket and CI sweeps ask the spend-budget gate under Codex exactly as under
//      Claude, and queue nothing over it (Check against docs is manual only: no gate to ask);
//   5. the allow-list holds these four kinds and none of another stream's.
//
//   pnpm --filter @pierre-review/backend test ai/codex/kinds/tickets
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'limn-codex-tickets-test-'));
  // ⚠ Some imports below reach db/client, which opens the database AT IMPORT: a scratch file, never
  // the real one (nothing here writes a row — the ledger is mocked and the sweeps stop at the gate).
  process.env.DATABASE_URL = path.join(root, 'scratch.sqlite');
  process.env.DISABLE_SCHEDULER = 'true';
  return {
    root,
    home: path.join(root, 'codex-home'),
    bin: path.join(root, 'fake-codex.mjs'),
    side: path.join(root, 'scenario.json'),
    log: path.join(root, 'calls.jsonl'),
    recorded: [] as any[],
    runtimeReady: { value: true },
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
  // A ChatGPT sign-in Limn has read, which auth.json agrees with: the run starts with no extra probe.
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
// The sweeps' "is the AI runtime installed?" (ai-ready.ts — the ACTIVE provider's download, so under
// Codex the Codex program's): yes, unless a test says not.
vi.mock('../../runtime.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../runtime.js')>();
  const status = (s: { runtimeMessage: string | null }) => ({ ...s, runtime: T.runtimeReady.value ? 'ready' : 'missing' });
  return {
    ...real,
    getAiRuntimeStatus: () => status(real.getAiRuntimeStatus()),
    getCodexRuntimeStatus: () => status(real.getCodexRuntimeStatus()),
  };
});

const { promptTools } = await import('../../prompt-tools.js');
const { ticketsPrompts } = await import('./tickets-golden.test-support.js');
const { CODEX_TICKETS_KINDS } = await import('./tickets.js');
const { CODEX_AGENT_KINDS, codexKindReady } = await import('../../provider-setting.js');
const { _resetCodexTrustCacheForTest } = await import('../../providers/codex.js');
const { loadZod } = await import('../../runtime.js');
const { shapeToJsonSchema, toStrictJsonSchema } = await import('../../result-schemas.js');
const { runTicketReviewAgent } = await import('../../../review/ticket-review/agent.js');
const { runCardAgent, runCardPrepass } = await import('../../../review/ticket-review/prepass.js');
const { runCiReviewAgent } = await import('../../../review/ci-review/agent.js');
const { runStoryDocsAgent } = await import('../../../review/story-docs/agent.js');
const { buildSubmitTicketReviewShape, buildSubmitPrCardShape } = await import('../../../review/ticket-review/schema.js');
const { buildSubmitCiReviewShape } = await import('../../../review/ci-review/schema.js');
const { buildSubmitAlignmentShape } = await import('../../../review/story-docs/schema.js');
const { runCiReviewSweep, _resetCiSweepForTest } = await import('../../../review/ci-review/sweep.js');
const { runTicketReviewSweep } = await import('../../../review/ticket-review/sweep.js');

// ---- the fake binary ------------------------------------------------------------------------------
//
// Its scenario rides a SIDECAR file (Limn hands a Codex process only its allow-listed environment):
//   { first, resume }  the final answer of the first turn and of the one `exec resume` retry;
//   hang               emit a step, then wait to be stopped.
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
out({ type: 'item.started', item: { id: 'i1', type: 'mcp_tool_call', server: 'workspace', tool: 'read_file', arguments: { path: 'MEMBERS.md' }, result: null, error: null, status: 'in_progress' } });
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

// ---- strict answers -------------------------------------------------------------------------------

const z = await loadZod();
/** A tool-args value in the STRICT form Codex must answer in: every optional key present, as null. */
function strictify(schema: any, value: any): any {
  // A nullable branch (`anyOf: [x, null]`): the non-null branch.
  const s = !schema.properties && !schema.items && Array.isArray(schema.anyOf) ? (schema.anyOf.find((b: any) => b && b.type !== 'null') ?? schema) : schema;
  if (Array.isArray(value)) return value.map((v) => strictify(s.items ?? {}, v));
  if (value === null || typeof value !== 'object') return value;
  if (!s.properties) return value;
  const out: Record<string, unknown> = {};
  for (const [k, sub] of Object.entries(s.properties)) out[k] = k in value ? strictify(sub, value[k]) : null;
  return out;
}
const answerFor = (shape: Record<string, unknown>, args: unknown): unknown =>
  strictify(toStrictJsonSchema(shapeToJsonSchema(z, shape)), args);

const TICKET_ARGS = {
  alignment: 'partly_aligned',
  summary: 'PR1 delivers the export.\n- PDF is missing',
  criteria: [{ text: 'CSV export', status: 'met', explanation: 'PR1 adds it.', deliveredBy: ['PR1'] }],
  cards: [{ pr: 'PR1', summary: 'Adds GET /api/export.', interfaces: [] }],
};
const CARD_ARGS = { summary: 'Adds GET /api/export returning CSV.', interfaces: [{ kind: 'endpoint', name: 'GET /api/export', change: 'added' }] };
const CI_ARGS = {
  summary: 'The build fails on a type error in src/a.ts.',
  failures: [{ ref: 'F1', cause: 'type error', explanation: 'Line 3 of src/a.ts.', category: 'code', fixableInPr: true, confidence: 80, path: 'src/a.ts', line: 3 }],
};
const good = { link: 'refunds/sections/01-refunds.md', quote: 'Refunds are paid within fourteen days' };
const ALIGN_ARGS = {
  overall: {
    verdict: 'mixed',
    summary: 'The story mostly matches the refund policy. It sets the wrong deadline.',
    actions: [
      { text: 'Change the deadline to 14 days.', refs: [good] },
      { text: 'Keep the approval step.', refs: [good] },
    ],
  },
  criteria: [{ n: 1, verdict: 'diverges', note: 'The story says 30 days; the policy says 14.', refs: [good] }],
  storyParts: [],
};
const ALIGN_CTX = { criteriaSource: 'brief', criteria: [{ n: 1, text: 'Refunds are paid within 30 days' }] } as any;

// ---- setup ----------------------------------------------------------------------------------------

const CHATGPT_AUTH = JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { id_token: 'fixture', access_token: 'fixture', refresh_token: 'fixture' } });
const savedProvider = process.env.LIMN_AI_PROVIDER;
const dirs: string[] = [];
const scratch = (name: string): string => {
  const d = mkdtempSync(join(tmpdir(), `limn-tickets-${name}-`));
  dirs.push(d);
  return d;
};
beforeEach(() => {
  mkdirSync(T.home, { recursive: true });
  writeFileSync(join(T.home, 'auth.json'), CHATGPT_AUTH);
  process.env.LIMN_AI_PROVIDER = 'codex';
  T.recorded.length = 0;
  T.runtimeReady.value = true;
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

// ---- 1. Claude is byte-identical; 2. the Codex words ---------------------------------------------

describe('the prompts', () => {
  it('⚠ Claude: every prompt is byte-for-byte what the code sent before the port', () => {
    const golden = JSON.parse(readFileSync(join(import.meta.dirname, '__fixtures__/tickets-claude-prompts.json'), 'utf8'));
    expect(ticketsPrompts(promptTools('claude'))).toEqual(golden);
  });

  it('Codex: no Claude tool name and no submit call anywhere; the workspace tools by name', () => {
    const p = ticketsPrompts(promptTools('codex'));
    for (const [name, text] of Object.entries(p)) {
      expect(text, name).not.toMatch(/\bGlob\b|\bGrep\b|submit_[a-z_]+|tool call/);
    }
    for (const k of ['ticketSystem', 'ticketSystemDocs', 'ciSystem', 'storySystem']) {
      expect(p[k], k).toContain('read_file, list_files and search');
      expect(p[k], k).toMatch(/final message|final JSON answer/);
    }
    expect(p.ticketSystemDocs).toContain('`docReferences` is a field of your final JSON answer');
    expect(p.cardSystem).toContain('ONE JSON object matching the given schema');
    expect(p.storyUser).toContain('Give your final JSON answer now.');
    expect(p.storyUserCut).toContain('Then give your final JSON answer.');
    expect(p.storyRefusal).toContain('answer again with the whole answer');
    // The facts the prompts carry are the same: the fences and paths do not move.
    const c = ticketsPrompts(promptTools('claude'));
    expect(p.ticketUser!.replace(/\n[^\n]*$/, '')).toBe(c.ticketUser!.replace(/\n[^\n]*$/, ''));
    expect(p.ciUser!.replace(/\n[^\n]*$/, '')).toBe(c.ciUser!.replace(/\n[^\n]*$/, ''));
  });
});

// ---- 3. the runs ------------------------------------------------------------------------------------

describe('ticket_review on Codex', () => {
  const run = async (over: Record<string, unknown> = {}) => {
    const cwd = scratch('ticket');
    const wt = scratch('wt');
    const lib = scratch('lib');
    const progress: any[] = [];
    const res = await runTicketReviewAgent({
      model: 'claude-opus-5-5',
      cwd,
      worktrees: [wt],
      systemPrompt: 'SYS',
      prompt: 'PROMPT',
      applyAuthEnv: true,
      abortController: new AbortController(),
      docsDir: lib,
      usageRecord: { accountId: 7, seam: 'agent', feature: 'ticket_review', prId: 3 },
      onProgress: (p) => progress.push(p),
      ...over,
    });
    return { res, progress, cwd, wt, lib };
  };

  it('succeeds through the strict schema: the handler gets the parsed answer, the roots are the path guard’s', async () => {
    scenario({ first: answerFor(buildSubmitTicketReviewShape(z, { docs: true }), TICKET_ARGS) });
    const { res, progress, cwd, wt, lib } = await run();
    expect(res.failureReason).toBeUndefined();
    expect(res.submitted).toBe(true);
    expect(res.payload).toMatchObject({ alignment: 'partly_aligned', criteria: [{ deliveredBy: ['PR1'] }], cards: [{ pr: 'PR1' }] });
    // A strict `null` for an optional key is ABSENT for the handler (as from Claude's tool).
    expect((res.payload as any).missing).toBeUndefined();
    expect(res).toMatchObject({ aborted: false, costUsd: 0, model: 'gpt-6.1-sol', ledgerByProvider: true, inputTokens: 100, outputTokens: 10 });
    const [call] = calls();
    expect(call.stdin).toBe('PROMPT');
    expect(cfg(call.argv, 'developer_instructions')).toContain('SYS');
    expect(cfg(call.argv, 'sandbox_mode')).toBe('"read-only"');
    // ⚠ The Claude guard's roots: cwd + the worktrees + the library (read-only); NO write root.
    const guard = JSON.parse(call.guard);
    expect(guard.write).toEqual([]);
    expect(new Set(guard.read)).toEqual(new Set([cwd, wt, lib]));
    expect(call.schema.properties.docReferences).toBeTruthy();
    // The provider wrote the ledger row: Codex, its model, its tokens, the run's identity.
    expect(T.recorded).toEqual([
      expect.objectContaining({ provider: 'codex', model: 'gpt-6.1-sol', feature: 'ticket_review', accountId: 7, prId: 3, costUsd: 0, inputTokens: 100, outputTokens: 10 }),
    ]);
    // The neutral progress reached the status line, priced at US$ 0 (never a Claude price on Codex tokens).
    expect(progress.some((p) => p.recentActivity.length > 0)).toBe(true);
    expect(progress.every((p) => p.usage.costUsd === 0)).toBe(true);
  });

  it('a schema failure is retried ONCE on the same thread, then accepted', async () => {
    const strict = answerFor(buildSubmitTicketReviewShape(z), TICKET_ARGS) as any;
    scenario({ first: { ...strict, alignment: 'kind_of' }, resume: strict });
    const { res } = await run({ docsDir: null });
    expect(res.submitted).toBe(true);
    const [first, retry] = calls();
    expect(first.resumed).toBe(false);
    expect(retry.resumed).toBe(true);
    expect(retry.stdin).toContain('alignment');
    // The resumed turn reports the thread's total: the run's tokens are counted once.
    expect(T.recorded).toEqual([expect.objectContaining({ inputTokens: 300, outputTokens: 30 })]);
  });

  it('two bad answers fail the run with Limn’s reason (never a half-read payload), usage still recorded', async () => {
    const strict = answerFor(buildSubmitTicketReviewShape(z), TICKET_ARGS) as any;
    scenario({ first: { ...strict, alignment: 'kind_of' }, resume: 'not json' });
    const { res } = await run({ docsDir: null });
    expect(res).toMatchObject({ submitted: false, payload: null, aborted: false });
    expect(res.failureReason).toContain("did not pass Limn's checks");
    expect(T.recorded).toHaveLength(1);
  });

  it('a cancelled run is aborted: no answer, and NULL tokens in the ledger', async () => {
    scenario({ hang: true });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 400);
    const { res } = await run({ abortController: ac });
    expect(res).toMatchObject({ submitted: false, payload: null, aborted: true });
    expect(T.recorded).toEqual([expect.objectContaining({ provider: 'codex', inputTokens: null, outputTokens: null })]);
  });
});

describe('pr_card on Codex', () => {
  const input = { prId: 5, repo: 'acme/api', number: 5, title: 'Export', diff: 'diff --git a/x b/x\n+1' };

  it('writes a card with the Codex model and its own ledger row; diff-only: an EMPTY scratch dir is its one root', async () => {
    scenario({ first: answerFor(buildSubmitPrCardShape(z), CARD_ARGS) });
    const out = await runCardPrepass({
      inputs: [input],
      ticket: { title: 'Story', description: null, acceptanceCriteria: '- CSV' },
      pickNonce: () => 'nn',
      signal: new AbortController().signal,
      applyAuthEnv: true,
      provider: 'codex',
      usageRecord: { accountId: 7, seam: 'agent', feature: 'ticket_review', prId: 3 },
    });
    expect(out).toEqual([
      expect.objectContaining({ prId: 5, failure: null, costUsd: 0, model: 'gpt-6.1-terra', ledgerByProvider: true }),
    ]);
    expect(out[0]!.card).toMatchObject({ summary: 'Adds GET /api/export returning CSV.' });
    const [call] = calls();
    expect(call.stdin).toContain('Describe this pull request in your final JSON answer.');
    expect(call.stdin).not.toContain('submit_pr_card');
    expect(cfg(call.argv, 'developer_instructions')).not.toContain('submit_pr_card');
    const guard = JSON.parse(call.guard);
    expect(guard.read).toHaveLength(1);
    expect(guard.read[0]).toMatch(/pierre-ticket-card-/);
    expect(guard.write).toEqual([]);
    expect(T.recorded).toEqual([expect.objectContaining({ provider: 'codex', model: 'gpt-6.1-terra', feature: 'ticket_review' })]);
  });

  it('a schema failure is retried once; a cancelled card is no card', async () => {
    const strict = answerFor(buildSubmitPrCardShape(z), CARD_ARGS) as any;
    scenario({ first: { ...strict, summary: 7 }, resume: strict });
    const ok = await runCardAgent({ input, ticket: null, nonce: 'nn', signal: new AbortController().signal, applyAuthEnv: false });
    expect(ok.failure).toBeNull();
    expect(calls().map((c) => c.resumed)).toEqual([false, true]);

    unlinkSync(T.log);
    scenario({ hang: true });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 400);
    const cancelled = await runCardAgent({ input, ticket: null, nonce: 'nn', signal: ac.signal, applyAuthEnv: false });
    expect(cancelled.payload).toBeNull();
    expect(cancelled.failure).toBeTruthy();
  });
});

describe('ci_review on Codex', () => {
  const run = async (over: Record<string, unknown> = {}) => {
    const cwd = scratch('ci');
    const wt = scratch('ciwt');
    const res = await runCiReviewAgent({
      model: 'claude-opus-5-5',
      cwd,
      worktrees: [wt],
      systemPrompt: 'SYS',
      prompt: 'PROMPT',
      applyAuthEnv: true,
      abortController: new AbortController(),
      usageRecord: { accountId: 7, seam: 'agent', feature: 'ci_review', prId: 9 },
      onProgress: () => {},
      ...over,
    });
    return { res, cwd, wt };
  };

  it('succeeds: the payload, the roots (cwd + worktree, no write), the provider’s ledger row', async () => {
    scenario({ first: answerFor(buildSubmitCiReviewShape(z), CI_ARGS) });
    const { res, cwd, wt } = await run();
    expect(res.submitted).toBe(true);
    expect(res.payload!.failures[0]).toMatchObject({ ref: 'F1', category: 'code', path: 'src/a.ts', line: 3 });
    expect(res.payload!.failures[0]!.suggestion).toBeNull(); // nullable: a strict null is kept, as Claude could send it
    expect(res).toMatchObject({ costUsd: 0, ledgerByProvider: true, model: 'gpt-6.1-sol' });
    const guard = JSON.parse(calls()[0].guard);
    expect(new Set(guard.read)).toEqual(new Set([cwd, wt]));
    expect(guard.write).toEqual([]);
    expect(T.recorded).toEqual([expect.objectContaining({ provider: 'codex', feature: 'ci_review', prId: 9 })]);
  });

  it('a schema failure is retried once', async () => {
    const strict = answerFor(buildSubmitCiReviewShape(z), CI_ARGS) as any;
    scenario({ first: { ...strict, failures: [{ ...strict.failures[0], confidence: 'high' }] }, resume: strict });
    const { res } = await run();
    expect(res.submitted).toBe(true);
    expect(calls().map((c) => c.resumed)).toEqual([false, true]);
  });

  it('a cancelled run is aborted', async () => {
    scenario({ hang: true });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 400);
    const { res } = await run({ abortController: ac });
    expect(res).toMatchObject({ submitted: false, aborted: true });
  });
});

describe('story_docs on Codex', () => {
  const run = async (over: Record<string, unknown> = {}) => {
    const cwd = scratch('sd');
    const doc = scratch('doc');
    const res = await runStoryDocsAgent({
      cwd,
      roots: [doc],
      systemPrompt: 'SYS',
      prompt: 'PROMPT',
      alignment: ALIGN_CTX,
      applyAuthEnv: true,
      abortController: new AbortController(),
      usageRecord: { accountId: 7, seam: 'agent', feature: 'story_docs_alignment' },
      ...over,
    });
    return { res, cwd, doc };
  };

  it('succeeds: the SAME shape judge accepts it; the shortlisted folders are READ-ONLY roots', async () => {
    scenario({ first: answerFor(buildSubmitAlignmentShape(z), ALIGN_ARGS) });
    const { res, cwd, doc } = await run();
    expect(res.payload).toMatchObject({ overall: { verdict: 'mixed' }, criteria: [{ n: 1 }] });
    expect(res).toMatchObject({ lastRefusal: null, aborted: false, costUsd: 0, ledgerByProvider: true, model: 'gpt-6.1-terra' });
    const guard = JSON.parse(calls()[0].guard);
    expect(new Set(guard.read)).toEqual(new Set([cwd, doc]));
    expect(guard.write).toEqual([]);
    expect(T.recorded).toEqual([expect.objectContaining({ provider: 'codex', feature: 'story_docs_alignment' })]);
  });

  it('a refused answer (the shape judge) is retried once with the refusal, then accepted', async () => {
    const strict = answerFor(buildSubmitAlignmentShape(z), ALIGN_ARGS) as any;
    scenario({ first: { ...strict, overall: { ...strict.overall, actions: [strict.overall.actions[0]] } }, resume: strict });
    const { res } = await run();
    expect(res.payload).not.toBeNull();
    const [, retry] = calls();
    expect(retry.resumed).toBe(true);
    expect(retry.stdin).toContain('Refused:');
    expect(retry.stdin).toContain('Fix every point and answer again with the whole answer.');
    expect(retry.stdin).not.toContain('submit_alignment');
  });

  it('refused twice: no usable answer, named by the last refusal (as on Claude)', async () => {
    const strict = answerFor(buildSubmitAlignmentShape(z), ALIGN_ARGS) as any;
    const bad = { ...strict, overall: { ...strict.overall, actions: [strict.overall.actions[0]] } };
    scenario({ first: bad, resume: bad });
    const { res } = await run();
    expect(res.payload).toBeNull();
    expect(res.failureReason).toMatch(/^no usable answer: .*actions has 1/);
  });

  it('a cancelled run is aborted', async () => {
    scenario({ hang: true });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 400);
    const { res } = await run({ abortController: ac });
    expect(res).toMatchObject({ payload: null, aborted: true });
  });
});

// ---- 4. the budget gate -----------------------------------------------------------------------------

describe('the spend-budget gate under Codex', () => {
  const ctxWith = (allow: boolean, asked: Array<[number, string]>, kinds: string[]): any => ({
    llm: {
      detectAuth: (kind: string) => {
        kinds.push(kind);
        return { status: 'ok' };
      },
    },
    aiBudget: {
      allowAutomaticRun: async (accountId: number, what: string) => {
        asked.push([accountId, what]);
        return allow;
      },
    },
    log: { warn: () => {}, info: () => {}, error: () => {} },
  });

  it('the CI sweep asks it with its own kind and queues nothing over it', async () => {
    _resetCiSweepForTest();
    const asked: Array<[number, string]> = [];
    const kinds: string[] = [];
    const enqueued: unknown[] = [];
    const res = await runCiReviewSweep(ctxWith(false, asked, kinds), Date.now(), {
      roster: async () => [{ accountId: 4, workspaceId: 1, enabledAtMs: 0 }],
      enqueue: async (_c, a) => {
        enqueued.push(a);
        return { ok: true } as any;
      },
      laneRoom: () => 5,
      held: () => false,
      automationUserIds: async () => new Set(),
      dailyCap: 10,
    });
    expect(kinds).toEqual(['ci_review']);
    expect(asked).toEqual([[4, 'CI review']]);
    expect(res.overBudget).toBe(true);
    expect(enqueued).toEqual([]);
  });

  it('the ticket sweep asks it and queues nothing over it', async () => {
    const asked: Array<[number, string]> = [];
    const kinds: string[] = [];
    const res = await runTicketReviewSweep(ctxWith(false, asked, kinds), Date.now(), {
      roster: async () => [{ accountId: 4, workspaceId: 1, enabledAtMs: 0 }],
    } as any);
    expect(kinds).toEqual(['ticket_review']);
    expect(asked).toEqual([[4, 'ticket review']]);
    expect(res.overBudget).toBe(true);
    expect(res.queued ?? []).toEqual([]);
  });
});

// ---- 5. the allow-list ------------------------------------------------------------------------------

describe('the allow-list', () => {
  it('holds exactly this stream’s four kinds from this file', () => {
    expect([...CODEX_TICKETS_KINDS].sort()).toEqual(['ci_review', 'pr_card', 'story_docs', 'ticket_review']);
    for (const k of CODEX_TICKETS_KINDS) {
      expect(CODEX_AGENT_KINDS.has(k)).toBe(true);
      expect(codexKindReady(k)).toBe(true);
    }
  });
});
