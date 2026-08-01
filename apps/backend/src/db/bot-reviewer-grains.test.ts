// THE BOT OBJECT AT ITS TWO GRAINS, on a THROWAWAY sqlite DB.
//
// `repo_reviewers` (account, repo, author) holds the JUDGEMENT — is this login acting as an
// automated reviewer HERE, and is it reviewing or quality-checking. `account_reviewers`
// (account, author) holds the IDENTITY — what the bot IS (`kind`), what it is CALLED (`label`),
// who decided that (`identitySource`) and what we PAY for it (`monthlyCents`).
//
// Everything below exists because the previous shape put both on one row and the two facts
// disagreed in production: CodeRabbit detected on three repos, a user clicks "Not a bot" on ONE,
// that row's kind goes null and is the most recently updated, identity resolution reports
// kind=null account-wide, and the vendor loses its brand colour and name on the repos nobody
// touched — with no surface anywhere to undo it. So the assertions come in PAIRS: what an edit
// at one grain does, and that the OTHER grain is untouched.
//
// There is NO team key, NO inheritance, NO merge and NO DEDUPLICATION anywhere. A vendor on three
// repos is THREE rows sharing ONE identity, and that is the intended display.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DB_PATH = '/tmp/pierre-bot-reviewer-grains-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => void) | undefined;
let q: any;

const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();

// Account 1 (seeded by the migrations) owns three repos; account 2 owns one.
let repoWeb = 0;
let repoApi = 0;
let repoInfra = 0;
let repoSolo = 0;

// A NON-vendor login on purpose: a known vendor is automated at every scope via the global
// `reviewBotUserIds` set, which would mask a broken judgement read and make half of this file
// vacuous.
let houseBot = 0;
// A KNOWN vendor login — the identity/colour case the split exists to protect.
let vendorBot = 0;
// An ordinary human commenter (gets rows, judged not automated).
let human = 0;
// Never touched any of account 1's repos — the anti-fabrication control.
let ghost = 0;
let soloBot = 0;
let soloHuman = 0;

let prSeq = 0;
let nodeSeq = 0;

async function makePr(accountId: number, repoId: number, authorId: number): Promise<number> {
  prSeq += 1;
  const [pr] = await db
    .insert(schema.pullRequests)
    .values({
      githubNodeId: `PR_brg_${prSeq}`,
      accountId,
      repoId,
      number: prSeq,
      title: `fixture #${prSeq}`,
      state: 'open',
      mergeable: 'mergeable',
      isDraft: false,
      authorId,
      openedAt: new Date(now - 5 * DAY),
      updatedAt: new Date(now - 1 * DAY),
    })
    .returning()
    .execute();
  return pr.id as number;
}

