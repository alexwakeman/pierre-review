import type { SandboxNetworkEntry } from '@pierre-review/shared';
import { describe, expect, it } from 'vitest';
import { buildManifest, type ManifestEntry, type TicketAttachment } from '../../tracker/artifacts.js';
import { TICKET_SESSION_MAX_READS, TICKET_SHOW_MIN_INTERVAL_MS, TicketRelayController, type TicketRelaySource } from './controller.js';

const att = (id: string, filename: string, size: number | null = 10): TicketAttachment => ({
  id,
  filename,
  mime: null,
  size,
  fetch: { kind: 'jira_attachment', contentUrl: `https://acme.atlassian.net/rest/api/2/attachment/content/${id}` },
});

function setup(o: { entries?: ManifestEntry[]; download?: (e: ManifestEntry) => Promise<Buffer>; refresh?: () => Promise<string | null>; problem?: string | null } = {}) {
  const entries = o.entries ?? buildManifest({ provider: 'jira', attachments: [att('1', 'mock.png'), att('2', '../../evil name.json')], description: 'https://e.test/page', comments: null });
  const written: Array<{ path: string; content: string | Buffer }> = [];
  const network: SandboxNetworkEntry[] = [];
  let now = 1_000_000;
  let downloads = 0;
  const source: TicketRelaySource = {
    manifest: async () => ({ entries, problem: o.problem ?? null }),
    download:
      o.download ??
      (async () => {
        downloads += 1;
        return Buffer.from('bytes');
      }),
    refreshTicket: o.refresh ?? (async () => '/workspace/TICKET.md'),
    host: () => 'acme.atlassian.net',
  };
  const ctl = new TicketRelayController('/workspace', source, {
    write: async (files) => void written.push(...files),
    onNetwork: (e) => void network.push(e),
    now: () => now,
  });
  const run = async (...argv: string[]) => {
    let out = '';
    let err = '';
    const code = await ctl.handle(argv, '/workspace', (s, t) => (s === 'o' ? (out += t) : (err += t)));
    return { code, out, err };
  };
  return { ctl, run, written, network, entries, advance: (ms: number) => (now += ms), downloads: () => downloads };
}

