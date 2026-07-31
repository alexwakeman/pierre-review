// PER-TEAM bot COST resolution + the cost-only patch, on a THROWAWAY sqlite DB.
//
// `bot_review_classification.cost_monthly_cents` (migration 0043 / pg 0030) is the one column on
// that row that resolves FIELD-WISE while every other column resolves ROW-WISE, and the two rules
// exist for opposite reasons:
//
//   • ROW-wise (classification): a per-team row is one indivisible judgement, so it wins WHOLESALE
//     — and a NEW team row must SEED `role` from the inherited value or creating it REVERSES the
//     classification.
//   • FIELD-wise (cost): a row created merely to hold a label/role opinion carries NO cost
//     opinion, so a wholesale win would ZERO an inherited price the instant someone pressed Apply
//     on an inherited row — and a new team row must NOT seed the cost, or later edits to the
//     team-0 price silently stop reaching that team.
//
// Plus the three one-character traps: `??` not `||` (a stored 0 is a REAL price and must BEAT an
// inherited $120), `!== undefined` not `!= null` (absent = leave alone, null = CLEAR), and a
// cost-only patch that must not stamp `source: 'manual'` (which would freeze the classification
// forever, since classifyReviewer returns a manual row verbatim and never re-derives it).
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DB_PATH = '/tmp/pierre-bot-cost-per-team-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => void) | undefined;
let q: any;

const DAY = 24 * 60 * 60 * 1000;
const NO_TEAM = 0;
const now = Date.now();

let teamA = 0;
let repoId = 0;
let human = 0;
let priced = 0; // $120 at team 0, the inheritance subject
let autoRow = 0; // an AUTO (non-manual) row at team 0 — the "don't stamp manual" subject
let noActed = 0; // priced but with nothing acted on — the divide-by-zero subject

let prSeq = 0;

async function makePr() {
  prSeq += 1;
  const [pr] = await db
    .insert(schema.pullRequests)
    .values({
      githubNodeId: `PR_bcpt_${prSeq}`,
      accountId: 1,
      repoId,
      number: prSeq,
      title: `cost fixture #${prSeq}`,
      state: 'open',
      mergeable: 'mergeable',
      isDraft: false,
      authorId: human,
      openedAt: new Date(now - 5 * DAY),
      updatedAt: new Date(now - 1 * DAY),
    })
    .returning()
    .execute();
  return pr.id as number;
}

// One thread by `botId`. `state` drives the acted-on split the $/acted-on divisor comes from.
let threadSeq = 0;
async function seedThread(botId: number, state: string) {
  const prId = await makePr();
  threadSeq += 1;
  await db
    .insert(schema.reviewThreads)
    .values({
      githubNodeId: `BCPT_T${threadSeq}`,
      prId,
      path: 'src/x.ts',
      line: 1,
      isResolved: state === 'resolved',
      isOutdated: false,
      derivedState: state,
      originalCommenterId: botId,
      createdAt: new Date(now - 3 * DAY),
    })
    .execute();
}

const rowAt = async (userId: number, teamId: number) =>
  (await db.select().from(schema.botReviewClassification).execute()).find(
    (r: any) => r.accountId === 1 && r.teamId === teamId && r.authorUserId === userId,
  );

