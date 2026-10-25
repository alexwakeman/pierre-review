// THE CODEX PROVIDER (ai/providers/codex.ts), offline: a FAKE `codex` binary (a node script) plays
// recorded-shape event streams chosen by the prompt, and logs every argv, stdin, the schema file and
// the child's env keys. Limn's Codex home, the hook, the MCP config and the ledger are mocked (they
// belong to streams B and C and to the database). What is pinned:
//   1. complete(): read-only, no MCP server, no hook, an empty scratch cwd, Codex's `fast` model even
//      when handed a Claude id, the system prompt as developer_instructions, `--output-schema` for a
//      JSON caller, US$ 0 on a login, a ledger row with provider 'codex' when billed, a clear sentence
//      with no credential, and CODEX_API_KEY (never OPENAI_API_KEY or anything else) on the key route.
//   2. runAgent(): the allow-list (EMPTY) answers the not-available sentence for every kind.
//   3. the run itself (runAgentUnchecked): the strict schema on disk, the answer mapped back to the
//      tool's arguments and judged by the tool's OWN handler, ONE retry via `exec resume` whose usage
//      is the thread's cumulative figure (so the run's total is not double-counted), a second failure
//      fails the run but still records usage; a WRITE run refuses without a trusted hook, and its
//      changed files come from GIT — a write the stream never reported is found, a write outside the
//      write root fails the run; a cancelled run records NULL tokens.
//
//   pnpm --filter @pierre-review/backend test ai/providers/codex
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'limn-codex-provider-test-'));
  return {
    root,
    home: path.join(root, 'codex-home'),
    bin: path.join(root, 'fake-codex.mjs'),
    log: path.join(root, 'calls.jsonl'),
    trusted: { value: false },
    recorded: [] as any[],
  };
});

vi.mock('../codex/home.js', () => ({
  codexBinary: async () => T.bin,
  codexHome: () => T.home,
  ensureCodexHomeConfig: async () => {},
}));
vi.mock('../codex/hook.js', () => ({
  pathGuardHook: () => ({ matcher: 'apply_patch|mcp__workspace__.*', command: '/limn/guard', hash: 'sha256:test' }),
  verifyHookTrusted: async () => T.trusted.value,
}));
vi.mock('../codex/workspace-mcp.js', () => ({
  workspaceMcpConfig: (roots: { read: string[] }) => ({
    id: 'workspace',
    command: '/usr/bin/node',
    args: ['/limn/mcp.js', ...roots.read],
    default_tools_approval_mode: 'approve',
  }),
}));
vi.mock('../codex/app-server.js', () => ({
  codexAccount: async () => ({ signedIn: true, plan: 'plus' }),
  codexRateLimits: async () => null,
  codexAccountTokens: async () => null,
}));
vi.mock('../../db/usage.js', () => ({
  recordAiUsage: async (row: unknown) => {
    T.recorded.push(row);
  },
}));

const C = await import('./codex.js');
const P = await import('../provider.js');
const { loadZod } = await import('../runtime.js');

