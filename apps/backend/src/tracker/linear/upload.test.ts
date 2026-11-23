// LINEAR'S FILE UPLOAD AND COMMENT (upload.ts) over a FAKE Linear and a FAKE signed upload host: the key goes to
// Linear only, never to the upload address; Linear's upload headers are forwarded except credential or connection
// ones; the asset address comes back; the comment goes to the issue's own id.
import { describe, expect, it } from 'vitest';
import type { JiraTransport, RawResponse } from '../jira/fetch.js';
import type { TrackerCall } from '../types.js';
import { linearCommentCreate, linearUploadFile } from './upload.js';

const json = (body: unknown, status = 200): RawResponse => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2]);

function fake(o: { uploadUrl?: string; uploadStatus?: number; refuse?: boolean } = {}) {
  const calls: Array<{ host: string; method: string; headers: Record<string, string>; body: unknown; bytes: Buffer | null }> = [];
  const transport: JiraTransport = async (url, headers, _o, init) => {
    calls.push({ host: url.host, method: init?.method ?? 'GET', headers, body: init?.body ?? null, bytes: init?.bytes ?? null });
    if (url.host === 'api.linear.app') {
      const q = JSON.parse(init!.body) as { query: string; variables: Record<string, unknown> };
      if (o.refuse) return json({ data: null, errors: [{ message: 'no', extensions: { code: 'FORBIDDEN' } }] });
      if (q.query.includes('fileUpload')) {
        return json({
          data: {
            fileUpload: {
              success: true,
              uploadFile: {
                uploadUrl: o.uploadUrl ?? 'https://storage.googleapis.com/linear-uploads/abc?X-Goog-Signature=s',
                assetUrl: 'https://uploads.linear.app/ws/abc/ensemble-7-1.png',
                headers: [
                  { key: 'x-goog-content-length-range', value: '0,10000' },
                  { key: 'Authorization', value: 'Bearer stolen' },
                  { key: 'Host', value: 'evil.example' },
                ],
              },
            },
          },
        });
      }
      if (q.query.includes('issue(id')) return json({ data: { issue: { id: 'uuid-eng-7' } } });
      if (q.query.includes('commentCreate')) return json({ data: { commentCreate: { success: true } } });
    }
    return { status: o.uploadStatus ?? 200, contentType: '', body: '' };
  };
  const call: TrackerCall = { provider: 'linear', apiRoot: 'https://linear.app/acme', credentials: { email: null, token: 'lin_api_secret' }, policy: { cloud: true }, transport };
  return { calls, call };
}

describe('linearUploadFile', () => {
  it('asks Linear for an upload address, PUTs the bytes there WITHOUT the key, and answers the asset address', async () => {
    const f = fake();
    const url = await linearUploadFile(f.call, { name: 'ensemble-7-1.png', contentType: 'image/png', bytes: PNG });
    expect(url).toBe('https://uploads.linear.app/ws/abc/ensemble-7-1.png');
    expect(f.calls.map((c) => [c.method, c.host])).toEqual([
      ['POST', 'api.linear.app'],
      ['PUT', 'storage.googleapis.com'],
    ]);
    const asked = JSON.parse(f.calls[0]!.body as string);
    expect(asked.variables).toEqual({ contentType: 'image/png', filename: 'ensemble-7-1.png', size: PNG.length });
    const put = f.calls[1]!;
    expect(put.bytes).toEqual(PNG);
    expect(put.headers['content-type']).toBe('image/png');
    expect(put.headers['x-goog-content-length-range']).toBe('0,10000');
    // Linear's answer cannot set a credential or the host, and the key never goes to the upload address.
    expect(Object.keys(put.headers).map((k) => k.toLowerCase())).not.toContain('authorization');
    expect(put.headers.host).toBeUndefined();
    expect(JSON.stringify(put.headers)).not.toContain('lin_api_secret');
  });

  it('refuses an upload address that is not https, and a failed upload is an error', async () => {
    await expect(linearUploadFile(fake({ uploadUrl: 'http://storage.example/x' }).call, { name: 'a.png', contentType: 'image/png', bytes: PNG })).rejects.toMatchObject({ code: 'blocked' });
    await expect(linearUploadFile(fake({ uploadStatus: 403 }).call, { name: 'a.png', contentType: 'image/png', bytes: PNG })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(linearUploadFile(fake({ refuse: true }).call, { name: 'a.png', contentType: 'image/png', bytes: PNG })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(linearUploadFile(fake().call, { name: '../a.png', contentType: 'image/png', bytes: PNG })).rejects.toMatchObject({ code: 'bad_url' });
  });
});

describe('linearCommentCreate', () => {
  it('finds the issue by its key, then comments on its id', async () => {
    const f = fake();
    await linearCommentCreate(f.call, 'ENG-7', 'Hello');
    const bodies = f.calls.map((c) => JSON.parse(c.body as string) as { variables: Record<string, unknown> });
    expect(bodies[0]!.variables).toEqual({ id: 'ENG-7' });
    expect(bodies[1]!.variables).toEqual({ issueId: 'uuid-eng-7', body: 'Hello' });
  });
});
