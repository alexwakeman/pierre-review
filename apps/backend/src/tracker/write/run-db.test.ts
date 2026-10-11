import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { jiraApiRoot, trackerTicketIdent, type TrackerProvider } from '@pierre-review/shared';

// The sprint WRITE-BACK's run (./run.ts) on a SCRATCH SQLite — never apps/backend/data. Fake writers
// stand in for the trackers. Pins: the claim comes BEFORE the write (a repeated requestId never
// writes twice), a failure is never retried, 403 → the named "can't write" refusal, a cut-off write
// is `maybe_written`, the replace target is the server's, another account's ticket is invisible, and
// a successful write marks the ticket for an immediate re-read.

const DB_PATH = '/private/tmp/claude-501/pierre-tracker-write-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void> | void) | undefined;
let run: typeof import('./run.js');
let providers: typeof import('./providers.js');
let ctx: import('../context.js').TrackerContext;
let wsA = 0;
let wsB = 0;

const BASE = 'https://acme.atlassian.net';
const ROOT = jiraApiRoot(BASE)!;
const KEY = 'ENG-1';
const IDENT = trackerTicketIdent('jira', ROOT, KEY);
const AC_TARGET = { kind: 'ac_field' as const, fieldId: 'customfield_1', fieldName: 'Acceptance criteria' };

type Call = { verb: 'comment' | 'replace'; key: string; text: string; target?: unknown };
function fakeWriters(behave: () => Promise<{ url: string | null }>): { writers: Record<TrackerProvider, import('./providers.js').TrackerWriter>; calls: Call[] } {
  const calls: Call[] = [];
  const w: import('./providers.js').TrackerWriter = {
    comment: async (_c, key, text) => {
      calls.push({ verb: 'comment', key, text });
      return behave();
    },
    replace: async (_c, key, target, text) => {
      calls.push({ verb: 'replace', key, text, target });
      return behave();
    },
  };
  return { writers: { jira: w, linear: w, github: w }, calls };
}

const sha = (x: string): string => createHash('sha256').update(x, 'utf8').digest('hex');
const AC_TEXT = '- Export works';
/** A live ticket as the tracker would return it now: the AC field holds `ac`. */
const liveTicket = (ac: string) => async () => ({
  key: KEY,
  title: 'Export CSV',
  description: '',
  issueType: null,
  status: null,
  assignee: null,
  candidates: [{ id: AC_TARGET.fieldId, name: AC_TARGET.fieldName, text: ac, match: 'strong' as const }],
  omittedCandidates: 0,
});

let seq = 0;
const rid = (): string => `req_${Date.now().toString(36)}_${(seq++).toString(36)}`;

