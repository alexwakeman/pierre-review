// db/automation-output.ts — the authoring-automation vector, on a THROWAWAY sqlite DB.
//
// THE CONTRACTS THIS FILE EXISTS FOR:
//  • THE MIRRORED KEY LIST MATCHES SHARED (shared is types-only and never shipped, so the
//    backend inlines it — the same drift rule the person and period vectors carry).
//  • THE MIRROR-IMAGE LANE RULE: a HUMAN returns null here, exactly as an automation returns
//    null from the person fold. Neither is a login test.
//  • THE WINDOW IS HALF-OPEN `[from, to)`: merged at exactly `from` is IN, at exactly `to` is OUT.
//  • A MERGE IS NOT CHURN: `prs_closed_unmerged` must key on `mergedAt IS NULL`, not on a bare
//    `closedAt` window — GitHub stamps closedAt on a merge too, so the naive predicate counts
//    every merged PR twice, once as a success and once as waste.
//  • MERGE RATE IS OVER THE RESOLVED POPULATION, never over `opened` — a PR opened on the last
//    day of the window has not had its chance yet.
//  • `prs_merged_without_human_review` LOOKS AT ALL TIME, deliberately: the population is PRs
//    merged in-window, and a review of a merged PR predates its merge, so the answer cannot move.
//    Windowing the review probe would report a March-reviewed, April-merged PR as unreviewed.
//  • A BOT REVIEWING A BOT IS NOT HUMAN ATTENTION — the human filter runs through the lane
//    resolver, so `human_review_comments_received` ignores another automation's comments.
//  • THE GLOBAL-users RULE: an automation with no authored PR in this workspace returns null
//    (unknown/foreign ids included — no existence oracle), and only login + display name leave.
//  • EVIDENCE IS ADDITIVE: requesting it never changes a metric cell, and each group is the
//    counting predicate's own rows.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUTOMATION_METRIC_KEYS as SHARED_KEYS } from '@pierre-review/shared';

const DB_PATH = '/tmp/pierre-automation-output-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => void) | undefined;
let ao: any;
let scope: any;
let alice = 0; // human
let dependabot = 0; // the subject — an authoring automation
let coderabbit = 0; // a REVIEWING automation, used to prove bot comments are not human attention
let repoA = 0;
let repoB = 0;

const HOUR = 3_600_000;
const DAY = 86_400_000;
const FROM = Date.UTC(2026, 6, 1);
const TO = Date.UTC(2026, 6, 15);
const WIN = { fromMs: FROM, toMs: TO };