describe('ensemble-ticket on the host', () => {
  it('list: prints the manifest and writes manifest.json once, with no download address in it', async () => {
    const t = setup();
    const r = await t.run('list');
    expect(r.code).toBe(0);
    expect(r.out).toContain('mock.png');
    await t.run('list');
    const manifests = t.written.filter((f) => f.path === '/workspace/.limn/ticket/manifest.json');
    expect(manifests).toHaveLength(1);
    expect(String(manifests[0]!.content)).not.toContain('attachment/content');
    expect(JSON.parse(String(manifests[0]!.content)).items).toHaveLength(3);
  });

  it('a manifest problem is said, and the links are still listed', async () => {
    const t = setup({ entries: buildManifest({ provider: 'jira', attachments: [], description: 'https://e.test/page', comments: null }), problem: 'Attachments were not read: no token.' });
    const r = await t.run('list');
    expect(r.err).toContain('Attachments were not read');
    expect(r.out).toContain('https://e.test/page');
  });

  it('get: writes each file under files/ with a safe name, one Network row for the tracker', async () => {
    const t = setup();
    const [a, b] = t.entries;
    const r = await t.run('get', a!.artifact.id, b!.artifact.id);
    expect(r.code).toBe(0);
    const paths = t.written.map((f) => f.path).filter((p) => p.includes('/files/'));
    expect(paths).toEqual([`/workspace/.limn/ticket/files/${a!.artifact.id}-mock.png`, `/workspace/.limn/ticket/files/${b!.artifact.id}-evil_name.json`]);
    expect(r.out.trim().split('\n')).toEqual(paths);
    expect(t.network.at(-1)).toMatchObject({ key: 'ticket:acme.atlassian.net', via: 'ticket', allowed: true, count: 2, down: 10 });
  });

  it('get: an id not in the manifest, and a link, are refused without a read', async () => {
    const t = setup();
    expect((await t.run('get', 'a-0000000000')).err).toContain('is not in the ticket');
    const link = t.entries.find((e) => e.artifact.kind === 'link')!;
    const r = await t.run('get', link.artifact.id);
    expect(r.code).toBe(1);
    expect(r.err).toContain('curl -x "$LIMN_PROXY" https://e.test/page');
    expect(t.downloads()).toBe(0);
    expect((await t.run('get')).code).toBe(2);
  });

  it('a failed download is a sentence; nothing is written', async () => {
    const t = setup({
      download: async () => {
        throw new Error('The tracker refused the workspace’s token for this file.');
      },
    });
    const r = await t.run('get', t.entries[0]!.artifact.id);
    expect(r.code).toBe(1);
    expect(r.err).toContain('refused the workspace’s token');
    expect(t.written.some((f) => f.path.includes('/files/'))).toBe(false);
  });

  it('caps the session’s reads', async () => {
    const t = setup();
    const id = t.entries[0]!.artifact.id;
    for (let i = 0; i < TICKET_SESSION_MAX_READS; i++) await t.run('get', id);
    const r = await t.run('get', id);
    expect(r.err).toContain(`used its ${TICKET_SESSION_MAX_READS} tracker reads`);
    expect(t.downloads()).toBe(TICKET_SESSION_MAX_READS);
  });

  it('refuses a file the manifest says is past the session budget, before reading it', async () => {
    const t = setup({ entries: buildManifest({ provider: 'jira', attachments: [att('9', 'huge.mov', 500 * 1024 * 1024)], description: '', comments: null }) });
    const r = await t.run('get', t.entries[0]!.artifact.id);
    expect(r.err).toContain('MB of ticket files');
    expect(t.downloads()).toBe(0);
  });

  it('show: reads the ticket again, at most every two minutes', async () => {
    let reads = 0;
    const t = setup({ refresh: async () => (reads++, '/workspace/TICKET.md') });
    expect((await t.run('show')).out).toBe('/workspace/TICKET.md\n');
    expect((await t.run('show')).out).toContain('less than two minutes ago');
    t.advance(TICKET_SHOW_MIN_INTERVAL_MS);
    await t.run('show');
    expect(reads).toBe(2);
  });

  it('show: a failed read says TICKET.md is the start copy', async () => {
    const t = setup({ refresh: async () => null });
    const r = await t.run('show');
    expect(r.code).toBe(1);
    expect(r.err).toContain('copy from the start of the session');
  });

  it('help and unknown verbs', async () => {
    const t = setup();
    expect((await t.run()).out).toContain('ensemble-ticket get <id>');
    const r = await t.run('rm', '-rf');
    expect(r.code).toBe(2);
    expect(r.err).toContain('unknown command `rm`');
  });

  it('figma: the outline and pictures under figma/, one Network row for api.figma.com; a link to it from get is redirected', async () => {
    const entries = buildManifest({ provider: 'jira', attachments: [], description: 'https://www.figma.com/design/AbCdEfGhIj1234/X?node-id=1-2', comments: null });
    const id = entries[0]!.artifact.id;
    const written: Array<{ path: string; content: string | Buffer }> = [];
    const network: SandboxNetworkEntry[] = [];
    const ctl = new TicketRelayController('/workspace', {
      manifest: async () => ({ entries, problem: null }),
      download: async () => Buffer.alloc(0),
      refreshTicket: async () => null,
      host: () => 'acme.atlassian.net',
      figma: async () => ({ outline: '# Figma outline', pngs: [{ nodeId: '1:2', bytes: Buffer.from([0x89, 0x50]) }], calls: 2 }),
    }, { write: async (f) => void written.push(...f), onNetwork: (e) => void network.push(e) });
    let out = '';
    let err = '';
    const code = await ctl.handle(['figma', id], '/', (s2, t) => (s2 === 'o' ? (out += t) : (err += t)));
    expect(code).toBe(0);
    expect(out.trim().split('\n')).toEqual([`/workspace/.limn/ticket/figma/${id}.outline.md`, `/workspace/.limn/ticket/figma/${id}-1-2.png`]);
    expect(network.at(-1)).toMatchObject({ host: 'api.figma.com', count: 2, via: 'ticket' });
    await ctl.handle(['get', id], '/', (s2, t) => (s2 === 'o' ? (out += t) : (err += t)));
    expect(err).toContain(`Read it with \`ensemble-ticket figma ${id}\``);
  });

  it("figma with no token: the source's sentence, and nothing is written", async () => {
    const entries = buildManifest({ provider: 'jira', attachments: [], description: 'https://www.figma.com/file/AbCdEfGhIj1234', comments: null });
    const written: Array<{ path: string }> = [];
    const ctl = new TicketRelayController('/workspace', {
      manifest: async () => ({ entries, problem: null }),
      download: async () => Buffer.alloc(0),
      refreshTicket: async () => null,
      host: () => 'h',
      figma: async () => {
        throw new Error('No Figma token is saved for this workspace.');
      },
    }, { write: async (f) => void written.push(...f) });
    let err = '';
    expect(await ctl.handle(['figma', entries[0]!.artifact.id], '/', (s2, t) => (s2 === 'e' ? (err += t) : undefined))).toBe(1);
    expect(err).toContain('No Figma token is saved');
    expect(written.filter((f) => f.path.includes('/figma/'))).toEqual([]);
  });
});
