// THE SERVICES CONTROLLER (docs/SANDBOX.md § Services; plan WP6). One per session, on the HOST. The
// agent asks with `limn-svc` (relay.ts carries the request out of the sandbox); Limn decides:
//
//   1. NORMALISE the picked compose file INSIDE the sandbox, where the repository is
//      (`docker-compose config --format json`; no daemon is involved);
//   2. POLICE the JSON (policy.ts) — refused files are refused whole, with every reason;
//   3. BUILD any service image from the agent's code (`limn-svc build`, or a `build:` section) through
//      the runtime, the context streamed out of the sandbox, the build steps on the session network;
//   4. RUN `docker compose` on the host with the policed model, then give the relay the localhost
//      forwards.
//
// ⚠ Limn never runs a file the reader did not pick (`stacks` comes from Settings). The agent's argv is
// DATA: every word is matched against the picked files' services, every path against the workspace.
// ⚠ Mutating verbs (up, down, build, run) run one at a time per session.
import { posix } from 'node:path';
import type { SandboxServiceStackStatus, SandboxServicesStatus } from '@pierre-review/shared';
import { PROXY_URL } from '../proxy/credentials.js';
import { appInstance, resourceLabels } from '../runtime/labels.js';
import type { ExecResult, SandboxRuntime, SessionOwner } from '../runtime/types.js';
import {
  DEFAULT_ALLOWED_REGISTRIES,
  DEFAULT_SERVICE_LIMITS,
  gb,
  insideRoot,
  policeCompose,
  type Forward,
  type PolicedStack,
  type PolicyResult,
  type ServiceLimits,
} from './policy.js';

/** The compose CLI inside the sandbox image (config only). */
export const SANDBOX_COMPOSE = '/usr/local/bin/docker-compose';

export interface ServiceStackConfig {
  /** `limn-svc`'s name for it: lower-case letters, digits and `-`. */
  key: string;
  /** The repository's folder in the sandbox. */
  repoPath: string;
  /** The compose file inside the repository. */
  file: string;
  /** `bng-metric-backend/compose.yml`, for people. */
  from: string;
  egress: readonly string[];
}

export interface ServicesControllerOptions {
  runtime: SandboxRuntime;
  owner: SessionOwner;
  /** The sandbox container (the normaliser and build contexts run there). */
  sandbox: string;
  /** The session's internal network. */
  network: string;
  workspaceRoot: string;
  workspaceVolume: string;
  stacks: readonly ServiceStackConfig[];
  /** The daemon's version (`detect().serverVersion`): volume subpaths need Docker 26 or later. */
  serverVersion?: string | null;
  limits?: ServiceLimits;
  allowedRegistries?: readonly string[];
  proxyUrl?: string;
  /** The `limn.managed` value (labels.ts). Default: this data dir's. */
  instance?: string;
  extraLabels?: Record<string, string>;
  onStatus?: (s: SandboxServicesStatus) => void;
  /** Every line of compose / build output, for the session's activity. */
  onOutput?: (line: string) => void;
}

export type Out = (stream: 'o' | 'e', text: string) => void;

interface StackState {
  cfg: ServiceStackConfig;
  status: SandboxServiceStackStatus;
  /** The model last started (for `down`, `ps`, `logs`). */
  running: PolicedStack | null;
  built: Map<string, string>;
  buildCount: number;
}

export const USAGE = [
  'limn-svc — the services Limn runs for this session',
  '',
  '  limn-svc ls                       list the compose files and their services',
  '  limn-svc check [file]             check a file against the session rules',
  '  limn-svc up [file | service …]    start services (a whole file, or named services)',
  '  limn-svc down [file]              stop services (all when none is named)',
  '  limn-svc ps                       show the running services',
  '  limn-svc logs <service> [--tail N]',
  '  limn-svc build <service> [folder] [--file Dockerfile] [--target stage]',
  '                                    build the service image from your code, then `up` uses it',
  '  limn-svc run <service> [command …] run a one-off container (a migration job)',
  '',
  'A service is reached by its name. Its published ports are on localhost here too.',
].join('\n');

