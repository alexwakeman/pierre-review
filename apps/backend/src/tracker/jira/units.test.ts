// ── JIRA API ACCESS: the pure parts ────────────────────────────────────────────────────────────
//
// The API-root derivation, the auth header choice, ADF flattening, the field list, the issue read
// against a fake transport, and the sealed/plain token round trip. (Candidates: jira-candidates.)
//
//   ./apps/backend/node_modules/.bin/vitest run --root packages/pro test/jira-units.test.ts
import { describe, expect, it } from 'vitest';
import {
  fetchJiraIssue,
  isJiraFieldId,
  jiraApiRoot,
  jiraAuthHeader,
  jiraErrorMessage,
  toFieldOptions,
  statusOf,
  assigneeOf,
} from './client.js';
import { JiraFetchError, type JiraTransport } from './fetch.js';
import { adfToText, fieldValueToText, normaliseJiraText } from './text.js';
import { openTrackerToken as openJiraToken, storeTrackerToken as storeJiraToken } from '../secret.js';

describe('jiraApiRoot — the ONE derivation of the API root from the tracker base URL', () => {
  it.each([
    ['https://acme.atlassian.net', 'https://acme.atlassian.net'],
    ['https://acme.atlassian.net/', 'https://acme.atlassian.net'],
    ['  https://acme.atlassian.net//  ', 'https://acme.atlassian.net'],
    ['https://acme.atlassian.net/browse', 'https://acme.atlassian.net'],
    ['https://acme.atlassian.net/browse/ENG-12', 'https://acme.atlassian.net'],
    ['https://acme.atlassian.net/rest/api/2', 'https://acme.atlassian.net'],
    ['https://acme.atlassian.net/secure/Dashboard.jspa', 'https://acme.atlassian.net'],
    ['https://acme.atlassian.net/browse/ENG-1?focusedCommentId=3#c', 'https://acme.atlassian.net'],
    // A Data Center context path is KEPT — it is part of the site root.
    ['https://jira.corp.example/jira', 'https://jira.corp.example/jira'],
    ['https://jira.corp.example/jira/browse/ENG-1', 'https://jira.corp.example/jira'],
    ['http://jira.lan:8080/Browse/X-1', 'http://jira.lan:8080'],
  ])('%s → %s', (input, want) => {
    expect(jiraApiRoot(input)).toBe(want);
  });

  it('refuses anything that is not an absolute http(s) URL', () => {
    expect(jiraApiRoot(null)).toBeNull();
    expect(jiraApiRoot('')).toBeNull();
    expect(jiraApiRoot('acme.atlassian.net')).toBeNull();
    expect(jiraApiRoot('ftp://acme.example')).toBeNull();
    expect(jiraApiRoot('javascript:alert(1)')).toBeNull();
  });
});

describe('jiraAuthHeader — email means Jira Cloud (Basic), no email means a PAT (Bearer)', () => {
  it('Basic with email:token when an email is set', () => {
    const h = jiraAuthHeader({ email: 'dev@acme.io', token: 'tok123' });
    expect(h).toBe(`Basic ${Buffer.from('dev@acme.io:tok123').toString('base64')}`);
  });
  it('Bearer when the email is null or blank', () => {
    expect(jiraAuthHeader({ email: null, token: 'pat' })).toBe('Bearer pat');
    expect(jiraAuthHeader({ email: '  ', token: 'pat' })).toBe('Bearer pat');
  });
});

describe('ADF flattening', () => {
  const doc = {
    type: 'doc',
    version: 1,
    content: [
      { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Acceptance' }] },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Line one' },
          { type: 'hardBreak' },
          { type: 'text', text: 'line two ', marks: [{ type: 'strong' }] },
          { type: 'mention', attrs: { text: '@Sam' } },
        ],
      },
      {
        type: 'bulletList',
        content: [
          {
            type: 'listItem',
            content: [
              { type: 'paragraph', content: [{ type: 'text', text: 'first' }] },
              {
                type: 'bulletList',
                content: [
                  {
                    type: 'listItem',
                    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'nested' }] }],
                  },
                ],
              },
            ],
          },
          {
            type: 'listItem',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'second' }] }],
          },
        ],
      },
      {
        type: 'orderedList',
        attrs: { order: 1 },
        content: [
          {
            type: 'listItem',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Given x' }] }],
          },
          {
            type: 'listItem',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Then y' }] }],
          },
        ],
      },
      {
        type: 'taskList',
        content: [
          { type: 'taskItem', attrs: { state: 'DONE' }, content: [{ type: 'text', text: 'done' }] },
          { type: 'taskItem', attrs: { state: 'TODO' }, content: [{ type: 'text', text: 'todo' }] },
        ],
      },
      { type: 'mediaSingle', content: [{ type: 'media', attrs: { id: 'x' } }] },
    ],
  };

  it('keeps headings, paragraphs, hard breaks, "- " items (nested indented), numbers and tasks', () => {
    expect(adfToText(doc)).toBe(
      [
        'Acceptance',
        '',
        'Line one\nline two @Sam',
        '',
        '- first\n  - nested\n- second',
        '',
        '1. Given x\n2. Then y',
        '',
        '- [x] done\n- [ ] todo',
      ].join('\n'),
    );
  });

  it('fieldValueToText reads ADF, wiki strings, checklist arrays and select objects', () => {
    expect(fieldValueToText(doc)).toContain('- first');
    expect(fieldValueToText('h3. AC\r\n* one\r\n* two')).toBe('h3. AC\n* one\n* two');
    expect(fieldValueToText(['Can log in', { value: 'Can log out' }])).toBe(
      '- Can log in\n- Can log out',
    );
    expect(fieldValueToText({ value: 'High' })).toBe('High');
    expect(fieldValueToText(null)).toBe('');
    expect(fieldValueToText(undefined)).toBe('');
  });

  it('removes the control characters the shared validator refuses, and never truncates', () => {
    expect(normaliseJiraText('a\u0000b\u0007c\td')).toBe('abc\td');
    const long = 'x'.repeat(20_000);
    expect(fieldValueToText(long)).toHaveLength(20_000);
  });
});

