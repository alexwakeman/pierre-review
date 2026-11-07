// THE CONTAINER ARGV, BUILT IN ONE PLACE (docs/SANDBOX.md § The sandbox container). Pure functions, so
// the hardening every sandbox gets is pinned by a test, not by reading `docker.ts`:
//
//   non-root (the image's `agent`), `--cap-drop ALL`, `--security-opt no-new-privileges`, `--init`,
//   `--pids-limit`, `--cpus`, `--memory` (+ the same swap cap), ONLY the session's internal network,
//   bind mounts READ-ONLY, writable storage on named volumes, Limn's labels.
//
// ⚠ No caller passes raw `docker run` flags. A new need is a new typed field here, with its test.
import { isAbsolute, normalize } from 'node:path';
import { labelArgs } from './labels.js';
import type { ComposeVerb, ImageBuildSpec, Mount, ProxySpec, SandboxResources, SandboxSpec } from './types.js';

/** The image's non-root user (apps/backend/sandbox-image/Dockerfile). */
export const SANDBOX_USER = 'agent';

/** Paths that must never be mounted into a sandbox, even read-only. */
const FORBIDDEN_SOURCE =
  /(?:^|\/)(?:docker|podman)\.sock$|(?:^|\/)\.(?:docker|ssh|gnupg)(?:\/|$)|(?:^|\/)\.config\/gh(?:\/|$)|^(?:\/private)?\/var\/run(?:\/|$)|^\/run(?:\/|$)|^\/proc(?:\/|$)|^\/sys(?:\/|$)|^\/dev(?:\/|$)/;

