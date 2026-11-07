// SERVICES ON MICROSANDBOX (docs/SANDBOX.md § Services; plan WP6, WP9). ⚠ CODE ONLY: NOT RUN. No
// machine this was written on can run microsandbox (it needs Apple Silicon, Linux with KVM, or Windows
// with WHP). WP9's adapter calls this; its first real run is the test.
//
// On microsandbox the sandbox is a VM with its own kernel, so Docker runs INSIDE it (the `docker:dind`
// pattern on a flat root disk) and the agent runs `docker compose` itself. Limn still applies THE SAME
// POLICY to the files the reader picked (defence in depth: the VM is the boundary, the policy keeps
// the reader's choice honest), and writes the policed model beside them for the agent to use:
//
//   /limn/services/<key>.compose.json    the policed, runnable model of one picked file
//
// Binds stay binds here (`bindMode: 'bind'`): the files are in the VM, beside the daemon.
import { posix } from 'node:path';
import type { SandboxRuntime, SessionOwner } from '../runtime/types.js';
import { SANDBOX_COMPOSE, type ServiceStackConfig } from './controller.js';
import { DEFAULT_ALLOWED_REGISTRIES, DEFAULT_SERVICE_LIMITS, policeCompose, type PolicyResult, type ServiceLimits } from './policy.js';

export const DIND_SERVICES_DIR = '/limn/services';
/** The network the agent's services join inside the VM. */
export const DIND_NETWORK = 'limn-services';

/** Start dockerd as root inside the VM (the one root step), then wait for it to answer. */
export async function startDindDaemon(runtime: SandboxRuntime, container: string, opts: { timeoutMs?: number } = {}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const started = await runtime.run(
    container,
    ['sh', '-c', 'mkdir -p /var/lib/docker /var/log && (dockerd --host=unix:///var/run/docker.sock --data-root=/var/lib/docker --group=agent >/var/log/dockerd.log 2>&1 &)'],
    { user: 'root', timeoutMs: 30_000 },
  );
  if (started.code !== 0) return { ok: false, reason: `Docker did not start in the sandbox: ${started.stderr.trim().split('\n').pop() ?? ''}` };
  const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
  while (Date.now() < deadline) {
    const r = await runtime.run(container, ['docker', 'info', '--format', '{{.ServerVersion}}'], { timeoutMs: 10_000 });
    if (r.code === 0) {
      await runtime.run(container, ['docker', 'network', 'create', DIND_NETWORK], { timeoutMs: 20_000 });
      return { ok: true };
    }
    await new Promise((res) => setTimeout(res, 1_000));
  }
  return { ok: false, reason: 'Docker in the sandbox did not answer within a minute.' };
}

export interface DindStackResult {
  key: string;
  from: string;
  result: PolicyResult;
  /** Where the policed model was written, when allowed. */
  path: string | null;
}

/** Police every picked file and write the runnable models into the VM. */
export async function prepareDindServices(o: {
  runtime: SandboxRuntime;
  owner: SessionOwner;
  container: string;
  workspaceRoot: string;
  stacks: readonly ServiceStackConfig[];
  limits?: ServiceLimits;
  allowedRegistries?: readonly string[];
  proxyUrl: string;
}): Promise<DindStackResult[]> {
  const out: DindStackResult[] = [];
  for (const st of o.stacks) {
    const file = posix.join(st.repoPath, st.file);
    const dir = posix.dirname(file);
    const n = await o.runtime.run(o.container, [SANDBOX_COMPOSE, '--project-directory', dir, '--file', file, 'config', '--format', 'json'], { cwd: dir, timeoutMs: 60_000 });
    let model: unknown = null;
    try {
      model = n.code === 0 ? (JSON.parse(n.stdout.toString('utf8')) as unknown) : null;
    } catch {
      model = null;
    }
    const result: PolicyResult =
      model == null
        ? { ok: false, reasons: [`${st.from} could not be read.`] }
        : policeCompose(model, {
            project: `limn-${st.key}`,
            network: DIND_NETWORK,
            workspaceRoot: o.workspaceRoot,
            workspaceVolume: '',
            bindMode: 'bind',
            serviceLabels: { 'limn.session': o.owner.sessionId },
            volumeLabels: { 'limn.session': o.owner.sessionId },
            builtImages: new Map(),
            plannedTag: (svc) => `limn-${st.key}-${svc.toLowerCase()}:dev`,
            egressServices: new Set(st.egress),
            proxyUrl: o.proxyUrl,
            limits: o.limits ?? DEFAULT_SERVICE_LIMITS,
            allowedRegistries: o.allowedRegistries ?? DEFAULT_ALLOWED_REGISTRIES,
          });
    let path: string | null = null;
    if (result.ok) {
      path = `${DIND_SERVICES_DIR}/${st.key}.compose.json`;
      // A `build:` section stays a build here: the daemon is beside the code, so `docker compose up
      // --build` builds the agent's edits directly.
      const services = result.stack.model.services as Record<string, Record<string, unknown>>;
      for (const svc of result.stack.services) {
        const m = services[svc.name];
        if (!svc.build || !m) continue;
        m.build = { context: svc.build.context, dockerfile: svc.build.dockerfile, ...(svc.build.target ? { target: svc.build.target } : {}), args: svc.build.args };
        delete m.pull_policy;
      }
      await o.runtime.copyIn(o.container, [{ path, content: `${JSON.stringify(result.stack.model, null, 2)}\n` }]);
    }
    out.push({ key: st.key, from: st.from, result, path });
  }
  return out;
}