describe('the field list (the Settings connection check)', () => {
  const raw = [
    { id: 'summary', name: 'Summary', custom: false, schema: { type: 'string' } },
    { id: 'customfield_10300', name: 'Story points', custom: true, schema: { type: 'number' } },
    { id: 'customfield_10500', name: 'Acceptance criteria (old)', custom: true, schema: { type: 'array' } },
    { id: 'customfield_10400', name: 'Acceptance Criteria', custom: true, schema: { type: 'string' } },
    { id: 'bad id!', name: 'Broken', custom: true },
    { id: 'customfield_10600', name: '', custom: true },
  ];

  it('the list is custom fields only, well-formed only, sorted by name', () => {
    const fields = toFieldOptions(raw);
    expect(fields.map((f) => f.id)).toEqual([
      'customfield_10400',
      'customfield_10500',
      'customfield_10300',
    ]);
    expect(toFieldOptions({ not: 'an array' })).toEqual([]);
  });

  it('field ids are query-string safe', () => {
    expect(isJiraFieldId('customfield_10042')).toBe(true);
    expect(isJiraFieldId('customfield_1,summary&x=1')).toBe(false);
    expect(isJiraFieldId('')).toBe(false);
  });
});

describe('fetchJiraIssue', () => {
  const call = (transport: JiraTransport) => ({
    apiRoot: 'https://acme.atlassian.net',
    credentials: { email: null, token: 'pat' },
    policy: { cloud: false },
    transport,
  });

  it('asks for EVERY field plus names and schema, and returns text, type and candidates', async () => {
    let seen: URL | null = null;
    let auth = '';
    const transport: JiraTransport = async (url, headers) => {
      seen = url;
      auth = headers.authorization ?? '';
      return {
        status: 200,
        contentType: 'application/json;charset=UTF-8',
        body: JSON.stringify({
          key: 'ENG-7',
          names: { customfield_10400: 'Acceptance Criteria', customfield_10500: 'Notes' },
          schema: { customfield_10400: { type: 'string' }, customfield_10500: { type: 'string' } },
          fields: {
            summary: 'Reset password',
            description: 'As a user…\r\nI want…',
            issuetype: { id: '10001', name: 'Story' },
            status: { name: 'In Review', statusCategory: { key: 'indeterminate', name: 'In Progress' } },
            assignee: {
              displayName: 'Ada Lovelace',
              accountId: '5b10ac8d82e05b22cc7d4ef5',
              avatarUrls: { '48x48': 'https://avatar.example/ada.png' },
            },
            customfield_10400: {
              type: 'doc',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Email sent' }] }],
            },
            customfield_10500: 'Ask ops',
          },
        }),
      };
    };
    const out = await fetchJiraIssue(call(transport), 'ENG-7');
    expect(String(seen)).toBe(
      'https://acme.atlassian.net/rest/api/2/issue/ENG-7?fields=*all&expand=names,schema',
    );
    expect(auth).toBe('Bearer pat');
    expect(out).toEqual({
      key: 'ENG-7',
      title: 'Reset password',
      description: 'As a user…\nI want…',
      issueType: { id: '10001', name: 'Story' },
      status: { name: 'In Review', category: 'indeterminate' },
      assignee: {
        name: 'Ada Lovelace',
        accountId: '5b10ac8d82e05b22cc7d4ef5',
        avatarUrl: 'https://avatar.example/ada.png',
      },
      candidates: [
        { id: 'customfield_10400', name: 'Acceptance Criteria', text: 'Email sent', match: 'strong' },
        { id: 'customfield_10500', name: 'Notes', text: 'Ask ops', match: null },
      ],
      omittedCandidates: 0,
    });
  });

  it('status and assignee: an unknown category is null, an http avatar is dropped, unassigned is null', () => {
    expect(statusOf({ name: 'Weird', statusCategory: { key: 'undefined' } })).toEqual({ name: 'Weird', category: null });
    expect(statusOf({ name: '' })).toBeNull();
    expect(statusOf(null)).toBeNull();
    expect(assigneeOf({ displayName: 'Bob', key: 'bob', avatarUrls: { '48x48': 'http://jira.lan/a.png' } })).toEqual({
      name: 'Bob',
      accountId: 'bob',
      avatarUrl: null,
    });
    expect(assigneeOf(null)).toBeNull();
    expect(assigneeOf({ accountId: 'x' })).toBeNull();
  });

  it('no names map and no issue type still answers (fields named by id, type null)', async () => {
    const transport: JiraTransport = async () => ({
      status: 200,
      contentType: 'application/json',
      body: '{"fields":{"summary":"S","customfield_1":"text"}}',
    });
    const out = await fetchJiraIssue(call(transport), 'ENG-7');
    expect(out.issueType).toBeNull();
    expect(out.candidates).toEqual([{ id: 'customfield_1', name: 'customfield_1', text: 'text', match: null }]);
  });

  it.each([
    [401, 'unauthorized', 'did not accept the saved token'],
    [403, 'forbidden', 'does not have permission'],
    [404, 'not_found', 'no such ticket'],
    [500, 'http', 'answered with an error (500)'],
    [302, 'redirect', 'redirect'],
  ] as const)('HTTP %i → %s with a plain-English message', async (status, code, words) => {
    const transport: JiraTransport = async () => ({ status, contentType: 'text/html', body: '<h1>secret internals</h1>' });
    const err = await fetchJiraIssue(call(transport), 'ENG-7').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JiraFetchError);
    expect((err as JiraFetchError).code).toBe(code);
    expect(jiraErrorMessage(err)).toContain(words);
    // Never echoes what Jira sent.
    expect(jiraErrorMessage(err)).not.toContain('secret internals');
  });

  it('a 200 that is not JSON (an SSO login page) is not_json', async () => {
    const html: JiraTransport = async () => ({ status: 200, contentType: 'text/html', body: '<html>' });
    const err = await fetchJiraIssue(call(html), 'ENG-7').catch((e: unknown) => e);
    expect((err as JiraFetchError).code).toBe('not_json');
    const broken: JiraTransport = async () => ({ status: 200, contentType: 'application/json', body: '{' });
    const err2 = await fetchJiraIssue(call(broken), 'ENG-7').catch((e: unknown) => e);
    expect((err2 as JiraFetchError).code).toBe('not_json');
  });

  it('a malformed key never reaches Jira', async () => {
    let called = false;
    const transport: JiraTransport = async () => {
      called = true;
      return { status: 200, contentType: 'application/json', body: '{}' };
    };
    await expect(fetchJiraIssue(call(transport), '../../admin')).rejects.toBeInstanceOf(JiraFetchError);
    expect(called).toBe(false);
  });
});

