// THE DEPENDENCIES TAB on the Pending board, on a THROWAWAY sqlite DB (the pending-card-source.test.ts
// pattern).
//
// WHAT THIS PINS — every assertion is PRODUCTIVE: each exclusion has a CONTROL beside it (a person's
// PR of the same shape that DOES get the home card), so an assertion of absence cannot pass because
// the fixture produced nothing.
//
//   1. ⚠ A DEPENDENCY-AUTOMATION PR IS LISTED ONLY IN DEPENDENCIES. It leaves merge, update_branch,
//      conflicts, ci_failing (your_pr), stalled_review, untouched_thread and reviewer_routing — and
//      each exclusion runs on the SEED list, so every `kindTotals` is exactly its cards. `my_turn`
//      keeps it: a review requested of you is a direct summons.
//   2. A tool's MARKER makes a person-authored PR a dependency PR (a Snyk fix under the viewer's own
//      token) — `automation.source === 'marker'`.
//   3. ⚠ SECURITY IS KNOWN ADVISORIES ONLY, and an alert is derived ON READ from the tool's own
//      comments: a person's PR keeps its other cards and gains one; a tool's later "all clear"
//      clears it (the SQL pre-filter must let that comment through); only a thread's ROOT counts.
//   4. WHO OPENED IT: `github_type = 'Bot'` and the vendor logins join the automation set; a manual
//      "human" still wins; the vendor seed names a kind, a stored kind beats it; an unknown
//      automation that opens a PR is a coding agent.
//   5. The tabs: Dependencies is a STRICT GROUP (security before bumps, whatever the scores); every
//      author split sums to its total; each author side is capped on its own.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { readFileSync, rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type {
  InsightCard,
  PendingTab,
  ReviewerSuggestion,
  SecurityCard,
  DependencyBumpCard,
} from '@pierre-review/shared';

const DB_PATH = '/tmp/pierre-pending-deps-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';

// The routing suggester's NETWORK half (CODEOWNERS + team history) — no suggestion, no request.
vi.mock('../github/reviewer-suggest.js', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    enrichReviewerSuggestions: vi.fn(async (args: { userSuggestions: ReviewerSuggestion[] }) => ({
      suggestions: args.userSuggestions,
      extraUsers: [],
    })),
  };
});

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void>) | undefined;
let q: any;
let tabs: any;
let brief: any;
let scope: any;
let vouchedScope: any;
let crowdScope: any;
let soloScope: any;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
// Whole seconds: sqlite stores these as unix-epoch INTEGERS.
const now = Math.floor(Date.now() / 1000) * 1000;
const VIEWER_LOGIN = 'viewer-me';
const HUMAN_ORPHANS = 60;
const AGENT_ORPHANS = 3;

/** DEPS-A's masked real bodies — the SQL pre-filter meets the text it will meet in production. */
const fixture = (name: string): string =>
  (
    JSON.parse(
      readFileSync(new URL(`../sync/__fixtures__/security/${name}.json`, import.meta.url), 'utf8'),
    ) as { body: string }
  ).body;
const SOCKET_CVE = fixture('alert-socket-critical-cve');
const SOCKET_RESOLVED = fixture('alert-socket-all-resolved');
const FROGBOT_SCAN = fixture('alert-frogbot-scan');

const prIdByKey = new Map<string, number>();
const pr = (key: string): number => prIdByKey.get(key)!;
const crowdAgentPrIds: number[] = [];
const ids: Record<string, number> = {};

