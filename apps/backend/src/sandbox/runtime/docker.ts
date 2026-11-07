// THE DOCKER BACKEND (docs/SANDBOX.md § The runtime layer): the `docker` CLI, no SDK, no socket of our
// own. `SANDBOX_CLI=podman` (or Settings) names Podman, which takes the same verbs. Every argv is built
// by spec.ts / image.ts; every resource is labelled (labels.ts); every call has a timeout except the
// image pull/build, which the caller can cancel.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { findOnPath } from '../../coding/checks/sandbox.js';
import { collect, createCliRunner, type CliRunner } from './cli.js';
import { bridgeNetworkFor, daemonProblem, licenceNoteFor, notInstalled, parseInfo } from './detect.js';
import { DockerfileTap } from './dockerfile.js';
import { buildArgv, imageRecipe, pinnedPullRef, readImagePin, RECIPE_LABEL, type ImagePin, type ImageRecipe } from './image.js';
import { appInstance, LABEL_MANAGED, LABEL_ROLE, LABEL_SESSION, labelArgs, resourceLabels, resourceName, type ResourceRole } from './labels.js';
import { composeArgs, proxyRunArgs, sandboxRunArgs, SANDBOX_USER, serviceBuildArgv, volumeChownArgs } from './spec.js';
import { tarFiles } from './tar.js';
import type {
  ComposeCall,
  ContainerStats,
  EnsuredImage,
  ExecHandle,
  ExecOptions,
  ExecResult,
  ImageBuildSpec,
  ImageProgress,
  RuntimeDetection,
  RuntimeFlavour,
  SandboxRuntime,
  SessionOwner,
  SweepResult,
} from './types.js';

export interface DockerRuntimeOptions {
  /** The CLI: a name on PATH or an absolute path. Default `SANDBOX_CLI`, else `docker`. */
  cli?: string;
  env?: NodeJS.ProcessEnv;
  /** Test seam: a scripted CLI. */
  runner?: CliRunner;
  /** The `limn.managed` label value (labels.ts). Default: this data dir's (`appInstance`). */
  instance?: string;
  /** Labels added to every resource (tests add `limn.test=1`). */
  extraLabels?: Record<string, string>;
  /** Test seams for the image decision. */
  recipe?: ImageRecipe | null;
  pin?: ImagePin | null;
}

const LIST_TIMEOUT = 20_000;
const CREATE_TIMEOUT = 60_000;

function lines(buf: Buffer | string): string[] {
  return String(buf)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/** One output line without its colour codes or carriage return (the classic builder colours stderr). */
export function plainLine(line: string): string {
  // eslint-disable-next-line no-control-regex
  return line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\r$/, '');
}

function lastLines(text: string, n = 6): string {
  return lines(text).slice(-n).join('\n');
}

/** "12.5MiB" → bytes. */
export function parseSize(text: string): number | null {
  const m = /^([\d.]+)\s*([kKmMgGtT]?i?)B$/.exec(text.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] ?? '').toLowerCase();
  const pow = { '': 0, k: 1, ki: 1, m: 2, mi: 2, g: 3, gi: 3, t: 4, ti: 4 }[unit];
  if (pow === undefined || !Number.isFinite(n)) return null;
  const base = unit.endsWith('i') || unit === '' ? 1024 : 1000;
  return Math.round(n * base ** pow);
}

export function resolveCliProgram(opts: { cli?: string; env?: NodeJS.ProcessEnv } = {}): string | null {
  const env = opts.env ?? process.env;
  const name = opts.cli ?? (env.SANDBOX_CLI?.trim() || 'docker');
  if (isAbsolute(name)) return name;
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return null;
  return findOnPath(name, env.PATH ?? '');
}

