// THE RELAY, FOR REAL: the shipped `limn-svcd.cjs` and `limn-svc` (apps/backend/sandbox-image/) run as
// local Node processes; the host side (relay.ts) talks to the relay over its stdio exactly as it does
// through `docker exec`. A request goes client → relay → controller → back, with its exit code; a
// forward carries TCP; a killed relay is started again.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createServer, connect, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createCliRunner } from '../runtime/cli.js';
import type { ExecHandle, SandboxRuntime } from '../runtime/types.js';
import type { ServicesController } from './controller.js';
import type { Forward } from './policy.js';
import { startServicesRelay, type ServicesRelay } from './relay.js';

const IMAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'sandbox-image');
const RELAY = join(IMAGE_DIR, 'limn-svcd.cjs');
const CLIENT = join(IMAGE_DIR, 'limn-svc');

const runner = createCliRunner(process.execPath);
const handles: ExecHandle[] = [];
const localRuntime = {
  exec: (_container: string, argv: string[], o: { env?: Record<string, string> } = {}) => {
    const h = runner.spawn(argv.slice(1), { interactive: true, ...(o.env ? { env: o.env } : {}) });
    handles.push(h);
    return h;
  },
} as unknown as SandboxRuntime;

/** A controller stand-in: records requests, answers with a scripted handler. */
function fakeController(answer: (argv: readonly string[], cwd: string, out: (s: 'o' | 'e', t: string) => void) => Promise<number>) {
  let forwarder: ((f: Forward[]) => Promise<{ listening: number[]; failed: { port: number; reason: string }[] }>) | null = null;
  const c = {
    handle: answer,
    setForwarder: (f: typeof forwarder) => {
      forwarder = f;
    },
    forward: (f: Forward[]) => forwarder!(f),
  };
  return c as unknown as ServicesController & { forward: (f: Forward[]) => ReturnType<NonNullable<typeof forwarder>> };
}

function client(socket: string, args: string[], cwd = tmpdir()): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((res) => {
    const p = spawn(process.execPath, [CLIENT, ...args], { env: { ...process.env, LIMN_SVC_SOCKET: socket }, cwd });
    let out = '';
    let err = '';
    p.stdout.on('data', (d: Buffer) => (out += d));
    p.stderr.on('data', (d: Buffer) => (err += d));
    p.on('close', (code) => res({ code, out, err }));
  });
}

let relay: ServicesRelay | null = null;
afterEach(() => {
  relay?.close();
  relay = null;
  for (const h of handles.splice(0)) h.kill();
});

describe('limn-svc ↔ limn-svcd ↔ Limn', () => {
  it('carries argv and cwd out, output and the exit code back', async () => {
    const socket = join(mkdtempSync(join(tmpdir(), 'lsvc-')), 's.sock');
    const seen: { argv: readonly string[]; cwd: string }[] = [];
    const ctl = fakeController(async (argv, cwd, out) => {
      seen.push({ argv, cwd });
      out('o', 'started postgres\n');
      out('e', 'a warning\n');
      return 7;
    });
    relay = startServicesRelay({ runtime: localRuntime, sandbox: 'x', controller: ctl, program: RELAY, socket });
    await relay.ready;
    const cwd = mkdtempSync(join(tmpdir(), 'lsvc-cwd-'));
    const r = await client(socket, ['up', 'postgres', '--', 'a b'], cwd);
    expect(r).toEqual({ code: 7, out: 'started postgres\n', err: 'a warning\n' });
    expect(seen[0]!.argv).toEqual(['up', 'postgres', '--', 'a b']);
    expect(seen[0]!.cwd.endsWith(cwd.split('/').pop()!)).toBe(true);
  }, 20_000);

  it('a large answer arrives whole', async () => {
    const socket = join(mkdtempSync(join(tmpdir(), 'lsvc-')), 's.sock');
    const big = 'x'.repeat(200_000) + '\n';
    relay = startServicesRelay({ runtime: localRuntime, sandbox: 'x', controller: fakeController(async (_a, _c, out) => (out('o', big), 0)), program: RELAY, socket });
    await relay.ready;
    const r = await client(socket, ['logs', 'api']);
    expect(r.code).toBe(0);
    expect(r.out.length).toBe(big.length);
  }, 20_000);

  it('forwards localhost to a service, and replaces the table', async () => {
    const socket = join(mkdtempSync(join(tmpdir(), 'lsvc-')), 's.sock');
    const echo = createServer((s) => s.pipe(s));
    await new Promise<void>((r) => echo.listen(0, '127.0.0.1', r));
    const target = (echo.address() as AddressInfo).port;
    const free = createServer();
    await new Promise<void>((r) => free.listen(0, '127.0.0.1', r));
    const port = (free.address() as AddressInfo).port;
    await new Promise<void>((r) => free.close(() => r()));

    const ctl = fakeController(async () => 0);
    relay = startServicesRelay({ runtime: localRuntime, sandbox: 'x', controller: ctl, program: RELAY, socket });
    await relay.ready;
    expect(await ctl.forward([{ port, host: '127.0.0.1', target }])).toEqual({ listening: [port], failed: [] });
    const reply = await new Promise<string>((res, rej) => {
      const s = connect(port, '127.0.0.1', () => s.write('ping'));
      s.on('data', (d) => {
        res(String(d));
        s.end();
      });
      s.on('error', rej);
    });
    expect(reply).toBe('ping');
    expect(await ctl.forward([])).toEqual({ listening: [], failed: [] });
    await expect(new Promise((res, rej) => {
      const s = connect(port, '127.0.0.1', () => res('connected'));
      s.on('error', (e) => rej(e));
    })).rejects.toThrow(/ECONNREFUSED/);
    echo.close();
  }, 20_000);

  it('a killed relay is started again; with none, the client says services are not available', async () => {
    const socket = join(mkdtempSync(join(tmpdir(), 'lsvc-')), 's.sock');
    const problems: string[] = [];
    relay = startServicesRelay({ runtime: localRuntime, sandbox: 'x', controller: fakeController(async () => 0), program: RELAY, socket, onProblem: (l) => problems.push(l) });
    await relay.ready;
    handles[0]!.kill();
    await new Promise((r) => setTimeout(r, 1_800));
    expect(problems[0]).toMatch(/stopped\. Starting it again/);
    expect((await client(socket, ['ps'])).code).toBe(0);
    relay.close();
    relay = null;
    await new Promise((r) => setTimeout(r, 300));
    const gone = await client(join(tmpdir(), 'no-such-limn.sock'), ['ps']);
    expect(gone).toMatchObject({ code: 3, err: 'limn-svc: services are not available in this session.\n' });
  }, 20_000);
});
