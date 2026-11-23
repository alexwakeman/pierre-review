// THE BUILD'S SCREENSHOTS ON THE TICKET (ticket-screens.ts) over an in-memory tracker DB and a FAKE Jira: behind the
// same gate as every tracker write, one multipart upload per screenshot with Jira's no-check header, then ONE comment
// that shows the names Jira stored; a failure says whether anything was already written.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { trackerTickets, workspaceTrackers } from '../db/schema.sqlite.js';
import { postTicketScreenshots } from './ticket-screens.js';
import type { JiraTransport, RawResponse } from './jira/fetch.js';
import type { TrackerContext } from './context.js';

const SITE = 'https://acme.atlassian.net';
const ident = (key: string): string => `jira:${SITE}#${key}`;
const migration = (name: string): string => readFileSync(fileURLToPath(new URL(`../db/migrations/${name}`, import.meta.url)), 'utf8');
const workspaces = sqliteTable('workspaces', { id: integer('id').primaryKey(), accountId: integer('account_id').notNull() });
const sprintTickets = sqliteTable('sprint_tickets', { id: integer('id').primaryKey(), accountId: integer('account_id').notNull(), workspaceId: integer('workspace_id').notNull(), ident: text('ident').notNull() });
const sprintRefTickets = sqliteTable('sprint_ref_tickets', { id: integer('id').primaryKey(), accountId: integer('account_id').notNull(), workspaceId: integer('workspace_id').notNull(), ident: text('ident').notNull() });

let sqlite: Database.Database;
let ctx: TrackerContext;
const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: string | null; bytes: Buffer | null }> = [];
let respond: (url: string, n: number) => RawResponse;
const transport: JiraTransport = async (url, headers, _o, init) => {
  calls.push({ url: String(url), method: init?.method ?? 'GET', headers, body: init?.body ?? null, bytes: init?.bytes ?? null });
  return respond(String(url), calls.length);
};
const json = (body: unknown, status = 200): RawResponse => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

beforeAll(() => {
  sqlite = new Database(':memory:');
  sqlite.exec(
    'CREATE TABLE accounts (id integer PRIMARY KEY); INSERT INTO accounts VALUES (1),(2);' +
      'CREATE TABLE workspaces (id integer PRIMARY KEY, account_id integer NOT NULL);' +
      'CREATE UNIQUE INDEX workspaces_id_account ON workspaces (id, account_id);' +
      'INSERT INTO workspaces VALUES (1,1),(2,1),(3,1);' +
      'CREATE TABLE sprint_tickets (id integer PRIMARY KEY AUTOINCREMENT, account_id integer NOT NULL, workspace_id integer NOT NULL, ident text NOT NULL);' +
      'CREATE TABLE sprint_ref_tickets (id integer PRIMARY KEY AUTOINCREMENT, account_id integer NOT NULL, workspace_id integer NOT NULL, ident text NOT NULL);',
  );
  sqlite.exec(migration('0088_issue_tracker.sql'));
  sqlite.exec(migration('0144_workspace_tracker_notion.sql'));
  sqlite.exec(migration('0098_tracker_ticket_dates.sql'));
  sqlite.exec('ALTER TABLE tracker_tickets ADD blocked_by_json text; ALTER TABLE tracker_tickets ADD status_id text; ALTER TABLE tracker_tickets ADD linked_at integer;');
  ctx = {
    db: drizzle(sqlite),
    host: {},
    log: { warn: () => {}, info: () => {}, error: () => {} },
    schema: { trackerTickets, workspaceTrackers, workspaces, sprintTickets, sprintRefTickets },
  } as unknown as TrackerContext;
});

beforeEach(() => {
  calls.length = 0;
  respond = (url) => (url.endsWith('/attachments') ? json([{ filename: 'ensemble-7-1.png' }]) : json({ id: '1' }, 201));
  sqlite.exec('DELETE FROM tracker_tickets; DELETE FROM workspace_trackers;');
  sqlite.exec(
    "INSERT INTO workspace_trackers (account_id, workspace_id, provider, base_url, auth_email, auth_token) VALUES " +
      "(1, 2, 'jira', 'https://acme.atlassian.net', 'dev@acme.io', 'plain:secret'), (1, 1, 'github', NULL, NULL, NULL), (1, 3, 'linear', 'https://linear.app/acme', NULL, 'plain:lin_api_secret')",
  );
  sqlite
    .prepare(
      "INSERT INTO tracker_tickets (account_id, workspace_id, pr_id, provider, issue_key, detected_from, detect_order, api_root, url, state, fetched_at, checked_at, next_check_at) VALUES (1, 2, 10, 'jira', 'ENG-7', 'title', 0, ?, '', 'ok', 1700000000, 1700000000, 1800000000)",
    )
    .run(SITE);
  sqlite
    .prepare(
      "INSERT INTO tracker_tickets (account_id, workspace_id, pr_id, provider, issue_key, detected_from, detect_order, api_root, url, state, fetched_at, checked_at, next_check_at) VALUES (1, 3, 11, 'linear', 'ENG-7', 'title', 0, 'https://linear.app/acme', '', 'ok', 1700000000, 1700000000, 1800000000)",
    )
    .run();
});

