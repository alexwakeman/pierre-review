// THE REVIEW STREAM ON CODEX (docs/CODEX-PLAN.md Phase 3, stream a), offline: Claude Review
// (review/agent.ts), the review chat (review/chat-agent.ts) and Check threads
// (review/claude-review/thread-check-agent.ts) run with LIMN_AI_PROVIDER=codex through the REAL Codex
// provider, against a FAKE `codex` binary that plays recorded-shape JSONL streams (the style of
// ai/codex/__fixtures__ and ai/providers/codex.test.ts). Limn's Codex home, the hook trust check, the
// MCP config, the app-server, the thread cleanup, the clone cache and the ledger are mocked (their own
// suites cover them). What is pinned, for EACH kind:
//   1. SUCCESS: the run goes through the provider's allow-list (the kind is ported), with the STRICT
//      result schema on disk (`--output-schema`), the prompts in Codex's words (no `submit_*`, Codex's
//      tool names), read-only (no write root ⇒ `read-only` sandbox), the review's depth (role → model,
//      the diff-only effort one step lower), and the answer reaches the SAME handler and the SAME
//      server-side mapping (mapSubmittedReview anchors, chat cards, thread reports);
//   2. SCHEMA FAILURE + ONE RETRY: an answer outside the shape is corrected once on the same thread
//      (`exec resume`), and a second failure fails the run with the reason (still billed);
//   3. CANCELLATION: an aborted run comes back `aborted`, its row recorded with NULL tokens;
//   4. BUDGET SKIP: a deep review's specialists are run by LIMN first (read-only, capped, in a fixed
//      order) and a specialist the spend budget refuses is skipped — named to the lead — while the
//      others and the lead still run; their reports reach the lead FENCED;
//   5. USAGE: one Codex ledger row per run (per specialist too), and the result says so
//      (`usageRecorded`) so the manager does not record it again;
// Claude's runs are pinned by agent-run.test.ts, chat-agent.test.ts and thread-check.test.ts
// (unchanged): none of the Codex branch runs with Claude active.
//
//   pnpm --filter @pierre-review/backend test review/codex-review-runs
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunReviewArgs } from '../platform/contract.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const T = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os') as typeof import('node:os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'limn-codex-review-runs-'));
  // Never the real database (an import may reach the DB client).
  process.env.DATABASE_URL = path.join(root, 'db.sqlite');
  return {
    root,
    home: path.join(root, 'codex-home'),
    bin: path.join(root, 'fake-codex.mjs'),
    log: path.join(root, 'calls.jsonl'),
    recorded: [] as any[],
    worktrees: 0,
  };
});

vi.mock('../ai/codex/home.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ai/codex/home.js')>()),
  codexBinary: async () => T.bin,
  codexHome: () => T.home,
  ensureCodexHomeConfig: async () => {},
}));
vi.mock('../ai/codex/hook.js', () => ({
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
vi.mock('../ai/codex/workspace-mcp.js', () => ({
  workspaceMcpConfig: (roots: { read: string[] }) => ({
    id: 'workspace',
    command: '/usr/bin/node',
    args: ['/limn/mcp.js', ...roots.read],
    env: {},
    default_tools_approval_mode: 'approve',
  }),
}));
vi.mock('../ai/codex/app-server.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ai/codex/app-server.js')>()),
  codexAccount: async () => ({ signedIn: true, plan: 'plus' }),
  codexSignedInCached: () => null,
  confirmCodexAccount: async () => {},
  recheckCodexAccount: async () => {},
}));
vi.mock('../db/usage.js', () => ({
  recordAiUsage: async (row: unknown) => {
    T.recorded.push(row);
  },
}));
vi.mock('../ai/codex/threads.js', () => ({
  armCodexThreadSweeps: () => {},
  queueCodexThreadCleanup: () => {},
}));
vi.mock('./clone-manager.js', async () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  return {
    prepWorktree: async () => {
      T.worktrees += 1;
      const wt = fs.mkdtempSync(join(T.root, 'wt-'));
      return { repoCloneDir: fs.mkdtempSync(join(T.root, 'clone-')), worktreePath: wt };
    },
    removeWorktreeLocked: async () => {},
    cleanupCloneCache: () => {},
    prepPeerWorktrees: async (peers: Array<{ owner: string; name: string; number: number; headSha: string }>) => ({
      peers: peers.map((p) => ({ ...p, path: fs.mkdtempSync(join(T.root, `peer-${p.name}-`)), repoCloneDir: T.root, error: null })),
      cleanup: async () => {},
    }),
    prepDefaultBranchCheckouts: async (repos: Array<{ owner: string; name: string; branch: string | null }>) => ({
      checkouts: repos.map((r) => ({ ...r, path: fs.mkdtempSync(join(T.root, `branch-${r.name}-`)), repoCloneDir: T.root, sha: 'f'.repeat(40), error: null })),
      cleanup: async () => {},
    }),
  };
});

