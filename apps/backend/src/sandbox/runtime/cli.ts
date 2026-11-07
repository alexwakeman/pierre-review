// ONE WAY TO START A CONTAINER CLI (docs/SANDBOX.md § The runtime layer): an argv array, never a shell
// string, with Limn's environment MINUS anything credential-shaped (`dockerCliEnv`, the same filter the
// sandboxed checks use). The adapters take a `CliRunner`, so their tests script the CLI's answers
// instead of needing a daemon.
import { spawn } from 'node:child_process';
import { dockerCliEnv } from '../../coding/checks/docker.js';
import type { ExecEvent, ExecHandle, ExecResult } from './types.js';

export interface CliCallOptions {
  /** Written to stdin, then stdin is closed. */
  input?: string | Buffer;
  /** Keep stdin open for `write()` (spawn only). */
  interactive?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Collected stdout is cut past this many bytes (run only). Default 64 MB. */
  maxBytes?: number;
  /** Extra environment for this one call (e.g. `DOCKER_BUILDKIT=0` for a service build). */
  env?: Record<string, string>;
}

export interface CliRunner {
  /** The program, as found on PATH (for messages). */
  readonly program: string;
  run(args: string[], opts?: CliCallOptions): Promise<ExecResult>;
  spawn(args: string[], opts?: CliCallOptions): ExecHandle;
}

/** A queue that turns pushed values into an async iterator (one consumer). */
export class EventQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: ((r: IteratorResult<T>) => void)[] = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w({ value: item, done: false });
    else this.items.push(item);
  }

  close(): void {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

/** Collect an ExecHandle to completion. */
export async function collect(handle: ExecHandle, maxBytes = 64 << 20): Promise<ExecResult> {
  const out: Buffer[] = [];
  let outBytes = 0;
  let stderr = '';
  for await (const ev of handle.events) {
    if (ev.type === 'stdout') {
      if (outBytes < maxBytes) {
        out.push(ev.data.subarray(0, maxBytes - outBytes));
        outBytes += ev.data.length;
      }
    } else if (ev.type === 'stderr') {
      if (stderr.length < 64_000) stderr += ev.data.toString('utf8');
    }
  }
  const r = await handle.done;
  return { code: r.code, stdout: Buffer.concat(out), stderr: stderr.slice(0, 64_000), timedOut: r.timedOut };
}

/** The real runner: `spawn(program, args)` with the filtered environment. */
export function createCliRunner(program: string, env: NodeJS.ProcessEnv = process.env): CliRunner {
  const childEnv = dockerCliEnv(env);
  const spawnOne = (args: string[], opts: CliCallOptions = {}): ExecHandle => {
    const events = new EventQueue<ExecEvent>();
    let timedOut = false;
    let resolveDone!: (r: { code: number | null; signal: string | null; timedOut: boolean }) => void;
    const done = new Promise<{ code: number | null; signal: string | null; timedOut: boolean }>((r) => (resolveDone = r));
    const keepStdin = opts.input === undefined && opts.interactive === true;
    const child = spawn(program, args, {
      env: opts.env ? { ...childEnv, ...opts.env } : childEnv,
      shell: false,
      stdio: [opts.input !== undefined || keepStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let finished = false;
    const finish = (code: number | null, signal: string | null): void => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      events.push({ type: 'exit', code, signal, timedOut });
      events.close();
      resolveDone({ code, signal, timedOut });
    };
    const kill = (): void => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* gone */
      }
    };
    const onAbort = (): void => kill();
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          kill();
        }, opts.timeoutMs)
      : null;
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    if (opts.signal?.aborted) kill();
    child.stdout?.on('data', (d: Buffer) => events.push({ type: 'stdout', data: d }));
    child.stderr?.on('data', (d: Buffer) => events.push({ type: 'stderr', data: d }));
    child.stdin?.on('error', () => {
      /* the process went away before reading everything: its exit says what happened */
    });
    child.on('error', (e) => {
      events.push({ type: 'stderr', data: Buffer.from(`${program}: ${e.message}\n`) });
      finish(null, null);
    });
    child.on('close', (code, signal) => finish(code, signal));
    if (opts.input !== undefined && child.stdin) child.stdin.end(opts.input);
    return {
      events,
      write: (data) => {
        if (child.stdin && !child.stdin.destroyed) child.stdin.write(data);
      },
      end: () => child.stdin?.end(),
      kill,
      done,
    };
  };
  return {
    program,
    spawn: spawnOne,
    run: (args, opts = {}) => collect(spawnOne(args, { ...opts, timeoutMs: opts.timeoutMs ?? 60_000 }), opts.maxBytes),
  };
}
