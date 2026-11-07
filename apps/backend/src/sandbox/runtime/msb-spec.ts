// THE MICROSANDBOX ARGV AND PARSERS, BUILT IN ONE PLACE (docs/SANDBOX.md § microsandbox). Pure
// functions, so what every microVM gets is pinned by a test (msb-spec.test.ts), not by reading
// microsandbox.ts. ⚠ UNTESTED AGAINST A REAL `msb`: written from docs.microsandbox.dev (read
// 2026-11-07) on a machine that cannot run it. Every output parser is TOLERANT (several plausible
// shapes, never a throw) because only a real run shows the exact JSON.
//
// What a session's VM gets (the Docker spec.ts equivalents in brackets):
//   • `--no-net`: NO network device policy that lets anything out [`--network <internal>`]. The VM
//     reaches Limn's egress proxy ONLY over three vsock routes to unix sockets on the host, so there
//     is no route to the host's TCP ports, the LAN or the internet at all.
//   • bind mounts READ-ONLY and `noexec` [`readonly`]; writable storage is a private disk removed with
//     the VM (`--mount-owned …:kind=disk,size=…`) [a named volume] — so the disk cap IS enforced here.
//   • `-c`/`-m` caps [`--cpus`/`--memory`]; processes capped per agent command (`--rlimit nproc=`).
//   • the agent runs as the image's non-root `agent` (`-u agent` on every exec); root is used only for
//     the setup step (hosts entry, disk ownership). The VM's own kernel is the boundary, so there is no
//     capability or seccomp setting to make.
import { isAbsolute, normalize } from 'node:path';
import { assertMountable, SANDBOX_USER } from './spec.js';
import type { ContainerStats, Mount, SandboxResources, SandboxSpec } from './types.js';

/** The vsock port the guest relay connects to for each proxy listener (any free number works). */
export const VSOCK_PORTS = { forward: 3128, anthropic: 8081, chatgpt: 8082 } as const;

/** The host sockets a session's proxy listens on. `control` is NEVER routed into the VM. */
export interface HostProxySockets {
  forward: string;
  anthropic: string;
  chatgpt: string;
  control: string;
}

/** A unix socket path must fit `sun_path` (104 bytes on macOS, 108 on Linux). */
export const MAX_SOCKET_PATH = 100;

/** `8G` / `512M`: msb's size spelling, rounded DOWN to whole MiB (never more than the reader allowed). */
export function msbSize(bytes: number): string {
  const mib = Math.floor(bytes / 1024 ** 2);
  if (!(mib >= 1)) throw new Error('Size out of range');
  return mib % 1024 === 0 ? `${mib / 1024}G` : `${mib}M`;
}

export function msbResourceArgs(r: SandboxResources): string[] {
  if (!(r.cpus > 0) || !(r.memoryBytes >= 256 * 1024 ** 2) || !(r.pids >= 64)) throw new Error('Sandbox resources out of range');
  // vCPUs are whole: round UP a fractional choice (Docker's `--cpus 1.5`), at least one.
  return ['-c', String(Math.max(1, Math.ceil(r.cpus))), '-m', msbSize(r.memoryBytes)];
}

/** One mount. A bind is ALWAYS `ro,noexec`; a volume becomes the VM's own private disk. */
export function msbMountArgs(m: Mount, diskBytes: number): string[] {
  assertMountable(m);
  if (m.kind === 'bind') {
    const src = normalize(m.source);
    if (src.includes(':') || m.target.includes(':')) throw new Error(`A microsandbox mount path cannot contain a colon: ${JSON.stringify(src)}`);
    return ['-v', `${src}:${m.target}:ro,noexec`];
  }
  if (m.target.includes(':')) throw new Error(`A microsandbox mount path cannot contain a colon: ${JSON.stringify(m.target)}`);
  // Removed with the sandbox: nothing to label or sweep separately. Sized: the disk cap is enforced.
  return ['--mount-owned', `${m.target}:kind=disk,size=${msbSize(Math.max(diskBytes, 1024 ** 3))}`];
}

