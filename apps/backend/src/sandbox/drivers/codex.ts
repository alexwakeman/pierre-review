// THE CODEX DRIVER (docs/SANDBOX.md § Agent drivers; spike 2's choice: `codex app-server`). ONE long-lived
// `codex app-server` per session, inside the sandbox, JSON-RPC 2.0 over the exec's stdio:
//
//   initialize → initialized → thread/start (or thread/resume of a stored thread)
//   a turn      turn/start {threadId, input, sandboxPolicy, effort} … turn/completed
//   Stop        turn/interrupt {threadId, turnId}; the process is ended only when that is not answered
//
// THE SANDBOX POLICY IS PER TURN, no restart: chat turns `externalSandbox` (network "restricted"), build
// turns `dangerFullAccess`. ⚠ Codex's OWN read-only sandbox cannot run inside ours (bubblewrap needs user
// namespaces, which Docker's seccomp profile refuses — spike 2), so a chat turn cannot be made read-only
// by Codex: the seed tells it not to change files until Start build, and after every chat turn this
// driver runs `git status` in each repository and reports any change (`turn_end.changedInChat`).
// Claude's plan mode needs none of this.
//
// THE CONFIG (`codexSandboxConfigToml`): Limn's lockdown (ai/codex/config.ts LOCKED_SETTINGS) MINUS the
// shell switch (the shell is the point here) and the AGENTS.md cap (the repositories' own instructions
// are the work's), then the injected provider (proxy/credentials.ts): every model call goes to the
// egress proxy's ChatGPT injector, which swaps the placeholder for the host's token. The auth.json
// holds fake secrets only; ⚠ `account/chatgptAuthTokens/refresh` and every other server REQUEST is
// refused — a refresh must never happen in the sandbox. This is the ONE module that starts `codex` in a
// sandbox (provider-seam.test.ts).
import type { SandboxAgentEvent, SandboxAgentMode } from '@pierre-review/shared';
import { LOCKED_SETTINGS } from '../../ai/codex/config.js';
import { lockdownToml } from '../../ai/codex/home.js';
import { codexInjectedConfigToml } from '../proxy/credentials.js';
import type { ExecHandle } from '../runtime/types.js';
import { CodexStreamFold, type CodexTurnResult } from './codex-parse.js';
import { DEFAULT_USAGE_SINK, deferred, ledgerFeature, pumpJsonLines, withTimeout } from './common.js';
import {
  SandboxAgentBusyError,
  SandboxAgentExitedError,
  type SandboxAgentDriver,
  type SandboxAgentStartOptions,
  type SandboxTurnEnd,
} from './types.js';

/** Codex's home inside the sandbox (never the reader's ~/.codex, which is not there at all). */
export const SANDBOX_CODEX_HOME = '/home/agent/.codex-limn';

/** The lockdown keys a workspace session does NOT carry (see the header). */
export const SANDBOX_CODEX_UNLOCKED = new Set(['features.shell_tool', 'project_doc_max_bytes']);

/** The sandbox's config.toml: the lockdown (Limn's own writer, `lockdownToml`) around the injected provider. Pure. */
export function codexSandboxConfigToml(): string {
  const lock = lockdownToml(LOCKED_SETTINGS.filter(([k]) => !SANDBOX_CODEX_UNLOCKED.has(k)));
  const firstTable = lock.findIndex((l) => l.startsWith('['));
  const top = firstTable < 0 ? lock : lock.slice(0, firstTable);
  const tables = firstTable < 0 ? [] : lock.slice(firstTable);
  // Every top-level key BEFORE any [table] header (TOML puts a key after a header INTO that table):
  // the lockdown's own, then the provider's keys and its table, then the lockdown's tables.
  return [`check_for_update_on_startup = false`, ...top, codexInjectedConfigToml().trimEnd(), ...tables, ''].join('\n');
}

/** The per-turn sandbox policy (app-server protocol v2 `SandboxPolicy`). */
export function codexTurnPolicy(mode: SandboxAgentMode): Record<string, unknown> {
  return mode === 'build' ? { type: 'dangerFullAccess' } : { type: 'externalSandbox', networkAccess: 'restricted' };
}

export const CODEX_APP_SERVER_ARGV = ['codex', 'app-server', '--strict-config'] as const;

