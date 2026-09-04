// db/repo-activity.ts — "where is the work happening?", on a THROWAWAY sqlite DB.
//
// Four things this getter can get wrong without anything erroring, each pinned below:
//
//  • THE WINDOW BOUNDARY. `[fromMs, toMs)` — a PR opened at exactly `fromMs` is in, one opened at
//    exactly `toMs` is not. A `lte` upper bound puts one PR in two consecutive reads of a rolling
//    window, which nothing on screen would reveal.
//  • UNKNOWN SIZE READ AS ZERO SIZE. `additions`/`deletions`/`changedFiles` are NOT NULL DEFAULT 0,
//    so a PR whose detail never hydrated is byte-identical to one that changed nothing. Summing the
//    fabricated zero is invisible; a repository whose every PR is unsized must report `null`, not 0.
//  • THE AUTOMATION SET. It is `resolveActorLanes`' UNION — the workspace verdict ∪ `users.isBot` ∪
//    the login vocabularies — never `automatedReviewerUserIds` alone. Both non-workspace arms are
//    seeded below, because real accounts carry the same actor as two rows with CONFLICTING flags
//    (`dependabot` beside `dependabot[bot]`, one of each pair sitting at `automated: 0` on the
//    measured account) and either signal read alone puts one of them in the human series.
//  • THE CAP. Top-N by PRs opened, and what it cut must be COUNTED, never silently dropped.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DB_PATH = '/tmp/pierre-repo-activity-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => void) | undefined;
let ra: any;

const DAY = 86_400_000;
const HOUR = 3_600_000;
// `nowMs` is a parameter, so every boundary below is absolute rather than clock-relative.
// Second-aligned by construction: sqlite stores `mode: 'timestamp'` as epoch SECONDS.
const NOW = Date.UTC(2026, 7, 1); // 2026-08-01T00:00:00Z
const FROM = NOW - 14 * DAY; // 2026-07-18T00:00:00Z

