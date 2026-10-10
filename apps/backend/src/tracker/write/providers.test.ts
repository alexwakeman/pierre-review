import { beforeEach, describe, expect, it } from 'vitest';
import { JiraFetchError, type JiraTransport, type RawResponse } from '../jira/fetch.js';
import { __resetLinearBudget } from '../linear/client.js';
import type { TrackerCall } from '../types.js';
import { GithubWriteError, type FetchLike } from './github-rest.js';
import { WRITERS, WriteFailure, classifyWriteError, githubWriter } from './providers.js';
import { trackerWriteMessage } from './messages.js';

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function transport(answers: RawResponse[]): { t: JiraTransport; sent: Sent[] } {
  const sent: Sent[] = [];
  const t: JiraTransport = async (url, headers, _opts, init) => {
    sent.push({ url: url.toString(), method: init?.method ?? 'GET', headers, body: init?.body != null ? JSON.parse(init.body) : undefined });
    const a = answers.shift();
    if (a == null) throw new Error('unexpected request');
    return a;
  };
  return { t, sent };
}
const json = (status: number, body: unknown): RawResponse => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

const jiraCall = (t: JiraTransport, email: string | null = 'me@acme.test'): TrackerCall => ({
  provider: 'jira',
  apiRoot: 'https://acme.atlassian.net',
  credentials: { email, token: 'tok' },
  policy: { cloud: false },
  transport: t,
});

