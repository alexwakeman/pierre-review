// ── THE TICKET UPDATE: the reader's press in the build tab's plan panel (./ticket-update.ts) ─────────
//
// Pinned through a real Fastify instance with an injected transport (no network):
//   1. NOT A PROXY — the status change's gate: a ticket Limn holds no row for, another account's,
//      or a non-Jira workspace is refused BEFORE Jira is called.
//   2. One PUT with the fields sent: the description as wiki markup, the criteria in their field's
//      own format (editmeta: wiki for a text area, plain for a one-line field, refused otherwise);
//      the stored rows are marked due.
//   3. Criteria with no field of their own are SPLICED into the description's criteria section.
//   4. Every refusal is a sentence Limn wrote.
//   5. GET …/current: the stored copy and where the criteria live, DB only, scoped.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import {
  TICKET_STATUS_NO_PERMISSION,
  TICKET_UPDATE_FIELD_NOT_EDITABLE,
  TICKET_UPDATE_FIELD_ONE_LINE,
} from '@pierre-review/shared';
import { trackerTickets, workspaceTrackers } from '../db/schema.sqlite.js';
import { registerTicketUpdateRoutes } from './ticket-update.js';
import type { JiraTransport, RawResponse, TransportInit } from './jira/fetch.js';
import type { TrackerContext } from './context.js';

