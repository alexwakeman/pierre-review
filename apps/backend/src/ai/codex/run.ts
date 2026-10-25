// THE CODEX PROCESS (docs/CODEX-PLAN.md § 3.2; CODEX-SPIKE.md § 7, 9). Spawns `codex exec` with the
// argv ai/codex/config.ts built, writes the prompt to stdin, streams stdout's JSONL through
// ai/codex/events.ts, keeps stderr (refusals appear ONLY there), and settles with what happened.
//
//   • An AbortSignal (or the timeout) sends SIGTERM, then SIGKILL after a grace period. ⚠ The CLI
//     exits 0 on SIGTERM (measured, ~20 ms), so "cancelled" is OUR flag, never read off the exit code.
//   • ⚠ THE WHOLE PROCESS GROUP IS SIGNALLED, never the one pid. The native CLI starts children of its
//     own (Limn's workspace MCP server, the PreToolUse hook, a sandboxed tool), and a signal to the CLI
//     alone can leave them running. So the child is spawned DETACHED (its own process group; POSIX
//     only — on Windows the child alone is signalled) and every signal goes to `-pid`, ESRCH-safe.
//     When the CLI exits, whatever is left in its group is ended too, and a Limn process that exits
//     mid-run SIGKILLs every live group (`process.on('exit')`).
//   • A cancelled or timed-out run reports `usage: null` — Codex emits no `turn.completed` for it, and
//     an unknown figure is never written as zero.
//   • It RESOLVES for every run that started (any exit code); the caller decides what a non-zero exit
//     or a `turn.failed` means. It REJECTS only when the binary could not be started at all.
//   • stdout/stderr are bounded: events are kept (a run is a few hundred), stderr keeps its last 64 KiB.
import { spawn } from 'node:child_process';
import { parseEventLine, summarizeEvents, type CodexEvent, type TokenUsage } from './events.js';
import { codexBinary } from './home.js';

export interface CodexExecOptions {
  cwd: string;
  /** The child's WHOLE environment (config.ts `codexChildEnv`). */
  env: Record<string, string>;
  signal?: AbortSignal;
  /** Every parsed event, in order, as it arrives. A throw here is caught and logged, never fatal. */
  onEvent?: (e: CodexEvent) => void;
  /** The prompt, written to stdin (the argv ends in `-`). */
  stdin?: string;
  /** The binary. Absent ⇒ Limn's pinned install (ai/codex/home.ts `codexBinary`). */
  binary?: string;
  /** Wall-clock limit. Absent ⇒ none. */
  timeoutMs?: number;
  /** SIGTERM → SIGKILL grace. Default 5 s. */
  killGraceMs?: number;
}

export interface CodexExecResult {
  events: CodexEvent[];
  threadId: string | null;
  /** The last agent message ('' when none). */
  finalResponse: string;
  /** The last turn's usage AS REPORTED (cumulative on a resumed thread); null when none came. */
  usage: TokenUsage | null;
  stderr: string;
  exitCode: number | null;
  /** The signal that ended the child, when one did. */
  signal: NodeJS.Signals | null;
  cancelled: boolean;
  timedOut: boolean;
}

const STDERR_KEEP = 64 * 1024;

/** POSIX: a run is its own process group. Windows has no `-pid`; the child alone is signalled. */
const GROUPS = process.platform !== 'win32';

/** Signal a run's process group (POSIX) or its child (Windows). Never throws: ESRCH means "gone". */
export function signalRun(pid: number | undefined, sig: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    process.kill(GROUPS ? -pid : pid, sig);
  } catch {
    // ESRCH: the group is already gone. EPERM: not ours. Neither is an error of the run.
  }
}

// Every live run, so a Limn that exits mid-run does not orphan a Codex process group.
const live = new Set<number>();
let exitHooked = false;
function track(pid: number): void {
  live.add(pid);
  if (exitHooked) return;
  exitHooked = true;
  process.on('exit', () => {
    for (const p of live) signalRun(p, 'SIGKILL');
  });
}

