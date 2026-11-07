// THE DOCKER ADAPTER over a SCRIPTED CLI: every argv it sends is recorded, every answer is canned, so
// the decisions (detection, which image, what the sweep removes) are pinned without a daemon. The real
// daemon is exercised by docker-real.test.ts (the slow project).
import { describe, expect, it } from 'vitest';
import { EventQueue, type CliRunner } from './cli.js';
import { createDockerRuntime, parseSize } from './docker.js';
import type { ExecEvent, ExecHandle, ExecResult } from './types.js';

type Answer = Partial<ExecResult> & { stdoutText?: string };

function scripted(answers: [RegExp, Answer | ((args: string[], input?: string) => Answer)][]): CliRunner & { calls: { args: string[]; input?: string }[] } {
  const calls: { args: string[]; input?: string }[] = [];
  const answer = (args: string[], input?: string): ExecResult => {
    const joined = args.join(' ');
    const hit = answers.find(([re]) => re.test(joined));
    const a = hit ? (typeof hit[1] === 'function' ? hit[1](args, input) : hit[1]) : { code: 1, stderr: `unscripted: ${joined}` };
    return { code: a.code ?? 0, stdout: a.stdout ?? Buffer.from(a.stdoutText ?? ''), stderr: a.stderr ?? '', timedOut: a.timedOut ?? false };
  };
  const spawn = (args: string[], opts: { input?: string | Buffer } = {}): ExecHandle => {
    const input = opts.input === undefined ? undefined : String(opts.input);
    calls.push({ args, ...(input !== undefined ? { input } : {}) });
    const r = answer(args, input);
    const q = new EventQueue<ExecEvent>();
    if (r.stdout.length) q.push({ type: 'stdout', data: r.stdout });
    if (r.stderr) q.push({ type: 'stderr', data: Buffer.from(r.stderr) });
    q.push({ type: 'exit', code: r.code, signal: null, timedOut: r.timedOut });
    q.close();
    return { events: q, write: () => undefined, end: () => undefined, kill: () => undefined, done: Promise.resolve({ code: r.code, signal: null, timedOut: r.timedOut }) };
  };
  return {
    program: '/usr/local/bin/docker',
    calls,
    spawn,
    run: async (args, opts = {}) => {
      const h = spawn(args, opts);
      const out: Buffer[] = [];
      let stderr = '';
      for await (const ev of h.events) {
        if (ev.type === 'stdout') out.push(ev.data);
        if (ev.type === 'stderr') stderr += ev.data.toString();
      }
      const d = await h.done;
      return { code: d.code, stdout: Buffer.concat(out), stderr, timedOut: d.timedOut };
    },
  };
}

const DESKTOP_INFO = JSON.stringify({ Name: 'docker-desktop', OperatingSystem: 'Docker Desktop', OSType: 'linux', Architecture: 'x86_64', MemTotal: 6736011264, NCPU: 12, SecurityOptions: ['name=seccomp,profile=builtin'], ServerVersion: '29.6.2' });
const recipe = { recipe: '0123456789abcdef', buildArgs: { CLAUDE_CODE_VERSION: '2.1.295', CODEX_VERSION: '0.164.0' }, localTag: 'limn-sandbox:local-0123456789abcdef', contextDir: '/ctx' };
const pin = { repository: 'ghcr.io/alexwakeman/limn-sandbox', tag: '1.0.12', digest: `sha256:${'a'.repeat(64)}`, recipe: '0123456789abcdef' };

