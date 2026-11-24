// THE COMMERCIAL LICENCE (docs/LICENSING.md). What is pinned:
//
//   1. THE KEY FORMAT IS A CONTRACT: a key the WEBSITE signs (apps/site licence.ts) is accepted here,
//      offline; a tampered, unknown-signer, malformed or expired key is refused with its reason.
//   2. THE COUNT: distinct people posting through Ensemble in one GitHub owner's repositories in the
//      last 90 days, plus the reader; the reader's own posts and old posts do not count.
//   3. THE REMINDER: above the free limit with no licence, or above the licence's seats; quiet during
//      the one evaluation and after "Remind me later"; never shown at or under the limit.
//
//   pnpm --filter @pierre-review/backend test licence/licence
import { generateKeyPairSync } from 'node:crypto';
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { LICENCE_FREE_USERS } from '@pierre-review/shared';
// The website's signer, imported across apps ON PURPOSE: the two sides must agree to the byte.
import { makePayload, signLicence } from '../../../site/src/licence.js';
import { checkLicenceKey } from './key.js';
import { decideReminder } from './status.js';

const DB_PATH = vi.hoisted(() => {
  const path = `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-licence.sqlite`;
  process.env.DATABASE_URL = path;
  process.env.DISABLE_SCHEDULER = 'true';
  return path;
});

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-11-24T12:00:00Z');
const pair = generateKeyPairSync('ed25519');
const other = generateKeyPairSync('ed25519');
const X = (pair.publicKey.export({ format: 'jwk' }) as { x: string }).x;
const KEYS = { k1: X };

function key(over: Partial<{ org: string; seats: number; expMs: number; kid: string }> = {}, signWith = pair.privateKey): string {
  const payload = makePayload({
    kid: over.kid ?? 'k1',
    org: over.org ?? 'Acme Ltd',
    seats: over.seats ?? 10,
    nowMs: NOW,
    expMs: over.expMs ?? NOW + 365 * DAY,
    src: 'polar',
  });
  return signLicence(payload, signWith);
}

describe('the signed key', () => {
  it('accepts a key the website signed, offline, and reads what it says', () => {
    const c = checkLicenceKey(key(), NOW, KEYS);
    expect(c).toMatchObject({ ok: true, payload: { org: 'Acme Ltd', seats: 10, exp: '2027-11-24', src: 'polar' } });
  });
  it('ignores whitespace and line breaks from a copied email', () => {
    const k = key();
    expect(checkLicenceKey(`  ${k.slice(0, 30)}\n${k.slice(30)}  `, NOW, KEYS).ok).toBe(true);
  });
  it('refuses a key signed by another private key', () => {
    expect(checkLicenceKey(key({}, other.privateKey), NOW, KEYS)).toEqual({ ok: false, problem: 'bad_signature' });
  });
  it('refuses a key whose payload was edited after signing', () => {
    const [p, body, sig] = key().split('.') as [string, string, string];
    const edited = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    edited.seats = 500;
    const forged = `${p}.${Buffer.from(JSON.stringify(edited)).toString('base64url')}.${sig}`;
    expect(checkLicenceKey(forged, NOW, KEYS)).toEqual({ ok: false, problem: 'bad_signature' });
  });
  it('refuses an unknown signer, rubbish, and a key past the end of its expiry day', () => {
    expect(checkLicenceKey(key({ kid: 'k9' }), NOW, KEYS)).toEqual({ ok: false, problem: 'unknown_signer' });
    expect(checkLicenceKey('hello', NOW, KEYS)).toEqual({ ok: false, problem: 'malformed' });
    expect(checkLicenceKey('ENS1.e30.AA', NOW, KEYS)).toEqual({ ok: false, problem: 'malformed' });
    const k = key({ expMs: NOW });
    expect(checkLicenceKey(k, Date.parse('2026-11-24T23:59:00Z'), KEYS).ok).toBe(true);
    expect(checkLicenceKey(k, Date.parse('2026-11-25T00:00:01Z'), KEYS)).toEqual({ ok: false, problem: 'expired' });
  });
  it('the built-in list starts empty, so no key is accepted until a signer is added', () => {
    expect(checkLicenceKey(key(), NOW)).toEqual({ ok: false, problem: 'unknown_signer' });
  });
});

describe('the reminder decision', () => {
  const base = { licence: null, evaluationEndsAtMs: null, snoozedUntilMs: null, nowMs: NOW };
  it('stays quiet at or under the free limit', () => {
    expect(decideReminder({ ...base, users: LICENCE_FREE_USERS }).show).toBe(false);
  });
  it('shows above the free limit with no licence, and offers the one evaluation', () => {
    expect(decideReminder({ ...base, users: LICENCE_FREE_USERS + 1 })).toEqual({
      show: true,
      reason: 'over_free_limit',
      evaluationEndsAt: null,
      canEvaluate: true,
    });
  });
  it('treats an invalid key as no licence', () => {
    const r = decideReminder({ ...base, users: 5, licence: { ok: false, problem: 'expired' } });
    expect(r.reason).toBe('over_free_limit');
  });
  it('is quiet with a licence that covers everyone, and shows when the team outgrows it', () => {
    const lic = { ok: true as const, org: 'Acme', seats: 10, expires: '2027-11-24', source: 'polar' as const };
    expect(decideReminder({ ...base, users: 10, licence: lic }).show).toBe(false);
    expect(decideReminder({ ...base, users: 11, licence: lic })).toMatchObject({ show: true, reason: 'over_licence_seats' });
  });
  it('is quiet during the evaluation and after "later", then shows again', () => {
    const during = decideReminder({ ...base, users: 6, evaluationEndsAtMs: NOW + DAY });
    expect(during).toMatchObject({ show: false, reason: 'over_free_limit', canEvaluate: false });
    expect(decideReminder({ ...base, users: 6, evaluationEndsAtMs: NOW - DAY }).show).toBe(true);
    expect(decideReminder({ ...base, users: 6, snoozedUntilMs: NOW + DAY }).show).toBe(false);
  });
});