describe('Jira writer', () => {
  it('Cloud comment: POST v3 with an ADF body; the link focuses the comment', async () => {
    const { t, sent } = transport([json(201, { id: '10500' })]);
    const out = await WRITERS.jira.comment(jiraCall(t), 'ENG-1', '- one\n- **two**');
    expect(sent[0]!.method).toBe('POST');
    expect(sent[0]!.url).toBe('https://acme.atlassian.net/rest/api/3/issue/ENG-1/comment');
    expect(sent[0]!.headers.authorization).toMatch(/^Basic /);
    expect(sent[0]!.body).toMatchObject({ body: { type: 'doc', version: 1, content: [{ type: 'bulletList' }] } });
    expect(out.url).toBe('https://acme.atlassian.net/browse/ENG-1?focusedCommentId=10500');
  });

  it('Server comment: POST v2 with wiki markup', async () => {
    const { t, sent } = transport([json(201, { id: '7' })]);
    await WRITERS.jira.comment(jiraCall(t, null), 'ENG-1', '- one');
    expect(sent[0]!.url).toBe('https://acme.atlassian.net/rest/api/2/issue/ENG-1/comment');
    expect(sent[0]!.headers.authorization).toMatch(/^Bearer /);
    expect(sent[0]!.body).toEqual({ body: '* one' });
  });

  it('Cloud replace of a paragraph criteria field: reads edit metadata, PUTs ADF into that field', async () => {
    const { t, sent } = transport([
      json(200, { fields: { customfield_1: { schema: { type: 'string', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:textarea' } } } }),
      { status: 204, contentType: '', body: '' },
    ]);
    const out = await WRITERS.jira.replace(jiraCall(t), 'ENG-1', { kind: 'ac_field', fieldId: 'customfield_1', fieldName: 'AC' }, 'hi', { fieldType: null });
    expect(sent[0]!.url).toBe('https://acme.atlassian.net/rest/api/3/issue/ENG-1/editmeta');
    expect(sent[1]).toMatchObject({ method: 'PUT', url: 'https://acme.atlassian.net/rest/api/3/issue/ENG-1' });
    expect(sent[1]!.body).toEqual({ fields: { customfield_1: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hi' }] }] } } });
    expect(out.url).toBe('https://acme.atlassian.net/browse/ENG-1');
  });

  it('a single-line text field gets the plain string', async () => {
    const { t, sent } = transport([{ status: 204, contentType: '', body: '' }]);
    await WRITERS.jira.replace(jiraCall(t), 'ENG-1', { kind: 'ac_field', fieldId: 'customfield_1', fieldName: 'AC' }, 'hi', {
      fieldType: 'com.atlassian.jira.plugin.system.customfieldtypes:textfield',
    });
    expect(sent[0]!.body).toEqual({ fields: { customfield_1: 'hi' } });
  });

  it('description replace writes `description`', async () => {
    const { t, sent } = transport([{ status: 204, contentType: '', body: '' }]);
    await WRITERS.jira.replace(jiraCall(t), 'ENG-1', { kind: 'description' }, 'hi', { fieldType: null });
    expect(Object.keys((sent[0]!.body as { fields: object }).fields)).toEqual(['description']);
  });

  it('edit metadata with no editable fields → no_write_permission; field missing → rejected', async () => {
    const a = transport([json(200, { fields: {} })]);
    await expect(
      WRITERS.jira.replace(jiraCall(a.t), 'ENG-1', { kind: 'ac_field', fieldId: 'customfield_1', fieldName: 'AC' }, 'x', { fieldType: null }),
    ).rejects.toMatchObject({ code: 'no_write_permission' });
    const b = transport([json(200, { fields: { summary: {} } })]);
    await expect(
      WRITERS.jira.replace(jiraCall(b.t), 'ENG-1', { kind: 'ac_field', fieldId: 'customfield_1', fieldName: 'AC' }, 'x', { fieldType: null }),
    ).rejects.toMatchObject({ code: 'rejected' });
  });

  it('a 403 on the write is the token-cannot-write refusal', async () => {
    const { t } = transport([json(403, {})]);
    const err = await WRITERS.jira.comment(jiraCall(t), 'ENG-1', 'x').catch((e: unknown) => e);
    expect(classifyWriteError(err)).toEqual({ status: 'failed', code: 'no_write_permission' });
  });
});

describe('Linear writer', () => {
  beforeEach(() => __resetLinearBudget());
  const linearCall = (t: JiraTransport): TrackerCall => ({
    provider: 'linear',
    apiRoot: 'https://linear.app/acme',
    credentials: { email: null, token: 'lin_api_abcdefgh' },
    policy: { cloud: false },
    transport: t,
  });

  it('comment: resolves the issue by key, then commentCreate', async () => {
    const { t, sent } = transport([
      json(200, { data: { issue: { id: 'uuid-1', url: 'https://linear.app/acme/issue/ENG-1' } } }),
      json(200, { data: { commentCreate: { success: true, comment: { url: 'https://linear.app/acme/issue/ENG-1#comment-1' } } } }),
    ]);
    const out = await WRITERS.linear.comment(linearCall(t), 'ENG-1', 'body');
    expect(sent[0]!.body).toMatchObject({ variables: { id: 'ENG-1' } });
    expect(String((sent[1]!.body as { query: string }).query)).toContain('commentCreate');
    expect(sent[1]!.body).toMatchObject({ variables: { input: { issueId: 'uuid-1', body: 'body' } } });
    expect(out.url).toBe('https://linear.app/acme/issue/ENG-1#comment-1');
  });

  it('replace: issueUpdate description', async () => {
    const { t, sent } = transport([
      json(200, { data: { issue: { id: 'uuid-1', url: 'x' } } }),
      json(200, { data: { issueUpdate: { success: true, issue: { url: 'https://linear.app/acme/issue/ENG-1' } } } }),
    ]);
    await WRITERS.linear.replace(linearCall(t), 'ENG-1', { kind: 'description' }, 'new', { fieldType: null });
    expect(String((sent[1]!.body as { query: string }).query)).toContain('issueUpdate');
    expect(sent[1]!.body).toMatchObject({ variables: { id: 'uuid-1', input: { description: 'new' } } });
  });

  it('success:false → rejected', async () => {
    const { t } = transport([json(200, { data: { issue: { id: 'u', url: 'x' } } }), json(200, { data: { commentCreate: { success: false, comment: null } } })]);
    await expect(WRITERS.linear.comment(linearCall(t), 'ENG-1', 'b')).rejects.toMatchObject({ code: 'rejected' });
  });

  it('a read-only key refused as a 400 FORBIDDEN body → no_write_permission', async () => {
    const { t } = transport([
      json(200, { data: { issue: { id: 'u', url: 'x' } } }),
      json(400, { errors: [{ message: 'Forbidden', extensions: { code: 'FORBIDDEN', type: 'forbidden', statusCode: 403 } }] }),
    ]);
    const err = await WRITERS.linear.comment(linearCall(t), 'ENG-1', 'b').catch((e: unknown) => e);
    expect(classifyWriteError(err)).toEqual({ status: 'failed', code: 'no_write_permission' });
  });

  it('an unknown key → not_found', async () => {
    const { t } = transport([json(200, { data: { issue: null } })]);
    await expect(WRITERS.linear.comment(linearCall(t), 'ENG-9', 'b')).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('GitHub Issues writer', () => {
  const ghCall: TrackerCall = {
    provider: 'github',
    apiRoot: 'https://github.com',
    credentials: { email: null, token: '' },
    policy: { cloud: false },
    github: { accountId: 7, graphql: async () => ({ data: null }) },
  };
  const fakeFetch = (status: number, body: unknown) => {
    const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: unknown }> = [];
    const f: FetchLike = async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers, body: JSON.parse(init.body) });
      return { ok: status >= 200 && status < 300, status, json: async () => body };
    };
    return { f, calls };
  };

  it('comment: POST /repos/o/r/issues/n/comments with the ACCOUNT token', async () => {
    const tokens: number[] = [];
    const { f, calls } = fakeFetch(201, { html_url: 'https://github.com/acme/web/issues/12#issuecomment-1' });
    const w = githubWriter({ token: async (id) => (tokens.push(id), 'ghtok'), fetch: f });
    const out = await w.comment(ghCall, 'acme/web#12', 'hello');
    expect(tokens).toEqual([7]);
    expect(calls[0]).toMatchObject({ url: 'https://api.github.com/repos/acme/web/issues/12/comments', method: 'POST', body: { body: 'hello' } });
    expect(calls[0]!.headers.authorization).toBe('token ghtok');
    expect(out.url).toBe('https://github.com/acme/web/issues/12#issuecomment-1');
  });

  it('replace: PATCH /repos/o/r/issues/n { body }', async () => {
    const { f, calls } = fakeFetch(200, { html_url: 'https://github.com/acme/web/issues/12' });
    await githubWriter({ token: async () => 't', fetch: f }).replace(ghCall, 'acme/web#12', { kind: 'description' }, 'new body', { fieldType: null });
    expect(calls[0]).toMatchObject({ url: 'https://api.github.com/repos/acme/web/issues/12', method: 'PATCH', body: { body: 'new body' } });
  });

  it('403 → no_write_permission; a thrown fetch → maybe_written', async () => {
    const { f } = fakeFetch(403, {});
    const err = await githubWriter({ token: async () => 't', fetch: f }).comment(ghCall, 'acme/web#12', 'x').catch((e: unknown) => e);
    expect(classifyWriteError(err)).toEqual({ status: 'failed', code: 'no_write_permission' });
    const boom: FetchLike = async () => {
      throw Object.assign(new Error('t'), { name: 'TimeoutError' });
    };
    const err2 = await githubWriter({ token: async () => 't', fetch: boom }).comment(ghCall, 'acme/web#12', 'x').catch((e: unknown) => e);
    expect(classifyWriteError(err2)).toEqual({ status: 'maybe_written', code: 'timeout' });
  });
});

describe('classifyWriteError', () => {
  it.each([
    [new JiraFetchError('unauthorized', 401), 'failed', 'no_write_permission'],
    [new JiraFetchError('not_found', 404), 'failed', 'not_found'],
    [new JiraFetchError('http', 429), 'failed', 'rate_limited'],
    [new JiraFetchError('http', 400), 'failed', 'rejected'],
    [new JiraFetchError('http', 500), 'failed', 'failed'],
    [new JiraFetchError('timeout'), 'maybe_written', 'timeout'],
    [new JiraFetchError('network'), 'maybe_written', 'timeout'],
    [new JiraFetchError('not_json', 201), 'maybe_written', 'failed'],
    [new JiraFetchError('blocked'), 'failed', 'failed'],
    [new GithubWriteError(422, 'http'), 'failed', 'rejected'],
    [new WriteFailure('not_found'), 'failed', 'not_found'],
    [new Error('x'), 'failed', 'failed'],
  ])('%s → %s / %s', (err, status, code) => {
    expect(classifyWriteError(err)).toEqual({ status, code });
  });
});

describe('trackerWriteMessage', () => {
  it('names the provider and never speaks on success', () => {
    expect(trackerWriteMessage({ status: 'failed', errorCode: 'no_write_permission', provider: 'jira' })).toBe('This token can’t write to Jira.');
    expect(trackerWriteMessage({ status: 'failed', errorCode: 'no_write_permission', provider: 'linear' })).toBe('This token can’t write to Linear.');
    expect(trackerWriteMessage({ status: 'maybe_written', errorCode: 'timeout', provider: 'github' })).toMatch(/may have been written/);
    expect(trackerWriteMessage({ status: 'written', errorCode: null, provider: 'jira' })).toBeNull();
    expect(trackerWriteMessage({ status: 'failed', errorCode: 'rejected', provider: 'github' })).toBe('GitHub refused the update.');
  });
});
