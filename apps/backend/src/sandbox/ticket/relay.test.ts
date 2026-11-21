// `ensemble-ticket`, FOR REAL: the shipped client (installed under that name) and the shipped relay
// program run as local Node processes, and the host side talks to the relay over its stdio exactly as
// it does through `docker exec`. The client's NAME picks its socket, so `limn-svc` and `ensemble-ticket`
// are two relays of the same program.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { buildManifest } from '../../tracker/artifacts.js';
import { createCliRunner } from '../runtime/cli.js';
import type { ExecHandle, FileToCopy, SandboxRuntime } from '../runtime/types.js';
import { startTicketRelay, type TicketRelay } from './index.js';

const IMAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'sandbox-image');
const RELAY = join(IMAGE_DIR, 'limn-svcd.cjs');
const CLIENT = join(IMAGE_DIR, 'ensemble-ticket');

const runner = createCliRunner(process.execPath);
const handles: ExecHandle[] = [];
const copied: FileToCopy[] = [];
const localRuntime = {
  exec: (_c: string, argv: string[], o: { env?: Record<string, string> } = {}) => {
    const h = runner.spawn(argv.slice(1), { interactive: true, ...(o.env ? { env: o.env } : {}) });
    handles.push(h);
    return h;
  },
  copyIn: async (_c: string, files: FileToCopy[]) => void copied.push(...files),
} as unknown as SandboxRuntime;

function client(socket: string, args: string[]): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((res) => {
    const p = spawn(process.execPath, [CLIENT, ...args], { env: { ...process.env, ENSEMBLE_TICKET_SOCKET: socket, LIMN_SVC_SOCKET: '/nowhere' } });
    let out = '';
    let err = '';
    p.stdout.on('data', (d: Buffer) => (out += d));
    p.stderr.on('data', (d: Buffer) => (err += d));
    p.on('close', (code) => res({ code, out, err }));
  });
}

let relay: TicketRelay | null = null;
afterEach(() => {
  relay?.close();
  relay = null;
  for (const h of handles.splice(0)) h.kill();
  copied.length = 0;
});

describe('ensemble-ticket ↔ the relay ↔ Ensemble', () => {
  it('the client is the SAME file as limn-svc (the image installs it twice)', () => {
    expect(readFileSync(CLIENT)).toEqual(readFileSync(join(IMAGE_DIR, 'limn-svc')));
  });

  it('writes the manifest before the first turn, then answers list and get', async () => {
    const socket = join(mkdtempSync(join(tmpdir(), 'etk-')), 't.sock');
    const entries = buildManifest({
      provider: 'jira',
      attachments: [{ id: '7', filename: 'mock.png', mime: 'image/png', size: 4, fetch: { kind: 'jira_attachment', contentUrl: 'https://acme.atlassian.net/a/7' } }],
      description: '',
      comments: null,
    });
    relay = await startTicketRelay({
      runtime: localRuntime,
      sandbox: 'x',
      root: '/workspace',
      program: RELAY,
      socket,
      source: {
        manifest: async () => ({ entries, problem: null }),
        download: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        refreshTicket: async () => '/workspace/TICKET.md',
        host: () => 'acme.atlassian.net',
      },
    });
    expect(copied.map((f) => f.path)).toEqual(['/workspace/.limn/ticket/manifest.json']);
    const list = await client(socket, ['list']);
    expect(list.code).toBe(0);
    expect(list.out).toContain('mock.png');
    const got = await client(socket, ['get', entries[0]!.artifact.id]);
    expect(got).toMatchObject({ code: 0, out: `/workspace/.limn/ticket/files/${entries[0]!.artifact.id}-mock.png\n` });
    expect([...(copied.at(-1)!.content as Buffer)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it('with no relay, the client says the ticket is not available', async () => {
    const r = await client(join(tmpdir(), 'no-such-ticket.sock'), ['list']);
    expect(r).toMatchObject({ code: 3, err: 'ensemble-ticket: the ticket is not available in this session.\n' });
  });
});
