// The API process's handle on the scoring PROCESS (scorer-process.ts). Lazy: no process, no model
// in memory, until the first batch arrives. Idle for LIMN_ML_IDLE_MS (default 10 min) and the
// process is stopped, which returns all of its memory (~0.5 GB with the model) to the OS. The
// next batch starts it again (a couple of seconds to load).
//
// ⚠ BACKGROUND PRIORITY IS THE POINT OF A SEPARATE PROCESS (throttle.ts has the full set of
// limits). macOS: started through `taskpolicy -b` (background QoS — CPU and I/O throttled whenever
// anything else wants them). Everywhere: niced to the lowest priority right after spawn.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { constants as osConstants, setPriority } from 'node:os';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { esmEntryOf, findPackageDir } from '../ai/runtime.js';
import type { ScoreItem, ScoreResult } from './decode.js';
import type { ScorerInit, ScorerReply } from './scorer-process.js';
import { cpuShareFrom, threadsFrom } from './throttle.js';

export interface LocalBatch {
  results: ScoreResult[];
  modelVersion: string;
}

/** A failed local batch. `loadFailed`: the model never loaded, so nothing will score. */
export class LocalScorerError extends Error {
  constructor(
    message: string,
    readonly loadFailed: boolean,
  ) {
    super(message);
    this.name = 'LocalScorerError';
  }
}

const IDLE_MS = Number(process.env.LIMN_ML_IDLE_MS) > 0 ? Number(process.env.LIMN_ML_IDLE_MS) : 10 * 60_000;
const TASKPOLICY = '/usr/sbin/taskpolicy';

// dist/ml/local-scorer.js runs scorer-process.js; from source (tsx dev, vitest) this file is .ts
// and the child needs tsx's loader to run scorer-process.ts.
const IS_TS = import.meta.url.endsWith('.ts');
const CHILD_SCRIPT = fileURLToPath(new URL(IS_TS ? './scorer-process.ts' : './scorer-process.js', import.meta.url));

function childNodeArgs(): string[] {
  if (!IS_TS) return [CHILD_SCRIPT];
  const dir = findPackageDir('tsx', dirname(fileURLToPath(import.meta.url)));
  const entry = dir ? esmEntryOf(dir) : null;
  if (!entry) throw new LocalScorerError('tsx is needed to run the scoring process from source', true);
  return ['--import', pathToFileURL(entry).href, CHILD_SCRIPT];
}

interface Pending {
  resolve: (b: LocalBatch) => void;
  reject: (e: Error) => void;
  /** The process it was sent to: a retired process's exit must fail only ITS requests. */
  child: ChildProcess;
}

let child: ChildProcess | null = null;
let childDir: string | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();
let idleTimer: NodeJS.Timeout | null = null;

function failAll(err: Error, only?: ChildProcess): void {
  for (const [id, p] of pending) {
    if (only && p.child !== only) continue;
    pending.delete(id);
    p.reject(err);
  }
}

function stopChild(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  const c = child;
  child = null;
  childDir = null;
  if (c && c.exitCode === null) c.kill();
}

function armIdle(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (pending.size === 0) stopChild();
    else armIdle();
  }, IDLE_MS);
  idleTimer.unref();
}

/** Lowest scheduling priority for `pid`. Best effort: a refusal only costs the politeness. */
function lowerPriority(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    setPriority(pid, process.platform === 'win32' ? osConstants.priority.PRIORITY_LOW : 19);
  } catch {
    /* not permitted here; taskpolicy (macOS) and the duty cycle still apply */
  }
}

function startChild(modelsDir: string): ChildProcess {
  const init: ScorerInit = {
    modelsDir,
    intraOpThreads: threadsFrom(process.env.LIMN_ML_THREADS),
    cpuShare: cpuShareFrom(process.env.LIMN_ML_CPU_SHARE),
  };
  const nodeArgs = childNodeArgs();
  // taskpolicy EXECs node in place, so the pid, the IPC channel and every flag carry through.
  const viaTaskpolicy = process.platform === 'darwin' && existsSync(TASKPOLICY);
  const c = spawn(
    viaTaskpolicy ? TASKPOLICY : process.execPath,
    viaTaskpolicy ? ['-b', process.execPath, ...nodeArgs] : nodeArgs,
    {
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      env: { ...process.env, LIMN_ML_SCORER_INIT: JSON.stringify(init) },
      windowsHide: true,
    },
  );
  lowerPriority(c.pid);
  c.on('message', (reply: ScorerReply) => {
    const p = pending.get(reply.id);
    if (!p) return;
    pending.delete(reply.id);
    if (reply.ok) p.resolve({ results: reply.results, modelVersion: reply.modelVersion });
    else p.reject(new LocalScorerError(reply.error, reply.loadFailed));
  });
  c.on('error', (err) => {
    if (child === c) stopChild();
    failAll(new LocalScorerError(`the scoring process failed: ${err.message}`, true), c);
  });
  c.on('exit', (code, signal) => {
    if (child === c) {
      child = null;
      childDir = null;
    }
    failAll(new LocalScorerError(`the scoring process exited (${signal ?? `code ${code}`})`, true), c);
  });
  return c;
}

/** Keep the API process alive for an in-flight batch only; an idle scorer never holds it open. */
function hold(c: ChildProcess, on: boolean): void {
  const ch = c.channel as { ref?: () => void; unref?: () => void } | undefined;
  if (on) {
    c.ref();
    ch?.ref?.();
  } else {
    c.unref();
    ch?.unref?.();
  }
}

/** Score one batch in the scoring process. Results come back in INPUT order; nothing is dropped. */
export function scoreLocally(modelsDir: string, items: ScoreItem[]): Promise<LocalBatch> {
  if (items.length === 0) return Promise.resolve({ results: [], modelVersion: '' });
  // A different model directory (a fresh download replaced the dev checkout, say) needs a fresh
  // process: the old one holds the old session.
  if (child && childDir !== modelsDir) stopChild();
  if (!child) {
    child = startChild(modelsDir);
    childDir = modelsDir;
  }
  const c = child;
  hold(c, true);
  armIdle();
  const id = nextId++;
  const settle = (): void => {
    if (![...pending.values()].some((p) => p.child === c)) hold(c, false);
  };
  return new Promise<LocalBatch>((resolve, reject) => {
    pending.set(id, { resolve, reject, child: c });
    c.send({ id, items }, (err) => {
      if (err && pending.delete(id)) reject(new LocalScorerError(`could not reach the scoring process: ${err.message}`, true));
    });
  }).then(
    (b) => {
      settle();
      if (b.results.length !== items.length) {
        throw new LocalScorerError(`local scorer returned ${b.results.length} results for ${items.length} items`, false);
      }
      return b;
    },
    (err: Error) => {
      settle();
      throw err;
    },
  );
}

/** Test seam / shutdown: stop the scoring process now. */
export function stopLocalScorer(): void {
  failAll(new LocalScorerError('the scoring process was stopped', false));
  stopChild();
}

/** Test seam: the running process's pid, if any. */
export function localScorerPid(): number | null {
  return child?.pid ?? null;
}