// ---- the fake binary ------------------------------------------------------------------------------
//
// Scenario: a specialist (its brief names it) answers its report; otherwise the prompt's FIRST WORD;
// on `exec resume <id>` the thread id it gave out. Every call is logged (argv, stdin, the schema).
const FAKE = `#!${process.execPath}
import { appendFileSync, readFileSync } from 'node:fs';
const argv = process.argv.slice(2);
const stdin = readFileSync(0, 'utf8');
const at = (f) => argv[argv.indexOf(f) + 1];
const schemaFile = argv.includes('--output-schema') ? at('--output-schema') : null;
const ri = argv.indexOf('resume');
const resumeId = ri >= 0 ? argv[ri + 1] : null;
appendFileSync(${JSON.stringify(T.log)}, JSON.stringify({
  argv, stdin, schema: schemaFile ? JSON.parse(readFileSync(schemaFile, 'utf8')) : null,
  guard: process.env.LIMN_CODEX_GUARD ?? null,
}) + '\\n');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const msg = (text) => out({ type: 'item.completed', item: { id: 'm', type: 'agent_message', text } });
const tool = (name) => out({ type: 'item.started', item: { id: 't', type: 'mcp_tool_call', server: 'workspace', tool: name, arguments: { path: 'src/a.ts' }, status: 'in_progress' } });
const done = (i, o) => out({ type: 'turn.completed', usage: { input_tokens: i, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: o, reasoning_output_tokens: 0 } });
const thread = (s) => out({ type: 'thread.started', thread_id: 'th-' + s });
const spec = /consulted as the ([a-z]+) specialist/.exec(stdin);
const scenario = resumeId ? resumeId.replace(/^th-/, '') : spec ? 'SPECIALIST' : stdin.split(/\\s/)[0];
const REVIEW = JSON.stringify({ summary: 'Looks fine.\\n- Good: small.', verdict: 'COMMENT', scopeUsed: 'diff_only', findings: [{ path: 'src/a.ts', line: 1, side: 'RIGHT', severity: 'warning', title: 'Check x', body: 'x may be null.', suggestion: null, priorRef: null, lens: null }], followUp: null, threads: null });
switch (scenario) {
  case 'SPECIALIST': thread('s-' + spec[1]); tool('read_file'); msg(JSON.stringify({ report: spec[1] + ' report: src/a.ts:1 warning: check it.' })); done(40, 4); break;
  case 'REVIEWOK': thread('x'); out({ type: 'turn.started' }); tool('read_file'); msg(REVIEW); done(1000, 100); break;
  case 'REVIEWBAD':
    thread('REVIEWBAD');
    if (resumeId) { msg(REVIEW); done(1500, 150); } else { msg(JSON.stringify({ summary: 's', verdict: 'MAYBE', scopeUsed: 'diff_only', findings: [] })); done(1000, 100); }
    break;
  case 'REVIEWBADALWAYS': thread('REVIEWBADALWAYS'); msg(JSON.stringify({ summary: 's', verdict: 'MAYBE', scopeUsed: 'x', findings: [] })); done(resumeId ? 1500 : 1000, resumeId ? 150 : 100); break;
  case 'CHATOK': thread('x'); msg('It matters because x can be null.'); done(300, 30); break;
  case 'EXPLAIN': thread('x'); msg(JSON.stringify({ cards: [{ ref: 'P1', meaning: 'm', whyItMatters: 'w', where: [{ path: 'src/a.ts', line: 1 }], fix: 'f' }] })); done(300, 30); break;
  case 'THREADSOK': thread('x'); tool('search'); msg(JSON.stringify({ threads: [{ ref: 'R1', validity: 'valid', addressed: 'not_addressed', explanation: 'src/a.ts still has it.', reason: 'Still there.', draftReply: null }] })); done(500, 50); break;
  case 'THREADSBAD':
    thread('THREADSBAD');
    if (resumeId) { msg(JSON.stringify({ threads: [] })); done(700, 70); } else { msg('{"threads": "none"}'); done(500, 50); }
    break;
  case 'HANG': process.on('SIGTERM', () => process.exit(0)); thread('x'); out({ type: 'turn.started' }); setInterval(() => {}, 1000); break;
  default: thread('x'); msg('?'); done(1, 1);
}
`;