export function createDockerRuntime(opts: DockerRuntimeOptions = {}): SandboxRuntime {
  const env = opts.env ?? process.env;
  const program = opts.runner ? opts.runner.program : resolveCliProgram(opts);
  const cliName = (opts.cli ?? (env.SANDBOX_CLI?.trim() || 'docker')).split('/').pop() ?? 'docker';
  const runner: CliRunner | null = opts.runner ?? (program ? createCliRunner(program, env) : null);
  const instance = opts.instance ?? appInstance(env);
  const extraLabels = opts.extraLabels ?? {};
  let flavour: RuntimeFlavour | null = null;
  let imageRef: string | null = null;

  const cli = (): CliRunner => {
    if (!runner) throw new Error(notInstalled(cliName).problem ?? 'No container runtime');
    return runner;
  };
  const run = (args: string[], o: { input?: string | Buffer; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<ExecResult> =>
    cli().run(args, { timeoutMs: o.timeoutMs ?? CREATE_TIMEOUT, ...(o.input !== undefined ? { input: o.input } : {}), ...(o.signal ? { signal: o.signal } : {}) });
  const must = async (args: string[], what: string, o: { input?: string | Buffer; timeoutMs?: number } = {}): Promise<ExecResult> => {
    const r = await run(args, o);
    if (r.code !== 0) throw new Error(`${what} failed: ${r.timedOut ? 'timed out' : lastLines(r.stderr) || `exit ${r.code}`}`);
    return r;
  };
  const labelsFor = (owner: SessionOwner, role: ResourceRole) => resourceLabels(instance, owner, role, extraLabels);
  const managedFilter = ['--filter', `label=${LABEL_MANAGED}=${instance}`];

  async function detect(): Promise<RuntimeDetection> {
    if (!runner) return notInstalled(cliName);
    const version = await runner.run(['version', '--format', '{{.Client.Version}}'], { timeoutMs: 15_000 });
    const context = /podman/i.test(cliName) ? null : await runner.run(['context', 'show'], { timeoutMs: 10_000 });
    const info = await runner.run(['info', '--format', 'json'], { timeoutMs: 20_000 });
    const base = {
      kind: 'docker' as const,
      cli: program,
      cliVersion: lines(version.stdout)[0] ?? null,
    };
    const parsed = info.code === 0 ? parseInfo(String(info.stdout), { cliName, context: context?.code === 0 ? lines(context.stdout)[0] ?? null : null }) : null;
    if (!parsed) {
      return {
        ...base,
        available: false,
        daemonReachable: false,
        serverVersion: null,
        os: null,
        arch: null,
        memoryBytes: null,
        cpus: null,
        rootless: null,
        flavour: /podman/i.test(cliName) ? 'podman' : 'unknown',
        licenceNote: null,
        problem: info.timedOut ? `${cliName} did not answer in time.` : daemonProblem(info.stderr, cliName),
      };
    }
    flavour = parsed.flavour;
    const linux = parsed.os === null || /linux/i.test(parsed.os);
    return {
      ...base,
      ...parsed,
      available: linux,
      daemonReachable: true,
      licenceNote: licenceNoteFor(parsed.flavour),
      problem: linux ? null : `${cliName} is running ${parsed.os} containers. Switch it to Linux containers.`,
    };
  }

  async function imageRecipeLabel(ref: string): Promise<string | null> {
    const r = await run(['image', 'inspect', '--format', `{{index .Config.Labels "${RECIPE_LABEL}"}}`, ref], { timeoutMs: LIST_TIMEOUT });
    return r.code === 0 ? (lines(r.stdout)[0] ?? null) : null;
  }

  async function streamed(args: string[], phase: ImageProgress['phase'], o: { onProgress?: (p: ImageProgress) => void; signal?: AbortSignal }): Promise<ExecResult> {
    const h = cli().spawn(args, o.signal ? { signal: o.signal } : {});
    let tail = '';
    const out: Buffer[] = [];
    for await (const ev of h.events) {
      if (ev.type === 'exit') continue;
      if (ev.type === 'stdout') out.push(ev.data);
      const text = ev.data.toString('utf8');
      if (ev.type === 'stderr') tail = (tail + text).slice(-8_000);
      for (const line of lines(text)) o.onProgress?.({ phase, line });
    }
    const d = await h.done;
    return { code: d.code, stdout: Buffer.concat(out), stderr: tail, timedOut: d.timedOut };
  }

  async function ensureImage(o: { onProgress?: (p: ImageProgress) => void; signal?: AbortSignal } = {}): Promise<EnsuredImage> {
    const recipe = opts.recipe === undefined ? imageRecipe() : opts.recipe;
    if (!recipe) throw new Error('The sandbox image recipe is missing (no Dockerfile, or the Claude Code / Codex pins are not exact versions).');
    o.onProgress?.({ phase: 'check', line: `Looking for ${recipe.localTag}` });
    if ((await imageRecipeLabel(recipe.localTag)) === recipe.recipe) {
      imageRef = recipe.localTag;
      return { ref: recipe.localTag, source: 'local' };
    }
    const pullRef = pinnedPullRef(opts.pin === undefined ? readImagePin() : opts.pin, recipe);
    if (pullRef) {
      o.onProgress?.({ phase: 'pull', line: `Downloading ${pullRef}` });
      const pulled = await streamed(['pull', pullRef], 'pull', o);
      if (pulled.code === 0 && (await run(['tag', pullRef, recipe.localTag], { timeoutMs: LIST_TIMEOUT })).code === 0) {
        if ((await imageRecipeLabel(recipe.localTag)) === recipe.recipe) {
          imageRef = recipe.localTag;
          return { ref: recipe.localTag, source: 'pulled' };
        }
      }
      if (o.signal?.aborted) throw new Error('Cancelled');
      o.onProgress?.({ phase: 'pull', line: 'The download did not work. Building the image here instead.' });
    }
    o.onProgress?.({ phase: 'build', line: `Building ${recipe.localTag} (a few minutes, once)` });
    const built = await streamed(buildArgv(recipe), 'build', o);
    if (built.code !== 0) throw new Error(`Building the sandbox image failed: ${lastLines(built.stderr) || `exit ${built.code}`}`);
    imageRef = recipe.localTag;
    return { ref: recipe.localTag, source: 'built' };
  }

  async function bridge(): Promise<string> {
    if (flavour === null) await detect();
    return bridgeNetworkFor(flavour ?? 'unknown');
  }

  const runtime: SandboxRuntime = {
    kind: 'docker',
    detect,
    ensureImage,

    async createNetwork(owner) {
      const name = resourceName(owner.sessionId, 'net');
      await must(['network', 'create', '--internal', ...labelArgs(labelsFor(owner, 'network')), name], 'Creating the session network');
      return { name };
    },

    async createVolume(owner, key) {
      const name = resourceName(owner.sessionId, `vol-${key}`);
      await must(['volume', 'create', ...labelArgs(labelsFor(owner, 'volume')), name], 'Creating a session volume');
      const image = imageRef ?? (await ensureImage()).ref;
      await must(volumeChownArgs(image, name, labelsFor(owner, 'setup')), 'Preparing a session volume', { timeoutMs: 120_000 });
      return name;
    },

    async startProxy(spec) {
      const name = resourceName(spec.sessionId, 'proxy');
      await must(proxyRunArgs(spec, name, labelsFor(spec, 'proxy'), await bridge()), 'Starting the egress proxy');
      const connected = await run(['network', 'connect', '--alias', spec.alias, spec.network, name]);
      if (connected.code !== 0) {
        await run(['rm', '--force', name], { timeoutMs: LIST_TIMEOUT });
        throw new Error(`Connecting the egress proxy failed: ${lastLines(connected.stderr)}`);
      }
      return { name };
    },

    async startSandbox(spec) {
      const name = resourceName(spec.sessionId, 'sandbox');
      await must(sandboxRunArgs(spec, name, labelsFor(spec, 'sandbox')), 'Starting the sandbox');
      return { name };
    },

    exec(container: string, argv: string[], o: ExecOptions = {}): ExecHandle {
      if (argv.length === 0) throw new Error('exec needs a program');
      const stdin = o.input !== undefined || o.interactive === true;
      const args = [
        'exec',
        ...(stdin ? ['--interactive'] : []),
        '--user', o.user ?? SANDBOX_USER,
        ...(o.cwd ? ['--workdir', o.cwd] : []),
        ...Object.entries(o.env ?? {}).flatMap(([k, v]) => {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`Not a valid environment variable name: ${k}`);
          return ['--env', `${k}=${v}`];
        }),
        container,
        ...argv,
      ];
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
      return cli().spawn(['logs', '--follow', container], o.signal ? { signal: o.signal } : {});
    },

    async networkMembers(network) {
      const r = await run(['network', 'inspect', '--format', '{{json .Containers}}', network], { timeoutMs: LIST_TIMEOUT });
      const out = new Map<string, string>();
      if (r.code !== 0) return out;
      try {
        const parsed = JSON.parse(String(r.stdout)) as Record<string, { Name?: string; IPv4Address?: string }> | null;
        for (const c of Object.values(parsed ?? {})) {
          const ip = c.IPv4Address?.split('/')[0];
          if (ip && c.Name) out.set(ip, c.Name);
        }
      } catch {
        /* an empty network prints `{}` or `null`; anything else is ignored */
      }
      return out;
    },

    async compose(call: ComposeCall): Promise<ExecResult> {
      const argv = composeArgs(call.project, call.call, emptyProjectDir());
      const model = call.compose ?? { name: call.project, services: {} };
      return streamedLines(cli().spawn(argv, {
        input: JSON.stringify(model),
        timeoutMs: call.timeoutMs ?? (call.call.verb === 'up' || call.call.verb === 'run' ? 900_000 : 120_000),
        ...(call.signal ? { signal: call.signal } : {}),
      }), call.onLine);
    },

    async buildImage(spec: ImageBuildSpec): Promise<ExecResult> {
      const argv = serviceBuildArgv(spec, labelsFor(spec, 'image'));
      const max = spec.maxContextBytes ?? 1024 ** 3;
      const build = cli().spawn(argv, {
        interactive: true,
        env: { DOCKER_BUILDKIT: '0' },
        timeoutMs: spec.timeoutMs ?? 1_800_000,
        ...(spec.signal ? { signal: spec.signal } : {}),
      });
      // The context leaves the sandbox as a tar, AS THE AGENT (it can read only what the agent can).
      const tar = runtime.exec(spec.from.container, ['tar', '-c', '-f', '-', '--exclude=./.git', '-C', spec.from.dir, '.'], spec.signal ? { signal: spec.signal } : {});
      let bytes = 0;
      let tooBig = false;
      let tarErr = '';
      // The Dockerfile is checked AS IT STREAMS (dockerfile.ts): the daemon starts nothing before the
      // stream ends, and a refused Dockerfile never gets its end.
      const tap = new DockerfileTap(spec.dockerfile);
      let refused: string[] = [];
      const pump = (async () => {
        for await (const ev of tar.events) {
          if (ev.type === 'stdout') {
            bytes += ev.data.length;
            if (bytes > max) {
              tooBig = true;
              tar.kill();
              build.kill();
              break;
            }
            tap.write(ev.data);
            build.write(ev.data);
          } else if (ev.type === 'stderr') {
            tarErr = (tarErr + ev.data.toString('utf8')).slice(-4_000);
          }
        }
        if (!tooBig) {
          refused = (await tar.done).code === 0 ? tap.result(spec.allowedRegistries) : [];
          if (refused.length > 0) {
            build.kill();
            return;
          }
        }
        build.end();
      })();
      const result = await streamedLines(build, spec.onLine);
      await pump;
      const t = await tar.done;
      if (tooBig) return { code: 1, stdout: Buffer.alloc(0), stderr: `The build folder is larger than ${Math.round(max / 1024 ** 2)} MB.`, timedOut: false };
      if (refused.length > 0) return { code: 1, stdout: Buffer.alloc(0), stderr: refused.join('\n'), timedOut: false };
      if (t.code !== 0 && result.code !== 0) return { ...result, stderr: `Reading the build folder failed: ${lastLines(tarErr, 3) || `exit ${t.code}`}\n${result.stderr}` };
      return result;
    },

    async stats(sessionId) {
      const ps = await run(['ps', ...managedFilter, '--filter', `label=${LABEL_SESSION}=${sessionId}`, '--format', `{{.Names}}\t{{.Label "${LABEL_ROLE}"}}`], { timeoutMs: LIST_TIMEOUT });
      const roles = new Map(lines(ps.stdout).map((l) => {
        const [n, role] = l.split('\t');
        return [n ?? '', role || null] as const;
      }));
      if (roles.size === 0) return [];
      const st = await run(['stats', '--no-stream', '--format', '{{json .}}', ...roles.keys()], { timeoutMs: LIST_TIMEOUT });
      const out: ContainerStats[] = [];
      for (const l of lines(st.stdout)) {
        try {
          const row = JSON.parse(l) as { Name?: string; CPUPerc?: string; MemUsage?: string };
          const [used, limit] = (row.MemUsage ?? '').split('/').map((s) => parseSize(s));
          const cpu = Number.parseFloat((row.CPUPerc ?? '').replace('%', ''));
          out.push({
            name: row.Name ?? '',
            role: roles.get(row.Name ?? '') ?? null,
            cpuPercent: Number.isFinite(cpu) ? cpu : null,
            memoryBytes: used ?? null,
            memoryLimitBytes: limit ?? null,
          });
        } catch {
          /* skip a line that is not JSON */
        }
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

  let projectDir: string | null = null;
  /** An EMPTY folder as compose's project directory: no compose file or `.env` of Limn's is read. */
  function emptyProjectDir(): string {
    if (!projectDir) projectDir = mkdtempSync(join(tmpdir(), 'limn-compose-'));
    return projectDir;
  }

  /** Collect a handle, passing each output line on as it arrives. */
  async function streamedLines(h: ExecHandle, onLine?: (line: string) => void): Promise<ExecResult> {
    const out: Buffer[] = [];
    let outBytes = 0;
    let stderr = '';
    let partial = '';
    for await (const ev of h.events) {
      if (ev.type === 'exit') continue;
      if (ev.type === 'stdout') {
        if (outBytes < 16 << 20) out.push(ev.data);
        outBytes += ev.data.length;
      } else {
        stderr = (stderr + ev.data.toString('utf8')).slice(-64_000);
      }
      if (onLine) {
        partial += ev.data.toString('utf8');
        const parts = partial.split('\n');
        partial = parts.pop() ?? '';
        for (const l of parts) if (l.trim()) onLine(plainLine(l));
      }
    }
    if (onLine && partial.trim()) onLine(plainLine(partial));
    const d = await h.done;
    return { code: d.code, stdout: Buffer.concat(out), stderr, timedOut: d.timedOut };
  }

  /** Every managed resource whose `limn.session` label passes `doomed`, removed (or only listed). */
  async function removeWhere(doomed: (session: string) => boolean, dryRun: boolean): Promise<SweepResult> {
    const result: SweepResult = { containers: [], networks: [], volumes: [], images: [], errors: [] };
    if (!runner) return result;
    const kinds = [
      { key: 'containers', list: ['ps', '--all', ...managedFilter, '--format', '{{.Names}}'], inspect: ['container', 'inspect', '--format', `{{.Name}}\t{{index .Config.Labels "${LABEL_SESSION}"}}`], rm: ['rm', '--force', '--volumes'] },
      { key: 'networks', list: ['network', 'ls', ...managedFilter, '--format', '{{.Name}}'], inspect: ['network', 'inspect', '--format', `{{.Name}}\t{{index .Labels "${LABEL_SESSION}"}}`], rm: ['network', 'rm'] },
      { key: 'volumes', list: ['volume', 'ls', ...managedFilter, '--format', '{{.Name}}'], inspect: ['volume', 'inspect', '--format', `{{.Name}}\t{{index .Labels "${LABEL_SESSION}"}}`], rm: ['volume', 'rm', '--force'] },
      // Service images Limn built (services/controller.ts): last, once no container uses them.
      // By short ID: a rebuilt tag leaves the old image untagged (`<none>`), still labelled.
      { key: 'images', list: ['image', 'ls', ...managedFilter, '--format', '{{.ID}}'], inspect: ['image', 'inspect', '--format', `{{printf "%.19s" .Id}}\t{{index .Config.Labels "${LABEL_SESSION}"}}`], rm: ['image', 'rm', '--force'] },
    ] as const;
    for (const k of kinds) {
      const listed = await run([...k.list], { timeoutMs: LIST_TIMEOUT });
      if (listed.code !== 0) {
        result.errors.push(`Listing ${k.key} failed: ${lastLines(listed.stderr, 2)}`);
        continue;
      }
      const names = lines(listed.stdout);
      if (names.length === 0) continue;
      const inspected = await run([...k.inspect, ...names], { timeoutMs: LIST_TIMEOUT });
      // Keyed by NAME, never by line position: a resource removed between the list and the inspect
      // prints nothing, and a positional match would then pair the next name with the wrong session.
      const sessionOf = new Map<string, string>();
      for (const l of lines(inspected.stdout)) {
        const [n, session] = l.split('\t');
        if (n) sessionOf.set(n.replace(/^\//, '').replace(/^sha256:/, ''), session ?? '');
      }
      const doomedNames = names.filter((n) => sessionOf.has(n) && doomed(sessionOf.get(n) ?? ''));
      if (doomedNames.length === 0) continue;
      if (!dryRun) {
        for (const name of doomedNames) {
          const r = await run([...k.rm, name], { timeoutMs: 120_000 });
          if (r.code !== 0) {
            result.errors.push(`${name}: ${lastLines(r.stderr, 2)}`);
            continue;
          }
          result[k.key].push(name);
        }
      } else {
        result[k.key].push(...doomedNames);
      }
    }
    return result;
  }

  return runtime;
}
