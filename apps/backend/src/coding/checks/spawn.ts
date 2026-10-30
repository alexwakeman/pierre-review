// ONE PROCESS, ARGV ONLY (docs/SECURITY.md § Sandboxed checks): every check, dependency step and hook
// is started here with `shell: false` — the program and its arguments as an array, never a command
// string — in its own process group, so a timeout or a cancel kills the whole tree (a test runner's
// workers too). Output is stdout + stderr interleaved, ANSI stripped and CAPPED: the first part and the
// last part are kept (a failing test prints its summary at the end) and the middle is named as cut.
// Node built-ins only.
import { spawn } from 'node:child_process';

export interface RunProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  /** Characters of output kept (head + tail). */
  outputCap: number;
  signal?: AbortSignal;
}

export interface RunProcessResult {
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  /** The process never started (missing program): the error, in a sentence. */
  spawnError: string | null;
  output: string;
  truncated: boolean;
  durationMs: number;
}

// CSI / OSC escape sequences and stray carriage returns (progress bars).
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '').replace(/\r(?!\n)/g, '\n');
}

/** Keeps the first quarter and the last three quarters of `cap` characters, naming what was cut. */
export class CappedOutput {
  private head = '';
  private tail = '';
  private dropped = 0;
  constructor(private readonly cap: number) {}

  push(chunk: string): void {
    const headCap = Math.floor(this.cap / 4);
    if (this.head.length < headCap) {
      const take = chunk.slice(0, headCap - this.head.length);
      this.head += take;
      chunk = chunk.slice(take.length);
    }
    if (chunk === '') return;
    this.tail += chunk;
    const tailCap = this.cap - headCap;
    if (this.tail.length > tailCap * 2) {
      this.dropped += this.tail.length - tailCap;
      this.tail = this.tail.slice(this.tail.length - tailCap);
    }
  }

  result(): { text: string; truncated: boolean } {
    const tailCap = this.cap - Math.floor(this.cap / 4);
    let tail = this.tail;
    let dropped = this.dropped;
    if (tail.length > tailCap) {
      dropped += tail.length - tailCap;
      tail = tail.slice(tail.length - tailCap);
    }
    const text = stripAnsi(dropped > 0 ? `${this.head}\n… ${dropped.toLocaleString('en-US')} characters cut …\n${tail}` : this.head + tail);
    return { text, truncated: dropped > 0 };
  }
}

/** Run one argv to completion (or the timeout / the abort), capturing capped output. Never throws. */
export function runProcess(o: RunProcessOptions): Promise<RunProcessResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const out = new CappedOutput(o.outputCap);
    let settled = false;
    let timedOut = false;
    let aborted = false;
    const finish = (r: Omit<RunProcessResult, 'output' | 'truncated' | 'durationMs' | 'timedOut' | 'aborted'>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', onAbort);
      const { text, truncated } = out.result();
      resolve({ ...r, timedOut, aborted, output: text, truncated, durationMs: Date.now() - started });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(o.command, o.args, {
        cwd: o.cwd,
        env: o.env,
        shell: false,
        detached: true, // its own process group: killGroup reaches every descendant
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e) {
      settled = true;
      resolve({ exitCode: null, timedOut: false, aborted: false, spawnError: e instanceof Error ? e.message : String(e), output: '', truncated: false, durationMs: 0 });
      return;
    }
    const killGroup = (): void => {
      if (child.pid == null) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          /* gone */
        }
      }
    };
    const onAbort = (): void => {
      aborted = true;
      killGroup();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, o.timeoutMs);
    timer.unref?.();
    if (o.signal?.aborted) onAbort();
    else o.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => out.push(d));
    child.stderr?.on('data', (d: string) => out.push(d));
    child.on('error', (e) => finish({ exitCode: null, spawnError: e.message }));
    child.on('close', (code) => {
      // A runner may leave background children holding nothing open: take the group down regardless.
      killGroup();
      finish({ exitCode: code, spawnError: null });
    });
  });
}
