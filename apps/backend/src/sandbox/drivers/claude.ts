// THE CLAUDE CODE DRIVER (docs/SANDBOX.md § Agent drivers; spike 1). ONE long-lived `claude -p` process
// per session, inside the sandbox, turns over stdin (stream-json), events over stdout:
//
//   chat   `--permission-mode plan` — Claude Code itself refuses every write (no file appears);
//   build  `set_permission_mode bypassPermissions`, live, on the SAME process and conversation
//          (⚠ only offered because the process started with `--allow-dangerously-skip-permissions`);
//   Stop   control_request `interrupt`: the turn ends `aborted_streaming`, the process lives on.
//
// The argv is ONE pure function (`claudeSandboxArgv`), pinned by its test:
//   --strict-mcp-config            no MCP server at all (none is named);
//   --setting-sources user,project the sandbox's seeded user files and the repository's own — never
//                                  `local` (a settings.local.json is a person's machine, not the repo);
//   --no-session-persistence       no transcript kept, even inside the sandbox (owner decision D1:
//                                  memories, never sessions);
//   --disallowedTools              the tools that make no sense in a disposable box (schedules,
//                                  remote triggers, messages to other sessions), the web tools (a web
//                                  search runs on Anthropic's side, past the egress allow-list), and
//                                  ExitPlanMode (the READER starts the build, with the button);
//   --model / --effort             the run choice (drivers/index.ts), never picked here.
//
// The real credential never enters: the environment carries the egress session's placeholder and the
// injector's URL (proxy/credentials.ts). This is the ONE module that starts `claude` in a sandbox
// (provider-seam.test.ts).
import { STORY_BUILD_MAX_TURNS_DEFAULT, type SandboxAgentEvent, type SandboxAgentMode } from '@pierre-review/shared';
import type { ExecHandle } from '../runtime/types.js';
import { ClaudeStreamFold, type ClaudeTurnResult } from './claude-parse.js';
import { DEFAULT_USAGE_SINK, deferred, ledgerFeature, pumpJsonLines, withTimeout } from './common.js';
import {
  SandboxAgentBusyError,
  SandboxAgentExitedError,
  type SandboxAgentDriver,
  type SandboxAgentStartOptions,
  type SandboxTurnEnd,
} from './types.js';

/** Tools a workspace session never offers (see the header). */
export const CLAUDE_SANDBOX_DISALLOWED_TOOLS = [
  'CronCreate',
  'CronDelete',
  'CronList',
  'RemoteTrigger',
  'ScheduleWakeup',
  'SendMessage',
  'ListAgents',
  'Workflow',
  'PushNotification',
  'WebFetch',
  'WebSearch',
  'ExitPlanMode',
] as const;

export const CLAUDE_PERMISSION_MODE: Record<SandboxAgentMode, 'plan' | 'bypassPermissions'> = {
  chat: 'plan',
  build: 'bypassPermissions',
};

/** The `claude` argv inside the sandbox. Pure. */
export function claudeSandboxArgv(o: Pick<SandboxAgentStartOptions, 'choice' | 'systemPromptFile' | 'systemPrompt' | 'addDirs' | 'mode' | 'maxTurns' | 'maxBudgetUsd'>): string[] {
  const argv = [
    'claude',
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--permission-mode', CLAUDE_PERMISSION_MODE[o.mode ?? 'chat'],
    '--allow-dangerously-skip-permissions',
    '--model', o.choice.model,
    '--effort', o.choice.effort,
    '--max-turns', String(o.maxTurns ?? STORY_BUILD_MAX_TURNS_DEFAULT),
    '--strict-mcp-config',
    '--setting-sources', 'user,project',
    '--no-session-persistence',
    '--disallowedTools', CLAUDE_SANDBOX_DISALLOWED_TOOLS.join(','),
  ];
  if (o.maxBudgetUsd != null && Number.isFinite(o.maxBudgetUsd) && o.maxBudgetUsd > 0) argv.push('--max-budget-usd', String(o.maxBudgetUsd));
  if (o.systemPromptFile) argv.push('--append-system-prompt-file', o.systemPromptFile);
  else if (o.systemPrompt) argv.push('--append-system-prompt', o.systemPrompt);
  for (const d of o.addDirs ?? []) argv.push('--add-dir', d);
  return argv;
}

const CONTROL_TIMEOUT_MS = 30_000;
const CLOSE_GRACE_MS = 5_000;