const listRow = async (teamId: number, userId: number, scoped = false) =>
  (await q.listDetectedReviewers(1, teamId, { scoped })).reviewers.find(
    (r: any) => r.userId === userId,
  );

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('./run-migrations.js');
  const client = await import('./client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  q = await import('./queries.js');
  await runMigrations();

  const { repos, users } = schema;
  repoId = (
    await db
      .insert(repos)
      .values({
        accountId: 1,
        owner: 'acme',
        name: 'api',
        githubNodeId: 'R_bcpt',
        inboxWatch: true,
      })
      .returning()
      .execute()
  )[0].id;

  const mkUser = async (login: string, isBot = true) =>
    (
      await db
        .insert(users)
        .values({ githubLogin: login, githubNodeId: `U_bcpt_${login}`, isBot })
        .returning()
        .execute()
    )[0].id as number;
  human = await mkUser('dana-h', false);
  priced = await mkUser('acme-priced-bot');
  autoRow = await mkUser('acme-auto-bot');
  noActed = await mkUser('acme-quiet-bot');

  teamA = (await q.createTeam(1, 'Team A')).id;
  await q.assignReposToTeam(teamA, 1, [repoId]);

  // `priced` gets 4 threads, 3 of them acted on → $120 / 3 = $40 per acted-on thread.
  await seedThread(priced, 'resolved');
  await seedThread(priced, 'resolved');
  await seedThread(priced, 'likely_addressed');
  await seedThread(priced, 'untouched');
  await seedThread(autoRow, 'untouched');
  await seedThread(noActed, 'untouched');

  // The team-0 default: automated, and $120/month.
  await q.setReviewerOverride(1, priced, {
    automated: true,
    kind: 'in_house',
    label: 'Priced',
    costMonthlyUsd: 120,
  });
  // Automated + priced but nothing of its has ever been acted on → the $/acted-on divisor is 0.
  await q.setReviewerOverride(1, noActed, {
    automated: true,
    kind: 'in_house',
    label: 'Quiet',
    costMonthlyUsd: 9,
  });
  // An AUTO row at team 0, written the way the classifier itself writes one.
  await db
    .insert(schema.botReviewClassification)
    .values({
      accountId: 1,
      teamId: NO_TEAM,
      authorUserId: autoRow,
      automated: true,
      kind: 'in_house',
      label: 'Auto Bot',
      role: 'review',
      confidence: 'medium',
      source: 'behavioral',
      reasonsJson: ['~1 review per PR'],
      updatedAt: new Date(),
    })
    .execute();
});

afterAll(() => closeDb?.());

describe('cost storage — dollars on the wire, integer cents in the column', () => {
  it('stores $120 as 12000 cents and reads it back as 120', async () => {
    expect((await rowAt(priced, NO_TEAM)).costMonthlyCents).toBe(12_000);
    const row = await listRow(NO_TEAM, priced);
    expect(row.costMonthlyUsd).toBe(120);
    // Nothing sits above the inheritance root, so key 0 is never "inherited".
    expect(row.costInherited).toBe(false);
  });
});