describe('detect', () => {
  it('Docker Desktop: available, with the licence line', async () => {
    const cli = scripted([[/^version/, { stdoutText: '29.6.2\n' }], [/^context show/, { stdoutText: 'desktop-linux\n' }], [/^info/, { stdoutText: DESKTOP_INFO }]]);
    const d = await createDockerRuntime({ runner: cli }).detect();
    expect(d).toMatchObject({ available: true, daemonReachable: true, flavour: 'docker-desktop', arch: 'x86_64', memoryBytes: 6736011264, cpus: 12, rootless: false, cliVersion: '29.6.2', problem: null });
    expect(d.licenceNote).toMatch(/250 employees/);
  });

  it('Colima by context, Podman by its own info shape, rootless Docker', async () => {
    const colima = scripted([[/^version/, { stdoutText: '27\n' }], [/^context show/, { stdoutText: 'colima\n' }], [/^info/, { stdoutText: JSON.stringify({ Name: 'colima', OperatingSystem: 'Ubuntu 24.04', OSType: 'linux', Architecture: 'aarch64', ServerVersion: '27.4' }) }]]);
    expect(await createDockerRuntime({ runner: colima }).detect()).toMatchObject({ flavour: 'colima', licenceNote: null, available: true });
    const podman = scripted([[/^version/, { stdoutText: '5.2\n' }], [/^info/, { stdoutText: JSON.stringify({ host: { arch: 'amd64', os: 'linux', memTotal: 8e9, cpus: 4, security: { rootless: true } }, version: { Version: '5.2.0' } }) }]]);
    expect(await createDockerRuntime({ runner: podman, cli: 'podman' }).detect()).toMatchObject({ flavour: 'podman', rootless: true, serverVersion: '5.2.0' });
    expect(podman.calls.some((c) => c.args[0] === 'context')).toBe(false);
    const rootless = scripted([[/^version/, {}], [/^context/, {}], [/^info/, { stdoutText: JSON.stringify({ Name: 'box', OperatingSystem: 'Debian', OSType: 'linux', ServerVersion: '28', SecurityOptions: ['name=rootless'] }) }]]);
    expect(await createDockerRuntime({ runner: rootless }).detect()).toMatchObject({ flavour: 'docker-engine', rootless: true });
  });

  it('a stopped daemon and a missing CLI each say what to do, in one line', async () => {
    const stopped = scripted([[/^version/, { stdoutText: '29\n' }], [/^context/, {}], [/^info/, { code: 1, stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock' }]]);
    const d = await createDockerRuntime({ runner: stopped }).detect();
    expect(d).toMatchObject({ available: false, daemonReachable: false });
    expect(d.problem).toMatch(/not running/);
    const missing = await createDockerRuntime({ cli: 'definitely-not-a-cli-limn', env: { PATH: '/nonexistent' } }).detect();
    expect(missing).toMatchObject({ available: false, cli: null });
    expect(missing.problem).toMatch(/No container runtime/);
  });
});

describe('ensureImage', () => {
  it('uses a local image whose recipe label matches', async () => {
    const cli = scripted([[/^image inspect/, { stdoutText: '0123456789abcdef\n' }]]);
    expect(await createDockerRuntime({ runner: cli, recipe, pin }).ensureImage()).toEqual({ ref: recipe.localTag, source: 'local' });
    expect(cli.calls.map((c) => c.args[0])).toEqual(['image']);
  });

  it('pulls the pinned image BY DIGEST and tags it locally', async () => {
    let tagged = false;
    const cli = scripted([
      [/^image inspect/, () => ({ stdoutText: tagged ? '0123456789abcdef\n' : '', code: tagged ? 0 : 1 })],
      [/^pull /, { stdoutText: 'Digest: ok\n' }],
      [/^tag /, () => ((tagged = true), {})],
    ]);
    const progress: string[] = [];
    expect(await createDockerRuntime({ runner: cli, recipe, pin }).ensureImage({ onProgress: (p) => progress.push(p.phase) })).toEqual({ ref: recipe.localTag, source: 'pulled' });
    expect(cli.calls.find((c) => c.args[0] === 'pull')?.args).toEqual(['pull', `ghcr.io/alexwakeman/limn-sandbox@sha256:${'a'.repeat(64)}`]);
    expect(progress).toContain('pull');
  });

  it('builds locally when the pull fails, or when the pin is for another recipe', async () => {
    const failing = scripted([[/^image inspect/, { code: 1 }], [/^pull /, { code: 1, stderr: 'denied' }], [/^build /, { stderr: '#1 done\n' }]]);
    expect(await createDockerRuntime({ runner: failing, recipe, pin }).ensureImage()).toEqual({ ref: recipe.localTag, source: 'built' });
    const build = failing.calls.find((c) => c.args[0] === 'build')!.args;
    expect(build).toEqual(['build', '--tag', recipe.localTag, '--build-arg', 'CLAUDE_CODE_VERSION=2.1.295', '--build-arg', 'CODEX_VERSION=0.164.0', '--build-arg', 'LIMN_RECIPE=0123456789abcdef', '/ctx']);
    const other = scripted([[/^image inspect/, { code: 1 }], [/^build /, {}]]);
    await createDockerRuntime({ runner: other, recipe, pin: { ...pin, recipe: 'ffffffffffffffff' } }).ensureImage();
    expect(other.calls.some((c) => c.args[0] === 'pull')).toBe(false);
  });

  it('a failed build is an error naming the last lines', async () => {
    const cli = scripted([[/^image inspect/, { code: 1 }], [/^build /, { code: 1, stderr: 'step 3\nERROR: npm install failed\n' }]]);
    await expect(createDockerRuntime({ runner: cli, recipe, pin: null }).ensureImage()).rejects.toThrow(/npm install failed/);
  });
});

describe('sweep and destroy', () => {
  const inventory = (): [RegExp, Answer | ((a: string[]) => Answer)][] => [
    [/^ps --all --filter label=limn\.managed=1/, { stdoutText: 'limn-a-sandbox\nlimn-a-proxy\nlimn-b-sandbox\nlimn-gone-sandbox\n' }],
    // `limn-gone-sandbox` vanished between the list and the inspect: it prints NOTHING, and must not
    // shift the pairing of the names after it.
    [/^container inspect/, { stdoutText: '/limn-a-sandbox\ta\n/limn-a-proxy\ta\n/limn-b-sandbox\tb\n' }],
    [/^network ls --filter label=limn\.managed=1/, { stdoutText: 'limn-a-net\nlimn-b-net\n' }],
    [/^network inspect/, { stdoutText: 'limn-a-net\ta\nlimn-b-net\tb\n' }],
    [/^volume ls --filter label=limn\.managed=1/, { stdoutText: '' }],
    [/^image ls --filter label=limn\.managed=1/, { stdoutText: '' }],
    [/^(rm|network rm|volume rm) /, {}],
  ];

  it('removes only what no live session owns, containers before networks', async () => {
    const cli = scripted(inventory());
    const r = await createDockerRuntime({ runner: cli, instance: '1' }).sweep(['b']);
    expect(r).toEqual({ containers: ['limn-a-sandbox', 'limn-a-proxy'], networks: ['limn-a-net'], volumes: [], images: [], errors: [] });
    const removals = cli.calls.filter((c) => /^(rm|network)$/.test(c.args[0]!) && c.args.includes('--force') || c.args[1] === 'rm').map((c) => c.args.join(' '));
    expect(removals).toEqual(['rm --force --volumes limn-a-sandbox', 'rm --force --volumes limn-a-proxy', 'network rm limn-a-net']);
  });

  it('a dry run lists without removing; destroy takes one session', async () => {
    const dry = scripted(inventory());
    expect((await createDockerRuntime({ runner: dry, instance: '1' }).sweep([], { dryRun: true })).containers).toEqual(['limn-a-sandbox', 'limn-a-proxy', 'limn-b-sandbox']);
    expect(dry.calls.some((c) => c.args[0] === 'rm')).toBe(false);
    const cli = scripted(inventory());
    expect(await createDockerRuntime({ runner: cli, instance: '1' }).destroy('b')).toEqual({ containers: ['limn-b-sandbox'], networks: ['limn-b-net'], volumes: [], images: [], errors: [] });
  });

  it('the app instance is keyed on the data dir', async () => {
    const { appInstance } = await import('./labels.js');
    expect(appInstance({ LIMN_DATA_DIR: '/a' })).toMatch(/^d[0-9a-f]{12}$/);
    expect(appInstance({ LIMN_DATA_DIR: '/a' })).not.toBe(appInstance({ LIMN_DATA_DIR: '/b' }));
  });

  it("a test instance's sweep filters on its own label value", async () => {
    const cli = scripted([[/./, { stdoutText: '' }]]);
    await createDockerRuntime({ runner: cli, instance: 'test-1' }).sweep([]);
    expect(cli.calls.every((c) => c.args.includes('label=limn.managed=test-1'))).toBe(true);
  });
});

describe('containers', () => {
  it('starts the proxy on the bridge, then joins the internal network under its alias', async () => {
    const cli = scripted([[/^version/, {}], [/^context/, {}], [/^info/, { stdoutText: DESKTOP_INFO }], [/^run /, {}], [/^network connect/, {}]]);
    const rt = createDockerRuntime({ runner: cli, extraLabels: { 'limn.test': '1' } });
    const h = await rt.startProxy({ sessionId: 's1', accountId: 1, image: 'img', network: 'limn-s1-net', alias: 'limn-proxy', source: 'x', env: {} });
    expect(h.name).toBe('limn-s1-proxy');
    const run = cli.calls.find((c) => c.args[0] === 'run')!.args;
    expect(run).toContain('limn.test=1');
    expect(run.slice(run.indexOf('--network'), run.indexOf('--network') + 2)).toEqual(['--network', 'bridge']);
    expect(cli.calls.find((c) => c.args[0] === 'network')!.args).toEqual(['network', 'connect', '--alias', 'limn-proxy', 'limn-s1-net', 'limn-s1-proxy']);
  });

  it('removes the proxy again when it cannot join the session network', async () => {
    const cli = scripted([[/^version/, {}], [/^context/, {}], [/^info/, { stdoutText: DESKTOP_INFO }], [/^run /, {}], [/^network connect/, { code: 1, stderr: 'no such network' }], [/^rm /, {}]]);
    await expect(createDockerRuntime({ runner: cli }).startProxy({ sessionId: 's1', accountId: 1, image: 'i', network: 'n', alias: 'limn-proxy', source: 'x', env: {} })).rejects.toThrow(/no such network/);
    expect(cli.calls.at(-1)!.args).toEqual(['rm', '--force', 'limn-s1-proxy']);
  });

  it('a new volume is chowned to the agent by a CHOWN-only root step', async () => {
    // No image ensured yet: the volume step ensures it first (here: found locally).
    const cli = scripted([[/^image inspect/, { stdoutText: '0123456789abcdef' }], [/^volume create/, {}], [/^run --rm/, {}]]);
    const rt = createDockerRuntime({ runner: cli, recipe, pin: null });
    expect(await rt.createVolume({ sessionId: 's1', accountId: 1 }, 'work')).toBe('limn-s1-vol-work');
    const step = cli.calls.find((c) => c.args[0] === 'run')!.args.join(' ');
    expect(step).toContain('--user root --cap-drop ALL --cap-add CHOWN');
    expect(step).toContain(`type=volume,src=limn-s1-vol-work,dst=/v ${recipe.localTag} chown agent:agent /v`);
  });

  it('exec, copyIn and readFile run as the agent', async () => {
    const cli = scripted([
      [/^exec .* tar -x/, (_a, input) => ({ code: input && input.length % 512 === 0 ? 0 : 1 })],
      [/^exec .* sh -c/, (a) => (a.includes('/missing') ? { code: 44 } : { stdoutText: 'content' })],
      [/^exec /, { stdoutText: 'hi' }],
    ]);
    const rt = createDockerRuntime({ runner: cli });
    const r = await rt.run('box', ['echo', 'hi'], { cwd: '/work', env: { A: '1' } });
    expect(String(r.stdout)).toBe('hi');
    expect(cli.calls[0]!.args).toEqual(['exec', '--user', 'agent', '--workdir', '/work', '--env', 'A=1', 'box', 'echo', 'hi']);
    await rt.copyIn('box', [{ path: '/home/agent/x', content: 'y' }]);
    expect(cli.calls[1]!.args.slice(0, 4)).toEqual(['exec', '--interactive', '--user', 'agent']);
    expect(String(await rt.readFile('box', '/home/agent/x'))).toBe('content');
    expect(await rt.readFile('box', '/missing')).toBeNull();
  });

  it('maps network members and parses stats', async () => {
    const cli = scripted([
      [/^network inspect/, { stdoutText: JSON.stringify({ abc: { Name: 'limn-s1-sandbox', IPv4Address: '172.30.0.3/16' }, def: { Name: 'limn-s1-proxy', IPv4Address: '172.30.0.2/16' } }) }],
      [/^ps /, { stdoutText: 'limn-s1-sandbox\tsandbox\n' }],
      [/^stats /, { stdoutText: JSON.stringify({ Name: 'limn-s1-sandbox', CPUPerc: '12.5%', MemUsage: '1.5GiB / 8GiB' }) }],
    ]);
    const rt = createDockerRuntime({ runner: cli });
    expect([...(await rt.networkMembers('n'))]).toEqual([['172.30.0.3', 'limn-s1-sandbox'], ['172.30.0.2', 'limn-s1-proxy']]);
    expect(await rt.stats('s1')).toEqual([{ name: 'limn-s1-sandbox', role: 'sandbox', cpuPercent: 12.5, memoryBytes: 1.5 * 1024 ** 3, memoryLimitBytes: 8 * 1024 ** 3 }]);
  });
});

describe('parseSize', () => {
  it('reads docker stats units', () => {
    expect(parseSize('12MiB')).toBe(12 * 1024 ** 2);
    expect(parseSize('1.5kB')).toBe(1500);
    expect(parseSize('512B')).toBe(512);
    expect(parseSize('junk')).toBeNull();
  });
});
