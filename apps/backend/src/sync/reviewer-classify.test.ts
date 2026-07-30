// Layered reviewer classifier + behavioral signals, on a THROWAWAY sqlite DB. Seeds
// users (and, for the behavioral compute, PRs/commits/reviews/threads/comments) then
// exercises the resolution order (manual > vendor > github_type > fingerprint >
// behavioral(medium) > human) plus the persistence + manual-never-overwritten guarantee.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DB_PATH = '/tmp/pierre-reviewer-classify-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => void) | undefined;
let classifyReviewer: any;
let computeBehavioralSignals: any;
let fingerprintReview: any;

const DAY = 24 * 60 * 60 * 1000;
const MIN = 60 * 1000;
// The classification team key sentinel (shared's NO_TEAM_KEY): 0 = "No team" AND the inheritance
// root. Every classifyReviewer call passes it EXPLICITLY — since migration 0042 the unique index
// is (account_id, team_id, author_user_id), so a read with no team predicate is non-deterministic.
const NO_TEAM = 0;

// user id by login, populated in beforeAll.
const uid: Record<string, number> = {};

async function addUser(
  login: string,
  opts: { isBot?: boolean; githubType?: string | null } = {},
): Promise<number> {
  const [row] = await db
    .insert(schema.users)
    .values({
      githubLogin: login,
      githubNodeId: `U_${login}`,
      isBot: opts.isBot ?? false,
      githubType: opts.githubType ?? null,
    })
    .returning()
    .execute();
  uid[login] = row.id;
  return row.id;
}

function userArg(login: string, opts: { isBot?: boolean; githubType?: string | null } = {}) {
  return {
    id: uid[login]!,
    githubLogin: login,
    githubType: opts.githubType ?? null,
    isBot: opts.isBot ?? false,
  };
}

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../db/run-migrations.js');
  const client = await import('../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  ({ classifyReviewer } = await import('./reviewer-classify.js'));
  ({ computeBehavioralSignals } = await import('./reviewer-behavior.js'));
  ({ fingerprintReview } = await import('./review-fingerprint.js'));
  await runMigrations();

  // account 1 exists (migration 0008); add a second account for the isolation check.
  await db
    .insert(schema.accounts)
    .values({ id: 2, githubUserId: 'GH_2', githubLogin: 'acct2', isLocal: false })
    .execute();

  await addUser('coderabbitai', { isBot: true });
  await addUser('qodo-ai', { isBot: true }); // manual-override subject
  await addUser('claude-bot-type', { isBot: true, githubType: 'Bot' });
  await addUser('branded-bot-type', { isBot: true, githubType: 'Bot' });
  await addUser('pierre-poster', { githubType: 'User' });
  await addUser('acme-ci'); // matches the -ci service-account pattern
  await addUser('jordan-lee'); // a fast, thorough human
  await addUser('sam-rivers'); // no evidence at all
  await addUser('robo-reviewer'); // behavioral-compute subject
  await addUser('sonarqubecloud', { isBot: true, githubType: 'Bot' }); // quality-check seed subject
  await addUser('per-team-bot', { isBot: true, githubType: 'Bot' }); // per-team override subject
});

afterAll(() => closeDb?.());

