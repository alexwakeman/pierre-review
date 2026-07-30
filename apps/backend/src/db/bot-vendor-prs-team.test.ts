// getBotVendorPrs TEAM RESOLUTION, on a THROWAWAY sqlite DB.
//
// Since migration 0042 the classification unique index is (account_id, team_id, author_user_id),
// so an account-only read of bot_review_classification returns SEVERAL rows per author and every
// team-scoped surface must bind the team key. This drill-down is opened from a TEAM-scoped ROI
// row, so both of the things it derives per-reviewer have to agree with that row:
//
//   1. the header LABEL — an account-only `limit(1)` with no ORDER BY picked whichever row the
//      storage engine handed back first (the team-0 default, in insertion order), contradicting
//      the ROI row the user clicked;
//   2. the per-PR `botOnly` badge — computed via getBotOnlyReviewPrs, whose `teamKey` parameter
//      has a NO_TEAM_KEY default, so omitting it silently evaluated the rule at the account
//      default: a reviewer the TEAM marked human still counted as a bot here, while the header's
//      `totals.botOnlyPrs` (from /api/bot-analytics) is team-resolved. One screen, two answers.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DB_PATH = '/tmp/pierre-bot-vendor-prs-team-test.sqlite';
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

let teamId = 0;
let botA = 0; // the drill-down target
let botB = 0; // automated at the account default, HUMAN under the team override
let prId = 0;

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('./run-migrations.js');
  const client = await import('./client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  q = await import('./queries.js');
  await runMigrations();

  const { repos, pullRequests, users, reviewThreads, reviewComments, reviews, teams } = schema;

  const [team] = await db
    .insert(teams)
    .values({ accountId: 1, name: 'platform' })
    .returning()
    .execute();
  teamId = team.id;

  const [repo] = await db
    .insert(repos)
    .values({ accountId: 1, owner: 'acme', name: 'api', githubNodeId: 'R_bvp', inboxWatch: true })
    .returning()
    .execute();

  const [author] = await db
    .insert(users)
    .values({ githubLogin: 'jordan-lee', githubNodeId: 'U_bvp_h' })
    .returning()
    .execute();

  // OPEN + mergeable: getBotOnlyReviewPrs' non-openOnly branch still requires one of
  // (merged in window) / (open AND mergeable), so a bare open PR would be filtered out and the
  // botOnly assertions would pass vacuously on an empty candidate set.
  const [pr] = await db
    .insert(pullRequests)
    .values({
      githubNodeId: 'PR_bvp',
      accountId: 1,
      repoId: repo.id,
      number: 1,
      title: 'team-resolution fixture',
      state: 'open',
      mergeable: 'mergeable',
      isDraft: false,
      authorId: author.id,
      openedAt: new Date(now - 5 * DAY),
      updatedAt: new Date(now - 1 * DAY),
    })
    .returning()
    .execute();
  prId = pr.id;

  // Neither login is a known vendor, so ONLY the classification rows decide — which is the point:
  // a vendor login would be automated at every team key via reviewBotUserIds and the team
  // override could never flip it.
  const [a] = await db
    .insert(users)
    .values({ githubLogin: 'acme-review-bot', githubNodeId: 'U_bvp_a', isBot: true })
    .returning()
    .execute();
  const [b] = await db
    .insert(users)
    .values({ githubLogin: 'acme-helper-bot', githubNodeId: 'U_bvp_b', isBot: true })
    .returning()
    .execute();
  botA = a.id;
  botB = b.id;

  // botA's thread + comment — what puts the PR in its drill-down.
  const [thread] = await db
    .insert(reviewThreads)
    .values({
      githubNodeId: 'BVP_T1',
      prId: pr.id,
      path: 'src/x.ts',
      line: 1,
      isResolved: false,
      isOutdated: false,
      derivedState: 'untouched',
      originalCommenterId: botA,
      createdAt: new Date(now - 3 * DAY),
    })
    .returning()
    .execute();
  await db
    .insert(reviewComments)
    .values({
      githubNodeId: 'BVP_C1',
      threadId: thread.id,
      prId: pr.id,
      authorId: botA,
      createdAt: new Date(now - 3 * DAY),
    })
    .execute();

  // botB's review — the ONLY other touch on the PR. Automated at the account default (so the PR
  // is bot-only there), a HUMAN under the team override (so it is not bot-only for that team).
  await db
    .insert(reviews)
    .values({
      githubNodeId: 'BVP_RV1',
      prId: pr.id,
      authorId: botB,
      state: 'commented',
      submittedAt: new Date(now - 2 * DAY),
    })
    .execute();

  // Account default: both are automated; botA is labelled 'Default Label'.
  await q.setReviewerOverride(1, botA, {
    automated: true,
    kind: 'in_house',
    label: 'Default Label',
  });
  await q.setReviewerOverride(1, botB, { automated: true, kind: 'in_house', label: 'Helper' });
  // Team override: botA keeps a DIFFERENT label; botB is declared a human.
  await q.setReviewerOverride(1, botA, {
    automated: true,
    kind: 'in_house',
    label: 'Team Label',
    teamId: team.id,
  });
  await q.setReviewerOverride(1, botB, { automated: false, teamId: team.id });
});

afterAll(() => closeDb?.());

describe('getBotVendorPrs resolves classification per TEAM', () => {
  it('the fixture really does hold two rows per author (otherwise the rest is vacuous)', async () => {
    const rows = (
      await db.select().from(schema.botReviewClassification).execute()
    ).filter((r: any) => r.accountId === 1 && r.authorUserId === botA);
    expect(rows.map((r: any) => r.teamId).sort()).toEqual([NO_TEAM, teamId].sort());
    // …and the two keys genuinely disagree about botB, which is what makes the botOnly rule flip.
    expect(await q.automatedReviewerUserIds(1, NO_TEAM, 'all')).toContain(botB);
    expect(await q.automatedReviewerUserIds(1, teamId, 'all')).not.toContain(botB);
  });

  it('uses the TEAM label, not whichever classification row the storage engine returns first', async () => {
    const teamRes = await q.getBotVendorPrs(1, { userId: botA }, 'rolling_14', null, teamId);
    expect(teamRes.label).toBe('Team Label');
    // The account default still reports its own label — proves the assertion above is about the
    // team key and not about the label read being broken in some constant way.
    const defRes = await q.getBotVendorPrs(1, { userId: botA }, 'rolling_14', null, NO_TEAM);
    expect(defRes.label).toBe('Default Label');
  });

  it('computes the per-PR botOnly flag at the REQUESTED team, not at the account default', async () => {
    const defRes = await q.getBotVendorPrs(1, { userId: botA }, 'rolling_14', null, NO_TEAM);
    const defPr = defRes.prs.find((p: any) => p.prId === prId);
    // Sanity: the PR is in the list at all, and at the account default both reviewers are bots,
    // so nothing human touched it.
    expect(defPr).toBeDefined();
    expect(defPr.botOnly).toBe(true);

    const teamRes = await q.getBotVendorPrs(1, { userId: botA }, 'rolling_14', null, teamId);
    const teamPr = teamRes.prs.find((p: any) => p.prId === prId);
    expect(teamPr).toBeDefined();
    // The team calls botB a human, so a human reviewed this PR → NOT bot-only for that team.
    expect(teamPr.botOnly).toBe(false);
    // …and this is exactly what the team-scoped analytics count says, which is the number
    // rendered directly above this list.
    const analytics = await q.getBotAnalytics(1, 'rolling_14', null, teamId);
    expect(analytics.totals.botOnlyPrs).toBe(0);
  });
});