export function msbEnvArgs(env: Record<string, string>): string[] {
  return Object.entries(env).flatMap(([k, v]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`Not a valid environment variable name: ${k}`);
    if (v.includes('\0')) throw new Error(`Environment value for ${k} contains a NUL byte`);
    return ['-e', `${k}=${v}`];
  });
}

export function msbLabelArgs(labels: Record<string, string>): string[] {
  return Object.entries(labels).flatMap(([k, v]) => {
    // msb reserves these prefixes for itself.
    if (/^(?:sandbox|microsandbox|service)\./.test(k)) throw new Error(`Reserved microsandbox label: ${k}`);
    return ['--label', `${k}=${v}`];
  });
}

export function assertSocketPath(p: string): string {
  if (!isAbsolute(p) || p.includes(':') || p.includes(',') || p.includes('\0') || Buffer.byteLength(p) > MAX_SOCKET_PATH) {
    throw new Error(`Not a usable proxy socket path: ${JSON.stringify(p)}`);
  }
  return p;
}

/** The guest's root disk: a private flat copy of the image (removed with the VM). */
export const ROOT_DISK = 'flat:20G,clone=auto';

/** `msb create` for a session's VM. The image is LAST, after every flag. */
export function msbCreateArgs(spec: SandboxSpec, name: string, labels: Record<string, string>, sockets: HostProxySockets): string[] {
  if (!isAbsolute(spec.workdir)) throw new Error('Sandbox workdir must be absolute');
  return [
    'create', '--quiet',
    '--name', name,
    ...msbLabelArgs(labels),
    ...msbResourceArgs(spec.resources),
    '--root-disk', ROOT_DISK,
    // No network at all; the three vsock routes are the only way out (to Limn's proxy).
    '--no-net',
    '--vsock', `${assertSocketPath(sockets.forward)}:${VSOCK_PORTS.forward}`,
    '--vsock', `${assertSocketPath(sockets.anthropic)}:${VSOCK_PORTS.anthropic}`,
    '--vsock', `${assertSocketPath(sockets.chatgpt)}:${VSOCK_PORTS.chatgpt}`,
    ...spec.mounts.flatMap((m) => msbMountArgs(m, spec.resources.diskBytes)),
    ...msbEnvArgs(spec.env),
    '-w', spec.workdir,
    spec.image,
  ];
}

export interface MsbExecFlags {
  user?: string;
  cwd?: string;
  env?: Record<string, string>;
  /** stdin is forwarded (`--stream`); otherwise the command gets EOF (`--no-stdin`). */
  stdin: boolean;
  /** `--rlimit nproc=<n>` for a non-root command (the processes cap). */
  pids?: number;
  detach?: boolean;
}

/** `msb exec` argv. Never a TTY: the output is read by Limn, byte for byte. */
export function msbExecArgs(container: string, argv: string[], f: MsbExecFlags): string[] {
  if (argv.length === 0) throw new Error('exec needs a program');
  const user = f.user ?? SANDBOX_USER;
  if (!/^[a-z_][a-z0-9_-]*$/.test(user)) throw new Error(`Not a valid user: ${user}`);
  return [
    'exec', '--quiet',
    ...(f.detach ? ['--detach'] : f.stdin ? ['--stream'] : ['--no-stdin']),
    '-u', user,
    ...(f.cwd ? ['-w', f.cwd] : []),
    ...msbEnvArgs(f.env ?? {}),
    ...(user !== 'root' && f.pids ? ['--rlimit', `nproc=${Math.floor(f.pids)}`] : []),
    container,
    '--',
    ...argv,
  ];
}

// ── the guest side ─────────────────────────────────────────────────────────────────────────────

/** The hosts entry that makes `limn-proxy` (proxy/credentials.ts PROXY_ALIAS) the guest's relay. */
export const GUEST_HOSTS_LINE = '127.0.0.1 limn-proxy';

/** The root setup step: the hosts entry, and the private disks made the agent's. */
export function guestSetupScript(): string {
  return [
    'set -e',
    `grep -q ' limn-proxy$' /etc/hosts 2>/dev/null || echo '${GUEST_HOSTS_LINE}' >> /etc/hosts`,
    `for d; do chown ${SANDBOX_USER}:${SANDBOX_USER} "$d"; done`,
  ].join('\n');
}