writeFileSync(T.bin, FAKE);
chmodSync(T.bin, 0o755);

const calls = (): any[] =>
  existsSync(T.log)
    ? readFileSync(T.log, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
const cfg = (argv: string[], key: string): string | undefined => {
  const i = argv.findIndex((a, k) => a === '-c' && argv[k + 1]!.startsWith(`${key}=`));
  return i >= 0 ? argv[i + 1]!.slice(key.length + 1) : undefined;
};
const model = (argv: string[]): string => argv[argv.indexOf('-m') + 1]!;

const savedProvider = process.env.LIMN_AI_PROVIDER;
process.env.LIMN_AI_PROVIDER = 'codex';

const { runReview } = await import('./agent.js');
const { runReviewChat } = await import('./chat-agent.js');
const { runThreadCheckAgent } = await import('./claude-review/thread-check-agent.js');
const { CODEX_REVIEW_KINDS } = await import('../ai/codex/kinds/review.js');
const { codexKindReady } = await import('../ai/provider.js');

const CHATGPT_AUTH = JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { id_token: 'fixture', access_token: 'fixture', refresh_token: 'fixture' } });

beforeEach(() => {
  mkdirSync(T.home, { recursive: true });
  writeFileSync(join(T.home, 'auth.json'), CHATGPT_AUTH);
  T.recorded.length = 0;
  process.env.LIMN_AI_PROVIDER = 'codex';
});
afterEach(() => {
  if (existsSync(T.log)) unlinkSync(T.log);
});
afterAll(() => {
  if (savedProvider === undefined) delete process.env.LIMN_AI_PROVIDER;
  else process.env.LIMN_AI_PROVIDER = savedProvider;
  rmSync(T.root, { recursive: true, force: true });
});

const DIFF = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -0,0 +1,2 @@\n+const x = 1;\n+export { x };\n';
const reviewArgs = (prompt: string, over: Partial<RunReviewArgs> = {}): RunReviewArgs => ({
  owner: 'acme',
  name: 'api',
  prNumber: 7,
  headSha: 'a'.repeat(40),
  model: 'claude-sonnet-5',
  mode: 'diff_only',
  systemPrompt:
    "# Environment\n- You have NO file-system or repository access: no Read, Glob, Grep, Bash, and no checked-out worktree. The ONLY tool available to you is submit_review.\n# Finishing\nWhen you are done, call the submit_review tool EXACTLY ONCE with:\n  { summary, verdict, scopeUsed, findings }",
  prompt: `${prompt}\n\nReview the diff and call submit_review EXACTLY ONCE with your { summary, verdict, scopeUsed, findings }.`,
  strippedDiff: DIFF,
  applyAuthEnv: false,
  abortController: new AbortController(),
  onProgress: () => {},
  usage: { accountId: 3, prId: 11 },
  ...over,
});

describe('the kinds file', () => {
  it('ports exactly the review stream’s three kinds, and the provider’s allow-list lets them through', () => {
    expect([...CODEX_REVIEW_KINDS].sort()).toEqual(['review', 'review_chat', 'thread_check']);
    for (const k of CODEX_REVIEW_KINDS) expect(codexKindReady(k)).toBe(true);
  });
});