const prIdOf = new Map<string, number>();

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('./run-migrations.js');
  const client = await import('./client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  const q = await import('./queries.js');
  ao = await import('./automation-output.js');
  await runMigrations();

  const { repos, pullRequests, users, reviews, reviewComments, reviewThreads } = schema;

  const mkRepo = async (name: string, node: string) =>
    (
      await db
        .insert(repos)
        .values({
          accountId: 1,
          owner: 'acme',
          name,
          githubNodeId: node,
          createdAt: new Date(FROM - 30 * DAY),
        })
        .returning()
        .execute()
    )[0].id;
  repoA = await mkRepo('alpha', 'R_ao_a');
  repoB = await mkRepo('beta', 'R_ao_b');

  const mkUser = async (login: string, node: string, isBot: boolean, name: string | null = null) =>
    (
      await db
        .insert(users)
        .values({ githubLogin: login, githubNodeId: node, isBot, displayName: name })
        .returning()
        .execute()
    )[0].id;
  alice = await mkUser('alice', 'U_ao_alice', false, 'Alice A');
  dependabot = await mkUser('dependabot[bot]', 'U_ao_dep', true, 'Dependabot');
  coderabbit = await mkUser('coderabbitai', 'U_ao_cr', true);

  interface PrSpec {
    key: string;
    author: number;
    repo: number;
    openedMs: number;
    mergedMs?: number;
    closedMs?: number;
    additions?: number;
    deletions?: number;
  }
  const PRS: PrSpec[] = [
    // ── The subject's merged PRs ────────────────────────────────────────────────────────────
    // Exactly at `from` → IN. Open 10h. 10 lines.
    { key: 'at_from', author: dependabot, repo: repoA, openedMs: FROM - 10 * HOUR, mergedMs: FROM, additions: 8, deletions: 2 },
    // Mid-window. Open 24h. 30 lines. This is the one a HUMAN comments on.
    { key: 'mid', author: dependabot, repo: repoA, openedMs: FROM + 2 * DAY, mergedMs: FROM + 3 * DAY, additions: 20, deletions: 10 },
    // Mid-window, other repo. Open 48h. 100 lines. Only a BOT comments on this one.
    { key: 'botseen', author: dependabot, repo: repoB, openedMs: FROM + 4 * DAY, mergedMs: FROM + 6 * DAY, additions: 60, deletions: 40 },
    // Exactly at `to` → OUT of every merged figure.
    { key: 'at_to', author: dependabot, repo: repoA, openedMs: FROM + 9 * DAY, mergedMs: TO, additions: 5, deletions: 5 },
    // ── Closed WITHOUT merging, in-window → churn ───────────────────────────────────────────
    { key: 'abandoned', author: dependabot, repo: repoA, openedMs: FROM + 5 * DAY, closedMs: FROM + 7 * DAY, additions: 3, deletions: 1 },
    // ── Still open, opened in-window → counts toward opened only ────────────────────────────
    { key: 'still_open', author: dependabot, repo: repoA, openedMs: FROM + 8 * DAY, additions: 4, deletions: 0 },
    // ── Opened BEFORE the window and merged after it → in neither count ─────────────────────
    { key: 'outside', author: dependabot, repo: repoA, openedMs: FROM - 5 * DAY, mergedMs: TO + 2 * DAY, additions: 1, deletions: 1 },
    // ── A HUMAN's PR, so the fold must not pick it up ───────────────────────────────────────
    { key: 'alice_pr', author: alice, repo: repoA, openedMs: FROM + 1 * DAY, mergedMs: FROM + 2 * DAY, additions: 100, deletions: 5 },
  ];
  for (const [i, s] of PRS.entries()) {
    const state = s.mergedMs != null ? 'merged' : s.closedMs != null ? 'closed' : 'open';
    const [pr] = await db
      .insert(pullRequests)
      .values({
        githubNodeId: `PR_ao_${s.key}`,
        accountId: 1,
        repoId: s.repo,
        number: i + 1,
        title: `fixture ${s.key}`,
        state,
        isDraft: false,
        authorId: s.author,
        openedAt: new Date(s.openedMs),
        updatedAt: new Date(s.mergedMs ?? s.closedMs ?? s.openedMs),
        mergedAt: s.mergedMs == null ? null : new Date(s.mergedMs),
        // ⚠ A MERGE ALSO STAMPS closedAt — this is exactly the shape that makes a bare
        // `closedAt`-window predicate count every merged PR as abandoned churn.
        closedAt:
          s.mergedMs != null
            ? new Date(s.mergedMs)
            : s.closedMs == null
              ? null
              : new Date(s.closedMs),
        additions: s.additions ?? 0,
        deletions: s.deletions ?? 0,
      })
      .returning()
      .execute();
    prIdOf.set(s.key, pr.id);
  }

  // A thread is needed so review comments have somewhere to hang.
  const mkThread = async (key: string, pr: string) =>
    (
      await db
        .insert(reviewThreads)
        .values({
          githubNodeId: `RT_ao_${key}`,
          prId: prIdOf.get(pr),
          path: 'package.json',
          isResolved: false,
          derivedState: 'untouched',
          createdAt: new Date(FROM),
        })
        .returning()
        .execute()
    )[0].id;
  const tMid = await mkThread('mid', 'mid');
  const tBot = await mkThread('botseen', 'botseen');

  const mkComment = async (key: string, pr: string, threadId: number, by: number, atMs: number) =>
    db
      .insert(reviewComments)
      .values({
        githubNodeId: `RC_ao_${key}`,
        prId: prIdOf.get(pr),
        threadId,
        authorId: by,
        body: 'a comment',
        createdAt: new Date(atMs),
      })
      .execute();
  // A HUMAN on 'mid' — the one PR that cost people time, and the only human review comment.
  await mkComment('human_mid', 'mid', tMid, alice, FROM + 2 * DAY + 6 * HOUR);
  // ANOTHER AUTOMATION on 'botseen' — must NOT read as human attention, and must NOT stop
  // 'botseen' counting as merged-without-human-review.
  await mkComment('bot_botseen', 'botseen', tBot, coderabbit, FROM + 4 * DAY + 2 * HOUR);

  // A human REVIEW (not a comment) on 'at_from' — the other half of the human-touched test.
  await db
    .insert(reviews)
    .values({
      githubNodeId: 'RV_ao_human_atfrom',
      prId: prIdOf.get('at_from'),
      authorId: alice,
      state: 'approved',
      body: 'lgtm',
      submittedAt: new Date(FROM - 2 * HOUR),
    })
    .execute();

  scope = await q.resolveWorkspaceScope(1, undefined, null);
});