/**
 * THE GUEST RELAY (python3 is in the image; Node has no AF_VSOCK). It listens on the guest's OWN
 * loopback at the ports the sandbox env names (`limn-proxy:3128`, `:8081`, `:8082`) and pipes each
 * connection to host CID 2 over vsock, where microsandbox hands it to Limn's unix socket. It knows no
 * rule and holds no secret: every decision is the host proxy's.
 */
export const GUEST_RELAY = `
import socket, threading
ROUTES = [(${VSOCK_PORTS.forward}, ${VSOCK_PORTS.forward}), (${VSOCK_PORTS.anthropic}, ${VSOCK_PORTS.anthropic}), (${VSOCK_PORTS.chatgpt}, ${VSOCK_PORTS.chatgpt})]
def pipe(a, b, done):
    try:
        while True:
            d = a.recv(65536)
            if not d:
                break
            b.sendall(d)
    except OSError:
        pass
    try:
        b.shutdown(socket.SHUT_WR)
    except OSError:
        pass
    with done[0]:
        done[1] += 1
        if done[1] == 2:
            a.close()
            b.close()
def serve(listen_port, vsock_port):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(('127.0.0.1', listen_port))
    s.listen(256)
    while True:
        c, _ = s.accept()
        try:
            v = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
            v.connect((2, vsock_port))
        except OSError:
            c.close()
            continue
        done = [threading.Lock(), 0]
        threading.Thread(target=pipe, args=(c, v, done), daemon=True).start()
        threading.Thread(target=pipe, args=(v, c, done), daemon=True).start()
threads = [threading.Thread(target=serve, args=r, daemon=True) for r in ROUTES]
for t in threads:
    t.start()
for t in threads:
    t.join()
`.trimStart();

/** Exit 0 once all three relay ports answer on the guest's loopback. */
export const GUEST_RELAY_PROBE = `
import socket, sys
for p in (${VSOCK_PORTS.forward}, ${VSOCK_PORTS.anthropic}, ${VSOCK_PORTS.chatgpt}):
    try:
        socket.create_connection(('127.0.0.1', p), timeout=2).close()
    except OSError:
        sys.exit(1)
`.trimStart();

// ── parsers (tolerant: the exact JSON is unverified) ─────────────────────────────────────────────

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

export interface MsbListedSandbox {
  name: string;
  labels: Record<string, string>;
  status: string | null;
}

/** `["k=v", …]`, `{k: v}` or `[{key, value}]` → a label map. */
export function labelsOf(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(v)) {
    for (const item of v) {
      if (typeof item === 'string') {
        const i = item.indexOf('=');
        if (i > 0) out[item.slice(0, i)] = item.slice(i + 1);
        else if (item) out[item] = '';
      } else if (isObj(item) && typeof item.key === 'string') {
        out[item.key] = typeof item.value === 'string' ? item.value : String(item.value ?? '');
      }
    }
  } else if (isObj(v)) {
    for (const [k, val] of Object.entries(v)) out[k] = typeof val === 'string' ? val : String(val ?? '');
  }
  return out;
}

function rowsOf(doc: unknown, keys: readonly string[]): unknown[] {
  if (Array.isArray(doc)) return doc;
  if (isObj(doc)) {
    for (const k of keys) if (Array.isArray(doc[k])) return doc[k] as unknown[];
    return [doc];
  }
  return [];
}

/** Parse JSON, or JSON Lines, or nothing. */
function parseDocs(text: string): unknown[] {
  const t = text.trim();
  if (t === '') return [];
  try {
    return [JSON.parse(t) as unknown];
  } catch {
    const out: unknown[] = [];
    for (const line of t.split('\n')) {
      try {
        out.push(JSON.parse(line) as unknown);
      } catch {
        /* not JSON: skipped */
      }
    }
    return out;
  }
}