const COMPOSE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;

/** Docker 26 added volume subpaths (API 1.45). */
export function supportsSubpath(serverVersion: string | null | undefined): boolean {
  if (!serverVersion) return true;
  const m = /^(\d+)\./.exec(serverVersion);
  return m ? Number(m[1]) >= 26 : true;
}

/** Make a stack key from a repository name: `DEFRA/bng-metric-backend` → `bng-metric-backend`. */
export function stackKeyFor(repo: string, taken: ReadonlySet<string>): string {
  const base = (repo.split('/').pop() ?? 'stack').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'stack';
  let key = base.slice(0, 40);
  for (let n = 2; taken.has(key); n++) key = `${base.slice(0, 36)}-${n}`;
  return key;
}

export class ServicesController {
  private readonly o: ServicesControllerOptions;
  private readonly stacks = new Map<string, StackState>();
  private readonly limits: ServiceLimits;
  private readonly instance: string;
  private chain: Promise<unknown> = Promise.resolve();
  private inventoried = false;
  private forwarder: ((f: Forward[]) => Promise<{ listening: number[]; failed: { port: number; reason: string }[] }>) | null = null;

  constructor(o: ServicesControllerOptions) {
    this.o = o;
    this.limits = o.limits ?? DEFAULT_SERVICE_LIMITS;
    this.instance = o.instance ?? appInstance();
    for (const cfg of o.stacks) {
      this.stacks.set(cfg.key, {
        cfg,
        running: null,
        built: new Map(),
        buildCount: 0,
        status: { key: cfg.key, from: cfg.from, state: 'stopped', reasons: [], notes: [], services: [], forwards: [], builtImages: [] },
      });
    }
  }

  /** The relay (relay.ts) registers how forwards reach the sandbox. */
  setForwarder(f: ServicesController['forwarder']): void {
    this.forwarder = f;
  }

  status(): SandboxServicesStatus {
    return { stacks: [...this.stacks.values()].map((s) => ({ ...s.status })) };
  }

  private emit(): void {
    this.o.onStatus?.(this.status());
  }

  private setState(st: StackState, patch: Partial<SandboxServiceStackStatus>): void {
    st.status = { ...st.status, ...patch };
    this.emit();
  }

  private project(st: StackState): string {
    return `limn-${this.o.owner.sessionId}-${st.cfg.key}`;
  }

  private tagFor(st: StackState, service: string, n: number): string {
    return `limn-${this.o.owner.sessionId}-svc-${st.cfg.key}-${service.toLowerCase().replace(/[^a-z0-9_.-]/g, '-')}:${n}`;
  }

  /** One mutating verb at a time per session. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  // ── Normalise + police ─────────────────────────────────────────────────────────────────────────

  /** `docker-compose config` inside the sandbox, on the file as it is NOW. */
  async normalise(st: StackState): Promise<{ ok: true; model: unknown } | { ok: false; reason: string }> {
    const file = posix.join(st.cfg.repoPath, st.cfg.file);
    const dir = posix.dirname(file);
    const r = await this.o.runtime.run(this.o.sandbox, [SANDBOX_COMPOSE, '--project-directory', dir, '--file', file, 'config', '--format', 'json'], { cwd: dir, timeoutMs: 60_000 });
    if (r.code !== 0) {
      const why = r.stderr.trim().split('\n').slice(-3).join(' ').replace(/\s+/g, ' ');
      return { ok: false, reason: `${st.cfg.from} could not be read: ${why || `exit ${r.code}`}` };
    }
    try {
      return { ok: true, model: JSON.parse(r.stdout.toString('utf8')) as unknown };
    } catch {
      return { ok: false, reason: `${st.cfg.from} could not be read.` };
    }
  }