async function board(s: any = scope) {
  const insights = await q.getWorkspaceInsights(1, undefined, s, { uncapped: true });
  return { insights, ...(await tabs.rankPendingTabs(1, s, insights)) } as {
    insights: { cards: InsightCard[]; kindTotals: Record<string, number> };
    tabs: PendingTab[];
    cards: InsightCard[];
    scores: Record<string, { score: number }>;
  };
}
/** Every card the uncapped fold built for one PR, by id. */
function cardsFor(cards: InsightCard[], key: string): string[] {
  return cards
    .filter((c) => 'prId' in c && c.prId === pr(key))
    .map((c) => c.id)
    .sort();
}
function card<T extends InsightCard>(cards: InsightCard[], id: string): T {
  const c = cards.find((x) => x.id === id);
  if (!c) throw new Error(`no card ${id}`);
  return c as T;
}

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('./run-migrations.js');
  const client = await import('./client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  q = await import('./queries.js');
  tabs = await import('./pending-tabs.js');
  brief = await import('./daily-brief.js');

  const {
    accounts,
    events,
    repos,
    pullRequests,
    users,
    reviews,
    reviewRequests,
    reviewThreads,
    reviewComments,
    prComments,
    workspaceReviewers,
  } = schema;
  const { eq } = await import('drizzle-orm');
  await db.update(accounts).set({ githubLogin: VIEWER_LOGIN }).where(eq(accounts.id, 1)).execute();

  const insertUser = async (
    login: string,
    extra: { isBot?: boolean; githubType?: string } = {},
  ): Promise<number> => {
    const [u] = await db
      .insert(users)
      .values({ githubLogin: login, githubNodeId: `U_${login}`, isBot: extra.isBot ?? false, githubType: extra.githubType ?? null })
      .returning()
      .execute();
    return u.id;
  };
  const viewerId = await insertUser(VIEWER_LOGIN);
  ids.viewer = viewerId;
  const aliceId = await insertUser('alice-dev');
  ids.alice = aliceId;
  const dependabotId = await insertUser('dependabot[bot]', { isBot: true });
  // ⚠ `isBot` FALSE and no workspace row: only the AUTOMATION_VENDORS login seed catches it.
  const renovateId = await insertUser('renovate[bot]');
  // ⚠ GitHub TYPES it a Bot, `isBot` is false, and no vocabulary names it.
  const ghAppId = await insertUser('acme-gh-app', { githubType: 'Bot' });
  const socketId = await insertUser('socket-security', { githubType: 'Bot' });
  const coderabbitId = await insertUser('coderabbitai[bot]', { isBot: true });
  // The vendor seed says `imgbot`; a person's stored row says otherwise.
  const imgbotId = await insertUser('imgbot[bot]', { isBot: true });
  // A behavioural "automated" verdict with the DERIVED default role and no brand.
  const helperId = await insertUser('acme-helper');
  const agentId = await insertUser('acme-agent', { githubType: 'Bot' });
  // ⚠ Another ORG's per-org Semgrep install, present in the GLOBAL users table only because some
  // other tenant synced it. Its login names that org. Nothing here references it.
  const foreignSemgrepId = await insertUser('semgrep-code-othercorp[bot]');
  ids.foreignSemgrep = foreignSemgrepId;
  ids.renovate = renovateId;

  const insertRepo = async (key: string, viewerPermission: string): Promise<number> => {
    const [repo] = await db
      .insert(repos)
      .values({
        accountId: 1,
        owner: 'acme',
        name: key,
        githubNodeId: `R_deps_${key}`,
        defaultBranch: 'main',
        defaultBranchName: 'main',
        viewerPermission,
        // Added now: every PR below predates it, so none is a My Turn "New PR" — the board holds
        // exactly the cards this file is about.
        createdAt: new Date(now),
      })
      .returning()
      .execute();
    return repo.id;
  };
  const depsRepo = await insertRepo('deps', 'WRITE');
  const vouchedRepo = await insertRepo('vouched', 'WRITE');
  const crowdRepo = await insertRepo('crowd', 'READ');
  const soloRepo = await insertRepo('solo', 'READ');

  let n = 1;
  let ev = 1;
  const insertPr = async (
    repoId: number,
    key: string,
    authorId: number,
    values: Record<string, unknown> = {},
  ): Promise<number> => {
    // Young by default: under the 4-hour orphan floor and the 24-hour stalled floor, so a person's
    // PR gets only the card its own shape asks for.
    const openedAt = new Date(now - 2 * HOUR);
    const [row] = await db
      .insert(pullRequests)
      .values({
        githubNodeId: `PR_deps_${key}`,
        accountId: 1,
        repoId,
        number: n++,
        title: `${key} fixture`,
        state: 'open',
        isDraft: false,
        authorId,
        baseRefName: 'main',
        openedAt,
        updatedAt: openedAt,
        lastCommitAt: openedAt,
        mergeStateStatus: 'blocked',
        mergeable: 'mergeable',
        // Files present, so the routing suggester never takes its GitHub files-backfill path.
        files: [{ path: `src/${key}.ts`, additions: 1, deletions: 0 }],
        ...values,
      })
      .returning()
      .execute();
    prIdByKey.set(key, row.id);
    // The board's admission floor: a real activity event inside the 90-day window.
    await db
      .insert(events)
      .values({
        accountId: 1,
        repoId,
        prId: row.id,
        actorId: authorId,
        type: 'commit_pushed',
        occurredAt: new Date(now - HOUR),
        dedupeKey: `ev_deps_${ev++}`,
      })
      .execute();
    return row.id;
  };
  const OLD = { openedAt: new Date(now - 2 * DAY), lastCommitAt: new Date(now - 2 * DAY) };
  const CLEAN = { mergeStateStatus: 'clean', mergeable: 'mergeable' };
  const DIRTY = { mergeStateStatus: 'dirty', mergeable: 'conflicting' };

  // ── dependency PRs, each shaped to earn a HOME card if the exclusion were missing ───────────
  // Clean, unreviewed, unrequested and older than the orphan floor: a `merge` AND a
  // `reviewer_routing` card, without the exclusion. No marker: the AUTHOR's role alone decides.
  await insertPr(depsRepo, 'dep-ready', dependabotId, { ...CLEAN, ...OLD });
  // Approved, clean and fresh — a bump that scores ABOVE the blocked security card below.
  await insertPr(depsRepo, 'dep-approved', dependabotId, {
    ...CLEAN,
    dependencyVendor: 'dependabot',
    lastCommitAt: new Date(now - HOUR),
  });
  await db
    .insert(reviews)
    .values({ githubNodeId: 'RV_deps_approved', prId: pr('dep-approved'), authorId: aliceId, state: 'approved', submittedAt: new Date(now - HOUR) })
    .execute();
  // A review requested of the VIEWER, three days ago: a `stalled_review` card without the
  // exclusion — and a my_turn card, which it must keep.
  await insertPr(depsRepo, 'dep-requested', dependabotId, {
    reviewDecision: 'review_required',
    openedAt: new Date(now - 3 * DAY),
  });
  await db.insert(reviewRequests).values({ prId: pr('dep-requested'), userId: viewerId }).execute();
  // Conflicting, in a WRITE repo: a `conflicts` card without the exclusion.
  await insertPr(depsRepo, 'dep-dirty', dependabotId, DIRTY);
  // An untouched thread older than a day: an `untouched_thread` card without the exclusion.
  await insertPr(depsRepo, 'dep-thread', dependabotId);
  // ⚠ The VIEWER's own PR, red — but a Snyk fix pushed with their token (the marker was read at
  // sync): a `ci_failing` your_pr card without the exclusion.
  await insertPr(depsRepo, 'snyk-mine', viewerId, {
    headRefName: 'snyk-fix-476d0e3c',
    dependencyVendor: 'snyk',
    securityFix: 'proven',
    ciStatus: 'failure',
  });
  // A proven fix that a tool ALSO flags — still ONE card. The fix names a DIFFERENT advisory from
  // the alert, so "what the fix fixes" and "what the chips list" can be told apart.
  await insertPr(depsRepo, 'dep-proven-alerted', dependabotId, {
    dependencyVendor: 'dependabot',
    securityFix: 'proven',
    advisoryIds: ['CVE-2026-1111'],
    reviewDecision: 'approved',
  });
  // ⚠ Red, but only NON-required checks: GitHub would merge it (`unstable`). Its person twin below.
  const UNSTABLE = { mergeStateStatus: 'unstable', mergeable: 'mergeable', ciStatus: 'failure' };
  await insertPr(depsRepo, 'dep-unstable', dependabotId, UNSTABLE);
  // Renovate by login alone (isBot false, no row) — the vendor seed's kind.
  await insertPr(depsRepo, 'by-renovate', renovateId, CLEAN);

  // ── the CONTROLS: a person's PR of each shape, which DOES get the home card ─────────────────
  await insertPr(depsRepo, 'human-orphan', aliceId, OLD);
  await insertPr(depsRepo, 'human-dirty', aliceId, DIRTY);
  await insertPr(depsRepo, 'human-thread', aliceId);
  await insertPr(depsRepo, 'mine-red', viewerId, { ciStatus: 'failure' });
  await insertPr(depsRepo, 'human-unstable', aliceId, UNSTABLE);
  // A person's clean PR a tool flagged: it keeps its `merge` card and gains a `security` one.
  await insertPr(depsRepo, 'human-alerted', aliceId, CLEAN);
  // Flagged, then cleared by the same tool's later comment.
  await insertPr(depsRepo, 'human-cleared', aliceId);
  // An AI reviewer's own ROOT finding naming a CVE, and a thread where only a REPLY names one.
  await insertPr(depsRepo, 'human-root-cve', aliceId);
  await insertPr(depsRepo, 'human-reply-cve', aliceId);
  // A Frogbot scan posted under a PERSON's token: the marker, never the login, makes it automation.
  await insertPr(depsRepo, 'human-frogbot', aliceId);

  // ── who opened it ─────────────────────────────────────────────────────────────────────────
  await insertPr(depsRepo, 'by-gh-app', ghAppId, CLEAN);
  await insertPr(depsRepo, 'by-imgbot', imgbotId, CLEAN);
  await insertPr(depsRepo, 'by-helper', helperId, CLEAN);
  // The same Renovate login, one workspace over, where a person vouched for it.
  await insertPr(vouchedRepo, 'vouched-renovate', renovateId, CLEAN);

  // ── the crowd: 60 people's orphans, then 3 coding-agent orphans that score BELOW every one ──
  for (let i = 0; i < HUMAN_ORPHANS; i++) {
    await insertPr(crowdRepo, `crowd-human-${i}`, aliceId, {
      openedAt: new Date(now - (100 + i) * HOUR),
    });
  }
  for (let i = 0; i < AGENT_ORPHANS; i++) {
    crowdAgentPrIds.push(
      await insertPr(crowdRepo, `crowd-agent-${i}`, agentId, { openedAt: new Date(now - (5 + i) * HOUR) }),
    );
  }

  // ── solo: the viewer's own red PR, alone in its workspace — its ci_failing card is their only one
  await insertPr(soloRepo, 'solo-mine-red', viewerId, { ciStatus: 'failure' });

  // ── threads and comments ──────────────────────────────────────────────────────────────────
  const insertThread = async (key: string, prKey: string, by: number): Promise<number> => {
    const [t] = await db
      .insert(reviewThreads)
      .values({
        githubNodeId: `TH_deps_${key}`,
        prId: pr(prKey),
        path: `src/${prKey}.ts`,
        isResolved: false,
        derivedState: 'untouched',
        createdAt: new Date(now - 2 * DAY),
        originalCommenterId: by,
      })
      .returning()
      .execute();
    return t.id;
  };
  let rc = 1;
  const insertReviewComment = async (threadId: number, prKey: string, by: number, body: string, at: number) =>
    db
      .insert(reviewComments)
      .values({ githubNodeId: `RC_deps_${rc++}`, threadId, prId: pr(prKey), authorId: by, body, createdAt: new Date(at) })
      .execute();
  for (const k of ['dep-thread', 'human-thread']) {
    const t = await insertThread(k, k, aliceId);
    await insertReviewComment(t, k, aliceId, 'Can this be simplified?', now - 2 * DAY);
  }
  {
    const t = await insertThread('root-cve', 'human-root-cve', coderabbitId);
    await insertReviewComment(
      t,
      'human-root-cve',
      coderabbitId,
      '_⚠️ Potential issue_\n\n**Upgrade `next` — CVE-2026-30827 allows request smuggling in this version.**',
      now - 2 * DAY,
    );
  }
  {
    const t = await insertThread('reply-cve', 'human-reply-cve', aliceId);
    await insertReviewComment(t, 'human-reply-cve', aliceId, 'Is this version still fine?', now - 2 * DAY);
    // The REPLY names the CVE. Only a root is a finding.
    await insertReviewComment(t, 'human-reply-cve', coderabbitId, 'Yes — CVE-2026-30827 does not affect it.', now - DAY);
  }
  let pc = 1;
  const insertPrComment = async (prKey: string, by: number, body: string, at: number) =>
    db
      .insert(prComments)
      .values({ githubNodeId: `IC_deps_${pc++}`, prId: pr(prKey), authorId: by, body, createdAt: new Date(at) })
      .execute();
  await insertPrComment('human-alerted', socketId, SOCKET_CVE, now - 3 * HOUR);
  await insertPrComment('dep-proven-alerted', socketId, SOCKET_CVE, now - 3 * HOUR);
  await insertPrComment('human-cleared', socketId, SOCKET_CVE, now - 3 * HOUR);
  // ⚠ Names no advisory at all — it must still reach the evaluator, because it is the latest.
  await insertPrComment('human-cleared', socketId, SOCKET_RESOLVED, now - HOUR);
  await insertPrComment('human-frogbot', aliceId, FROGBOT_SCAN, now - 3 * HOUR);

  // ── workspaces and judgements ─────────────────────────────────────────────────────────────
  const vouched = await q.createWorkspace(1, 'Vouched');
  await q.assignReposToWorkspace(vouched.id, 1, [vouchedRepo]);
  const crowd = await q.createWorkspace(1, 'Crowd');
  await q.assignReposToWorkspace(crowd.id, 1, [crowdRepo]);
  const solo = await q.createWorkspace(1, 'Solo');
  await q.assignReposToWorkspace(solo.id, 1, [soloRepo]);
  scope = await q.resolveWorkspaceScope(1, null);
  vouchedScope = await q.resolveWorkspaceScope(1, vouched.id);
  crowdScope = await q.resolveWorkspaceScope(1, crowd.id);
  soloScope = await q.resolveWorkspaceScope(1, solo.id);
  await db
    .insert(workspaceReviewers)
    .values([
      // A person named this bot's brand by hand — it beats the `imgbot` login seed.
      { accountId: 1, workspaceId: scope.workspaceId, authorUserId: imgbotId, automated: true, role: 'code_agent', confidence: 'high', source: 'manual', kind: 'crowdin', identitySource: 'manual' },
      // Behavioural "automated", derived default role, no brand.
      { accountId: 1, workspaceId: scope.workspaceId, authorUserId: helperId, automated: true, role: 'review', confidence: 'medium', source: 'behavioral', kind: 'in_house', identitySource: 'auto' },
      // ⚠ "This is a human" — for the Renovate login, in the Vouched workspace only.
      { accountId: 1, workspaceId: vouched.id, authorUserId: renovateId, automated: false, role: 'review', confidence: 'high', source: 'manual', identitySource: 'manual' },
    ])
    .execute();
});