describe('the token at rest — sealed when the host can, plain otherwise, both readable', () => {
  const host = {
    sealSecret: (p: string) => `SEALED(${Buffer.from(p).toString('base64')})`,
    openSecret: (s: string) => {
      const m = /^SEALED\((.*)\)$/.exec(s);
      if (!m) throw new Error('bad');
      return Buffer.from(m[1] ?? '', 'base64').toString('utf8');
    },
  };

  it('seals with the host seam and opens again', () => {
    const stored = storeJiraToken(host, 'tok-1');
    expect(stored.startsWith('sealed:v1:')).toBe(true);
    expect(stored).not.toContain('tok-1');
    expect(openJiraToken(host, stored)).toEqual({ state: 'ok', token: 'tok-1' });
  });

  it('stores plain (prefixed) without the seam, and a sealing host still reads it', () => {
    const stored = storeJiraToken({}, 'tok-2');
    expect(stored).toBe('plain:tok-2');
    expect(openJiraToken({}, stored)).toEqual({ state: 'ok', token: 'tok-2' });
    expect(openJiraToken(host, stored)).toEqual({ state: 'ok', token: 'tok-2' });
  });

  it('a sealed token on a host that cannot open it is UNREADABLE, never sent', () => {
    const stored = storeJiraToken(host, 'tok-3');
    expect(openJiraToken({}, stored)).toEqual({ state: 'unreadable' });
    expect(openJiraToken(host, 'sealed:v1:garbage')).toEqual({ state: 'unreadable' });
    expect(openJiraToken(host, 'no-prefix-at-all')).toEqual({ state: 'unreadable' });
    expect(openJiraToken(host, null)).toEqual({ state: 'none' });
  });
});