// One inline thread opened by `actorId` on a fresh PR in `repoId` — the FOOTPRINT signal a row is
// created from. Rows are never fabricated for a pair with no footprint, so every actor that is
// meant to appear must get one of these.
async function seedThread(accountId: number, repoId: number, actorId: number, author: number) {
  const prId = await makePr(accountId, repoId, author);
  nodeSeq += 1;
  await db
    .insert(schema.reviewThreads)
    .values({
      githubNodeId: `RT_brg_${nodeSeq}`,
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
  return prId;
}

async function seedComment(accountId: number, repoId: number, actorId: number, author: number) {
  const prId = await makePr(accountId, repoId, author);
  nodeSeq += 1;
  await db
    .insert(schema.prComments)
    .values({
      githubNodeId: `PC_brg_${nodeSeq}`,
      prId,
      authorId: actorId,
      body: 'ping',
      createdAt: new Date(now - 3 * DAY),
    })
    .execute();
  return prId;
}

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('./run-migrations.js');
  const client = await import('./client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  q = await import('./queries.js');
  await runMigrations();

  const { accounts, repos, users } = schema;
  await db
    .insert(accounts)
    .values({ id: 2, githubUserId: 'U_brg_b', githubLogin: 'solo', isLocal: false })
    .execute();

  const mkRepo = async (accountId: number, name: string) =>
    (
      await db
        .insert(repos)
        .values({
          accountId,
          owner: 'acme',
          name,
          githubNodeId: `R_brg_${name}`,
          inboxWatch: true,
        })
        .returning()
        .execute()
    )[0].id as number;
  repoWeb = await mkRepo(1, 'web');
  repoApi = await mkRepo(1, 'api');
  repoInfra = await mkRepo(1, 'infra');
  repoSolo = await mkRepo(2, 'solo');

  const mkUser = async (login: string, isBot: boolean, githubType?: string) =>
    (
      await db
        .insert(users)
        .values({
          githubLogin: login,
          githubNodeId: `U_brg_${login}`,
          isBot,
          ...(githubType ? { githubType } : {}),
        })
        .returning()
        .execute()
    )[0].id as number;
  // githubType 'Bot' is a HARD signal, so this actor auto-classifies as automated in every repo
  // it has touched — which is what "derive once, write to N rows" needs to be observable.
  houseBot = await mkUser('acme-house-bot', true, 'Bot');
  vendorBot = await mkUser('coderabbitai', true, 'Bot');
  human = await mkUser('dana-h', false);
  ghost = await mkUser('never-here', false);
  soloBot = await mkUser('solo-bot', true, 'Bot');
  soloHuman = await mkUser('solo-h', false);

  // houseBot works on web + api (NOT infra) — so "no fabricated row for infra" is checkable.
  await seedThread(1, repoWeb, houseBot, human);
  await seedThread(1, repoApi, houseBot, human);
  // vendorBot works on all three — the "one vendor, three rows, one identity" case.
  await seedThread(1, repoWeb, vendorBot, human);
  await seedThread(1, repoApi, vendorBot, human);
  await seedThread(1, repoInfra, vendorBot, human);
  // A comment-only human on web: it gets a row (the row IS the object, and an object nobody can
  // see cannot be corrected) but is judged not automated.
  await seedComment(1, repoWeb, human, human);
  // Account 2's own population, so its emptiness below is isolation and not an empty database.
  await seedThread(2, repoSolo, soloBot, soloHuman);
});

afterAll(() => closeDb?.());

const rowsFor = (resp: any, userId: number) =>
  resp.rows.filter((r: any) => r.userId === userId);
const rowIn = (resp: any, userId: number, repoId: number) =>
  resp.rows.find((r: any) => r.userId === userId && r.repoId === repoId);
const identityOf = (resp: any, userId: number) =>
  resp.reviewers.find((r: any) => r.userId === userId);

describe('the fixture is real (nothing below is vacuous)', () => {
  it('lists one row per (repo, actor) with a footprint, and one identity per actor', async () => {
    const resp = await q.listDetectedReviewers(1);
    expect(resp.repoIds.sort()).toEqual([repoWeb, repoApi, repoInfra].sort());
    // THREE rows for one vendor — the intended display, not a duplicate to collapse.
    expect(rowsFor(resp, vendorBot).map((r: any) => r.repoId).sort()).toEqual(
      [repoWeb, repoApi, repoInfra].sort(),
    );
    expect(rowsFor(resp, houseBot).map((r: any) => r.repoId).sort()).toEqual(
      [repoWeb, repoApi].sort(),
    );
    // …and exactly ONE identity entry each.
    expect(resp.reviewers.filter((r: any) => r.userId === vendorBot)).toHaveLength(1);
    expect(identityOf(resp, vendorBot).kind).toBe('coderabbit');
  });

  it('never fabricates a row for a repo the actor has not touched', async () => {
    const resp = await q.listDetectedReviewers(1);
    expect(rowIn(resp, houseBot, repoInfra)).toBeUndefined();
    // …and an actor with no footprint anywhere in the account never appears at all. `users` is a
    // GLOBAL table, so a fabricated row would render a stranger's login/avatar in this account.
    expect(rowsFor(resp, ghost)).toHaveLength(0);
    expect(identityOf(resp, ghost)).toBeUndefined();
  });

  it('gives a comment-only human a row, judged not automated', async () => {
    const resp = await q.listDetectedReviewers(1);
    expect(rowIn(resp, human, repoWeb)?.automated).toBe(false);
  });
});

describe('detection derives ONCE PER ACTOR and writes that verdict to every repo row', () => {
  it('one pass produced the same verdict on all three of the vendor’s rows', async () => {
    const resp = await q.listDetectedReviewers(1);
    const rows = rowsFor(resp, vendorBot);
    expect(rows).toHaveLength(3);
    // Same automated/role/source on every row — one derivation, fanned out. If the classifier ran
    // per repo it would still agree here, but it would also have paid for the tie-break N times
    // and scored the behavioural band on a per-repo slice; the point of the assertion is that N
    // rows exist and AGREE by construction.
    expect(new Set(rows.map((r: any) => r.automated))).toEqual(new Set([true]));
    expect(new Set(rows.map((r: any) => r.role))).toEqual(new Set(['review']));
    expect(new Set(rows.map((r: any) => r.source))).toEqual(new Set(['vendor_login']));
  });

  it('classifyReviewer writes N rows in one call', async () => {
    const { classifyReviewer } = await import('../sync/reviewer-classify.js');
    // Re-run it explicitly over the two repos houseBot touches.
    await classifyReviewer(
      1,
      { id: houseBot, githubLogin: 'acme-house-bot', githubType: 'Bot', isBot: true },
      {},
      [repoWeb, repoApi],
    );
    const stored = await db.select().from(schema.repoReviewers).execute();
    const mine = stored.filter((r: any) => r.authorUserId === houseBot && r.accountId === 1);
    expect(mine.map((r: any) => r.repoId).sort()).toEqual([repoWeb, repoApi].sort());
    expect(new Set(mine.map((r: any) => r.automated))).toEqual(new Set([true]));
  });
});

describe('the judgement is PER REPO and may legitimately differ', () => {
  it('marks the vendor "not a bot" on web only, leaving api and infra automated', async () => {
    const patched = await q.setRepoReviewerJudgement(1, vendorBot, {
      repoId: repoWeb,
      automated: false,
    });
    expect(patched?.source).toBe('manual');
    const resp = await q.listDetectedReviewers(1);
    expect(rowIn(resp, vendorBot, repoWeb)?.automated).toBe(false);
    expect(rowIn(resp, vendorBot, repoApi)?.automated).toBe(true);
    expect(rowIn(resp, vendorBot, repoInfra)?.automated).toBe(true);
    expect(rowIn(resp, vendorBot, repoWeb)?.isManualOverride).toBe(true);
    expect(rowIn(resp, vendorBot, repoApi)?.isManualOverride).toBe(false);
  });

  it('scopes automatedReviewerUserIds by repo, and UNIONS across a multi-repo scope', async () => {
    // In `web` alone the manual "human" wins — it removes even a known vendor login.
    expect(await q.automatedReviewerUserIds(1, [repoWeb], 'all')).not.toContain(vendorBot);
    // In `api` alone it is still a bot.
    expect(await q.automatedReviewerUserIds(1, [repoApi], 'all')).toContain(vendorBot);
    // Over BOTH, the union rule keeps it: a scope containing a repo where it really is a bot must
    // still surface the threads it posted there. (The mirror rule — a manual "human" only removes
    // an actor when NOTHING in scope calls it automated — is what stops one repo's correction
    // blanking a vendor account-wide.)
    expect(await q.automatedReviewerUserIds(1, [repoWeb, repoApi], 'all')).toContain(vendorBot);
    // …and account-wide (`null` = no repo scope) likewise.
    expect(await q.automatedReviewerUserIds(1, null, 'all')).toContain(vendorBot);
  });

  it('treats an EMPTY scope as "no repos", never as "every repo"', async () => {
    expect(await q.automatedReviewerUserIds(1, [], 'all')).toEqual([]);
    const resp = await q.listDetectedReviewers(1, []);
    expect(resp.rows).toEqual([]);
    expect(resp.repoIds).toEqual([]);
  });
});

describe('the IDENTITY is per ACTOR and stays constant across those repos', () => {
  it('reports one kind/label/price for the vendor even with a per-repo "not a bot" in place', async () => {
    // Premise: web IS marked human (set by the block above) — without this the assertion below
    // would pass on an account where nothing ever diverged.
    const before = await q.listDetectedReviewers(1);
    expect(rowIn(before, vendorBot, repoWeb)?.automated).toBe(false);

    // THE BUG THIS PINS: identity resolution used to read whichever repo row was newest, so the
    // "not a bot" click above nulled the kind account-wide and useBotColors (which filters on
    // kind != null) dropped the vendor's brand colour on api and infra.
    expect(identityOf(before, vendorBot).kind).toBe('coderabbit');
    // Scoping the LISTING to a repo where it is marked human must not change the identity either.
    const webOnly = await q.listDetectedReviewers(1, [repoWeb]);
    expect(identityOf(webOnly, vendorBot).kind).toBe('coderabbit');
    const apiOnly = await q.listDetectedReviewers(1, [repoApi]);
    expect(identityOf(apiOnly, vendorBot).kind).toBe('coderabbit');
    expect(identityOf(webOnly, vendorBot).label).toBe(identityOf(apiOnly, vendorBot).label);
  });

  it('classificationKindForUser reads the kind off the ACTOR, not off a repo row', async () => {
    const apiKinds = await q.classificationKindForUser(1, [repoApi]);
    expect(apiKinds.get(vendorBot)).toBe('coderabbit');
    const bothKinds = await q.classificationKindForUser(1, [repoWeb, repoApi]);
    expect(bothKinds.get(vendorBot)).toBe('coderabbit');
  });
});

describe('the two write grains do not reach each other', () => {
  it('the identity route refuses to touch the judgement', async () => {
    const beforeWeb = rowIn(await q.listDetectedReviewers(1), vendorBot, repoWeb);
    expect(beforeWeb.automated).toBe(false); // premise
    expect(beforeWeb.source).toBe('manual'); // premise

    const ident = await q.setReviewerIdentity(1, vendorBot, { label: 'CodeRabbit (ours)' });
    expect(ident?.label).toBe('CodeRabbit (ours)');
    expect(ident?.identitySource).toBe('manual');

    const after = await q.listDetectedReviewers(1);
    // Naming a vendor is not a judgement about how it behaves in any given repo. Stamping the
    // row-level `source` from the identity route would freeze auto-classification on EVERY one of
    // this actor's repos.
    expect(rowIn(after, vendorBot, repoWeb).automated).toBe(false);
    expect(rowIn(after, vendorBot, repoApi).automated).toBe(true);
    expect(rowIn(after, vendorBot, repoApi).source).toBe('vendor_login');
    expect(rowIn(after, vendorBot, repoApi).isManualOverride).toBe(false);
  });

  it('the judgement route refuses to touch the identity', async () => {
    const before = identityOf(await q.listDetectedReviewers(1), vendorBot);
    expect(before.label).toBe('CodeRabbit (ours)'); // premise
    expect(before.kind).toBe('coderabbit'); // premise

    await q.setRepoReviewerJudgement(1, vendorBot, { repoId: repoApi, automated: false });
    const after = identityOf(await q.listDetectedReviewers(1), vendorBot);
    expect(after.kind).toBe('coderabbit');
    expect(after.label).toBe('CodeRabbit (ours)');
    expect(after.identitySource).toBe('manual');

    // Put api back so later blocks read a sane fixture.
    await q.setRepoReviewerJudgement(1, vendorBot, { repoId: repoApi, automated: true });
  });

  it('a role-only patch is still a human judgement (or the next pass would revert it)', async () => {
    await q.setRepoReviewerJudgement(1, houseBot, { repoId: repoWeb, role: 'quality_check' });
    const resp = await q.listDetectedReviewers(1);
    expect(rowIn(resp, houseBot, repoWeb).role).toBe('quality_check');
    // ⚠ It stamps `source: 'manual'` — which also pins `automated` for that repo. Deliberate: not
    // stamping it would let the next classification pass re-derive `role` from the login seed and
    // silently revert the edit, and a silent revert is worse than a visible, undoable pin.
    expect(rowIn(resp, houseBot, repoWeb).source).toBe('manual');
    // …and the role narrows the REVIEWER cohort for that repo only.
    expect(await q.automatedReviewerUserIds(1, [repoWeb], 'review')).not.toContain(houseBot);
    expect(await q.automatedReviewerUserIds(1, [repoWeb], 'all')).toContain(houseBot);
    expect(await q.automatedReviewerUserIds(1, [repoApi], 'review')).toContain(houseBot);
  });
});

describe('re-detection honours BOTH provenance flags, each on its own table', () => {
  it('leaves a manual repo row alone while the actor’s other rows update', async () => {
    const { classifyReviewer } = await import('../sync/reviewer-classify.js');
    // Premise: web is a manual quality_check + automated (set above), api is auto.
    const before = await q.listDetectedReviewers(1);
    expect(rowIn(before, houseBot, repoWeb).source).toBe('manual');
    expect(rowIn(before, houseBot, repoWeb).role).toBe('quality_check');
    expect(rowIn(before, houseBot, repoApi).source).toBe('github_type');

    // Dirty api's row so a re-derivation is OBSERVABLE — otherwise "api updated" is
    // indistinguishable from "nothing happened".
    const { and, eq } = await import('drizzle-orm');
    await db
      .update(schema.repoReviewers)
      .set({ automated: false, role: 'quality_check', source: 'behavioral' })
      .where(
        and(
          eq(schema.repoReviewers.accountId, 1),
          eq(schema.repoReviewers.authorUserId, houseBot),
          eq(schema.repoReviewers.repoId, repoApi),
        ),
      )
      .execute();

    await classifyReviewer(
      1,
      { id: houseBot, githubLogin: 'acme-house-bot', githubType: 'Bot', isBot: true },
      {},
      [repoWeb, repoApi],
    );

    const after = await q.listDetectedReviewers(1);
    // api was re-derived …
    expect(rowIn(after, houseBot, repoApi).automated).toBe(true);
    expect(rowIn(after, houseBot, repoApi).role).toBe('review');
    expect(rowIn(after, houseBot, repoApi).source).toBe('github_type');
    // … and web, the human's row, was NOT.
    expect(rowIn(after, houseBot, repoWeb).source).toBe('manual');
    expect(rowIn(after, houseBot, repoWeb).role).toBe('quality_check');
  });

  it('leaves a manual IDENTITY alone while still re-deriving the judgement', async () => {
    const { classifyReviewer } = await import('../sync/reviewer-classify.js');
    // vendorBot's identity was set by hand above ('CodeRabbit (ours)', identitySource manual).
    expect(identityOf(await q.listDetectedReviewers(1), vendorBot).label).toBe(
      'CodeRabbit (ours)',
    );
    await classifyReviewer(
      1,
      { id: vendorBot, githubLogin: 'coderabbitai', githubType: 'Bot', isBot: true },
      {},
      [repoWeb, repoApi, repoInfra],
    );
    const after = await q.listDetectedReviewers(1);
    // The classifier would have written label 'CodeRabbit' — gating on the row-level `source`
    // instead of `identity_source` is what used to revert a human's vendor correction.
    expect(identityOf(after, vendorBot).label).toBe('CodeRabbit (ours)');
    expect(identityOf(after, vendorBot).identitySource).toBe('manual');
    // …while the non-manual repo rows did re-derive.
    expect(rowIn(after, vendorBot, repoInfra).source).toBe('vendor_login');
  });
});

describe('cost is ACTOR-grain, bounded, and three-state-free', () => {
  it('stores one price for the actor, however many repo rows it has', async () => {
    const ident = await q.setReviewerCost(1, vendorBot, 30);
    expect(ident?.costMonthlyUsd).toBe(30);
    const resp = await q.listDetectedReviewers(1);
    // ONE identity entry carries it; the three repo rows carry no price at all, which is what
    // makes "sum the column" impossible rather than merely discouraged. You buy one subscription
    // from a vendor — three repos running CodeRabbit is $30, not $90.
    expect(identityOf(resp, vendorBot).costMonthlyUsd).toBe(30);
    expect(rowsFor(resp, vendorBot)).toHaveLength(3);
    expect(Object.keys(rowIn(resp, vendorBot, repoWeb))).not.toContain('costMonthlyUsd');
  });

  it('has TWO states: a number (0 is real) and null (unset). Nothing inherits.', async () => {
    expect((await q.setReviewerCost(1, vendorBot, 0))?.costMonthlyUsd).toBe(0);
    expect((await q.setReviewerCost(1, vendorBot, null))?.costMonthlyUsd).toBeNull();
    // Clearing is a COLUMN write, never a row delete — the row also carries the identity.
    expect((await q.setReviewerCost(1, vendorBot, null))?.kind).toBe('coderabbit');
    expect((await q.setReviewerCost(1, vendorBot, null))?.label).toBe('CodeRabbit (ours)');
  });

  it('CLAMPS to the int4 cents ceiling — the one place the two dialects stop agreeing', async () => {
    // Postgres RAISES `integer out of range` (a 500) above 2147483647 cents while SQLite's 64-bit
    // integers accept the value happily, so an unbounded field means the same request succeeds
    // locally and 500s in cloud, leaving a number cloud can never represent.
    expect((await q.setReviewerCost(1, vendorBot, 99_999_999_999))?.costMonthlyUsd).toBe(
      21474836.47,
    );
    expect((await q.setReviewerCost(1, vendorBot, -5))?.costMonthlyUsd).toBe(0);
  });

  it('rounds by the FIXED rule shared with the migrations: floor(usd*100 + 0.5)', async () => {
    // $1.005 lands on 100 under this rule and 101 under exact-decimal rounding; the two backfill
    // paths were measured disagreeing on exactly that value before the rule was pinned.
    expect(q.monthlyUsdToCents(1.005)).toBe(100);
    expect(q.monthlyUsdToCents(0.1) + q.monthlyUsdToCents(0.2)).toBe(30);
    expect(q.monthlyUsdToCents(Number.NaN)).toBe(0);
    await q.setReviewerCost(1, vendorBot, 30); // leave the fixture priced
  });

  it('reviewerCostForUser is keyed by actor and needs no repo scope', async () => {
    const map = await q.reviewerCostForUser(1);
    expect(map.get(vendorBot)).toBe(30);
    expect(map.get(houseBot) ?? null).toBeNull();
  });
});

describe('cross-account: every read and write is account-scoped', () => {
  it('never surfaces another tenant’s rows, even when handed its repo ids', async () => {
    const b = await q.listDetectedReviewers(2);
    expect(b.rows.some((r: any) => r.userId === vendorBot)).toBe(false);
    expect(b.rows.some((r: any) => r.userId === soloBot)).toBe(true); // not vacuous
    // `repoIds` arrives off the wire, so the listing intersects it with the caller's own repos.
    const cross = await q.listDetectedReviewers(2, [repoWeb, repoApi]);
    expect(cross.rows).toEqual([]);
    expect(cross.repoIds).toEqual([]);
  });

  it('rejects a judgement write naming another tenant’s repo', async () => {
    expect(
      await q.setRepoReviewerJudgement(2, vendorBot, { repoId: repoWeb, automated: false }),
    ).toBeNull();
    // …and nothing landed (a null return would also be what a silently-swallowed write looks like).
    const stored = await db.select().from(schema.repoReviewers).execute();
    expect(stored.some((r: any) => r.accountId === 2 && r.repoId === repoWeb)).toBe(false);
    // The owner's own write on the same row still works, so the rejection is about ownership.
    expect(
      await q.setRepoReviewerJudgement(1, vendorBot, { repoId: repoWeb, automated: false }),
    ).not.toBeNull();
  });

  it('rejects identity and cost writes for an actor with no repo row in the account', async () => {
    // The two tables are keyed independently, so the storage would happily take these — and the
    // listing is row-driven, so the result would be an identity/price nothing could ever display,
    // edit or clear. (`author_user_id` also points at the GLOBAL users table, so an ungated write
    // plus a read back is a cross-tenant profile lookup.)
    expect(await q.setReviewerIdentity(2, vendorBot, { kind: 'greptile' })).toBeNull();
    expect(await q.setReviewerCost(2, vendorBot, 99)).toBeNull();
    expect(await q.setReviewerIdentity(1, ghost, { kind: 'greptile' })).toBeNull();
    expect(await q.setReviewerCost(1, ghost, 99)).toBeNull();
    // Positive control.
    expect(await q.setReviewerIdentity(1, vendorBot, { kind: 'coderabbit' })).not.toBeNull();
    const idRows = await db.select().from(schema.accountReviewers).execute();
    // Account 2 legitimately HAS identity rows — for its OWN reviewers, written by its own
    // listing. What must not exist is a row of account 2's naming account 1's actors.
    expect(
      idRows.some((r: any) => r.accountId === 2 && (r.authorUserId === vendorBot || r.authorUserId === ghost)),
    ).toBe(false);
    expect(idRows.some((r: any) => r.accountId === 2 && r.authorUserId === soloBot)).toBe(true);
    expect(idRows.some((r: any) => r.accountId === 1 && r.authorUserId === vendorBot)).toBe(true);
  });
});

// ── THE WAY BACK TO AUTO, ONE RESET PER GRAIN ─────────────────────────────────────────────────
// Everything above pins: a manual write stamps a provenance flag the classifier honours forever,
// and flipping the value back BY HAND does not un-pin it — the row is still manual, just manual on
// a different value. So without these two routes every edit in this file is permanent, and the
// role-only patch's `source: 'manual'` stamp (which pins `automated` for that repo as a side
// effect) is a trap rather than the deliberate trade it is documented as.
//
// The assertions come in the same PAIRS as the writes: what the reset restores, and that the other
// grain did not move.
const repoRowsJson = async () =>
  JSON.stringify(
    (await db.select().from(schema.repoReviewers).execute()).sort(
      (a: any, b: any) => a.id - b.id,
    ),
  );
const identityRowsJson = async () =>
  JSON.stringify(
    (await db.select().from(schema.accountReviewers).execute()).sort(
      (a: any, b: any) => a.id - b.id,
    ),
  );

describe('resetting the JUDGEMENT returns ONE repo row to auto', () => {
  it('deletes the row, and touches neither the identity nor the price', async () => {
    // Premise: houseBot on `web` is pinned by the ROLE-ONLY patch further up — the exact case the
    // trade-off note calls out (a role opinion also pins `automated` for that repo).
    const before = await q.listDetectedReviewers(1);
    expect(rowIn(before, houseBot, repoWeb).source).toBe('manual');
    expect(rowIn(before, houseBot, repoWeb).role).toBe('quality_check');
    // …and the AUTO answer is known and DIFFERENT, from the same actor's untouched sibling row.
    // Without this the re-derivation assertion below could pass on a row that never changed.
    expect(rowIn(before, houseBot, repoApi).source).toBe('github_type');
    expect(rowIn(before, houseBot, repoApi).role).toBe('review');

    const identitiesBefore = await identityRowsJson();
    expect(await q.resetRepoReviewerJudgement(1, houseBot, repoWeb)).toBe(true);

    // It really is a DELETE — the assertion below is about re-derivation, not about a rewrite
    // leaving the human's numbers behind under an auto-looking label.
    const stored = await db.select().from(schema.repoReviewers).execute();
    expect(
      stored.some(
        (r: any) => r.accountId === 1 && r.authorUserId === houseBot && r.repoId === repoWeb,
      ),
    ).toBe(false);
    // …and the actor's OTHER row is untouched: one repo, not the actor.
    expect(
      stored.some(
        (r: any) => r.accountId === 1 && r.authorUserId === houseBot && r.repoId === repoApi,
      ),
    ).toBe(true);
    // Nothing at the ACTOR grain moved — not the vendor, not the label, not the price, not even
    // an updated_at. Different table, and this function issues no statement against it.
    expect(await identityRowsJson()).toBe(identitiesBefore);
  });

  it('and the next classification pass re-derives it with a fresh AUTO verdict', async () => {
    // THE WHOLE POINT. Deleting is only the right form because the row is derived from ACTIVITY:
    // the listing rebuilds the (repo, actor) pair from the actor's reviews/threads/comments and
    // re-classifies any pair with no stored row. If that were not true this would have had to be
    // an in-place "clear source/confidence" instead.
    const after = await q.listDetectedReviewers(1);
    const row = rowIn(after, houseBot, repoWeb);
    expect(row).toBeDefined();
    // Not merely "changed": the values the DETECTOR produces, all three of them back.
    expect(row.source).toBe('github_type');
    expect(row.role).toBe('review'); // the pinned 'quality_check' is gone
    expect(row.automated).toBe(true);
    expect(row.isManualOverride).toBe(false);
    // …and the row is editable-then-resettable again, i.e. the reset is not one-shot.
    await q.setRepoReviewerJudgement(1, houseBot, { repoId: repoWeb, automated: false });
    expect(rowIn(await q.listDetectedReviewers(1), houseBot, repoWeb).automated).toBe(false);
    expect(await q.resetRepoReviewerJudgement(1, houseBot, repoWeb)).toBe(true);
    expect(rowIn(await q.listDetectedReviewers(1), houseBot, repoWeb).automated).toBe(true);
  });

  it('404s (false) on a repo the actor has no row in, and on an unknown actor', async () => {
    // houseBot never touched infra, so there is no judgement there to reset.
    expect(await q.resetRepoReviewerJudgement(1, houseBot, repoInfra)).toBe(false);
    expect(await q.resetRepoReviewerJudgement(1, ghost, repoWeb)).toBe(false);
    expect(await q.resetRepoReviewerJudgement(1, houseBot, 999_999)).toBe(false);
    // Positive control — the falses above are about the gate, not about the function.
    await q.setRepoReviewerJudgement(1, houseBot, { repoId: repoApi, automated: true });
    expect(await q.resetRepoReviewerJudgement(1, houseBot, repoApi)).toBe(true);
  });

  it('is account-scoped: another tenant cannot reset this account’s row', async () => {
    // Premise: a manual row exists for account 1.
    await q.setRepoReviewerJudgement(1, vendorBot, { repoId: repoWeb, automated: false });
    expect(rowIn(await q.listDetectedReviewers(1), vendorBot, repoWeb).source).toBe('manual');

    expect(await q.resetRepoReviewerJudgement(2, vendorBot, repoWeb)).toBe(false);
    // The row scan is the assertion that matters: without the accountId predicate in the DELETE
    // this call would have removed account 1's row and returned true.
    expect(
      (await db.select().from(schema.repoReviewers).execute()).some(
        (r: any) => r.accountId === 1 && r.authorUserId === vendorBot && r.repoId === repoWeb,
      ),
    ).toBe(true);
    expect(rowIn(await q.listDetectedReviewers(1), vendorBot, repoWeb).source).toBe('manual');
  });
});

describe('resetting the IDENTITY returns the actor to auto, everywhere, and keeps the price', () => {
  it('clears the human naming, re-derives it, and leaves EVERY repo row untouched', async () => {
    // Premise: a human named this vendor and priced it.
    await q.setReviewerIdentity(1, vendorBot, { label: 'CodeRabbit (ours)' });
    await q.setReviewerCost(1, vendorBot, 30);
    const before = identityOf(await q.listDetectedReviewers(1), vendorBot);
    expect(before.identitySource).toBe('manual');
    expect(before.label).toBe('CodeRabbit (ours)');
    expect(before.costMonthlyUsd).toBe(30);

    // ⚠ DIRTY A NON-MANUAL REPO ROW FIRST, or the "untouched" assertion below is VACUOUS. A
    // re-derivation would rewrite `infra` with the SAME derived values, and sqlite stores
    // `updated_at` at one-second granularity, so within a test run the row comes back
    // byte-identical. MEASURED: a mutation handing classifyReviewer the actor's REAL repo ids
    // instead of `[]` — i.e. the identity reset reaching straight into the judgement grain —
    // passed this file and the isolation script until this line existed. With the row dirtied,
    // any write to it flips values, not just a timestamp.
    const { and: dAnd, eq: dEq } = await import('drizzle-orm');
    await db
      .update(schema.repoReviewers)
      .set({ automated: false, role: 'quality_check', source: 'behavioral' })
      .where(
        dAnd(
          dEq(schema.repoReviewers.accountId, 1),
          dEq(schema.repoReviewers.authorUserId, vendorBot),
          dEq(schema.repoReviewers.repoId, repoInfra),
        ),
      )
      .execute();

    const rowsBefore = await repoRowsJson();
    const ident = await q.resetReviewerIdentity(1, vendorBot);

    expect(ident?.identitySource).toBe('auto');
    // AUTO CAME BACK, not merely "the human's value is gone": detection's own vendor + label.
    // (A clear-only reset would leave kind null here, the login as the label, and the bot with no
    // brand colour until something unrelated happened to re-sync it.)
    expect(ident?.kind).toBe('coderabbit');
    expect(ident?.label).toBe('CodeRabbit');
    // THE PRICE SURVIVES. It shares the row but is not a classification opinion — losing it as a
    // side effect of un-naming a vendor is the coupling the two-table split exists to remove.
    expect(ident?.costMonthlyUsd).toBe(30);
    // NOT ONE REPO ROW MOVED — no automated/role/source/confidence/reasons, not even an
    // updated_at. Structural: the re-derivation runs with an EMPTY repo list, so persist() issues
    // no statement against repo_reviewers at all.
    expect(await repoRowsJson()).toBe(rowsBefore);
    // Spelled out as well as compared, so a future reader can see WHAT would have moved: the
    // dirtied row still carries the values nobody derived.
    const infra = rowIn(await q.listDetectedReviewers(1), vendorBot, repoInfra);
    expect(infra.automated).toBe(false);
    expect(infra.role).toBe('quality_check');
    expect(infra.source).toBe('behavioral');
  });

  it('stays auto afterwards — the next pass owns the identity again', async () => {
    const { classifyReviewer } = await import('../sync/reviewer-classify.js');
    // Re-run detection over the actor. Before the reset this was a no-op on identity (the manual
    // gate); now it must land, which is what "detection owns it again" means.
    await q.setReviewerIdentity(1, vendorBot, { label: 'temporary' });
    expect(identityOf(await q.listDetectedReviewers(1), vendorBot).label).toBe('temporary');
    await q.resetReviewerIdentity(1, vendorBot);
    await classifyReviewer(
      1,
      { id: vendorBot, githubLogin: 'coderabbitai', githubType: 'Bot', isBot: true },
      {},
      [],
    );
    const after = identityOf(await q.listDetectedReviewers(1), vendorBot);
    expect(after.label).toBe('CodeRabbit');
    expect(after.identitySource).toBe('auto');
    expect(after.costMonthlyUsd).toBe(30); // still not a classification opinion
  });

  it('404s (null) on an actor with no repo row in the account', async () => {
    expect(await q.resetReviewerIdentity(1, ghost)).toBeNull();
    // Positive control.
    expect(await q.resetReviewerIdentity(1, vendorBot)).not.toBeNull();
  });

  it('is account-scoped: another tenant cannot reset this account’s identity', async () => {
    await q.setReviewerIdentity(1, vendorBot, { label: 'CodeRabbit (ours)' });
    const before = await identityRowsJson();
    expect(await q.resetReviewerIdentity(2, vendorBot)).toBeNull();
    // Account 2 owns repos and reviewers, so it passes every account-level check; the only thing
    // between it and account 1's identity row is the repo-row gate. Nothing may have moved.
    expect(await identityRowsJson()).toBe(before);
    expect(identityOf(await q.listDetectedReviewers(1), vendorBot).label).toBe('CodeRabbit (ours)');
    // …and account 2 CAN reset its OWN actor (so the null above is about ownership, not about the
    // function refusing account 2 outright).
    await q.setReviewerIdentity(2, soloBot, { label: 'their bot' });
    expect(identityOf(await q.listDetectedReviewers(2), soloBot).identitySource).toBe('manual');
    expect((await q.resetReviewerIdentity(2, soloBot))?.identitySource).toBe('auto');
  });
});
