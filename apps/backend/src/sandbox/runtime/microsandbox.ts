// THE MICROSANDBOX BACKEND (docs/SANDBOX.md § microsandbox; plan WP9). ⚠ UNTESTED: written against
// the documented `msb` CLI (docs.microsandbox.dev, read 2026-11-07) on an Intel Mac, which cannot run
// it. The unit tests pin the argv and the parsers; `microsandbox-real.test.ts` (slow project) runs it
// for real and SKIPS, saying why, wherever `msb` cannot run. No npm dependency: the CLI only.
//
// THE SHAPE (why it differs from Docker):
//   • The sandbox is a microVM with its OWN KERNEL, created with `--no-net`: no network policy can let
//     anything out because there is no route at all.
//   • THE EGRESS PROXY IS A HOST PROCESS, the SAME program the Docker backend runs in a container
//     (proxy/server.ts, `node --input-type=module -e`), listening on UNIX SOCKETS in a 0700 folder of
//     Limn's data dir. The VM reaches three of them over vsock (`--vsock <socket>:<port>`); a small
//     relay in the guest (msb-spec.ts GUEST_RELAY) serves them at `limn-proxy:3128/8081/8082`, so the
//     sandbox environment, the allow-list, the log and the credential injectors are IDENTICAL on both
//     backends. The fourth socket (control) is never routed into the VM.
//   • HOST-BOUND SECRETS: the model credential reaches the proxy over its control socket
//     (`proxyControl`), from Limn's memory — never an env var, argv or file — and never enters the VM.
//     microsandbox's own `--secret` substitution is NOT used: it needs TLS interception inside the
//     guest and gives no per-request log (docs/SANDBOX.md § Spike 5).
//   • Writable storage is the VM's private disk (`--mount-owned`), removed with it; nothing else to
//     sweep. Services (Docker in the VM) are not wired yet: the image has no Docker Engine.
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import http from 'node:http';
import { arch as osArch, cpus as osCpus, homedir, platform as osPlatform, totalmem } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { findOnPath } from '../../coding/checks/sandbox.js';
import { PROXY_CONFIG_ENV } from '../proxy/server.js';
import { resolveDataDir } from '../../data-dir.js';
import { collect, createCliRunner, EventQueue, type CliRunner } from './cli.js';
import { createDockerRuntime, resolveCliProgram } from './docker.js';
import { imageRecipe, pinnedPullRef, readImagePin, type ImagePin, type ImageRecipe } from './image.js';
import { appInstance, LABEL_MANAGED, LABEL_ROLE, LABEL_SESSION, resourceLabels, resourceName, type ResourceRole } from './labels.js';
import {
  doctorProblem,
  guestArch,
  GUEST_RELAY,
  GUEST_RELAY_PROBE,
  guestSetupScript,
  MAX_SOCKET_PATH,
  msbCreateArgs,
  msbExecArgs,
  parseMsbImages,
  parseMsbList,
  parseMsbMetrics,
  parseMsbVersion,
  platformProblem,
  type HostProxySockets,
} from './msb-spec.js';
import { SANDBOX_USER } from './spec.js';
import { tarFiles } from './tar.js';
import type {
  ContainerHandle,
  EnsuredImage,
  ExecEvent,
  ExecHandle,
  ExecOptions,
  ExecResult,
  ImageProgress,
  ProxySpec,
  RuntimeDetection,
  SandboxRuntime,
  SessionOwner,
  SweepResult,
} from './types.js';

export const SERVICES_NOT_ON_MICROSANDBOX =
  'Services do not run on microsandbox yet: the sandbox image has no Docker Engine. Use the Docker backend (SANDBOX_RUNTIME=docker) for integration tests.';

