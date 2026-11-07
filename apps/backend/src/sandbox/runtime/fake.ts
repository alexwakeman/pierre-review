// THE FAKE RUNTIME (docs/SANDBOX.md § Testing): an in-memory `SandboxRuntime` for every caller's tests
// (workspace mirror, drivers, session manager, routes). No daemon, no process.
//
//   RECORD — every call lands in `fake.calls` (method + arguments), so a test asserts what was asked.
//   REPLAY — `fake.onExec(match, handler)` answers an `exec`: a fixed result, or an INTERACTIVE handler
//            that reads the stdin lines the caller writes and emits output lines (e.g. a recorded
//            Claude stream-json fixture, replayed turn by turn). An unmatched exec exits 127.
//
// Files written with `copyIn` are readable with `readFile`; `destroy` / `sweep` remove the session's
// resources just as the real adapters do, so a leak shows up in `fake.resources()`.
import { EventQueue } from './cli.js';
import type {
  ComposeCall,
  ContainerHandle,
  ExecEvent,
  ExecHandle,
  ExecOptions,
  ExecResult,
  ImageBuildSpec,
  RuntimeDetection,
  SandboxRuntime,
  SweepResult,
} from './types.js';
import { collect } from './cli.js';
import { resourceName } from './labels.js';

export interface FakeCall {
  method: string;
  args: unknown[];
}

export interface FakeExecContext {
  container: string;
  argv: string[];
  opts: ExecOptions;
  /** Lines the caller writes to stdin (split on `\n`), then the end of input. */
  stdin: AsyncIterable<string>;
  stdout(text: string): void;
  stderr(text: string): void;
  /** Resolves when the caller kills the process. */
  killed: Promise<void>;
}

export type FakeExecHandler =
  | { code?: number; stdout?: string | Buffer; stderr?: string }
  | ((ctx: FakeExecContext) => Promise<number | void> | number | void);

type Matcher = string | RegExp | ((argv: string[], container: string) => boolean);

interface FakeResource {
  kind: 'container' | 'network' | 'volume' | 'image';
  name: string;
  sessionId: string;
  role: string;
}

export interface FakeRuntime extends SandboxRuntime {
  calls: FakeCall[];
  /** Answer `exec` calls whose argv matches (`argv.join(' ')` for a string or RegExp). Later registrations win. */
  onExec(match: Matcher, handler: FakeExecHandler): void;
  /** Lines the fake proxy container prints (fed to `followLogs`). */
  emitLog(container: string, line: string): void;
  files(container: string): Map<string, Buffer>;
  resources(): FakeResource[];
  setDetection(d: Partial<RuntimeDetection>): void;
  /** Answer `compose` calls (default: exit 0, no output). Later registrations win. */
  onCompose(handler: (call: ComposeCall) => Partial<ExecResult> & { lines?: string[] } | Promise<Partial<ExecResult> & { lines?: string[] }>): void;
  /** Answer `buildImage` calls (default: exit 0; the image is recorded as a resource). */
  onBuild(handler: (spec: ImageBuildSpec) => Partial<ExecResult> & { lines?: string[] } | Promise<Partial<ExecResult> & { lines?: string[] }>): void;
}

type FakeAnswer = Partial<ExecResult> & { lines?: string[] };
const toResult = (a: FakeAnswer, onLine?: (l: string) => void): ExecResult => {
  for (const l of a.lines ?? []) onLine?.(l);
  return { code: a.code ?? 0, stdout: a.stdout ?? Buffer.from((a.lines ?? []).join('\n')), stderr: a.stderr ?? '', timedOut: a.timedOut ?? false };
};

export const FAKE_DETECTION: RuntimeDetection = {
  kind: 'fake',
  available: true,
  cli: '/fake/docker',
  cliVersion: 'fake',
  daemonReachable: true,
  serverVersion: 'fake',
  os: 'linux',
  arch: 'x86_64',
  memoryBytes: 16 * 1024 ** 3,
  cpus: 8,
  rootless: false,
  flavour: 'fake',
  licenceNote: null,
  problem: null,
};

function matches(m: Matcher, argv: string[], container: string): boolean {
  if (typeof m === 'function') return m(argv, container);
  const joined = argv.join(' ');
  return typeof m === 'string' ? joined === m || joined.startsWith(`${m} `) : m.test(joined);
}

