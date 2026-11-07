// THE COMPOSE POLICY (docs/SANDBOX.md § Services; plan WP6). Pure: the NORMALISED model
// (`docker compose config --format json`, run inside the sandbox on the file the reader picked) in, a
// RUNNABLE model out — or the whole file refused, with every reason, in plain words.
//
// ⚠ The input is UNTRUSTED: the agent can edit the compose file, and the normaliser ran in the sandbox.
// This fold is the boundary. It runs on every `up`, on the file as it is then.
//
// REFUSED (the whole file): privileged mode, added capabilities, devices, GPUs, the host's network /
// PID / IPC / UTS / user namespaces, another container's namespaces, a mount from outside the session's
// workspace, the Docker socket (it is outside the workspace), a loosened security option, a logging
// driver that sends logs somewhere, a volume with its own driver or options (a disguised host mount),
// external volumes, networks and links, secrets or configs read from files, images from a registry not
// on the list, and the compose features that reach the host (`use_api_socket`, providers, models).
//
// REWRITTEN: every service joins ONLY the session's internal network (its other networks' aliases and
// its `container_name` become aliases there); published ports are DROPPED and become LOCALHOST
// FORWARDS inside the sandbox; `links` become aliases; `extra_hosts` go; a bind inside the workspace
// becomes a SUBPATH of the session's workspace volume (the host daemon cannot see the sandbox's files);
// named volumes are the project's own and carry Limn's labels; memory, CPUs and processes are capped
// per service and in total; `no-new-privileges` is set; services get NO proxy settings unless the
// reader opted that service in (spike 4 rule 1).
import { posix } from 'node:path';

export interface ServiceLimits {
  /** What a service that sets no memory limit gets (spike 4: BNG's largest, localstack, peaked at 406 MiB). */
  defaultServiceMemoryBytes: number;
  /** The most one service may have. */
  perServiceMemoryBytes: number;
  perServiceCpus: number;
  perServicePids: number;
  /** All of a session's running services together. */
  totalMemoryBytes: number;
  maxServices: number;
}

export const DEFAULT_SERVICE_LIMITS: ServiceLimits = {
  defaultServiceMemoryBytes: 768 * 1024 ** 2,
  perServiceMemoryBytes: 2 * 1024 ** 3,
  perServiceCpus: 2,
  perServicePids: 1024,
  totalMemoryBytes: 8 * 1024 ** 3,
  maxServices: 30,
};

/** Registries the host daemon may pull a service image from (docs/SANDBOX.md § Services). */
export const DEFAULT_ALLOWED_REGISTRIES = ['docker.io', 'ghcr.io', 'public.ecr.aws', 'mcr.microsoft.com', 'quay.io', 'gcr.io', 'registry.k8s.io'] as const;

export interface PolicyContext {
  /** Compose project name, `limn-<session>-<stack>`. */
  project: string;
  /** The session's internal network (the services' only network). */
  network: string;
  /** Where the session's workspace volume is mounted in the sandbox (the layout's root). */
  workspaceRoot: string;
  workspaceVolume: string;
  /**
   * How a bind inside the workspace is mounted. `workspace-volume` (Docker backend, the default): as a
   * SUBPATH of the session's workspace volume — the host daemon cannot see the sandbox's files.
   * `bind` (microsandbox: Docker runs INSIDE the VM, beside the files): kept as a bind, still only from
   * inside the workspace.
   */
  bindMode?: 'workspace-volume' | 'bind';
  /** Limn's labels for a service container, and for a volume. */
  serviceLabels: Record<string, string>;
  volumeLabels: Record<string, string>;
  /** service → the image Limn built for it this session (`limn-svc build`). */
  builtImages: ReadonlyMap<string, string>;
  /** The tag a service with a `build:` section gets when Limn builds it. */
  plannedTag(service: string): string;
  /** Services the reader let reach the internet through the proxy. */
  egressServices: ReadonlySet<string>;
  proxyUrl: string;
  limits: ServiceLimits;
  allowedRegistries: readonly string[];
}

export interface ServiceBuild {
  /** Absolute path in the sandbox, inside the workspace. */
  context: string;
  /** Inside the context. */
  dockerfile: string;
  target: string | null;
  args: Record<string, string>;
}

export interface PolicedService {
  name: string;
  image: string;
  /** Limn builds this image before `up` when it is not built yet. */
  build: ServiceBuild | null;
  built: boolean;
  memoryBytes: number;
}

