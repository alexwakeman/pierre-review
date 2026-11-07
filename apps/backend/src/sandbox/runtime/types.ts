// THE SANDBOX RUNTIME CONTRACT (docs/SANDBOX.md § The runtime layer). One interface, several backends:
// `docker.ts` drives the `docker` CLI (or Podman with the same verbs), `microsandbox.ts` (WP9) drives
// `msb`, and `fake.ts` is the in-memory stand-in every caller's tests use. Nothing outside
// `sandbox/runtime/` spawns a container CLI.
//
// ⚠ THE INVARIANTS THIS SHAPE ENFORCES (docs/SANDBOX.md § Invariants):
//   • A BIND mount is ALWAYS read-only — `BindMount` has no `readOnly` switch to flip. Writable storage
//     is a NAMED VOLUME Limn created (`createVolume`), never a host folder.
//   • The sandbox never gets the Docker socket (spec.ts refuses it as a mount source) or GitHub
//     credentials (no caller passes them; the env is plain values the session chose).
//   • Every resource carries Limn's labels (labels.ts) so `destroy` / `sweep` can find it.

export type RuntimeKind = 'docker' | 'microsandbox' | 'fake';

/** Which product serves the Docker API. Decides one licence line and the default bridge's name. */
export type RuntimeFlavour =
  | 'docker-desktop'
  | 'colima'
  | 'podman'
  | 'rancher-desktop'
  | 'orbstack'
  | 'docker-engine'
  | 'microsandbox'
  | 'fake'
  | 'unknown';

export interface RuntimeDetection {
  kind: RuntimeKind;
  /** Ready to start a session: the CLI is there and its daemon answers. */
  available: boolean;
  /** The CLI's absolute path, or null when not found. */
  cli: string | null;
  cliVersion: string | null;
  daemonReachable: boolean;
  serverVersion: string | null;
  /** The server's OS and CPU architecture (`linux`, `x86_64` / `aarch64`). */
  os: string | null;
  arch: string | null;
  /** Memory the daemon can give containers, in bytes (the VM's size on Docker Desktop / Colima). */
  memoryBytes: number | null;
  cpus: number | null;
  rootless: boolean | null;
  flavour: RuntimeFlavour;
  /** One plain line about the product's licence, when it is not free for everyone. */
  licenceNote: string | null;
  /** One plain line saying what is wrong, when `available` is false. */
  problem: string | null;
}

/** Who a resource belongs to. Turned into labels on every container, network and volume. */
export interface SessionOwner {
  sessionId: string;
  accountId: number;
}

/** A host path mounted READ-ONLY. There is deliberately no writable variant. */
export interface BindMount {
  kind: 'bind';
  source: string;
  target: string;
}

/** A named volume Limn created for this session (writable, labelled, removed on discard). */
export interface VolumeMount {
  kind: 'volume';
  name: string;
  target: string;
}

export type Mount = BindMount | VolumeMount;

export interface SandboxResources {
  cpus: number;
  memoryBytes: number;
  pids: number;
  /** The disk the reader allowed. Docker cannot cap a named volume, so this is reported, not
   *  enforced, there (docs/SANDBOX.md § Resources); microsandbox sizes its root disk with it. */
  diskBytes: number;
}

export const DEFAULT_RESOURCES: SandboxResources = {
  cpus: 4,
  memoryBytes: 8 * 1024 ** 3,
  pids: 2048,
  diskBytes: 30 * 1024 ** 3,
};

export interface SandboxSpec extends SessionOwner {
  image: string;
  /** The session's internal network (`createNetwork`). The sandbox joins ONLY this network. */
  network: string;
  env: Record<string, string>;
  mounts: Mount[];
  resources: SandboxResources;
  /** The starting directory inside the sandbox. */
  workdir: string;
}

export interface ProxySpec extends SessionOwner {
  image: string;
  /** The session's internal network; the proxy also joins the runtime's default bridge. */
  network: string;
  /** The DNS name the sandbox reaches the proxy by on the internal network. */
  alias: string;
  /** The program: a self-contained ES module run with `node --input-type=module -e`. */
  source: string;
  /** Non-secret configuration only. Secrets reach the proxy over its control port (proxy/egress.ts). */
  env: Record<string, string>;
}

export interface NetworkHandle {
  name: string;
}

export interface ContainerHandle {
  name: string;
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** Default: the image's user (`agent`). */
  user?: string;
  /** Text written to stdin then closed. Omit to keep stdin open for `write()` (interactive). */
  input?: string | Buffer;
  /** Keep stdin open for `write()`. Implied when `input` is absent and `interactive` is true. */
  interactive?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type ExecEvent =
  | { type: 'stdout'; data: Buffer }
  | { type: 'stderr'; data: Buffer }
  | { type: 'exit'; code: number | null; signal: string | null; timedOut: boolean };

/** A running process: its output as events, and its stdin. */
export interface ExecHandle {
  events: AsyncIterable<ExecEvent>;
  write(data: string | Buffer): void;
  end(): void;
  kill(): void;
  done: Promise<{ code: number | null; signal: string | null; timedOut: boolean }>;
}

export interface ExecResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
  timedOut: boolean;
}

export interface FileToCopy {
  /** Absolute path inside the sandbox. */
  path: string;
  content: string | Buffer;
  /** Octal mode, default 0o644. */
  mode?: number;
}