const SITE = 'https://acme.atlassian.net';
const ident = (key: string): string => `jira:${SITE}#${key}`;
const migration = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../db/migrations/${name}`, import.meta.url)), 'utf8');

const workspaces = sqliteTable('workspaces', { id: integer('id').primaryKey(), accountId: integer('account_id').notNull() });
const sprintTickets = sqliteTable('sprint_tickets', {
  id: integer('id').primaryKey(),
  accountId: integer('account_id').notNull(),
  workspaceId: integer('workspace_id').notNull(),
  ident: text('ident').notNull(),
  description: text('description').notNull(),
  acceptanceCriteria: text('acceptance_criteria').notNull(),
  acFieldId: text('ac_field_id'),
  acFieldName: text('ac_field_name'),
  fetchedAt: integer('fetched_at', { mode: 'timestamp' }),
});
const sprintRefTickets = sqliteTable('sprint_ref_tickets', {
  id: integer('id').primaryKey(),
  accountId: integer('account_id').notNull(),
  workspaceId: integer('workspace_id').notNull(),
  ident: text('ident').notNull(),
});

let app: FastifyInstance;
let sqlite: Database.Database;
let account = 1;
const calls: Array<{ url: string; method: string; body: string | null }> = [];
let respond: (url: string, init?: TransportInit) => RawResponse = () => ({ status: 204, contentType: '', body: '' });
const transport: JiraTransport = async (url, _headers, _opts, init) => {
  calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body ?? null });
  return respond(String(url), init);
};

beforeAll(async () => {
  sqlite = new Database(':memory:');
  sqlite.exec(
    'CREATE TABLE accounts (id integer PRIMARY KEY); INSERT INTO accounts VALUES (1),(2);' +
      'CREATE TABLE workspaces (id integer PRIMARY KEY, account_id integer NOT NULL);' +
      'CREATE UNIQUE INDEX workspaces_id_account ON workspaces (id, account_id);' +
      'INSERT INTO workspaces VALUES (1,1),(2,1),(90,2);' +
      'CREATE TABLE sprint_tickets (id integer PRIMARY KEY AUTOINCREMENT, account_id integer NOT NULL, ' +
      "workspace_id integer NOT NULL, ident text NOT NULL, description text NOT NULL DEFAULT '', " +
        "acceptance_criteria text NOT NULL DEFAULT '', ac_field_id text, ac_field_name text, fetched_at integer);" +
      'CREATE TABLE sprint_ref_tickets (id integer PRIMARY KEY AUTOINCREMENT, account_id integer NOT NULL, ' +
      'workspace_id integer NOT NULL, ident text NOT NULL);',
  );
  sqlite.exec(migration('0088_issue_tracker.sql'));
  sqlite.exec(migration('0144_workspace_tracker_notion.sql'));
  sqlite.exec(migration('0098_tracker_ticket_dates.sql'));
  sqlite.exec('ALTER TABLE tracker_tickets ADD blocked_by_json text; ALTER TABLE tracker_tickets ADD status_id text;');
  sqlite.exec('ALTER TABLE tracker_tickets ADD linked_at integer;'); // migration 0182
  const ctx = {
    db: drizzle(sqlite),
    host: {},
    accountIdOf: () => account,
    defaultWorkspaceId: async (a: number) => (a === 1 ? 1 : 90),
    log: { warn: () => {}, info: () => {}, error: () => {} },
    schema: { trackerTickets, workspaceTrackers, workspaces, sprintTickets, sprintRefTickets },
  } as unknown as TrackerContext;
  const { default: Fastify } = await import('fastify');
  app = Fastify({ logger: false });
  registerTicketUpdateRoutes(app, ctx, { transport });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  sqlite?.close();
});

const ticketRow = (
  acct: number,
  ws: number,
  pr: number,
  key: string,
  acField: string | null,
  text: { description?: string; criteria?: string } = {},
): void => {
  sqlite
    .prepare(
      'INSERT INTO tracker_tickets (account_id, workspace_id, pr_id, provider, issue_key, detected_from, detect_order, ' +
        "api_root, url, state, ac_field_id, ac_field_name, description, acceptance_criteria, fetched_at, checked_at, next_check_at) " +
        "VALUES (?,?,?,'jira',?,'title',0,?,'','ok',?,?,?,?,1700000000,1700000000,1800000000)",
    )
    .run(acct, ws, pr, key, SITE, acField, acField == null ? null : 'Acceptance Criteria', text.description ?? null, text.criteria ?? null);
};

const DESC_WITH_AC = '## Context\nWhy.\n\n## Acceptance criteria\n1. old one\n\n## Notes\nkeep';

beforeEach(() => {
  calls.length = 0;
  account = 1;
  respond = () => ({ status: 204, contentType: '', body: '' });
  sqlite.exec('DELETE FROM tracker_tickets; DELETE FROM sprint_tickets; DELETE FROM sprint_ref_tickets; DELETE FROM workspace_trackers;');
  sqlite.exec(
    "INSERT INTO workspace_trackers (account_id, workspace_id, provider, base_url, auth_email, auth_token) VALUES " +
      "(1, 2, 'jira', 'https://acme.atlassian.net', 'dev@acme.io', 'plain:secret')," +
      "(1, 1, 'github', NULL, NULL, NULL)," +
      "(2, 90, 'jira', 'https://acme.atlassian.net', 'x@other.io', 'plain:other')",
  );
  ticketRow(1, 2, 10, 'ENG-7', 'customfield_10042', { description: 'Story', criteria: '- GIVEN a report' });
  ticketRow(1, 2, 12, 'ENG-8', null, { description: DESC_WITH_AC });
  ticketRow(1, 2, 13, 'ENG-9', null, { description: 'Just a story.' });
  ticketRow(2, 90, 91, 'ENG-99', 'customfield_1');
  sqlite.exec(`INSERT INTO sprint_tickets (account_id, workspace_id, ident, ac_field_id, ac_field_name) VALUES (1, 2, '${ident('ENG-50')}', 'customfield_7', 'DoD')`);
});

const update = (id: string, body: { description?: string | null; acceptanceCriteria?: string | null }, ws = 2) =>
  app.inject({
    method: 'POST',
    url: `/api/ticket-update?workspace=${ws}`,
    payload: { ident: id, description: body.description ?? null, acceptanceCriteria: body.acceptanceCriteria ?? null },
  });

/** Jira's answers: editmeta names the criteria field's schema; the PUT answers 204. */
const editmeta = (fields: Record<string, unknown>): void => {
  respond = (url) =>
    url.endsWith('/editmeta')
      ? { status: 200, contentType: 'application/json', body: JSON.stringify({ fields }) }
      : { status: 204, contentType: '', body: '' };
};
const textarea = { schema: { type: 'string', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:textarea' } };
const textfield = { schema: { type: 'string', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:textfield' } };
const select = { schema: { type: 'option', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:select' } };
const puts = () => calls.filter((c) => c.method === 'PUT');

describe('1. not a proxy', () => {
  it('refuses a ticket Limn holds no row for, another account’s, and a non-Jira workspace, before any Jira call', async () => {
    expect((await update(ident('ENG-1234'), { description: 'x' })).statusCode).toBe(404);
    expect((await update(ident('ENG-99'), { description: 'x' })).statusCode).toBe(404);
    const gh = await update(ident('ENG-7'), { description: 'x' }, 1);
    expect(gh.statusCode).toBe(400);
    expect(gh.json().message).toMatch(/works with Jira only/);
    expect(calls).toHaveLength(0);
  });

  it('refuses an empty update', async () => {
    const res = await update(ident('ENG-7'), {});
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('NothingToUpdate');
    expect(calls).toHaveLength(0);
  });
});

describe('2. one PUT with the fields sent', () => {
  it('writes the description as wiki markup and the criteria as wiki markup into their text-area field, then marks the rows due', async () => {
    editmeta({ customfield_10042: textarea });
    const res = await update(ident('ENG-7'), { description: '## Context\n- **one**', acceptanceCriteria: '- GIVEN a report\n- THEN **it** shows' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      updated: { description: true, acceptanceCriteria: true },
      criteriaField: 'Acceptance Criteria',
      criteriaWritten: 'field',
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ method: 'GET', url: `${SITE}/rest/api/2/issue/ENG-7/editmeta` });
    expect(calls[1]).toMatchObject({ method: 'PUT', url: `${SITE}/rest/api/2/issue/ENG-7` });
    expect(JSON.parse(calls[1]!.body!)).toEqual({
      fields: { description: 'h2. Context\n* *one*', customfield_10042: '* GIVEN a report\n* THEN *it* shows' },
    });
    const row = sqlite.prepare("SELECT next_check_at FROM tracker_tickets WHERE issue_key = 'ENG-7' AND account_id = 1").get() as { next_check_at: number };
    expect(row.next_check_at).toBe(0);
    // Another account's row is untouched.
    const other = sqlite.prepare("SELECT next_check_at FROM tracker_tickets WHERE account_id = 2").get() as { next_check_at: number };
    expect(other.next_check_at).toBe(1800000000);
  });

  it('a description alone touches no other field and reads no editmeta; a sprint row names the criteria field too', async () => {
    await update(ident('ENG-9'), { description: 'plain' });
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]!.body!)).toEqual({ fields: { description: 'plain' } });
    editmeta({ customfield_7: textarea });
    const res = await update(ident('ENG-50'), { acceptanceCriteria: 'AC' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(puts()[1]!.body!)).toEqual({ fields: { customfield_7: 'AC' } });
  });

  it('a one-line text field gets plain text; longer than 255 characters is refused before the PUT', async () => {
    editmeta({ customfield_10042: textfield });
    const ok = await update(ident('ENG-7'), { acceptanceCriteria: '- **Fast**\n- [docs](https://x.io)' });
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(puts()[0]!.body!)).toEqual({ fields: { customfield_10042: 'Fast docs' } });
    calls.length = 0;
    const long = await update(ident('ENG-7'), { acceptanceCriteria: 'x'.repeat(256) });
    expect(long.statusCode).toBe(400);
    expect(long.json()).toMatchObject({ error: 'CriteriaTooLong', message: TICKET_UPDATE_FIELD_ONE_LINE });
    expect(puts()).toHaveLength(0);
  });

  it('a select field, or a field missing from editmeta, is refused before the PUT', async () => {
    editmeta({ customfield_10042: select });
    const a = await update(ident('ENG-7'), { acceptanceCriteria: 'AC' });
    expect(a.statusCode).toBe(400);
    expect(a.json()).toMatchObject({ error: 'CriteriaFieldNotEditable', message: TICKET_UPDATE_FIELD_NOT_EDITABLE });
    editmeta({});
    const b = await update(ident('ENG-7'), { acceptanceCriteria: 'AC', description: 'd' });
    expect(b.statusCode).toBe(400);
    expect(b.json().error).toBe('CriteriaFieldNotEditable');
    expect(puts()).toHaveLength(0);
  });
});

describe('3. criteria that live in the description', () => {
  /** Jira's live description (wiki) for a GET …?fields=description; the PUT answers 204. */
  const liveDescription = (wiki: unknown): void => {
    respond = (url) =>
      url.includes('?fields=description')
        ? { status: 200, contentType: 'application/json', body: JSON.stringify({ fields: { description: wiki } }) }
        : { status: 204, contentType: '', body: '' };
  };

  it('criteria only: ONE live read, then ONLY the criteria block of the LIVE wiki is replaced (colours, images, panels kept)', async () => {
    const wiki = 'h2. Context\n{color:#0747a6}Why.{color} !shot.png|width=300!\n{panel}note{panel}\n\nh2. Acceptance criteria\n# old one\n\nh2. Notes\nkeep';
    liveDescription(wiki);
    const res = await update(ident('ENG-8'), { acceptanceCriteria: '1. new one\n2. new two' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ criteriaWritten: 'description', criteriaField: null, updated: { description: true } });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ method: 'GET', url: `${SITE}/rest/api/2/issue/ENG-8?fields=description` });
    expect(JSON.parse(calls[1]!.body!)).toEqual({
      fields: { description: 'h2. Context\n{color:#0747a6}Why.{color} !shot.png|width=300!\n{panel}note{panel}\n\nh2. Acceptance criteria\n# new one\n# new two\n\nh2. Notes\nkeep' },
    });
  });

  it('criteria only under a bold label (*Acceptance Criteria:*): the label kept, the block replaced, no second section', async () => {
    liveDescription('Story text.\n\n*Acceptance Criteria:*\n* old\n\n*Notes:*\nkeep');
    sqlite.prepare('UPDATE tracker_tickets SET description = ? WHERE issue_key = ?').run('Story text.\n\n**Acceptance Criteria:**\n- old\n\n**Notes:**\nkeep', 'ENG-8');
    await update(ident('ENG-8'), { acceptanceCriteria: '- new' });
    expect(JSON.parse(calls[1]!.body!).fields.description).toBe('Story text.\n\n*Acceptance Criteria:*\n* new\n\n*Notes:*\nkeep');
  });

  it('criteria only, a description Jira does not answer as text: refused before the PUT', async () => {
    liveDescription({ type: 'doc', content: [] });
    const res = await update(ident('ENG-8'), { acceptanceCriteria: '1. x' });
    expect(res.statusCode).toBe(400);
    expect(puts()).toHaveLength(0);
  });

  it('are spliced into the description SENT in the same press', async () => {
    await update(ident('ENG-8'), { description: '## Context\nNew why.\n\n## Acceptance criteria\n1. old one', acceptanceCriteria: '1. new' });
    expect(JSON.parse(calls[0]!.body!).fields.description).toBe('h2. Context\nNew why.\n\nh2. Acceptance criteria\n\n# new');
  });

  it('with no section anywhere, are appended under "Acceptance criteria" (the live text kept as is)', async () => {
    liveDescription('Just a {color:red}story{color}.');
    const res = await update(ident('ENG-9'), { acceptanceCriteria: '- one' });
    expect(res.json().criteriaWritten).toBe('description');
    expect(JSON.parse(calls[1]!.body!).fields.description).toBe('Just a {color:red}story{color}.\n\nh2. Acceptance criteria\n* one');
  });

  it('the criteria location is THIS workspace’s: another workspace naming a field for the same ticket does not count', async () => {
    // Workspace 1 (another workspace of the account) still names a custom field for ENG-8.
    ticketRow(1, 1, 30, 'ENG-8', 'customfield_555', { description: DESC_WITH_AC });
    liveDescription('h2. Acceptance criteria\n# old');
    const res = await update(ident('ENG-8'), { acceptanceCriteria: '1. new' });
    expect(res.json()).toMatchObject({ criteriaWritten: 'description' });
    expect(calls.some((c) => c.url.endsWith('/editmeta'))).toBe(false);
    expect(JSON.parse(puts()[0]!.body!).fields).toEqual({ description: 'h2. Acceptance criteria\n# new' });
  });
});

describe('4. refusals are Limn’s sentences', () => {
  it('403 → the token may not change it; 400 → Jira refused', async () => {
    respond = () => ({ status: 403, contentType: 'application/json', body: '{"errorMessages":["secret detail"]}' });
    const a = await update(ident('ENG-7'), { description: 'x' });
    expect(a.statusCode).toBe(502);
    expect(a.json().message).toBe(TICKET_STATUS_NO_PERMISSION);
    respond = (url) =>
      url.endsWith('/editmeta')
        ? { status: 200, contentType: 'application/json', body: JSON.stringify({ fields: { customfield_10042: textarea } }) }
        : { status: 400, contentType: 'application/json', body: '{"errors":{"customfield_10042":"bad"}}' };
    const b = await update(ident('ENG-7'), { acceptanceCriteria: 'x' });
    expect(b.json().message).toBe('Jira refused this change.');
    expect(JSON.stringify(b.json())).not.toMatch(/bad|secret/);
  });
});

describe('5. GET /api/ticket-update/current', () => {
  const current = (id: string, ws = 2) =>
    app.inject({ method: 'GET', url: `/api/ticket-update/current?workspace=${ws}&ident=${encodeURIComponent(id)}` });

  it('answers the stored copy and where the criteria live, without calling Jira', async () => {
    const field = await current(ident('ENG-7'));
    expect(field.statusCode).toBe(200);
    expect(field.json()).toMatchObject({
      workspaceId: 2,
      jira: true,
      description: 'Story',
      acceptanceCriteria: '- GIVEN a report',
      acLocation: { kind: 'field', fieldId: 'customfield_10042', fieldName: 'Acceptance Criteria' },
    });
    const inDesc = await current(ident('ENG-8'));
    expect(inDesc.json()).toMatchObject({
      description: DESC_WITH_AC,
      acceptanceCriteria: '1. old one',
      acLocation: { kind: 'description', heading: 'Acceptance criteria' },
    });
    expect((await current(ident('ENG-9'))).json().acLocation).toEqual({ kind: 'none' });
    // A non-Jira workspace reads it, but cannot write it.
    expect((await current(ident('ENG-7'), 1)).json().jira).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('404s an unknown ticket and another account’s', async () => {
    expect((await current(ident('ENG-1234'))).statusCode).toBe(404);
    expect((await current(ident('ENG-99'))).statusCode).toBe(404);
  });
});