afterAll(async () => {
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('a dependency PR is listed only in Dependencies', () => {
  it('gets exactly one card, and no merge / routing card', async () => {
    const { insights } = await board();
    expect(cardsFor(insights.cards, 'dep-ready')).toEqual([`deps:${pr('dep-ready')}`]);
    expect(card<DependencyBumpCard>(insights.cards, `deps:${pr('dep-ready')}`).depState).toBe('ready');
  });

  it('leaves every home total to exactly the other PRs', async () => {
    const { insights } = await board();
    const prIdsOf = (kind: string) =>
      insights.cards
        .filter((c) => c.kind === kind)
        .map((c) => (c as { prId: number }).prId)
        .sort((a, b) => a - b);
    const ids = (...keys: string[]) => keys.map(pr).sort((a, b) => a - b);
    expect(prIdsOf('merge')).toEqual(
      ids('human-alerted', 'human-unstable', 'by-gh-app', 'by-imgbot', 'by-helper'),
    );
    expect(insights.kindTotals.merge).toBe(5);
    // The control proves the orphan path is live; the dependency orphan is not on it.
    expect(prIdsOf('reviewer_routing')).toEqual(ids('human-orphan'));
    expect(insights.kindTotals.reviewer_routing).toBe(1);
  });

  it('⚠ keeps its my_turn card when a review is requested of you — and no stalled card', async () => {
    const { insights } = await board();
    expect(cardsFor(insights.cards, 'dep-requested')).toEqual(
      [`deps:${pr('dep-requested')}`, `myturn:review_request:${pr('dep-requested')}`].sort(),
    );
    expect(card<DependencyBumpCard>(insights.cards, `deps:${pr('dep-requested')}`).depState).toBe(
      'needs_review',
    );
    expect(insights.kindTotals.stalled_review ?? 0).toBe(0);
  });

  it('says a conflict on its own card, never as a conflicts card', async () => {
    const { insights } = await board();
    expect(cardsFor(insights.cards, 'human-dirty')).toContain(`conflicts:${pr('human-dirty')}`);
    expect(cardsFor(insights.cards, 'dep-dirty')).toEqual([`deps:${pr('dep-dirty')}`]);
    expect(card<DependencyBumpCard>(insights.cards, `deps:${pr('dep-dirty')}`).depState).toBe(
      'conflicts',
    );
    expect(insights.kindTotals.conflicts).toBe(1);
  });

  it('⚠ takes a red Snyk fix under the viewer’s own account off ci_failing — via the marker', async () => {
    const { insights } = await board();
    expect(cardsFor(insights.cards, 'mine-red')).toContain(`cifail:pr:${pr('mine-red')}`);
    expect(cardsFor(insights.cards, 'snyk-mine')).toEqual([`security:${pr('snyk-mine')}`]);
    const c = card<SecurityCard>(insights.cards, `security:${pr('snyk-mine')}`);
    expect(c.automation).toEqual({ role: 'dependency', kind: 'snyk', source: 'marker' });
    // The account is a person's: the flag stays a claim about the ACCOUNT.
    expect(c.authorIsBot).toBe(false);
    expect([c.depState, c.fix]).toEqual(['ci_red', 'proven']);
  });

  it('⚠ calls a red build GitHub would still merge ready — in the words a person’s merge card uses', async () => {
    const { insights } = await board();
    const dep = card<DependencyBumpCard>(insights.cards, `deps:${pr('dep-unstable')}`);
    const human = card<InsightCard & { detail: string }>(insights.cards, `wp:merge:${pr('human-unstable')}`);
    expect(dep.depState).toBe('ready');
    expect(dep.detail).toBe(human.detail);
    expect(dep.detail).toBe('Can land now, but non-required checks are red');
  });

  it('drops a dependency PR’s untouched thread before counting', async () => {
    const { insights } = await board();
    const threadPrs = insights.cards
      .filter((c) => c.kind === 'untouched_thread')
      .map((c) => (c as { prId: number }).prId);
    expect(threadPrs).toContain(pr('human-thread'));
    expect(threadPrs).not.toContain(pr('dep-thread'));
    expect(insights.kindTotals.untouched_thread).toBe(threadPrs.length);
  });
});

describe('security is known advisories, read from the tools’ own comments', () => {
  it('flags a person’s PR — which keeps its merge card', async () => {
    const { insights } = await board();
    expect(cardsFor(insights.cards, 'human-alerted')).toEqual(
      [`security:${pr('human-alerted')}`, `wp:merge:${pr('human-alerted')}`].sort(),
    );
    const c = card<SecurityCard>(insights.cards, `security:${pr('human-alerted')}`);
    expect([c.dependencyUpdate, c.depState, c.fix, c.detail, c.stateDetail]).toEqual([
      false,
      null,
      null,
      '',
      null,
    ]);
    expect(c.alertCount).toBe(1);
    expect(c.alerts.map((a) => [a.source, a.surface, a.vendorKind])).toEqual([
      ['socket', 'comment', 'socket'],
    ]);
    expect(c.advisoryIds).toEqual(['GHSA-9qr9-h5gf-34mp']);
    expect(c.automation).toBeNull();
  });

  it('keeps a proven fix that a tool also flags as ONE card', async () => {
    const { insights } = await board();
    expect(cardsFor(insights.cards, 'dep-proven-alerted')).toEqual([
      `security:${pr('dep-proven-alerted')}`,
    ]);
    const c = card<SecurityCard>(insights.cards, `security:${pr('dep-proven-alerted')}`);
    expect([c.dependencyUpdate, c.fix, c.alertCount, c.severity]).toEqual([true, 'proven', 1, 'high']);
    // The chips carry every id, the fix's first…
    expect(c.advisoryIds).toEqual(['CVE-2026-1111', 'GHSA-9qr9-h5gf-34mp']);
    // …but ⚠ the sentence names only what the FIX fixes — never the alert's id, which it may not.
    expect(c.detail).toBe('Fixes CVE-2026-1111');
  });

  it('⚠ clears when the tool’s latest comment says all clear — the pre-filter lets it through', async () => {
    const { insights } = await board();
    expect(cardsFor(insights.cards, 'human-cleared')).toEqual([]);
  });

  it('⚠ reads a Frogbot scan a PERSON posted — the pre-filter narrows comments to tools, not to bots', async () => {
    const { insights } = await board();
    const c = card<SecurityCard>(insights.cards, `security:${pr('human-frogbot')}`);
    expect(c.alerts.map((a) => [a.source, a.surface, a.authorId])).toEqual([
      ['frogbot', 'comment', ids.alice],
    ]);
    expect(c.advisoryIds.length).toBeGreaterThan(0);
  });

  it('gives every author-free rule a marker that every body it identifies carries', async () => {
    const { SECURITY_ALERT_PREFILTER, SECURITY_ALERT_RULES } = await import('../sync/security-detect.js');
    const { AUTHOR_FREE_ALERT_MARKERS } = await import('./security-alerts.js');
    const authorFree = SECURITY_ALERT_RULES.filter((r) => r.author === null);
    expect(authorFree.map((r) => r.source).sort()).toEqual(Object.keys(AUTHOR_FREE_ALERT_MARKERS).sort());
    for (const r of authorFree) {
      const marker = AUTHOR_FREE_ALERT_MARKERS[r.source]!;
      // Exact-case, like the evaluator's own admission test.
      expect(SECURITY_ALERT_PREFILTER).toContain(marker);
      for (const alt of r.identifies.source.split('|')) expect([r.source, alt.includes(marker)]).toEqual([r.source, true]);
    }
  });

  it('reads a thread’s ROOT as the finding, and never a reply', async () => {
    const { insights } = await board();
    const root = card<SecurityCard>(insights.cards, `security:${pr('human-root-cve')}`);
    expect(root.alerts.map((a) => [a.source, a.surface, a.threadId != null])).toEqual([
      ['reviewer', 'thread', true],
    ]);
    expect(root.alerts[0]!.vendorKind).toBe('coderabbit');
    expect(root.advisoryIds).toEqual(['CVE-2026-30827']);
    expect(cardsFor(insights.cards, 'human-reply-cve').filter((id) => id.startsWith('security:'))).toEqual([]);
  });
});

describe('who opened it', () => {
  const src = (c: InsightCard) => {
    const p = c as { authorIsBot: boolean; authorBotKind: string | null; automation: unknown };
    return [p.authorIsBot, p.authorBotKind, p.automation];
  };

  it('⚠ counts an account GitHub types a Bot as automation', async () => {
    const { insights } = await board();
    expect(src(card(insights.cards, `wp:merge:${pr('by-gh-app')}`))).toEqual([
      true,
      null,
      { role: 'code_agent', kind: null, source: 'account' },
    ]);
  });

  it('names a vendor by its login alone, and makes it a dependency PR', async () => {
    const { insights } = await board();
    expect(src(card(insights.cards, `deps:${pr('by-renovate')}`))).toEqual([
      true,
      'renovate',
      { role: 'dependency', kind: 'renovate', source: 'account' },
    ]);
  });

  it('⚠ lets a manual "human" beat the vendor login — no dependency card', async () => {
    const { insights } = await board(vouchedScope);
    expect(cardsFor(insights.cards, 'vouched-renovate')).toEqual([`wp:merge:${pr('vouched-renovate')}`]);
    expect(src(card(insights.cards, `wp:merge:${pr('vouched-renovate')}`))).toEqual([
      false,
      null,
      null,
    ]);
  });

  it('lets a stored kind beat the vendor seed', async () => {
    const { insights } = await board();
    const c = card(insights.cards, `wp:merge:${pr('by-imgbot')}`);
    expect(src(c)).toEqual([true, 'crowdin', { role: 'code_agent', kind: 'crowdin', source: 'account' }]);
  });

  it('names you as the author of your own red PR — with your login, even when it is your only card', async () => {
    const { insights } = await board(soloScope);
    const { users } = insights as unknown as { users: { id: number; githubLogin: string }[] };
    expect(insights.cards.map((c) => [c.id, (c as { authorId: number | null }).authorId])).toEqual([
      [`cifail:pr:${pr('solo-mine-red')}`, ids.viewer],
    ]);
    // The byline resolves through `users[]`; without the viewer there it reads as a bare id.
    expect(users.map((u) => [u.id, u.githubLogin])).toEqual([[ids.viewer, VIEWER_LOGIN]]);
  });

  it('⚠ calls an unknown automation with a DERIVED review role a coding agent', async () => {
    const { insights } = await board();
    expect(src(card(insights.cards, `wp:merge:${pr('by-helper')}`))).toEqual([
      true,
      'in_house',
      { role: 'code_agent', kind: 'in_house', source: 'account' },
    ]);
  });
});

describe('the vendor kind seed', () => {
  it('⚠ names an exact vendor login, but never a per-org prefix — that login names another org', async () => {
    // The kind map is also the bot drill-downs' "is this id classified here" gate, which then
    // resolves the login from the GLOBAL users table. Seeded by prefix, any tenant could read
    // another org's name back through it.
    const kinds = await q.classificationKindForUser(1, scope.workspaceId);
    expect(kinds.get(ids.renovate)).toBe('renovate');
    expect(kinds.has(ids.foreignSemgrep)).toBe(false);
    const drill = await q.getBotVendorPrs(1, { userId: ids.foreignSemgrep }, 'rolling_30', scope);
    expect([drill.login, drill.label]).toEqual([null, `u${ids.foreignSemgrep}`]);
    // …while the prefix still makes it AUTOMATION — by id, which names nobody.
    const inputs = await q.resolveAuthorAutomationInputs(1, scope.workspaceId);
    expect(inputs.automatedIds.has(ids.foreignSemgrep)).toBe(true);
  });
});

describe('the tabs', () => {
  it('⚠ lists every security item before any bump, whatever the scores', async () => {
    const b = await board();
    const deps = b.tabs.find((t) => t.key === 'deps')!;
    const kindOf = new Map(b.cards.map((c) => [c.id, c.kind]));
    const kinds = deps.cardIds.map((id) => kindOf.get(id));
    expect(kinds.indexOf('dependency_bump')).toBeGreaterThan(kinds.lastIndexOf('security'));
    // Productive: a bump outscores a security card, so a purely scored tab would interleave them.
    const bump = b.scores[`deps:${pr('dep-approved')}`]!.score;
    const sec = b.scores[`security:${pr('dep-proven-alerted')}`]!.score;
    expect(bump).toBeGreaterThan(sec);
    expect(deps.kindTotals).toEqual({ security: 5, dependency_bump: 7 });
  });

  it('splits every tab by who opened it, and the halves add up', async () => {
    let checkedAutomation = 0;
    for (const s of [scope, crowdScope, vouchedScope]) {
      const b = await board(s);
      for (const t of b.tabs) {
        expect([t.key, t.authorTotals!.people + t.authorTotals!.automation]).toEqual([t.key, t.total]);
        for (const [k, v] of Object.entries(t.kindAuthorTotals ?? {})) {
          expect([t.key, k, v!.people + v!.automation]).toEqual([t.key, k, t.kindTotals[k as never] ?? 0]);
        }
        if (t.relevanceTotals) {
          const r = t.relevanceAuthorTotals!;
          expect(r.mine.people + r.mine.automation).toBe(t.relevanceTotals.mine);
          expect(r.others.people + r.others.automation).toBe(t.relevanceTotals.others);
        }
        checkedAutomation += t.authorTotals!.automation;
      }
    }
    expect(checkedAutomation).toBeGreaterThan(0);
  });

  it('⚠ caps each author side on its own — every automation card survives a crowd of people', async () => {
    const { PENDING_LIMITS } = await import('@pierre-review/shared');
    const b = await board(crowdScope);
    const review = b.tabs.find((t) => t.key === 'review')!;
    expect(review.authorTotals).toEqual({ people: HUMAN_ORPHANS, automation: AGENT_ORPHANS });
    // Productive: the agents score below every person, so one shared cap would cut all three.
    const agentIds = crowdAgentPrIds.map((id) => `route:${id}`);
    const lowestPerson = Math.min(
      ...review.cardIds.filter((id) => !agentIds.includes(id)).map((id) => b.scores[id]!.score),
    );
    for (const id of agentIds) expect(b.scores[id]!.score).toBeLessThan(lowestPerson);
    for (const id of agentIds) expect(review.cardIds).toContain(id);
    expect(review.cardIds).toHaveLength(PENDING_LIMITS.boardListCap + AGENT_ORPHANS);
  });
});

describe('the brief', () => {
  it('says the security population its chip shows', async () => {
    const { insights } = await board();
    const { counts } = await brief.getDailyBriefEntry(1, scope.workspaceId);
    expect(insights.kindTotals.security).toBeGreaterThan(0);
    expect(counts.security).toBe(insights.kindTotals.security);
  });
});
