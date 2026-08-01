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
// THE ROW IS THE BOT OBJECT, so every classifyReviewer call names the REPO ROWS its verdict
// should land on. There is no sentinel: `NO_TEAM_KEY` used to stand in here for "no team to
// give", which quietly also meant "the inheritance root every team reads". A repo id means one
// thing. Most tests below use a single scope repo; the fan-out across several is covered in
// db/bot-reviewer-grains.test.ts.
let SCOPE: number[] = [];

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
  await addUser('per-repo-bot', { isBot: true, githubType: 'Bot' }); // per-repo override subject

  // One repo for the resolution-order block to write its rows into. A judgement has to land
  // somewhere, and a row keyed to a repo that does not exist is rejected by the composite FK
  // `(repo_id, account_id) → repos(id, account_id)`.
  const [clsRepo] = await db
    .insert(schema.repos)
    .values({ accountId: 1, owner: 'acme', name: 'classify', githubNodeId: 'R_classify' })
    .returning()
    .execute();
  SCOPE = [clsRepo.id];
});

afterAll(() => closeDb?.());

describe('classifyReviewer resolution order', () => {
  it('2. known vendor login → vendor kind, high, vendor_login (+ persisted)', async () => {
    const c = await classifyReviewer(1, userArg('coderabbitai', { isBot: true }), {}, SCOPE);
    expect(c.automated).toBe(true);
    expect(c.kind).toBe('coderabbit');
    expect(c.confidence).toBe('high');
    expect(c.source).toBe('vendor_login');
    // Persisted at BOTH grains: the JUDGEMENT on the repo row, the IDENTITY on the actor row.
    // (Small test DB → a full scan is fine.)
    const judgement = (
      await db.select().from(schema.repoReviewers).execute()
    ).find((r: any) => r.authorUserId === uid['coderabbitai']! && r.accountId === 1);
    expect(judgement).toBeDefined();
    expect(judgement.source).toBe('vendor_login');
    expect(judgement.repoId).toBe(SCOPE[0]);
    const identity = (
      await db.select().from(schema.accountReviewers).execute()
    ).find((r: any) => r.authorUserId === uid['coderabbitai']! && r.accountId === 1);
    expect(identity).toBeDefined();
    expect(identity.kind).toBe('coderabbit');
    // The classifier wrote it, so the provenance stays 'auto' — it must keep self-healing.
    expect(identity.identitySource).toBe('auto');
  });

  it("3. githubType==='Bot' with no marker → in_house, high, github_type", async () => {
    const c = await classifyReviewer(
      1,
      userArg('claude-bot-type', { isBot: true, githubType: 'Bot' }),
      { fingerprint: { marked: false, tool: null, markers: [] } },
      SCOPE,
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
      SCOPE,
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
      SCOPE,
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
      SCOPE,
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
      SCOPE,
    );
    expect(c.automated).toBe(false);
    expect(c.kind).toBeNull();
    expect(c.confidence).toBe('high');
  });

  it('otherwise → human (weak): no evidence → automated:false, low', async () => {
    const c = await classifyReviewer(1, userArg('sam-rivers'), {}, SCOPE);
    expect(c.automated).toBe(false);
    expect(c.confidence).toBe('low');
  });
});