async function addTicket(accountId: number, workspaceId: number, opts: { inSprint?: boolean; acField?: boolean } = {}): Promise<void> {
  const now = new Date();
  await db
    .insert(schema.sprintTickets)
    .values({
      accountId,
      workspaceId,
      ident: IDENT,
      provider: 'jira',
      apiRoot: ROOT,
      issueKey: KEY,
      url: `${BASE}/browse/${KEY}`,
      title: 'Export CSV',
      acFieldId: opts.acField === false ? null : AC_TARGET.fieldId,
      acFieldName: opts.acField === false ? null : AC_TARGET.fieldName,
      acceptanceCriteria: opts.acField === false ? '' : AC_TEXT,
      inSprint: opts.inSprint ?? true,
      firstSeenAt: now,
      lastSeenAt: now,
      fetchedAt: now,
      nextCheckAt: new Date(now.getTime() + 3_600_000),
    })
    .execute();
}

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../../db/run-migrations.js');
  const client = await import('../../db/client.js');
  closeDb = client.closeDb;
  await runMigrations();
  db = client.db;
  schema = client.schema;
  const q = await import('../../db/queries.js');
  const have = new Set((await db.select().from(schema.accounts).execute()).map((a: any) => a.id));
  if (!have.has(1)) await db.insert(schema.accounts).values({ id: 1, githubUserId: 'U_tw_a', githubLogin: 'tw-a', isLocal: true }).execute();
  if (!have.has(2)) await db.insert(schema.accounts).values({ id: 2, githubUserId: 'U_tw_b', githubLogin: 'tw-b', isLocal: false }).execute();
  wsA = await q.ensureDefaultWorkspace(1);
  wsB = await q.ensureDefaultWorkspace(2);
  for (const [accountId, workspaceId] of [
    [1, wsA],
    [2, wsB],
  ] as const) {
    await db
      .insert(schema.workspaceTrackers)
      .values({ accountId, workspaceId, provider: 'jira', baseUrl: BASE, authEmail: 'me@acme.test', authToken: 'plain:tok' })
      .execute();
  }
  // Only account 2 has the ticket.
  await addTicket(2, wsB);
  // A PR-linked stored ticket for the same ident in account 2, to see it marked due.
  await db
    .insert(schema.trackerTickets)
    .values({
      accountId: 2,
      workspaceId: wsB,
      prId: 999,
      provider: 'jira',
      issueKey: KEY,
      detectedFrom: 'title',
      detectOrder: 0,
      apiRoot: ROOT,
      url: `${BASE}/browse/${KEY}`,
      state: 'ok',
      checkedAt: new Date(),
      nextCheckAt: new Date(Date.now() + 3_600_000),
    })
    .execute();
  const { buildTrackerContext } = await import('../runtime.js');
  ctx = { ...buildTrackerContext({ warn: () => {}, info: () => {}, error: () => {} }) };
  run = await import('./run.js');
  providers = await import('./providers.js');
});