export function createFakeRuntime(): FakeRuntime {
  const calls: FakeCall[] = [];
  const handlers: { match: Matcher; handler: FakeExecHandler }[] = [];
  const fileStore = new Map<string, Map<string, Buffer>>();
  const resources = new Map<string, FakeResource>();
  const logs = new Map<string, EventQueue<ExecEvent>[]>();
  let detection = { ...FAKE_DETECTION };
  let composeHandler: (call: ComposeCall) => FakeAnswer | Promise<FakeAnswer> = () => ({});
  let buildHandler: (spec: ImageBuildSpec) => FakeAnswer | Promise<FakeAnswer> = () => ({});
  const record = (method: string, ...args: unknown[]): void => {
    calls.push({ method, args });
  };
  const add = (kind: FakeResource['kind'], name: string, sessionId: string, role: string): void => {
    resources.set(`${kind}:${name}`, { kind, name, sessionId, role });
  };
  const filesOf = (container: string): Map<string, Buffer> => {
    let m = fileStore.get(container);
    if (!m) fileStore.set(container, (m = new Map()));
    return m;
  };

  function exec(container: string, argv: string[], opts: ExecOptions = {}): ExecHandle {
    record('exec', container, argv, opts);
    const events = new EventQueue<ExecEvent>();
    const stdinQueue = new EventQueue<string>();
    let pending = '';
    let killResolve!: () => void;
    const killed = new Promise<void>((r) => (killResolve = r));
    let resolveDone!: (r: { code: number | null; signal: string | null; timedOut: boolean }) => void;
    const done = new Promise<{ code: number | null; signal: string | null; timedOut: boolean }>((r) => (resolveDone = r));
    let finished = false;
    const finish = (code: number | null, signal: string | null = null): void => {
      if (finished) return;
      finished = true;
      events.push({ type: 'exit', code, signal, timedOut: false });
      events.close();
      stdinQueue.close();
      resolveDone({ code, signal, timedOut: false });
    };
    const feed = (data: string | Buffer): void => {
      pending += String(data);
      let i;
      while ((i = pending.indexOf('\n')) >= 0) {
        stdinQueue.push(pending.slice(0, i));
        pending = pending.slice(i + 1);
      }
    };
    const endInput = (): void => {
      if (pending) stdinQueue.push(pending);
      pending = '';
      stdinQueue.close();
    };
    if (opts.input !== undefined) {
      feed(opts.input);
      endInput();
    }
    const found = [...handlers].reverse().find((h) => matches(h.match, argv, container));
    queueMicrotask(async () => {
      if (!found) {
        events.push({ type: 'stderr', data: Buffer.from(`fake runtime: no handler for ${argv.join(' ')}\n`) });
        finish(127);
        return;
      }
      const h = found.handler;
      if (typeof h !== 'function') {
        if (h.stdout !== undefined) events.push({ type: 'stdout', data: Buffer.from(h.stdout) });
        if (h.stderr !== undefined) events.push({ type: 'stderr', data: Buffer.from(h.stderr) });
        finish(h.code ?? 0);
        return;
      }
      try {
        const code = await h({
          container,
          argv,
          opts,
          stdin: stdinQueue,
          stdout: (t) => events.push({ type: 'stdout', data: Buffer.from(t) }),
          stderr: (t) => events.push({ type: 'stderr', data: Buffer.from(t) }),
          killed,
        });
        finish(typeof code === 'number' ? code : 0);
      } catch (e) {
        events.push({ type: 'stderr', data: Buffer.from(String(e)) });
        finish(1);
      }
    });
    return {
      events,
      write: (d) => feed(d),
      end: endInput,
      kill: () => {
        killResolve();
        finish(null, 'SIGKILL');
      },
      done,
    };
  }

  const removeWhere = (doomed: (sessionId: string) => boolean, dryRun = false): SweepResult => {
    const r: SweepResult = { containers: [], networks: [], volumes: [], images: [], errors: [] };
    for (const [key, res] of resources) {
      if (!doomed(res.sessionId)) continue;
      r[`${res.kind}s` as 'containers' | 'networks' | 'volumes' | 'images'].push(res.name);
      if (!dryRun) {
        resources.delete(key);
        if (res.kind === 'container') fileStore.delete(res.name);
      }
    }
    return r;
  };

  const fake: FakeRuntime = {
    kind: 'fake',
    calls,
    onExec(match, handler) {
      handlers.push({ match, handler });
    },
    emitLog(container, line) {
      for (const q of logs.get(container) ?? []) q.push({ type: 'stdout', data: Buffer.from(`${line}\n`) });
    },
    files: filesOf,
    resources: () => [...resources.values()],
    setDetection(d) {
      detection = { ...detection, ...d };
    },
    async detect() {
      record('detect');
      return { ...detection };
    },
    async ensureImage() {
      record('ensureImage');
      return { ref: 'limn-sandbox:fake', source: 'local' };
    },
    async createNetwork(owner) {
      record('createNetwork', owner);
      const name = resourceName(owner.sessionId, 'net');
      add('network', name, owner.sessionId, 'network');
      return { name };
    },
    async createVolume(owner, key) {
      record('createVolume', owner, key);
      const name = resourceName(owner.sessionId, `vol-${key}`);
      add('volume', name, owner.sessionId, 'volume');
      return name;
    },
    async startProxy(spec): Promise<ContainerHandle> {
      record('startProxy', { ...spec, source: `<${spec.source.length} chars>` });
      const name = resourceName(spec.sessionId, 'proxy');
      add('container', name, spec.sessionId, 'proxy');
      return { name };
    },
    async startSandbox(spec) {
      record('startSandbox', spec);
      const name = resourceName(spec.sessionId, 'sandbox');
      add('container', name, spec.sessionId, 'sandbox');
      return { name };
    },
    exec,
    run(container, argv, opts) {
      return collect(exec(container, argv, opts));
    },
    async copyIn(container, files, opts) {
      record('copyIn', container, files.map((f) => f.path), opts);
      const m = filesOf(container);
      for (const f of files) m.set(f.path, typeof f.content === 'string' ? Buffer.from(f.content) : f.content);
    },
    async readFile(container, path) {
      record('readFile', container, path);
      return fileStore.get(container)?.get(path) ?? null;
    },
    followLogs(container) {
      record('followLogs', container);
      const q = new EventQueue<ExecEvent>();
      logs.set(container, [...(logs.get(container) ?? []), q]);
      let resolveDone!: (r: { code: number | null; signal: string | null; timedOut: boolean }) => void;
      const done = new Promise<{ code: number | null; signal: string | null; timedOut: boolean }>((r) => (resolveDone = r));
      return {
        events: q,
        write: () => undefined,
        end: () => undefined,
        kill: () => {
          q.push({ type: 'exit', code: null, signal: 'SIGKILL', timedOut: false });
          q.close();
          resolveDone({ code: null, signal: 'SIGKILL', timedOut: false });
        },
        done,
      };
    },
    async networkMembers(network) {
      record('networkMembers', network);
      return new Map();
    },
    onCompose(h) {
      composeHandler = h;
    },
    onBuild(h) {
      buildHandler = h;
    },
    async compose(call): Promise<ExecResult> {
      const { onLine, signal: _signal, ...rest } = call;
      record('compose', rest);
      return toResult(await composeHandler(call), onLine);
    },
    async buildImage(spec): Promise<ExecResult> {
      const { onLine, signal: _signal, ...rest } = spec;
      record('buildImage', rest);
      const r = toResult(await buildHandler(spec), onLine);
      if (r.code === 0) add('image', spec.tag, spec.sessionId, 'image');
      return r;
    },
    async stats(sessionId) {
      record('stats', sessionId);
      return [...resources.values()]
        .filter((r) => r.kind === 'container' && r.sessionId === sessionId)
        .map((r) => ({ name: r.name, role: r.role, cpuPercent: 0, memoryBytes: 0, memoryLimitBytes: null }));
    },
    async destroy(sessionId) {
      record('destroy', sessionId);
      return removeWhere((s) => s === sessionId);
    },
    async sweep(live, opts) {
      const set = new Set(live);
      record('sweep', [...set], opts);
      return removeWhere((s) => !set.has(s), opts?.dryRun === true);
    },
  };
  return fake;
}
