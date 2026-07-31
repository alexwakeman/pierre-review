// listDetectedReviewers OPT-IN TEAM SCOPING, on a THROWAWAY sqlite DB.
//
// The Bots→Settings tab wants only the reviewers relevant to the team it is showing. The
// narrowing is an OPT-IN FLAG (`opts.scoped` ← `?scoped=true`) and NOT a redefinition of team
// key 0, because four production callers already read this route at key 0 to mean "the whole
// account roster" — the bot colour map, the feed's per-row vendor tag, ThreadList's bulk
// "Resolve N addressed" count, and the cost picker's options. Every assertion below therefore
// comes in pairs: what the scoped listing does, and that the UNSCOPED one is unchanged.
//
// The rules under test:
//   • footprint = a review, an inline thread, or an issue comment EVER (not windowed) in the
//     scoped repos;
//   • team key 0 scoped = the repos in NO team at all (the literal reading, chosen deliberately),
//     so an account with no teams still sees everything there;
//   • a repo may sit in SEVERAL teams and must show up on each;
//   • `scopedRepoCount` is null when unscoped — never the account's repo count, which would
//     disguise the one case the field exists to catch ("this team has no repos yet" = the only 0);
//   • a MANUAL classification stored at the requested key survives as `dormantInScope` even with
//     no footprint, because it still governs every metric computed at that key — and so does a
//     stored PRICE, whose row is deliberately NOT manual (a cost-only patch never stamps one);
//   • key 0 is the inheritance ROOT, so a 0-repo root scope degrades to the unscoped roster
//     rather than leaving the row every team reads uneditable.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DB_PATH = '/tmp/pierre-detected-reviewers-scope-test.sqlite';
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
let teamB = 0;
let teamEmpty = 0;
let repoTeamed = 0;
let repoUnteamed = 0;
let repoBoth = 0;
// account 1's reviewers, one per footprint location.
let botTeamed = 0; // only in teamA's own repo
let botUnteamed = 0; // only in the repo that is in NO team
let botBoth = 0; // in the two-team repo AND the unteamed one (so counts must narrow)
let botDormant = 0; // a manual row at teamA; its only footprint is OUTSIDE teamA's repos
let botGhost = 0; // a manual row at teamA and NO footprint anywhere — must stay invisible
let botTeamedManual = 0; // teamed-repo footprint + a MANUAL row at key 0 (dormant on No-Team)
// account 2 owns one repo and has NO teams at all.
let soloBot = 0;

let prSeq = 0;
let nodeSeq = 0;

