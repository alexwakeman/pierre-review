// THE RUNTIME IN USE (docs/SANDBOX.md § The runtime layer, § microsandbox). The ONE place the backend
// is chosen. Tests swap in the fake.
//
//   SANDBOX_RUNTIME=docker         Docker (or Podman via `SANDBOX_CLI`), always.
//   SANDBOX_RUNTIME=microsandbox   microsandbox, always (its detection says what is missing).
//   unset / auto                   microsandbox when it is installed AND healthy (`msb doctor`), else
//                                  Docker. Decided on the first detection that finds either one
//                                  available, then FIXED for the process: a live session never changes
//                                  backend under its feet.
import { createDockerRuntime, resolveCliProgram } from './docker.js';
import { createMicrosandboxRuntime, resolveMsbProgram } from './microsandbox.js';
import type { RuntimeDetection, RuntimeKind, SandboxRuntime, SweepResult } from './types.js';

export type RuntimeChoice = 'auto' | 'docker' | 'microsandbox';

export function runtimeChoiceOf(env: NodeJS.ProcessEnv = process.env): RuntimeChoice {
  const v = env.SANDBOX_RUNTIME?.trim().toLowerCase();
  if (v === 'docker' || v === 'podman') return 'docker';
  if (v === 'microsandbox' || v === 'msb') return 'microsandbox';
  return 'auto';
}

/**
 * The auto choice as a runtime: `detect()` picks (microsandbox first, when healthy) and every other
 * call goes to the pick. Before a pick, calls go to Docker (the backend that existed first).
 */
export function createAutoRuntime(o: { docker: SandboxRuntime; microsandbox: SandboxRuntime | null }): SandboxRuntime & { readonly picked: RuntimeKind | null } {
  let picked: SandboxRuntime | null = null;
  const target = (): SandboxRuntime => picked ?? o.docker;
  const r: SandboxRuntime & { readonly picked: RuntimeKind | null } = {
    get kind() {
      return target().kind;
    },
    get picked() {
      return picked?.kind ?? null;
    },
    async detect(): Promise<RuntimeDetection> {
      if (picked) return picked.detect();
      if (o.microsandbox) {
        const m = await o.microsandbox.detect();
        if (m.available) {
          picked = o.microsandbox;
          return m;
        }
      }
      const d = await o.docker.detect();
      if (d.available) picked = o.docker;
      return d;
    },
    ensureImage: (x) => target().ensureImage(x),
    createNetwork: (x) => target().createNetwork(x),
    createVolume: (x, k) => target().createVolume(x, k),
    startProxy: (x) => target().startProxy(x),
    startSandbox: (x) => target().startSandbox(x),
    exec: (c, a, x) => target().exec(c, a, x),
    run: (c, a, x) => target().run(c, a, x),
    copyIn: (c, f, x) => target().copyIn(c, f, x),
    readFile: (c, p, x) => target().readFile(c, p, x),
    followLogs: (c, x) => target().followLogs(c, x),
    networkMembers: (n) => target().networkMembers(n),
    compose: (c) => target().compose(c),
    buildImage: (s) => target().buildImage(s),
    stats: (s) => target().stats(s),
    destroy: (s) => target().destroy(s),
    sweep: (live, x) => target().sweep(live, x),
  };
  // Only a runtime whose proxy is not a container has it (egress.ts checks for the method).
  Object.defineProperty(r, 'proxyControl', {
    enumerable: true,
    get: () => (picked?.proxyControl ? picked.proxyControl.bind(picked) : undefined),
  });
  return r;
}

let current: SandboxRuntime | null = null;

export function sandboxRuntime(env: NodeJS.ProcessEnv = process.env): SandboxRuntime {
  if (current) return current;
  const choice = runtimeChoiceOf(env);
  if (choice === 'docker') current = createDockerRuntime({ env });
  else if (choice === 'microsandbox') current = createMicrosandboxRuntime({ env });
  else current = createAutoRuntime({ docker: createDockerRuntime({ env }), microsandbox: resolveMsbProgram({ env }) ? createMicrosandboxRuntime({ env }) : null });
  return current;
}

/** Test seam: the runtime every caller gets (null restores the real choice). */
export function setSandboxRuntimeForTests(r: SandboxRuntime | null): void {
  current = r;
}

function mergeSweeps(a: SweepResult, b: SweepResult): SweepResult {
  return {
    containers: [...a.containers, ...b.containers],
    networks: [...a.networks, ...b.networks],
    volumes: [...a.volumes, ...b.volumes],
    images: [...a.images, ...b.images],
    errors: [...a.errors, ...b.errors],
  };
}

/**
 * Sweep EVERY installed backend, whichever one sessions use: a reader who switched backends still has
 * the other one's leftovers. Each backend is swept only when its CLI is there and it answers. Null
 * when neither did.
 */
export async function sweepAllBackends(
  liveSessionIds: Iterable<string>,
  opts: { dryRun?: boolean; env?: NodeJS.ProcessEnv; backends?: SandboxRuntime[] } = {},
): Promise<{ result: SweepResult; swept: RuntimeKind[]; problems: string[] } | null> {
  const env = opts.env ?? process.env;
  const live = [...liveSessionIds];
  const backends =
    opts.backends ??
    [
      ...(resolveCliProgram({ env }) ? [createDockerRuntime({ env })] : []),
      ...(resolveMsbProgram({ env }) ? [createMicrosandboxRuntime({ env })] : []),
    ];
  let result: SweepResult = { containers: [], networks: [], volumes: [], images: [], errors: [] };
  const swept: RuntimeKind[] = [];
  const problems: string[] = [];
  for (const b of backends) {
    const d = await b.detect();
    if (!d.daemonReachable) {
      if (d.problem) problems.push(d.problem);
      continue;
    }
    result = mergeSweeps(result, await b.sweep(live, opts.dryRun ? { dryRun: true } : {}));
    swept.push(b.kind);
  }
  return swept.length === 0 ? (problems.length ? { result, swept, problems } : null) : { result, swept, problems };
}

/**
 * THE BOOT SWEEP: remove every labelled sandbox resource whose session is not live. Background,
 * after listen, NEVER fatal, and free when no container CLI is installed (no process is started).
 * At boot no session is live (the session manager's restart reconcile marks them failed), so the
 * default is to remove them all. Every installed backend is swept.
 */
export function sweepSandboxesAtBoot(
  opts: { liveSessionIds?: Iterable<string>; runtime?: SandboxRuntime; env?: NodeJS.ProcessEnv } = {},
): Promise<SweepResult | null> {
  const run = async (): Promise<SweepResult | null> => {
    const env = opts.env ?? process.env;
    if (opts.runtime) {
      const detected = await opts.runtime.detect();
      if (!detected.daemonReachable) return null;
      return opts.runtime.sweep(opts.liveSessionIds ?? []);
    }
    const all = await sweepAllBackends(opts.liveSessionIds ?? [], { env });
    return all && all.swept.length > 0 ? all.result : null;
  };
  const p = run();
  bootSweep = p;
  return p;
}

let bootSweep: Promise<unknown> = Promise.resolve();

/**
 * Resolves once the boot sweep (if one started) has finished, whatever its result. ⚠ The session
 * manager waits on it before it creates anything: a session booted while the sweep ran would have its
 * fresh resources removed as "not live".
 */
export function bootSweepSettled(): Promise<void> {
  return bootSweep.then(
    () => undefined,
    () => undefined,
  );
}

export type * from './types.js';
