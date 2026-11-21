// `ensemble-ticket` ON A REAL DAEMON (slow project; docs/SANDBOX.md § The ticket relay): the shipped client
// and relay program, copied into a plain Node container with the Docker runtime's own `copyIn`, the relay
// started over `docker exec` exactly as a session starts it, and the client run INSIDE the container as
// the agent would. The files `get` writes are read back from the container.
//
// Skipped without a daemon. Uses `node:22-bookworm-slim` (the sandbox image's base), pulled if missing.
// The container carries `limn.test=1` and is removed.
import { randomBytes } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildManifest } from '../../tracker/artifacts.js';
import { createDockerRuntime } from '../runtime/docker.js';
import type { SandboxRuntime } from '../runtime/types.js';
import { startTicketRelay, type TicketRelay } from './index.js';

const docker = process.env.SANDBOX_CLI || 'docker';
const probe = spawnSync(docker, ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8', timeout: 20_000 });
const haveDaemon = probe.status === 0 && probe.stdout.trim() !== '';
if (!haveDaemon) console.warn('[ticket-real] SKIPPED: no container daemon answers');

const IMAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'sandbox-image');
const IMAGE = 'node:22-bookworm-slim';
const container = `limn-ticket-test-${randomBytes(4).toString('hex')}`;
const rt: SandboxRuntime = createDockerRuntime({ instance: 'ticket-test', extraLabels: { 'limn.test': '1' } });
let relay: TicketRelay | null = null;

describe.skipIf(!haveDaemon)('ensemble-ticket in a real container', () => {
  beforeAll(async () => {
    execFileSync(docker, ['run', '-d', '--rm', '--name', container, '--label', 'limn.test=1', '--network', 'none', IMAGE, 'sleep', 'infinity'], { stdio: 'ignore', timeout: 300_000 });
    // The sandbox image's user (its Dockerfile: `useradd -m agent`); the runtime runs everything as it.
    execFileSync(docker, ['exec', '-u', 'root', container, 'useradd', '-m', '-s', '/bin/sh', 'agent'], { stdio: 'ignore', timeout: 60_000 });
    // As the image installs them: root-owned, readable.
    await rt.copyIn(
      container,
      [
        { path: '/usr/local/bin/ensemble-ticket', content: readFileSync(join(IMAGE_DIR, 'ensemble-ticket')), mode: 0o755 },
        { path: '/usr/local/lib/limn/limn-svcd.cjs', content: readFileSync(join(IMAGE_DIR, 'limn-svcd.cjs')) },
      ],
      { user: 'root' },
    );
  }, 300_000);

  afterAll(() => {
    relay?.close();
    spawnSync(docker, ['rm', '-f', container], { stdio: 'ignore', timeout: 60_000 });
  });

  it('manifest before the first turn; list and get from inside; the file lands in the sandbox', async () => {
    const entries = buildManifest({
      provider: 'jira',
      attachments: [{ id: '7', filename: 'mock up.png', mime: 'image/png', size: 4, fetch: { kind: 'jira_attachment', contentUrl: 'https://acme.atlassian.net/a/7' } }],
      description: 'Design: https://www.figma.com/design/AbCdEfGhIj1234/Checkout?node-id=1-2',
      comments: null,
    });
    relay = await startTicketRelay({
      runtime: rt,
      sandbox: container,
      root: '/home/agent/ws',
      source: {
        manifest: async () => ({ entries, problem: null }),
        download: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        refreshTicket: async () => '/home/agent/ws/TICKET.md',
        host: () => 'acme.atlassian.net',
      },
    });
    const sh = async (cmd: string) => {
      const r = await rt.run(container, ['sh', '-c', cmd], { timeoutMs: 60_000 });
      return { code: r.code, out: `${String(r.stdout)}${r.stderr}` };
    };
    expect((await sh('cat /home/agent/ws/.limn/ticket/manifest.json')).out).toContain('"kind": "figma"');
    const list = await sh('ensemble-ticket list');
    expect(list.code).toBe(0);
    expect(list.out).toContain('mock up.png');
    const id = entries[0]!.artifact.id;
    const got = await sh(`ensemble-ticket get ${id}`);
    expect(got).toMatchObject({ code: 0, out: `/home/agent/ws/.limn/ticket/files/${id}-mock_up.png\n` });
    expect((await sh(`od -An -tx1 /home/agent/ws/.limn/ticket/files/${id}-mock_up.png`)).out.trim()).toBe('89 50 4e 47');
    const link = await sh(`ensemble-ticket get ${entries[1]!.artifact.id}`);
    expect(link.code).toBe(1);
    expect(link.out).toContain('is a link');
  }, 120_000);
});