async function makePr(accountId: number, repoId: number, authorId: number) {
  prSeq += 1;
  const [pr] = await db
    .insert(schema.pullRequests)
    .values({
      githubNodeId: `PR_drs_${prSeq}`,
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

// One inline thread opened by `botId` on a fresh PR in `repoId` — the footprint signal the
// listing keys on, and the row `threadsLast90d` counts.
async function seedThread(accountId: number, repoId: number, botId: number, human: number) {
  const prId = await makePr(accountId, repoId, human);
  nodeSeq += 1;
  await db
    .insert(schema.reviewThreads)
    .values({
      githubNodeId: `DRS_T${nodeSeq}`,
      prId,
      path: 'src/x.ts',
      line: 1,
      isResolved: false,
      isOutdated: false,
      derivedState: 'untouched',
      originalCommenterId: botId,
      createdAt: new Date(now - 3 * DAY),
    })
    .execute();
  return prId;
}

// A submitted review WITH a body — the row's `sampleReviewBody` evidence.
async function seedReviewBody(prId: number, botId: number, body: string) {
  nodeSeq += 1;
  await db
    .insert(schema.reviews)
    .values({
      githubNodeId: `DRS_RV${nodeSeq}`,
      prId,
      authorId: botId,
      state: 'commented',
      body,
      submittedAt: new Date(now - 2 * DAY),
    })
    .execute();
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
    .values({ id: 2, githubUserId: 'U_drs_b', githubLogin: 'solo', isLocal: false })
    .execute();

  const mkRepo = async (accountId: number, name: string) =>
    (
      await db
        .insert(repos)
        .values({
          accountId,
          owner: 'acme',
          name,
          githubNodeId: `R_drs_${name}`,
          inboxWatch: true,
        })
        .returning()
        .execute()
    )[0].id as number;
  repoTeamed = await mkRepo(1, 'teamed');
  repoUnteamed = await mkRepo(1, 'unteamed');
  repoBoth = await mkRepo(1, 'both');
  const repoSolo = await mkRepo(2, 'solo');

  const mkUser = async (login: string, isBot = true) =>
    (
      await db
        .insert(users)
        .values({ githubLogin: login, githubNodeId: `U_drs_${login}`, isBot })
        .returning()
        .execute()
    )[0].id as number;
  // Deliberately NOT known vendor logins: a vendor would be automated at every key via
  // reviewBotUserIds, which would mask a broken classification read.
  const human = await mkUser('dana-h', false);
  const soloHuman = await mkUser('solo-h', false);
  botTeamed = await mkUser('acme-teamed-bot');
  botUnteamed = await mkUser('acme-unteamed-bot');
  botBoth = await mkUser('acme-both-bot');
  botDormant = await mkUser('acme-dormant-bot');
  botGhost = await mkUser('acme-ghost-bot');
  botTeamedManual = await mkUser('acme-teamed-manual-bot');
  soloBot = await mkUser('solo-bot');

  teamA = (await q.createTeam(1, 'Team A')).id;
  teamB = (await q.createTeam(1, 'Team B')).id;
  teamEmpty = (await q.createTeam(1, 'Team Empty')).id;
  // repoBoth is in BOTH teams — team_repos is many-to-many and both tabs must show its bots.
  await q.assignReposToTeam(teamA, 1, [repoTeamed, repoBoth]);
  await q.assignReposToTeam(teamB, 1, [repoBoth]);
  // repoUnteamed is deliberately left out of every team; teamEmpty gets no repos at all.

  await seedThread(1, repoTeamed, botTeamed, human);
  const unteamedPr = await seedThread(1, repoUnteamed, botUnteamed, human);
  // botBoth is seen in TWO repos on different sides of the team line, so a scoped
  // `threadsLast90d` of 1 vs an unscoped 2 proves the volume group-by took the repo filter.
  await seedThread(1, repoBoth, botBoth, human);
  await seedThread(1, repoUnteamed, botBoth, human);
  // …and its only review BODY is in the unteamed repo, so the sample query must narrow too.
  await seedReviewBody(unteamedPr, botBoth, 'unteamed-repo evidence body');

  // botDormant works ONLY in the unteamed repo but is classified for teamA — the realistic
  // "someone set this, then the repos moved" case the dormant flag exists for. It still governs
  // automatedReviewerUserIds/classificationKindForUser at teamA, so teamA's tab must surface it.
  await seedThread(1, repoUnteamed, botDormant, human);
  // Works only in a TEAMED repo, but carries a manual classification at key 0 — the account
  // default, which governs every team that has no row of its own.
  await seedThread(1, repoTeamed, botTeamedManual, human);

  await seedThread(2, repoSolo, soloBot, soloHuman);

  await q.setReviewerOverride(1, botDormant, {
    automated: true,
    kind: 'in_house',
    label: 'Dormant',
    teamId: teamA,
  });
  // botGhost gets the SAME stored row but has never appeared in any of this account's synced
  // data. `author_user_id` points at the GLOBAL users table and this write takes any id, so
  // listing it would turn the route into a cross-tenant profile lookup (login + display name +
  // avatar) for an arbitrary GitHub user. It must stay invisible.
  await q.setReviewerOverride(1, botGhost, {
    automated: true,
    kind: 'in_house',
    label: 'Ghost',
    teamId: teamA,
  });
  await q.setReviewerOverride(1, botTeamedManual, {
    automated: true,
    kind: 'in_house',
    label: 'Teamed Manual',
  });
});

afterAll(() => closeDb?.());

const loginsOf = (resp: any): string[] => resp.reviewers.map((r: any) => r.login).sort();
const rowFor = (resp: any, userId: number) =>
  resp.reviewers.find((r: any) => r.userId === userId);

describe('listDetectedReviewers — the fixture is real (nothing below is vacuous)', () => {
  it('teamA owns two repos, teamB one of them, teamEmpty none, and one repo is unteamed', async () => {
    expect((await q.getTeamRepoIds(teamA, 1)).sort()).toEqual([repoTeamed, repoBoth].sort());
    expect(await q.getTeamRepoIds(teamB, 1)).toEqual([repoBoth]);
    expect(await q.getTeamRepoIds(teamEmpty, 1)).toEqual([]);
    expect(await q.getUnassignedRepoIds(1)).toEqual([repoUnteamed]);
  });
});

describe('listDetectedReviewers — the UNSCOPED listing is unchanged (the four account-wide callers)', () => {
  it('returns every reviewer in the account regardless of team, at key 0 and at a team key', async () => {
    const atRoot = await q.listDetectedReviewers(1);
    const atTeam = await q.listDetectedReviewers(1, teamA);
    for (const resp of [atRoot, atTeam]) {
      // `dana-h` only AUTHORED the PRs — the population is reviewers/thread-openers/commenters,
      // which is unchanged by this work. `acme-ghost-bot` has a stored classification but no
      // synced activity, so it is not part of the population either.
      expect(loginsOf(resp)).toEqual(
        [
          'acme-both-bot',
          'acme-dormant-bot',
          'acme-teamed-bot',
          'acme-teamed-manual-bot',
          'acme-unteamed-bot',
        ].sort(),
      );
    }
  });

  it('reports scopedRepoCount as NULL — not the account repo count, which would hide the real 0', async () => {
    const resp = await q.listDetectedReviewers(1, teamA);
    expect(resp.scopedRepoCount).toBeNull();
    // The account owns three repos, so a "helpfully" defaulted count would be 3 and would make
    // an empty team indistinguishable from a busy one.
    expect((await q.listDetectedReviewers(1, teamA, { scoped: true })).scopedRepoCount).toBe(2);
  });

  it('never marks anything dormantInScope (nothing was narrowed), and still hides the ghost row', async () => {
    const resp = await q.listDetectedReviewers(1, teamA);
    expect(resp.reviewers.every((r: any) => r.dormantInScope === false)).toBe(true);
    // botDormant DOES have a footprint (in the unteamed repo), so an unscoped listing shows it as
    // an ordinary row — it is only "dormant" relative to teamA's repos.
    expect(rowFor(resp, botDormant)).toBeDefined();
    // botGhost has a stored teamA row and no synced activity at all, and must never be named.
    expect(rowFor(resp, botGhost)).toBeUndefined();
  });

  it('counts a reviewer’s threads across ALL repos', async () => {
    const resp = await q.listDetectedReviewers(1, teamA);
    expect(rowFor(resp, botBoth).threadsLast90d).toBe(2);
    expect(rowFor(resp, botBoth).sampleReviewBody).toBe('unteamed-repo evidence body');
  });
});

describe('listDetectedReviewers — scoped to a TEAM', () => {
  it('shows only the reviewers with a footprint in that team’s own repos', async () => {
    const resp = await q.listDetectedReviewers(1, teamA, { scoped: true });
    expect(resp.reviewers.some((r: any) => r.userId === botTeamed)).toBe(true);
    expect(resp.reviewers.some((r: any) => r.userId === botBoth)).toBe(true);
    // The unteamed repo's bot is NOT teamA's problem.
    expect(rowFor(resp, botUnteamed)).toBeUndefined();
    expect(resp.scopedRepoCount).toBe(2);
    expect(resp.teamId).toBe(teamA);
  });

  it('narrows threadsLast90d AND the sample body to the scoped repos', async () => {
    const resp = await q.listDetectedReviewers(1, teamA, { scoped: true });
    // 2 unscoped (above) vs 1 here: without the repo filter this tab would caption the bot with
    // volume it earned somewhere else entirely.
    expect(rowFor(resp, botBoth).threadsLast90d).toBe(1);
    // Its only review body lives in the unteamed repo, so this team has no evidence to show.
    expect(rowFor(resp, botBoth).sampleReviewBody).toBeNull();
  });

  it('shows a repo that belongs to TWO teams on both tabs', async () => {
    const a = await q.listDetectedReviewers(1, teamA, { scoped: true });
    const b = await q.listDetectedReviewers(1, teamB, { scoped: true });
    expect(rowFor(a, botBoth)).toBeDefined();
    expect(rowFor(b, botBoth)).toBeDefined();
    // …and teamB, which owns only the shared repo, does NOT inherit teamA's exclusive bot.
    expect(rowFor(b, botTeamed)).toBeUndefined();
    expect(b.scopedRepoCount).toBe(1);
  });

  it('surfaces a manual row stored at the key as dormantInScope instead of dropping it', async () => {
    const a = await q.listDetectedReviewers(1, teamA, { scoped: true });
    const row = rowFor(a, botDormant);
    expect(row).toBeDefined();
    expect(row.dormantInScope).toBe(true);
    expect(row.inherited).toBe(false); // it IS teamA's own row
    expect(row.classification.automated).toBe(true);
    // Every other row is a real footprint row, so the flag is discriminating and not constant.
    expect(rowFor(a, botTeamed).dormantInScope).toBe(false);
    // The row belongs to teamA ALONE — teamB has no stored row for it and no footprint.
    const b = await q.listDetectedReviewers(1, teamB, { scoped: true });
    expect(rowFor(b, botDormant)).toBeUndefined();
    // …and at NO_TEAM it is an ORDINARY row: its footprint IS in the unteamed repo.
    const root = await q.listDetectedReviewers(1, NO_TEAM, { scoped: true });
    expect(rowFor(root, botDormant).dormantInScope).toBe(false);
  });

  it('NEVER names a classified user the account has no synced activity for', async () => {
    // The dormant scan reads `bot_review_classification.author_user_id`, which points at the
    // GLOBAL users table, and setReviewerOverride accepts ANY id. Without the intersection
    // against this account's own population, writing an override for an arbitrary id and then
    // reading the scoped listing returns that person's login/display name/avatar — a
    // cross-tenant profile lookup. verify:isolation caught exactly this.
    const a = await q.listDetectedReviewers(1, teamA, { scoped: true });
    expect(rowFor(a, botGhost)).toBeUndefined();
    // The row really is stored, so the assertion above is about the guard and not about a
    // missing fixture.
    const ghostRow = (await db.select().from(schema.botReviewClassification).execute()).find(
      (r: any) => r.accountId === 1 && r.teamId === teamA && r.authorUserId === botGhost,
    );
    expect(ghostRow).toBeDefined();
    expect(ghostRow.source).toBe('manual');
  });

  it('reports 0 repos for a team with none, and shows nothing there', async () => {
    const resp = await q.listDetectedReviewers(1, teamEmpty, { scoped: true });
    expect(resp.scopedRepoCount).toBe(0);
    // No footprint (no repos) and no manual row stored at this key → genuinely empty. The 0 is
    // what lets the UI say "assign repos to this team" instead of "no bots detected".
    expect(resp.reviewers).toEqual([]);
  });
});

describe('listDetectedReviewers — scoped at NO_TEAM_KEY means the UNTEAMED repos', () => {
  it('shows only reviewers active in repos that belong to no team', async () => {
    const resp = await q.listDetectedReviewers(1, NO_TEAM, { scoped: true });
    expect(rowFor(resp, botUnteamed)).toBeDefined();
    // botBoth is also active in the unteamed repo, so it legitimately appears here too…
    expect(rowFor(resp, botBoth)).toBeDefined();
    // …but the bot that only ever worked in a teamed repo does not.
    expect(rowFor(resp, botTeamed)).toBeUndefined();
    expect(resp.scopedRepoCount).toBe(1);
  });

  it('a MANUAL row at key 0 shows here as DORMANT even when its work is all in teamed repos', async () => {
    // The literal "reviewers active in unteamed repos" rule governs the MAIN list. A manual row
    // stored at key 0 is the ACCOUNT DEFAULT — it governs every team that has no row of its own —
    // so hiding it would be the "set here but invisible while still steering everything" trap.
    // It arrives flagged `dormantInScope` for the UI's dimmed/collapsed section, not in the body
    // of the list.
    const resp = await q.listDetectedReviewers(1, NO_TEAM, { scoped: true });
    const row = rowFor(resp, botTeamedManual);
    expect(row).toBeDefined();
    expect(row.dormantInScope).toBe(true);
    // Contrast: botTeamed has the SAME footprint (teamed repo only) but only an AUTO row, so it
    // is absent entirely — the discriminator is the manual judgement, not the footprint.
    expect(rowFor(resp, botTeamed)).toBeUndefined();
    // And where it IS active, it is an ordinary row.
    const a = await q.listDetectedReviewers(1, teamA, { scoped: true });
    expect(rowFor(a, botTeamedManual).dormantInScope).toBe(false);
  });

  it('does NOT resurrect the whole roster as dormant rows (bare auto rows at key 0 are excluded)', async () => {
    // Every reviewer the listing has ever classified holds an AUTO row at key 0. If the dormant
    // scan had no predicate at all, the No-Team tab would list all of them and the narrowing
    // would be undone entirely. (The predicate is "manual OR carries a stored price" — a bare
    // auto row is regenerable and holds no human judgement; see the priced cases at the end of
    // this file for the other half of that rule.)
    const autoRowsAtRoot = (
      await db.select().from(schema.botReviewClassification).execute()
    ).filter((r: any) => r.accountId === 1 && r.teamId === NO_TEAM && r.source !== 'manual');
    expect(autoRowsAtRoot.length).toBeGreaterThan(0); // the guard has something to exclude
    const resp = await q.listDetectedReviewers(1, NO_TEAM, { scoped: true });
    // Not ONE of the auto-classified logins is dragged back in as a dormant row (the only
    // dormant row here is the manually-classified one asserted below).
    const autoIds = new Set(autoRowsAtRoot.map((r: any) => r.authorUserId));
    expect(resp.reviewers.some((r: any) => autoIds.has(r.userId) && r.dormantInScope)).toBe(false);
    expect(rowFor(resp, botTeamed)).toBeUndefined();
  });

  it('an account with NO teams sees everything on the No-Team tab', async () => {
    // Account 2 has one repo and no teams, so every repo is unassigned and the scoped listing
    // must be identical to the unscoped one — the single-team install must not go blank.
    const scoped = await q.listDetectedReviewers(2, NO_TEAM, { scoped: true });
    const unscoped = await q.listDetectedReviewers(2, NO_TEAM);
    expect(loginsOf(scoped)).toEqual(loginsOf(unscoped));
    expect(rowFor(scoped, soloBot)).toBeDefined();
    expect(scoped.scopedRepoCount).toBe(1);
    // …and it still cannot see account 1's reviewers (the scoping is not a substitute for the
    // accountId predicate).
    expect(rowFor(scoped, botTeamed)).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// A STORED PRICE IS A HUMAN JUDGEMENT TOO — and it is the one with money attached.
//
// A COST-ONLY patch deliberately does NOT stamp `source: 'manual'` (that would freeze the
// reviewer's classification forever, see setReviewerOverride), so pricing an auto-detected bot
// creates a row whose source is `vendor_login`/`github_type`/`behavioral` — at ANY key. A dormant
// scan filtering on `source = 'manual'` therefore dropped exactly the rows holding money, at both
// ends of the inheritance chain:
//   • at a TEAM key, a price typed on the team tab disappeared from that tab the moment the bot's
//     repo left the team, while still resolving at that key — un-auditable, un-clearable;
//   • at NO_TEAM_KEY, a price typed at the ROOT (where every team inherits from) disappeared from
//     the No-team tab as soon as the account had no untamed repos, while still driving every
//     team's inherited cost.
// These run LAST because they write classification rows into account 1's fixture.
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('listDetectedReviewers — a PRICED row survives as dormant, manual or not', () => {
  it('a price on an auto-detected bot at a TEAM key makes it findable there', async () => {
    // botUnteamed's only footprint is the repo in NO team, so teamA's scoped tab cannot see it…
    const before = await q.listDetectedReviewers(1, teamA, { scoped: true });
    expect(rowFor(before, botUnteamed)).toBeUndefined(); // not vacuous

    // …until someone prices it there. This is the ORDINARY path: the CostEditor sends a cost-only
    // body on whatever row the tab is showing, and most rows are auto-classified.
    await q.setReviewerOverride(1, botUnteamed, { costMonthlyUsd: 250, teamId: teamA });
    const stored = (await db.select().from(schema.botReviewClassification).execute()).find(
      (r: any) => r.accountId === 1 && r.teamId === teamA && r.authorUserId === botUnteamed,
    );
    // The row that got created is NOT manual — that is the whole trap.
    expect(stored.source).not.toBe('manual');
    expect(stored.costMonthlyCents).toBe(25_000);

    const after = await q.listDetectedReviewers(1, teamA, { scoped: true });
    const row = rowFor(after, botUnteamed);
    expect(row).toBeDefined();
    expect(row.dormantInScope).toBe(true);
    // …and it arrives WITH its price, so the box that set it is the box that can clear it.
    expect(row.costMonthlyUsd).toBe(250);
    expect(row.costInherited).toBe(false);
  });

  it('a price at the ROOT stays findable on the No-team tab', async () => {
    // botTeamed works only in a TEAMED repo, so the No-team scope (the untamed repos) has no
    // footprint for it — the existing test above asserts it is absent there.
    const before = await q.listDetectedReviewers(1, NO_TEAM, { scoped: true });
    expect(rowFor(before, botTeamed)).toBeUndefined(); // not vacuous

    // Key 0 is the inheritance ROOT: this one number is what every team without its own price
    // charges for this bot. Losing sight of it is losing the account default.
    await q.setReviewerOverride(1, botTeamed, { costMonthlyUsd: 400 });
    const after = await q.listDetectedReviewers(1, NO_TEAM, { scoped: true });
    const row = rowFor(after, botTeamed);
    expect(row).toBeDefined();
    expect(row.dormantInScope).toBe(true);
    expect(row.costMonthlyUsd).toBe(400);
    // And every team still inherits it — the row was governing all along, which is exactly why
    // hiding it was the bug.
    expect((await q.listDetectedReviewers(1, teamB)).reviewers.find(
      (r: any) => r.userId === botTeamed,
    ).costMonthlyUsd).toBe(400);
  });

  it('a stored 0 ("free here") is a price too — NOT-NULL, never truthiness', async () => {
    await q.setReviewerOverride(1, botUnteamed, { costMonthlyUsd: 0, teamId: teamB });
    const resp = await q.listDetectedReviewers(1, teamB, { scoped: true });
    const row = rowFor(resp, botUnteamed);
    // With a truthiness test on cost_monthly_cents this row would vanish while still zeroing the
    // team's spend for that bot.
    expect(row).toBeDefined();
    expect(row.dormantInScope).toBe(true);
    expect(row.costMonthlyUsd).toBe(0);
  });

  it('still does not resurrect UNPRICED auto rows', async () => {
    // The narrowing the predicate must not undo. botTeamed is now priced at key 0 (above) so it
    // is legitimately listed; every OTHER auto-classified login with no untamed footprint and no
    // price must stay out.
    const priced = new Set((await db.select().from(schema.botReviewClassification).execute())
      .filter((r: any) => r.accountId === 1 && r.teamId === NO_TEAM && r.costMonthlyCents != null)
      .map((r: any) => r.authorUserId));
    const bare = (await db.select().from(schema.botReviewClassification).execute()).filter(
      (r: any) =>
        r.accountId === 1 &&
        r.teamId === NO_TEAM &&
        r.source !== 'manual' &&
        r.costMonthlyCents == null,
    );
    expect(bare.length).toBeGreaterThan(0); // the guard still has something to exclude
    const resp = await q.listDetectedReviewers(1, NO_TEAM, { scoped: true });
    for (const r of resp.reviewers) {
      if (r.dormantInScope) expect(priced.has(r.userId) || r.isManualOverride).toBe(true);
    }
  });
});

describe('listDetectedReviewers — the No-team ROOT never goes dark', () => {
  // The ordinary "we adopted teams" step: every repo ends up in a team, so `getUnassignedRepoIds`
  // returns []. A strictly scoped key 0 would then list NOTHING — and key 0 is not just the
  // No-team scope, it is the row every team inherits classification AND cost from, and the key
  // `classificationTeamKey` maps every union scope onto. Empty means no cost boxes, no roles, and
  // (since the search-to-promote block lives on the non-empty path) no way to set an account-wide
  // answer at all, under an empty state telling the user to go assign more repos to teams.
  let allTeamedBot = 0;

  beforeAll(async () => {
    const { accounts, repos, users } = schema;
    await db
      .insert(accounts)
      .values({ id: 3, githubUserId: 'U_drs_c', githubLogin: 'fullyteamed', isLocal: false })
      .execute();
    const repoId = (
      await db
        .insert(repos)
        .values({
          accountId: 3,
          owner: 'acme',
          name: 'all-teamed',
          githubNodeId: 'R_drs_all_teamed',
          inboxWatch: true,
        })
        .returning()
        .execute()
    )[0].id as number;
    const human = (
      await db
        .insert(users)
        .values({ githubLogin: 'ft-human', githubNodeId: 'U_drs_fth', isBot: false })
        .returning()
        .execute()
    )[0].id as number;
    allTeamedBot = (
      await db
        .insert(users)
        .values({ githubLogin: 'acme-all-teamed-bot', githubNodeId: 'U_drs_atb', isBot: true })
        .returning()
        .execute()
    )[0].id as number;
    await seedThread(3, repoId, allTeamedBot, human);
    const team = (await q.createTeam(3, 'Everything')).id;
    await q.assignReposToTeam(team, 3, [repoId]);
    expect(await q.getUnassignedRepoIds(3)).toEqual([]); // the premise
  });

  it('degrades to the unscoped roster instead of listing nothing', async () => {
    const resp = await q.listDetectedReviewers(3, NO_TEAM, { scoped: true });
    expect(rowFor(resp, allTeamedBot)).toBeDefined();
    // NULL, not 0: no scoping happened, so there is no repo count to quote — which is also what
    // makes the client drop the "reviewers seen in this scope's N repos" caption and the
    // team-only "this team has no repos yet" empty copy (emptyStateFor(null) === 'unscoped').
    expect(resp.scopedRepoCount).toBeNull();
    // Identical to the unscoped listing, since that is what it degraded to.
    const unscoped = await q.listDetectedReviewers(3, NO_TEAM);
    expect(loginsOf(resp)).toEqual(loginsOf(unscoped));
    // Still account-scoped — the degradation widens repos, never tenants.
    expect(rowFor(resp, botTeamed)).toBeUndefined();
  });

  it('a NAMED team with no repos still reports 0 and lists nothing', async () => {
    // Only the ROOT degrades. For a real team, "no repos assigned" is the true and useful answer,
    // and the 0 is what lets the UI say "assign some" instead of "no bots detected".
    const empty = (await q.createTeam(3, 'Empty')).id;
    const resp = await q.listDetectedReviewers(3, empty, { scoped: true });
    expect(resp.scopedRepoCount).toBe(0);
    expect(resp.reviewers).toEqual([]);
  });
});
