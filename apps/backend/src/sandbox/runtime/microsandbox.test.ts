// THE MICROSANDBOX ADAPTER over a SCRIPTED `msb` (no VM): detection, the image order, the session's
// create/setup/relay sequence, exec, the sweep, and the services refusal. One case runs the REAL proxy
// program as a host process on unix sockets (what microsandbox uses), which this machine can do.
// ⚠ `msb` output here is hand-written from the docs; microsandbox-real.test.ts is the real check.
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { proxyProgramSource } from '../proxy/source.js';
import { PROXY_CONFIG_ENV, PROXY_MAIN_ENV } from '../proxy/server.js';
import { EventQueue, type CliRunner } from './cli.js';
import { createAutoRuntime, runtimeChoiceOf } from './index.js';
import { createMicrosandboxRuntime, resolveMsbProgram, SERVICES_NOT_ON_MICROSANDBOX, socketDirFor } from './microsandbox.js';
import { createFakeRuntime } from './fake.js';
import { DEFAULT_RESOURCES, type ExecEvent, type ExecHandle, type ExecResult, type SandboxRuntime } from './types.js';

type Answer = Partial<ExecResult> & { stdoutText?: string };

function scripted(program: string, answers: [RegExp, Answer | ((args: string[]) => Answer)][]): CliRunner & { calls: { args: string[]; input?: string }[]; written: Buffer[] } {
  const calls: { args: string[]; input?: string }[] = [];
  const written: Buffer[] = [];
  const spawn = (args: string[], opts: { input?: string | Buffer } = {}): ExecHandle => {
    const input = opts.input === undefined ? undefined : String(opts.input);
    calls.push({ args, ...(input !== undefined ? { input } : {}) });
    const joined = args.join(' ');
    const hit = answers.find(([re]) => re.test(joined));
    const a = hit ? (typeof hit[1] === 'function' ? hit[1](args) : hit[1]) : { code: 1, stderr: `unscripted: ${joined}` };
    const r = { code: a.code ?? 0, stdout: a.stdout ?? Buffer.from(a.stdoutText ?? ''), stderr: a.stderr ?? '', timedOut: a.timedOut ?? false };
    const q = new EventQueue<ExecEvent>();
    if (r.stdout.length) q.push({ type: 'stdout', data: r.stdout });
    if (r.stderr) q.push({ type: 'stderr', data: Buffer.from(r.stderr) });
    q.push({ type: 'exit', code: r.code, signal: null, timedOut: r.timedOut });
    q.close();
    return { events: q, write: (d) => void written.push(Buffer.from(d)), end: () => undefined, kill: () => undefined, done: Promise.resolve({ code: r.code, signal: null, timedOut: r.timedOut }) };
  };
  return {
    program,
    calls,
    written,
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

const recipe = { recipe: '0123456789abcdef', buildArgs: { CLAUDE_CODE_VERSION: '2.1.295', CODEX_VERSION: '0.164.0' }, localTag: 'limn-sandbox:local-0123456789abcdef', contextDir: '/ctx' };
const pin = { repository: 'ghcr.io/alexwakeman/limn-sandbox', tag: '1.0.12', digest: `sha256:${'a'.repeat(64)}`, recipe: '0123456789abcdef' };
const pullRef = `${pin.repository}@${pin.digest}`;
const owner = { sessionId: 's1', accountId: 1 };
const roots: string[] = [];
const newRoot = (): string => {
  const d = mkdtempSync(join('/tmp', 'limn-msb-'));
  roots.push(d);
  return d;
};
afterAll(() => {
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

/** A ChildProcess stand-in for the proxy: nothing listens; it records how it was started. */
function fakeChild(): { spawnProxy: (s: string, e: Record<string, string>, c: string) => ChildProcess; started: { env: Record<string, string>; cwd: string }[] } {
  const started: { env: Record<string, string>; cwd: string }[] = [];
  return {
    started,
    spawnProxy: (_s, env, cwd) => {
      started.push({ env, cwd });
      const c = new EventEmitter() as unknown as ChildProcess;
      Object.assign(c, { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: () => true, exitCode: null });
      return c;
    },
  };
}

describe('detect', () => {
  it('an Intel Mac is refused without running msb', async () => {
    const cli = scripted('/x/msb', []);
    const d = await createMicrosandboxRuntime({ runner: cli, platform: 'darwin', arch: 'x64' }).detect();
    expect(d).toMatchObject({ kind: 'microsandbox', available: false, flavour: 'microsandbox' });
    expect(d.problem).toMatch(/Apple Silicon/);
    expect(cli.calls).toEqual([]);
  });

  it('healthy when `msb doctor` passes; its failing line otherwise', async () => {
    const ok = scripted('/x/msb', [[/^--version/, { stdoutText: 'msb 0.7.9\n' }], [/^doctor/, { stdoutText: '✓ all good\n' }]]);
    expect(await createMicrosandboxRuntime({ runner: ok, platform: 'linux', arch: 'x64', hasKvm: true }).detect()).toMatchObject({ available: true, cliVersion: '0.7.9', arch: 'x86_64', problem: null });
    const bad = scripted('/x/msb', [[/^--version/, { stdoutText: 'msb 0.7.9\n' }], [/^doctor/, { code: 1, stdoutText: '✗ libkrunfw missing\n' }]]);
    const d = await createMicrosandboxRuntime({ runner: bad, platform: 'darwin', arch: 'arm64' }).detect();
    expect(d.available).toBe(false);
    expect(d.problem).toMatch(/libkrunfw missing/);
  });

  it('not installed: one line', async () => {
    const d = await createMicrosandboxRuntime({ env: { PATH: '/nonexistent', HOME: '/nonexistent' }, platform: 'linux', arch: 'x64', hasKvm: true }).detect();
    expect(d.problem).toMatch(/not installed/);
    expect(resolveMsbProgram({ env: { PATH: '/nonexistent', HOME: '/nonexistent' } })).toBeNull();
  });
});

describe('ensureImage', () => {
  it('uses the cached pinned image, else pulls it by digest', async () => {
    const cached = scripted('/x/msb', [[/^images -q/, { stdoutText: `${pullRef}\n` }]]);
    expect(await createMicrosandboxRuntime({ runner: cached, recipe, pin }).ensureImage()).toEqual({ ref: pullRef, source: 'local' });
    const pull = scripted('/x/msb', [[/^images -q/, { stdoutText: '' }], [/^pull /, { code: 0 }]]);
    expect(await createMicrosandboxRuntime({ runner: pull, recipe, pin }).ensureImage()).toEqual({ ref: pullRef, source: 'pulled' });
    expect(pull.calls.map((c) => c.args.join(' '))).toContain(`pull ${pullRef}`);
  });

  it('a failed pull builds with Docker and loads it: `docker save | msb load --tag`', async () => {
    const msb = scripted('/x/msb', [[/^images -q/, { stdoutText: '' }], [/^pull /, { code: 1, stderr: 'denied' }], [/^load --quiet --tag/, { code: 0 }]]);
    const docker = scripted('/x/docker', [[/^save /, { stdoutText: 'TARBYTES' }]]);
    const fake = createFakeRuntime();
    const r = await createMicrosandboxRuntime({ runner: msb, recipe, pin, dockerFallback: fake, dockerRunner: docker }).ensureImage();
    expect(r).toEqual({ ref: recipe.localTag, source: 'built' });
    expect(docker.calls[0]?.args[0]).toBe('save');
    expect(msb.calls.at(-1)?.args).toEqual(['load', '--quiet', '--tag', recipe.localTag]);
    expect(Buffer.concat(msb.written).toString()).toBe('TARBYTES');
  });

  it('no pull and no Docker: one plain line', async () => {
    const msb = scripted('/x/msb', [[/^images -q/, { stdoutText: '' }]]);
    await expect(createMicrosandboxRuntime({ runner: msb, recipe, pin: null, dockerFallback: null, dockerRunner: null }).ensureImage()).rejects.toThrow(/needs Docker/);
  });
});

describe('a session', () => {
  it('proxy first (host process, 0700 sockets, config carries the sockets), then create → root setup → relay → probe', async () => {
    const root = newRoot();
    const child = fakeChild();
    const msb = scripted('/x/msb', [[/^create /, { code: 0 }], [/^exec /, { code: 0 }]]);
    const rt = createMicrosandboxRuntime({ runner: msb, instance: 'dtest', socketRoot: root, spawnProxy: child.spawnProxy });
    await expect(rt.startSandbox({ ...owner, image: 'img', network: 'n', env: {}, mounts: [], resources: DEFAULT_RESOURCES, workdir: '/w' })).rejects.toThrow(/proxy must be running/);

    const config = { rules: ['registry.npmjs.org'], placeholders: { anthropic: 'pa', chatgpt: 'pc' }, controlToken: 'tok' };
    const proxy = await rt.startProxy({ ...owner, image: 'img', network: 'n', alias: 'limn-proxy', source: 'void 0', env: { [PROXY_MAIN_ENV]: '1', [PROXY_CONFIG_ENV]: JSON.stringify(config) } });
    expect(proxy.name).toBe('limn-s1-proxy');
    const dir = socketDirFor(root, 'dtest', 's1');
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const sent = JSON.parse(child.started[0]?.env[PROXY_CONFIG_ENV] ?? '{}') as Record<string, unknown>;
    expect(sent).toMatchObject({ ...config, exitOnStdinEnd: true, sockets: { forward: join(dir, 'forward.sock'), control: join(dir, 'control.sock') } });
    expect(Object.keys(child.started[0]?.env ?? {}).sort()).toEqual([PROXY_CONFIG_ENV, PROXY_MAIN_ENV].sort());

    const box = await rt.startSandbox({
      ...owner,
      image: 'img',
      network: 'n',
      env: { A: '1' },
      mounts: [{ kind: 'volume', name: 'limn-s1-vol-ws', target: '/Users/a/P' }],
      resources: DEFAULT_RESOURCES,
      workdir: '/Users/a/P',
    });
    expect(box.name).toBe('limn-s1-sandbox');
    const seq = msb.calls.map((c) => c.args);
    expect(seq[0]?.slice(0, 4)).toEqual(['create', '--quiet', '--name', 'limn-s1-sandbox']);
    expect(seq[0]).toEqual(expect.arrayContaining(['--no-net', '--vsock', `${join(dir, 'forward.sock')}:3128`, '--label', 'limn.managed=dtest', '--label', 'limn.role=sandbox']));
    expect(seq[1]).toEqual(expect.arrayContaining(['-u', 'root', 'limn-s1-sandbox', '--', 'sh', '-c']));
    expect(seq[1]?.at(-1)).toBe('/Users/a/P');
    expect(seq[2]).toEqual(expect.arrayContaining(['--detach', '-u', 'agent', 'python3', '-c']));
    expect(seq[3]).toEqual(expect.arrayContaining(['--no-stdin', 'python3', '-c']));

    // The agent's commands get the process cap; the proxy is not exec-able.
    rt.exec('limn-s1-sandbox', ['true']);
    expect(msb.calls.at(-1)?.args).toEqual(expect.arrayContaining(['--rlimit', 'nproc=2048']));
    expect(() => rt.exec('limn-s1-proxy', ['node'])).toThrow(/host process/);

    // Discard: the proxy stops, its folder goes, the VM is removed.
    const ls = JSON.stringify([{ name: 'limn-s1-sandbox', labels: { 'limn.managed': 'dtest', 'limn.session': 's1', 'limn.role': 'sandbox' } }]);
    const msb2 = msb.calls.length;
    const answers = scripted('/x/msb', [[/^ls /, { stdoutText: ls }], [/^rm /, { code: 0 }]]);
    Object.assign(msb, { run: answers.run, spawn: answers.spawn });
    const removed = await rt.destroy('s1');
    expect(removed.containers).toEqual(['limn-s1-proxy', 'limn-s1-sandbox']);
    expect(existsSync(dir)).toBe(false);
    expect(answers.calls.map((c) => c.args.join(' '))).toEqual(['ls --label limn.managed=dtest --format json', 'rm --force --quiet limn-s1-sandbox']);
    expect(msb.calls.length).toBe(msb2);
  });

  it('a relay that never answers removes the VM and fails', async () => {
    const root = newRoot();
    const child = fakeChild();
    const msb = scripted('/x/msb', [[/^create /, { code: 0 }], [/python3 -c import socket, sys/, { code: 1 }], [/^exec /, { code: 0 }], [/^rm /, { code: 0 }]]);
    const rt = createMicrosandboxRuntime({ runner: msb, instance: 'dtest', socketRoot: root, spawnProxy: child.spawnProxy, relayTimeoutMs: 50 });
    await rt.startProxy({ ...owner, image: 'img', network: 'n', alias: 'limn-proxy', source: '', env: { [PROXY_CONFIG_ENV]: '{}' } });
    await expect(rt.startSandbox({ ...owner, image: 'img', network: 'n', env: {}, mounts: [], resources: DEFAULT_RESOURCES, workdir: '/w' })).rejects.toThrow(/Reaching the proxy/);
    expect(msb.calls.at(-1)?.args).toEqual(['rm', '--force', '--quiet', 'limn-s1-sandbox']);
  });

  it('the sweep removes only this instance’s dead sessions', async () => {
    const ls = JSON.stringify([
      { name: 'limn-a-sandbox', labels: { 'limn.managed': 'dtest', 'limn.session': 'a' } },
      { name: 'limn-b-sandbox', labels: { 'limn.managed': 'dtest', 'limn.session': 'b' } },
      { name: 'other', labels: { 'limn.managed': 'dother', 'limn.session': 'c' } },
    ]);
    const msb = scripted('/x/msb', [[/^ls /, { stdoutText: ls }], [/^rm /, { code: 0 }]]);
    const rt = createMicrosandboxRuntime({ runner: msb, instance: 'dtest', socketRoot: newRoot() });
    expect((await rt.sweep(['b'], { dryRun: true })).containers).toEqual(['limn-a-sandbox']);
    expect(msb.calls.some((c) => c.args[0] === 'rm')).toBe(false);
    expect((await rt.sweep(['b'])).containers).toEqual(['limn-a-sandbox']);
  });

  it('a destroy removes only its own socket folder; the sweep keeps every live session\'s', async () => {
    const root = newRoot();
    const { mkdirSync, existsSync } = await import('node:fs');
    const dirs = Object.fromEntries(['a', 'b', 'gone'].map((id) => [id, socketDirFor(root, 'dtest', id)]));
    for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
    // A second runtime object (another backend list) knows none of these proxies.
    const msb = scripted('/x/msb', [[/^ls /, { stdoutText: '[]' }], [/^rm /, { code: 0 }]]);
    const rt = createMicrosandboxRuntime({ runner: msb, instance: 'dtest', socketRoot: root });
    await rt.destroy('a');
    expect([existsSync(dirs.a!), existsSync(dirs.b!), existsSync(dirs.gone!)]).toEqual([false, true, true]);
    await rt.sweep(['b']);
    expect([existsSync(dirs.b!), existsSync(dirs.gone!)]).toEqual([true, false]);
  });

  it('lists the running sandboxes of this instance', async () => {
    const ls = JSON.stringify([
      { name: 'limn-a-sandbox', status: 'running', labels: { 'limn.managed': 'dtest', 'limn.session': 'a', 'limn.role': 'sandbox' } },
      { name: 'limn-b-sandbox', status: 'stopped', labels: { 'limn.managed': 'dtest', 'limn.session': 'b', 'limn.role': 'sandbox' } },
      { name: 'other', status: 'running', labels: { 'limn.managed': 'dother', 'limn.session': 'c', 'limn.role': 'sandbox' } },
    ]);
    const rt = createMicrosandboxRuntime({ runner: scripted('/x/msb', [[/^ls /, { stdoutText: ls }]]), instance: 'dtest', socketRoot: newRoot() });
    expect(await rt.listSandboxes()).toEqual([{ name: 'limn-a-sandbox', sessionId: 'a' }]);
  });

  it('services are refused in one line', async () => {
    const rt = createMicrosandboxRuntime({ runner: scripted('/x/msb', []), socketRoot: newRoot() });
    expect((await rt.compose({ ...owner, project: 'p', compose: {}, call: { verb: 'ps' } })).stderr).toBe(SERVICES_NOT_ON_MICROSANDBOX);
  });
});

describe('the host proxy for real (unix sockets, no VM)', () => {
  it('starts, takes control requests, refuses a denied host and a foreign credential, and stops', async () => {
    const root = newRoot();
    const rt = createMicrosandboxRuntime({ runner: scripted('/x/msb', [[/^ls /, { stdoutText: '[]' }]]), instance: 'dreal', socketRoot: root });
    const config = { rules: ['registry.npmjs.org'], placeholders: { anthropic: 'limn-ph-a', chatgpt: 'limn-ph-c' }, controlToken: 'tok123-long-enough-for-the-proxy' };
    const handle = await rt.startProxy({ ...owner, image: '', network: '', alias: 'limn-proxy', source: proxyProgramSource(), env: { [PROXY_MAIN_ENV]: '1', [PROXY_CONFIG_ENV]: JSON.stringify(config) } });
    const logs = rt.followLogs(handle.name);
    const rows: Record<string, unknown>[] = [];
    let buf = '';
    const ready = (async () => {
      for await (const ev of logs.events) {
        if (ev.type !== 'stdout') continue;
        buf += ev.data.toString();
        for (const l of buf.split('\n').slice(0, -1)) rows.push(JSON.parse(l) as Record<string, unknown>);
        buf = buf.slice(buf.lastIndexOf('\n') + 1);
        if (rows.some((r) => r.kind === 'ready')) return;
      }
    })();
    await ready;
    const dir = socketDirFor(root, 'dreal', 's1');

    expect(await rt.proxyControl?.(handle.name, '/rules', { rules: ['registry.npmjs.org', 'example.org'] })).toBe(true);
    expect(await rt.proxyControl?.(handle.name, '/credentials', { anthropicOauth: 'not-a-real-token' })).toBe(true);
    expect(await rt.proxyControl?.('limn-nope-proxy', '/rules', { rules: [] })).toBe(false);

    // CONNECT to a host not on the list: 403 from the proxy, never an upstream socket.
    const reply = await new Promise<string>((resolve, reject) => {
      const s = net.connect(join(dir, 'forward.sock'));
      let got = '';
      s.on('data', (d) => (got += d.toString()));
      s.on('end', () => resolve(got));
      s.on('error', reject);
      s.write('CONNECT denied.example.com:443 HTTP/1.1\r\nHost: denied.example.com:443\r\n\r\n');
    });
    expect(reply).toMatch(/^HTTP\/1\.1 403/);

    // The Anthropic injector refuses a credential Limn did not give (no upstream call).
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({ socketPath: join(dir, 'anthropic.sock'), method: 'POST', path: '/v1/messages', headers: { authorization: 'Bearer someone-elses', host: 'limn-proxy' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end('{}');
    });
    expect(status).toBe(403);

    const removed = await rt.destroy('s1');
    expect(removed.containers).toEqual(['limn-s1-proxy']);
    expect(existsSync(dir)).toBe(false);
    expect((await logs.done).code === null || typeof (await logs.done).code === 'number').toBe(true);
  }, 20_000);
});

describe('the runtime choice', () => {
  it('reads SANDBOX_RUNTIME', () => {
    expect(runtimeChoiceOf({})).toBe('auto');
    expect(runtimeChoiceOf({ SANDBOX_RUNTIME: 'Docker' })).toBe('docker');
    expect(runtimeChoiceOf({ SANDBOX_RUNTIME: 'msb' })).toBe('microsandbox');
  });

  it('auto: microsandbox when healthy, else Docker; then fixed', async () => {
    const docker = createFakeRuntime();
    const healthy = { ...createFakeRuntime(), kind: 'microsandbox' as const, detect: async () => ({ ...(await docker.detect()), kind: 'microsandbox' as const, available: true }), proxyControl: async () => true };
    const auto = createAutoRuntime({ docker, microsandbox: healthy as SandboxRuntime });
    expect(auto.picked).toBeNull();
    await auto.detect();
    expect(auto.kind).toBe('microsandbox');
    expect(typeof auto.proxyControl).toBe('function');

    const sick = { ...healthy, detect: async () => ({ ...(await docker.detect()), kind: 'microsandbox' as const, available: false }) };
    const auto2 = createAutoRuntime({ docker, microsandbox: sick as SandboxRuntime });
    await auto2.detect();
    expect(auto2.kind).toBe(docker.kind);
    expect(auto2.proxyControl).toBeUndefined();
  });
});