export async function startClaudeDriver(o: SandboxAgentStartOptions): Promise<SandboxAgentDriver> {
  if (o.choice.provider !== 'claude') throw new Error('The Claude driver runs Claude only.');
  const sink = o.usageSink ?? DEFAULT_USAGE_SINK;
  const fold = new ClaudeStreamFold();
  let mode: SandboxAgentMode = o.mode ?? 'chat';
  let turn = 0;
  let current: { done: ReturnType<typeof deferred<ClaudeTurnResult>> } | null = null;
  let exitedFlag = false;
  let closing = false;
  let reqN = 0;
  const controls = new Map<string, ReturnType<typeof deferred<unknown>>>();
  const emit = (e: SandboxAgentEvent): void => {
    try {
      o.onEvent(e);
    } catch {
      /* a listener's throw never stops the stream */
    }
  };

  emit({ type: 'status', state: 'starting', mode, detail: null });
  const handle: ExecHandle = o.runtime.exec(o.container, claudeSandboxArgv(o), { cwd: o.cwd, env: o.env, interactive: true });
  const write = (msg: unknown): void => handle.write(`${JSON.stringify(msg)}\n`);

  const exited = pumpJsonLines(handle, (v) => {
    const r = fold.feed(v);
    for (const e of r.events) emit(e);
    if (r.rateLimit) sink.noteClaudeRateLimit?.(r.rateLimit);
    if (r.control) {
      const c = controls.get(r.control.requestId);
      if (c) {
        controls.delete(r.control.requestId);
        if (r.control.ok) c.resolve(r.control.response);
        else c.reject(new Error(r.control.error ?? 'refused'));
      }
    }
    if (r.turnEnd && current) current.done.resolve(r.turnEnd);
  }).then(({ code, stderrTail }) => {
    exitedFlag = true;
    const why = new SandboxAgentExitedError(stderrTail.trim() ? `The agent stopped: ${lastLine(stderrTail)}` : `The agent stopped (exit ${code ?? 'signal'}).`);
    for (const c of controls.values()) c.reject(why);
    controls.clear();
    if (current) current.done.reject(why);
    // A close the session asked for is not an error.
    if (!closing) emit({ type: 'error', code: 'agent_exited', message: why.message });
    emit({ type: 'status', state: 'stopped', mode, detail: null });
  });

  const control = (request: Record<string, unknown>, timeoutMs = CONTROL_TIMEOUT_MS): Promise<unknown> => {
    if (exitedFlag) return Promise.reject(new SandboxAgentExitedError());
    const request_id = `limn_${++reqN}`;
    const d = deferred<unknown>();
    controls.set(request_id, d);
    write({ type: 'control_request', request_id, request });
    return withTimeout(d.promise, timeoutMs, `The agent did not answer (${String(request.subtype)}).`);
  };

  try {
    await control({ subtype: 'initialize', hooks: null }, o.startTimeoutMs ?? 90_000);
  } catch (err) {
    handle.kill();
    throw err;
  }
  emit({ type: 'status', state: 'ready', mode, detail: null });

  const driver: SandboxAgentDriver = {
    provider: 'claude',
    choice: o.choice,
    mode: () => mode,
    agentRef: () => fold.sessionId,
    busy: () => current != null,
    exited,
    async send(text) {
      if (exitedFlag) throw new SandboxAgentExitedError();
      if (current) throw new SandboxAgentBusyError();
      const slot = { done: deferred<ClaudeTurnResult>() };
      current = slot;
      const turnMode = mode;
      try {
        await o.beforeTurn?.();
        turn += 1;
        emit({ type: 'status', state: 'working', mode: turnMode, detail: null });
        write({ type: 'user', session_id: '', parent_tool_use_id: null, message: { role: 'user', content: text } });
        const r = await slot.done.promise;
        if (r.error) emit({ type: 'error', code: r.error.code, message: r.error.message });
        const cost = r.usage?.costUsd ?? null;
        if (cost != null && cost > 0) {
          await sink.record({
            accountId: o.usage.accountId,
            feature: ledgerFeature(o.usage, turnMode),
            model: o.choice.model,
            provider: 'claude',
            costUsd: cost,
            inputTokens: r.usage?.inputTokens ?? null,
            outputTokens: r.usage?.outputTokens ?? null,
            repoId: o.usage.repoId ?? null,
            ...(o.usage.prId != null ? { prId: o.usage.prId } : {}),
          });
        }
        const end: SandboxTurnEnd = { turn, mode: turnMode, outcome: r.outcome, usage: r.usage, text: r.text, changedInChat: [] };
        emit({ type: 'turn_end', ...end, provider: 'claude', model: o.choice.model });
        emit({ type: 'status', state: 'ready', mode, detail: null });
        return end;
      } finally {
        if (current === slot) current = null;
      }
    },
    async startBuild() {
      if (mode === 'build') return;
      if (current) throw new SandboxAgentBusyError();
      const r = (await control({ subtype: 'set_permission_mode', mode: CLAUDE_PERMISSION_MODE.build })) as { mode?: unknown } | null;
      if (r && typeof r === 'object' && r.mode != null && r.mode !== CLAUDE_PERMISSION_MODE.build) {
        throw new Error('The agent did not switch to build mode.');
      }
      mode = 'build';
      emit({ type: 'status', state: 'ready', mode, detail: null });
    },
    async interrupt() {
      if (!current || exitedFlag) return;
      fold.interruptRequested = true;
      await control({ subtype: 'interrupt' }).catch(() => {});
    },
    async close() {
      closing = true;
      if (!exitedFlag) handle.end();
      const gone = await Promise.race([exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), CLOSE_GRACE_MS).unref())]);
      if (!gone) {
        handle.kill();
        // `docker exec`'s client going does not end the process inside: end it there too.
        await o.runtime.run(o.container, ['pkill', '-TERM', '-f', '^claude -p '], { timeoutMs: 10_000 }).catch(() => {});
      }
    },
  };
  return driver;
}

function lastLine(s: string): string {
  const lines = s.trim().split('\n');
  return (lines[lines.length - 1] ?? '').slice(0, 300);
}