let mainScope: { workspaceId: number; repoIds: number[] };
let wideScope: { workspaceId: number; repoIds: number[] };
let alpha = 0;
let beta = 0;
let gamma = 0;
let zeta = 0;
let epsilon = 0;
let foreign = 0;
let alice = 0;
let botFlagOnly = 0;
let botVocabOnly = 0;
let prSeq = 0;

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const client = await import('./client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  const { runMigrations } = await import('./run-migrations.js');
  await runMigrations();
  ra = await import('./repo-activity.js');

  const { repos, pullRequests, users, workspaces, workspaceRepos } = schema;

  const mkRepo = async (name: string, createdMs: number, accountId = 1): Promise<number> =>
    (
      await db
        .insert(repos)
        .values({
          accountId,
          owner: 'acme',
          name,
          githubNodeId: `R_ra_${name}`,
          createdAt: new Date(createdMs),
        })
        .returning()
        .execute()
    )[0].id;

  alpha = await mkRepo('alpha', FROM - 100 * DAY);
  beta = await mkRepo('beta', FROM - 100 * DAY);
  // Added DURING the window — the coverage-bias marker's whole reason for existing.
  gamma = await mkRepo('gamma', FROM + 3 * DAY);
  zeta = await mkRepo('zeta', FROM - 100 * DAY);
  // In the workspace, but saw nothing in the window: counted in `workspaceRepos`, absent from rows.
  epsilon = await mkRepo('epsilon', FROM - 100 * DAY);
  // ANOTHER ACCOUNT's repo. Handed to the getter inside the scope on purpose — that is the IDOR
  // probe: `resolveWorkspaceScope` would never produce it, so the getter's own ownership predicate
  // is the thing under test.
  foreign = await mkRepo('theirs', FROM - 100 * DAY, 2);

  const mkUser = async (login: string, isBot: boolean): Promise<number> =>
    (
      await db
        .insert(users)
        .values({ githubLogin: login, githubNodeId: `U_ra_${login}`, isBot })
        .returning()
        .execute()
    )[0].id;
  alice = await mkUser('alice', false);
  // ⚠ THE TWO NON-WORKSPACE ARMS OF THE UNION, one user each. Neither has a `workspace_reviewers`
  // row, so `automatedReviewerUserIds` on its own answers with the vendor-login seed alone:
  //   • an UNRECOGNISED login carrying the global `users.isBot` flag — an in-house CI account
  //     nobody has opened the Bots tab for, invisible to the vendor seed;
  //   • a KNOWN vendor login whose `isBot` is still false, which is the state a row sits in
  //     between joining the vocabulary and its next sync.
  // Reading either signal alone drops one of these two bars into the human series.
  botFlagOnly = await mkUser('ci-runner-9000', true);
  botVocabOnly = await mkUser('coderabbitai', false);

  // A second, non-default workspace (the partial unique index allows exactly one default).
  const mkWorkspace = async (name: string): Promise<number> =>
    (
      await db
        .insert(workspaces)
        .values({ accountId: 1, name, isDefault: false })
        .returning()
        .execute()
    )[0].id;
  const mainWs = await mkWorkspace('Main');
  for (const r of [alpha, beta, gamma, zeta, epsilon]) {
    await db.insert(workspaceRepos).values({ accountId: 1, workspaceId: mainWs, repoId: r }).execute();
  }
  mainScope = { workspaceId: mainWs, repoIds: [alpha, beta, gamma, zeta, epsilon] };

  const mkPr = async (
    repoId: number,
    authorId: number,
    openedMs: number,
    size: { additions: number; deletions: number; changedFiles: number },
    accountId = 1,
  ): Promise<void> => {
    prSeq += 1;
    await db
      .insert(pullRequests)
      .values({
        githubNodeId: `PR_ra_${prSeq}`,
        accountId,
        repoId,
        number: prSeq,
        title: `fixture ${prSeq}`,
        state: 'open',
        isDraft: false,
        authorId,
        openedAt: new Date(openedMs),
        updatedAt: new Date(openedMs),
        ...size,
      })
      .execute();
  };
  const SIZED = (a: number, d: number) => ({ additions: a, deletions: d, changedFiles: 1 });
  // A never-observed size: all three columns 0, which is the SAME row as "changed nothing".
  const UNSIZED = { additions: 0, deletions: 0, changedFiles: 0 };

  // alpha — 1 human + 1 automation (the global-flag arm); one sized (15 lines), one unsized.
  await mkPr(alpha, alice, FROM, SIZED(10, 5)); // EXACTLY the inclusive lower bound
  await mkPr(alpha, botFlagOnly, NOW - HOUR, UNSIZED);
  await mkPr(alpha, alice, FROM - 1000, SIZED(999, 999)); // 1s BEFORE the window — excluded
  await mkPr(alpha, alice, NOW, SIZED(888, 888)); // EXACTLY `toMs` — excluded (half-open)

  // beta — 3 human PRs, 300 lines. The volume leader.
  for (let i = 0; i < 3; i++) await mkPr(beta, alice, FROM + (i + 1) * DAY, SIZED(100, 0));

  // gamma — one human PR, never sized. Added mid-window.
  await mkPr(gamma, alice, FROM + 5 * DAY, UNSIZED);

  // zeta — 1 human + 1 automation (the vendor-login arm). Ties alpha on volume; the tie breaks
  // on the name.
  await mkPr(zeta, alice, FROM + 5 * DAY, SIZED(7, 0));
  await mkPr(zeta, botVocabOnly, FROM + 6 * DAY, SIZED(3, 0));

  // The other account's PR, in the other account's repo. Must never surface.
  await mkPr(foreign, alice, FROM + 2 * DAY, SIZED(99_999, 0), 2);

  // ── The cap fixture: its own workspace, 14 active repos with descending volumes ──
  const wideWs = await mkWorkspace('Wide');
  const wideIds: number[] = [];
  for (let i = 0; i < 14; i++) {
    // w00 gets 15 PRs, w13 gets 2 — strictly descending, so the cap's cut is unambiguous.
    const id = await mkRepo(`w${String(i).padStart(2, '0')}`, FROM - 100 * DAY);
    wideIds.push(id);
    await db.insert(workspaceRepos).values({ accountId: 1, workspaceId: wideWs, repoId: id }).execute();
    for (let n = 0; n < 15 - i; n++) await mkPr(id, alice, FROM + DAY, SIZED(10, 0));
  }
  wideScope = { workspaceId: wideWs, repoIds: wideIds };
});

afterAll(() => closeDb?.());