// ---- the fake binary ------------------------------------------------------------------------------
//
// Scenario = the prompt's first word (or, on `exec resume <id>`, the thread id it gave out).
const FAKE = `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
const argv = process.argv.slice(2);
const stdin = readFileSync(0, 'utf8');
const at = (f) => argv[argv.indexOf(f) + 1];
const schemaFile = argv.includes('--output-schema') ? at('--output-schema') : null;
const cwd = at('-C');
const ri = argv.indexOf('resume');
const resumeId = ri >= 0 ? argv[ri + 1] : null;
appendFileSync(${JSON.stringify(T.log)}, JSON.stringify({
  argv, stdin, envKeys: Object.keys(process.env).sort(), cwdIsEmpty: cwd ? (await import('node:fs')).readdirSync(cwd).length === 0 : null,
  schema: schemaFile ? JSON.parse(readFileSync(schemaFile, 'utf8')) : null,
}) + '\\n');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const msg = (text) => out({ type: 'item.completed', item: { id: 'm', type: 'agent_message', text } });
const done = (i, o) => out({ type: 'turn.completed', usage: { input_tokens: i, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: o, reasoning_output_tokens: 0 } });
const scenario = resumeId ? resumeId.replace(/^th-/, '') : stdin.split(/\\s/)[0];
const thread = (s) => out({ type: 'thread.started', thread_id: 'th-' + s });
switch (scenario) {
  case 'COMPLETE': thread('x'); out({ type: 'turn.started' }); msg('  hello there  '); done(10, 2); break;
  case 'GOOD': thread('x'); msg('{"answer":"yes","note":null}'); done(100, 10); break;
  case 'BADTHENGOOD':
    thread('BADTHENGOOD');
    if (resumeId) { msg('{"answer":"fixed","note":"n"}'); done(250, 30); } else { msg('not json'); done(100, 10); }
    break;
  case 'BADALWAYS': thread('BADALWAYS'); msg('{"answer":"wrong","note":null}'); done(resumeId ? 300 : 100, resumeId ? 40 : 10); break;
  case 'FAIL': thread('x'); out({ type: 'turn.failed', error: { message: 'the model refused' } }); process.exit(1);
  case 'WRITE':
    thread('x');
    writeFileSync(join(cwd, 'claimed.txt'), 'a');
    out({ type: 'item.completed', item: { id: 'f', type: 'file_change', changes: [{ path: join(cwd, 'claimed.txt'), kind: 'add' }], status: 'completed' } });
    writeFileSync(join(cwd, 'silent.txt'), 'b'); // never reported — git must find it
    msg('{"answer":"yes","note":null}'); done(50, 5); break;
  case 'WRITEOUTSIDE':
    thread('x');
    writeFileSync(join(dirname(cwd), 'outside.txt'), 'x');
    msg('{"answer":"yes","note":null}'); done(50, 5); break;
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

/** Every `-c` value of one argv, by key. */
function cfg(argv: string[]): Map<string, string> {
  const m = new Map<string, string>();
  argv.forEach((a, i) => {
    if (a === '-c') {
      const kv = argv[i + 1]!;
      m.set(kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1));
    }
  });
  return m;
}

const savedKey = process.env.OPENAI_API_KEY;
beforeEach(() => {
  mkdirSync(T.home, { recursive: true });
  writeFileSync(join(T.home, 'auth.json'), '{}'); // a Codex sign-in was made (contents never read)
  delete process.env.OPENAI_API_KEY;
  T.trusted.value = false;
  T.recorded.length = 0;
  C._resetCodexTrustCacheForTest();
});
afterEach(() => {
  if (existsSync(T.log)) unlinkSync(T.log);
  if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = savedKey;
});
afterAll(() => rmSync(T.root, { recursive: true, force: true }));

// ---- 1. complete --------------------------------------------------------------------------------

describe('complete()', () => {
  it('runs read-only, tool-less, in an EMPTY scratch dir, on Codex’s fast model even when given a Claude id', async () => {
    const out = await C.codexProvider.complete({ model: 'claude-haiku-5-5', role: 'fast', system: 'SYS', prompt: 'COMPLETE please' });
    expect(out).toEqual({ text: 'hello there', usage: { inputTokens: 10, outputTokens: 2 }, provider: 'codex', model: 'gpt-6-luna', costUsd: 0 });
    const [call] = calls();
    const c = cfg(call.argv);
    expect(call.argv[call.argv.indexOf('-m') + 1]).toBe('gpt-6-luna');
    expect(c.get('model_reasoning_effort')).toBe('"low"');
    expect(c.get('sandbox_mode')).toBe('"read-only"');
    expect(c.get('developer_instructions')).toBe('"SYS"');
    expect(c.get('features.shell_tool')).toBe('false');
    expect([...c.keys()].some((k) => k.startsWith('mcp_servers') || k.startsWith('hooks'))).toBe(false);
    expect(call.argv).not.toContain('--output-schema');
    expect(call.stdin).toBe('COMPLETE please');
    expect(call.cwdIsEmpty).toBe(true);
    // The child sees Limn's Codex home and nothing secret.
    expect(call.envKeys).toContain('CODEX_HOME');
    expect(call.envKeys).not.toContain('OPENAI_API_KEY');
    expect(call.envKeys).not.toContain('CODEX_API_KEY');
    expect(T.recorded).toEqual([]); // no usageRecord ⇒ the caller records
  });

  it('passes a JSON caller’s schema with --output-schema, and records a codex ledger row at US$ 0', async () => {
    const schema = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false };
    await C.codexProvider.complete({
      prompt: 'COMPLETE',
      outputSchema: schema,
      usageRecord: { accountId: 3, seam: 'summary', feature: 'sprint_briefs' },
    });
    expect(calls()[0].schema).toEqual(schema);
    expect(T.recorded).toEqual([
      expect.objectContaining({ accountId: 3, feature: 'sprint_briefs', provider: 'codex', model: 'gpt-6-luna', costUsd: 0, inputTokens: 10, outputTokens: 2, sharePct: null }),
    ]);
  });

  it('keeps an explicit NON-Claude model id', async () => {
    expect((await C.codexProvider.complete({ model: 'gpt-6-sol', prompt: 'COMPLETE' })).model).toBe('gpt-6-sol');
  });

  it('with no credential at all, says how to sign in (and starts nothing)', async () => {
    unlinkSync(join(T.home, 'auth.json'));
    await expect(C.codexProvider.complete({ prompt: 'COMPLETE' })).rejects.toThrow(C.CODEX_SIGN_IN_MESSAGE);
    expect(calls()).toEqual([]);
    expect(C.codexProvider.credentialRoute()).toBe('none');
  });

  it('on the API-key route, hands the key over as CODEX_API_KEY only', async () => {
    unlinkSync(join(T.home, 'auth.json'));
    process.env.OPENAI_API_KEY = 'sk-test';
    expect(C.codexProvider.credentialRoute()).toBe('api_key');
    await C.codexProvider.complete({ prompt: 'COMPLETE' });
    const keys = calls()[0].envKeys as string[];
    expect(keys).toContain('CODEX_API_KEY');
    expect(keys).not.toContain('OPENAI_API_KEY');
  });

  it('a failed turn rejects with Codex’s own reason', async () => {
    await expect(C.codexProvider.complete({ prompt: 'FAIL' })).rejects.toThrow('Codex could not finish: the model refused');
  });
});

// ---- 2. the allow-list ---------------------------------------------------------------------------

describe('runAgent() — the allow-list', () => {
  it('is EMPTY in Phase 2: every kind answers its not-available sentence and starts nothing', async () => {
    for (const kind of ['review', 'fix', 'plan', 'resolve', 'docs_chat'] as const) {
      await expect(C.codexProvider.runAgent({ kind } as any)).rejects.toThrow(P.codexKindNotAvailableMessage(kind));
    }
    expect(calls()).toEqual([]);
  });
});

// ---- 3. the run itself ---------------------------------------------------------------------------

const z = await loadZod();
let handled: unknown[] = [];
const resultTool = {
  name: 'submit_review',
  description: 'D',
  shape: { answer: z.string(), note: z.string().optional() },
  handle: (args: unknown) => {
    handled.push(args);
    const a = args as { answer?: unknown };
    return typeof a.answer === 'string' && a.answer !== 'wrong'
      ? { text: 'ok' }
      : { text: 'answer must not be "wrong"', isError: true };
  },
};

function repo(): string {
  const r = join(T.root, `repo-${Math.random().toString(36).slice(2)}`);
  const wt = join(r, 'wt');
  mkdirSync(wt, { recursive: true });
  const g = (...a: string[]) => execFileSync('git', ['-C', r, ...a], { stdio: 'ignore' });
  g('init', '-q');
  writeFileSync(join(wt, 'a.ts'), 'x');
  g('add', '.');
  g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
  return wt;
}

const spec = (prompt: string, over: Record<string, unknown> = {}): any => ({
  kind: 'review',
  model: P.claudeModelChoice('claude-opus-5-5'),
  effort: 'worktree',
  prompt,
  system: 'SYS',
  cwd: T.root,
  roots: [],
  readOnlyRoots: [],
  writeRoots: [],
  tools: { server: 'review', tools: [resultTool] },
  budget: { usd: 5, turns: 10 },
  abortController: new AbortController(),
  claude: { allowedTools: [], disallowedTools: ['Bash'] },
  usageRecord: { accountId: 9, seam: 'agent', feature: 'claude_review', prId: 4 },
  ...over,
});

describe('runAgentUnchecked() — one read-only run', () => {
  beforeEach(() => {
    handled = [];
  });

  it('sends the STRICT schema, maps the answer back to the tool’s arguments, and lets the tool’s own handler judge it', async () => {
    const progress: unknown[] = [];
    const out = await C.runAgentUnchecked(spec('GOOD', { onProgress: (p: unknown) => progress.push(p) }));
    const [call] = calls();
    expect(call.schema).toMatchObject({
      additionalProperties: false,
      required: ['answer', 'note'],
      properties: { note: { anyOf: [{ type: 'string' }, { type: 'null' }] } },
    });
    // strict `note: null` → absent for the tool (optional-not-nullable)
    expect(handled).toEqual([{ answer: 'yes' }]);
    expect(out).toMatchObject({ result: null, provider: 'codex', text: '{"answer":"yes","note":null}', costUsd: 0, filesChanged: null, threadId: 'th-x' });
    expect(out.usage).toEqual({ inputTokens: 100, cachedInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 0 });
    // deep role (a Claude Opus id) → Codex's deep model, high effort
    expect(call.argv[call.argv.indexOf('-m') + 1]).toBe('gpt-6-astra');
    const c = cfg(call.argv);
    expect(c.get('model_reasoning_effort')).toBe('"high"');
    expect(c.get('sandbox_mode')).toBe('"read-only"');
    expect(c.get('mcp_servers.workspace.default_tools_approval_mode')).toBe('"approve"');
    // Untrusted hook on a READ-ONLY run: it goes without (the MCP server guards reads).
    expect(c.has('hooks.PreToolUse')).toBe(false);
    expect(T.recorded).toEqual([expect.objectContaining({ accountId: 9, prId: 4, provider: 'codex', model: 'gpt-6-astra', inputTokens: 100, outputTokens: 10 })]);
    expect(progress.length).toBeGreaterThan(0);
  });

  it('carries a trusted hook when the guard is trusted', async () => {
    T.trusted.value = true;
    await C.runAgentUnchecked(spec('GOOD'));
    expect(cfg(calls()[0].argv).get('hooks.PreToolUse')).toContain('/limn/guard');
  });

  it('retries ONCE on the same thread with the reason, and counts the resumed turn’s tokens once', async () => {
    const out = await C.runAgentUnchecked(spec('BADTHENGOOD'));
    const [first, retry] = calls();
    expect(first.argv).not.toContain('resume');
    expect(retry.argv.slice(-3)).toEqual(['resume', 'th-BADTHENGOOD', '-']);
    expect(retry.stdin).toContain('The final answer was not valid JSON.');
    expect(handled).toEqual([{ answer: 'fixed', note: 'n' }]);
    // The resume reported the THREAD total (250/30): the run's tokens are that, not 100+250.
    expect(out.usage).toEqual({ inputTokens: 250, cachedInputTokens: 0, outputTokens: 30, reasoningOutputTokens: 0 });
  });

  it('fails after the one retry, with the handler’s reason, and still records the tokens it spent', async () => {
    await expect(C.runAgentUnchecked(spec('BADALWAYS'))).rejects.toThrow(
      'Codex\'s answer did not pass Limn\'s checks: answer must not be "wrong"',
    );
    expect(calls()).toHaveLength(2);
    expect(calls()[1].stdin).toContain('answer must not be "wrong"');
    expect(T.recorded).toEqual([expect.objectContaining({ inputTokens: 300, outputTokens: 40 })]);
  });

  it('a cancelled run rejects as an AbortError and records NULL tokens', async () => {
    const ac = new AbortController();
    const p = C.runAgentUnchecked(spec('HANG', { abortController: ac, onProgress: () => ac.abort() }));
    await expect(p).rejects.toMatchObject({ name: 'AbortError', message: 'The run was cancelled.' });
    expect(T.recorded).toEqual([expect.objectContaining({ inputTokens: null, outputTokens: null, costUsd: 0 })]);
  });

  it('needs exactly one result tool unless one is named', () => {
    const other = { ...resultTool, name: 'submit_plan' };
    expect(() => C.pickResultTool({ tools: { server: 's', tools: [resultTool, other] } })).toThrow(/exactly one result tool/);
    expect(C.pickResultTool({ tools: { server: 's', tools: [resultTool, other] }, codex: { resultTool: 'submit_plan' } })).toBe(other);
    expect(C.pickResultTool({ tools: { server: 's', tools: [resultTool, { ...resultTool, name: 'helper' }] } })).toBe(resultTool);
    expect(C.pickResultTool({})).toBeNull();
  });
});

describe('runAgentUnchecked() — a write run', () => {
  it('refuses to write without a trusted path guard (an untrusted hook is skipped silently)', async () => {
    const wt = repo();
    await expect(C.runAgentUnchecked(spec('WRITE', { cwd: wt, writeRoots: [wt] }))).rejects.toThrow(C.HOOK_NOT_TRUSTED_MESSAGE);
    expect(calls()).toEqual([]);
  });

  it('reads the changed files from GIT: the write the stream never reported is found too', async () => {
    T.trusted.value = true;
    const wt = repo();
    const out = await C.runAgentUnchecked(spec('WRITE', { cwd: wt, writeRoots: [wt] }));
    const real = realpathSync(wt);
    expect(out.filesChanged).toEqual([join(real, 'claimed.txt'), join(real, 'silent.txt')]);
    const c = cfg(calls()[0].argv);
    expect(c.get('sandbox_mode')).toBe('"workspace-write"');
    expect(c.get('sandbox_workspace_write.exclude_slash_tmp')).toBe('true');
    expect(c.has('hooks.PreToolUse')).toBe(true);
  });

  it('a change outside the write roots fails the run', async () => {
    T.trusted.value = true;
    const wt = repo();
    const err = await C.runAgentUnchecked(spec('WRITEOUTSIDE', { cwd: wt, writeRoots: [wt] })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(C.CodexRunError);
    expect((err as Error).message).toMatch(/changed files outside its folder/);
    // The caller is told exactly what is on disk.
    expect((err as InstanceType<typeof C.CodexRunError>).filesChanged).toEqual([join(realpathSync(join(wt, '..')), 'outside.txt')]);
  });
});

describe('models and prices', () => {
  it('maps roles to the pinned models, and ignores a Claude id', () => {
    expect(C.CODEX_MODEL_FOR_ROLE).toEqual({ deep: 'gpt-6-astra', standard: 'gpt-6.1-sol', fast: 'gpt-6-luna' });
    expect(C.resolveCodexModel({ role: 'standard', id: 'claude-sonnet-5' })).toBe('gpt-6.1-sol');
    expect(C.resolveCodexModel({ role: 'standard', id: 'gpt-6-sol' })).toBe('gpt-6-sol');
  });
  it('a login is never priced; an API key is priced from the table, US$ 0 while a price is unknown', () => {
    const u = { inputTokens: 2_000_000, cachedInputTokens: 1_000_000, outputTokens: 1_000_000, reasoningOutputTokens: 0 };
    expect(C.codexCostUsd('gpt-6-luna', u, 'login')).toBe(0);
    expect(C.codexCostUsd('gpt-6-luna', u, 'api_key')).toBe(0); // TODO prices
    expect(C.codexCostUsd('m', u, 'api_key', { m: { input: 1, cachedInput: 0.1, output: 4 } })).toBeCloseTo(1 + 0.1 + 4);
    expect(C.codexCostUsd('m', null, 'api_key', { m: { input: 1, cachedInput: 0.1, output: 4 } })).toBe(0);
  });
  it('detect() reports a working login (the pre-flight still keeps Codex from users in Phase 2)', async () => {
    expect(await C.codexProvider.detect()).toEqual({ id: 'codex', available: true, route: 'login', message: null });
  });
});