export function assertMountable(m: Mount): void {
  // `--mount` is CSV: a comma or a quote would start another field (`readonly=false`).
  if (!isAbsolute(m.target) || /[,"\n\0]/.test(m.target)) {
    throw new Error(`Sandbox mount target must be an absolute path without commas: ${JSON.stringify(m.target)}`);
  }
  if (m.kind === 'volume') {
    if (!/^[a-z0-9][a-z0-9_.-]*$/.test(m.name)) throw new Error(`Not a valid volume name: ${JSON.stringify(m.name)}`);
    return;
  }
  const src = normalize(m.source);
  if (!isAbsolute(src) || /[,"\n\0]/.test(src)) {
    throw new Error(`Sandbox bind source must be an absolute path without commas: ${JSON.stringify(m.source)}`);
  }
  if (src === '/' || FORBIDDEN_SOURCE.test(src)) {
    throw new Error(`Refusing to mount ${src} into a sandbox`);
  }
}

/** `--mount` for one mount. A bind is ALWAYS `readonly`; there is no other spelling. */
export function mountArgs(m: Mount): string[] {
  assertMountable(m);
  if (m.kind === 'bind') return ['--mount', `type=bind,src=${normalize(m.source)},dst=${m.target},readonly`];
  // `volume-nocopy`: an EMPTY volume would otherwise take the mount point's ownership (root, when
  // the path is also the workdir) and undo the CHOWN step — measured on Docker 29.
  return ['--mount', `type=volume,src=${m.name},dst=${m.target},volume-nocopy`];
}

export function resourceArgs(r: SandboxResources): string[] {
  if (!(r.cpus > 0) || !(r.memoryBytes >= 256 * 1024 ** 2) || !(r.pids >= 64)) {
    throw new Error('Sandbox resources out of range');
  }
  const mem = String(Math.floor(r.memoryBytes));
  // Swap capped at the memory limit: no silent overcommit onto the host's disk.
  return ['--cpus', String(r.cpus), '--memory', mem, '--memory-swap', mem, '--pids-limit', String(Math.floor(r.pids))];
}

export function envArgs(env: Record<string, string>): string[] {
  return Object.entries(env).flatMap(([k, v]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`Not a valid environment variable name: ${k}`);
    if (v.includes('\0')) throw new Error(`Environment value for ${k} contains a NUL byte`);
    return ['--env', `${k}=${v}`];
  });
}

/** The hardening every Limn container gets (sandbox and proxy alike). */
export const HARDENING = ['--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--init'] as const;

export function sandboxRunArgs(spec: SandboxSpec, name: string, labels: Record<string, string>): string[] {
  if (!isAbsolute(spec.workdir)) throw new Error('Sandbox workdir must be absolute');
  return [
    'run', '--detach', '--name', name, '--hostname', 'sandbox',
    ...labelArgs(labels),
    '--network', spec.network,
    '--user', SANDBOX_USER,
    ...HARDENING,
    ...resourceArgs(spec.resources),
    ...spec.mounts.flatMap(mountArgs),
    ...envArgs(spec.env),
    '--workdir', spec.workdir,
    spec.image,
    'sleep', 'infinity',
  ];
}

/** Small and read-only: the proxy needs no disk and little memory. */
export const PROXY_RESOURCES: SandboxResources = { cpus: 1, memoryBytes: 256 * 1024 ** 2, pids: 256, diskBytes: 0 };

/**
 * The proxy starts on the runtime's default bridge (its way out); `docker.ts` then connects it to the
 * session's internal network under `spec.alias`. Read-only root, a small /tmp, non-root.
 */
export function proxyRunArgs(spec: ProxySpec, name: string, labels: Record<string, string>, bridge: string): string[] {
  return [
    'run', '--detach', '--name', name, '--hostname', 'limn-proxy',
    ...labelArgs(labels),
    '--network', bridge,
    '--user', SANDBOX_USER,
    ...HARDENING,
    ...resourceArgs(PROXY_RESOURCES),
    '--read-only', '--tmpfs', '/tmp:rw,size=16m',
    ...envArgs(spec.env),
    spec.image,
    'node', '--input-type=module', '-e', spec.source,
  ];
}

/** The one-off root step that makes a fresh volume the agent's: CHOWN only, never held by the agent. */
export function volumeChownArgs(image: string, volume: string, labels: Record<string, string>): string[] {
  return [
    'run', '--rm', ...labelArgs(labels),
    '--network', 'none',
    '--user', 'root',
    '--cap-drop', 'ALL', '--cap-add', 'CHOWN',
    '--security-opt', 'no-new-privileges',
    '--mount', `type=volume,src=${volume},dst=/v`,
    image,
    'chown', `${SANDBOX_USER}:${SANDBOX_USER}`, '/v',
  ];
}

// ── Services (sandbox/services/) ────────────────────────────────────────────────────────────────

const SERVICE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;
const PROJECT_NAME = /^[a-z0-9][a-z0-9_-]{0,127}$/;

/**
 * `docker compose` argv for one typed verb. The model always comes on STDIN (`--file -`) and the
 * project directory is an EMPTY folder Limn made, so no `compose.yaml` or `.env` in Limn's own working
 * folder is ever read (the model is already interpolated: `docker compose config` wrote `$$` for `$`).
 */
export function composeArgs(project: string, call: ComposeVerb, projectDir: string): string[] {
  if (!PROJECT_NAME.test(project)) throw new Error(`Not a valid compose project name: ${JSON.stringify(project)}`);
  const svc = (s: string): string => {
    if (!SERVICE_NAME.test(s)) throw new Error(`Not a valid service name: ${JSON.stringify(s)}`);
    return s;
  };
  const base = ['compose', '--ansi', 'never', '--progress', 'plain', '--project-name', project, '--project-directory', projectDir, '--file', '-'];
  switch (call.verb) {
    case 'up':
      return [...base, 'up', '--detach', '--wait', '--wait-timeout', '300', '--pull', 'missing', '--no-build', ...(call.services ?? []).map(svc)];
    case 'down':
      return [...base, 'down', '--volumes', '--remove-orphans', '--timeout', '10'];
    case 'ps':
      return [...base, 'ps', '--all', '--format', 'json'];
    case 'logs':
      return [...base, 'logs', '--no-color', '--tail', String(Math.max(1, Math.min(2000, Math.floor(call.tail)))), svc(call.service)];
    case 'run':
      if (call.command.some((a) => a.includes('\0'))) throw new Error('A command argument contains a NUL byte');
      return [...base, 'run', '--rm', '--no-TTY', '--quiet-pull', svc(call.service), ...call.command];
  }
}

/** The proxy build args every service build gets (Docker's predefined ARGs: never kept in the image). */
export function proxyBuildArgs(proxyUrl: string): Record<string, string> {
  const no = 'localhost,127.0.0.1';
  return { HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, http_proxy: proxyUrl, https_proxy: proxyUrl, NO_PROXY: no, no_proxy: no };
}

/**
 * `docker build` for a service image, the context as a TAR on stdin. Run with `DOCKER_BUILDKIT=0`: the
 * classic builder is the one that runs each step on a USER-DEFINED network, so the steps reach only
 * the session's proxy (BuildKit takes `default`, `host` or `none` only). `--force-rm` removes the step
 * containers even when a step fails. Base images are pulled by the host daemon (docs/SANDBOX.md § Services).
 */
export function serviceBuildArgv(spec: ImageBuildSpec, labels: Record<string, string>): string[] {
  if (!/^limn-[a-z0-9][a-z0-9_.-]*:[a-z0-9_.-]+$/.test(spec.tag)) throw new Error(`Not a Limn service image tag: ${JSON.stringify(spec.tag)}`);
  if (!spec.dockerfile || spec.dockerfile.startsWith('/') || spec.dockerfile.split('/').includes('..')) {
    throw new Error(`The Dockerfile must be a path inside the build folder: ${JSON.stringify(spec.dockerfile)}`);
  }
  if (spec.target !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(spec.target)) throw new Error(`Not a valid build target: ${JSON.stringify(spec.target)}`);
  const args = { ...(spec.buildArgs ?? {}), ...proxyBuildArgs(spec.proxyUrl) };
  return [
    'build', '--rm', '--force-rm',
    '--network', spec.network,
    '--memory', String(Math.floor(spec.memoryBytes)),
    '--tag', spec.tag,
    '--file', spec.dockerfile,
    ...(spec.target ? ['--target', spec.target] : []),
    ...labelArgs(labels),
    ...Object.entries(args).flatMap(([k, v]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`Not a valid build arg name: ${k}`);
      return ['--build-arg', `${k}=${v}`];
    }),
    '-',
  ];
}