describe('cost inherits FIELD-wise while the classification resolves ROW-wise', () => {
  it('a team with no row of its own inherits the team-0 price', async () => {
    const row = await listRow(teamA, priced);
    expect(row.costMonthlyUsd).toBe(120);
    expect(row.costInherited).toBe(true);
    expect(row.inherited).toBe(true); // the whole row is inherited too, at this point
  });

  it('creating a team row for a CLASSIFICATION opinion must NOT zero the inherited price', async () => {
    // This is the Apply-on-an-inherited-row case: the patch carries no cost, so the new team row
    // leaves cost_monthly_cents NULL and keeps inheriting. Seeding it from the inherited value
    // instead would freeze a copy and later edits to the default would stop reaching this team.
    await q.setReviewerOverride(1, priced, {
      automated: true,
      kind: 'in_house',
      label: 'Priced (Team A)',
      teamId: teamA,
    });
    expect((await rowAt(priced, teamA)).costMonthlyCents).toBeNull();

    const row = await listRow(teamA, priced);
    // ⚠ THE DISAGREEMENT IS THE POINT: a real ROW-level override (inherited:false) still using
    // the account default's price (costInherited:true).
    expect(row.inherited).toBe(false);
    expect(row.classification.label).toBe('Priced (Team A)');
    expect(row.costMonthlyUsd).toBe(120);
    expect(row.costInherited).toBe(true);

    // …and the default keeps flowing through: raise it at team 0 and the team follows.
    await q.setReviewerOverride(1, priced, { costMonthlyUsd: 150 });
    expect((await listRow(teamA, priced)).costMonthlyUsd).toBe(150);
    await q.setReviewerOverride(1, priced, { costMonthlyUsd: 120 }); // restore
    expect((await listRow(teamA, priced)).costMonthlyUsd).toBe(120);
  });

  it('an explicit 0 BEATS the inherited price (`??`, never `||`)', async () => {
    await q.setReviewerOverride(1, priced, { costMonthlyUsd: 0, teamId: teamA });
    const row = await listRow(teamA, priced);
    // With `||` this would read 120 and the team would be billed for a bot it does not pay for.
    expect(row.costMonthlyUsd).toBe(0);
    expect(row.costInherited).toBe(false);
    // The account default is untouched — the patch was scoped to teamA.
    expect((await listRow(NO_TEAM, priced)).costMonthlyUsd).toBe(120);
  });

  it('an explicit null CLEARS the override so the key inherits again (`!== undefined`)', async () => {
    await q.setReviewerOverride(1, priced, { costMonthlyUsd: null, teamId: teamA });
    expect((await rowAt(priced, teamA)).costMonthlyCents).toBeNull();
    const row = await listRow(teamA, priced);
    // Read with `!= null` the clear would have been a no-op and this would still be 0.
    expect(row.costMonthlyUsd).toBe(120);
    expect(row.costInherited).toBe(true);
  });

  it('an ABSENT cost leaves the stored value alone (a role edit can never wipe a price)', async () => {
    await q.setReviewerOverride(1, priced, { costMonthlyUsd: 42, teamId: teamA });
    expect((await listRow(teamA, priced)).costMonthlyUsd).toBe(42);
    // "Mark as quality check" sends no cost at all.
    await q.setReviewerOverride(1, priced, { automated: true, role: 'quality_check', teamId: teamA });
    const row = await listRow(teamA, priced);
    expect(row.classification.role).toBe('quality_check');
    expect(row.costMonthlyUsd).toBe(42);
    expect(row.costInherited).toBe(false);
    // Put the row back to a review bot with no price of its own for the tests that follow.
    await q.setReviewerOverride(1, priced, { automated: true, role: 'review', teamId: teamA });
    await q.setReviewerOverride(1, priced, { costMonthlyUsd: null, teamId: teamA });
  });
});