describe('classifyReviewer resolution order', () => {
  it('2. known vendor login → vendor kind, high, vendor_login (+ persisted)', async () => {
    const c = await classifyReviewer(1, userArg('coderabbitai', { isBot: true }), {}, NO_TEAM);
    expect(c.automated).toBe(true);
    expect(c.kind).toBe('coderabbit');
    expect(c.confidence).toBe('high');
    expect(c.source).toBe('vendor_login');
    // persisted to the classification store (small test DB → a full scan is fine)
    const persisted = (
      await db.select().from(schema.botReviewClassification).execute()
    ).find((r: any) => r.authorUserId === uid['coderabbitai']! && r.accountId === 1);
    expect(persisted).toBeDefined();
    expect(persisted.source).toBe('vendor_login');
  });

  it("3. githubType==='Bot' with no marker → in_house, high, github_type", async () => {
    const c = await classifyReviewer(
      1,
      userArg('claude-bot-type', { isBot: true, githubType: 'Bot' }),
      { fingerprint: { marked: false, tool: null, markers: [] } },
      NO_TEAM,
    );
    expect(c.automated).toBe(true);
    expect(c.kind).toBe('in_house');
    expect(c.source).toBe('github_type');
    expect(c.confidence).toBe('high');
  });

  it('3. githubType Bot + a branded fingerprint → the vendor kind wins the label', async () => {
    const fp = fingerprintReview('Summary by CodeRabbit', []);
    const c = await classifyReviewer(
      1,
      userArg('branded-bot-type', { isBot: true, githubType: 'Bot' }),
      { fingerprint: fp },
      NO_TEAM,
    );
    expect(c.kind).toBe('coderabbit');
    expect(c.source).toBe('github_type');
  });

  // The marker in the review body stays `pierre:claude-review` after the rename to
  // Limn, and so does the `kind` — both are permanent identifiers. The marker is
  // written into GitHub review bodies we do not control, so the detector must keep
  // matching it forever; the kind is a persisted DB value and a live API path
  // segment. Only the human-readable LABEL moved. This test asserts that split.
  it('4. branded fingerprint on a plain User → pierre, high, fingerprint', async () => {
    const fp = fingerprintReview('LGTM\n\n<!-- pierre:claude-review v=1 -->', []);
    const c = await classifyReviewer(
      1,
      userArg('pierre-poster', { githubType: 'User' }),
      { fingerprint: fp },
      NO_TEAM,
    );
    expect(c.automated).toBe(true);
    expect(c.kind).toBe('pierre');
    expect(c.source).toBe('fingerprint');
    expect(c.label).toBe('Limn · Claude');
  });

  it('5. behavioral band → MEDIUM in_house, source behavioral (never auto-badges to high)', async () => {
    const c = await classifyReviewer(
      1,
      userArg('acme-ci'),
      {
        behavioral: {
          reviews: 5,
          medianPushToReviewMins: 0.5,
          reviewsPerPr: 1,
          replyRate: 0,
          commentsPerReview: 4,
        },
      },
      NO_TEAM,
    );
    expect(c.automated).toBe(true);
    expect(c.kind).toBe('in_house');
    expect(c.confidence).toBe('medium'); // MEDIUM — no tiebreak requested
    expect(c.source).toBe('behavioral');
    expect(c.label).toBe('acme-ci'); // allowlist match → the login is the label
  });

  it('otherwise → human (strong): behavioral evidence that does not trip → automated:false, high', async () => {
    const c = await classifyReviewer(
      1,
      userArg('jordan-lee'),
      {
        behavioral: {
          reviews: 5,
          medianPushToReviewMins: 120,
          reviewsPerPr: 3,
          replyRate: 0.8,
          commentsPerReview: 1,
        },
      },
      NO_TEAM,
    );
    expect(c.automated).toBe(false);
    expect(c.kind).toBeNull();
    expect(c.confidence).toBe('high');
  });

  it('otherwise → human (weak): no evidence → automated:false, low', async () => {
    const c = await classifyReviewer(1, userArg('sam-rivers'), {}, NO_TEAM);
    expect(c.automated).toBe(false);
    expect(c.confidence).toBe('low');
  });
});

describe('manual override wins + is never overwritten by auto', () => {
  it('1. a source=manual "human" row beats the vendor-login signal', async () => {
    // qodo-ai is a KNOWN vendor login, but a manual override says "this is a human".
    await db
      .insert(schema.botReviewClassification)
      .values({
        accountId: 1,
        teamId: NO_TEAM,
        authorUserId: uid['qodo-ai']!,
        automated: false,
        kind: null,
        label: 'A human',
        confidence: 'high',
        source: 'manual',
        reasonsJson: ['user marked as human'],
        updatedAt: new Date(),
      })
      .execute();
    const c = await classifyReviewer(1, userArg('qodo-ai', { isBot: true }), {}, NO_TEAM);
    expect(c.automated).toBe(false);
    expect(c.source).toBe('manual');
    expect(c.label).toBe('A human');
    // and the stored row is untouched (still manual, still automated=false)
    const row = (
      await db.select().from(schema.botReviewClassification).execute()
    ).find((r: any) => r.authorUserId === uid['qodo-ai']! && r.accountId === 1);
    expect(row.source).toBe('manual');
    expect(row.automated).toBe(false);
  });
});

