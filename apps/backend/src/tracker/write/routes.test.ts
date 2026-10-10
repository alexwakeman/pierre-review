import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { parseWriteBody, registerTrackerWriteRoutes } from './routes.js';

// POST /api/sprint-stories/write — the body check and the 402 (before any DB work; this test opens no
// database at all, which is itself the pin: an unentitled or malformed request never reaches ./run.ts).

const ok = { workspaceId: 3, ident: 'jira:https://acme.atlassian.net#ENG-1', mode: 'comment', text: ' hi ', requestId: 'abcdefgh12' };

describe('parseWriteBody', () => {
  it('accepts a comment and trims the text', () => {
    expect(parseWriteBody(ok)).toEqual({ ok: true, body: { ...ok, text: 'hi', assessmentId: null } });
  });
  it.each([
    [{ ...ok, mode: 'bulk' }],
    [{ ...ok, requestId: 'short' }],
    [{ ...ok, requestId: 'has space 123' }],
    [{ ...ok, workspaceId: '3' }],
    [{ ...ok, workspaceId: 1.5 }],
    [{ ...ok, ident: '' }],
    [{ ...ok, mode: 'replace' }],
    [{ ...ok, mode: 'replace', target: { kind: 'ac_field' } }],
    [{ ...ok, assessmentId: 'x' }],
    [{ ...ok, assessmentId: 2 ** 31 }],
    [{ ...ok, mode: 'replace', target: { kind: 'description' } }],
    [{ ...ok, mode: 'replace', target: { kind: 'description' }, baseHash: 'nothex' }],
    [null],
  ])('bad_request: %j', (b) => {
    expect(parseWriteBody(b)).toMatchObject({ ok: false, status: 400, body: { error: 'bad_request' } });
  });
  it('bad_text for NUL and empty text', () => {
    expect(parseWriteBody({ ...ok, text: 'a\u0000' })).toMatchObject({ ok: false, body: { error: 'bad_text' } });
    expect(parseWriteBody({ ...ok, text: '  ' })).toMatchObject({ ok: false, body: { error: 'bad_text' } });
  });
  it('replace carries its target', () => {
    const baseHash = 'a'.repeat(64);
    const r = parseWriteBody({ ...ok, mode: 'replace', target: { kind: 'description' }, baseHash, assessmentId: 4 });
    expect(r).toMatchObject({ ok: true, body: { mode: 'replace', target: { kind: 'description' }, baseHash, assessmentId: 4 } });
  });
});

describe('the route', () => {
  it('402s an unentitled caller before reading the body', async () => {
    const app = Fastify();
    registerTrackerWriteRoutes(app);
    const res = await app.inject({ method: 'POST', url: '/api/sprint-stories/write', payload: { nonsense: true } });
    expect(res.statusCode).toBe(402);
    await app.close();
  });
});