describe('a COST-ONLY patch never stamps a classification', () => {
  it('leaves source/confidence/automated/label/reasons untouched on an existing AUTO row', async () => {
    const before = await rowAt(autoRow, NO_TEAM);
    expect(before.source).toBe('behavioral'); // the guard has something to preserve
    await q.setReviewerOverride(1, autoRow, { costMonthlyUsd: 7 });
    const after = await rowAt(autoRow, NO_TEAM);
    // Stamping 'manual' here would freeze this reviewer's classification FOREVER —
    // classifyReviewer returns a manual row verbatim and never re-derives it, so it would stop
    // self-healing when the login later joins the vendor list or its behaviour changes.
    expect(after.source).toBe('behavioral');
    expect(after.confidence).toBe('medium');
    expect(after.automated).toBe(before.automated);
    expect(after.label).toBe('Auto Bot');
    expect(after.reasonsJson).toEqual(['~1 review per PR']);
    expect(after.costMonthlyCents).toBe(700);
  });

  it('does NOT convert an inherited row into a row-level classification override at team 0', async () => {
    // Same row, viewed from teamA: still inherited (there is no teamA row for autoRow), and the
    // price it now inherits is the one just typed at the default.
    const row = await listRow(teamA, autoRow);
    expect(row.inherited).toBe(true);
    expect(row.classification.source).toBe('behavioral');
    expect(row.costMonthlyUsd).toBe(7);
    expect(row.costInherited).toBe(true);
  });

  it('copies the inherited classification VERBATIM when it has to create a team row', async () => {
    await q.setReviewerOverride(1, autoRow, { costMonthlyUsd: 3, teamId: teamA });
    const teamRow = await rowAt(autoRow, teamA);
    // NOT NULL columns leave no choice but to write them on an INSERT — so they are copied off
    // the inherited row rather than fabricated, and in particular are NOT stamped 'manual'.
    expect(teamRow.source).toBe('behavioral');
    expect(teamRow.confidence).toBe('medium');
    expect(teamRow.automated).toBe(true);
    expect(teamRow.label).toBe('Auto Bot');
    expect(teamRow.role).toBe('review');
    expect(teamRow.costMonthlyCents).toBe(300);
    // The account default is untouched by a team-scoped price.
    expect((await rowAt(autoRow, NO_TEAM)).costMonthlyCents).toBe(700);
  });

  it('bootstraps a non-manual default when the login has no classification anywhere', async () => {
    // The user is created HERE, not in beforeAll: every listDetectedReviewers call above lazily
    // auto-classifies the whole population, so a fixture-time login would already own a row and
    // this test would silently exercise the UPDATE path instead of the bootstrap.
    const fresh = (
      await db
        .insert(schema.users)
        .values({ githubLogin: 'acme-fresh-bot', githubNodeId: 'U_bcpt_fresh', isBot: true })
        .returning()
        .execute()
    )[0].id as number;
    expect(await rowAt(fresh, NO_TEAM)).toBeUndefined(); // not vacuous

    await q.setReviewerOverride(1, fresh, { costMonthlyUsd: 9 });
    const created = await rowAt(fresh, NO_TEAM);
    expect(created).toBeDefined();
    expect(created.costMonthlyCents).toBe(900);
    // Bootstrapped through the real classifier's cheap evidence-free path, so the row stays
    // re-derivable. A fabricated source='manual' row would shadow auto-detection for this login
    // permanently — for the crime of typing a number.
    expect(created.source).not.toBe('manual');
  });
});