  async police(st: StackState): Promise<PolicyResult> {
    if (!supportsSubpath(this.o.serverVersion)) {
      return { ok: false, reasons: [`Services need Docker 26 or later (this one is ${this.o.serverVersion}).`] };
    }
    const n = await this.normalise(st);
    if (!n.ok) return { ok: false, reasons: [n.reason] };
    return policeCompose(n.model, {
      project: this.project(st),
      network: this.o.network,
      workspaceRoot: this.o.workspaceRoot,
      workspaceVolume: this.o.workspaceVolume,
      serviceLabels: resourceLabels(this.instance, this.o.owner, 'service', this.o.extraLabels),
      volumeLabels: resourceLabels(this.instance, this.o.owner, 'volume', this.o.extraLabels),
      builtImages: st.built,
      plannedTag: (svc) => this.tagFor(st, svc, 0),
      egressServices: new Set(st.cfg.egress),
      proxyUrl: this.o.proxyUrl ?? PROXY_URL,
      limits: this.limits,
      allowedRegistries: this.o.allowedRegistries ?? DEFAULT_ALLOWED_REGISTRIES,
    });
  }

  /** Every picked file's service names, for the seed (WP4 `SeedService`). Refused files are named too. */
  async inventory(): Promise<{ name: string; from: string; stack: string }[]> {
    this.inventoried = true;
    const out: { name: string; from: string; stack: string }[] = [];
    for (const st of this.stacks.values()) {
      const n = await this.normalise(st);
      if (!n.ok || typeof n.model !== 'object' || n.model == null) continue;
      const services = (n.model as { services?: Record<string, unknown> }).services ?? {};
      const names = Object.keys(services).filter((s) => COMPOSE_NAME.test(s));
      this.setState(st, { services: names });
      for (const name of names) out.push({ name, from: st.cfg.from, stack: st.cfg.key });
    }
    return out;
  }

  // ── The verbs ──────────────────────────────────────────────────────────────────────────────────