export async function runCodexExec(args: readonly string[], opts: CodexExecOptions): Promise<CodexExecResult> {
  const binary = opts.binary ?? (await codexBinary());
  if (opts.signal?.aborted) {
    return { events: [], threadId: null, finalResponse: '', usage: null, stderr: '', exitCode: null, signal: null, cancelled: true, timedOut: false };
  }

  return new Promise<CodexExecResult>((resolve, reject) => {
    const child = spawn(binary, [...args], {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Its OWN process group, so a stop reaches the MCP server, the hook and any tool it started.
      detached: GROUPS,
    });
    if (child.pid !== undefined) track(child.pid);

    const events: CodexEvent[] = [];
    let stdoutBuf = '';
    let stderr = '';
    let cancelled = false;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    let timeout: NodeJS.Timeout | undefined;
    let settled = false;
    const grace = opts.killGraceMs ?? 5_000;

    // SIGTERM the group now, SIGKILL it after the grace. The SIGKILL goes out whatever the leader did
    // meanwhile: a straggler in the group is exactly what it is for. Once only.
    const stopGroup = (): void => {
      if (killTimer) return;
      signalRun(child.pid, 'SIGTERM');
      killTimer = setTimeout(() => signalRun(child.pid, 'SIGKILL'), grace);
      killTimer.unref?.();
    };
    const stop = (): void => {
      if (!settled) stopGroup();
    };
    const onAbort = (): void => {
      cancelled = true;
      stop();
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    if (opts.timeoutMs !== undefined) {
      timeout = setTimeout(() => {
        timedOut = true;
        stop();
      }, opts.timeoutMs);
      timeout.unref?.();
    }

    const handleLine = (line: string): void => {
      const e = parseEventLine(line);
      if (!e) return;
      events.push(e);
      try {
        opts.onEvent?.(e);
      } catch (err) {
        console.warn('[codex] onEvent threw:', (err as Error).message);
      }
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdoutBuf += chunk;
      let i: number;
      while ((i = stdoutBuf.indexOf('\n')) >= 0) {
        handleLine(stdoutBuf.slice(0, i));
        stdoutBuf = stdoutBuf.slice(i + 1);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
      if (stderr.length > STDERR_KEEP * 2) stderr = stderr.slice(-STDERR_KEEP);
    });
    // A child that exits before reading stdin gives EPIPE on the write: not an error of ours.
    child.stdin.on('error', () => {});
    child.stdin.end(opts.stdin ?? '');

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      if (stdoutBuf.trim()) handleLine(stdoutBuf);
      if (timeout) clearTimeout(timeout);
      opts.signal?.removeEventListener('abort', onAbort);
      if (child.pid !== undefined) live.delete(child.pid);
      // Whatever the CLI left in its group is ended now (ESRCH-safe; usually there is nothing).
      if (killTimer) clearTimeout(killTimer);
      signalRun(child.pid, 'SIGKILL');
      const s = summarizeEvents(events);
      const stopped = cancelled || timedOut;
      resolve({
        events,
        threadId: s.threadId,
        finalResponse: s.finalResponse,
        // ⚠ A stopped run's tokens are UNKNOWN, even if an earlier turn of a resumed thread reported.
        usage: stopped ? null : s.usage,
        stderr: stderr.length > STDERR_KEEP ? stderr.slice(-STDERR_KEEP) : stderr,
        exitCode,
        signal,
        cancelled,
        timedOut,
      });
    };

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      opts.signal?.removeEventListener('abort', onAbort);
      if (child.pid !== undefined) live.delete(child.pid);
      reject(new Error(`Could not start Codex (${(err as NodeJS.ErrnoException).code ?? err.message}).`));
    });
    // The leader exited: a straggler in its group may still hold stdout open, which would hold back
    // 'close' indefinitely. Signal the group now (SIGTERM, then SIGKILL after the grace).
    child.on('exit', () => {
      if (!settled) stopGroup();
    });
    child.on('close', finish);
  });
}