describe('getBotAnalytics resolves cost SERVER-side per team', () => {
  it('carries the row’s monthly cost and $/acted-on, and flags an inherited price', async () => {
    const atRoot = await q.getBotAnalytics(1, 'rolling_14', null, NO_TEAM);
    const rootRow = atRoot.vendors.find((v: any) => v.key === `u${priced}`);
    expect(rootRow).toBeDefined();
    expect(rootRow.actedOn).toBe(3); // 2 resolved + 1 likely_addressed
    expect(rootRow.costMonthlyUsd).toBe(120);
    expect(rootRow.costPerActedOnUsd).toBeCloseTo(40, 6);
    expect(rootRow.costInherited).toBe(false);

    // teamA holds a classification override with NO cost of its own → inherits the $120.
    const atTeam = await q.getBotAnalytics(1, 'rolling_14', null, teamA);
    const teamRow = atTeam.vendors.find((v: any) => v.key === `u${priced}`);
    expect(teamRow.costMonthlyUsd).toBe(120);
    expect(teamRow.costInherited).toBe(true);
  });

  it('reports a real 0 as 0, not as "unknown"', async () => {
    await q.setReviewerOverride(1, priced, { costMonthlyUsd: 0, teamId: teamA });
    const teamRow = (await q.getBotAnalytics(1, 'rolling_14', null, teamA)).vendors.find(
      (v: any) => v.key === `u${priced}`,
    );
    // `|| null` (or a truthiness test anywhere in the chain) would turn this into null and the
    // $/acted-on column would silently go blank for a team that pays nothing.
    expect(teamRow.costMonthlyUsd).toBe(0);
    expect(teamRow.costPerActedOnUsd).toBe(0);
    expect(teamRow.costInherited).toBe(false);
    await q.setReviewerOverride(1, priced, { costMonthlyUsd: null, teamId: teamA });
  });

  it('leaves $/acted-on null when the price is unknown, and never divides by zero', async () => {
    const row = (await q.getBotAnalytics(1, 'rolling_14', null, NO_TEAM)).vendors.find(
      (v: any) => v.key === `u${noActed}`,
    );
    expect(row).toBeDefined();
    // One untouched thread → actedOn is 0, so even with a $9 price there is no per-acted-on
    // figure to report (Infinity would be worse than null).
    expect(row.actedOn).toBe(0);
    expect(row.costMonthlyUsd).toBe(9);
    expect(row.costPerActedOnUsd).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// CLEARING A PRICE OFF A ROW THAT EXISTS ONLY TO HOLD IT.
//
// A team row born from a COST-ONLY patch is not a classification opinion: its
// automated/kind/label/role/source are a verbatim COPY of the default's, written because those
// columns are NOT NULL. Leaving that copy behind once its price is cleared is worse than dropping
// it — it keeps winning ROW-level resolution, so later edits to the default stop reaching this
// team, and the Settings tab badges a "team override" nobody made (which then offers a "Reset to
// default" button whose only real effect is deleting a price it never names).
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('clearing the price DROPS a cost-carrier team row', () => {
  it('removes the row entirely and hands the key back to the default', async () => {
    // autoRow's teamA row was created purely by a cost-only patch further up this file.
    const carrier = await rowAt(autoRow, teamA);
    expect(carrier).toBeDefined();
    expect(carrier.source).not.toBe('manual'); // not vacuous — this is the cost-carrier shape
    expect(carrier.costMonthlyCents).toBe(300);

    // The Clear gesture: a cost-only patch with an explicit null.
    const echoed = await q.setReviewerOverride(1, autoRow, { costMonthlyUsd: null, teamId: teamA });
    // Not a 404 (the route turns a null return into one) — the caller gets what now applies here.
    expect(echoed).not.toBeNull();
    expect(await rowAt(autoRow, teamA)).toBeUndefined();

    const row = await listRow(teamA, autoRow);
    // Truly inheriting again: BOTH axes, not just the cost. With the row left behind, `inherited`
    // stayed false and the classification was a frozen copy that later default edits never reach.
    expect(row.inherited).toBe(true);
    expect(row.costInherited).toBe(true);
    expect(row.costMonthlyUsd).toBe(7); // the default typed at key 0 earlier in this file
  });

  it('and the default keeps flowing through afterwards', async () => {
    await q.setReviewerOverride(1, autoRow, { automated: true, label: 'Renamed At Root' });
    // A frozen copy at teamA would have shadowed this forever.
    expect((await listRow(teamA, autoRow)).classification.label).toBe('Renamed At Root');
  });

  it('but a MANUAL row keeps its classification — only its price is cleared', async () => {
    // The mirror case. `priced` holds a real per-team classification override, so clearing the
    // cost must leave the judgement standing; deleting the row here would silently undo an
    // opinion the user typed on a different control.
    await q.setReviewerOverride(1, priced, { costMonthlyUsd: 55, teamId: teamA });
    expect((await rowAt(priced, teamA)).source).toBe('manual'); // not vacuous
    await q.setReviewerOverride(1, priced, { costMonthlyUsd: null, teamId: teamA });
    const stillThere = await rowAt(priced, teamA);
    expect(stillThere).toBeDefined();
    expect(stillThere.costMonthlyCents).toBeNull();
    expect((await listRow(teamA, priced)).inherited).toBe(false);
  });

  it('never drops the ROOT row — it is also the auto-classification cache', async () => {
    // At key 0 a null price is an ordinary "no cost set". Deleting the row would throw the
    // reviewer's whole stored classification away for the crime of emptying a box.
    await q.setReviewerOverride(1, autoRow, { costMonthlyUsd: null });
    const root = await rowAt(autoRow, NO_TEAM);
    expect(root).toBeDefined();
    expect(root.costMonthlyCents).toBeNull();
    // The classification the tests above wrote at this key is untouched.
    expect(root.label).toBe('Renamed At Root');
  });
});