describe('Claude Review on Codex', () => {
  it('SUCCESS: strict schema, Codex words, read-only, the diff-only depth, the same anchoring, one ledger row', async () => {
    const progress: any[] = [];
    const res = await runReview(reviewArgs('REVIEWOK', { onProgress: (p) => progress.push(p) }));
    expect(res).toMatchObject({ submitted: true, verdict: 'COMMENT', aborted: false, usageRecorded: true, costUsd: 0, numTurns: null });
    // The SAME server-side mapping as Claude's: the finding anchored to the diff's RIGHT line 1.
    expect(res.findings).toEqual([expect.objectContaining({ path: 'src/a.ts', line: 1, anchored: true, severity: 'warning' })]);
    expect(res.inputTokens).toBe(1000);
    expect(res.outputTokens).toBe(100);
    const [call] = calls();
    expect(call.schema.required).toEqual(expect.arrayContaining(['summary', 'verdict', 'scopeUsed', 'findings']));
    expect(call.schema.additionalProperties).toBe(false);
    // Sonnet → standard → gpt-6.1-terra; a diff-only run one step below the role's medium.
    expect(model(call.argv)).toBe('gpt-6.1-terra');
    expect(cfg(call.argv, 'model_reasoning_effort')).toBe('"low"');
    expect(cfg(call.argv, 'sandbox_mode')).toBe('"read-only"');
    // The prompts in Codex's words: no Claude tool anywhere.
    expect(call.stdin).not.toMatch(/submit_review/);
    expect(call.stdin).toContain('give your final answer (ONE JSON object) with your');
    const dev = cfg(call.argv, 'developer_instructions')!;
    expect(dev).not.toMatch(/submit_review|Read, Glob/);
    expect(dev).toContain('You answer with your final JSON answer only.');
    // Progress through the neutral stream: the reviewing phase with Codex's activity line.
    const lastActivity: string[] = progress.filter((p) => p.recentActivity).at(-1).recentActivity;
    expect(lastActivity).toContain('Submitting review…');
    expect(lastActivity.some((l) => l.startsWith('{'))).toBe(false);
    expect(progress.every((p) => p.usage == null || p.usage.estCostUsd === 0)).toBe(true);
    expect(T.recorded).toEqual([
      expect.objectContaining({ accountId: 3, seam: 'agent', feature: 'claude_review', prId: 11, provider: 'codex', model: 'gpt-6.1-terra', costUsd: 0, inputTokens: 1000, outputTokens: 100 }),
    ]);
  });

  it('a deep (Opus) worktree run: deep model at the role’s effort, the checkout as its read root', async () => {
    const res = await runReview(reviewArgs('REVIEWOK', { mode: 'worktree', model: 'claude-opus-5-5', systemPrompt: 'Explore the worktree.' }));
    expect(res.submitted).toBe(true);
    const [call] = calls();
    expect(model(call.argv)).toBe('gpt-6.1-sol');
    expect(cfg(call.argv, 'model_reasoning_effort')).toBe('"high"');
    // The MCP server is given the worktree (mocked prepWorktree) as a read root.
    expect(call.argv.join(' ')).toContain(`${T.root}/wt-`);
    // Default effort is stored on the run for its label.
    expect(res.ranOn).toEqual({ provider: 'codex', model: 'gpt-6.1-sol', effort: 'high' });
  });

  it('Settings → AI → Effort reaches Codex: the chosen level on a worktree run, one step lower diff-only, stored on the run', async () => {
    const { setStoredAiEffort } = await import('../ai/effort.js');
    setStoredAiEffort('xhigh');
    try {
      const deep = await runReview(reviewArgs('REVIEWOK', { mode: 'worktree', model: 'claude-opus-5-5', systemPrompt: 'Explore the worktree.' }));
      expect(cfg(calls()[0].argv, 'model_reasoning_effort')).toBe('"xhigh"');
      expect(deep.ranOn).toEqual({ provider: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh' });
      unlinkSync(T.log);
      const small = await runReview(reviewArgs('REVIEWOK'));
      expect(cfg(calls()[0].argv, 'model_reasoning_effort')).toBe('"high"');
      expect(small.ranOn?.effort).toBe('high');
    } finally {
      setStoredAiEffort(null);
    }
  });

  it('related repos: a PR peer and a branch peer are READ roots of the workspace MCP server and the guard, never write roots', async () => {
    const res = await runReview(
      reviewArgs('REVIEWOK', {
        mode: 'worktree',
        model: 'claude-opus-5-5',
        systemPrompt: 'Explore the worktree.',
        peers: [
          { ref: 'X1', owner: 'acme', name: 'web', prNumber: 9, headSha: 'b'.repeat(40) },
          { ref: 'X2', owner: 'acme', name: 'infra', kind: 'branch', branch: 'eng-12-reset' },
        ],
      }),
    );
    expect(res.submitted).toBe(true);
    expect(res.peersCheckedOut).toEqual(['X1', 'X2']);
    const [call] = calls();
    const argv = call.argv.join(' ');
    // The MCP server's read roots (mocked workspaceMcpConfig puts them in its args) carry both.
    expect(argv).toContain(`${T.root}/peer-web-`);
    expect(argv).toContain(`${T.root}/branch-infra-`);
    // Read-only: the sandbox stays read-only and the guard's write roots are empty.
    expect(cfg(call.argv, 'sandbox_mode')).toBe('"read-only"');
    // The PreToolUse guard's roots (the hook's env): both readable, nothing writable.
    const roots = JSON.parse(call.guard) as { read: string[]; write: string[] };
    expect(roots.read.some((r) => r.startsWith(`${T.root}/peer-web-`))).toBe(true);
    expect(roots.read.some((r) => r.startsWith(`${T.root}/branch-infra-`))).toBe(true);
    expect(roots.write).toEqual([]);
    // The prompt says where each one is.
    expect(call.stdin).toContain('## Related checkouts');
    expect(call.stdin).toMatch(/- X2: .*branch-infra-/);
  });

  it('SCHEMA FAILURE: corrected once on the same thread, the retry’s delta billed once', async () => {
    const res = await runReview(reviewArgs('REVIEWBAD'));
    expect(res.submitted).toBe(true);
    const cs = calls();
    expect(cs).toHaveLength(2);
    expect(cs[1].argv).toContain('resume');
    expect(cs[1].stdin).toMatch(/Limn could not accept your final answer:[\s\S]*verdict/);
    // The resumed turn reports the THREAD's total (1500): the run's tokens are that, not 2500.
    expect(T.recorded).toEqual([expect.objectContaining({ inputTokens: 1500, outputTokens: 150, provider: 'codex' })]);
  });

  it('a second refusal fails the review with the reason, still billed', async () => {
    const res = await runReview(reviewArgs('REVIEWBADALWAYS'));
    expect(res.submitted).toBe(false);
    expect(res.failureReason).toMatch(/did not pass Limn's checks/);
    expect(res.usageRecorded).toBe(true);
    expect(T.recorded).toHaveLength(1);
  });

  it('CANCELLATION: aborted, its row recorded with NULL tokens', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 400);
    const res = await runReview(reviewArgs('HANG', { abortController: ac }));
    expect(res).toMatchObject({ submitted: false, aborted: true });
    expect(T.recorded).toEqual([expect.objectContaining({ provider: 'codex', inputTokens: null, outputTokens: null })]);
  });

  it('BUDGET SKIP: Limn runs the specialists first (fixed order, cap 3, read-only); a refused one is skipped and named; the reports reach the lead fenced', async () => {
    const asked: string[] = [];
    const res = await runReview(
      reviewArgs('REVIEWOK', {
        mode: 'worktree',
        model: 'claude-opus-5-5',
        specialists: ['design', 'tests', 'impact', 'security', 'performance'],
        systemPrompt: (await import('./claude-review/prompts.js')).systemPromptForMode('worktree', ['design', 'tests', 'impact', 'security', 'performance'], null),
        allowSpecialistStart: (lens) => {
          asked.push(lens);
          return lens !== 'tests';
        },
      }),
    );
    expect(res.submitted).toBe(true);
    // security, impact, tests are the first three of the offered ones in the fixed order.
    expect(asked.sort()).toEqual(['impact', 'security', 'tests']);
    const cs = calls();
    const specialists = cs.filter((c) => /consulted as the/.test(c.stdin));
    expect(specialists.map((c) => /consulted as the ([a-z]+)/.exec(c.stdin)![1]).sort()).toEqual(['impact', 'security']);
    for (const c of specialists) {
      expect(cfg(c.argv, 'sandbox_mode')).toBe('"read-only"');
      expect(c.schema.required).toEqual(['report']);
      expect(c.stdin).not.toMatch(/submit_review/);
      expect(cfg(c.argv, 'developer_instructions')).not.toMatch(/\bRead, Glob\b|\bGrep\b/);
    }
    const lead = cs.find((c) => !/consulted as the/.test(c.stdin))!;
    expect(lead.stdin).toContain('## Specialist reports');
    expect(lead.stdin).toMatch(/---BEGIN SPECIALIST SECURITY [0-9a-f]{16}---\nsecurity report/);
    expect(lead.stdin).toContain('- tests: did not answer (The spend budget does not allow another run now.)');
    expect(cfg(lead.argv, 'developer_instructions')).toContain('Specialist reviewers have already read this change');
    // One ledger row per run: two specialists + the lead; the specialists' tokens join the review's.
    expect(T.recorded.map((r) => r.feature).sort()).toEqual(['claude_review', 'claude_review:impact', 'claude_review:security']);
    expect(res.inputTokens).toBe(1080);
  });
});

describe('the review chat on Codex', () => {
  const chatArgs = (prompt: string, over: Record<string, unknown> = {}) => ({
    owner: 'acme',
    name: 'api',
    prNumber: 7,
    headSha: 'a'.repeat(40),
    model: 'claude-opus-5-5' as const,
    mode: 'diff_only' as const,
    systemPrompt: 'You are answering a developer’s questions about a code review you (Claude) wrote for one GitHub pull request.',
    prompt,
    applyAuthEnv: false,
    abortController: new AbortController(),
    usage: { accountId: 3, prId: 11 },
    ...over,
  });

  it('SUCCESS (a plain answer): no schema, Codex words, its own ledger row', async () => {
    const res = await runReviewChat(chatArgs('CHATOK why?'));
    expect(res).toMatchObject({ ok: true, text: 'It matters because x can be null.', usageRecorded: true, costUsd: 0 });
    const [call] = calls();
    expect(call.schema).toBeNull();
    expect(cfg(call.argv, 'developer_instructions')).not.toContain('(Claude)');
    expect(cfg(call.argv, 'model_reasoning_effort')).toBe('"medium"');
    expect(T.recorded).toEqual([expect.objectContaining({ feature: 'claude_review_chat', provider: 'codex', prId: 11 })]);
  });

  it('an EXPLAIN turn answers through the strict submit_explanations schema', async () => {
    const res = await runReviewChat(
      chatArgs('EXPLAIN\nAnswer by calling submit_explanations EXACTLY once, with one card per item: P1. Put nothing outside the tool call.', { explain: true }),
    );
    expect(res.ok).toBe(true);
    expect(res.submitted).toEqual({ cards: [expect.objectContaining({ ref: 'P1', where: [{ path: 'src/a.ts', line: 1 }] })] });
    const [call] = calls();
    expect(call.schema.required).toEqual(['cards']);
    expect(call.stdin).toContain('Answer with ONE JSON object, with one card per item: P1. Put nothing outside that JSON object.');
  });

  it('CANCELLATION', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 400);
    const res = await runReviewChat(chatArgs('HANG', { abortController: ac }));
    expect(res).toMatchObject({ ok: false, aborted: true });
  });
});

