// THE SEAT COUNT behind per-seat bot pricing, on a THROWAWAY sqlite DB.
//
// A SEAT = one distinct HUMAN PR author across the workspace's repos over the TRAILING 30 DAYS.
// `workspaceHumanSeatCount` is read-time input to every per-seat dollar figure (the reviewer
// wire's `effectiveMonthlyUsd`, the analytics' effective `costMonthlyUsd`), so a wrong count is a
// wrong invoice-shaped number on screen.
//
// THE EXCLUSION RULE UNDER TEST, and why it is not a raw `users.isBot` predicate:
//
//   excluded = automatedReviewerUserIds(account, workspace, 'all')   — the WORKSPACE's verdict
//            ∪ { users.isBot / githubType = 'Bot' }                  — the global markers
//            − { the workspace's manual "this is a human" rows }     — which win BOTH directions
//
// `isBot` alone under-excludes (rows synced before a login joined the known set), and the manual
// verdict must beat every global marker: a login GitHub types `Bot` that a human vouched for is a
// SEAT, and a human-looking login the workspace classified automated is NOT.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DB_PATH = '/tmp/pierre-workspace-seat-count-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => void) | undefined;
let q: any;

const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();

let wsSeats = 0; // two repos — the workspace whose count every case below interrogates
let wsOther = 0; // one repo — same account, different workspace: its authors are not seats here
let acct2Default = 0; // account 2's Default — the cross-tenant control

let alice = 0; // human, opens PRs in BOTH of wsSeats' repos (distinctness)
let bob = 0; // human, one PR
let recent = 0; // human, PR opened 29d ago — inside the window
let old = 0; // human, PR opened 31d ago — outside it
let flaggedBot = 0; // githubType 'Bot' / isBot — excluded by the GLOBAL marker, no row needed
let vendorBot = 0; // known vendor login with isBot FALSE — the case a raw isBot predicate misses
let inHouseBot = 0; // human-looking login the WORKSPACE classified automated — excluded
let vouchedHuman = 0; // githubType 'Bot', but a manual "this is a human" row — a SEAT
let dave = 0; // human in wsOther only
let eve = 0; // account 2's human

let seq = 0;

async function mkUser(login: string, githubType?: string): Promise<number> {
  const [row] = await db
    .insert(schema.users)
    .values({
      githubLogin: login,
      githubNodeId: `U_seat_${login}`,
      isBot: githubType === 'Bot',
      ...(githubType ? { githubType } : {}),
    })
    .returning()
    .execute();
  return row.id as number;
}

async function mkRepo(accountId: number, name: string): Promise<number> {
  const [row] = await db
    .insert(schema.repos)
    .values({ accountId, owner: 'acme', name, githubNodeId: `R_seat_${name}` })
    .returning()
    .execute();
  return row.id as number;
}

async function mkWorkspace(name: string, repoIds: number[]): Promise<number> {
  const ws = await q.createWorkspace(1, name);
  await q.assignReposToWorkspace(ws.id, 1, repoIds);
  return ws.id as number;
}

async function mkPr(
  accountId: number,
  repoId: number,
  authorId: number,
  openedAt: Date,
): Promise<number> {
  seq += 1;
  const [pr] = await db
    .insert(schema.pullRequests)
    .values({
      githubNodeId: `PR_seat_${seq}`,
      accountId,
      repoId,
      number: seq,
      title: `seat fixture #${seq}`,
      state: 'open',
      mergeable: 'mergeable',
      isDraft: false,
      authorId,
      openedAt,
      updatedAt: openedAt,
    })
    .returning()
    .execute();
  return pr.id as number;
}

// A review-thread footprint, so `setWorkspaceReviewer` will accept a row for the actor (rows are
// never fabricated for an actor with no footprint). The carrier PR is authored by alice — already
// a seat — so the fixture adds no accidental extra author.
async function seedThread(repoId: number, actorId: number): Promise<void> {
  const prId = await mkPr(1, repoId, alice, new Date(now - 5 * DAY));
  seq += 1;
  await db
    .insert(schema.reviewThreads)
    .values({
      githubNodeId: `RT_seat_${seq}`,
      prId,
      path: 'src/x.ts',
      line: 1,
      isResolved: false,
      isOutdated: false,
      derivedState: 'untouched',
      originalCommenterId: actorId,
      createdAt: new Date(now - 3 * DAY),
    })
    .execute();
}