describe('computeBehavioralSignals', () => {
  beforeAll(async () => {
    const now = Date.now();
    const [repo] = await db
      .insert(schema.repos)
      .values({ accountId: 1, owner: 'acme', name: 'svc', githubNodeId: 'R_beh' })
      .returning()
      .execute();
    const U = uid['robo-reviewer']!;

    // 3 PRs: each gets one commit and a review by U ~1 min later (sub-2-min latency).
    const prIds: number[] = [];
    for (let i = 0; i < 3; i++) {
      const openedAt = new Date(now - (10 + i) * DAY);
      const [pr] = await db
        .insert(schema.pullRequests)
        .values({
          githubNodeId: `PR_beh_${i}`,
          accountId: 1,
          repoId: repo.id,
          number: 100 + i,
          title: `beh ${i}`,
          state: 'open',
          isDraft: false,
          openedAt,
          updatedAt: openedAt,
        })
        .returning()
        .execute();
      prIds.push(pr.id);
      const commitAt = new Date(now - (5 + i) * DAY);
      await db
        .insert(schema.commits)
        .values({ sha: `sha_${i}`, prId: pr.id, committedAt: commitAt })
        .execute();
      await db
        .insert(schema.reviews)
        .values({
          githubNodeId: `RV_beh_${i}`,
          prId: pr.id,
          authorId: U,
          state: 'commented',
          submittedAt: new Date(commitAt.getTime() + 1 * MIN),
        })
        .execute();
    }

    // 9 threads on PR0, each ORIGINATED by U with exactly ONE comment by U → replyRate 0,
    // and 9 comments / 3 reviews → commentsPerReview 3.
    const pr0 = prIds[0]!;
    for (let i = 0; i < 9; i++) {
      const [th] = await db
        .insert(schema.reviewThreads)
        .values({
          githubNodeId: `TH_beh_${i}`,
          prId: pr0,
          path: 'src/x.ts',
          line: i + 1,
          isResolved: false,
          isOutdated: false,
          derivedState: 'untouched',
          originalCommenterId: U,
          createdAt: new Date(now - 5 * DAY),
        })
        .returning()
        .execute();
      await db
        .insert(schema.reviewComments)
        .values({
          githubNodeId: `RC_beh_${i}`,
          threadId: th.id,
          prId: pr0,
          authorId: U,
          body: `⚠️ Potential issue ${i}`,
          createdAt: new Date(now - 5 * DAY),
        })
        .execute();
    }

    // Account-2 noise for the same user id — must NOT leak into account-1 signals.
    const [repo2] = await db
      .insert(schema.repos)
      .values({ accountId: 2, owner: 'acme', name: 'svc2', githubNodeId: 'R_beh2' })
      .returning()
      .execute();
    const [pr2] = await db
      .insert(schema.pullRequests)
      .values({
        githubNodeId: 'PR_beh_a2',
        accountId: 2,
        repoId: repo2.id,
        number: 1,
        title: 'a2',
        state: 'open',
        isDraft: false,
        openedAt: new Date(now - DAY),
        updatedAt: new Date(now - DAY),
      })
      .returning()
      .execute();
    await db
      .insert(schema.reviews)
      .values({
        githubNodeId: 'RV_beh_a2',
        prId: pr2.id,
        authorId: U,
        state: 'commented',
        submittedAt: new Date(now - DAY),
      })
      .execute();
  });

  it('derives per-account distributions from real synced rows (account-scoped)', async () => {
    const sig = await computeBehavioralSignals(1, uid['robo-reviewer']!);
    expect(sig.reviews).toBe(3); // account-2's review is excluded
    expect(sig.reviewsPerPr).toBe(1);
    expect(sig.commentsPerReview).toBe(3);
    expect(sig.replyRate).toBe(0);
    expect(sig.medianPushToReviewMins).not.toBeNull();
    expect(sig.medianPushToReviewMins!).toBeLessThan(2);
  });

  it('feeds classifyReviewer → this reviewer lands in the MEDIUM automated band', async () => {
    const sig = await computeBehavioralSignals(1, uid['robo-reviewer']!);
    const c = await classifyReviewer(1, userArg('robo-reviewer'), { behavioral: sig }, NO_TEAM);
    expect(c.automated).toBe(true);
    expect(c.confidence).toBe('medium');
    expect(c.source).toBe('behavioral');
  });
});