  /** One `limn-svc` request. Returns the exit code. */
  async handle(argv: readonly string[], cwd: string, out: Out): Promise<number> {
    const [verb, ...rest] = argv;
    const say = (t: string): void => out('o', t.endsWith('\n') ? t : `${t}\n`);
    const fail = (t: string, code = 1): number => {
      out('e', t.endsWith('\n') ? t : `${t}\n`);
      return code;
    };
    try {
      // A bare service name needs every file's service list.
      if (!this.inventoried && ['up', 'logs', 'build', 'run', 'ls'].includes(verb ?? '')) await this.inventory();
      switch (verb) {
        case undefined:
        case 'help':
        case '--help':
        case '-h':
          say(USAGE);
          return 0;
        case 'ls':
          return this.ls(say);
        case 'check':
          return await this.check(rest, say, fail);
        case 'ps':
          return await this.ps(say, fail);
        case 'logs':
          return await this.logs(rest, out, fail);
        case 'up':
          return await this.serial(() => this.up(rest, say, fail));
        case 'down':
          return await this.serial(() => this.down(rest, say, fail));
        case 'build':
          return await this.serial(() => this.build(rest, cwd, say, fail));
        case 'run':
          return await this.serial(() => this.run(rest, out, fail));
        default:
          return fail(`limn-svc: unknown command \`${verb}\`.\n\n${USAGE}`, 2);
      }
    } catch (e) {
      return fail(`limn-svc: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private ls(say: (t: string) => void): number {
    if (this.stacks.size === 0) {
      say('No compose files are set up for this workspace.');
      return 0;
    }
    for (const st of this.stacks.values()) {
      const svcs = st.status.services.length > 0 ? st.status.services.join(', ') : '(run `limn-svc check` to list them)';
      say(`${st.cfg.key}  ${st.cfg.from}  ${st.status.state}\n  services: ${svcs}`);
    }
    return 0;
  }

  /** `file` (a stack key), `file/service`, or a service name found in exactly one file. */
  private resolve(words: readonly string[], fail: (t: string, code?: number) => number): Map<StackState, string[] | null> | number {
    const picked = new Map<StackState, string[] | null>();
    if (words.length === 0) {
      if (this.stacks.size === 1) {
        picked.set([...this.stacks.values()][0]!, null);
        return picked;
      }
      if (this.stacks.size === 0) return fail('No compose files are set up for this workspace.');
      return fail(`Name a file: ${[...this.stacks.keys()].join(', ')}.`, 2);
    }
    for (const w of words) {
      const slash = w.indexOf('/');
      if (slash > 0) {
        const st = this.stacks.get(w.slice(0, slash));
        const svc = w.slice(slash + 1);
        if (!st) return fail(`There is no file called \`${w.slice(0, slash)}\`. Files: ${[...this.stacks.keys()].join(', ')}.`, 2);
        if (!COMPOSE_NAME.test(svc)) return fail(`\`${svc}\` is not a service name.`, 2);
        const list = picked.get(st);
        if (list !== null) picked.set(st, [...(list ?? []), svc]);
        continue;
      }
      const st = this.stacks.get(w);
      if (st) {
        picked.set(st, null);
        continue;
      }
      if (!COMPOSE_NAME.test(w)) return fail(`\`${w}\` is not a service name.`, 2);
      const owners = [...this.stacks.values()].filter((s) => s.status.services.includes(w));
      if (owners.length === 0 && this.stacks.size === 1) {
        const only = [...this.stacks.values()][0]!;
        const list = picked.get(only);
        if (list !== null) picked.set(only, [...(list ?? []), w]);
        continue;
      }
      if (owners.length !== 1) {
        return fail(owners.length === 0 ? `No file has a service called \`${w}\`. Run \`limn-svc ls\`.` : `\`${w}\` is in ${owners.map((o) => o.cfg.key).join(' and ')}. Say which: \`${owners[0]!.cfg.key}/${w}\`.`, 2);
      }
      const list = picked.get(owners[0]!);
      if (list !== null) picked.set(owners[0]!, [...(list ?? []), w]);
    }
    return picked;
  }

  private async check(words: readonly string[], say: (t: string) => void, fail: (t: string, code?: number) => number): Promise<number> {
    const targets = words.length === 0 ? [...this.stacks.values()] : words.map((w) => this.stacks.get(w));
    if (targets.length === 0) return fail('No compose files are set up for this workspace.');
    let code = 0;
    for (const st of targets) {
      if (!st) return fail(`Files: ${[...this.stacks.keys()].join(', ')}.`, 2);
      const r = await this.police(st);
      if (!r.ok) {
        this.setState(st, { state: st.running ? st.status.state : 'refused', reasons: r.reasons });
        say(`${st.cfg.from}: refused.\n${r.reasons.map((x) => `  - ${x}`).join('\n')}`);
        code = 1;
        continue;
      }
      this.setState(st, { services: r.stack.services.map((s) => s.name), reasons: st.running ? st.status.reasons : [], ...(st.running ? {} : { state: 'stopped' as const }) });
      say(`${st.cfg.from}: allowed. Services: ${r.stack.services.map((s) => s.name).join(', ')} (${gb(r.stack.memoryBytes)} of memory).`);
      for (const n of r.stack.notes) say(`  ${n}`);
    }
    return code;
  }

  /** The services `wanted` start, with everything they depend on. */
  private withDependencies(model: Record<string, unknown>, wanted: readonly string[]): Set<string> {
    const services = (model.services ?? {}) as Record<string, { depends_on?: unknown }>;
    const out = new Set<string>();
    const visit = (n: string): void => {
      if (out.has(n) || !(n in services)) return;
      out.add(n);
      const deps = services[n]?.depends_on;
      const names = Array.isArray(deps) ? deps.map(String) : deps && typeof deps === 'object' ? Object.keys(deps) : [];
      for (const d of names) visit(d);
    };
    for (const w of wanted) visit(w);
    return out;
  }

  private async up(words: readonly string[], say: (t: string) => void, fail: (t: string, code?: number) => number): Promise<number> {
    const resolved = this.resolve(words, fail);
    if (typeof resolved === 'number') return resolved;
    for (const [st, only] of resolved) {
      const r = await this.police(st);
      if (!r.ok) {
        this.setState(st, { state: st.running ? st.status.state : 'refused', reasons: r.reasons });
        return fail(`${st.cfg.from} was refused:\n${r.reasons.map((x) => `  - ${x}`).join('\n')}`);
      }
      const stack = r.stack;
      const names = stack.services.map((s) => s.name);
      for (const svc of only ?? []) if (!names.includes(svc)) return fail(`${st.cfg.from} has no service called \`${svc}\`. It has: ${names.join(', ')}.`, 2);
      // Two files on one network must not answer to the same name.
      for (const other of this.stacks.values()) {
        if (other === st || !other.running) continue;
        const clash = other.running.services.map((s) => s.name).filter((n) => names.includes(n));
        if (clash.length > 0) return fail(`Stop ${other.cfg.key} first (\`limn-svc down ${other.cfg.key}\`): both have ${clash.join(', ')}.`);
      }
      const othersMemory = [...this.stacks.values()].filter((o) => o !== st && o.running).reduce((n, o) => n + (o.running?.memoryBytes ?? 0), 0);
      if (othersMemory + stack.memoryBytes > this.limits.totalMemoryBytes) {
        return fail(`Not enough memory for ${st.cfg.key}: it needs ${gb(stack.memoryBytes)}, ${gb(othersMemory)} is in use, the limit is ${gb(this.limits.totalMemoryBytes)}. Stop something first.`);
      }

      this.setState(st, { state: 'starting', reasons: [], services: names });
      const wanted = only ? this.withDependencies(stack.model, only) : new Set(names);
      // Folders a bind names are created (as the agent) when missing, as compose would on a host.
      if (stack.bindDirs.length > 0) {
        await this.o.runtime.run(this.o.sandbox, ['sh', '-c', 'for p; do [ -e "$p" ] || mkdir -p -- "$p"; done', 'sh', ...stack.bindDirs], { timeoutMs: 30_000 });
      }
      // Images built from the agent's code first.
      for (const svc of stack.services) {
        if (!wanted.has(svc.name) || svc.built || !svc.build) continue;
        say(`Building ${svc.name} from ${posix.relative(this.o.workspaceRoot, svc.build.context) || '.'} …`);
        const b = await this.buildService(st, svc.name, svc.build.context, svc.build.dockerfile, svc.build.target, svc.build.args, say);
        if (!b.ok) {
          this.setState(st, { state: st.running ? 'running' : 'failed', reasons: [b.reason] });
          return fail(b.reason);
        }
      }
      // Police again: the built tags are now part of the model.
      const again = await this.police(st);
      if (!again.ok) {
        this.setState(st, { state: 'refused', reasons: again.reasons });
        return fail(`${st.cfg.from} was refused:\n${again.reasons.map((x) => `  - ${x}`).join('\n')}`);
      }
      say(`Starting ${only ? [...wanted].join(', ') : st.cfg.key} …`);
      const res = await this.o.runtime.compose({ ...this.o.owner, project: this.project(st), compose: again.stack.model, call: { verb: 'up', ...(only ? { services: [...wanted] } : {}) }, ...this.outputSink() });
      st.running = again.stack;
      if (res.code !== 0) {
        const why = lastLines(res.stderr) || `exit ${res.code}`;
        this.setState(st, { state: 'failed', reasons: [`Starting failed: ${why}`], notes: again.stack.notes });
        await this.applyForwards();
        return fail(`Starting ${st.cfg.key} failed:\n${why}\nSee \`limn-svc ps\` and \`limn-svc logs <service>\`.`);
      }
      const fw = await this.applyForwards();
      const forwards = again.stack.forwards.filter((f) => fw.listening.includes(f.port));
      this.setState(st, { state: 'running', reasons: [], notes: again.stack.notes, forwards: forwards.map((f) => ({ port: f.port, service: f.host, target: f.target })) });
      say(`${st.cfg.key} is running: ${[...wanted].join(', ')}.`);
      if (forwards.length > 0) say(`On localhost here: ${forwards.map((f) => `${f.port} → ${f.host}:${f.target}`).join(', ')}.`);
      for (const f of fw.failed.filter((x) => again.stack.forwards.some((g) => g.port === x.port))) say(`localhost:${f.port} could not be forwarded (${f.reason}).`);
      for (const n of again.stack.notes) if (!n.startsWith('Published ports')) say(n);
    }
    return 0;
  }

  private async down(words: readonly string[], say: (t: string) => void, fail: (t: string, code?: number) => number): Promise<number> {
    const targets = words.length === 0 ? [...this.stacks.values()].filter((s) => s.running) : words.map((w) => this.stacks.get(w));
    if (targets.some((t) => !t)) return fail(`Files: ${[...this.stacks.keys()].join(', ')}.`, 2);
    if (targets.length === 0) {
      say('Nothing is running.');
      return 0;
    }
    let code = 0;
    for (const st of targets as StackState[]) {
      this.setState(st, { state: 'stopping' });
      const res = await this.o.runtime.compose({ ...this.o.owner, project: this.project(st), compose: st.running?.model ?? null, call: { verb: 'down' }, ...this.outputSink() });
      if (res.code !== 0) {
        code = 1;
        this.setState(st, { state: 'failed', reasons: [`Stopping failed: ${lastLines(res.stderr)}`] });
        say(`Stopping ${st.cfg.key} failed: ${lastLines(res.stderr)}`);
        continue;
      }
      st.running = null;
      this.setState(st, { state: 'stopped', forwards: [], reasons: [] });
      say(`${st.cfg.key} stopped.`);
    }
    await this.applyForwards();
    return code;
  }

  private async ps(say: (t: string) => void, fail: (t: string, code?: number) => number): Promise<number> {
    const running = [...this.stacks.values()].filter((s) => s.running);
    if (running.length === 0) {
      say(`Nothing is running.${this.stacks.size > 0 ? ` Files: ${[...this.stacks.keys()].join(', ')}.` : ''}`);
      return 0;
    }
    for (const st of running) {
      const res = await this.o.runtime.compose({ ...this.o.owner, project: this.project(st), compose: st.running!.model, call: { verb: 'ps' } });
      if (res.code !== 0) return fail(`Could not list ${st.cfg.key}: ${lastLines(res.stderr)}`);
      const rows = parsePs(res.stdout.toString('utf8'));
      say(`${st.cfg.key} (${st.cfg.from})`);
      for (const r of rows) say(`  ${r.service.padEnd(24)} ${r.state}${r.health ? ` (${r.health})` : ''}${r.exitCode != null && r.state === 'exited' ? ` exit ${r.exitCode}` : ''}`);
      if (st.status.forwards.length > 0) say(`  localhost: ${st.status.forwards.map((f) => `${f.port} → ${f.service}`).join(', ')}`);
    }
    return 0;
  }

  private async logs(words: readonly string[], out: Out, fail: (t: string, code?: number) => number): Promise<number> {
    let tail = 200;
    const rest: string[] = [];
    for (let i = 0; i < words.length; i++) {
      const w = words[i]!;
      if (w === '--tail' || w === '-n') {
        tail = Number.parseInt(words[++i] ?? '', 10);
        if (!Number.isInteger(tail) || tail < 1) return fail('`--tail` takes a number.', 2);
      } else rest.push(w);
    }
    if (rest.length !== 1) return fail('Name one service: `limn-svc logs <service>`.', 2);
    const resolved = this.resolve(rest, fail);
    if (typeof resolved === 'number') return resolved;
    const [st, svcs] = [...resolved][0]!;
    if (!st.running) return fail(`${st.cfg.key} is not running.`);
    const svc = svcs?.[0];
    if (!svc) return fail('Name one service: `limn-svc logs <service>`.', 2);
    const res = await this.o.runtime.compose({ ...this.o.owner, project: this.project(st), compose: st.running.model, call: { verb: 'logs', service: svc, tail: Math.min(tail, 2000) } });
    out('o', res.stdout.toString('utf8'));
    if (res.code !== 0) return fail(lastLines(res.stderr) || `exit ${res.code}`);
    return 0;
  }

  private async run(words: readonly string[], out: Out, fail: (t: string, code?: number) => number): Promise<number> {
    const [target, ...command] = words;
    if (!target) return fail('Name a service: `limn-svc run <service> [command …]`.', 2);
    const resolved = this.resolve([target], fail);
    if (typeof resolved === 'number') return resolved;
    const [st, svcs] = [...resolved][0]!;
    const svc = svcs?.[0];
    if (!svc) return fail('Name a service, not a file: `limn-svc run <service>`.', 2);
    const r = await this.police(st);
    if (!r.ok) return fail(`${st.cfg.from} was refused:\n${r.reasons.map((x) => `  - ${x}`).join('\n')}`);
    if (!r.stack.services.some((s) => s.name === svc)) return fail(`${st.cfg.from} has no service called \`${svc}\`.`, 2);
    const unbuilt = r.stack.services.find((s) => s.name === svc && s.build && !s.built);
    if (unbuilt) return fail(`Build it first: \`limn-svc build ${svc}\`.`);
    if (r.stack.bindDirs.length > 0) {
      await this.o.runtime.run(this.o.sandbox, ['sh', '-c', 'for p; do [ -e "$p" ] || mkdir -p -- "$p"; done', 'sh', ...r.stack.bindDirs], { timeoutMs: 30_000 });
    }
    const res = await this.o.runtime.compose({
      ...this.o.owner,
      project: this.project(st),
      compose: r.stack.model,
      call: { verb: 'run', service: svc, command },
      onLine: (l) => {
        this.o.onOutput?.(l);
        out('o', `${l}\n`);
      },
    });
    if (res.code !== 0 && res.stderr) out('e', `${lastLines(res.stderr, 10)}\n`);
    return res.code ?? 1;
  }

  private async build(words: readonly string[], cwd: string, say: (t: string) => void, fail: (t: string, code?: number) => number): Promise<number> {
    let dockerfile: string | null = null;
    let target: string | null = null;
    const pos: string[] = [];
    for (let i = 0; i < words.length; i++) {
      const w = words[i]!;
      if (w === '--file' || w === '-f') dockerfile = words[++i] ?? '';
      else if (w === '--target') target = words[++i] ?? '';
      else pos.push(w);
    }
    if (pos.length < 1 || pos.length > 2) return fail('Usage: `limn-svc build <service> [folder] [--file Dockerfile] [--target stage]`.', 2);
    const resolved = this.resolve([pos[0]!], fail);
    if (typeof resolved === 'number') return resolved;
    const [st, svcs] = [...resolved][0]!;
    const svc = svcs?.[0];
    if (!svc) return fail('Name a service, not a file.', 2);
    const r = await this.police(st);
    if (!r.ok) return fail(`${st.cfg.from} was refused:\n${r.reasons.map((x) => `  - ${x}`).join('\n')}`);
    const policed = r.stack.services.find((s) => s.name === svc);
    if (!policed) return fail(`${st.cfg.from} has no service called \`${svc}\`.`, 2);
    const base = cwd && posix.isAbsolute(cwd) ? cwd : this.o.workspaceRoot;
    const context = pos[1] ? posix.resolve(base, pos[1]) : policed.build?.context ?? null;
    if (!context) return fail(`\`${svc}\` has no build section. Name the folder to build from: \`limn-svc build ${svc} <folder>\`.`, 2);
    if (!insideRoot(this.o.workspaceRoot, context)) return fail(`${context} is outside the session's workspace.`, 2);
    const file = dockerfile ?? (pos[1] ? 'Dockerfile' : policed.build?.dockerfile ?? 'Dockerfile');
    const stage = target ?? (pos[1] ? null : policed.build?.target ?? null);
    say(`Building ${svc} from ${posix.relative(this.o.workspaceRoot, context) || '.'} …`);
    const b = await this.buildService(st, svc, context, file, stage, pos[1] ? {} : policed.build?.args ?? {}, say);
    if (!b.ok) return fail(b.reason);
    say(`Built ${b.tag}.${st.running ? ` Run \`limn-svc up ${st.cfg.key}/${svc}\` to use it.` : ` \`limn-svc up\` uses it.`}`);
    return 0;
  }

  private async buildService(
    st: StackState,
    svc: string,
    context: string,
    dockerfile: string,
    target: string | null,
    args: Record<string, string>,
    say: (t: string) => void,
  ): Promise<{ ok: true; tag: string } | { ok: false; reason: string }> {
    const tag = this.tagFor(st, svc, ++st.buildCount);
    let last = '';
    const res: ExecResult = await this.o.runtime.buildImage({
      ...this.o.owner,
      tag,
      from: { container: this.o.sandbox, dir: context },
      dockerfile,
      ...(target ? { target } : {}),
      buildArgs: args,
      allowedRegistries: this.o.allowedRegistries ?? DEFAULT_ALLOWED_REGISTRIES,
      network: this.o.network,
      proxyUrl: this.o.proxyUrl ?? PROXY_URL,
      memoryBytes: this.limits.perServiceMemoryBytes * 2,
      onLine: (l) => {
        this.o.onOutput?.(l);
        if (/^Step \d+\/\d+ :/.test(l)) {
          say(`  ${l.slice(0, 160)}`);
          last = l;
        }
      },
    });
    if (res.code !== 0) {
      const why = lastLines(res.stderr, 6) || `exit ${res.code}`;
      return { ok: false, reason: `Building ${svc} failed${last ? ` at "${last.slice(0, 120)}"` : ''}:\n${why}` };
    }
    st.built.set(svc, tag);
    this.setState(st, { builtImages: [...st.built].map(([service, t]) => ({ service, tag: t })) });
    return { ok: true, tag };
  }

  private outputSink(): { onLine?: (l: string) => void } {
    return this.o.onOutput ? { onLine: this.o.onOutput } : {};
  }

  /** The union of the running files' forwards → the relay. */
  private async applyForwards(): Promise<{ listening: number[]; failed: { port: number; reason: string }[] }> {
    const all: Forward[] = [];
    for (const st of this.stacks.values()) for (const f of st.running?.forwards ?? []) if (!all.some((g) => g.port === f.port)) all.push(f);
    if (!this.forwarder) return { listening: [], failed: all.map((f) => ({ port: f.port, reason: 'no relay' })) };
    return this.forwarder(all);
  }

  /** Stop every running file (discard). The session's `runtime.destroy` removes whatever is left. */
  async stopAll(): Promise<void> {
    await this.serial(async () => {
      for (const st of this.stacks.values()) {
        if (!st.running) continue;
        await this.o.runtime.compose({ ...this.o.owner, project: this.project(st), compose: st.running.model, call: { verb: 'down' } });
        st.running = null;
        st.status = { ...st.status, state: 'stopped', forwards: [] };
      }
      this.emit();
    });
  }
}

function lastLines(text: string, n = 4): string {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-n)
    .join('\n');
}

export interface PsRow {
  service: string;
  state: string;
  health: string | null;
  exitCode: number | null;
}

/** `docker compose ps --format json`: one object per line (Compose 2.21+), or one array (older). */
export function parsePs(text: string): PsRow[] {
  const rows: unknown[] = [];
  const t = text.trim();
  if (t.startsWith('[')) {
    try {
      rows.push(...(JSON.parse(t) as unknown[]));
    } catch {
      /* unreadable */
    }
  } else {
    for (const l of t.split('\n')) {
      try {
        if (l.trim()) rows.push(JSON.parse(l));
      } catch {
        /* skip */
      }
    }
  }
  return rows
    .filter((r): r is Record<string, unknown> => r != null && typeof r === 'object')
    .map((r) => ({
      service: String(r.Service ?? r.Name ?? ''),
      state: String(r.State ?? ''),
      health: typeof r.Health === 'string' && r.Health ? r.Health : null,
      exitCode: typeof r.ExitCode === 'number' ? r.ExitCode : null,
    }))
    .sort((a, b) => a.service.localeCompare(b.service));
}