/** `msb ls --format json`. */
export function parseMsbList(text: string): MsbListedSandbox[] {
  const out: MsbListedSandbox[] = [];
  for (const doc of parseDocs(text)) {
    for (const row of rowsOf(doc, ['sandboxes', 'items', 'data'])) {
      if (!isObj(row)) continue;
      const name = typeof row.name === 'string' ? row.name : typeof row.Name === 'string' ? row.Name : null;
      if (!name) continue;
      const labels = labelsOf(row.labels ?? row.Labels ?? (isObj(row.config) ? row.config.labels : undefined));
      const status = [row.status, row.state, row.Status, row.State].find((s): s is string => typeof s === 'string') ?? null;
      out.push({ name, labels, status });
    }
  }
  return out;
}

function firstNumber(row: Json, keys: readonly string[]): number | null {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (isObj(v)) {
      for (const inner of ['bytes', 'used', 'value']) {
        const x = v[inner];
        if (typeof x === 'number' && Number.isFinite(x)) return x;
      }
    }
  }
  return null;
}

/** `msb metrics <name> --format json` → one stats row per sandbox. CPU as a percentage of ONE core. */
export function parseMsbMetrics(text: string, roleOf: (name: string) => string | null): ContainerStats[] {
  const out: ContainerStats[] = [];
  for (const doc of parseDocs(text)) {
    for (const row of rowsOf(doc, ['sandboxes', 'metrics', 'items'])) {
      if (!isObj(row)) continue;
      const name = typeof row.name === 'string' ? row.name : null;
      if (!name) continue;
      let cpu = firstNumber(row, ['cpu_percent', 'cpuPercent']);
      if (cpu === null) {
        // "busy cores": 0.8 of a core = 80 %.
        const cores = firstNumber(row, ['cpu_busy_cores', 'cpu_cores_busy', 'cpu']);
        cpu = cores === null ? null : Math.round(cores * 1000) / 10;
      }
      out.push({
        name,
        role: roleOf(name),
        cpuPercent: cpu,
        memoryBytes: firstNumber(row, ['memory_used_bytes', 'mem_used_bytes', 'memory_bytes', 'memory_used', 'mem_used', 'memory']),
        memoryLimitBytes: firstNumber(row, ['memory_limit_bytes', 'mem_limit_bytes', 'memory_limit', 'mem_limit']),
      });
    }
  }
  return out;
}

/** `msb images -q`: one reference per line. */
export function parseMsbImages(text: string): Set<string> {
  return new Set(
    text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean),
  );
}

/** `msb --version` → "0.7.9". */
export function parseMsbVersion(text: string): string | null {
  return /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(text)?.[1] ?? null;
}

/** The one line to show from a failed `msb doctor` (its first failing check, else its last line). */
export function doctorProblem(output: string): string {
  // eslint-disable-next-line no-control-regex
  const lines = output.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
  const bad = lines.find((l) => /(?:✗|✘|×|\bfail(?:ed)?\b|\berror\b|\bmissing\b|\bnot (?:found|supported|available)\b)/i.test(l));
  const line = (bad ?? lines[lines.length - 1] ?? '').replace(/^[✗✘×!\-*\s]+/, '').slice(0, 200);
  return line ? `microsandbox is installed but not ready: ${line} Run \`msb doctor\` for details.` : 'microsandbox is installed but `msb doctor` failed. Run it for details.';
}

/**
 * The hardware microsandbox needs, checked WITHOUT running anything: an Apple Silicon Mac, Linux with
 * `/dev/kvm`, or Windows (WHP, preview). Null when this machine can run it.
 */
export function platformProblem(platform: NodeJS.Platform, arch: string, hasKvm: boolean): string | null {
  if (platform === 'darwin') return arch === 'arm64' ? null : 'microsandbox needs an Apple Silicon Mac; this Mac has an Intel chip. Use Colima or Docker instead.';
  if (platform === 'linux') return hasKvm ? null : 'microsandbox needs KVM (/dev/kvm), which this Linux machine does not have. Use Docker or Podman instead.';
  if (platform === 'win32') return null; // WHP: `msb doctor` says whether it is on.
  return `microsandbox does not run on ${platform}.`;
}

/** Node's arch → the guest's (`docker info` spelling, so the route shows one vocabulary). */
export function guestArch(arch: string): string {
  return arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x86_64' : arch;
}