const IN_WINDOW = new Date(now - 5 * DAY);

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('./run-migrations.js');
  const client = await import('./client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  q = await import('./queries.js');
  await runMigrations();

  alice = await mkUser('seat-alice');
  bob = await mkUser('seat-bob');
  recent = await mkUser('seat-recent');
  old = await mkUser('seat-old');
  flaggedBot = await mkUser('acme-ci', 'Bot');
  // A known VENDOR login stored with isBot FALSE — synced before the flag, exactly the row a raw
  // `users.isBot` filter would count as a person.
  vendorBot = await mkUser('coderabbitai');
  inHouseBot = await mkUser('metrics-runner');
  vouchedHuman = await mkUser('internal-sam', 'Bot');
  dave = await mkUser('seat-dave');
  eve = await mkUser('seat-eve');

  const repoS1 = await mkRepo(1, 'seats-one');
  const repoS2 = await mkRepo(1, 'seats-two');
  const repoO = await mkRepo(1, 'other');
  await q.ensureDefaultWorkspace(1);
  await q.ensureRepoMemberships(1);
  wsSeats = await mkWorkspace('Seats', [repoS1, repoS2]);
  wsOther = await mkWorkspace('Other', [repoO]);

  // ── wsSeats' PR authors, every case at once ──
  await mkPr(1, repoS1, alice, IN_WINDOW);
  await mkPr(1, repoS2, alice, IN_WINDOW); // same human in a second repo — still ONE seat
  await mkPr(1, repoS1, bob, IN_WINDOW);
  await mkPr(1, repoS1, recent, new Date(now - 29 * DAY)); // just inside the window
  await mkPr(1, repoS1, old, new Date(now - 31 * DAY)); // just outside it
  await mkPr(1, repoS1, flaggedBot, IN_WINDOW);
  await mkPr(1, repoS1, vendorBot, IN_WINDOW);
  await mkPr(1, repoS2, inHouseBot, IN_WINDOW);
  await mkPr(1, repoS1, vouchedHuman, IN_WINDOW);
  // Another workspace of the SAME account — its author must not leak into wsSeats' count.
  await mkPr(1, repoO, dave, IN_WINDOW);

  // The two WORKSPACE verdicts (each needs a footprint before the write is accepted):
  // a human-looking login classified automated here …
  await seedThread(repoS1, inHouseBot);
  await q.setWorkspaceReviewer(1, inHouseBot, { workspaceId: wsSeats, automated: true });
  // … and a Bot-typed login a human vouched for (source 'manual' + automated false = manualHuman).
  await seedThread(repoS1, vouchedHuman);
  await q.setWorkspaceReviewer(1, vouchedHuman, { workspaceId: wsSeats, automated: false });

  // ── account 2: same shape, different tenant ──
  await db
    .insert(schema.accounts)
    .values({ id: 2, githubUserId: 'U_seat_b', githubLogin: 'seat-bob-acct', isLocal: false })
    .execute();
  const repoB = await mkRepo(2, 'tenant-two');
  acct2Default = await q.ensureDefaultWorkspace(2);
  await q.ensureRepoMemberships(2);
  await mkPr(2, repoB, eve, IN_WINDOW);
});

afterAll(() => closeDb?.());

describe('workspaceHumanSeatCount — distinct human PR authors, trailing 30 days', () => {
  it('counts each human ONCE across the workspace, with every exclusion applied', async () => {
    // alice (once, though she authored in both repos) + bob + recent + vouchedHuman.
    // NOT: old (window), flaggedBot (global marker), vendorBot (vendor-login seed),
    // inHouseBot (workspace verdict), dave (other workspace), eve (other account).
    expect(await q.workspaceHumanSeatCount(1, wsSeats)).toBe(4);
  });

  it('the global Bot marker excludes without any workspace row', async () => {
    // flaggedBot has no workspace_reviewers row anywhere — the union with users.isBot/githubType
    // is what excludes it. Falsified by dropping the global-marker check: the count reads 5.
    const rows = (await db.select().from(schema.workspaceReviewers).execute()).filter(
      (r: any) => r.authorUserId === flaggedBot,
    );
    expect(rows).toHaveLength(0);
    expect(await q.workspaceHumanSeatCount(1, wsSeats)).toBe(4);
  });

  it('a known vendor login is excluded even while users.isBot is FALSE', async () => {
    // The under-exclusion a raw isBot predicate ships: the row predates the flag.
    const [u] = (await db.select().from(schema.users).execute()).filter(
      (r: any) => r.id === vendorBot,
    );
    expect(u.isBot).toBe(false);
    expect(await q.workspaceHumanSeatCount(1, wsSeats)).toBe(4);
  });

  it('the manual "this is a human" verdict beats the global Bot marker — a real seat', async () => {
    // Flip the vouch away and the seat disappears; restore it and it returns. This is the
    // both-directions half of the rule, exercised as a delta rather than assumed in the total.
    await q.setWorkspaceReviewer(1, vouchedHuman, { workspaceId: wsSeats, automated: true });
    expect(await q.workspaceHumanSeatCount(1, wsSeats)).toBe(3);
    await q.setWorkspaceReviewer(1, vouchedHuman, { workspaceId: wsSeats, automated: false });
    expect(await q.workspaceHumanSeatCount(1, wsSeats)).toBe(4);
  });

  it('the 30-day window is a hard boundary on openedAt', async () => {
    // `recent` (29d) is inside and part of the 4; `old` (31d) is not. A window that widened to
    // backfill depth would read 5 here.
    expect(await q.workspaceHumanSeatCount(1, wsSeats)).toBe(4);
    // Move `old`'s PR inside the window: the seat appears — proving the 4 was the window's doing,
    // not a missing author.
    await db
      .update(schema.pullRequests)
      .set({ openedAt: new Date(now - 20 * DAY) })
      .where(eq(schema.pullRequests.authorId, old))
      .execute();
    expect(await q.workspaceHumanSeatCount(1, wsSeats)).toBe(5);
    await db
      .update(schema.pullRequests)
      .set({ openedAt: new Date(now - 31 * DAY) })
      .where(eq(schema.pullRequests.authorId, old))
      .execute();
    expect(await q.workspaceHumanSeatCount(1, wsSeats)).toBe(4);
  });

  it("another workspace's repos are not counted — seats key on the MEMBERSHIP", async () => {
    expect(await q.workspaceHumanSeatCount(1, wsOther)).toBe(1); // dave alone
  });

  it('another account is isolated in both directions', async () => {
    expect(await q.workspaceHumanSeatCount(2, acct2Default)).toBe(1); // eve alone
    // A foreign workspace id yields 0 through the (repo_id, account_id) join — never another
    // tenant's headcount, and no existence oracle.
    expect(await q.workspaceHumanSeatCount(2, wsSeats)).toBe(0);
    expect(await q.workspaceHumanSeatCount(1, acct2Default)).toBe(0);
  });

  it('an unknown workspace id is simply 0', async () => {
    expect(await q.workspaceHumanSeatCount(1, 999_999)).toBe(0);
  });
});