afterAll(() => {
  closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

const metric = (o: any, key: string) => o.metrics.find((m: any) => m.key === key);

describe('the shared mirror', () => {
  it('matches the shared key list exactly', () => {
    expect(ao.AUTOMATION_METRIC_KEYS).toEqual(SHARED_KEYS);
  });
});

describe('admission', () => {
  it('refuses a HUMAN — the mirror image of the person fold refusing a bot', async () => {
    expect(await ao.getAutomationOutput(1, scope, alice, WIN)).toBeNull();
  });

  it('refuses an automation with no authored PR here, and an unknown id, identically', async () => {
    // coderabbit reviews but never authors — it is getBotAnalytics' subject, not this fold's.
    expect(await ao.getAutomationOutput(1, scope, coderabbit, WIN)).toBeNull();
    expect(await ao.getAutomationOutput(1, scope, 999_999, WIN)).toBeNull();
  });

  it('returns login + display name only', async () => {
    const o = await ao.getAutomationOutput(1, scope, dependabot, WIN);
    expect(o.login).toBe('dependabot[bot]');
    expect(o.displayName).toBe('Dependabot');
    expect(Object.keys(o)).toEqual(
      expect.arrayContaining(['userId', 'login', 'displayName', 'role', 'repos', 'metrics']),
    );
    expect(o).not.toHaveProperty('avatarUrl');
    expect(o).not.toHaveProperty('email');
  });

  it('an empty workspace admits nobody', async () => {
    expect(
      await ao.getAutomationOutput(1, { workspaceId: scope.workspaceId, repoIds: [] }, dependabot, WIN),
    ).toBeNull();
  });
});

describe('the windowed counts', () => {
  it('is half-open — merged at `from` counts, merged at `to` does not', async () => {
    const o = await ao.getAutomationOutput(1, scope, dependabot, WIN);
    // at_from, mid, botseen — NOT at_to, NOT outside.
    expect(metric(o, 'prs_merged').value).toBe(3);
  });

  it('counts opened inside the window only', async () => {
    const o = await ao.getAutomationOutput(1, scope, dependabot, WIN);
    // mid, botseen, abandoned, still_open — not at_from (opened before), not outside, not at_to?
    // at_to opened FROM+9d, which IS in-window, so: mid, botseen, abandoned, still_open, at_to = 5.
    expect(metric(o, 'prs_opened').value).toBe(5);
  });

  // The defect this test exists for: `closedAt` is stamped on merges too.
  it('counts ONLY unmerged closes as churn — a merge is not abandonment', async () => {
    const o = await ao.getAutomationOutput(1, scope, dependabot, WIN);
    expect(metric(o, 'prs_closed_unmerged').value).toBe(1); // 'abandoned' alone
  });

  it('rates merges over the RESOLVED population, not over opened', async () => {
    const o = await ao.getAutomationOutput(1, scope, dependabot, WIN);
    // 3 merged, 1 closed-unmerged → 75%. Over `opened` (5) it would read 60%.
    expect(metric(o, 'merge_rate_pct').value).toBe(75);
    expect(metric(o, 'merge_rate_pct').sampleSize).toBe(4);
  });

  it('medians only the merged-in-window population', async () => {
    const o = await ao.getAutomationOutput(1, scope, dependabot, WIN);
    // open→merged: at_from 10h, mid 24h, botseen 48h → median 24h.
    expect(metric(o, 'median_hours_to_merge').value).toBe(24);
    // sizes: 10, 30, 100 → median 30.
    expect(metric(o, 'median_pr_size_lines').value).toBe(30);
    expect(metric(o, 'median_pr_size_lines').sampleSize).toBe(3);
  });

  it('counts repos it opened or merged in, and ignores a human author entirely', async () => {
    const o = await ao.getAutomationOutput(1, scope, dependabot, WIN);
    expect(metric(o, 'repos_touched').value).toBe(2);
    expect(o.repos.map((r: any) => r.repoFullName).sort()).toEqual(['acme/alpha', 'acme/beta']);
    // alice's 100-line PR must not have moved the median size or any count.
    expect(metric(o, 'prs_merged').value).toBe(3);
  });
});

describe('the human-attention figures', () => {
  it('counts human review comments and IGNORES another automation\'s', async () => {
    const o = await ao.getAutomationOutput(1, scope, dependabot, WIN);
    // alice on 'mid' counts; coderabbit on 'botseen' does not.
    expect(metric(o, 'human_review_comments_received').value).toBe(1);
  });

  it('treats a bot-only PR as merged WITHOUT human review', async () => {
    const o = await ao.getAutomationOutput(1, scope, dependabot, WIN);
    // Of the 3 merged: at_from has a human REVIEW, mid has a human COMMENT, botseen has only a
    // bot comment → exactly one untouched by people.
    expect(metric(o, 'prs_merged_without_human_review').value).toBe(1);
    expect(metric(o, 'prs_merged_without_human_review').sampleSize).toBe(3);
  });

  // The all-time probe is the point: alice's review on 'at_from' sits BEFORE the window opens.
  it('honours a human review that predates the window on a PR merged inside it', async () => {
    const o = await ao.getAutomationOutput(1, scope, dependabot, WIN);
    const ev = (await ao.getAutomationOutput(1, scope, dependabot, WIN, { evidence: true })).evidence;
    // If the review probe were windowed, 'at_from' would join botseen and this would read 2.
    expect(metric(o, 'prs_merged_without_human_review').value).toBe(1);
    // and 'at_from' is in the merged evidence either way.
    expect(ev.merged.some((p: any) => p.title.endsWith('at_from'))).toBe(true);
  });
});

describe('evidence', () => {
  it('is absent unless asked for, and never changes a metric cell', async () => {
    const bare = await ao.getAutomationOutput(1, scope, dependabot, WIN);
    const withEv = await ao.getAutomationOutput(1, scope, dependabot, WIN, { evidence: true });
    expect(bare.evidence).toBeUndefined();
    expect(withEv.evidence).toBeDefined();
    expect(withEv.metrics).toEqual(bare.metrics);
  });

  it('each group is its own metric\'s population', async () => {
    const o = await ao.getAutomationOutput(1, scope, dependabot, WIN, { evidence: true });
    const ev = o.evidence;
    expect(ev.merged).toHaveLength(3);
    expect(ev.mergedMore).toBe(0);
    expect(ev.closedUnmerged).toHaveLength(1);
    expect(ev.closedUnmerged[0].title).toContain('abandoned');
    // Only the PR a HUMAN commented on.
    expect(ev.humanReviewed).toHaveLength(1);
    expect(ev.humanReviewed[0].title).toContain('mid');
  });
});