describe('getWorkspaceRepoActivity', () => {
  it('is window-pure on a HALF-OPEN [from, to) boundary', async () => {
    const out = await ra.getWorkspaceRepoActivity(1, mainScope, NOW);
    const a = out.repos.find((r: any) => r.repoFullName === 'acme/alpha');
    // The PR at exactly `fromMs` is IN; the one 1s earlier and the one at exactly `toMs` are OUT.
    // Both excluded PRs carry huge line counts, so a leak moves `linesChanged` by three orders of
    // magnitude rather than hiding in a rounding.
    expect(a.prsOpenedHuman + a.prsOpenedAutomation).toBe(2);
    expect(a.linesChanged).toBe(15);
    expect(out.from).toBe(new Date(FROM).toISOString());
    expect(out.to).toBe(new Date(NOW).toISOString());
    expect(out.windowDays).toBe(14);
  });

  it('splits human vs automation on the LANE UNION, not users.isBot alone', async () => {
    const out = await ra.getWorkspaceRepoActivity(1, mainScope, NOW);
    const a = out.repos.find((r: any) => r.repoFullName === 'acme/alpha');
    // `ci-runner-9000` is in no vocabulary and has no workspace_reviewers row: only `users.isBot`
    // knows. `automatedReviewerUserIds` alone scores this bar 2 human / 0 automation.
    expect(a.prsOpenedHuman).toBe(1);
    expect(a.prsOpenedAutomation).toBe(1);
    const z = out.repos.find((r: any) => r.repoFullName === 'acme/zeta');
    // `coderabbitai` carries `isBot: false`; the vendor-login seed is what catches it. Reading the
    // global flag alone scores THIS bar 2 human / 0 automation instead.
    expect(z.prsOpenedHuman).toBe(1);
    expect(z.prsOpenedAutomation).toBe(1);
  });

  it('reports an unsized PR as unknown, NEVER as zero lines', async () => {
    const out = await ra.getWorkspaceRepoActivity(1, mainScope, NOW);
    const a = out.repos.find((r: any) => r.repoFullName === 'acme/alpha');
    // Mixed: one sized, one not. The line total covers only the sized one, and the shortfall is
    // COUNTED so the two charts' different populations can be stated on screen.
    expect(a.sizedPrs).toBe(1);
    expect(a.unsizedPrs).toBe(1);
    expect(a.linesChanged).toBe(15);

    const g = out.repos.find((r: any) => r.repoFullName === 'acme/gamma');
    // EVERY PR unsized → null. A fabricated 0 here would draw an identical (absent) bar while
    // asserting the repository changed nothing.
    expect(g.sizedPrs).toBe(0);
    expect(g.unsizedPrs).toBe(1);
    expect(g.linesChanged).toBeNull();
  });

  it('marks a repo added part-way through the window, and does not pro-rate it', async () => {
    const out = await ra.getWorkspaceRepoActivity(1, mainScope, NOW);
    const g = out.repos.find((r: any) => r.repoFullName === 'acme/gamma');
    expect(g.addedDuringWindow).toBe(true);
    // One PR observed, one PR reported — no scaling up to a notional full fortnight.
    expect(g.prsOpenedHuman).toBe(1);
    for (const name of ['acme/alpha', 'acme/beta', 'acme/zeta']) {
      expect(out.repos.find((r: any) => r.repoFullName === name).addedDuringWindow).toBe(false);
    }
  });

  it('orders by total PRs opened, breaking ties on the repo name', async () => {
    const out = await ra.getWorkspaceRepoActivity(1, mainScope, NOW);
    // beta 3 · alpha 2 · zeta 2 · gamma 1 — alpha before zeta alphabetically at the tie. A
    // Map-iteration or heap order would be stable on sqlite and flip on Postgres after any UPDATE.
    expect(out.repos.map((r: any) => r.repoFullName)).toEqual([
      'acme/beta',
      'acme/alpha',
      'acme/zeta',
      'acme/gamma',
    ]);
  });

  it('counts a silent repo in the membership but draws no band for it', async () => {
    const out = await ra.getWorkspaceRepoActivity(1, mainScope, NOW);
    expect(out.repos.some((r: any) => r.repoFullName === 'acme/epsilon')).toBe(false);
    expect(out.activeRepos).toBe(4);
    expect(out.workspaceRepos).toBe(5);
    expect(out.omitted).toEqual({ repos: 0, prsOpened: 0, linesChanged: null });
  });

  it('caps at REPO_ACTIVITY_MAX_REPOS and STATES what the cap cut', async () => {
    const out = await ra.getWorkspaceRepoActivity(1, wideScope, NOW);
    expect(ra.REPO_ACTIVITY_MAX_REPOS).toBe(12);
    expect(out.repos).toHaveLength(12);
    expect(out.activeRepos).toBe(14);
    // The two cut repos hold 3 + 2 = 5 PRs at 10 lines each. A silent truncation would report
    // nothing here — and the lines chart is ranked by the PR count, so a repo can lead on lines
    // and still be below the fold.
    expect(out.omitted.repos).toBe(2);
    expect(out.omitted.prsOpened).toBe(5);
    expect(out.omitted.linesChanged).toBe(50);
  });

  it('never crosses an account boundary, even when handed a foreign repo id', async () => {
    const probe = { workspaceId: mainScope.workspaceId, repoIds: [alpha, foreign] };
    const out = await ra.getWorkspaceRepoActivity(1, probe, NOW);
    expect(out.repos.map((r: any) => r.repoFullName)).toEqual(['acme/alpha']);
    expect(out.workspaceRepos).toBe(1);
    // …and from the other side: account 2 asking for account 1's repos gets nothing.
    expect(await ra.getWorkspaceRepoActivity(2, { workspaceId: mainScope.workspaceId, repoIds: [alpha, beta] }, NOW)).toBeNull();
  });

  it('returns null for an empty scope rather than widening to the account', async () => {
    // ⚠ `[]` IS A LEGAL STATE (a workspace with no repos) and it means EMPTY, never "every repo".
    expect(await ra.getWorkspaceRepoActivity(1, { workspaceId: mainScope.workspaceId, repoIds: [] }, NOW)).toBeNull();
  });
});