describe('the count, against the database', () => {
  let db: any;
  let schema: any;
  let closeDb: (() => Promise<void>) | undefined;
  let status: typeof import('./status.js');
  const users: Record<string, number> = {};
  const repoIds: Record<string, number> = {};
  let seq = 0;

  beforeAll(async () => {
    const { runMigrations } = await import('../db/run-migrations.js');
    const client = await import('../db/client.js');
    db = client.db;
    schema = client.schema;
    closeDb = client.closeDb;
    await runMigrations();
    const { eq } = await import('drizzle-orm');
    await db.insert(schema.accounts).values({ id: 1, githubUserId: 'U_me', githubLogin: 'me', isLocal: true }).onConflictDoNothing().execute();
    await db.update(schema.accounts).set({ githubLogin: 'me' }).where(eq(schema.accounts.id, 1)).execute();
    for (const login of ['me', 'ann', 'bob', 'cat', 'dan', 'limn:ann']) {
      await db.insert(schema.users).values({ githubLogin: login, githubNodeId: login.startsWith('limn:') ? null : `U_${login}` }).onConflictDoNothing().execute();
      const [u] = await db.select().from(schema.users).where(eq(schema.users.githubLogin, login)).execute();
      users[login] = u.id;
    }
    for (const owner of ['acme', 'other']) {
      const [r] = await db.insert(schema.repos).values({ accountId: 1, owner, name: 'api', githubNodeId: `R_${owner}` }).returning().execute();
      repoIds[owner] = r.id;
    }
    status = await import('./status.js');
  });

  afterAll(async () => {
    await closeDb?.();
    for (const x of ['', '-shm', '-wal']) rmSync(DB_PATH + x, { force: true });
  });

  async function posted(owner: string, poster: string, daysAgo: number, kind: 'comment' | 'review' = 'comment'): Promise<void> {
    seq += 1;
    const at = new Date(NOW - daysAgo * DAY);
    const [p] = await db
      .insert(schema.pullRequests)
      .values({ githubNodeId: `PR_${seq}`, accountId: 1, repoId: repoIds[owner], number: seq, title: 't', state: 'open', isDraft: false, authorId: users.dan, openedAt: at, updatedAt: at })
      .returning()
      .execute();
    if (kind === 'comment') {
      await db
        .insert(schema.prComments)
        .values({ githubNodeId: `C_${seq}`, prId: p.id, authorId: users['limn:ann'], body: 'x', createdAt: at, limnPostedByUserId: users[poster] })
        .execute();
    } else {
      await db
        .insert(schema.reviews)
        .values({ githubNodeId: `RV_${seq}`, prId: p.id, authorId: users['limn:ann'], state: 'COMMENTED', submittedAt: at, limnPostedByUserId: users[poster] })
        .execute();
    }
  }

  it('counts distinct posters per owner, plus the reader, within 90 days', async () => {
    await posted('acme', 'ann', 1);
    await posted('acme', 'ann', 2, 'review');
    await posted('acme', 'bob', 10, 'review');
    await posted('acme', 'me', 3); // the reader's own: not a colleague
    await posted('acme', 'cat', 120); // too old
    await posted('other', 'dan', 1);
    expect(await status.countEnsembleUsers(1, 'me', NOW)).toEqual({ count: 3, owner: 'acme' });
  });

  it('turns the reminder on once a fourth person appears, and a stored licence for 10 turns it off', async () => {
    await posted('acme', 'cat', 5);
    const s = await status.getLicenceStatus(1, NOW);
    expect(s.users).toEqual({ count: 4, owner: 'acme' });
    expect(s.reminder).toMatchObject({ show: true, reason: 'over_free_limit', canEvaluate: true });

    await status.startLicenceEvaluation(1, NOW);
    const evaluating = await status.getLicenceStatus(1, NOW);
    expect(evaluating.reminder).toMatchObject({ show: false, canEvaluate: false });
    expect(evaluating.reminder.evaluationEndsAt).toBe(new Date(NOW + 30 * DAY).toISOString());

    // The built-in signer list is empty in the repository, so storing goes through the module's
    // own check: an unknown signer is refused and nothing is stored.
    expect(await status.saveLicenceKey(1, key(), NOW)).toEqual({ ok: false, problem: 'unknown_signer' });
    expect((await status.getLicenceStatus(1, NOW)).licence).toBeNull();
  });
});