const REQUEST_TIMEOUT_MS = 30_000;
const INTERRUPT_GRACE_MS = 10_000;
const CLOSE_GRACE_MS = 5_000;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export async function startCodexDriver(o: SandboxAgentStartOptions): Promise<SandboxAgentDriver> {
  if (o.choice.provider !== 'codex') throw new Error('The Codex driver runs Codex only.');
  if (!o.codexAuthJson) throw new Error('Codex is not signed in on this computer.');
  const sink = o.usageSink ?? DEFAULT_USAGE_SINK;
  const fold = new CodexStreamFold();
  let mode: SandboxAgentMode = o.mode ?? 'chat';
  let turn = 0;
  let threadId: string | null = null;
  let current: { done: ReturnType<typeof deferred<CodexTurnResult>> } | null = null;
  let exitedFlag = false;
  let closing = false;
  let nextId = 0;
  const pending = new Map<number, ReturnType<typeof deferred<unknown>>>();
  const emit = (e: SandboxAgentEvent): void => {
    try {
      o.onEvent(e);
    } catch {
      /* a listener's throw never stops the stream */
    }
  };

  emit({ type: 'status', state: 'starting', mode, detail: null });
  await o.runtime.copyIn(o.container, [
    { path: `${SANDBOX_CODEX_HOME}/auth.json`, content: o.codexAuthJson, mode: 0o600 },
    { path: `${SANDBOX_CODEX_HOME}/config.toml`, content: codexSandboxConfigToml(), mode: 0o600 },
  ]);

  const handle: ExecHandle = o.runtime.exec(o.container, [...CODEX_APP_SERVER_ARGV], {
    cwd: o.cwd,
    env: { ...o.env, CODEX_HOME: SANDBOX_CODEX_HOME },
    interactive: true,
  });
  const write = (msg: unknown): void => handle.write(`${JSON.stringify(msg)}\n`);

  const exited = pumpJsonLines(handle, (v) => {
    if (!isObj(v)) return;
    // A response to one of OUR requests.
    if (typeof v.id === 'number' && !('method' in v)) {
      const d = pending.get(v.id);
      if (!d) return;
      pending.delete(v.id);
      if (isObj(v.error)) d.reject(new Error(typeof v.error.message === 'string' ? v.error.message : 'refused'));
      else d.resolve(v.result ?? null);
      return;
    }
    if (typeof v.method !== 'string') return;
    // A REQUEST from the server (approvals, user input, a token refresh): refused, always.
    if ('id' in v && (typeof v.id === 'number' || typeof v.id === 'string')) {
      write({ jsonrpc: '2.0', id: v.id, error: { code: -32601, message: 'Not available in a Limn session.' } });
      return;
    }
    const r = fold.feed(v.method, v.params);
    for (const e of r.events) emit(e);
    if (r.turnEnd && current) current.done.resolve(r.turnEnd);
  }).then(({ code, stderrTail }) => {
    exitedFlag = true;
    const tail = stderrTail.trim().split('\n').pop()?.slice(0, 300) ?? '';
    const why = new SandboxAgentExitedError(tail ? `The agent stopped: ${tail}` : `The agent stopped (exit ${code ?? 'signal'}).`);
    for (const d of pending.values()) d.reject(why);
    pending.clear();
    if (current) current.done.reject(why);
    // A close the session asked for is not an error.
    if (!closing) emit({ type: 'error', code: 'agent_exited', message: why.message });
    emit({ type: 'status', state: 'stopped', mode, detail: null });
  });

  const call = (method: string, params: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> => {
    if (exitedFlag) return Promise.reject(new SandboxAgentExitedError());
    const id = ++nextId;
    const d = deferred<unknown>();
    pending.set(id, d);
    write({ jsonrpc: '2.0', id, method, params });
    return withTimeout(d.promise, timeoutMs, `The agent did not answer (${method}).`);
  };

  try {
    await call('initialize', { clientInfo: { name: 'limn', title: 'Limn', version: '1' } }, o.startTimeoutMs ?? 90_000);
    write({ jsonrpc: '2.0', method: 'initialized' });
    let developerInstructions: string | null = o.systemPrompt ?? null;
    if (o.systemPromptFile) {
      const buf = await o.runtime.readFile(o.container, o.systemPromptFile);
      if (buf) developerInstructions = buf.toString('utf8');
    }
    const common = {
      cwd: o.cwd,
      model: o.choice.model,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      ...(developerInstructions ? { developerInstructions } : {}),
    };
    const started = (o.resumeRef
      ? await call('thread/resume', { threadId: o.resumeRef, ...common, excludeTurns: true })
      : await call('thread/start', common)) as { thread?: { id?: unknown } } | null;
    const id = started?.thread?.id;
    if (typeof id !== 'string') throw new Error('Codex did not open a conversation.');
    threadId = id;
  } catch (err) {
    handle.kill();
    throw err;
  }
  emit({ type: 'status', state: 'ready', mode, detail: null });

  const chatChanges = async (): Promise<string[]> => {
    const out: string[] = [];
    for (const dir of o.repoDirs ?? []) {
      const r = await o.runtime.run(o.container, ['git', '-C', dir, 'status', '--porcelain', '--untracked-files=all'], { timeoutMs: 30_000 }).catch(() => null);
      if (!r || r.code !== 0) continue;
      for (const line of String(r.stdout).split('\n')) {
        const path = line.slice(3).trim();
        if (path) out.push(`${dir.replace(/\/+$/, '')}/${path}`);
      }
    }
    return out;
  };

  const driver: SandboxAgentDriver = {
    provider: 'codex',
    choice: o.choice,
    mode: () => mode,
    agentRef: () => threadId,
    busy: () => current != null,
    exited,
    async send(text) {
      if (exitedFlag) throw new SandboxAgentExitedError();
      if (current) throw new SandboxAgentBusyError();
      const slot = { done: deferred<CodexTurnResult>() };
      current = slot;
      const turnMode = mode;
      try {
        await o.beforeTurn?.();
        turn += 1;
        emit({ type: 'status', state: 'working', mode: turnMode, detail: null });
        await call('turn/start', {
          threadId,
          input: [{ type: 'text', text }],
          sandboxPolicy: codexTurnPolicy(turnMode),
          effort: o.choice.effort,
        });
        const r = await slot.done.promise;
        if (r.error) emit({ type: 'error', code: r.error.code, message: r.error.message });
        if (r.usage) {
          // A ChatGPT sign-in has no price: the row is US$ 0 with its tokens (db/usage.ts keeps it for Codex).
          await sink.record({
            accountId: o.usage.accountId,
            feature: ledgerFeature(o.usage, turnMode),
            model: o.choice.model,
            provider: 'codex',
            costUsd: 0,
            inputTokens: r.ledgerInputTokens,
            outputTokens: r.usage.outputTokens,
            repoId: o.usage.repoId ?? null,
          });
        }
        const changedInChat = turnMode === 'chat' ? await chatChanges() : [];
        const end: SandboxTurnEnd = { turn, mode: turnMode, outcome: r.outcome, usage: r.usage, text: r.text, changedInChat };
        emit({ type: 'turn_end', ...end, provider: 'codex', model: o.choice.model });
        emit({ type: 'status', state: 'ready', mode, detail: null });
        return end;
      } finally {
        if (current === slot) current = null;
      }
    },
    async startBuild() {
      if (current) throw new SandboxAgentBusyError();
      // The policy is per turn: the next turn carries full access. Nothing to tell the process.
      mode = 'build';
      emit({ type: 'status', state: 'ready', mode, detail: null });
    },
    async interrupt() {
      const slot = current;
      if (!slot || exitedFlag) return;
      const turnId = fold.turnId;
      if (turnId) await call('turn/interrupt', { threadId, turnId }).catch(() => {});
      const ended = await Promise.race([
        slot.done.promise.then(() => true, () => true),
        new Promise<boolean>((r) => setTimeout(() => r(false), INTERRUPT_GRACE_MS).unref()),
      ]);
      // Not answered: the process signal (the plan's fallback). The session then needs a new agent.
      if (!ended) {
        handle.kill();
        await o.runtime.run(o.container, ['pkill', '-TERM', '-f', 'codex app-server'], { timeoutMs: 10_000 }).catch(() => {});
      }
    },
    async close() {
      closing = true;
      if (!exitedFlag) handle.end();
      const gone = await Promise.race([exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), CLOSE_GRACE_MS).unref())]);
      if (!gone) {
        handle.kill();
        await o.runtime.run(o.container, ['pkill', '-TERM', '-f', 'codex app-server'], { timeoutMs: 10_000 }).catch(() => {});
      }
    },
  };
  return driver;
}