export interface MicrosandboxRuntimeOptions {
  /** The CLI: a name on PATH or an absolute path. Default `MSB_CLI`, else `msb` on PATH or in its install folders. */
  cli?: string;
  env?: NodeJS.ProcessEnv;
  /** Test seam: a scripted `msb`. */
  runner?: CliRunner;
  /** Test seam: the Docker CLI used only for the local image build fallback. */
  dockerFallback?: SandboxRuntime | null;
  dockerRunner?: CliRunner | null;
  instance?: string;
  extraLabels?: Record<string, string>;
  recipe?: ImageRecipe | null;
  pin?: ImagePin | null;
  /** Test seams for the hardware check. */
  platform?: NodeJS.Platform;
  arch?: string;
  hasKvm?: boolean;
  /** Where the proxy sockets live. Default `<data dir>/sbx`. */
  socketRoot?: string;
  /** Test seam: start the host proxy (default: `process.execPath --input-type=module -e <source>`). */
  spawnProxy?: (source: string, env: Record<string, string>, cwd: string) => ChildProcess;
  /** How long to wait for the guest relay. */
  relayTimeoutMs?: number;
}

const LIST_TIMEOUT = 30_000;
const CREATE_TIMEOUT = 600_000;

function lines(buf: Buffer | string): string[] {
  return String(buf)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}
function lastLines(text: string, n = 6): string {
  return lines(text).slice(-n).join('\n');
}

/** `msb`: `MSB_CLI`, else PATH, else the installer's folders (`~/.local/bin`, `~/.microsandbox/bin`). */
export function resolveMsbProgram(opts: { cli?: string; env?: NodeJS.ProcessEnv; home?: string } = {}): string | null {
  const env = opts.env ?? process.env;
  const name = opts.cli ?? (env.MSB_CLI?.trim() || 'msb');
  if (isAbsolute(name)) return existsSync(name) ? name : null;
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return null;
  const home = opts.home ?? env.HOME ?? homedir();
  const extra = [join(home, '.local', 'bin'), join(home, '.microsandbox', 'bin')].join(process.platform === 'win32' ? ';' : ':');
  return findOnPath(name, [env.PATH ?? '', extra].filter(Boolean).join(process.platform === 'win32' ? ';' : ':'));
}

/** The per-session socket folder: short (sun_path), private, keyed by instance + session. */
export function socketDirFor(root: string, instance: string, sessionId: string): string {
  const dir = join(root, createHash('sha256').update(`${instance}\n${sessionId}`).digest('hex').slice(0, 12));
  if (Buffer.byteLength(join(dir, 'anthropic.sock')) > MAX_SOCKET_PATH) {
    throw new Error(`The data folder's path is too long for the sandbox proxy's sockets (${dir}). Set LIMN_DATA_DIR to a shorter path.`);
  }
  return dir;
}

export function socketsIn(dir: string): HostProxySockets {
  return { forward: join(dir, 'forward.sock'), anthropic: join(dir, 'anthropic.sock'), chatgpt: join(dir, 'chatgpt.sock'), control: join(dir, 'control.sock') };
}

interface HostProxy {
  sessionId: string;
  child: ChildProcess;
  dir: string;
  sockets: HostProxySockets;
  controlToken: string;
  events: EventQueue<ExecEvent>;
  followed: boolean;
  exited: boolean;
}

function defaultSpawnProxy(source: string, env: Record<string, string>, cwd: string): ChildProcess {
  // ⚠ A MINIMAL environment, never Limn's: the proxy gets its config and nothing credential-shaped.
  return spawn(process.execPath, ['--input-type=module', '-e', source], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true });
}