/** One `docker compose` call on a session's services (sandbox/services/). The verbs are typed: no
 *  caller passes compose flags. */
export type ComposeVerb =
  | { verb: 'up'; services?: string[] }
  | { verb: 'down' }
  | { verb: 'ps' }
  | { verb: 'logs'; service: string; tail: number }
  | { verb: 'run'; service: string; command: string[] };

export interface ComposeCall extends SessionOwner {
  /** Compose project name (`limn-<session>-<stack>`). */
  project: string;
  /** The POLICED, rewritten compose model (`sandbox/services/policy.ts`), as JSON. Never a reader's
   *  raw file. Not needed for `down` (compose finds the project by its labels). */
  compose: unknown;
  call: ComposeVerb;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Each output line as it arrives (progress for `up`). */
  onLine?: (line: string) => void;
}

/** An image built from a folder INSIDE the sandbox (the agent's edited code), for a service. */
export interface ImageBuildSpec extends SessionOwner {
  /** `limn-<session>-svc-<stack>-<service>:<n>` (services/controller.ts). */
  tag: string;
  /** The context: a folder inside this container, streamed out as a tar (as the agent). */
  from: { container: string; dir: string };
  /** The Dockerfile's path inside the context. */
  dockerfile: string;
  target?: string;
  buildArgs?: Record<string, string>;
  /** The network the build's steps run on: the session's internal one, so they reach only the proxy. */
  network: string;
  /** The proxy's URL, given to the steps as the standard proxy build args (never stored in the image). */
  proxyUrl: string;
  memoryBytes: number;
  /** Registries a `FROM` / `COPY --from` may pull from (default: policy.ts's list). The Dockerfile is
   *  checked as the context streams (runtime/dockerfile.ts). */
  allowedRegistries?: readonly string[];
  /** The context is refused past this size (default 2 GB). */
  maxContextBytes?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  onLine?: (line: string) => void;
}

export interface ContainerStats {
  name: string;
  role: string | null;
  cpuPercent: number | null;
  memoryBytes: number | null;
  memoryLimitBytes: number | null;
}

export interface SweepResult {
  containers: string[];
  networks: string[];
  volumes: string[];
  /** Images Limn built for a session's services. */
  images: string[];
  /** One line per resource that could not be removed. */
  errors: string[];
}

export interface ImageProgress {
  phase: 'check' | 'pull' | 'build';
  line: string;
}

export interface EnsuredImage {
  /** The local reference every container is started from. */
  ref: string;
  source: 'local' | 'pulled' | 'built';
}

export interface SandboxRuntime {
  readonly kind: RuntimeKind;
  detect(): Promise<RuntimeDetection>;
  /** The sandbox image, present locally: already there, pulled by digest, or built from the Dockerfile. */
  ensureImage(opts?: { onProgress?: (p: ImageProgress) => void; signal?: AbortSignal }): Promise<EnsuredImage>;
  /** The session's `--internal` network: no route out except through the proxy. */
  createNetwork(owner: SessionOwner): Promise<NetworkHandle>;
  /** A labelled named volume, owned by the image's non-root user. */
  createVolume(owner: SessionOwner, key: string): Promise<string>;
  startProxy(spec: ProxySpec): Promise<ContainerHandle>;
  /**
   * Send one control request (`/rules`, `/credentials`) to a session's proxy. Only a runtime whose
   * proxy is NOT a container has it (microsandbox: a host process on unix sockets); without it the
   * caller uses `exec` into the proxy container (proxy/egress.ts). True when the proxy accepted it.
   */
  proxyControl?(proxy: string, path: '/rules' | '/credentials', body: unknown): Promise<boolean>;
  startSandbox(spec: SandboxSpec): Promise<ContainerHandle>;
  /** Start a process in a container and stream it. */
  exec(container: string, argv: string[], opts?: ExecOptions): ExecHandle;
  /** `exec` to completion, output collected. */
  run(container: string, argv: string[], opts?: ExecOptions): Promise<ExecResult>;
  copyIn(container: string, files: FileToCopy[], opts?: { user?: string }): Promise<void>;
  /** A file's bytes, or null when it does not exist. Refuses past `maxBytes` (default 8 MB). */
  readFile(container: string, path: string, opts?: { maxBytes?: number }): Promise<Buffer | null>;
  /** The container's stdout+stderr, followed live. */
  followLogs(container: string, opts?: { signal?: AbortSignal }): ExecHandle;
  /** The IP addresses of every container on a network → container name (attributes proxy log rows). */
  networkMembers(network: string): Promise<Map<string, string>>;
  /** `docker compose` on a session's services, the policed model on stdin. */
  compose(call: ComposeCall): Promise<ExecResult>;
  /** Build a service image from a folder inside the sandbox (services/controller.ts `build`). */
  buildImage(spec: ImageBuildSpec): Promise<ExecResult>;
  stats(sessionId: string): Promise<ContainerStats[]>;
  /** Remove every container, network, volume and built image of one session. */
  destroy(sessionId: string): Promise<SweepResult>;
  /** Remove every Limn resource whose session is not in `liveSessionIds` (boot + `limn sandbox prune`). */
  sweep(liveSessionIds: Iterable<string>, opts?: { dryRun?: boolean }): Promise<SweepResult>;
}