describe('a MANUAL row is never re-derived — per grain, per repo', () => {
  it('a manual "human" judgement survives a pass that would say "known vendor"', async () => {
    // qodo-ai is a KNOWN vendor login, so every classification pass wants to call it a bot. A
    // human said otherwise IN THIS REPO, and persist() must decline to write that row.
    //
    // NOTE WHAT IS NOT HERE ANY MORE: classifyReviewer used to short-circuit on a manual row and
    // return it verbatim. Under the repo grain the derivation always runs — it has to, because
    // the SAME actor's other repos must keep updating — and the decision to skip moved into the
    // write. So the RETURN value below is the derived verdict; the STORED row is what the manual
    // flag protects, and that is what this asserts.
    await db
      .insert(schema.repoReviewers)
      .values({
        accountId: 1,
        repoId: SCOPE[0]!,
        authorUserId: uid['qodo-ai']!,
        automated: false,
        role: 'review',
        confidence: 'high',
        source: 'manual',
        reasonsJson: ['user marked as human'],
        updatedAt: new Date(),
      })
      .execute();
    await classifyReviewer(1, userArg('qodo-ai', { isBot: true }), {}, SCOPE);
    const row = (await db.select().from(schema.repoReviewers).execute()).find(
      (r: any) => r.authorUserId === uid['qodo-ai']! && r.accountId === 1,
    );
    expect(row.source).toBe('manual');
    expect(row.automated).toBe(false);
  });

  it('a manual IDENTITY survives the same pass — and the judgement still re-derives', async () => {
    // The two flags live on two tables precisely so this pair is expressible. Gating identity on
    // the ROW's `source` would revert a human's vendor correction; gating the judgement on
    // `identity_source` would freeze auto-detection on every one of the actor's repos.
    await db
      .insert(schema.accountReviewers)
      .values({
        accountId: 1,
        authorUserId: uid['coderabbitai']!,
        kind: 'greptile',
        label: 'Actually Greptile',
        identitySource: 'manual',
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [schema.accountReviewers.accountId, schema.accountReviewers.authorUserId],
        set: { kind: 'greptile', label: 'Actually Greptile', identitySource: 'manual' },
      })
      .execute();
    await classifyReviewer(1, userArg('coderabbitai', { isBot: true }), {}, SCOPE);
    const identity = (await db.select().from(schema.accountReviewers).execute()).find(
      (r: any) => r.authorUserId === uid['coderabbitai']! && r.accountId === 1,
    );
    expect(identity.kind).toBe('greptile'); // the human's correction stands
    expect(identity.label).toBe('Actually Greptile');
    const judgement = (await db.select().from(schema.repoReviewers).execute()).find(
      (r: any) => r.authorUserId === uid['coderabbitai']! && r.accountId === 1,
    );
    expect(judgement.source).toBe('vendor_login'); // …and the repo row still re-derived
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
    const c = await classifyReviewer(1, userArg('robo-reviewer'), { behavioral: sig }, SCOPE);
    expect(c.automated).toBe(true);
    expect(c.confidence).toBe('medium');
    expect(c.source).toBe('behavioral');
  });
});