const shots = [
  { name: 'ensemble-7-1.png', png: PNG },
  { name: 'ensemble-7-2.png', png: PNG },
];
const post = (over: Partial<{ ident: string; workspaceId: number }> = {}) =>
  postTicketScreenshots(ctx, { accountId: 1, workspaceId: 2, ident: ident('ENG-7'), shots, comment: (names) => names.map((n) => `!${n}|thumbnail!`).join(' '), ...over }, transport);

describe('postTicketScreenshots', () => {
  it('one upload per screenshot with Jira’s no-check header, then ONE comment showing the names Jira stored', async () => {
    respond = (url, n) => (url.endsWith('/attachments') ? json([{ filename: n === 1 ? 'ensemble-7-1.png' : 'ensemble-7-2 (1).png' }]) : json({ id: '1' }, 201));
    const r = await post();
    expect(r).toEqual({ ok: true, attachments: 2 });
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ['POST', `${SITE}/rest/api/2/issue/ENG-7/attachments`],
      ['POST', `${SITE}/rest/api/2/issue/ENG-7/attachments`],
      ['POST', `${SITE}/rest/api/2/issue/ENG-7/comment`],
    ]);
    expect(calls[0]!.headers['x-atlassian-token']).toBe('no-check');
    expect(calls[0]!.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
    expect(calls[0]!.headers.authorization).toMatch(/^Basic /);
    expect(calls[0]!.bytes!.toString('latin1')).toContain('filename="ensemble-7-1.png"');
    expect(calls[0]!.bytes!.includes(PNG)).toBe(true);
    expect(JSON.parse(calls[2]!.body!)).toEqual({ body: '!ensemble-7-1.png|thumbnail! !ensemble-7-2 (1).png|thumbnail!' });
  });

  it('a failure on the second upload: something was written, so it must not be retried', async () => {
    respond = (url, n) => (n === 2 ? json({}, 500) : url.endsWith('/attachments') ? json([{ filename: 'a.png' }]) : json({}, 201));
    const r = await post();
    expect(r).toMatchObject({ ok: false, wrote: true, error: 'JiraError' });
    expect(calls).toHaveLength(2);
  });

  it('a refused first upload wrote nothing', async () => {
    respond = () => json({}, 403);
    expect(await post()).toMatchObject({ ok: false, wrote: false });
  });

  it('the gate: a workspace not on Jira, and a ticket Ensemble does not hold, call nobody', async () => {
    expect(await post({ workspaceId: 1 })).toMatchObject({ ok: false, error: 'NotJira', wrote: false });
    expect(await post({ ident: ident('ENG-404') })).toMatchObject({ ok: false, status: 404, wrote: false });
    expect(calls).toEqual([]);
  });

  it('Linear: each shot through its file upload, then ONE markdown comment with the asset addresses', async () => {
    const formats: string[] = [];
    respond = (url) => {
      if (url.startsWith('https://api.linear.app/')) {
        const q = JSON.parse(calls.at(-1)!.body!) as { query: string };
        if (q.query.includes('fileUpload')) return json({ data: { fileUpload: { success: true, uploadFile: { uploadUrl: `https://storage.googleapis.com/u/${calls.length}`, assetUrl: `https://uploads.linear.app/a/${calls.length}.png`, headers: [] } } } });
        if (q.query.includes('issue(id')) return json({ data: { issue: { id: 'uuid-7' } } });
        return json({ data: { commentCreate: { success: true } } });
      }
      return { status: 200, contentType: '', body: '' };
    };
    const r = await postTicketScreenshots(
      ctx,
      { accountId: 1, workspaceId: 3, ident: 'linear:https://linear.app/acme#ENG-7', shots, comment: (refs, format) => (formats.push(format), refs.map((u) => `![x](${u})`).join(' ')) },
      transport,
    );
    expect(r).toEqual({ ok: true, attachments: 2 });
    expect(formats).toEqual(['linear']);
    expect(calls.filter((c) => c.method === 'PUT').map((c) => c.url)).toEqual(['https://storage.googleapis.com/u/1', 'https://storage.googleapis.com/u/3']);
    const comment = JSON.parse(calls.at(-1)!.body!) as { variables: { issueId: string; body: string } };
    expect(comment.variables).toEqual({ issueId: 'uuid-7', body: '![x](https://uploads.linear.app/a/1.png) ![x](https://uploads.linear.app/a/3.png)' });
  });

  it('Linear: a ticket Ensemble does not hold calls nobody', async () => {
    const r = await postTicketScreenshots(ctx, { accountId: 1, workspaceId: 3, ident: 'linear:https://linear.app/acme#ENG-404', shots, comment: () => '' }, transport);
    expect(r).toMatchObject({ ok: false, status: 404, wrote: false });
    expect(calls).toEqual([]);
  });
});
