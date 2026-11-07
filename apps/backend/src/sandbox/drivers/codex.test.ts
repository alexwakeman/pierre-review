// The Codex driver over the FAKE runtime and a scripted app-server (JSON-RPC over the exec's stdio):
// the handshake, a chat turn (externalSandbox, then `git status`), Start build (dangerFullAccess on the
// SAME thread), Stop (turn/interrupt), a server REQUEST refused, resume, and the ledger rows.
import { describe, expect, it } from 'vitest';
import type { SandboxAgentEvent } from '@pierre-review/shared';
import { createFakeRuntime, type FakeExecContext } from '../runtime/fake.js';
import { codexSandboxConfigToml, SANDBOX_CODEX_HOME, startCodexDriver } from './codex.js';
import { SUCCESS_TURN, T } from './codex.test-support.js';
import type { SandboxUsageRow } from './types.js';

interface Rpc {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { message: string };
}

/** A scripted app-server: answers the handshake and runs each turn from `SUCCESS_TURN`. */
function appServer(log: Rpc[], opts: { refreshRequest?: boolean } = {}) {
  return async (ctx: FakeExecContext): Promise<number> => {
    const send = (m: unknown) => ctx.stdout(`${JSON.stringify(m)}\n`);
    let turnN = 0;
    for await (const line of ctx.stdin) {
      const m = JSON.parse(line) as Rpc;
      log.push(m);
      if (m.method === 'initialize') send({ id: m.id, result: { userAgent: 'fake' } });
      else if (m.method === 'thread/start' || m.method === 'thread/resume') send({ id: m.id, result: { thread: { id: m.method === 'thread/resume' ? m.params!.threadId : T } } });
      else if (m.method === 'turn/start') {
        turnN++;
        const turnId = `tu-${turnN}`;
        send({ id: m.id, result: { turn: { id: turnId, status: 'inProgress' } } });
        const text = String((m.params!.input as Array<{ text: string }>)[0]!.text);
        if (opts.refreshRequest && turnN === 1) send({ id: 900, method: 'account/chatgptAuthTokens/refresh', params: {} });
        if (text === 'long') {
          send({ method: 'turn/started', params: { threadId: T, turn: { id: turnId } } });
          send({ method: 'item/agentMessage/delta', params: { threadId: T, turnId, itemId: 'm9', delta: '1\n' } });
          continue; // until turn/interrupt
        }
        for (const ev of SUCCESS_TURN) {
          const raw = JSON.stringify(ev).replaceAll('"tu-1"', JSON.stringify(turnId));
          send(JSON.parse(raw));
        }
      } else if (m.method === 'turn/interrupt') {
        send({ id: m.id, result: {} });
        send({ method: 'turn/completed', params: { threadId: T, turn: { id: m.params!.turnId, status: 'interrupted' } } });
      }
    }
    return 0;
  };
}

function setup(o: { refreshRequest?: boolean; resumeRef?: string } = {}) {
  const fake = createFakeRuntime();
  const log: Rpc[] = [];
  fake.onExec((argv) => argv[0] === 'codex', appServer(log, o));
  fake.onExec((argv) => argv[0] === 'git', { stdout: ' M src/a.ts\n?? notes.txt\n' });
  const events: SandboxAgentEvent[] = [];
  const rows: SandboxUsageRow[] = [];
  const opts = {
    runtime: fake,
    container: 'limn-s2-sandbox',
    cwd: '/Users/alex/Projects/home',
    choice: { provider: 'codex' as const, model: 'gpt-6.1-sol', effort: 'high' as const },
    env: { LIMN_PROXY: 'http://limn-proxy:3128' },
    codexAuthJson: '{"auth_mode":"chatgpt","tokens":{"access_token":"fake.jwt.limn"}}\n',
    systemPromptFile: '/home/agent/.limn/seed.md',
    repoDirs: ['/Users/alex/Projects/home'],
    usage: { accountId: 1 },
    usageSink: { record: async (r: SandboxUsageRow) => void rows.push(r) },
    onEvent: (e: SandboxAgentEvent) => void events.push(e),
    ...(o.resumeRef ? { resumeRef: o.resumeRef } : {}),
  };
  return { fake, log, events, rows, opts };
}

