// What both drivers share: reading an exec's stdout as JSON lines, the default usage sink, the ledger
// feature per mode, and the one-line tool summary.
import {
  clipSandboxText,
  SANDBOX_TOOL_SUMMARY_MAX,
  STORY_BUILD_LEDGER_FEATURES,
  type SandboxAgentMode,
} from '@pierre-review/shared';
import type { ExecHandle } from '../runtime/types.js';
import type { SandboxUsageAccount, SandboxUsageSink } from './types.js';

/** How much of the agent's stderr is kept (for the "agent stopped" message). */
const STDERR_TAIL = 4000;

/**
 * Pump an exec's events: each stdout LINE parsed as JSON goes to `onJson` (a line that is not JSON is
 * dropped — the CLIs print only JSON on stdout); stderr is kept as a tail. Resolves at the exit.
 */
export async function pumpJsonLines(
  handle: ExecHandle,
  onJson: (value: unknown) => void,
): Promise<{ code: number | null; stderrTail: string }> {
  let buf = '';
  let stderr = '';
  let code: number | null = null;
  const flush = (line: string): void => {
    const t = line.trim();
    if (!t) return;
    let v: unknown;
    try {
      v = JSON.parse(t);
    } catch {
      return;
    }
    onJson(v);
  };
  for await (const ev of handle.events) {
    if (ev.type === 'stdout') {
      buf += ev.data.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        flush(line);
      }
    } else if (ev.type === 'stderr') {
      stderr = (stderr + ev.data.toString('utf8')).slice(-STDERR_TAIL);
    } else {
      code = ev.code;
    }
  }
  if (buf) flush(buf);
  return { code, stderrTail: stripAnsi(stderr) };
}

/** Terminal colour codes out (a CLI's log line read as a sentence). Pure. */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

/** The ledger feature of a turn in `mode` (chat = the plan's, build = the build's). */
export function ledgerFeature(account: SandboxUsageAccount, mode: SandboxAgentMode): string {
  return account.features?.[mode] ?? (mode === 'chat' ? STORY_BUILD_LEDGER_FEATURES.plan : STORY_BUILD_LEDGER_FEATURES.build);
}

/**
 * THE DEFAULT SINK: the ONE ledger (db/usage.ts `recordAiUsage`) and the spend budget's Claude reading
 * (ai/budget.ts `noteAgentMessage`, the same fold the Agent SDK tap feeds — the CLI in the sandbox is
 * not an SDK query, so its `rate_limit_event` is handed over here). Both imported LAZILY: the DB client
 * opens SQLite at import. A ledger write never breaks the session.
 */
export const DEFAULT_USAGE_SINK: SandboxUsageSink = {
  async record(row) {
    try {
      const { recordAiUsage } = await import('../../db/usage.js');
      await recordAiUsage({
        accountId: row.accountId,
        seam: 'agent',
        feature: row.feature,
        model: row.model,
        costUsd: row.costUsd,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        repoId: row.repoId,
        provider: row.provider,
        sharePct: null,
      });
    } catch (err) {
      console.warn('[sandbox] could not record usage:', (err as Error).message);
    }
  },
  noteClaudeRateLimit(message) {
    void import('../../ai/budget.js')
      .then((m) => m.noteAgentMessage(message))
      .catch(() => {});
  },
};

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

/** One plain line for a tool call: the command, the file, the pattern. Pure. */
export function toolSummary(tool: string, input: unknown): string {
  const o = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const pick =
    str(o.command) ??
    str(o.file_path) ??
    str(o.notebook_path) ??
    str(o.path) ??
    str(o.pattern) ??
    str(o.url) ??
    str(o.query) ??
    str(o.description) ??
    str(o.prompt);
  const line = (pick ?? tool).replace(/\s+/g, ' ').trim();
  return clipSandboxText(line, SANDBOX_TOOL_SUMMARY_MAX);
}

/** A promise with a timeout: rejects with `message` after `ms`. */
export function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p.finally(() => timer && clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
      timer.unref?.();
    }),
  ]);
}

/** A deferred promise. */
export function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: Error) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