export function createMicrosandboxRuntime(opts: MicrosandboxRuntimeOptions = {}): SandboxRuntime {
  const env = opts.env ?? process.env;
  const program = opts.runner ? opts.runner.program : resolveMsbProgram({ ...(opts.cli ? { cli: opts.cli } : {}), env });
  const runner: CliRunner | null = opts.runner ?? (program ? createCliRunner(program, env) : null);
  const instance = opts.instance ?? appInstance(env);
  const extraLabels = opts.extraLabels ?? {};
  const socketRoot = opts.socketRoot ?? join(resolveDataDir(env), 'sbx');
  const spawnProxy = opts.spawnProxy ?? defaultSpawnProxy;
  const proxies = new Map<string, HostProxy>();
  /** Session → the agent's process cap (applied per exec: the VM has no cgroup knob for it). */
  const pidCaps = new Map<string, number>();

  const cli = (): CliRunner => {
    if (!runner) throw new Error('microsandbox (`msb`) is not installed.');
    return runner;
  };
  const run = (args: string[], o: { input?: string | Buffer; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<ExecResult> =>
    cli().run(args, { timeoutMs: o.timeoutMs ?? LIST_TIMEOUT, ...(o.input !== undefined ? { input: o.input } : {}), ...(o.signal ? { signal: o.signal } : {}) });
  const must = async (args: string[], what: string, o: { input?: string | Buffer; timeoutMs?: number } = {}): Promise<ExecResult> => {
    const r = await run(args, o);
    if (r.code !== 0) throw new Error(`${what} failed: ${r.timedOut ? 'timed out' : lastLines(r.stderr) || `exit ${r.code}`}`);
    return r;
  };
  const labelsFor = (owner: SessionOwner, role: ResourceRole) => resourceLabels(instance, owner, role, extraLabels);
  const sessionOfName = (name: string): string | null => {
    for (const p of proxies.values()) if (resourceName(p.sessionId, 'proxy') === name) return p.sessionId;
    return null;
  };

  async function detect(): Promise<RuntimeDetection> {
    const platform = opts.platform ?? osPlatform();
    const arch = opts.arch ?? osArch();
    const hasKvm = opts.hasKvm ?? (platform === 'linux' ? existsSync('/dev/kvm') : false);
    const base: RuntimeDetection = {
      kind: 'microsandbox',
      available: false,
      cli: program,
      cliVersion: null,
      daemonReachable: false,
      serverVersion: null,
      os: 'linux',
      arch: guestArch(arch),
      memoryBytes: totalmem(),
      cpus: osCpus().length,
      rootless: true,
      flavour: 'microsandbox',
      licenceNote: null,
      problem: null,
    };
    const hw = platformProblem(platform, arch, hasKvm);
    if (hw) return { ...base, problem: hw };
    if (!runner) return { ...base, problem: 'microsandbox is not installed (no `msb` on the PATH). See “How to set up”.' };
    const version = await runner.run(['--version'], { timeoutMs: 15_000 });
    const cliVersion = parseMsbVersion(String(version.stdout)) ?? parseMsbVersion(version.stderr);
    const doctor = await runner.run(['doctor'], { timeoutMs: 90_000 });
    if (doctor.code !== 0) {
      return { ...base, cliVersion, problem: doctor.timedOut ? '`msb doctor` did not finish in time.' : doctorProblem(`${String(doctor.stdout)}\n${doctor.stderr}`) };
    }
    return { ...base, cliVersion, serverVersion: cliVersion, available: true, daemonReachable: true };
  }

  async function streamed(args: string[], phase: ImageProgress['phase'], o: { onProgress?: (p: ImageProgress) => void; signal?: AbortSignal }): Promise<ExecResult> {
    const h = cli().spawn(args, o.signal ? { signal: o.signal } : {});
    let tail = '';
    for await (const ev of h.events) {
      if (ev.type === 'exit') continue;
      const text = ev.data.toString('utf8');
      if (ev.type === 'stderr') tail = (tail + text).slice(-8_000);
      for (const line of lines(text)) o.onProgress?.({ phase, line });
    }
    const d = await h.done;
    return { code: d.code, stdout: Buffer.alloc(0), stderr: tail, timedOut: d.timedOut };
  }

  /**
   * The image (owner decision Q3, the same order as Docker): already in msb's cache → the pinned GHCR
   * image pulled BY DIGEST (used by that immutable reference) → a local Docker build loaded into msb
   * (`docker save | msb load --tag`). The last needs Docker on the host as well.
   */
  async function ensureImage(o: { onProgress?: (p: ImageProgress) => void; signal?: AbortSignal } = {}): Promise<EnsuredImage> {
    const recipe = opts.recipe === undefined ? imageRecipe() : opts.recipe;
    if (!recipe) throw new Error('The sandbox image recipe is missing (no Dockerfile, or the Claude Code / Codex pins are not exact versions).');
    const pullRef = pinnedPullRef(opts.pin === undefined ? readImagePin() : opts.pin, recipe);
    o.onProgress?.({ phase: 'check', line: `Looking for ${recipe.localTag}` });
    const listed = await run(['images', '-q']);
    const have = listed.code === 0 ? parseMsbImages(String(listed.stdout)) : new Set<string>();
    if (pullRef && have.has(pullRef)) return { ref: pullRef, source: 'local' };
    if (have.has(recipe.localTag)) return { ref: recipe.localTag, source: 'local' };
    if (pullRef) {
      o.onProgress?.({ phase: 'pull', line: `Downloading ${pullRef}` });
      const pulled = await streamed(['pull', pullRef], 'pull', o);
      if (pulled.code === 0) return { ref: pullRef, source: 'pulled' };
      if (o.signal?.aborted) throw new Error('Cancelled');
      o.onProgress?.({ phase: 'pull', line: 'The download did not work. Building the image here instead.' });
    }
    const docker = opts.dockerFallback === undefined ? (resolveCliProgram({ env }) ? createDockerRuntime({ env, recipe, pin: null }) : null) : opts.dockerFallback;
    const dockerProgram = opts.dockerRunner === undefined ? resolveCliProgram({ env }) : opts.dockerRunner?.program ?? null;
    if (!docker || !dockerProgram) {
      throw new Error('Limn could not download the sandbox image, and building it here needs Docker (or Colima) as well. Try again later, or install Colima.');
    }
    o.onProgress?.({ phase: 'build', line: `Building ${recipe.localTag} with Docker (a few minutes, once)` });
    const built = await docker.ensureImage(o);
    o.onProgress?.({ phase: 'build', line: 'Copying the image into microsandbox' });
    const dockerCli = opts.dockerRunner ?? createCliRunner(dockerProgram, env);
    const save = dockerCli.spawn(['save', built.ref], o.signal ? { signal: o.signal } : {});
    const load = cli().spawn(['load', '--quiet', '--tag', recipe.localTag], { interactive: true, ...(o.signal ? { signal: o.signal } : {}) });
    let saveErr = '';
    const pump = (async () => {
      for await (const ev of save.events) {
        if (ev.type === 'stdout') load.write(ev.data);
        else if (ev.type === 'stderr') saveErr = (saveErr + ev.data.toString('utf8')).slice(-4_000);
      }
      load.end();
    })();
    const loaded = await collect(load);
    await pump;
    const saved = await save.done;
    if (saved.code !== 0 || loaded.code !== 0) {
      throw new Error(`Copying the sandbox image into microsandbox failed: ${lastLines(saved.code !== 0 ? saveErr : loaded.stderr) || 'no output'}`);
    }
    return { ref: recipe.localTag, source: 'built' };
  }

  function stopProxy(p: HostProxy): void {
    proxies.delete(resourceName(p.sessionId, 'proxy'));
    try {
      p.child.stdin?.end();
      p.child.kill('SIGTERM');
    } catch {
      /* gone */
    }
    rmSync(p.dir, { recursive: true, force: true });
  }

  async function startProxy(spec: ProxySpec): Promise<ContainerHandle> {
    const name = resourceName(spec.sessionId, 'proxy');
    const old = proxies.get(name);
    if (old) stopProxy(old);
    const dir = socketDirFor(socketRoot, instance, spec.sessionId);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const sockets = socketsIn(dir);
    let config: Record<string, unknown> = {};
    try {
      config = JSON.parse(spec.env[PROXY_CONFIG_ENV] ?? '{}') as Record<string, unknown>;
    } catch {
      throw new Error('The egress proxy configuration is not JSON.');
    }
    const controlToken = typeof config.controlToken === 'string' ? config.controlToken : '';
    const childEnv: Record<string, string> = {
      ...spec.env,
      [PROXY_CONFIG_ENV]: JSON.stringify({ ...config, sockets, exitOnStdinEnd: true }),
    };
    const child = spawnProxy(spec.source, childEnv, dir);
    const events = new EventQueue<ExecEvent>();
    const p: HostProxy = { sessionId: spec.sessionId, child, dir, sockets, controlToken, events, followed: false, exited: false };
    child.stdout?.on('data', (d: Buffer) => events.push({ type: 'stdout', data: d }));
    child.stderr?.on('data', (d: Buffer) => events.push({ type: 'stderr', data: d }));
    child.stdin?.on('error', () => undefined);
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (p.exited) return;
      p.exited = true;
      events.push({ type: 'exit', code, signal, timedOut: false });
      events.close();
    };
    child.on('error', (e) => {
      events.push({ type: 'stderr', data: Buffer.from(`egress proxy: ${e.message}\n`) });
      onExit(null, null);
    });
    child.on('close', onExit);
    proxies.set(name, p);
    return { name };
  }

  /** POST one control request over the proxy's control socket (0700 folder; token as well). */
  function proxyControl(proxy: string, path: '/rules' | '/credentials', body: unknown): Promise<boolean> {
    const p = proxies.get(proxy);
    if (!p || p.exited) return Promise.resolve(false);
    const payload = JSON.stringify(body);
    return new Promise((resolve) => {
      const req = http.request(
        { socketPath: p.sockets.control, method: 'POST', path, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), 'x-limn-control': p.controlToken }, timeout: 15_000 },
        (res) => {
          res.resume();
          res.on('end', () => resolve((res.statusCode ?? 500) < 300));
        },
      );
      req.on('error', () => resolve(false));
      req.on('timeout', () => req.destroy());
      req.end(payload);
    });
  }

  async function startSandbox(spec: Parameters<SandboxRuntime['startSandbox']>[0]): Promise<ContainerHandle> {
    const name = resourceName(spec.sessionId, 'sandbox');
    const proxy = proxies.get(resourceName(spec.sessionId, 'proxy'));
    if (!proxy || proxy.exited) throw new Error('The egress proxy must be running before the sandbox starts.');
    await must(msbCreateArgs(spec, name, labelsFor(spec, 'sandbox'), proxy.sockets), 'Starting the sandbox', { timeoutMs: CREATE_TIMEOUT });
    pidCaps.set(spec.sessionId, spec.resources.pids);
    const fail = async (what: string, r: ExecResult): Promise<never> => {
      await run(['rm', '--force', '--quiet', name], { timeoutMs: 120_000 });
      pidCaps.delete(spec.sessionId);
      throw new Error(`${what} failed: ${lastLines(r.stderr) || `exit ${r.code}`}`);
    };
    // The one root step: `limn-proxy` → the guest relay, and the private disks made the agent's.
    const disks = spec.mounts.filter((m) => m.kind === 'volume').map((m) => m.target);
    const setup = await run(msbExecArgs(name, ['sh', '-c', guestSetupScript(), 'sh', ...disks], { user: 'root', stdin: false }), { timeoutMs: 60_000 });
    if (setup.code !== 0) await fail('Preparing the sandbox', setup);
    const relay = await run(msbExecArgs(name, ['python3', '-c', GUEST_RELAY], { user: SANDBOX_USER, stdin: false, detach: true }), { timeoutMs: 60_000 });
    if (relay.code !== 0) await fail('Starting the sandbox’s way to the proxy', relay);
    const deadline = Date.now() + (opts.relayTimeoutMs ?? 20_000);
    let probe: ExecResult | null = null;
    while (Date.now() < deadline) {
      probe = await run(msbExecArgs(name, ['python3', '-c', GUEST_RELAY_PROBE], { stdin: false }), { timeoutMs: 15_000 });
      if (probe.code === 0) return { name };
      await new Promise((r) => setTimeout(r, 500));
    }
    return fail('Reaching the proxy from the sandbox', probe ?? { code: null, stdout: Buffer.alloc(0), stderr: 'no answer', timedOut: true });
  }

  function proxyHandle(p: HostProxy): ExecHandle {
    // The proxy's log stream (one consumer, like `docker logs -f`). `done` settles when it exits.
    if (p.followed) throw new Error('The egress proxy log is already being followed.');
    p.followed = true;
    const done = new Promise<{ code: number | null; signal: string | null; timedOut: boolean }>((resolve) => {
      if (p.exited) resolve({ code: p.child.exitCode, signal: null, timedOut: false });
      else p.child.once('close', (code, signal) => resolve({ code, signal, timedOut: false }));
    });
    return { events: p.events, write: () => undefined, end: () => undefined, kill: () => stopProxy(p), done };
  }

  const runtime: SandboxRuntime = {
    kind: 'microsandbox',
    detect,
    ensureImage,

    // No network to make: the VM has none (`--no-net`). The name is kept for the callers' records.
    async createNetwork(owner) {
      return { name: resourceName(owner.sessionId, 'net') };
    },

    // The VM's private disk (`--mount-owned`), created with the VM and removed with it.
    async createVolume(owner, key) {
      return resourceName(owner.sessionId, `vol-${key}`);
    },

    startProxy,
    proxyControl,
    startSandbox,

    exec(container: string, argv: string[], o: ExecOptions = {}): ExecHandle {
      if (sessionOfName(container)) throw new Error('The egress proxy is a host process on microsandbox: use proxyControl.');
      const stdin = o.input !== undefined || o.interactive === true;
      const session = /^limn-(.+)-sandbox$/.exec(container)?.[1];
      const pids = session ? pidCaps.get(session) : undefined;
      const args = msbExecArgs(container, argv, {
        stdin,
        ...(o.user ? { user: o.user } : {}),
        ...(o.cwd ? { cwd: o.cwd } : {}),
        ...(o.env ? { env: o.env } : {}),
        ...(pids ? { pids } : {}),
      });
      return cli().spawn(args, {
        ...(o.input !== undefined ? { input: o.input } : {}),
        ...(o.interactive ? { interactive: true } : {}),
        ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}),
        ...(o.signal ? { signal: o.signal } : {}),
      });
    },

    run(container, argv, o = {}) {
      return collect(runtime.exec(container, argv, { timeoutMs: 120_000, ...o }));
    },

    async copyIn(container, files, o = {}) {
      if (files.length === 0) return;
      const r = await runtime.run(container, ['tar', '-x', '-m', '-f', '-', '-C', '/'], { input: tarFiles(files), user: o.user ?? SANDBOX_USER, timeoutMs: 120_000 });
      if (r.code !== 0) throw new Error(`Copying files into the sandbox failed: ${lastLines(r.stderr)}`);
    },

    async readFile(container, path, o = {}) {
      const max = o.maxBytes ?? 8 << 20;
      const r = await runtime.run(container, ['sh', '-c', '[ -f "$1" ] || exit 44; exec head -c "$2" -- "$1"', 'sh', path, String(max + 1)], { timeoutMs: 60_000 });
      if (r.code === 44) return null;
      if (r.code !== 0) throw new Error(`Reading ${path} from the sandbox failed: ${lastLines(r.stderr)}`);
      if (r.stdout.length > max) throw new Error(`${path} is larger than ${max} bytes`);
      return r.stdout;
    },

    followLogs(container, o = {}) {
      const p = proxies.get(container);
      if (p) return proxyHandle(p);
      return cli().spawn(['logs', '--follow', container], o.signal ? { signal: o.signal } : {});
    },

    // The proxy sees unix-socket peers, not addresses: every row is the session's one VM.
    async networkMembers() {
      return new Map<string, string>();
    },

    async compose() {
      return { code: 1, stdout: Buffer.alloc(0), stderr: SERVICES_NOT_ON_MICROSANDBOX, timedOut: false };
    },

    async buildImage() {
      return { code: 1, stdout: Buffer.alloc(0), stderr: SERVICES_NOT_ON_MICROSANDBOX, timedOut: false };
    },

    async stats(sessionId) {
      const listed = await listManaged();
      const mine = listed.filter((s) => s.labels[LABEL_SESSION] === sessionId);
      const out = [];
      for (const s of mine) {
        const r = await run(['metrics', s.name, '--format', 'json'], { timeoutMs: LIST_TIMEOUT });
        if (r.code === 0) out.push(...parseMsbMetrics(String(r.stdout), (n) => mine.find((m) => m.name === n)?.labels[LABEL_ROLE] ?? null));
      }
      return out;
    },

    async destroy(sessionId) {
      return removeWhere((session) => session === sessionId, false);
    },

    async sweep(liveSessionIds, o = {}) {
      const live = new Set(liveSessionIds);
      return removeWhere((session) => !live.has(session), o.dryRun === true);
    },
  };

  async function listManaged(): Promise<ReturnType<typeof parseMsbList>> {
    const r = await run(['ls', '--label', `${LABEL_MANAGED}=${instance}`, '--format', 'json']);
    if (r.code !== 0) throw new Error(`Listing microsandbox sandboxes failed: ${lastLines(r.stderr, 2)}`);
    // `--label` already filters; checked again here so a CLI that ignored it can never widen a sweep.
    return parseMsbList(String(r.stdout)).filter((s) => s.labels[LABEL_MANAGED] === instance);
  }

  async function removeWhere(doomed: (session: string) => boolean, dryRun: boolean): Promise<SweepResult> {
    const result: SweepResult = { containers: [], networks: [], volumes: [], images: [], errors: [] };
    // Host proxies of this process first: they are what keeps a VM's way out open.
    for (const p of [...proxies.values()]) {
      if (!doomed(p.sessionId)) continue;
      result.containers.push(resourceName(p.sessionId, 'proxy'));
      if (!dryRun) stopProxy(p);
    }
    if (runner) {
      let listed: ReturnType<typeof parseMsbList> = [];
      try {
        listed = await listManaged();
      } catch (e) {
        result.errors.push(e instanceof Error ? e.message : String(e));
      }
      for (const s of listed) {
        const session = s.labels[LABEL_SESSION] ?? '';
        if (!doomed(session)) continue;
        if (dryRun) {
          result.containers.push(s.name);
          continue;
        }
        const r = await run(['rm', '--force', '--quiet', s.name], { timeoutMs: 120_000 });
        if (r.code !== 0) result.errors.push(`${s.name}: ${lastLines(r.stderr, 2)}`);
        else {
          result.containers.push(s.name);
          pidCaps.delete(session);
        }
      }
    }
    // Socket folders a crashed Limn left (no live proxy of ours uses them).
    if (!dryRun && existsSync(socketRoot)) {
      const inUse = new Set([...proxies.values()].map((p) => p.dir));
      for (const d of readdirSync(socketRoot)) {
        const full = join(socketRoot, d);
        if (/^[0-9a-f]{12}$/.test(d) && !inUse.has(full)) rmSync(full, { recursive: true, force: true });
      }
    }
    return result;
  }

  return runtime;
}