describe('Check threads on Codex', () => {
  const tcArgs = (prompt: string, over: Record<string, unknown> = {}) => ({
    model: 'claude-sonnet-5' as const,
    cwd: T.root,
    worktrees: [] as string[],
    systemPrompt: 'Call submit_threads EXACTLY ONCE with { threads }. Each entry: ref, validity, addressed, explanation (one or two sentences that name the code you checked), reason (ONE line, at most 120 characters), and an optional draftReply. Do not write prose outside the tool call.',
    prompt: `${prompt}\nCall submit_threads once with { threads }.`,
    applyAuthEnv: false,
    abortController: new AbortController(),
    onProgress: () => {},
    usage: { accountId: 3, prId: 11, repoId: 5 },
    ...over,
  });

  it('SUCCESS: strict submit_threads schema, Codex words, the reports handed back', async () => {
    const seen: string[][] = [];
    const res = await runThreadCheckAgent(tcArgs('THREADSOK', { onProgress: (p: { recentActivity: string[] }) => seen.push(p.recentActivity) }));
    expect(seen.at(-1)).toContain('Saving the judgements…');
    expect(seen.at(-1)!.some((l) => l.startsWith('{'))).toBe(false);
    expect(res).toMatchObject({ submitted: true, usageRecorded: true, costUsd: 0 });
    expect(res.threads).toEqual([expect.objectContaining({ ref: 'R1', validity: 'valid', addressed: 'not_addressed', reason: 'Still there.' })]);
    const [call] = calls();
    expect(call.schema.required).toEqual(['threads']);
    expect(call.stdin).toContain('Answer with ONE JSON object { threads }.');
    expect(cfg(call.argv, 'developer_instructions')).toContain('Give your final answer as ONE JSON object { threads }.');
    expect(T.recorded).toEqual([expect.objectContaining({ feature: 'thread_check', repoId: 5, provider: 'codex' })]);
  });

  it('SCHEMA FAILURE + one retry', async () => {
    const res = await runThreadCheckAgent(tcArgs('THREADSBAD'));
    expect(res.submitted).toBe(true);
    expect(res.threads).toEqual([]);
    expect(calls()).toHaveLength(2);
  });

  it('CANCELLATION', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 400);
    const res = await runThreadCheckAgent(tcArgs('HANG', { abortController: ac }));
    expect(res).toMatchObject({ submitted: false, aborted: true });
  });
});