export interface Forward {
  /** localhost port inside the sandbox. */
  port: number;
  /** The service's name on the session network. */
  host: string;
  target: number;
}

export interface PolicedStack {
  /** The runnable model (JSON for `docker compose --file -`). */
  model: Record<string, unknown>;
  services: PolicedService[];
  forwards: Forward[];
  /** Sandbox folders a bind mount names: created (as the agent) when missing, before `up`. */
  bindDirs: string[];
  memoryBytes: number;
  /** What was dropped or changed, one plain line each. */
  notes: string[];
}

export type PolicyResult = { ok: true; stack: PolicedStack } | { ok: false; reasons: string[] };

const NET_KEY = 'limn';
const WORKSPACE_VOLUME_KEY = 'limn-workspace';
const SERVICE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;
const ALIAS = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,252}$/;
const VOLUME_KEY = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;
const ALLOWED_SECURITY_OPT = /^no-new-privileges(?:[:=]true)?$/;
const ALLOWED_LOG_DRIVERS = new Set(['json-file', 'local', 'none']);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v != null && typeof v === 'object' && !Array.isArray(v);
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const nonEmpty = (v: unknown): boolean => (Array.isArray(v) ? v.length > 0 : isObj(v) ? Object.keys(v).length > 0 : v != null && v !== '' && v !== false);

/** "512m", "2g", 1073741824, "1073741824" → bytes; null when unreadable. */
export function parseComposeBytes(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? Math.floor(v) : null;
  if (typeof v !== 'string') return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*([bkmgt]?)i?b?\s*$/i.exec(v);
  if (!m) return null;
  const pow = { '': 0, b: 0, k: 1, m: 2, g: 3, t: 4 }[(m[2] ?? '').toLowerCase()] ?? 0;
  const n = Number(m[1]) * 1024 ** pow;
  return n > 0 ? Math.floor(n) : null;
}

/** The registry an image reference is pulled from (`postgres` → docker.io). */
export function registryOf(image: string): string {
  const first = image.split('/')[0] ?? '';
  if (image.includes('/') && (first.includes('.') || first.includes(':') || first === 'localhost')) {
    const host = first.toLowerCase();
    return host === 'index.docker.io' || host === 'registry-1.docker.io' ? 'docker.io' : host;
  }
  return 'docker.io';
}

/** True when `p` is `root` or inside it (lexically, after normalising). */
export function insideRoot(root: string, p: string): boolean {
  const r = posix.normalize(root).replace(/\/+$/, '') || '/';
  const n = posix.normalize(p);
  return n === r || n.startsWith(r === '/' ? '/' : `${r}/`);
}

