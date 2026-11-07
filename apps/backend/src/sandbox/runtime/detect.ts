// WHAT IS SERVING THE DOCKER API (docs/SANDBOX.md § Setting up a runtime). Pure parsing of
// `docker info --format json` (Docker Engine, Docker Desktop, Colima, Rancher Desktop, OrbStack) and
// of Podman's own `info` shape (which `podman info --format json`, and the `podman-docker` shim's
// `docker info`, both print). The adapter feeds it the CLI's output; tests feed it recorded output.
import type { RuntimeDetection, RuntimeFlavour } from './types.js';

export const DOCKER_DESKTOP_LICENCE =
  'Docker Desktop is free only for organisations under 250 employees and under US$10M a year in revenue. Colima and Podman are free for everyone.';
export const ORBSTACK_LICENCE = 'OrbStack needs a paid licence for commercial use. Colima and Podman are free for everyone.';

type Json = Record<string, unknown>;

function obj(v: unknown): Json | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export interface ParsedInfo {
  serverVersion: string | null;
  os: string | null;
  arch: string | null;
  memoryBytes: number | null;
  cpus: number | null;
  rootless: boolean | null;
  flavour: RuntimeFlavour;
}

/** Parse one `info --format json` document (Docker's or Podman's shape). Null when it is neither. */
export function parseInfo(text: string, opts: { cliName?: string; context?: string | null } = {}): ParsedInfo | null {
  let doc: Json | null;
  try {
    doc = obj(JSON.parse(text));
  } catch {
    return null;
  }
  if (!doc) return null;

  // Podman: { host: { arch, os, memTotal, cpus, security: { rootless } }, version: { Version } }
  const host = obj(doc.host);
  if (host) {
    const security = obj(host.security);
    return {
      serverVersion: str(obj(doc.version)?.Version),
      os: str(host.os),
      arch: str(host.arch),
      memoryBytes: num(host.memTotal),
      cpus: num(host.cpus),
      rootless: typeof security?.rootless === 'boolean' ? security.rootless : null,
      flavour: 'podman',
    };
  }

  if (!('ServerVersion' in doc) && !('OperatingSystem' in doc)) return null;
  const operatingSystem = str(doc.OperatingSystem) ?? '';
  const name = str(doc.Name) ?? '';
  const context = opts.context ?? '';
  const securityOptions = Array.isArray(doc.SecurityOptions) ? doc.SecurityOptions.map(String) : [];
  let flavour: RuntimeFlavour = 'docker-engine';
  if (/docker desktop/i.test(operatingSystem)) flavour = 'docker-desktop';
  else if (/orbstack/i.test(operatingSystem) || /orbstack/i.test(context)) flavour = 'orbstack';
  else if (/rancher/i.test(operatingSystem) || /rancher-desktop/i.test(name) || /rancher-desktop/i.test(context)) flavour = 'rancher-desktop';
  else if (/colima/i.test(name) || /colima/i.test(context)) flavour = 'colima';
  else if (/podman/i.test(opts.cliName ?? '') || /podman/i.test(operatingSystem)) flavour = 'podman';
  return {
    serverVersion: str(doc.ServerVersion),
    os: str(doc.OSType),
    arch: str(doc.Architecture),
    memoryBytes: num(doc.MemTotal),
    cpus: num(doc.NCPU),
    rootless: securityOptions.some((o) => /name=rootless/.test(o)),
    flavour,
  };
}

export function licenceNoteFor(flavour: RuntimeFlavour): string | null {
  if (flavour === 'docker-desktop') return DOCKER_DESKTOP_LICENCE;
  if (flavour === 'orbstack') return ORBSTACK_LICENCE;
  return null;
}

/** The default network a container reaches the internet through. */
export function bridgeNetworkFor(flavour: RuntimeFlavour): string {
  return flavour === 'podman' ? 'podman' : 'bridge';
}

/** One plain line for a CLI that answered `info` with an error. */
export function daemonProblem(stderr: string, cliName: string): string {
  if (/permission denied/i.test(stderr)) {
    return `${cliName} is installed, but Limn may not use it. On Linux, add your user to the docker group, or use Podman rootless.`;
  }
  return `${cliName} is installed but not running. Start Docker Desktop, Colima, Podman or your Docker service.`;
}

export function notInstalled(cliName: string): RuntimeDetection {
  return {
    kind: 'docker',
    available: false,
    cli: null,
    cliVersion: null,
    daemonReachable: false,
    serverVersion: null,
    os: null,
    arch: null,
    memoryBytes: null,
    cpus: null,
    rootless: null,
    flavour: 'unknown',
    licenceNote: null,
    problem: `No container runtime found (${cliName} is not on the PATH). See “How to set up” for a free one.`,
  };
}