// ── The quality-check ROLE, at the repo grain (migrations 0042/0043) ────────────────────────
// The role is a per-(repo, actor) flag, so these cover the three things most likely to break: the
// upsert's conflict target (now the 3-column `repo_reviewers_account_repo_author`), the role seed
// surviving a re-sync, and the role narrowing the METRIC set without touching the exclusion set.
//
// The per-repo divergence / identity-constancy cases live in db/bot-reviewer-grains.test.ts; this
// file stays focused on the classifier itself.
describe('quality-check role', () => {
  let q: any;
  beforeAll(async () => {
    q = await import('../db/queries.js');
    // The listing only surfaces actors seen in THIS account's synced data, and a judgement write
    // needs a real footprint, so the subject needs a real review or the assertions below pass
    // vacuously on `undefined`.
    const [pr] = await db
      .insert(schema.pullRequests)
      .values({
        githubNodeId: 'PR_role_1',
        accountId: 1,
        repoId: SCOPE[0]!,
        number: 991,
        title: 'role',
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
        githubNodeId: 'RV_role_1',
        prId: pr.id,
        authorId: uid['per-repo-bot']!,
        state: 'commented',
        submittedAt: new Date(Date.now() - DAY),
      })
      .execute();
    await db
      .insert(schema.reviews)
      .values({
        githubNodeId: 'RV_role_2',
        prId: pr.id,
        authorId: uid['sonarqubecloud']!,
        state: 'commented',
        submittedAt: new Date(Date.now() - DAY),
      })
      .execute();
  });

  it('the ON CONFLICT target matches the 3-column unique index (upsert, not duplicate)', async () => {
    // Classifying the SAME reviewer twice over the SAME repo must UPDATE, not insert a second row
    // — and must not raise "no unique or exclusion constraint matching the ON CONFLICT
    // specification", which is what a stale target produces at RUNTIME (it type-checks fine).
    await classifyReviewer(1, userArg('sonarqubecloud', { isBot: true, githubType: 'Bot' }), {}, SCOPE);
    await classifyReviewer(1, userArg('sonarqubecloud', { isBot: true, githubType: 'Bot' }), {}, SCOPE);
    const rows = (await db.select().from(schema.repoReviewers).execute()).filter(
      (r: any) => r.accountId === 1 && r.authorUserId === uid['sonarqubecloud']!,
    );
    expect(rows).toHaveLength(1);
    // …and the identity upsert likewise (2-column target on `account_reviewers`).
    const idRows = (await db.select().from(schema.accountReviewers).execute()).filter(
      (r: any) => r.accountId === 1 && r.authorUserId === uid['sonarqubecloud']!,
    );
    expect(idRows).toHaveLength(1);
  });

  it('seeds a known quality-check login with role=quality_check, still automated', async () => {
    const c = await classifyReviewer(
      1,
      userArg('sonarqubecloud', { isBot: true, githubType: 'Bot' }),
      {},
      SCOPE,
    );
    // automated STAYS true — excludeBots / the feed bot lens / the per-row vendor tag all keep
    // working. Only the METRIC sets narrow by role.
    expect(c.automated).toBe(true);
    expect(c.role).toBe('quality_check');
  });

  it('the role SURVIVES a re-classification pass (the seed is not erased)', async () => {
    // The regression this guards: persist() shares ONE values object between the insert and the
    // ON CONFLICT set:, so a role copied off the in-memory classification would be rewritten from
    // a stale default on the next sync — putting SonarQube back into the review-bot metrics.
    await classifyReviewer(1, userArg('sonarqubecloud', { isBot: true, githubType: 'Bot' }), {}, SCOPE);
    const [row] = (await db.select().from(schema.repoReviewers).execute()).filter(
      (r: any) => r.accountId === 1 && r.authorUserId === uid['sonarqubecloud']!,
    );
    expect(row.role).toBe('quality_check');
  });

  it('a quality_check reviewer is EXCLUDED from the metric set but present in the full set', async () => {
    const reviewOnly = await q.automatedReviewerUserIds(1, SCOPE, 'review');
    const all = await q.automatedReviewerUserIds(1, SCOPE, 'all');
    expect(all).toContain(uid['sonarqubecloud']!);
    expect(reviewOnly).not.toContain(uid['sonarqubecloud']!);
    // …and a real review bot is in BOTH (the role filter is not a blanket narrowing).
    expect(all).toContain(uid['coderabbitai']!);
    expect(reviewOnly).toContain(uid['coderabbitai']!);
  });

  it('reviewerRoleForUser reports the role folded over the requested repos', async () => {
    expect((await q.reviewerRoleForUser(1, SCOPE)).get(uid['sonarqubecloud']!)).toBe(
      'quality_check',
    );
    expect((await q.reviewerRoleForUser(1, SCOPE)).get(uid['coderabbitai']!)).toBe('review');
  });

  it('a manual role edit in one repo pins that row and nothing else', async () => {
    const userId = uid['per-repo-bot']!;
    await classifyReviewer(1, userArg('per-repo-bot', { isBot: true, githubType: 'Bot' }), {}, SCOPE);
    expect(await q.automatedReviewerUserIds(1, SCOPE, 'review')).toContain(userId);
    const patched = await q.setRepoReviewerJudgement(1, userId, {
      repoId: SCOPE[0]!,
      role: 'quality_check',
    });
    expect(patched?.role).toBe('quality_check');
    // The role narrows the reviewer cohort …
    expect(await q.automatedReviewerUserIds(1, SCOPE, 'review')).not.toContain(userId);
    // … but never the exclusion set: a linter's threads still have to be visible and triageable.
    expect(await q.automatedReviewerUserIds(1, SCOPE, 'all')).toContain(userId);
    // …and it survives the next classification pass, because the row is now a human judgement.
    await classifyReviewer(1, userArg('per-repo-bot', { isBot: true, githubType: 'Bot' }), {}, SCOPE);
    const [row] = (await db.select().from(schema.repoReviewers).execute()).filter(
      (r: any) => r.accountId === 1 && r.authorUserId === userId,
    );
    expect(row.role).toBe('quality_check');
    expect(row.source).toBe('manual');
  });
});