afterAll(async () => {
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

beforeEach(() => run.__resetTrackerWriteLocks());

const base = (over: Partial<Parameters<typeof import('./run.js').performTrackerWrite>[1]> = {}) => ({
  accountId: 2,
  workspaceId: wsB,
  ident: IDENT,
  mode: 'comment' as const,
  text: '- Given a filter, export only the filtered rows',
  requestId: rid(),
  ...over,
});

describe('performTrackerWrite', () => {
  it('writes once, records the exact text, and a repeated requestId never writes again', async () => {
    const { writers, calls } = fakeWriters(async () => ({ url: 'https://acme.atlassian.net/browse/ENG-1?focusedCommentId=1' }));
    const a = base({ writers });
    const first = await run.performTrackerWrite(ctx, a);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.record).toMatchObject({ status: 'written', error: null, message: null, mode: 'comment', ident: IDENT });
    expect(calls).toEqual([{ verb: 'comment', key: KEY, text: a.text }]);
    const again = await run.performTrackerWrite(ctx, a);
    expect(again.ok && again.record.id).toBe(first.record.id);
    expect(calls).toHaveLength(1);
    const [row] = await db.select().from(schema.trackerWrites).where((await import('drizzle-orm')).eq(schema.trackerWrites.id, first.record.id)).execute();
    expect(row.text).toBe(a.text);
    expect(row.textHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('marks the sprint ticket and its PR-linked rows due at once after a write', async () => {
    const { eq } = await import('drizzle-orm');
    const [st] = await db.select().from(schema.sprintTickets).where(eq(schema.sprintTickets.accountId, 2)).execute();
    expect(st.nextCheckAt.getTime()).toBe(0);
    const [tt] = await db.select().from(schema.trackerTickets).where(eq(schema.trackerTickets.accountId, 2)).execute();
    expect(tt.nextCheckAt.getTime()).toBe(0);
  });

  it('the claim is taken BEFORE the write: the writer sees a `writing` row', async () => {
    const { eq } = await import('drizzle-orm');
    const requestId = rid();
    let seen: string | null = null;
    const { writers } = fakeWriters(async () => {
      const [r] = await db.select().from(schema.trackerWrites).where(eq(schema.trackerWrites.requestId, requestId)).execute();
      seen = r?.status ?? null;
      return { url: null };
    });
    await run.performTrackerWrite(ctx, base({ writers, requestId }));
    expect(seen).toBe('writing');
  });

  it('a failure is recorded once and never retried, even when the same request comes back', async () => {
    const { writers, calls } = fakeWriters(async () => {
      throw new providers.WriteFailure('rejected');
    });
    const a = base({ writers });
    const out = await run.performTrackerWrite(ctx, a);
    expect(out.ok && out.record).toMatchObject({ status: 'failed', error: 'rejected', message: 'Jira refused the update.' });
    await run.performTrackerWrite(ctx, a);
    expect(calls).toHaveLength(1);
  });

  it('a token that cannot write → the named refusal on the record', async () => {
    const { JiraFetchError } = await import('../jira/fetch.js');
    const { writers } = fakeWriters(async () => {
      throw new JiraFetchError('forbidden', 403);
    });
    const out = await run.performTrackerWrite(ctx, base({ writers }));
    expect(out.ok && out.record).toMatchObject({ status: 'failed', error: 'no_write_permission', message: 'This token can’t write to Jira.' });
  });

  it('a write cut off after it was sent is `maybe_written`', async () => {
    const { JiraFetchError } = await import('../jira/fetch.js');
    const { writers } = fakeWriters(async () => {
      throw new JiraFetchError('timeout');
    });
    const out = await run.performTrackerWrite(ctx, base({ writers }));
    expect(out.ok && out.record).toMatchObject({ status: 'maybe_written', error: 'timeout' });
    expect(out.ok && out.record.message).toMatch(/may have been written/);
  });

  it('replace: the target must be the description or the ticket’s own criteria field; a match writes into the stored field', async () => {
    const { writers, calls } = fakeWriters(async () => ({ url: null }));
    const wrong = await run.performTrackerWrite(
      ctx,
      base({ writers, mode: 'replace', target: { ...AC_TARGET, fieldId: 'customfield_9' }, baseHash: sha(AC_TEXT), fetchTicket: liveTicket(AC_TEXT) }),
    );
    expect(wrong).toMatchObject({ ok: false, status: 409, body: { error: 'target_changed' } });
    const missing = await run.performTrackerWrite(ctx, base({ writers, mode: 'replace' }));
    expect(missing).toMatchObject({ ok: false, status: 409, body: { error: 'target_changed' } });
    expect(calls).toHaveLength(0);
    const ok = await run.performTrackerWrite(
      ctx,
      base({ writers, mode: 'replace', target: AC_TARGET, baseHash: sha(AC_TEXT), fetchTicket: liveTicket(AC_TEXT) }),
    );
    expect(ok.ok && ok.record).toMatchObject({ status: 'written', target: AC_TARGET });
    expect(calls[0]).toMatchObject({ verb: 'replace', target: AC_TARGET });
  });

  it('replace: the DESCRIPTION is writable beside a criteria field, with its own base hash', async () => {
    const { writers, calls } = fakeWriters(async () => ({ url: null }));
    // The criteria field's hash does not stand for the description.
    const crossed = await run.performTrackerWrite(
      ctx,
      base({ writers, mode: 'replace', target: { kind: 'description' }, baseHash: sha(AC_TEXT), fetchTicket: liveTicket(AC_TEXT) }),
    );
    expect(crossed).toMatchObject({ ok: false, status: 409, body: { error: 'ticket_changed' } });
    expect(calls).toHaveLength(0);
    const ok = await run.performTrackerWrite(
      ctx,
      base({ writers, mode: 'replace', target: { kind: 'description' }, text: 'New description', baseHash: sha(''), fetchTicket: liveTicket(AC_TEXT) }),
    );
    expect(ok.ok && ok.record).toMatchObject({ status: 'written', target: { kind: 'description' } });
    expect(calls[0]).toMatchObject({ verb: 'replace', target: { kind: 'description' }, text: 'New description' });
  });

  it('replace: a criteria-field target on a ticket with no criteria field is refused', async () => {
    const { and, eq } = await import('drizzle-orm');
    const t = schema.sprintTickets;
    const where = and(eq(t.accountId, 2), eq(t.ident, IDENT));
    await db.update(t).set({ acFieldId: null, acFieldName: null }).where(where).execute();
    const { writers, calls } = fakeWriters(async () => ({ url: null }));
    const out = await run.performTrackerWrite(
      ctx,
      base({ writers, mode: 'replace', target: AC_TARGET, baseHash: sha(AC_TEXT), fetchTicket: liveTicket(AC_TEXT) }),
    );
    expect(out).toMatchObject({ ok: false, status: 409, body: { error: 'target_changed' } });
    expect(calls).toHaveLength(0);
    await db.update(t).set({ acFieldId: AC_TARGET.fieldId, acFieldName: AC_TARGET.fieldName }).where(where).execute();
  });

  it('replace: a ticket edited in the tracker since the dialog opened refuses, writes nothing, stores the new text', async () => {
    const { and, eq } = await import('drizzle-orm');
    const { writers, calls } = fakeWriters(async () => ({ url: null }));
    const stale = await run.performTrackerWrite(ctx, base({ writers, mode: 'replace', target: AC_TARGET, baseHash: sha('older text'), fetchTicket: liveTicket(AC_TEXT) }));
    expect(stale).toMatchObject({ ok: false, status: 409, body: { error: 'ticket_changed' } });
    const edited = await run.performTrackerWrite(
      ctx,
      base({ writers, mode: 'replace', target: AC_TARGET, baseHash: sha(AC_TEXT), fetchTicket: liveTicket('- Someone edited this') }),
    );
    expect(edited).toMatchObject({ ok: false, status: 409, body: { error: 'ticket_changed' } });
    const failing = await run.performTrackerWrite(
      ctx,
      base({
        writers,
        mode: 'replace',
        target: AC_TARGET,
        baseHash: sha('- Someone edited this'),
        fetchTicket: async () => {
          throw new Error('boom');
        },
      }),
    );
    expect(failing).toMatchObject({ ok: false, status: 502, body: { error: 'read_failed' } });
    expect(calls).toHaveLength(0);
    const t = schema.sprintTickets;
    const [row] = await db.select().from(t).where(and(eq(t.accountId, 2), eq(t.ident, IDENT))).execute();
    expect(row.acceptanceCriteria).toBe('- Someone edited this');
    await db.update(t).set({ acceptanceCriteria: AC_TEXT }).where(and(eq(t.accountId, 2), eq(t.ident, IDENT))).execute();
  });

  it('replace: a text longer than the page carries is refused (too_long), never cut by a write', async () => {
    const { and, eq } = await import('drizzle-orm');
    const t = schema.sprintTickets;
    const long = 'x'.repeat(20_001);
    await db.update(t).set({ acceptanceCriteria: long }).where(and(eq(t.accountId, 2), eq(t.ident, IDENT))).execute();
    const { writers, calls } = fakeWriters(async () => ({ url: null }));
    const out = await run.performTrackerWrite(ctx, base({ writers, mode: 'replace', target: AC_TARGET, baseHash: sha(long), fetchTicket: liveTicket(long) }));
    expect(out).toMatchObject({ ok: false, status: 409, body: { error: 'too_long' } });
    expect(calls).toHaveLength(0);
    await db.update(t).set({ acceptanceCriteria: AC_TEXT }).where(and(eq(t.accountId, 2), eq(t.ident, IDENT))).execute();
  });

  it('an assessment id that is not this ticket’s, in this account, is stored as null', async () => {
    const { eq } = await import('drizzle-orm');
    const [foreign] = await db
      .insert(schema.sprintAssessments)
      .values({ accountId: 1, workspaceId: wsA, ident: IDENT, model: 'm', status: 'succeeded', fingerprint: 'f', textHash: 'h', reposJson: [] })
      .returning({ id: schema.sprintAssessments.id })
      .execute();
    const [own] = await db
      .insert(schema.sprintAssessments)
      .values({ accountId: 2, workspaceId: wsB, ident: IDENT, model: 'm', status: 'succeeded', fingerprint: 'f', textHash: 'h', reposJson: [] })
      .returning({ id: schema.sprintAssessments.id })
      .execute();
    const { writers } = fakeWriters(async () => ({ url: null }));
    const a = await run.performTrackerWrite(ctx, base({ writers, assessmentId: foreign.id }));
    const b = await run.performTrackerWrite(ctx, base({ writers, assessmentId: own.id }));
    const rowA = (await db.select().from(schema.trackerWrites).where(eq(schema.trackerWrites.id, a.ok ? a.record.id : -1)).execute())[0];
    const rowB = (await db.select().from(schema.trackerWrites).where(eq(schema.trackerWrites.id, b.ok ? b.record.id : -1)).execute())[0];
    expect(rowA.assessmentId).toBeNull();
    expect(rowB.assessmentId).toBe(own.id);
  });

  it('deleting a workspace moves its write history to Default (a maybe_written warning survives)', async () => {
    const { and, eq } = await import('drizzle-orm');
    const q = await import('../../db/queries.js');
    const [ws] = await db
      .insert(schema.workspaces)
      .values({ accountId: 2, name: 'Doomed', isDefault: false })
      .returning({ id: schema.workspaces.id })
      .execute();
    const requestId = rid();
    await db
      .insert(schema.trackerWrites)
      .values({ accountId: 2, workspaceId: ws.id, ident: IDENT, provider: 'jira', requestId, mode: 'comment', text: 'x', textHash: 'h', status: 'maybe_written' })
      .execute();
    expect(await q.deleteWorkspace(ws.id, 2)).toBe('deleted');
    const rows = await db
      .select()
      .from(schema.trackerWrites)
      .where(and(eq(schema.trackerWrites.accountId, 2), eq(schema.trackerWrites.requestId, requestId)))
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0].workspaceId).toBe(wsB);
    expect(rows[0].status).toBe('maybe_written');
  });

  it('another account cannot write to this account’s ticket (no_ticket; nothing claimed)', async () => {
    const { eq } = await import('drizzle-orm');
    const { writers, calls } = fakeWriters(async () => ({ url: null }));
    const requestId = rid();
    const out = await run.performTrackerWrite(ctx, base({ writers, accountId: 1, workspaceId: wsA, requestId }));
    expect(out).toMatchObject({ ok: false, status: 404, body: { error: 'no_ticket' } });
    expect(calls).toHaveLength(0);
    expect(await db.select().from(schema.trackerWrites).where(eq(schema.trackerWrites.requestId, requestId)).execute()).toHaveLength(0);
  });

  it('a ticket that left the sprint list is refused', async () => {
    const { and, eq } = await import('drizzle-orm');
    const t = schema.sprintTickets;
    await db.update(t).set({ inSprint: false }).where(and(eq(t.accountId, 2), eq(t.ident, IDENT))).execute();
    const { writers, calls } = fakeWriters(async () => ({ url: null }));
    const out = await run.performTrackerWrite(ctx, base({ writers }));
    expect(out).toMatchObject({ ok: false, body: { error: 'no_ticket' } });
    expect(calls).toHaveLength(0);
    await db.update(t).set({ inSprint: true }).where(and(eq(t.accountId, 2), eq(t.ident, IDENT))).execute();
  });

  it('a second write on the same ticket while one is in flight is busy', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const { writers, calls } = fakeWriters(async () => {
      await gate;
      return { url: null };
    });
    const first = run.performTrackerWrite(ctx, base({ writers }));
    // Let the first reach the writer.
    for (let i = 0; i < 50 && calls.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    const second = await run.performTrackerWrite(ctx, base({ writers }));
    expect(second).toMatchObject({ ok: false, status: 409, body: { error: 'busy' } });
    release();
    expect((await first).ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('the startup sweep turns an interrupted `writing` row into `maybe_written`', async () => {
    const { eq } = await import('drizzle-orm');
    const requestId = rid();
    await db
      .insert(schema.trackerWrites)
      .values({ accountId: 2, workspaceId: wsB, ident: IDENT, provider: 'jira', requestId, mode: 'comment', text: 'x', textHash: 'h', status: 'writing' })
      .execute();
    expect(await run.reconcileTrackerWritesOnStartup()).toBe(1);
    const [r] = await db.select().from(schema.trackerWrites).where(eq(schema.trackerWrites.requestId, requestId)).execute();
    expect(r).toMatchObject({ status: 'maybe_written', errorCode: 'interrupted' });
  });
});
