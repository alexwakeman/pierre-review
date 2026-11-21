import { beforeEach, describe, expect, it } from 'vitest';
import type { PageTransport } from '../reference-docs/url-fetch.js';
import type { JiraTransport } from '../tracker/jira/fetch.js';
import { figmaErrorMessage } from './client.js';
import { clearFigmaCache, readFigmaFrames } from './read.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
let version = 'v1';
let calls: Array<{ host: string; path: string; query: string; token: string | undefined }> = [];
const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
const transport: JiraTransport = async (url, headers) => {
  calls.push({ host: url.host, path: url.pathname, query: url.search, token: headers['x-figma-token'] });
  if (url.pathname === '/v1/files/AbCdEfGhIj1234') return json({ document: { children: [{ type: 'CANVAS', children: [{ id: '1:2', type: 'FRAME' }, { id: '1:3', type: 'TEXT' }, { id: '1:4', type: 'FRAME' }] }] } });
  if (url.pathname === '/v1/files/AbCdEfGhIj1234/nodes') {
    const ids = url.searchParams.get('ids')!.split(',');
    return json({ name: 'Checkout', version, nodes: Object.fromEntries(ids.map((id) => [id, { document: { id, type: 'FRAME', name: `Frame ${id}` }, components: {} }])) });
  }
  if (url.pathname === '/v1/images/AbCdEfGhIj1234') {
    const ids = url.searchParams.get('ids')!.split(',');
    return json({ err: null, images: Object.fromEntries(ids.map((id) => [id, `https://figma-alpha-api.s3.us-west-2.amazonaws.com/images/${id.replace(':', '-')}?sig=x`])) });
  }
  return { status: 404, contentType: 'application/json', body: '{}' };
};
const pages: string[] = [];
const pageTransport: PageTransport = async (url) => {
  pages.push(url.href);
  return { status: 200, contentType: 'image/png', location: null, body: PNG };
};

beforeEach(() => {
  clearFigmaCache();
  calls = [];
  pages.length = 0;
  version = 'v1';
});

const read = (nodeId: string | null) => readFigmaFrames({ accountId: 1, token: 'figd_secret', fileKey: 'AbCdEfGhIj1234', nodeId, transport, pageTransport });

describe('readFigmaFrames', () => {
  it('a linked frame: its nodes, then its picture; the token goes only to api.figma.com', async () => {
    const r = await read('1:2');
    expect(calls.map((c) => c.path)).toEqual(['/v1/files/AbCdEfGhIj1234/nodes', '/v1/images/AbCdEfGhIj1234']);
    expect(calls.every((c) => c.host === 'api.figma.com' && c.token === 'figd_secret')).toBe(true);
    expect(r).toMatchObject({ version: 'v1', calls: 2, cached: false });
    expect(r.outline).toContain('## Frame 1:2 (node 1:2)');
    expect(r.pngs).toEqual([{ nodeId: '1:2', bytes: PNG }]);
    // The picture's signed address is read with no token at all (a page fetch has no headers).
    expect(pages).toEqual(['https://figma-alpha-api.s3.us-west-2.amazonaws.com/images/1-2?sig=x']);
  });
  it('no frame in the link: the first page’s top frames, at most three', async () => {
    const r = await read(null);
    expect(calls[0]).toMatchObject({ path: '/v1/files/AbCdEfGhIj1234', query: '?depth=2' });
    expect(calls[1]!.query).toContain('ids=1%3A2%2C1%3A4');
    expect(r.pngs.map((p) => p.nodeId)).toEqual(['1:2', '1:4']);
  });
  it('the same version again is the cache: one call, no picture read', async () => {
    await read('1:2');
    calls = [];
    pages.length = 0;
    const again = await read('1:2');
    expect(again).toMatchObject({ cached: true, calls: 1 });
    expect(calls.map((c) => c.path)).toEqual(['/v1/files/AbCdEfGhIj1234/nodes']);
    expect(pages).toEqual([]);
    version = 'v2';
    expect((await read('1:2')).cached).toBe(false);
  });
  it('a bad key or node id is refused before any request', async () => {
    await expect(readFigmaFrames({ accountId: 1, token: 't', fileKey: '../etc', nodeId: null, transport })).rejects.toMatchObject({ code: 'bad_input' });
    await expect(readFigmaFrames({ accountId: 1, token: 't', fileKey: 'AbCdEfGhIj1234', nodeId: '1:2/../x', transport })).rejects.toMatchObject({ code: 'bad_input' });
    expect(calls).toEqual([]);
  });
  it('Figma’s refusals are sentences, never its body', async () => {
    const refusing: JiraTransport = async () => ({ status: 403, contentType: 'application/json', body: '{"err":"secret detail"}' });
    const err = await readFigmaFrames({ accountId: 1, token: 't', fileKey: 'AbCdEfGhIj1234', nodeId: '1:2', transport: refusing }).catch((e: unknown) => e);
    expect(figmaErrorMessage(err)).toBe('Figma refused the workspace’s token. Check it in Settings → Integrations → Figma.');
    const limited: JiraTransport = async () => ({ status: 429, contentType: 'application/json', body: '{}' });
    expect(figmaErrorMessage(await readFigmaFrames({ accountId: 1, token: 't', fileKey: 'AbCdEfGhIj1234', nodeId: '1:2', transport: limited }).catch((e: unknown) => e))).toMatch(/rate limit/);
  });
});