describe('the Codex driver', () => {
  it('chat, Start build, Stop: one thread, the policy per turn, the ledger rows', async () => {
    const t = setup();
    // The seed file is in the sandbox already (the workspace step wrote it).
    await t.fake.copyIn('limn-s2-sandbox', [{ path: '/home/agent/.limn/seed.md', content: 'You are in a Limn session.' }]);
    const d = await startCodexDriver(t.opts);
    expect(d.agentRef()).toBe(T);

    // Codex's home: the FAKE auth.json and the locked config, written before the process starts.
    const files = t.fake.files('limn-s2-sandbox');
    expect(String(files.get(`${SANDBOX_CODEX_HOME}/auth.json`))).toBe(t.opts.codexAuthJson);
    expect(String(files.get(`${SANDBOX_CODEX_HOME}/config.toml`))).toBe(codexSandboxConfigToml());
    const exec = t.fake.calls.find((c) => c.method === 'exec' && (c.args[1] as string[])[0] === 'codex')!;
    expect(exec.args[1]).toEqual(['codex', 'app-server', '--strict-config']);
    expect(exec.args[2]).toMatchObject({ cwd: '/Users/alex/Projects/home', interactive: true, env: { LIMN_PROXY: 'http://limn-proxy:3128', CODEX_HOME: SANDBOX_CODEX_HOME } });

    const start = t.log.find((m) => m.method === 'thread/start')!;
    expect(start.params).toEqual({
      cwd: '/Users/alex/Projects/home',
      model: 'gpt-6.1-sol',
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      developerInstructions: 'You are in a Limn session.',
    });

    const r1 = await d.send('look at the code first');
    expect(r1).toMatchObject({ turn: 1, mode: 'chat', outcome: 'completed', text: 'Fixed it.' });
    // Codex cannot be made read-only inside our sandbox: what changed during the chat is reported.
    expect(r1.changedInChat).toEqual(['/Users/alex/Projects/home/src/a.ts', '/Users/alex/Projects/home/notes.txt']);

    await d.startBuild();
    const r2 = await d.send('build it');
    expect(r2).toMatchObject({ turn: 2, mode: 'build', outcome: 'completed', changedInChat: [] });

    const turns = t.log.filter((m) => m.method === 'turn/start');
    expect(turns.map((m) => m.params!.sandboxPolicy)).toEqual([{ type: 'externalSandbox', networkAccess: 'restricted' }, { type: 'dangerFullAccess' }]);
    expect(turns.every((m) => m.params!.threadId === T && m.params!.effort === 'high')).toBe(true);

    // Stop: turn/interrupt names the running turn; the process lives on.
    const p3 = d.send('long');
    for (let i = 0; i < 100 && !t.events.some((e) => e.type === 'text' && e.messageId === 'm9'); i++) await new Promise((r) => setTimeout(r, 5));
    await d.interrupt();
    expect((await p3).outcome).toBe('interrupted');
    expect(t.log.find((m) => m.method === 'turn/interrupt')!.params).toEqual({ threadId: T, turnId: 'tu-3' });
    expect((await d.send('again')).outcome).toBe('completed');

    // One ledger row per turn that reported tokens: Codex, US$ 0, raw input tokens.
    expect(t.rows).toEqual([
      { accountId: 1, feature: 'story_plan', model: 'gpt-6.1-sol', provider: 'codex', costUsd: 0, inputTokens: 2500, outputTokens: 90, repoId: null },
      { accountId: 1, feature: 'story_build', model: 'gpt-6.1-sol', provider: 'codex', costUsd: 0, inputTokens: 2500, outputTokens: 90, repoId: null },
      { accountId: 1, feature: 'story_build', model: 'gpt-6.1-sol', provider: 'codex', costUsd: 0, inputTokens: 2500, outputTokens: 90, repoId: null },
    ]);
    const ends = t.events.filter((e) => e.type === 'turn_end');
    expect(ends.map((e) => e.type === 'turn_end' && [e.mode, e.outcome, e.provider, e.usage?.costUsd])).toEqual([
      ['chat', 'completed', 'codex', null],
      ['build', 'completed', 'codex', null],
      ['build', 'interrupted', 'codex', undefined],
      ['build', 'completed', 'codex', null],
    ]);
    await d.close();
  });

  it('refuses every server request (a token refresh must never happen in the sandbox)', async () => {
    const t = setup({ refreshRequest: true });
    const d = await startCodexDriver(t.opts);
    await d.send('hi');
    const reply = t.log.find((m) => m.id === 900);
    expect(reply).toMatchObject({ id: 900, error: { message: 'Not available in a Limn session.' } });
    expect(reply && 'result' in reply).toBe(false);
    await d.close();
  });

  it('resumes a stored thread', async () => {
    const t = setup({ resumeRef: 'th-old' });
    const d = await startCodexDriver({ ...t.opts, systemPromptFile: undefined, systemPrompt: 'Seed.' });
    expect(d.agentRef()).toBe('th-old');
    expect(t.log.find((m) => m.method === 'thread/resume')!.params).toMatchObject({ threadId: 'th-old', developerInstructions: 'Seed.', excludeTurns: true });
    expect(t.log.some((m) => m.method === 'thread/start')).toBe(false);
    await d.close();
  });

  it('needs the sandbox auth file, and runs Codex only', async () => {
    const t = setup();
    await expect(startCodexDriver({ ...t.opts, codexAuthJson: null })).rejects.toThrow(/not signed in/);
    await expect(startCodexDriver({ ...t.opts, choice: { provider: 'claude', model: 'claude-sonnet-5', effort: 'low' } })).rejects.toThrow(/Codex only/);
  });
});

describe('the sandbox config.toml', () => {
  const toml = codexSandboxConfigToml();
  it('keeps the lockdown but not the shell switch or the AGENTS.md cap', () => {
    expect(toml).toMatch(/^\[features\]\n(?:[a-z_]+ = false\n)*?plugins = false$/m);
    expect(toml).toMatch(/^apps = false$/m);
    expect(toml).toMatch(/^web_search = "disabled"$/m);
    expect(toml).toMatch(/^\[analytics\]\nenabled = false$/m);
    expect(toml).not.toMatch(/shell_tool/);
    expect(toml).not.toMatch(/project_doc_max_bytes/);
  });
  it('points the provider at the injector, after every top-level key', () => {
    // Every top-level key comes before the first [table] header.
    const firstTable = toml.search(/^\[/m);
    for (const key of ['web_search', 'approval_policy', 'model_provider', 'chatgpt_base_url', 'cli_auth_credentials_store']) {
      expect(toml.search(new RegExp(`^${key} = `, 'm')), key).toBeLessThan(firstTable);
    }
    expect(toml.slice(firstTable)).toMatch(/^\[model_providers\.limn\]/);
    expect(toml).toContain('model_provider = "limn"');
    expect(toml).toContain('base_url = "http://limn-proxy:8082/backend-api/codex"');
  });
});