// ── Per-TEAM classification + the quality-check ROLE (migration 0042) ────────────────────────
// `bot_review_classification` gained (team_id, role) and its unique index became the 3-column
// (account_id, team_id, author_user_id). These cover the four things most likely to break:
// the upsert's conflict target, the team override → team-0 → auto-detect resolution order, the
// role seed surviving a re-sync, and deleteTeam's hand-rolled cleanup (there is no FK cascade).
describe('per-team classification + quality-check role', () => {
  let q: any;
  beforeAll(async () => {
    q = await import('../db/queries.js');
    // listDetectedReviewers only surfaces actors seen in THIS account's synced data, so the
    // per-team override subject needs a real review or it never appears in the roster and the
    // teamId/inherited assertions below would pass vacuously on `undefined`.
    const [repo] = await db
      .insert(schema.repos)
      .values({ accountId: 1, owner: 'acme', name: 'team-svc', githubNodeId: 'R_team' })
      .returning()
      .execute();
    const [pr] = await db
      .insert(schema.pullRequests)
      .values({
        githubNodeId: 'PR_team_1',
        accountId: 1,
        repoId: repo.id,
        number: 1,
        title: 'team',
        state: 'open',
        isDraft: false,
        openedAt: new Date(Date.now() - DAY),
        updatedAt: new Date(Date.now() - DAY),
      })
      .returning()
      .execute();
    await db
      .insert(schema.reviews)
      .values({
        githubNodeId: 'RV_team_1',
        prId: pr.id,
        authorId: uid['per-team-bot']!,
        state: 'commented',
        submittedAt: new Date(Date.now() - DAY),
      })
      .execute();
  });

  it('the ON CONFLICT target matches the 3-column unique index (upsert, not duplicate)', async () => {
    // Classifying the SAME reviewer twice under the SAME team must UPDATE, not insert a second
    // row — and must not raise "no unique or exclusion constraint matching the ON CONFLICT
    // specification", which is what a stale 2-column target produces at runtime.
    await classifyReviewer(1, userArg('sonarqubecloud', { isBot: true, githubType: 'Bot' }), {}, NO_TEAM);
    await classifyReviewer(1, userArg('sonarqubecloud', { isBot: true, githubType: 'Bot' }), {}, NO_TEAM);
    const rows = (await db.select().from(schema.botReviewClassification).execute()).filter(
      (r: any) => r.accountId === 1 && r.authorUserId === uid['sonarqubecloud']!,
    );
    expect(rows).toHaveLength(1);
  });

  it('seeds a known quality-check login with role=quality_check, still automated', async () => {
    const c = await classifyReviewer(
      1,
      userArg('sonarqubecloud', { isBot: true, githubType: 'Bot' }),
      {},
      NO_TEAM,
    );
    // automated STAYS true — excludeBots / the feed bot lens / the per-row vendor tag all keep
    // working. Only the METRIC sets narrow by role.
    expect(c.automated).toBe(true);
    expect(c.role).toBe('quality_check');
  });

  it('the role SURVIVES a re-classification pass (the backfill is not erased)', async () => {
    // The regression this guards: persist() shares ONE values object between the insert and the
    // ON CONFLICT set:, so a role copied off the in-memory classification would be rewritten
    // from a stale default on the next sync — putting SonarQube back into the review-bot metrics.
    await classifyReviewer(1, userArg('sonarqubecloud', { isBot: true, githubType: 'Bot' }), {}, NO_TEAM);
    const [row] = (await db.select().from(schema.botReviewClassification).execute()).filter(
      (r: any) => r.accountId === 1 && r.authorUserId === uid['sonarqubecloud']!,
    );
    expect(row.role).toBe('quality_check');
  });

  it('a quality_check reviewer is EXCLUDED from the metric set but present in the full set', async () => {
    const reviewOnly = await q.automatedReviewerUserIds(1, NO_TEAM, 'review');
    const all = await q.automatedReviewerUserIds(1, NO_TEAM, 'all');
    expect(all).toContain(uid['sonarqubecloud']!);
    expect(reviewOnly).not.toContain(uid['sonarqubecloud']!);
    // …and a real review bot is in BOTH (the role filter is not a blanket narrowing).
    expect(all).toContain(uid['coderabbitai']!);
    expect(reviewOnly).toContain(uid['coderabbitai']!);
  });

  it('a TEAM override beats the team-0 default; other teams still inherit team 0', async () => {
    const [team] = await db
      .insert(schema.teams)
      .values({ accountId: 1, name: 'platform' })
      .returning()
      .execute();
    const [otherTeam] = await db
      .insert(schema.teams)
      .values({ accountId: 1, name: 'web' })
      .returning()
      .execute();
    const userId = uid['per-team-bot']!;
    // The account default says "automated".
    await q.setReviewerOverride(1, userId, { automated: true, kind: 'in_house', label: 'Kimi' });
    // The platform team says "this is a human" (erxes' githubactions[bot] case in miniature).
    await q.setReviewerOverride(1, userId, { automated: false, teamId: team.id });

    expect(await q.automatedReviewerUserIds(1, NO_TEAM, 'all')).toContain(userId);
    expect(await q.automatedReviewerUserIds(1, team.id, 'all')).not.toContain(userId);
    // A team with no explicit row inherits the team-0 default — the whole point of the sentinel.
    expect(await q.automatedReviewerUserIds(1, otherTeam.id, 'all')).toContain(userId);

    // The listing reports which key each row resolved under, so the tab can label it.
    const teamList = await q.listDetectedReviewers(1, team.id);
    const teamRow = teamList.reviewers.find((r: any) => r.userId === userId);
    expect(teamList.teamId).toBe(team.id);
    expect(teamRow.teamId).toBe(team.id);
    expect(teamRow.inherited).toBe(false);
    const otherList = await q.listDetectedReviewers(1, otherTeam.id);
    const otherRow = otherList.reviewers.find((r: any) => r.userId === userId);
    expect(otherRow.teamId).toBe(NO_TEAM);
    expect(otherRow.inherited).toBe(true);

    // "Reset to default" drops the team row → the team inherits again.
    expect(await q.deleteReviewerOverride(1, userId, team.id)).toBe(true);
    expect(await q.automatedReviewerUserIds(1, team.id, 'all')).toContain(userId);
  });

  it('an absent `role` in an override leaves the stored role ALONE', async () => {
    const userId = uid['sonarqubecloud']!;
    // Mark it automated with an explicit quality_check role…
    await q.setReviewerOverride(1, userId, {
      automated: true,
      kind: 'in_house',
      role: 'quality_check',
    });
    // …then edit something else with NO role in the body (what "Not a bot"/an old client sends).
    const after = await q.setReviewerOverride(1, userId, { automated: true, label: 'Sonar' });
    expect(after.role).toBe('quality_check');
  });

  it('rejects a foreign / unknown teamId on the WRITE path (→ 404), and on delete', async () => {
    // Account 2 owns this team; account 1 must not be able to key a row to it. There is no FK on
    // team_id (0 isn't a team id), so the DATABASE would happily accept the write.
    const [foreign] = await db
      .insert(schema.teams)
      .values({ accountId: 2, name: 'acct2-team' })
      .returning()
      .execute();
    const userId = uid['per-team-bot']!;
    expect(await q.setReviewerOverride(1, userId, { automated: true, teamId: foreign.id })).toBeNull();
    expect(await q.setReviewerOverride(1, userId, { automated: true, teamId: 999_999 })).toBeNull();
    expect(await q.deleteReviewerOverride(1, userId, foreign.id)).toBe(false);
    // MUTATION-CHECK: the assertions above would pass vacuously if the write simply did nothing,
    // so prove no row was created under the foreign key.
    const leaked = (await db.select().from(schema.botReviewClassification).execute()).filter(
      (r: any) => r.teamId === foreign.id,
    );
    expect(leaked).toHaveLength(0);
    // …and prove the same call SUCCEEDS for a team account 1 does own (so the 404 is about
    // ownership, not about the parameter being ignored).
    const [own] = await db
      .insert(schema.teams)
      .values({ accountId: 1, name: 'owned' })
      .returning()
      .execute();
    expect(await q.setReviewerOverride(1, userId, { automated: true, teamId: own.id })).not.toBeNull();
  });

  // The Bots→Settings tab renders a team's INHERITED (team-0) answer with an "inherited" badge
  // and an Apply button that deliberately sends NO `role` ("absent means leave the stored role
  // alone"). That Apply is an INSERT at the team key, so the insert's role fallback — not the ON
  // CONFLICT set: — decides, and seeding it from the login alone silently reversed the user's
  // explicit classification. Both directions are pinned, because the login seed gets each one
  // wrong in the opposite way.
  it('editing an INHERITED quality check on a team tab does not promote it back to a review bot', async () => {
    // A login OUTSIDE the QUALITY_CHECK_BOTS seed — so defaultRoleFor() says 'review' and only
    // the inherited row carries the truth.
    const userId = await addUser('acme-lint-bot', { isBot: true, githubType: 'Bot' });
    const [team] = await db
      .insert(schema.teams)
      .values({ accountId: 1, name: 'inherit-qc' })
      .returning()
      .execute();

    // Account default: an in-house quality check.
    await q.setReviewerOverride(1, userId, {
      automated: true,
      kind: 'in_house',
      label: 'Acme Lint',
      role: 'quality_check',
    });
    // MUTATION-CHECK: the team must genuinely INHERIT quality_check first, or the assertion
    // after the Apply would pass without the fix ever mattering.
    expect((await q.reviewerRoleForUser(1, team.id)).get(userId)).toBe('quality_check');
    expect(await q.automatedReviewerUserIds(1, team.id, 'review')).not.toContain(userId);

    // Exactly what DetectedReviewersTable's Apply sends for an inherited row: no `role`.
    const after = await q.setReviewerOverride(1, userId, {
      automated: true,
      kind: 'in_house',
      label: 'Acme Lint v2',
      teamId: team.id,
    });
    expect(after.role).toBe('quality_check');
    expect((await q.reviewerRoleForUser(1, team.id)).get(userId)).toBe('quality_check');
    // …and it stays OUT of the team's ROI / behaviour / dedup / benchmark set.
    expect(await q.automatedReviewerUserIds(1, team.id, 'review')).not.toContain(userId);
    // The account default is untouched by the team-level edit.
    expect((await q.reviewerRoleForUser(1, NO_TEAM)).get(userId)).toBe('quality_check');
  });

  it('the MIRROR case: an inherited re-roled vendor is not demoted to quality_check', async () => {
    // A login INSIDE the seed, explicitly re-roled to 'review' at the account default. Here the
    // login seed says 'quality_check', so an unfixed insert drops it OUT of the team's metrics.
    const userId = await addUser('codecov', { isBot: true, githubType: 'Bot' });
    const [team] = await db
      .insert(schema.teams)
      .values({ accountId: 1, name: 'inherit-review' })
      .returning()
      .execute();

    await q.setReviewerOverride(1, userId, {
      automated: true,
      kind: 'in_house',
      label: 'Codecov',
      role: 'review',
    });
    expect((await q.reviewerRoleForUser(1, team.id)).get(userId)).toBe('review');
    expect(await q.automatedReviewerUserIds(1, team.id, 'review')).toContain(userId);

    const after = await q.setReviewerOverride(1, userId, {
      automated: true,
      kind: 'in_house',
      label: 'Codecov CI',
      teamId: team.id,
    });
    expect(after.role).toBe('review');
    expect((await q.reviewerRoleForUser(1, team.id)).get(userId)).toBe('review');
    expect(await q.automatedReviewerUserIds(1, team.id, 'review')).toContain(userId);
  });

  it('with NOTHING stored anywhere, a fresh team override still falls back to the login seed', async () => {
    // Guards the fix from over-reaching: the inherited lookup must not swallow the seed when
    // there is no team-0 row at all.
    const seeded = await addUser('coveralls', { isBot: true, githubType: 'Bot' });
    const plain = await addUser('acme-inhouse-bot', { isBot: true, githubType: 'Bot' });
    const [team] = await db
      .insert(schema.teams)
      .values({ accountId: 1, name: 'no-default' })
      .returning()
      .execute();
    const qc = await q.setReviewerOverride(1, seeded, {
      automated: true,
      kind: 'in_house',
      teamId: team.id,
    });
    expect(qc.role).toBe('quality_check');
    const rev = await q.setReviewerOverride(1, plain, {
      automated: true,
      kind: 'in_house',
      teamId: team.id,
    });
    expect(rev.role).toBe('review');
  });

  it('deleteTeam removes that team’s classification rows (no FK cascade exists)', async () => {
    const [team] = await db
      .insert(schema.teams)
      .values({ accountId: 1, name: 'doomed' })
      .returning()
      .execute();
    const userId = uid['per-team-bot']!;
    await q.setReviewerOverride(1, userId, { automated: false, teamId: team.id });
    const before = (await db.select().from(schema.botReviewClassification).execute()).filter(
      (r: any) => r.teamId === team.id,
    );
    expect(before).toHaveLength(1); // the check below would be vacuous without this

    expect(await q.deleteTeam(team.id, 1)).toBe(true);
    const after = (await db.select().from(schema.botReviewClassification).execute()).filter(
      (r: any) => r.teamId === team.id,
    );
    expect(after).toHaveLength(0);
  });
});