/** Police and rewrite one normalised compose model. */
export function policeCompose(input: unknown, ctx: PolicyContext): PolicyResult {
  const reasons: string[] = [];
  const notes: string[] = [];
  const refuse = (why: string): void => {
    if (!reasons.includes(why)) reasons.push(why);
  };
  const note = (line: string): void => {
    if (!notes.includes(line)) notes.push(line);
  };
  if (!isObj(input) || !isObj(input.services)) return { ok: false, reasons: ['The file has no services.'] };
  const root = posix.normalize(ctx.workspaceRoot).replace(/(.)\/+$/, '$1');

  // ── Top level ────────────────────────────────────────────────────────────────────────────────
  for (const key of Object.keys(input)) {
    if (['name', 'services', 'volumes', 'networks', 'secrets', 'configs', 'version'].includes(key) || key.startsWith('x-')) continue;
    if (key === 'models') refuse('The file uses compose models, which a session does not run.');
    else note(`The top-level \`${key}\` section is ignored.`);
  }
  for (const kind of ['secrets', 'configs'] as const) {
    const section = input[kind];
    if (!isObj(section)) continue;
    for (const [k, v] of Object.entries(section)) {
      if (isObj(v) && (v.file != null || (v.external != null && v.external !== false))) {
        refuse(`The ${kind.slice(0, -1)} \`${k}\` is read from a file or from outside the project. Use \`content\` instead.`);
      }
      // ⚠ `environment:` names a variable of the process that runs compose: LIMN's, on the host.
      if (isObj(v) && v.environment != null) {
        refuse(`The ${kind.slice(0, -1)} \`${k}\` is read from an environment variable on this computer. Use \`content\` instead.`);
      }
    }
  }

  const volumesOut: Obj = {};
  const topVolumes = isObj(input.volumes) ? input.volumes : {};
  for (const [key, raw] of Object.entries(topVolumes)) {
    if (!VOLUME_KEY.test(key)) {
      refuse(`The volume name \`${key}\` is not allowed.`);
      continue;
    }
    const v = isObj(raw) ? raw : {};
    if (v.external === true || (isObj(v.external) && nonEmpty(v.external))) refuse(`The volume \`${key}\` is external: a session uses only its own volumes.`);
    if (v.driver != null && v.driver !== 'local') refuse(`The volume \`${key}\` uses the \`${String(v.driver)}\` driver. Only plain volumes are allowed.`);
    if (nonEmpty(v.driver_opts)) refuse(`The volume \`${key}\` has driver options, which can mount a host folder.`);
    volumesOut[key] = { name: `${ctx.project}_${key}`, labels: { ...ctx.volumeLabels } };
  }

  const entries = Object.entries(input.services);
  if (entries.length === 0) return { ok: false, reasons: ['The file has no services.'] };
  const names = new Set(entries.map(([n]) => n));
  let replicas = 0;
  for (const [, raw] of entries) {
    const deploy = isObj(raw) && isObj(raw.deploy) ? raw.deploy : null;
    const r = deploy && typeof deploy.replicas === 'number' && deploy.replicas >= 0 ? Math.floor(deploy.replicas) : 1;
    replicas += r;
  }
  if (replicas > ctx.limits.maxServices) refuse(`The file starts ${replicas} containers. The limit is ${ctx.limits.maxServices}.`);
  const defaultMemory = Math.max(128 * 1024 ** 2, Math.min(ctx.limits.defaultServiceMemoryBytes, ctx.limits.perServiceMemoryBytes, Math.floor(ctx.limits.totalMemoryBytes / Math.max(1, replicas))));

  const aliasesOf = new Map<string, Set<string>>();
  const addAlias = (svc: string, a: unknown): void => {
    if (typeof a !== 'string' || !ALIAS.test(a) || a === svc) return;
    let s = aliasesOf.get(svc);
    if (!s) aliasesOf.set(svc, (s = new Set()));
    s.add(a);
  };

  const servicesOut: Obj = {};
  const policed: PolicedService[] = [];
  const forwards: Forward[] = [];
  const bindDirs = new Set<string>();
  let workspaceVolumeUsed = false;
  let totalMemory = 0;

  for (const [name, raw] of entries) {
    if (!SERVICE_NAME.test(name)) {
      refuse(`The service name \`${name}\` is not allowed.`);
      continue;
    }
    if (!isObj(raw)) {
      refuse(`The service \`${name}\` is not readable.`);
      continue;
    }
    const s: Obj = { ...raw };
    const say = (what: string): void => refuse(`\`${name}\` ${what}`);

    // Privilege and the host's namespaces.
    if (s.privileged === true) say('asks for privileged mode.');
    if (nonEmpty(s.cap_add)) say(`adds capabilities (${asArray(s.cap_add).map(String).join(', ')}).`);
    if (nonEmpty(s.devices)) say('asks for host devices.');
    if (nonEmpty(s.device_cgroup_rules)) say('asks for device access rules.');
    if (nonEmpty(s.gpus)) say('asks for GPUs.');
    if (s.use_api_socket === true) say('asks for the Docker socket (`use_api_socket`).');
    if (s.provider != null) say('is a provider service, which a session does not run.');
    if (s.cgroup_parent != null) say('sets its own cgroup parent.');
    if (s.cgroup === 'host') say("uses the host's cgroup namespace.");
    if (s.userns_mode === 'host') say("uses the host's user namespace.");
    if (s.uts === 'host') say("uses the host's UTS namespace.");
    if (s.credential_spec != null) say('uses a credential spec.');
    if (s.oom_kill_disable === true || (typeof s.oom_score_adj === 'number' && s.oom_score_adj < 0)) say("protects itself from the host's out-of-memory killer.");
    if (s.runtime != null && s.runtime !== 'runc') say(`uses the \`${String(s.runtime)}\` runtime.`);
    for (const ns of ['pid', 'ipc'] as const) {
      const v = s[ns];
      if (typeof v === 'string' && (v === 'host' || v.startsWith('container:'))) say(`uses ${v === 'host' ? "the host's" : 'another container’s'} ${ns.toUpperCase()} namespace.`);
    }
    for (const opt of asArray(s.security_opt)) {
      if (typeof opt !== 'string' || !ALLOWED_SECURITY_OPT.test(opt.trim())) say(`loosens its security (\`${String(opt)}\`).`);
    }
    const deploy = isObj(s.deploy) ? s.deploy : null;
    const reservations = deploy && isObj(deploy.resources) && isObj(deploy.resources.reservations) ? deploy.resources.reservations : null;
    if (reservations && nonEmpty(reservations.devices)) say('reserves host devices.');
    for (const hook of [...asArray(s.post_start), ...asArray(s.pre_stop)]) {
      if (isObj(hook) && hook.privileged === true) say('runs a privileged hook.');
    }
    const logging = isObj(s.logging) ? s.logging : null;
    if (logging && logging.driver != null && !ALLOWED_LOG_DRIVERS.has(String(logging.driver))) say(`sends its logs with the \`${String(logging.driver)}\` driver.`);
    if (nonEmpty(s.external_links)) say('links to containers outside the project.');
    for (const vf of asArray(s.volumes_from)) {
      if (typeof vf === 'string' && vf.startsWith('container:')) say('takes volumes from a container outside the project.');
    }

    // Networking: only the session network.
    const networkMode = typeof s.network_mode === 'string' ? s.network_mode : null;
    if (networkMode !== null) {
      const peer = networkMode.startsWith('service:') ? networkMode.slice('service:'.length) : null;
      if (networkMode !== 'none' && !(peer && names.has(peer))) say(`uses the network mode \`${networkMode}\`.`);
    }
    if (isObj(s.networks)) {
      for (const n of Object.values(s.networks)) if (isObj(n)) for (const a of asArray(n.aliases)) addAlias(name, a);
    }
    if (typeof s.container_name === 'string') {
      addAlias(name, s.container_name);
      note(`\`${name}\`'s container name becomes a host name on the session network.`);
    }
    for (const l of asArray(s.links)) {
      if (typeof l !== 'string') continue;
      const [target, alias] = l.split(':');
      if (target && alias && names.has(target)) addAlias(target, alias);
    }
    if (nonEmpty(s.extra_hosts)) note(`\`${name}\`'s extra host entries are dropped (there is no route to the host).`);

    // Ports → localhost forwards in the sandbox.
    for (const p of asArray(s.ports)) {
      if (!isObj(p)) continue;
      const target = Number(p.target);
      const published = Number.parseInt(String(p.published ?? ''), 10);
      if (!Number.isInteger(target) || target < 1 || target > 65535) continue;
      if ((p.protocol ?? 'tcp') !== 'tcp') {
        note(`\`${name}\`'s ${String(p.protocol)} port ${target} is not forwarded.`);
        continue;
      }
      if (!Number.isInteger(published) || published < 1 || published > 65535) continue;
      if (forwards.some((f) => f.port === published)) {
        note(`localhost:${published} already goes to another service; \`${name}\` is reached by its name.`);
        continue;
      }
      forwards.push({ port: published, host: name, target });
    }

    // Mounts.
    const volumesSvc: unknown[] = [];
    for (const m of asArray(s.volumes)) {
      if (!isObj(m)) {
        say('has a mount that is not readable.');
        continue;
      }
      const type = String(m.type ?? '');
      const target = typeof m.target === 'string' ? m.target : '';
      if (!target.startsWith('/')) {
        say('has a mount without an absolute target.');
        continue;
      }
      if (type === 'bind') {
        const source = typeof m.source === 'string' ? m.source : '';
        if (!source.startsWith('/') || !insideRoot(root, source)) {
          say(`mounts \`${source || '(nothing)'}\`, which is outside the session's workspace.`);
          continue;
        }
        const sub = posix.relative(root, posix.normalize(source));
        const bind = isObj(m.bind) ? m.bind : {};
        if (bind.create_host_path !== false) bindDirs.add(posix.normalize(source));
        if (ctx.bindMode === 'bind') {
          volumesSvc.push({ type: 'bind', source: posix.normalize(source), target, ...(m.read_only === true ? { read_only: true } : {}), bind: { create_host_path: bind.create_host_path !== false } });
          continue;
        }
        workspaceVolumeUsed = true;
        volumesSvc.push({
          type: 'volume',
          source: WORKSPACE_VOLUME_KEY,
          target,
          ...(m.read_only === true ? { read_only: true } : {}),
          volume: { nocopy: true, ...(sub ? { subpath: sub } : {}) },
        });
      } else if (type === 'volume') {
        const source = typeof m.source === 'string' ? m.source : '';
        if (source && !(source in volumesOut)) {
          say(`mounts the volume \`${source}\`, which the file does not declare.`);
          continue;
        }
        const vol = isObj(m.volume) ? m.volume : {};
        volumesSvc.push({
          type: 'volume',
          ...(source ? { source } : {}),
          target,
          ...(m.read_only === true ? { read_only: true } : {}),
          ...(vol.nocopy === true || typeof vol.subpath === 'string' ? { volume: { ...(vol.nocopy === true ? { nocopy: true } : {}), ...(typeof vol.subpath === 'string' ? { subpath: vol.subpath } : {}) } } : {}),
        });
      } else if (type === 'tmpfs') {
        volumesSvc.push({ type: 'tmpfs', target, ...(isObj(m.tmpfs) ? { tmpfs: m.tmpfs } : {}) });
      } else {
        say(`has a \`${type || 'unknown'}\` mount, which a session does not allow.`);
      }
    }

    // The image: a built one, one Limn will build, or a pull from an allowed registry.
    let image = typeof s.image === 'string' ? s.image : '';
    let build: ServiceBuild | null = null;
    const builtTag = ctx.builtImages.get(name) ?? null;
    if (isObj(s.build)) {
      const b = s.build;
      const context = typeof b.context === 'string' ? b.context : '';
      if (!context.startsWith('/') || !insideRoot(root, context)) say(`builds from \`${context || '(nothing)'}\`, which is outside the session's workspace.`);
      for (const k of ['ssh', 'secrets', 'additional_contexts', 'entitlements', 'network', 'extra_hosts'] as const) {
        if (nonEmpty(b[k])) say(`sets \`build.${k}\`, which a session's builds do not allow.`);
      }
      if (b.privileged === true) say('asks for a privileged build.');
      if (b.dockerfile_inline != null) say('uses an inline Dockerfile. Put it in a file.');
      let dockerfile = typeof b.dockerfile === 'string' && b.dockerfile ? b.dockerfile : 'Dockerfile';
      if (dockerfile.startsWith('/')) dockerfile = posix.relative(context, dockerfile);
      if (dockerfile.split('/').includes('..')) say("names a Dockerfile outside its build folder.");
      const args: Record<string, string> = {};
      if (isObj(b.args)) for (const [k, v] of Object.entries(b.args)) if (v != null) args[k] = String(v);
      build = { context, dockerfile, target: typeof b.target === 'string' ? b.target : null, args };
    }
    if (builtTag) image = builtTag;
    else if (build) image = ctx.plannedTag(name);
    else if (!image) say('has no image.');
    else {
      const registry = registryOf(image);
      if (!ctx.allowedRegistries.includes(registry)) say(`pulls from \`${registry}\`, which is not an allowed registry.`);
    }

    // Resources.
    const declared = parseComposeBytes(s.mem_limit) ?? (deploy && isObj(deploy.resources) && isObj(deploy.resources.limits) ? parseComposeBytes(deploy.resources.limits.memory) : null);
    const memory = Math.min(declared ?? defaultMemory, ctx.limits.perServiceMemoryBytes);
    const declaredCpus = Number(s.cpus ?? (deploy && isObj(deploy.resources) && isObj(deploy.resources.limits) ? deploy.resources.limits.cpus : NaN));
    const cpus = Number.isFinite(declaredCpus) && declaredCpus > 0 ? Math.min(declaredCpus, ctx.limits.perServiceCpus) : ctx.limits.perServiceCpus;
    const declaredPids = Number(s.pids_limit);
    const pids = Number.isInteger(declaredPids) && declaredPids > 0 ? Math.min(declaredPids, ctx.limits.perServicePids) : ctx.limits.perServicePids;
    const count = deploy && typeof deploy.replicas === 'number' && deploy.replicas >= 0 ? Math.floor(deploy.replicas) : 1;
    totalMemory += memory * count;

    // The environment: no proxy unless the reader opted this service in.
    // ⚠ A variable with NO value (`- FOO`, normalised to `FOO: null`) is filled by compose from the
    // environment of the process that runs it — LIMN's, on the host. Dropped, never passed.
    const environment: Obj = {};
    if (isObj(s.environment)) {
      const unset: string[] = [];
      for (const [k, v] of Object.entries(s.environment)) {
        if (v == null) unset.push(k);
        else environment[k] = v;
      }
      if (unset.length > 0) note(`\`${name}\`'s variables with no value are left out (${unset.slice(0, 5).join(', ')}${unset.length > 5 ? ', …' : ''}): they would be read from this computer.`);
    }
    if (ctx.egressServices.has(name)) {
      const no = ['localhost', '127.0.0.1', ...names].join(',');
      Object.assign(environment, { HTTP_PROXY: ctx.proxyUrl, HTTPS_PROXY: ctx.proxyUrl, http_proxy: ctx.proxyUrl, https_proxy: ctx.proxyUrl, NO_PROXY: no, no_proxy: no });
    }

    for (const k of [
      'build', 'ports', 'links', 'external_links', 'extra_hosts', 'container_name', 'networks', 'network_mode',
      'env_file', 'label_file', 'mac_address', 'develop', 'storage_opt', 'isolation', 'mem_limit', 'memswap_limit', 'mem_reservation',
      'cpus', 'pids_limit', 'security_opt', 'pull_policy', 'labels', 'volumes', 'environment',
    ]) delete s[k];
    if (deploy) {
      const d: Obj = { ...deploy };
      delete d.resources;
      delete d.placement;
      s.deploy = d;
    }
    const labels = isObj(raw.labels) ? Object.fromEntries(Object.entries(raw.labels).filter(([k]) => !k.startsWith('limn.'))) : {};
    servicesOut[name] = {
      ...s,
      image,
      ...(builtTag || build ? { pull_policy: 'never' } : {}),
      labels: { ...labels, ...ctx.serviceLabels },
      environment,
      volumes: volumesSvc,
      mem_limit: memory,
      memswap_limit: memory,
      cpus,
      pids_limit: pids,
      security_opt: ['no-new-privileges:true'],
      ...(networkMode !== null ? { network_mode: networkMode } : { networks: { [NET_KEY]: { aliases: [] as string[] } } }),
    };
    policed.push({ name, image, build, built: builtTag !== null, memoryBytes: memory * count });
  }

  for (const [svc, aliases] of aliasesOf) {
    const out = servicesOut[svc];
    if (!isObj(out) || !isObj(out.networks)) continue;
    const n = out.networks[NET_KEY];
    if (isObj(n)) n.aliases = [...aliases].sort();
  }
  for (const out of Object.values(servicesOut)) {
    if (isObj(out) && isObj(out.networks) && isObj(out.networks[NET_KEY]) && asArray((out.networks[NET_KEY] as Obj).aliases).length === 0) {
      out.networks[NET_KEY] = null;
    }
  }
  if (forwards.length > 0) note(`Published ports are reached on localhost inside the sandbox: ${forwards.slice(0, 6).map((f) => `${f.port} → ${f.host}`).join(', ')}${forwards.length > 6 ? `, and ${forwards.length - 6} more` : ''}.`);
  if (totalMemory > ctx.limits.totalMemoryBytes) {
    refuse(`These services need ${gb(totalMemory)} of memory. The limit is ${gb(ctx.limits.totalMemoryBytes)}.`);
  }
  if (reasons.length > 0) return { ok: false, reasons };

  if (workspaceVolumeUsed) volumesOut[WORKSPACE_VOLUME_KEY] = { external: true, name: ctx.workspaceVolume };
  const model: Obj = {
    name: ctx.project,
    services: servicesOut,
    networks: { [NET_KEY]: { external: true, name: ctx.network } },
    ...(Object.keys(volumesOut).length > 0 ? { volumes: volumesOut } : {}),
  };
  for (const kind of ['secrets', 'configs'] as const) if (isObj(input[kind])) model[kind] = input[kind];
  return { ok: true, stack: { model, services: policed, forwards, bindDirs: [...bindDirs].sort(), memoryBytes: totalMemory, notes } };
}

export function gb(bytes: number): string {
  const v = bytes / 1024 ** 3;
  return `${v >= 10 ? Math.round(v) : Math.round(v * 10) / 10} GB`;
}
