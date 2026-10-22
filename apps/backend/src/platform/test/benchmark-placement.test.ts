// THE PLACEMENT ROUTE, END TO END, OVER A REAL DATABASE.
//
// `test/benchmark-metric-contract.test.ts` proves the FOLD agrees with Python. This file proves the
// rest of the path: that the host's tables reach that fold with the corpus's definitions intact,
// that a placement lands in the right band of the SHIPPED artifact, that every refusal arm is
// reachable and structurally distinguishable from a low number, and that an anomaly needs both a
// share and a magnitude.
//
// ⚠ THE CORE SCHEMA IS IMPORTED, NOT RE-DECLARED. A hand-written mirror of `pull_requests` in this
// file would let a column rename in `apps/backend/src/db/schema.sqlite.ts` sail past — and
// `ctx.schema` is `Record<string, any>`, so the compiler will not catch one either. Importing the
// real module makes this test the thing that does.
//
// Runs from the backend workspace (@pierre/pro ships no vitest devDep):
//   pnpm --filter @pierre-review/backend exec vitest run src/platform/test
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type {
  BotBenchmarkPlacementMetric,
  BotBenchmarkPlacementResponse,
  BotBenchmarkPlacementUnit,
  BotBenchmarkWorkspaceRollup,
} from '@pierre-review/shared';
import * as coreSchema from '../../db/schema.sqlite.js';
import { anomaliesFor } from '../bots/benchmark/anomalies.js';
import { corpusVendorForKind } from '../bots/benchmark/collect.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const DAY = 86_400_000;
const HOUR = 3_600_000;
const ACCOUNT = 1;
const WORKSPACE = 1;

// The smallest slice of the core schema this fold touches. ⚠ A STANDING OBLIGATION: a column the
// collector names and this DDL lacks fails loudly with `no such column`, which is the intended
// failure — never a silent zero.
const DDL = `
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  github_login TEXT NOT NULL UNIQUE,
  github_node_id TEXT,
  display_name TEXT,
  avatar_url TEXT,
  is_bot INTEGER NOT NULL DEFAULT 0,
  is_bot_overridden INTEGER NOT NULL DEFAULT 0,
  github_type TEXT,
  app_slug TEXT
);
CREATE TABLE repos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  github_node_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE pull_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  github_node_id TEXT NOT NULL,
  account_id INTEGER NOT NULL,
  repo_id INTEGER NOT NULL,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  author_id INTEGER,
  state TEXT NOT NULL,
  is_draft INTEGER NOT NULL DEFAULT 0,
  opened_at INTEGER NOT NULL,
  merged_at INTEGER,
  updated_at INTEGER NOT NULL,
  additions INTEGER NOT NULL DEFAULT 0,
  deletions INTEGER NOT NULL DEFAULT 0,
  changed_files INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE review_threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  github_node_id TEXT NOT NULL,
  pr_id INTEGER NOT NULL,
  path TEXT NOT NULL,
  line INTEGER,
  is_resolved INTEGER NOT NULL,
  is_outdated INTEGER NOT NULL DEFAULT 0,
  derived_state TEXT NOT NULL,
  addressed_confidence TEXT NOT NULL DEFAULT 'none',
  created_at INTEGER NOT NULL
);
CREATE TABLE review_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  github_node_id TEXT NOT NULL,
  thread_id INTEGER NOT NULL,
  pr_id INTEGER NOT NULL,
  author_id INTEGER,
  body TEXT,
  excerpt TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE pr_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  github_node_id TEXT NOT NULL,
  pr_id INTEGER NOT NULL,
  author_id INTEGER,
  body TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  github_node_id TEXT NOT NULL,
  pr_id INTEGER NOT NULL,
  author_id INTEGER,
  state TEXT NOT NULL,
  body TEXT,
  submitted_at INTEGER NOT NULL
);
CREATE TABLE workspaces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE workspace_repos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  workspace_id INTEGER NOT NULL,
  repo_id INTEGER NOT NULL
);
CREATE TABLE workspace_reviewers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  workspace_id INTEGER NOT NULL,
  author_user_id INTEGER NOT NULL,
  automated INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'review',
  confidence TEXT NOT NULL,
  source TEXT NOT NULL,
  kind TEXT,
  label TEXT,
  identity_source TEXT NOT NULL DEFAULT 'auto',
  monthly_cents INTEGER,
  cost_model TEXT NOT NULL DEFAULT 'flat',
  updated_at INTEGER NOT NULL DEFAULT 0
);
`;

const secs = (ms: number): number => Math.floor(ms / 1000);

let raw: Database.Database;
let app: any;
let ctx: any;
let now: number;
/** The host's OPTIONAL seat-count seam. `null` stands in for an older host that does not implement
 *  it at all — the member is then `undefined` and a per-seat price is UNRESOLVABLE. */
let seatCountAnswer: number | null = 8;
/** The host's OPTIONAL dormancy seam (core `db/bot-dormancy.ts`). `null` stands in for an older
 *  host that does not implement it — the member is then `undefined` and the tab hides NOTHING,
 *  which is the deliberate degradation. An array is the ids that host reports as silent. */
let dormantAnswer: number[] | null = null;

/** A seeding helper set that speaks the DOMAIN, so each test reads as the scenario it pins. */
interface Seed {
  repo(opts: { id: number; name: string; createdAtMs: number }): void;
  user(opts: { id: number; login: string; isBot?: boolean; githubType?: string }): void;
  reviewer(opts: {
    userId: number;
    kind: string | null;
    role?: string;
    automated?: boolean;
    source?: string;
    /** ⚠ CENTS, and `undefined` means the column stays NULL — "no price set", which is a
     *  different fact from a stored 0. */
    monthlyCents?: number;
    costModel?: string;
    workspaceId?: number;
  }): void;
  pr(opts: {
    id: number;
    repoId: number;
    number: number;
    authorId: number;
    merged: boolean;
    mergedAgoMs?: number;
  }): void;
  thread(opts: {
    id: number;
    prId: number;
    path: string;
    line: number | null;
    resolved?: boolean;
    outdated?: boolean;
    ageMs: number;
  }): void;
  reviewComment(opts: {
    id: number;
    threadId: number;
    prId: number;
    authorId: number;
    body: string | null;
    excerpt?: string | null;
    atMs: number;
  }): void;
  review(opts: { id: number; prId: number; authorId: number; body: string | null }): void;
}

function seeder(): Seed {
  let commentSeq = 0;
  return {
    repo: ({ id, name, createdAtMs }) => {
      raw
        .prepare(
          'INSERT INTO repos (id, account_id, owner, name, github_node_id, created_at) VALUES (?,?,?,?,?,?)',
        )
        .run(id, ACCOUNT, 'acme', name, `R_${id}`, secs(createdAtMs));
      raw
        .prepare(
          'INSERT INTO workspace_repos (account_id, workspace_id, repo_id) VALUES (?,?,?)',
        )
        .run(ACCOUNT, WORKSPACE, id);
    },
    user: ({ id, login, isBot = false, githubType = null as any }) =>
      void raw
        .prepare('INSERT INTO users (id, github_login, is_bot, github_type) VALUES (?,?,?,?)')
        .run(id, login, isBot ? 1 : 0, githubType),
    reviewer: ({
      userId,
      kind,
      role = 'review',
      automated = true,
      source = 'vendor_login',
      monthlyCents,
      costModel = 'flat',
      workspaceId = WORKSPACE,
    }) =>
      void raw
        .prepare(
          `INSERT INTO workspace_reviewers
             (account_id, workspace_id, author_user_id, automated, role, confidence, source, kind,
              monthly_cents, cost_model)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          ACCOUNT,
          workspaceId,
          userId,
          automated ? 1 : 0,
          role,
          'high',
          source,
          kind,
          // ⚠ `?? null`, NEVER `?? 0`. The two states this whole feature turns on are "nobody has
          // said what this costs" and "we pay nothing for it", and a seeding helper that collapsed
          // them would make the absent-price test unwritable.
          monthlyCents ?? null,
          costModel,
        ),
    pr: ({ id, repoId, number, authorId, merged, mergedAgoMs = 3 * DAY }) =>
      void raw
        .prepare(
          `INSERT INTO pull_requests
             (id, github_node_id, account_id, repo_id, number, title, author_id, state, opened_at, merged_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          `PR_${id}`,
          ACCOUNT,
          repoId,
          number,
          `pr ${number}`,
          authorId,
          merged ? 'merged' : 'open',
          secs(now - 30 * DAY),
          merged ? secs(now - mergedAgoMs) : null,
          secs(now - mergedAgoMs),
        ),
    thread: ({ id, prId, path, line, resolved = false, outdated = false, ageMs }) =>
      void raw
        .prepare(
          `INSERT INTO review_threads
             (id, github_node_id, pr_id, path, line, is_resolved, is_outdated, derived_state, created_at)
           VALUES (?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          `T_${id}`,
          prId,
          path,
          line,
          resolved ? 1 : 0,
          outdated ? 1 : 0,
          'untouched',
          secs(now - ageMs),
        ),
    reviewComment: ({ id, threadId, prId, authorId, body, excerpt = null, atMs }) =>
      void raw
        .prepare(
          `INSERT INTO review_comments
             (id, github_node_id, thread_id, pr_id, author_id, body, excerpt, created_at)
           VALUES (?,?,?,?,?,?,?,?)`,
        )
        .run(id, `RC_${id}`, threadId, prId, authorId, body, excerpt, secs(atMs)),
    review: ({ id, prId, authorId, body }) =>
      void raw
        .prepare(
          `INSERT INTO reviews (id, github_node_id, pr_id, author_id, state, body, submitted_at)
           VALUES (?,?,?,?,?,?,?)`,
        )
        .run(id, `RV_${id}_${(commentSeq += 1)}`, prId, authorId, 'commented', body, secs(now)),
  };
}

async function placement(query = ''): Promise<BotBenchmarkPlacementResponse> {
  const res = await app.inject({
    method: 'GET',
    url: `/api/pro/bot-benchmark/placement${query}`,
  });
  expect(res.statusCode).toBe(200);
  return res.json() as BotBenchmarkPlacementResponse;
}

function unitFor(body: BotBenchmarkPlacementResponse, vendorKey: string): BotBenchmarkPlacementUnit {
  const found = (body.units ?? []).find((u) => u.vendor === vendorKey);
  if (found == null) throw new Error(`no unit for ${vendorKey}`);
  return found;
}

/**
 * ONE VENDOR'S WHOLE-WORKSPACE CARD.
 *
 * ⚠ IT LOOKS UP THE WORKSPACE'S AUTOMATION KEY, NOT `vendor`, and that is the identity rule rather
 * than a convenience: `vendor` is `null` for every brand the corpus has never seen — most of the
 * reviewers a real workspace runs — so n unbranded cards would collapse onto one lookup. For a
 * corpus vendor the two strings coincide, which is why every call below reads like `unitFor`'s.
 */
function rollupFor(
  body: BotBenchmarkPlacementResponse,
  key: string,
): BotBenchmarkWorkspaceRollup {
  const found = (body.rollup ?? []).find((r) => r.key === key);
  if (found == null) throw new Error(`no rollup card for ${key}`);
  return found;
}

/**
 * ⚠ ASSERT ON THE VALUES, NEVER ON THE SERIALISED STRING.
 *
 * `JSON.stringify` writes `Infinity`, `-Infinity` and `NaN` as the literal `null`, so a regex
 * hunting for those tokens in a serialised payload can never match. The assertion this replaced
 * did exactly that and was therefore unfalsifiable: a relaxed divide-by-zero guard would have put
 * an `Infinity` on the wire as `null`, rendered it as an em dash, and stayed green.
 */
function expectAllFinite(value: unknown, path = 'cost'): void {
  if (typeof value === 'number') {
    expect(Number.isFinite(value), `${path} = ${String(value)}`).toBe(true);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => expectAllFinite(v, `${path}[${i}]`));
    return;
  }
  if (value != null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) expectAllFinite(v, `${path}.${k}`);
  }
}

beforeAll(async () => {
  const { registerBotBenchmarkPlacementRoutes } = await import(
    '../bots/benchmark/placement-routes.js'
  );
  const { default: Fastify } = await import('fastify');
  app = Fastify({ logger: false });
  registerBotBenchmarkPlacementRoutes(app, {
    accountIdOf: () => ACCOUNT,
    get db() {
      return ctx.db;
    },
    schema: coreSchema,
    queries: {
      defaultWorkspaceId: async () => WORKSPACE,
      // ⚠ A GETTER, so a test can make the OPTIONAL seam ABSENT rather than merely make it answer
      // differently. `undefined` is the older-host case the contract's optionality exists for, and
      // it is a different code path from "the seat count is 0".
      get workspaceHumanSeatCount() {
        return seatCountAnswer == null ? undefined : async () => seatCountAnswer as number;
      },
      // ⚠ A GETTER for the same reason: `undefined` (an older host) is a DIFFERENT code path from
      // "the host answered with an empty list", and only a getter can express both.
      get dormantBotUserIds() {
        return dormantAnswer == null
          ? undefined
          : async (_accountId: number, _workspaceId: number, candidates: number[]) =>
              candidates.filter((id) => (dormantAnswer as number[]).includes(id));
      },
    },
    log: { warn: () => {}, info: () => {}, error: () => {} },
  } as any);
  await app.ready();
});

afterAll(async () => {
  await app?.close();
});

beforeEach(async () => {
  delete process.env.PRO_BENCHMARK_FIT_PATH;
  (await import('../bots/benchmark/artifact.js')).resetBenchmarkArtifactCache();
  seatCountAnswer = 8;
  dormantAnswer = null;
  now = Date.now();
  raw = new Database(':memory:');
  raw.exec(DDL);
  raw
    .prepare('INSERT INTO workspaces (id, account_id, name, is_default) VALUES (?,?,?,1)')
    .run(WORKSPACE, ACCOUNT, 'Default');
  ctx = { db: drizzle(raw) as any };
});

// ════════════════════════════════════════════════════════════════════════════════════════════════

describe('the happy path: a repository placed in a real band of the shipped corpus', () => {
  beforeEach(() => {
    const s = seeder();
    s.repo({ id: 10, name: 'app', createdAtMs: now - 400 * DAY });
    s.user({ id: 1, login: 'alice' });
    s.user({ id: 2, login: 'coderabbitai', isBot: true, githubType: 'Bot' });
    s.user({ id: 3, login: 'dependabot', isBot: true, githubType: 'Bot' });
    s.user({ id: 4, login: 'some-ci-bot', isBot: true, githubType: 'Bot' });
    s.reviewer({ userId: 2, kind: 'coderabbit' });
    s.reviewer({ userId: 3, kind: 'dependabot', role: 'dependency' });
    s.reviewer({ userId: 4, kind: 'in_house', role: 'quality_check' });

    // Eight merged human pull requests + two merged dependency bumps + one open one. The bumps are
    // OUT of the volume denominator and IN the banding axis.
    for (let i = 1; i <= 8; i += 1) {
      s.pr({ id: i, repoId: 10, number: i, authorId: 1, merged: true, mergedAgoMs: i * HOUR });
    }
    s.pr({ id: 20, repoId: 10, number: 20, authorId: 3, merged: true, mergedAgoMs: 2 * HOUR });
    s.pr({ id: 21, repoId: 10, number: 21, authorId: 3, merged: true, mergedAgoMs: 3 * HOUR });
    s.pr({ id: 30, repoId: 10, number: 30, authorId: 1, merged: false });

    // Six settled threads on merged human PRs; three resolved, one with a human reply.
    for (let i = 1; i <= 6; i += 1) {
      s.thread({
        id: i,
        prId: i,
        path: `src/f${i}.ts`,
        line: i * 10,
        resolved: i <= 3,
        ageMs: 30 * DAY,
      });
      s.reviewComment({
        id: 100 + i,
        threadId: i,
        prId: i,
        authorId: 2,
        body: 'x'.repeat(40),
        atMs: now - 30 * DAY,
      });
    }
    // A human answered one of them, two hours after the bot.
    s.reviewComment({
      id: 200,
      threadId: 4,
      prId: 4,
      authorId: 1,
      body: 'fixed',
      atMs: now - 30 * DAY + 2 * HOUR,
    });
    // ⚠ AND A CI BOT ANSWERED ANOTHER. "Human" is the complement of MACHINE, so this must NOT
    // count as a reply — the exact gap 645 of 3,292 comments sat in on the walk's v1 schema.
    s.reviewComment({
      id: 201,
      threadId: 5,
      prId: 5,
      authorId: 4,
      body: 'build ok',
      atMs: now - 30 * DAY + 2 * HOUR,
    });
    // ⚠ AND AN UNCLASSIFIED BOT ANSWERED A THIRD — `is_bot` / `githubType: 'Bot'` with NO
    // workspace_reviewers row at all. The machine set is a UNION of three independent tests, and
    // this actor is only in two of them: without the `users.isBot` and `githubType` disjuncts it
    // reads as a person and manufactures a human reply. That is the difference between dividing
    // four findings by ten merges and by a hundred, stated on the reply side.
    s.user({ id: 6, login: 'stale-bot', isBot: true, githubType: 'Bot' });
    s.reviewComment({
      id: 202,
      threadId: 6,
      prId: 6,
      authorId: 6,
      body: 'closing as stale',
      atMs: now - 30 * DAY + 3 * HOUR,
    });
  });

  it('places the unit in a band of the vendor’s own ladder, with the denominator attached', async () => {
    const body = await placement();
    expect(body.available).toBe(true);
    expect(body.workspaceId).toBe(WORKSPACE);
    const unit = unitFor(body, 'coderabbit');
    expect(unit.placement.status).toBe('placed');
    if (unit.placement.status !== 'placed') throw new Error('unreachable');
    // ⚠ THE LABEL RIDES THE RANK. "Upper fifth" is honest at 5 bands and a misrepresentation at 10.
    expect(unit.placement.nBands).toBe(10);
    expect(unit.placement.bandLabel).toBe(
      `${unit.placement.activityBand + 1} of ${unit.placement.nBands}`,
    );
    expect(unit.placement.cohortRepos).toBeGreaterThan(0);
    expect(unit.reviewers.map((r) => r.login)).toEqual(['coderabbitai']);
  });

  it('counts MACHINE-AUTHORED merges in the banding axis and out of the denominator', async () => {
    const body = await placement();
    const unit = unitFor(body, 'coderabbit');
    // Ten merges in the window, two of them dependency bumps.
    expect(unit.activity.mergedPrsLast14d).toBe(10);
    expect(unit.counters.volume['mergedEligible']).toBe(8);
    expect(unit.counters.repository['mergedMachineAuthored']).toBe(2);
    // ⚠ The band is read off the TEN, not the eight. Excluding bumps here would place a bump-heavy
    // repository one or more bands too low.
    expect(unit.activity.walkBudget).toBe(64); // min(150, round(10 * 90 / 14))
  });

  it('does not count ANY machine answering a finding as a human reply', async () => {
    const body = await placement();
    const unit = unitFor(body, 'coderabbit');
    expect(unit.counters.outcome['threadsSettledComplete']).toBe(6);
    // Exactly ONE human reply. Thread 5 was answered by a CLASSIFIED quality_check bot and thread
    // 6 by an UNCLASSIFIED `githubType: 'Bot'` account with no workspace_reviewers row — three
    // different routes into the machine set, and only the person on thread 4 is a human.
    expect(unit.counters.outcome['threadsSettledCompleteReplied']).toBe(1);
    expect(unit.counters.outcome['threadsSettledCompleteFollowed']).toBe(1);
    // …so five of the six settled threads are overdue-untouched, not three.
    expect(unit.counters.overdueUntouched['72']).toBe(2);
  });

  it('starts the reply clock STRICTLY after the vendor’s comment, never at it', async () => {
    // A human comment stamped at the same second as the vendor's finding did not answer it — the
    // corpus's own predicate is `>`, and `>=` would count a simultaneous comment (common when a
    // sync collapses sub-second stamps) as a reply the bot earned.
    const s = seeder();
    s.reviewComment({
      id: 210,
      threadId: 5,
      prId: 5,
      authorId: 1,
      body: 'unrelated',
      atMs: now - 30 * DAY,
    });
    const unit = unitFor(await placement(), 'coderabbit');
    expect(unit.counters.outcome['threadsSettledCompleteReplied']).toBe(1);
  });

  it('compares every metric both sides fitted, and attaches the cohort’s own uncertainty', async () => {
    const body = await placement();
    const unit = unitFor(body, 'coderabbit');
    const acted = unit.metrics['acted_on_rate'] as BotBenchmarkPlacementMetric;
    expect(acted.status).toBe('compared');
    if (acted.status !== 'compared') throw new Error('unreachable');
    // 3 resolved + 1 followed-but-unresolved, over 6 settled complete threads.
    expect(acted.value).toBe(4 / 6);
    expect(acted.units).toBe(6);
    expect(acted.percentile).toBeGreaterThanOrEqual(0);
    expect(acted.percentile).toBeLessThanOrEqual(100);
    expect(acted.cohort.direction).toBe('higher_is_better');
    expect(acted.cohort.nRepos).toBeGreaterThanOrEqual(30);
    // ⚠ THE CI TRAVELS. Without it, "your 67% vs the cohort's 63%" is reporting noise as a gap.
    expect(acted.cohort.ciMedian95).not.toBeNull();
  });

  it('reports the corpus parameters it ran on, read from the artifact and never inlined', async () => {
    const body = await placement();
    expect(body.params).toEqual({
      settleHours: 72,
      overdueGraceHours: [72, 168],
      activityWindowDays: 14,
    });
    expect(body.fitKey).toMatch(/^fit-v2\+/);
    expect(body.staleness?.state).toBeDefined();
  });

  it('passes the three model-derived metrics through as STRUCTURALLY ABSENT', async () => {
    const body = await placement();
    // ⚠ IT MATTERS MOST HERE: the host ALREADY HAS these numbers (ML severity is a shipped free
    // feature), so the temptation is to render the customer's severity distribution against a
    // placeholder. Structural absence means the key is not in any cell to read.
    expect((body.absentMetrics ?? []).map((m) => m.name).sort()).toEqual([
      'distinct_category_count',
      'high_severity_share',
      'nit_share',
    ]);
    for (const unit of body.units ?? []) {
      expect(unit.metrics).not.toHaveProperty('high_severity_share');
      expect(unit.metrics).not.toHaveProperty('nit_share');
    }
  });

  it('discloses the comparison’s limits WITHOUT withholding the comparison', async () => {
    const body = await placement();
    expect(body.disclosures?.length).toBeGreaterThan(0);
    expect(body.disclosures?.join(' ')).toMatch(/PUBLIC repositories only/);
    expect(body.disclosures?.join(' ')).toMatch(/fixed historical fortnight/);
    expect(unitFor(body, 'coderabbit').placement.status).toBe('placed');
  });

  it('bounds the banding axis to the LAST 14 DAYS, half-open', async () => {
    // A merge from six weeks ago is not this fortnight's activity. Without the lower bound the
    // repository climbs bands purely by having existed longer, which is the one thing the axis
    // must not measure.
    const s = seeder();
    s.pr({ id: 40, repoId: 10, number: 40, authorId: 1, merged: true, mergedAgoMs: 42 * DAY });
    const body = await placement();
    expect(unitFor(body, 'coderabbit').activity.mergedPrsLast14d).toBe(10);
  });

  it('marks a 50-comment thread TRUNCATED and drops it from the complete-only denominators', async () => {
    // ⚠ THE HOST FETCHES `comments(first: 50)` WITH NO pageInfo, so it has the corpus's truncation
    // failure mode and no `comment_total` to detect it with. The rule is an approximation in the
    // CONSERVATIVE direction: a 50-comment complete thread is falsely excluded, which is right,
    // because the alternative ("assume complete") manufactures an overdue-untouched rate out of
    // paging.
    const before = unitFor(await placement(), 'coderabbit');
    expect(before.counters.outcome['threadsSettledComplete']).toBe(6);
    expect(before.counters.outcome['threadsTruncated']).toBe(0);

    const s = seeder();
    s.thread({ id: 90, prId: 1, path: 'src/long.ts', line: 5, ageMs: 30 * DAY });
    for (let i = 0; i < 50; i += 1) {
      s.reviewComment({
        id: 900 + i,
        threadId: 90,
        prId: 1,
        authorId: i === 0 ? 2 : 1,
        body: 'x'.repeat(40),
        atMs: now - 30 * DAY + i * 60_000,
      });
    }
    const after = unitFor(await placement(), 'coderabbit');
    expect(after.counters.outcome['threadsTruncated']).toBe(1);
    // ⚠ It IS in `threadsSettled` (isResolved is a thread-level scalar observable under truncation)
    // and it is NOT in `threadsSettledComplete`. That asymmetry is thread_resolved_rate's whole
    // reason for having a different denominator from every other outcome metric.
    expect(after.counters.outcome['threadsSettled']).toBe(7);
    expect(after.counters.outcome['threadsSettledComplete']).toBe(6);
    const resolved = after.metrics['thread_resolved_rate'];
    const acted = after.metrics['acted_on_rate'];
    if (resolved?.status !== 'compared' || acted?.status !== 'compared') {
      throw new Error('expected both to compare');
    }
    expect(resolved.units).toBe(7);
    expect(acted.units).toBe(6);
    // …and it is OUT of the overdue denominators too, where "we did not read far enough" must never
    // be counted as "nobody answered".
    expect(after.counters.overdueEligible['72']).toBe(6);
  });

  it('refuses the two body-reading volume metrics when a body is UNOBSERVED, and nothing else', async () => {
    // `body` and `excerpt` both null is a legacy row from the 2026-06 lean window. It cannot be
    // classified as a finding or as a silent approval, so the two metrics that read a body refuse
    // rather than guess — while the thread-outcome metrics, which read no body, are untouched.
    const s = seeder();
    s.reviewComment({ id: 700, threadId: 1, prId: 1, authorId: 2, body: null, atMs: now });
    const unit = unitFor(await placement(), 'coderabbit');
    for (const name of ['findings_per_merged_pr', 'pr_comment_coverage']) {
      const metric = unit.metrics[name];
      expect(metric?.status, name).toBe('excluded');
      if (metric?.status !== 'excluded') throw new Error('unreachable');
      expect(metric.reason, name).toBe('body_unobserved');
    }
    expect(unit.metrics['threads_per_merged_pr']?.status).toBe('compared');
    expect(unit.metrics['acted_on_rate']?.status).toBe('compared');
    // ⚠ AND IT STILL PROVES THE VENDOR RAN: an unknown body is an observed comment, so the live
    // gate is unaffected and nothing collapses to `vendor_silent`.
    expect(unit.counters.volume['commentsObserved']).toBeGreaterThan(0);
  });

  it('treats a NON-EMPTY EXCERPT as proof of a non-empty body', async () => {
    const s = seeder();
    s.reviewComment({
      id: 701,
      threadId: 1,
      prId: 1,
      authorId: 2,
      body: null,
      excerpt: 'a real finding',
      atMs: now,
    });
    const unit = unitFor(await placement(), 'coderabbit');
    expect(unit.metrics['findings_per_merged_pr']?.status).toBe('compared');
    expect(unit.counters.volume['findingComments']).toBe(7);
  });

  it('counts an EMPTY-BODY review as a silent approval — live, never a finding', async () => {
    const s = seeder();
    s.review({ id: 800, prId: 1, authorId: 2, body: '' });
    const unit = unitFor(await placement(), 'coderabbit');
    expect(unit.counters.volume['emptyBodyComments']).toBe(1);
    expect(unit.counters.volume['findingComments']).toBe(6);
    expect(unit.counters.volume['commentsObserved']).toBe(7);
  });

  it('emits a unit for a reviewer that is SILENT in this repository — undefined, never 0.0', async () => {
    // `in_house` is a quality_check role, so it is not a review vendor and gets no unit at all.
    // Add a second REVIEW vendor that never comments here, and it must be `vendor_silent`.
    const s = seeder();
    s.user({ id: 5, login: 'greptileai', isBot: true, githubType: 'Bot' });
    s.reviewer({ userId: 5, kind: 'greptile' });
    const body = await placement();
    const unit = unitFor(body, 'greptile');
    for (const metric of Object.values(unit.metrics)) {
      expect(metric.status).toBe('excluded');
      if (metric.status !== 'excluded') throw new Error('unreachable');
      expect(metric.reason).toBe('vendor_silent');
      // ⚠ RULE 1, STRUCTURALLY: reading a percentile off a refusal must be impossible, not 0.
      expect(metric).not.toHaveProperty('percentile');
      expect(metric).not.toHaveProperty('value');
      expect(metric.message).toMatch(/undefined|no comment/i);
    }
  });

  it('gives a non-reviewer automation NO unit, however loud it is', async () => {
    // ⚠ EXACTLY `role === 'review'`, NEVER `!== 'quality_check'`. Six roles exist and only one is
    // the reviewer cohort; the negated spelling re-admits `dependency`, `code_agent`, `release`
    // and `housekeeping`, which is how a bump bot's volume ends up in a review-bot cohort. The
    // seed carries BOTH a `quality_check` reviewer (which a deny-list would also exclude) and a
    // `dependency` one (which it would NOT), and asserting the exact emitted set is what tells
    // them apart.
    const body = await placement();
    const emitted = (body.units ?? []).flatMap((u) => u.reviewers.map((r) => r.login)).sort();
    expect(emitted).toEqual(['coderabbitai']);
    expect((body.units ?? []).map((u) => u.vendor)).not.toContain('in_house');
  });
});

describe('a DORMANT reviewer is hidden, and hiding it moves no other number', () => {
  // The workspace runs two review vendors in one repository. Both are live in the fold; the HOST
  // reports one of them dormant — no thread, no review comment, no submitted review anywhere in
  // this workspace for thirty days — which is the same claim the Bots ROI table already makes about
  // it. The tab must then say nothing about it at all: no unit, no card, no zero.
  //
  // ⚠ THE SECOND ASSERTION IS THE ONE THAT MATTERS. `rollup.ts`'s `isLive` decides a card's
  // repository population, which is the denominator of `perMergedPr` and the base of every pooled
  // counter. The hide therefore has to land on WHOLE vendors AFTER the fold, never inside a live
  // vendor's population — so CodeRabbit's card must be byte-identical with and without the gate.
  beforeEach(() => {
    const s = seeder();
    s.repo({ id: 10, name: 'app', createdAtMs: now - 400 * DAY });
    s.user({ id: 1, login: 'alice' });
    s.user({ id: 2, login: 'coderabbitai', isBot: true, githubType: 'Bot' });
    s.user({ id: 5, login: 'greptileai', isBot: true, githubType: 'Bot' });
    s.reviewer({ userId: 2, kind: 'coderabbit', monthlyCents: 12_000 });
    s.reviewer({ userId: 5, kind: 'greptile', monthlyCents: 6_000 });
    for (let i = 1; i <= 8; i += 1) {
      s.pr({ id: i, repoId: 10, number: i, authorId: 1, merged: true, mergedAgoMs: i * HOUR });
    }
    for (let i = 1; i <= 6; i += 1) {
      s.thread({ id: i, prId: i, path: `src/f${i}.ts`, line: i * 10, resolved: i <= 3, ageMs: 30 * DAY });
      s.reviewComment({
        id: 100 + i,
        threadId: i,
        prId: i,
        authorId: 2,
        body: 'x'.repeat(40),
        atMs: now - 30 * DAY,
      });
    }
    // Greptile is loud in the fold's eyes — it is the HOST's 30-day dormancy verdict, not the
    // walked slice, that hides it. Seeding it silent instead would make this test pass for the
    // wrong reason (`vendor_silent` already withholds every metric).
    for (let i = 7; i <= 8; i += 1) {
      s.thread({ id: i, prId: i, path: `src/g${i}.ts`, line: i, resolved: false, ageMs: 30 * DAY });
      s.reviewComment({
        id: 100 + i,
        threadId: i,
        prId: i,
        authorId: 5,
        body: 'y'.repeat(40),
        atMs: now - 30 * DAY,
      });
    }
  });

  it('drops the dormant vendor’s units and its card — absent, never a zero', async () => {
    dormantAnswer = [5];
    const body = await placement();
    expect((body.units ?? []).map((u) => u.vendor)).toEqual(['coderabbit']);
    expect((body.rollup ?? []).map((r) => r.key)).toEqual(['coderabbit']);
    // Not a card with zeroed counters and not a `vendor_silent` unit — nothing about it at all.
    expect(JSON.stringify(body)).not.toContain('greptile');
  });

  it('leaves the LIVE vendor’s card bit-for-bit unchanged — the denominator never moved', async () => {
    dormantAnswer = null;
    const before = rollupFor(await placement(), 'coderabbit');
    dormantAnswer = [5];
    const after = rollupFor(await placement(), 'coderabbit');
    // ⚠ THE WHOLE CARD, not a chosen field: `liveInRepos`, `reposConsidered`, every pooled counter,
    // the spread, the expectation and the money all have to be identical, because the filter must
    // not have reached inside a surviving vendor's population.
    expect(after).toEqual(before);
  });

  it('hides NOTHING when the host has no dormancy seam — the older-host degradation', async () => {
    dormantAnswer = null;
    const body = await placement();
    expect(new Set((body.units ?? []).map((u) => u.vendor))).toEqual(
      new Set(['coderabbit', 'greptile']),
    );
    expect(new Set((body.rollup ?? []).map((r) => r.key))).toEqual(
      new Set(['coderabbit', 'greptile']),
    );
  });

  it('keeps a vendor whose OTHER login is still live — one live account keeps the card', async () => {
    // Two logins the workspace classifies as one vendor are ONE card, so the key is dormant only
    // when EVERY login under it is. The conservative direction is the only one that cannot hide
    // observed work.
    const s = seeder();
    s.user({ id: 9, login: 'coderabbitai-2', isBot: true, githubType: 'Bot' });
    s.reviewer({ userId: 9, kind: 'coderabbit' });
    dormantAnswer = [9]; // the second CodeRabbit account only
    const body = await placement();
    expect((body.rollup ?? []).map((r) => r.key)).toContain('coderabbit');
  });
});

describe('the refusals, each a different sentence', () => {
  const base = (): Seed => {
    const s = seeder();
    s.user({ id: 1, login: 'alice' });
    for (let i = 1; i <= 6; i += 1) {
      s.pr({ id: i, repoId: 10, number: i, authorId: 1, merged: true, mergedAgoMs: i * HOUR });
    }
    return s;
  };

  it('refuses a repository the host has held for less than the activity window', async () => {
    const s = seeder();
    s.repo({ id: 10, name: 'fresh', createdAtMs: now - 3 * DAY });
    base();
    s.user({ id: 2, login: 'coderabbitai', isBot: true });
    s.reviewer({ userId: 2, kind: 'coderabbit' });
    s.reviewComment({ id: 1, threadId: 1, prId: 1, authorId: 2, body: 'x', atMs: now });
    const body = await placement();
    const unit = unitFor(body, 'coderabbit');
    expect(unit.placement.status).toBe('refused');
    if (unit.placement.status !== 'refused') throw new Error('unreachable');
    // ⚠ A REFUSAL, NOT A CAVEAT: a partial window is an UNDERCOUNT, so it would place the
    // repository too LOW and silently — the direction nobody would notice.
    expect(unit.placement.reason).toBe('repo_window_incomplete');
    expect(unit.placement.required).toEqual({ repoHeldDays: 14 });
    expect(unit.anomalies).toEqual([]);
  });

  it('refuses a repository that merged nothing recently, rather than calling every bot silent', async () => {
    // ⚠ THE FALSE CLAIM THIS REFUSAL EXISTS TO PREVENT, reproduced. `walkBudget` is derived from
    // the merge count, so zero merges in the window means the fold reads ZERO pull requests — and
    // every reviewer then comes back `vendor_silent`, rendered as "Said nothing here", however much
    // it actually wrote. Before this refusal, THIS SEED reported all thirteen metrics as silence
    // for a reviewer holding twenty real findings.
    //
    // It is deliberately NOT `repo_window_incomplete`: the window is whole and the host has held
    // the repository for over a year. The work is simply elsewhere in time, and reading further
    // back would compare it against a window no peer used.
    const s = seeder();
    s.repo({ id: 10, name: 'quiet', createdAtMs: now - 400 * DAY });
    s.user({ id: 1, login: 'alice' });
    s.user({ id: 2, login: 'coderabbitai', isBot: true });
    s.reviewer({ userId: 2, kind: 'coderabbit' });
    // Twenty merged pull requests carrying twenty real findings — all merged 40 days ago.
    for (let i = 1; i <= 20; i += 1) {
      s.pr({ id: i, repoId: 10, number: i, authorId: 1, merged: true, mergedAgoMs: 40 * DAY });
      s.reviewComment({ id: i, threadId: i, prId: i, authorId: 2, body: 'a real finding', atMs: now - 40 * DAY });
    }
    const body = await placement();
    const unit = unitFor(body, 'coderabbit');
    expect(unit.activity.mergedPrsLast14d).toBe(0);
    expect(unit.placement.status).toBe('refused');
    if (unit.placement.status !== 'refused') throw new Error('unreachable');
    expect(unit.placement.reason).toBe('repo_inactive_in_window');
    // ⚠ AND NOTHING ANYWHERE IN THE ANSWER MAY ASSERT THE REVIEWER WAS SILENT. That is the defect,
    // and the refusal reason alone does NOT catch it: the first fix refused the PLACEMENT while all
    // thirteen metrics still read `vendor_silent`, so the verdict was right and the evidence under
    // it was still a false claim about the bot.
    expect(JSON.stringify(unit)).not.toContain('vendor_silent');
    // The positive half: every metric names the real cause, which is about the REPOSITORY.
    const reasons = new Set(
      Object.values(unit.metrics).map((m: any) => (m.status === 'excluded' ? m.reason : m.status)),
    );
    expect([...reasons]).toEqual(['no_prs_in_window']);
    expect(unit.anomalies).toEqual([]);
  });

  it('says "we have never measured this bot" for a host-only vendor', async () => {
    const s = seeder();
    s.repo({ id: 10, name: 'app', createdAtMs: now - 400 * DAY });
    base();
    s.user({ id: 2, login: 'deepsource-io', isBot: true });
    s.reviewer({ userId: 2, kind: 'deepsource' });
    const body = await placement();
    const unit = (body.units ?? [])[0] as BotBenchmarkPlacementUnit;
    expect(unit.botKind).toBe('deepsource');
    expect(unit.vendor).toBeNull();
    expect(unit.placement.status).toBe('refused');
    if (unit.placement.status !== 'refused') throw new Error('unreachable');
    expect(unit.placement.reason).toBe('vendor_not_in_corpus_vocabulary');
    expect(unit.placement.message).toMatch(/never measured/i);
  });

  it('says "we have too little of this bot" for an UNSTRATIFIABLE one, with the shortfall', async () => {
    const s = seeder();
    s.repo({ id: 10, name: 'app', createdAtMs: now - 400 * DAY });
    base();
    s.user({ id: 2, login: 'graphite-app', isBot: true });
    s.reviewer({ userId: 2, kind: 'graphite' });
    const body = await placement();
    const unit = unitFor(body, 'graphite');
    expect(unit.placement.status).toBe('refused');
    if (unit.placement.status !== 'refused') throw new Error('unreachable');
    // ⚠ A DIFFERENT SENTENCE FROM "never measured": the corpus MEASURED graphite and then declined
    // to cut it into two bands of thirty. One band is not a coarse stratification, it is the
    // ABSENCE of one — and the artifact's own numbers say how far short.
    expect(unit.placement.reason).toBe('vendor_unstratifiable');
    expect(unit.placement.required?.['n_bands']).toBe(2);
    expect(unit.placement.observed?.['repos_band_support']).toBeGreaterThan(0);
    expect(unit.placement.observed?.['repos_band_support']).toBeLessThan(60);
  });

  it('never widens to a neighbouring band', async () => {
    // devin publishes 2 bands (`2..8`, `9..139`). Whatever this repository's activity, it lands in
    // one of those two — the rule clamps, it does not refuse — so a `cell_not_in_corpus` here can
    // only come from a vendor whose banding and cells disagree, which the artifact never does.
    const s = seeder();
    s.repo({ id: 10, name: 'app', createdAtMs: now - 400 * DAY });
    base();
    s.user({ id: 2, login: 'devin-ai-integration', isBot: true });
    s.reviewer({ userId: 2, kind: 'devin' });
    s.reviewComment({ id: 1, threadId: 1, prId: 1, authorId: 2, body: 'x', atMs: now });
    const body = await placement();
    const unit = unitFor(body, 'devin');
    expect(unit.placement.status).toBe('placed');
    if (unit.placement.status !== 'placed') throw new Error('unreachable');
    expect(unit.placement.nBands).toBe(2);
    expect(unit.placement.activityBand).toBe(0); // six merges, band 0 is 2..8
  });

  it('places a repository sitting exactly ON a band edge in the LOWER band', async () => {
    // ⚠ THE TIE, THROUGH THE WHOLE ROUTE. devin's published bands are `2..8` and `9..139`, so a
    // repository with exactly EIGHT merges in the fortnight is the boundary case: the rule reads
    // the HIGH edges and answers band 0; a `<` instead of a `<=` — or the alternative "last band
    // whose LOW edge is <= the value" reading — answers band 1. The generated 122-case sweep in
    // benchmark-metric-contract.test.ts pins the rule itself; this pins that the ROUTE uses it.
    const place = async (merges: number): Promise<number> => {
      raw.exec('DELETE FROM pull_requests');
      const s = seeder();
      for (let i = 1; i <= merges; i += 1) {
        s.pr({ id: i, repoId: 10, number: i, authorId: 1, merged: true, mergedAgoMs: i * HOUR });
      }
      const unit = unitFor(await placement(), 'devin');
      expect(unit.activity.mergedPrsLast14d).toBe(merges);
      if (unit.placement.status !== 'placed') throw new Error('expected a placement');
      return unit.placement.activityBand;
    };
    const s = seeder();
    s.repo({ id: 10, name: 'app', createdAtMs: now - 400 * DAY });
    s.user({ id: 1, login: 'alice' });
    s.user({ id: 2, login: 'devin-ai-integration', isBot: true });
    s.reviewer({ userId: 2, kind: 'devin' });
    s.thread({ id: 1, prId: 1, path: 'a.ts', line: 1, ageMs: 30 * DAY });
    s.reviewComment({ id: 1, threadId: 1, prId: 1, authorId: 2, body: 'x', atMs: now - 30 * DAY });

    expect(await place(8)).toBe(0);
    expect(await place(9)).toBe(1);
    // …and above every high edge it CLAMPS to the last band rather than refusing, with the
    // overshoot disclosed — the outermost bands are open in the direction they face.
    raw.exec('DELETE FROM pull_requests');
    const many = seeder();
    for (let i = 1; i <= 200; i += 1) {
      many.pr({ id: i, repoId: 10, number: i, authorId: 1, merged: true, mergedAgoMs: HOUR });
    }
    const top = unitFor(await placement(), 'devin');
    if (top.placement.status !== 'placed') throw new Error('expected a placement');
    expect(top.placement.activityBand).toBe(1);
    expect(top.placement.aboveTopBandBy).toBe(200 - 139);
  });

  it('answers `available: false` with ONE banner when no corpus is bundled', async () => {
    process.env.PRO_BENCHMARK_FIT_PATH = fileURLToPath(new URL('./nope.json', import.meta.url));
    (await import('../bots/benchmark/artifact.js')).resetBenchmarkArtifactCache();
    const body = await placement();
    expect(body.available).toBe(false);
    expect(body.reason).toBe('artifact_missing');
    expect(body.message?.length).toBeGreaterThan(20);
    // ⚠ THE SCOPE STILL TRAVELS: the SPA must never receive an object it has to guess about.
    expect(body.workspaceId).toBe(WORKSPACE);
    expect(body.units).toBeUndefined();
  });
});

describe('scope and tenancy', () => {
  beforeEach(() => {
    const s = seeder();
    s.repo({ id: 10, name: 'app', createdAtMs: now - 400 * DAY });
    s.repo({ id: 11, name: 'lib', createdAtMs: now - 400 * DAY });
    s.user({ id: 1, login: 'alice' });
    s.user({ id: 2, login: 'coderabbitai', isBot: true });
    s.reviewer({ userId: 2, kind: 'coderabbit' });
    for (const repoId of [10, 11]) {
      for (let i = 1; i <= 5; i += 1) {
        const id = repoId * 100 + i;
        s.pr({ id, repoId, number: i, authorId: 1, merged: true, mergedAgoMs: i * HOUR });
        s.thread({ id, prId: id, path: 'a.ts', line: i, ageMs: 30 * DAY });
        s.reviewComment({
          id,
          threadId: id,
          prId: id,
          authorId: 2,
          body: 'x'.repeat(40),
          atMs: now - 30 * DAY,
        });
      }
    }
    // ANOTHER TENANT'S repository, with a pull request and a thread of its own. It is in no
    // workspace of account 1 and must never be folded, however it is named on the wire.
    raw
      .prepare(
        'INSERT INTO repos (id, account_id, owner, name, github_node_id, created_at) VALUES (?,?,?,?,?,?)',
      )
      .run(99, 2, 'other', 'secret', 'R_99', secs(now - 400 * DAY));
    raw
      .prepare(
        `INSERT INTO pull_requests
           (id, github_node_id, account_id, repo_id, number, title, author_id, state, opened_at, merged_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(9900, 'PR_9900', 2, 99, 1, 'secret', 1, 'merged', secs(now), secs(now), secs(now));
  });

  it('folds every repository in the workspace, one unit per (repository, vendor)', async () => {
    const body = await placement();
    // ⚠ THE UNIT IS A (repository, vendor) PAIR, NEVER A WORKSPACE AGGREGATE. Two repositories
    // running one bot are TWO placements — a workspace-wide rate is a number no member of any cell
    // resembles, and its percentile is a rank in a distribution it does not belong to.
    expect((body.units ?? []).map((u) => `${u.repoName}|${u.vendor}`).sort()).toEqual([
      'app|coderabbit',
      'lib|coderabbit',
    ]);
    expect(body.truncated).toBe(false);
  });

  it('rolls those two units into ONE vendor card that carries NO percentile of its own', async () => {
    // ⚠ THIS RULE GOT MORE LOAD-BEARING, NOT LESS, WHEN THE ROLLUP ARRIVED. Every distribution in
    // every corpus cell is over (repository, vendor) pairs, so there is no distribution of
    // WORKSPACES to rank one against — the rollup has no cohort and may not compute a percentile at
    // any grain of its own. What it may do is COUNT how its repositories' own percentiles fall
    // around their own cohorts' medians, which is a shape rather than a rank, and carry each
    // repository's percentile in the evidence row it belongs to.
    const body = await placement();
    expect(body.rollup).toHaveLength(1);
    const card = rollupFor(body, 'coderabbit');
    expect(card.liveInRepos).toBe(2);
    expect(card.reposConsidered).toBe(2);
    expect(card.contributions.map((c) => c.repoName).sort()).toEqual(['app', 'lib']);
    // The evidence rows DO carry one each — the key exists, so the assertion below is about where
    // it lives rather than about a word that happens to be missing everywhere.
    for (const c of card.contributions) {
      expect(Object.prototype.hasOwnProperty.call(c, 'percentile')).toBe(true);
    }
    // ⚠ AND NOWHERE ELSE ON THE CARD. Dropping the audit trail leaves the headline, the spread, the
    // expectation and the money — none of which may hold a rank.
    expect(JSON.stringify({ ...card, contributions: undefined })).not.toContain('percentile');
    expect(JSON.stringify(card.spread)).not.toContain('percentile');
    expect(JSON.stringify(card.expectation)).not.toContain('percentile');
  });

  it('treats ?repoIds= as DATA NARROWING ONLY, intersected with the workspace membership', async () => {
    const narrowed = await placement('?repoIds=11');
    expect((narrowed.units ?? []).map((u) => u.repoName)).toEqual(['lib']);
    // ⚠ A FOREIGN REPO ID IN THE QUERY NARROWS TO NOTHING — it cannot WIDEN the scope, because the
    // narrow set is intersected with the resolved workspace's membership rather than replacing it.
    const foreign = await placement('?repoIds=99');
    expect(foreign.units).toEqual([]);
    const mixed = await placement('?repoIds=10,99');
    expect((mixed.units ?? []).map((u) => u.repoName)).toEqual(['app']);
  });

  it('cannot be WIDENED by ?repoIds= to a repository outside the workspace', async () => {
    // ⚠ THE OWN-ACCOUNT, OUT-OF-WORKSPACE CASE, which is the one a foreign id does not exercise:
    // repo 12 belongs to this tenant, so every account-scoped predicate downstream admits it. The
    // ONLY thing keeping it out is that `?repoIds=` is INTERSECTED with the resolved workspace's
    // membership rather than replacing it — the `repoIds ⊆ membership` invariant `BotScopeWire`
    // requires. Without the intersection a query parameter picks the corpus.
    raw
      .prepare(
        'INSERT INTO repos (id, account_id, owner, name, github_node_id, created_at) VALUES (?,?,?,?,?,?)',
      )
      .run(12, ACCOUNT, 'acme', 'unlisted', 'R_12', secs(now - 400 * DAY));
    raw
      .prepare(
        `INSERT INTO pull_requests
           (id, github_node_id, account_id, repo_id, number, title, author_id, state, opened_at, merged_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(1200, 'PR_1200', ACCOUNT, 12, 1, 'x', 1, 'merged', secs(now), secs(now), secs(now));

    const body = await placement('?repoIds=12');
    expect(body.units).toEqual([]);
    const mixed = await placement('?repoIds=10,12');
    expect((mixed.units ?? []).map((u) => u.repoName)).toEqual(['app']);
  });

  it('reads the reviewer table with an EXPLICIT workspace predicate', async () => {
    // ⚠ Every read of `workspace_reviewers` needs one. The same login can be classified
    // differently per workspace — judgement is per workspace by design — and a read scoped only by
    // account collapses a multi-row table one-row-per-author in HEAP ORDER, which flips after any
    // UPDATE on Postgres. Here workspace 2 calls the same actor a HUMAN; workspace 1's judgement is
    // the only one this request may see.
    raw
      .prepare('INSERT INTO workspaces (id, account_id, name, is_default) VALUES (2,?,?,0)')
      .run(ACCOUNT, 'Other');
    // The SAME actor, classified as a DIFFERENT VENDOR in workspace 2. Without the workspace
    // predicate both rows come back and the actor resolves to two vendors at once — or, worse, to
    // whichever row the storage engine happened to return last, which flips after any UPDATE on
    // Postgres.
    raw
      .prepare(
        `INSERT INTO workspace_reviewers
           (account_id, workspace_id, author_user_id, automated, role, confidence, source, kind)
         VALUES (?,2,2,1,'review','high','manual','greptile')`,
      )
      .run(ACCOUNT);
    const body = await placement();
    // Workspace 1 sees coderabbit, on both repositories, and greptile NOWHERE.
    expect((body.units ?? []).map((u) => u.vendor)).toEqual(['coderabbit', 'coderabbit']);
    expect(unitFor(body, 'coderabbit').counters.volume['findingComments']).toBe(5);
  });

  it('resolves an unknown or foreign ?workspace= to the DEFAULT workspace, never a 404', async () => {
    // Host §5.1: absent / unparseable / unknown / another tenant's id all resolve to Default. Not a
    // 404 — every id produces the same response shape, so this is not an existence oracle.
    for (const q of ['?workspace=999', '?workspace=abc', '?workspace=-1', '']) {
      const body = await placement(q);
      expect(body.workspaceId, q).toBe(WORKSPACE);
      expect((body.units ?? []).length, q).toBe(2);
    }
  });
});

describe('the per-request bounds', () => {
  it('caps the repositories folded and SAYS SO — never a silent truncation', async () => {
    // ⚠ The repository count is the cost driver (each one reads up to its own walk budget of pull
    // requests and everything hanging off them), so the cap bounds the work per request while the
    // rate tier bounds the request count. Over the cap the omitted repositories are NOT "no data",
    // so `truncated` rides the response and the caller narrows with `?repoIds=`.
    const s = seeder();
    s.user({ id: 1, login: 'alice' });
    s.user({ id: 2, login: 'coderabbitai', isBot: true });
    s.reviewer({ userId: 2, kind: 'coderabbit' });
    for (let r = 1; r <= 15; r += 1) {
      s.repo({ id: r, name: `repo-${String(r).padStart(2, '0')}`, createdAtMs: now - 400 * DAY });
      s.pr({ id: r * 100, repoId: r, number: 1, authorId: 1, merged: true, mergedAgoMs: HOUR });
    }
    const body = await placement();
    expect(body.truncated).toBe(true);
    expect(new Set((body.units ?? []).map((u) => u.repoId)).size).toBe(12);
    // Deterministic, so a caller paging with ?repoIds= sees a stable frontier rather than a
    // reshuffle on every request.
    expect((body.units ?? []).map((u) => u.repoName)).toEqual(
      Array.from({ length: 12 }, (_, i) => `repo-${String(i + 1).padStart(2, '0')}`),
    );
  });

  it('folds only the walk_budget most-recently-updated pull requests', async () => {
    // ⚠ THE ONE FIDELITY CHOICE IN THE CONTRACT. The corpus walked `min(150, round(p*90/14))` pull
    // requests, ordered UPDATED_AT DESC, and stopped — a cap that actually bound in 85.5 % of live
    // repositories in the median cell. A customer folding over their whole synced history measures
    // an older, wider population than any cell describes: older threads, higher overdue rates,
    // lower reply rates. Without the LIMIT this repository's 40 stale pull requests all count.
    const s = seeder();
    s.repo({ id: 10, name: 'app', createdAtMs: now - 400 * DAY });
    s.user({ id: 1, login: 'alice' });
    s.user({ id: 2, login: 'coderabbitai', isBot: true });
    s.reviewer({ userId: 2, kind: 'coderabbit' });
    // Two merges inside the fortnight ⇒ walkBudget = round(2 * 90 / 14) = 13.
    for (let i = 1; i <= 2; i += 1) {
      s.pr({ id: i, repoId: 10, number: i, authorId: 1, merged: true, mergedAgoMs: i * HOUR });
    }
    // …twenty older MERGED pull requests, each carrying an unanswered thread…
    for (let i = 100; i < 120; i += 1) {
      s.pr({ id: i, repoId: 10, number: i, authorId: 1, merged: true, mergedAgoMs: 90 * DAY });
      s.thread({ id: i, prId: i, path: 'old.ts', line: i, ageMs: 200 * DAY });
      s.reviewComment({
        id: i,
        threadId: i,
        prId: i,
        authorId: 2,
        body: 'x'.repeat(40),
        atMs: now - 200 * DAY,
      });
    }
    // …and twenty OPEN ones, older still. ⚠ THE ORDER IS AS LOAD-BEARING AS THE LIMIT: the corpus
    // walked UPDATED_AT **DESC**. Taking the oldest thirteen instead would fold thirteen open pull
    // requests and put the volume denominator at zero — a plausible-looking answer about a
    // population the cohort never measured.
    for (let i = 200; i < 220; i += 1) {
      s.pr({ id: i, repoId: 10, number: i, authorId: 1, merged: false, mergedAgoMs: 300 * DAY });
    }
    const unit = unitFor(await placement(), 'coderabbit');
    expect(unit.activity.mergedPrsLast14d).toBe(2);
    expect(unit.activity.walkBudget).toBe(13);
    expect(unit.activity.prsConsidered).toBe(13);
    // The thirteen most recently updated are the two recent merges plus eleven of the older
    // merges — every one of them merged, so the volume denominator is 13, not the 42 rows the
    // database holds and not the 0 an ascending sort would produce.
    expect(unit.counters.volume['mergedEligible']).toBe(13);
    expect(unit.counters.repository['prsObserved']).toBe(13);
  });

  it('keeps the belt-and-braces account predicate on the repository read itself', async () => {
    // ⚠ DEFENCE IN DEPTH, PINNED AT ITS OWN GRAIN. Through the route this predicate is redundant —
    // `resolveWorkspaceRepoIds` is already account-scoped, so a foreign id never reaches here. That
    // redundancy is exactly why it would be deleted as dead weight, and why it is tested directly:
    // `reposInScope` is the function a future caller might hand a scope from somewhere else.
    const { reposInScope } = await import('../bots/benchmark/collect.js');
    raw
      .prepare(
        'INSERT INTO repos (id, account_id, owner, name, github_node_id, created_at) VALUES (?,?,?,?,?,?)',
      )
      .run(99, 2, 'other', 'secret', 'R_99', secs(now));
    raw
      .prepare(
        'INSERT INTO repos (id, account_id, owner, name, github_node_id, created_at) VALUES (?,?,?,?,?,?)',
      )
      .run(10, ACCOUNT, 'acme', 'app', 'R_10', secs(now));
    const rows = await reposInScope({ db: ctx.db, schema: coreSchema } as any, ACCOUNT, {
      workspaceId: WORKSPACE,
      repoIds: [10, 99],
    });
    expect(rows.map((r) => r.id)).toEqual([10]);
  });
});

describe('cost — what the reviewer costs per unit of the work it produces', () => {
  /** Threads per pull request in `seedPriced`. ⚠ IT IS FIVE RATHER THAN ONE FOR ONE REASON: the
   *  per-acted-on money refuses under `COST_WINDOW_MIN_ACTED` acted-on threads inside the cost
   *  window, and one-per-pull-request gave this estate TWO. A fixture under that floor would have
   *  exercised `window_underpopulated` while every assertion below read as if it were testing the
   *  happy path — the same trap the span comment two paragraphs down records. Scaling the THREADS
   *  and not the pull requests keeps `mergedPrsLast14d`, the band and `perMergedPr` exactly where
   *  they were, and keeps `acted_on_rate` at 0.2. */
  const THREADS_PER_PR = 5;

  /**
   * A repository with clean, assertable arithmetic: TEN merged human pull requests in the window,
   * FIFTY settled threads (five per pull request), TEN of them resolved.
   *
   *   threads_per_merged_pr = 50 ÷ 10 = 5.0      acted_on_rate = 10 ÷ 50 = 0.2
   *
   * Both clear their `minUnits: 5` floors, so both are real comparisons rather than refusals — the
   * cost block needs BOTH of the customer's own rates and a seed that produced neither would test
   * the refusal path while looking like it tested the happy one.
   *
   * ⚠ EVERY THREAD IS 30 DAYS OLD, so its SETTLE POINT — creation plus the 72-hour settle window —
   * lands 27 days ago, inside the cost window at both ends. That is what the per-acted-on money
   * counts, and a fixture aged past it would refuse `nothing_acted_on` while looking healthy.
   */
  const seedPriced = (opts: { monthlyCents?: number; costModel?: string } = {}): void => {
    const s = seeder();
    s.repo({ id: 10, name: 'app', createdAtMs: now - 400 * DAY });
    s.user({ id: 1, login: 'alice' });
    s.user({ id: 2, login: 'coderabbitai', isBot: true, githubType: 'Bot' });
    s.reviewer({
      userId: 2,
      kind: 'coderabbit',
      ...(opts.monthlyCents == null ? {} : { monthlyCents: opts.monthlyCents }),
      ...(opts.costModel == null ? {} : { costModel: opts.costModel }),
    });
    for (let i = 1; i <= 10; i += 1) {
      s.pr({ id: i, repoId: 10, number: i, authorId: 1, merged: true, mergedAgoMs: i * HOUR });
      for (let t = 0; t < THREADS_PER_PR; t += 1) {
        const threadId = i * 10 + t;
        s.thread({
          id: threadId,
          prId: i,
          path: `src/f${i}-${t}.ts`,
          line: i * 10 + t,
          resolved: i <= 2,
          ageMs: 30 * DAY,
        });
        // ⚠ THE COMMENTS ARE SPREAD ACROSS NINE DAYS ON PURPOSE. The evidence table publishes the
        // stretch of time this reviewer's own output covers, so a fixture that stamped all of them
        // at one instant would report no observation period at all — which is exactly what the
        // first draft of this helper did, back when that stretch was also the money's divisor.
        s.reviewComment({
          id: 1000 + threadId,
          threadId,
          prId: i,
          authorId: 2,
          body: 'x'.repeat(40),
          atMs: now - (39 - i) * DAY,
        });
      }
    }
  };

  /** A SECOND repository this reviewer is live in, sized so its own `acted_on_rate` falls under the
   *  `minUnits: 5` floor: THREE settled threads, all three resolved. Its rate is therefore withheld
   *  and its COUNTS still pool — which is the whole of rule 3, and the thing that makes the two
   *  comparison populations differ. */
  const seedThinSecondRepo = (): void => {
    const s = seeder();
    s.repo({ id: 11, name: 'lib', createdAtMs: now - 400 * DAY });
    for (let i = 1; i <= 6; i += 1) {
      s.pr({ id: 1100 + i, repoId: 11, number: i, authorId: 1, merged: true, mergedAgoMs: i * HOUR });
    }
    for (let i = 1; i <= 3; i += 1) {
      s.thread({ id: 1100 + i, prId: 1100 + i, path: `lib/f${i}.ts`, line: i, resolved: true, ageMs: 30 * DAY });
      s.reviewComment({
        id: 1200 + i,
        threadId: 1100 + i,
        prId: 1100 + i,
        authorId: 2,
        body: 'x'.repeat(40),
        atMs: now - (20 - i) * DAY,
      });
    }
  };

  it('renders NO COST BLOCK AT ALL when no price is set — absent, not empty and not zero', async () => {
    // ⚠ THE RULE THE WHOLE FEATURE TURNS ON. `monthly_cents` NULL means nobody has said what this
    // reviewer costs. A block reading "US$0.00 per acted-on thread" would be a claim about a
    // reviewer nobody priced, and an empty card would be a promise the data cannot keep.
    seedPriced();
    const body = await placement();
    const card = rollupFor(body, 'coderabbit');
    expect(card.liveInRepos).toBe(1);
    expect(card.cost).toBeUndefined();
    // …and the key is absent from the WIRE, which is the claim that matters: the SPA branches on
    // `rollup.cost != null` and renders no money at all for this reviewer.
    //
    // ⚠ THIS PAIR CANNOT DISTINGUISH "never assigned" FROM "assigned undefined" — `res.json()` has
    // already been through `JSON.stringify`, which drops an own property whose value is
    // `undefined`. Recorded rather than dressed up, because a test that looks like it pins the
    // in-memory shape and does not is exactly the kind this package has shipped six of.
    expect(Object.prototype.hasOwnProperty.call(card, 'cost')).toBe(false);
    expect(JSON.stringify(card)).not.toContain('"cost"');
    // …and the sections that owe the corpus nothing still render: the counters and the evidence
    // table are the customer's own facts and do not wait on a price.
    expect(card.counters.outcome['threadsSettledComplete']).toBe(50);
    expect(card.contributions).toHaveLength(1);
  });

  it('states money ONLY on the rollup — never on any per-repository unit', async () => {
    // ⚠ THE GRAIN RULE, AS A STRUCTURAL CLAIM. A unit is one (repository, vendor) pair and the price
    // is per WORKSPACE, so any money on a unit is the whole subscription measured against one
    // repository's work: an upper bound wearing the grammar of a fact. Six repositories of
    // CodeRabbit shipped six blocks each carrying the same US$120, under a "do not add these up"
    // disclosure that was a caveat compensating for a grain mismatch. The grain moved instead, and
    // this is the assertion that keeps it moved.
    seedPriced({ monthlyCents: 12_000 });
    const body = await placement();
    expect(rollupFor(body, 'coderabbit').cost?.monthlyUsd).toBe(120);
    for (const unit of body.units ?? []) {
      expect(Object.prototype.hasOwnProperty.call(unit, 'cost')).toBe(false);
      expect(JSON.stringify(unit)).not.toContain('"cost"');
      expect(JSON.stringify(unit)).not.toContain('monthlyUsd');
    }
    // ⚠ AND THE RETIRED DISCLOSURE IS GONE WITH IT. `sharedWithUnits` counted how many cards in one
    // response carried this same price so the panel could tell the reader not to add them up; there
    // is now ONE card, so adding is not something a reader can do and the count says nothing.
    expect(JSON.stringify(body)).not.toContain('sharedWithUnits');
  });

  it('builds NO rollup — and therefore no money anywhere — for a ?repoIds=-narrowed request', async () => {
    // ⚠ THE STRUCTURAL HALF OF "NO MONEY IN A REPO-GRAINED VIEW", and it is deliberately not a UI
    // convention: the guarantee has to be "there is no figure in the payload to find" rather than
    // "every present and future renderer declines to draw the one that is". The SPA's per-repository
    // Bots tab is exactly a `?repoIds=<one id>` call.
    //
    // ⚠ AND IT IS THE NARROWING THAT DECIDES, NOT THE RESULTING REPOSITORY COUNT — which is what
    // this single-repository workspace pins. The un-narrowed call and the narrowed one resolve to
    // the SAME scope and fold the SAME repository; only the second is denied the money, because the
    // caller has said it is asking a per-repository question.
    seedPriced({ monthlyCents: 12_000 });
    const whole = await placement();
    expect((whole.units ?? []).map((u) => u.repoId)).toEqual([10]);
    expect(whole.rollup).toHaveLength(1);
    expect(rollupFor(whole, 'coderabbit').cost?.monthlyUsd).toBe(120);

    const narrowed = await placement('?repoIds=10');
    expect((narrowed.units ?? []).map((u) => u.repoId)).toEqual([10]);
    // ⚠ ABSENT, NEVER `[]` — the wire type distinguishes them: `[]` says the fold ran and no vendor
    // was live anywhere, the missing key says it did not run.
    expect(narrowed.rollup).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(narrowed, 'rollup')).toBe(false);
    expect(JSON.stringify(narrowed)).not.toContain('"cost"');
    expect(JSON.stringify(narrowed)).not.toContain('monthlyUsd');
    expect(JSON.stringify(narrowed)).not.toContain('perActedOnUsd');
  });

  it('prices merged PRs on the fortnight and the REVIEWER as a rate over its observed pace', async () => {
    seedPriced({ monthlyCents: 12_000 });
    const body = await placement();
    const card = rollupFor(body, 'coderabbit');
    const cost = card.cost;
    if (cost == null) throw new Error('expected a cost block');
    expect(cost.monthlyUsd).toBe(120);
    expect(cost.costModel).toBe('flat');
    expect(cost.windowDays).toBe(14);
    // 120 × 14 ÷ 30.44 — a month is not 28 days and it is not 30.
    expect(cost.windowUsd).toBe(55.190539);
    // ⚠ THE DENOMINATOR'S SIZE IS PART OF THE CLAIM: "US$5.52 per merged PR" over one repository and
    // over nine are different assertions, so the estate this is summed over rides the block.
    expect(cost.coveredRepos).toBe(1);
    expect(card.liveInRepos).toBe(1);
    expect(card.reposConsidered).toBe(1);
    expect(cost.spanUnobservedRepos).toBe(0);
    expect(cost.partialWindowRepos).toBe(0);
    expect(unitFor(body, 'coderabbit').activity.mergedPrsLast14d).toBe(10);
    expect(cost.perMergedPr).toEqual({ status: 'value', value: 5.519054, mergedPrs: 10 });

    // ⚠ THE SPAN IS READ OFF THIS REVIEWER'S OWN COMMENTS, END TO END, AND IT IS NOW PER REPOSITORY.
    // Ten of them, spread from 38 to 29 days ago, is nine days — and that stretch is the window the
    // WORK was measured over, which is all it is. It rides the EVIDENCE ROW rather than the money
    // block, because an estate has no one span: the per-month pace below is a SUM of per-repository
    // rates, and a union of these stretches would measure time nobody was working.
    expect(cost).not.toHaveProperty('span');
    expect(card.contributions).toHaveLength(1);
    expect(card.contributions[0]?.spanDays).toBe(9);
    expect(card.contributions[0]?.settledThreads).toBe(50);
    expect(card.contributions[0]?.actedThreads).toBe(10);
    expect(card.contributions[0]?.actedOnRate).toBe(0.2);
    // ⚠ AND THE SPAN CARRIES NO MONEY. It shipped with a `usd` field holding today's price prorated
    // across it (US$35.48 here), and every reviewer-side figure was a share of that — a past spend
    // the app cannot evidence, since the price may have changed and the subscription may be younger
    // than the span. The field is DELETED rather than capped.
    expect(JSON.stringify(card)).not.toContain('35.479632');

    if (cost.yours.status !== 'value') throw new Error('expected the customer’s own figures');
    // ⚠ REAL COUNTS, INSIDE THE COST WINDOW: fifty settled threads, ten of them resolved, every one
    // settling 27 days ago. Not `10 merges × 5.0 threads × 0.2`, which happens to give the same 10
    // here and is a coincidence of this fixture.
    expect(cost.yours.settledThreads).toBe(50);
    expect(cost.yours.actedThreads).toBe(10);
    expect(cost.yours.actedOnRate).toBe(0.2);
    // ⚠ THE WINDOW IS ONE CALENDAR MONTH, SO THE COUNT IS ALREADY THE PACE. `US$120 ÷ 10` is the
    // whole arithmetic, and both of its halves are printed on the card beside it.
    expect(cost.yours.actedPerMonth).toBe(10);
    expect(cost.yours.actedPerMonth).toBe(cost.yours.actedThreads);
    expect(cost.yours.perActedOnUsd).toBe(12); // 120 ÷ 10
    expect(cost.monthlyUsd! / cost.yours.actedThreads).toBe(cost.yours.perActedOnUsd);
    // ⚠ THE FIGURE THE OBSERVED-SPAN BASIS WOULD HAVE PRINTED, NAMED so the regression is not
    // silent: 10 × 30.44 ÷ 9 = 33.822222 a month, and 120 ÷ that is US$3.55 — a third of the truth,
    // because this reviewer's comments happen to span nine days rather than a month. On the real
    // erxes card the same slip ran the other way and printed US$23.94 against US$3.22.
    expect(cost.yours.perActedOnUsd).not.toBe(3.548);
    // …and the fortnight-price-over-slice-work figure the projection basis would have given:
    expect(cost.yours.perActedOnUsd).not.toBe(5.519054);
    // ⚠ THE BASIS SENTENCE PRINTS BOTH HALVES, so the division is checkable from the card alone —
    // the property the version this replaced did not have.
    expect(cost.basisNote).toContain('US$120.00 a month');
    expect(cost.basisNote).toContain('10 comments your team used in the last 30 days');
    expect(cost.costWindowDays).toBe(30.44);
    expect(cost.costWindowIncompleteRepos).toBe(0);
    // …and the two figures that DID move are rates at the monthly price, not shares of a span.
    if (cost.unacted.status !== 'value') throw new Error('unreachable');
    expect(cost.unacted.unactedUsd).toBe(96); // 120 × 0.8 a month, never 35.479632 × 0.8 = 28.38
    expect(cost.unacted.unactedUsd).not.toBe(28.383706);

    // …and the counts are `acted_on_rate`'s OWN numerator and denominator, so the rate on the card
    // and the metric row on the repository's own card cannot disagree.
    const rate = unitFor(body, 'coderabbit').metrics['acted_on_rate'];
    if (rate == null || rate.status === 'excluded') throw new Error('expected a measured rate');
    expect(cost.yours.actedThreads / cost.yours.settledThreads).toBeCloseTo(rate.value, 9);
    expectAllFinite(card);
  });

  it('swaps EXACTLY ONE FACTOR for the counterfactual, through the real cohort', async () => {
    seedPriced({ monthlyCents: 12_000 });
    const body = await placement();
    const unit = unitFor(body, 'coderabbit');
    const card = rollupFor(body, 'coderabbit');
    const cost = card.cost;
    if (cost == null) throw new Error('expected a cost block');
    if (cost.yours.status !== 'value') throw new Error('unreachable');
    const peer = card.expectation;
    if (peer.status !== 'value') throw new Error('expected an estate-matched expectation');
    const tpp = unit.metrics['threads_per_merged_pr'];
    const acted = unit.metrics['acted_on_rate'];
    if (tpp?.status !== 'compared') throw new Error('expected a thread-rate comparison');
    if (acted?.status !== 'compared') throw new Error('expected an engagement comparison');
    // ⚠ THE MONTHLY PRICE IS THE BASIS OF EVERY FIGURE BELOW — not a spend prorated over the span,
    // which is what these assertions were written against before the money became a rate.
    const monthlyUsd = cost.monthlyUsd;
    if (monthlyUsd == null) throw new Error('expected a statable price');
    const median = acted.cohort.quantiles['p50'] as number;
    expect(median).toBeGreaterThan(0);

    // ⚠ THE GUARD THAT KEEPS THE ASSERTIONS BELOW FROM BEING VACUOUS. If the cohort's median thread
    // rate happened to make `merges × threadRate` equal the customer's settled count, an
    // implementation that let a SECOND cohort quantile into the counterfactual would produce
    // identical numbers and nothing here could tell them apart.
    const cohortThreads = tpp.cohort.quantiles['p50'] as number;
    expect(cohortThreads).not.toBe(tpp.value);
    expect(unit.activity.mergedPrsLast14d * cohortThreads).not.toBeCloseTo(cost.yours.settledThreads, 6);

    // YOUR settled threads, YOUR price, THEIR engagement rate — and nothing else moves. At one
    // fitted repository `Σ_r (settled_r × median_r)` has one term, so the swap is visible bare.
    expect(peer.fittedRepos).toBe(1);
    expect(peer.excludedRepos).toBe(0);
    expect(peer.actedAtPeer).toBeCloseTo(cost.yours.settledThreads * median, 6);
    expect(peer.expectedRate).toBeCloseTo(median, 6);
    // …which is a DIFFERENT number from any version built on the cohort's THREAD rate, so a second
    // quantile creeping in is observable here.
    expect(peer.actedAtPeer).not.toBeCloseTo(
      unit.activity.mergedPrsLast14d * cohortThreads * median,
      6,
    );
    // ⚠ THE COUNTERFACTUAL IS ON THE SAME CALENDAR MONTH AS THE MEASURED FIGURE, because the two
    // sit in adjacent rows of one table. Its count is the WINDOW's settled threads met with the
    // cohort's median — `actedAtPeer` above is the same swap over the whole read slice, which is
    // what `expectedRate` is computed from, and the two are deliberately different numbers.
    expect(peer.actedPerMonthAtPeer).toBeCloseTo(cost.yours.settledThreads * median, 6);
    expect(peer.perActedOnUsd).toBeCloseTo(monthlyUsd / (peer.actedPerMonthAtPeer ?? 0), 4);
    expect(peer.moneyRefusal).toBeNull();

    // ⚠ TWO MONEY FIGURES, TWO QUESTIONS, AND BOTH ARE RATES AT THE CURRENT PRICE. What the price
    // currently buys unacted is the customer's own rate against their own monthly price; what
    // closing the gap is WORTH is a difference of two rates against the same price. They are
    // different numbers, and the headline printed the second under the first's words.
    if (cost.unacted.status !== 'value') throw new Error('unreachable');
    expect(cost.unacted.unactedUsd).toBeCloseTo(monthlyUsd * (1 - cost.yours.actedOnRate), 6);
    expect(peer.conversionGapUsd).toBeCloseTo(
      monthlyUsd * (peer.expectedRate - peer.yoursRateOnFitted),
      6,
    );
    expect(cost.unacted.unactedUsd).not.toBeCloseTo(peer.conversionGapUsd ?? 0, 6);
    // ⚠ AND BOTH ARE BOUNDED BY THE MONTHLY PRICE THEY ARE A SHARE OF, in both directions — the
    // ratio they replaced was not, and rendered figures several times the total. ⚠ NAMED AGAINST
    // THE OLD BASIS TOO: a span-prorated figure at this fixture is US$35.48, so a revert would
    // shrink both by a factor of four and this bound would still pass — which is why the two
    // arithmetic assertions above name `monthlyUsd` explicitly rather than leaning on the bound.
    expect(Math.abs(peer.conversionGapUsd ?? 0)).toBeLessThanOrEqual(monthlyUsd);
    expect(cost.unacted.unactedUsd).toBeLessThanOrEqual(monthlyUsd);
    expectAllFinite(card);
  });

  it('keeps the comparison’s TWO POPULATIONS apart, and publishes both denominators', async () => {
    // ⚠⚠ THE DEFECT docs/PERIOD-REPORTING.md CALLS "ONE ROW MUST NEVER MIX THE HEADLINE AND SUBSET
    // POPULATIONS", shipped three times there before it was believed, and this is the shape that
    // makes it observable end to end. `expectedRate` can only be computed over the repositories
    // whose cohort published a median — the FITTED subset — so the customer's rate it is set against
    // must be computed over the SAME subset. The card's headline rate is pooled over EVERY live
    // repository and is a different number.
    //
    // Repository `app` compares (ten settled threads, two acted). Repository `lib` does NOT: three
    // settled threads is under `acted_on_rate`'s `minUnits: 5` floor, so its own rate is withheld —
    // and all three of its threads were acted on, so the two populations disagree loudly.
    seedPriced({ monthlyCents: 12_000 });
    seedThinSecondRepo();
    const body = await placement();
    const card = rollupFor(body, 'coderabbit');
    const cost = card.cost;
    if (cost == null) throw new Error('expected a cost block');
    if (cost.unacted.status !== 'value') throw new Error('unreachable');
    const peer = card.expectation;
    if (peer.status !== 'value') throw new Error('expected an estate-matched expectation');

    expect(card.liveInRepos).toBe(2);
    // ⚠ RULE 3: THE GATE APPLIES TO THE ROW, NOT TO THE FOLD. `lib`'s rate is withheld in the
    // evidence table — a rate over three threads is exactly the number that gate exists to refuse —
    // while its COUNTS pool into the headline, because pooling is the remedy for a thin sample.
    const lib = card.contributions.find((c) => c.repoName === 'lib');
    expect(lib?.actedOnRate).toBeNull();
    expect(lib?.percentile).toBeNull();
    expect(lib?.settledThreads).toBe(3);
    expect(lib?.actedThreads).toBe(3);

    // THE HEADLINE, over every live repository: 13 of 53.
    expect(cost.unacted.settledThreads).toBe(53);
    expect(cost.unacted.actedThreads).toBe(13);
    expect(cost.unacted.actedOnRate).toBe(0.245283);
    // THE SUBSET, over the one repository with a fitted cohort median: 10 of 50.
    expect(peer.yoursRateOnFitted).toBe(0.2);
    expect(peer.fittedRepos).toBe(1);
    expect(peer.excludedRepos).toBe(1);
    // ⚠ THE ASSERTION THE WHOLE TEST EXISTS FOR. Two populations, two fields, never one row — and
    // both denominators on the wire so a renderer is physically able to label them apart.
    expect(peer.yoursRateOnFitted).not.toBe(cost.unacted.actedOnRate);
    expect(peer.fittedRepos).not.toBe(card.liveInRepos);
    // …and the gap is priced against the SUBSET's rate, never the headline's.
    expect(peer.conversionGapUsd).toBeCloseTo(120 * (peer.expectedRate - peer.yoursRateOnFitted), 6);
    expect(peer.conversionGapUsd).not.toBeCloseTo(
      120 * (peer.expectedRate - cost.unacted.actedOnRate),
      6,
    );

    // ⚠ AND ONE PLACED REPOSITORY IS NOT A SPREAD. `lib` is placed but its metric never compared,
    // so it holds no percentile — the spread's population is narrower again, and it refuses rather
    // than inviting a pattern to be read out of a single point.
    expect(card.spread.status).toBe('refused');
    if (card.spread.status !== 'refused') throw new Error('unreachable');
    expect(card.spread.reason).toBe('single_repo');
    expectAllFinite(card);
  });

  it('renders a price of exactly 0 as a REAL price and refuses every figure derived from it', async () => {
    // ⚠ 0 IS NOT "no price". It is "we pay nothing for this", deliberately recorded — so the price
    // renders. Every figure divided out of it is exactly 0.00, which is TRUE and reads as a broken
    // panel, so the derived figures refuse with a sentence instead.
    seedPriced({ monthlyCents: 0 });
    const card = rollupFor(await placement(), 'coderabbit');
    const cost = card.cost;
    if (cost == null) throw new Error('a stored 0 must still produce a block');
    expect(cost.monthlyUsd).toBe(0);
    expect(cost.windowUsd).toBe(0);
    expect(cost.seatCountZero).toBe(0); // ⚠ A STORED zero, reached without a seat count at all
    for (const arm of [cost.perMergedPr, cost.unacted, cost.yours]) {
      expect(arm.status).toBe('refused');
      if (arm.status !== 'refused') throw new Error('unreachable');
      expect(arm.reason).toBe('price_is_zero');
      // ⚠ AND NOT A SINGLE 0.00 FIGURE ANYWHERE IN THE BLOCK — reading one off a refusal must be
      // impossible, which is what the discriminated union buys. ⚠ ON THE LIVE VALUES, never on a
      // serialisation: a refusal leaking a NON-ZERO figure passes a `/"value":0/` regex and fails
      // these lines, and when it fails it names the arm rather than the whole payload.
      expect(arm, arm.reason).not.toHaveProperty('value');
      expect(arm, arm.reason).not.toHaveProperty('perActedOnUsd');
      expect(arm, arm.reason).not.toHaveProperty('unactedUsd');
    }
    // ⚠ THE COMPARISON IS A SIBLING OF THE MONEY AT THIS GRAIN, AND ITS RATES SURVIVE. They are the
    // customer's own measurements met with the corpus's, and withholding them because nobody could
    // state a price would delete a real finding for want of an unrelated fact. Only the two MONEY
    // halves go quiet — with the SAME refusal object the cost arms carry, so one cause never
    // produces two accounts of itself on one card.
    const peer = card.expectation;
    if (peer.status !== 'value') throw new Error('the rates do not wait on a price');
    expect(peer.expectedRate).toBeGreaterThan(0);
    expect(peer.yoursRateOnFitted).toBe(0.2);
    expect(peer.perActedOnUsd).toBeNull();
    expect(peer.conversionGapUsd).toBeNull();
    expect(peer.moneyRefusal?.reason).toBe('price_is_zero');
    expectAllFinite(card);
  });

  it('DROPS a per-seat price against a ZERO seat count instead of reporting it as free', async () => {
    // ⚠ A COMPUTED ZERO IS NOT A STORED ZERO, END TO END. `workspaceHumanSeatCount` answers 0 for a
    // workspace with no human pull-request authors in the trailing 30 days — a maintenance-mode
    // repository whose recent pull requests are all a bot's, which still MERGES, so neither
    // repository gate fires. Multiplying US$15 a developer by it gave a monthly figure of exactly
    // 0, indistinguishable from a stored 0, and the block printed "recorded as free" about a
    // reviewer somebody priced.
    seatCountAnswer = 0;
    seedPriced({ monthlyCents: 1_500, costModel: 'per_seat' });
    // ⚠ AND IT IS NOT SILENCE EITHER — the second half of the same fix. Dropping the row and then
    // answering "no price" hands this workspace the NO-BLOCK experience, so `seatCountZero` reaches
    // the screen only when some OTHER login keeps the card alive — which is not the shape the
    // counter was written for, and leaves a card that says nothing where somebody typed US$15 a
    // developer. The block renders with NO monthly figure and every arm refusing.
    const card = rollupFor(await placement(), 'coderabbit');
    const cost = card.cost;
    if (cost == null) throw new Error('an entered price must still produce a block');
    expect(cost.monthlyUsd).toBeNull();
    expect(cost.windowUsd).toBeNull();
    expect(cost.seatCountZero).toBe(1);
    expect(cost.pricedReviewers).toBe(0);
    for (const arm of [cost.perMergedPr, cost.unacted, cost.yours]) {
      expect(arm.status).toBe('refused');
      if (arm.status !== 'refused') throw new Error('unreachable');
      // ⚠ ITS OWN SENTENCE, NEVER `price_is_zero`. "Recorded as free" about a reviewer priced at
      // US$15 a developer is the exact false claim this whole branch exists to prevent.
      expect(arm.reason).toBe('price_unresolved');
    }
    if (card.expectation.status !== 'value') throw new Error('the rates do not wait on a price');
    expect(card.expectation.moneyRefusal?.reason).toBe('price_unresolved');
    expectAllFinite(card);
    // …and with a real seat count the same seed is a full US$120 block, so the branch above is a
    // genuine drop and not simply a workspace with no price.
    seatCountAnswer = 8;
    expect(rollupFor(await placement(), 'coderabbit').cost?.monthlyUsd).toBe(120);
  });

  it('discloses the dropped ZERO-SEAT price when another reviewer keeps the block alive', async () => {
    // ⚠ THE DISCLOSURE IS THE HALF THAT MATTERS. With a second priced login on the same card the
    // block survives, and a silently-excluded per-seat price would understate the figure with
    // nothing on screen to say so — "a missing disclosure is the same defect as a wrong number, one
    // line quieter", which is why it is a COUNTER and not a boolean.
    seatCountAnswer = 0;
    seedPriced({ monthlyCents: 1_500, costModel: 'per_seat' });
    const s = seeder();
    s.user({ id: 6, login: 'coderabbitai-enterprise', isBot: true, githubType: 'Bot' });
    s.reviewer({ userId: 6, kind: 'coderabbit', monthlyCents: 4_000 });
    const cost = rollupFor(await placement(), 'coderabbit').cost;
    if (cost == null) throw new Error('the flat-priced login still carries the block');
    expect(cost.monthlyUsd).toBe(40);
    expect(cost.seatCountZero).toBe(1);
    // ⚠ ITS OWN COUNTER, NOT THE SEAM-ABSENT ONE. Two facts, two remedies.
    expect(cost.seatPriceUnresolved).toBe(0);
    expect(cost.pricedReviewers).toBe(1);
  });

  it('multiplies a per-seat price by the workspace seat count ON READ, and shows both halves', async () => {
    seatCountAnswer = 8;
    seedPriced({ monthlyCents: 1_500, costModel: 'per_seat' });
    const cost = rollupFor(await placement(), 'coderabbit').cost;
    if (cost == null) throw new Error('expected a cost block');
    // ⚠ US$15 per developer × 8 seats. The product is NEVER stored — it can exceed int4 as cents
    // and would go stale — so a build that read the stored 1500 as the monthly figure would report
    // this reviewer at one eighth of its price. ⚠ AND THE MULTIPLY HAPPENS ONCE PER VENDOR NOW,
    // through `resolveUnitPrice` and nowhere else, which is the grain the price was always stored
    // at; the seat count is one query per REQUEST rather than one per (repository, vendor) pair.
    expect(cost.monthlyUsd).toBe(120);
    expect(cost.unitMonthlyUsd).toBe(15);
    expect(cost.seats).toBe(8);
    expect(cost.costModel).toBe('per_seat');
    expect(cost.windowUsd).toBe(55.190539);
  });

  it('DROPS a per-seat price when the host does not implement the seat seam', async () => {
    // ⚠ THE OPTIONAL-SEAM DEGRADATION, and it degrades ONE reading rather than the plugin. Reading
    // the per-developer unit as the monthly figure would understate the cost by the seat count,
    // silently and in the direction that flatters the reviewer — so the price is excluded instead.
    seatCountAnswer = null;
    seedPriced({ monthlyCents: 1_500, costModel: 'per_seat' });
    const cost = rollupFor(await placement(), 'coderabbit').cost;
    // ⚠ THE SAME SHAPE AS A ZERO SEAT COUNT — a block with no monthly figure — but a DIFFERENT
    // counter, because "implement the seam" and "your Workspace has no human authors this month"
    // are different remedies.
    expect(cost?.monthlyUsd).toBeNull();
    expect(cost?.seatPriceUnresolved).toBe(1);
    expect(cost?.seatCountZero).toBe(0);
    // …and with a seat count it is the full US$120, so the branch above is a real degradation and
    // not simply a workspace with no price.
    seatCountAnswer = 8;
    expect(rollupFor(await placement(), 'coderabbit').cost?.monthlyUsd).toBe(120);
  });

  it('gives a priced reviewer that said nothing anywhere NO CARD — absent, never a column of zeros', async () => {
    // ⚠ THE DECLARED LINEUP EMITS A UNIT PER REVIEWER PER REPOSITORY, so a bot nobody has installed
    // arrives at the fold with n all-zero units. A card for it would be a column of zeros about a
    // reviewer that has not been given the chance to do anything — the "missing thing rendered as a
    // zero" this whole tab exists to refuse — and, worse, its silent repositories' merge counts
    // would land in the denominator of a cost figure it had no part in.
    seedPriced({ monthlyCents: 12_000 });
    const s = seeder();
    s.user({ id: 5, login: 'greptileai', isBot: true, githubType: 'Bot' });
    s.reviewer({ userId: 5, kind: 'greptile', monthlyCents: 6_000 });
    const body = await placement();
    expect((body.rollup ?? []).map((r) => r.key)).toEqual(['coderabbit']);
    // …and the PER-REPOSITORY answer is unchanged, which is where "said nothing here" belongs: it
    // is a statement about one repository, and the estate card has no room for it.
    const unit = unitFor(body, 'greptile');
    const metric = unit.metrics['acted_on_rate'];
    expect(metric?.status).toBe('excluded');
    if (metric?.status !== 'excluded') throw new Error('unreachable');
    expect(metric.reason).toBe('vendor_silent');
  });

  it('keeps $/merged PR when the reviewer’s own rates are withheld — it asks nothing of the bot', async () => {
    // ⚠ THE DECISION, END TO END. A reviewer that opens no review threads has no engagement rate
    // anywhere in the estate, so both per-thread figures refuse. `$ per merged PR` divides a price
    // by the REPOSITORIES' own merges and asks nothing of the reviewer, so it survives — and it is
    // most worth reading exactly here: "this is what you paid, and this is what it produced."
    seedPriced({ monthlyCents: 12_000 });
    const s = seeder();
    s.user({ id: 5, login: 'greptileai', isBot: true, githubType: 'Bot' });
    s.reviewer({ userId: 5, kind: 'greptile', monthlyCents: 6_000 });
    // ONE review body and nothing else: demonstrably live, and it opens no thread — a summariser.
    s.review({ id: 800, prId: 1, authorId: 5, body: 'looks fine to me' });
    const card = rollupFor(await placement(), 'greptile');
    const cost = card.cost;
    if (cost == null) throw new Error('a priced live reviewer still has a price');
    expect(card.liveInRepos).toBe(1);
    // US$60 × 14 ÷ 30.44 = 27.595269, over the repository's own ten merges.
    expect(cost.perMergedPr).toEqual({ status: 'value', value: 2.759527, mergedPrs: 10 });
    for (const arm of [cost.unacted, cost.yours]) {
      expect(arm.status).toBe('refused');
      if (arm.status !== 'refused') throw new Error('unreachable');
      // ⚠ "NOTHING TO RATE", NOT "no measurable stretch of time". This reviewer has no observable
      // span EITHER, and the guard order puts the reviewer's own gate first precisely so the card
      // names the fact with a remedy attached rather than its consequence.
      expect(arm.reason).toBe('own_rate_withheld');
      expect(arm.metricReason).toBe('denominator_empty');
    }
    // ⚠ AND THE SPAN DISCLOSURE STILL RIDES THE BLOCK. One comment is not a stretch of time, so this
    // repository contributed NOTHING to the estate's pace — never that its pace was zero, and never
    // that it borrows a sibling's span.
    expect(cost.spanUnobservedRepos).toBe(1);
    expect(card.contributions[0]?.spanDays).toBeNull();
    expectAllFinite(card);
  });

  it('makes no vendor LIVE in a repository that merged nothing, so there is no estate figure at all', async () => {
    // ⚠ THE FALSE CLAIM THIS PREVENTS, ONE GRAIN UP. `walkBudget` is derived from the merge count,
    // so zero merges in the window means the fold reads ZERO pull requests and every counter on
    // every unit is 0. The per-repository unit says so honestly (`repo_inactive_in_window`, and
    // every metric `no_prs_in_window`). The ESTATE card must not exist at all: a vendor with no
    // observable work anywhere is absent, not a column of zeros with a price beside it.
    //
    // ⚠ AND THIS IS WHY `no_merges_in_window` IS UNREACHABLE FROM THIS ROUTE AT THE ESTATE GRAIN —
    // recorded rather than dressed up. Liveness requires an observed comment, an observed comment
    // requires a read pull request, and a read pull request requires a non-zero merge count, so
    // `Σ mergedPrsLast14d` over the LIVE repositories cannot be zero. The guard is defence in depth,
    // like `buildCounterfactual`'s own unreachable divisor check, and the module says so.
    const s = seeder();
    s.repo({ id: 10, name: 'quiet', createdAtMs: now - 400 * DAY });
    s.user({ id: 1, login: 'alice' });
    s.user({ id: 2, login: 'coderabbitai', isBot: true });
    s.reviewer({ userId: 2, kind: 'coderabbit', monthlyCents: 12_000 });
    // Twenty merged pull requests carrying twenty real findings — all merged 40 days ago.
    for (let i = 1; i <= 20; i += 1) {
      s.pr({ id: i, repoId: 10, number: i, authorId: 1, merged: true, mergedAgoMs: 40 * DAY });
      s.thread({ id: i, prId: i, path: `src/f${i}.ts`, line: i, ageMs: 60 * DAY });
      s.reviewComment({
        id: i,
        threadId: i,
        prId: i,
        authorId: 2,
        body: 'a real finding',
        atMs: now - (60 - i) * DAY,
      });
    }
    const body = await placement();
    const unit = unitFor(body, 'coderabbit');
    expect(unit.activity.mergedPrsLast14d).toBe(0);
    expect(unit.placement.status).toBe('refused');
    if (unit.placement.status !== 'refused') throw new Error('unreachable');
    expect(unit.placement.reason).toBe('repo_inactive_in_window');
    // ⚠ AND NO MONEY ANYWHERE. The price is real and there is nothing to divide it by, so the
    // response states nothing rather than dividing by that zero or printing a card of dashes.
    expect(body.rollup).toEqual([]);
    expect(JSON.stringify(body)).not.toContain('monthlyUsd');
  });

  it('refuses every WORKSPACE figure when every live repository has a PARTIAL window', async () => {
    // ⚠ THE UNDERCOUNT LANDS IN A DENOMINATOR HERE, so it inflates rather than under-places. The
    // placement refuses this repository because three days of merges would put it in too quiet a
    // band; cost DIVIDES by that same count, and a full fortnight's price over a partial
    // fortnight's merges reports several times the true cost per merged PR — the tab's most
    // quotable number, wrong in the direction that manufactures a finding.
    const s = seeder();
    s.repo({ id: 10, name: 'fresh', createdAtMs: now - 3 * DAY });
    s.user({ id: 1, login: 'alice' });
    s.user({ id: 2, login: 'coderabbitai', isBot: true });
    s.reviewer({ userId: 2, kind: 'coderabbit', monthlyCents: 12_000 });
    for (let i = 1; i <= 4; i += 1) {
      s.pr({ id: i, repoId: 10, number: i, authorId: 1, merged: true, mergedAgoMs: i * HOUR });
      s.thread({ id: i, prId: i, path: `src/f${i}.ts`, line: i, resolved: i <= 1, ageMs: 2 * DAY });
      s.reviewComment({
        id: 100 + i,
        threadId: i,
        prId: i,
        authorId: 2,
        body: 'x'.repeat(40),
        atMs: now - (3 * DAY - i * HOUR),
      });
    }
    const unit = unitFor(await placement(), 'coderabbit');
    expect(unit.placement.status).toBe('refused');
    if (unit.placement.status !== 'refused') throw new Error('unreachable');
    expect(unit.placement.reason).toBe('repo_window_incomplete');
    const card = rollupFor(await placement(), 'coderabbit');
    const cost = card.cost;
    if (cost == null) throw new Error('the price is real; only the denominator is not');
    expect(cost.partialWindowRepos).toBe(1);
    expect(cost.coveredRepos).toBe(1);
    for (const arm of [cost.perMergedPr, cost.unacted, cost.yours]) {
      expect(arm.status).toBe('refused');
      if (arm.status !== 'refused') throw new Error('unreachable');
      // ⚠ THE SAME REASON THE PLACEMENT GAVE. One fact, one sentence, on one card.
      expect(arm.reason).toBe('repo_window_incomplete');
    }
    // The price itself is a whole-window price and still renders — it is the division that refuses.
    expect(cost.windowUsd).toBe(55.190539);
    // ⚠ NOT ONE Infinity OR NaN ANYWHERE. A divide-by-zero that survived to the wire would render
    // as "US$∞ per merged PR", which is how this refusal was found — and the check is on the LIVE
    // VALUES, because `JSON.stringify` writes all three of those tokens as the literal `null`.
    expectAllFinite(card);
  });

  it('drops a PARTIAL-WINDOW repository from the merge sum ALONE, and discloses that it did', async () => {
    // ⚠ ONE REPOSITORY'S UNDERCOUNT MUST NOT SILENTLY INFLATE THE ESTATE'S MOST QUOTABLE NUMBER. A
    // repository the host has held for three days has a partial-window merge count; summing it into
    // `perMergedPr`'s DENOMINATOR would report the estate as costing less per merged pull request
    // than it does — the flattering direction, which is the one nobody checks. Its counters and its
    // threads still pool, because only the merge count is windowed.
    seedPriced({ monthlyCents: 12_000 });
    const s = seeder();
    s.repo({ id: 11, name: 'fresh', createdAtMs: now - 3 * DAY });
    for (let i = 1; i <= 4; i += 1) {
      s.pr({ id: 1100 + i, repoId: 11, number: i, authorId: 1, merged: true, mergedAgoMs: i * HOUR });
      // ⚠ THE THREADS ARE OLDER THAN THE HOST'S OWN RECORD OF THE REPOSITORY, which is the ordinary
      // shape after a backfill — and they have to be, or the 72-hour settle gate drops them and this
      // test would "prove" the merge-sum exclusion by silently excluding the threads too.
      s.thread({ id: 1100 + i, prId: 1100 + i, path: `fresh/f${i}.ts`, line: i, ageMs: 10 * DAY });
      s.reviewComment({
        id: 1200 + i,
        threadId: 1100 + i,
        prId: 1100 + i,
        authorId: 2,
        body: 'x'.repeat(40),
        atMs: now - 10 * DAY + i * HOUR,
      });
    }
    const card = rollupFor(await placement(), 'coderabbit');
    const cost = card.cost;
    if (cost == null) throw new Error('expected a cost block');
    expect(card.liveInRepos).toBe(2);
    expect(cost.coveredRepos).toBe(2);
    expect(cost.partialWindowRepos).toBe(1);
    // ⚠ TEN MERGES, NOT FOURTEEN — the identical figure a workspace holding only `app` would get,
    // which is exactly the point: the partial repository contributed nothing to this fraction.
    expect(cost.perMergedPr).toEqual({ status: 'value', value: 5.519054, mergedPrs: 10 });
    // …and the wrong answer, named: 55.190539 ÷ 14 = 3.942181, cheaper by a quarter for no reason
    // other than a repository we have not held long enough to count.
    if (cost.perMergedPr.status !== 'value') throw new Error('unreachable');
    expect(cost.perMergedPr.value).not.toBe(3.942181);
    // ⚠ AND ONLY THE MERGE SUM IS AFFECTED. The fresh repository's four threads pool into the
    // headline exactly like any other's — excluding them would be a second, unstated exclusion.
    if (cost.unacted.status !== 'value') throw new Error('unreachable');
    expect(cost.unacted.settledThreads).toBe(54);
    expect(card.counters.outcome['threadsSettledComplete']).toBe(54);
    expect(card.contributions).toHaveLength(2);
  });

  it('states ONE price ONCE for two repositories, and pools every counter exactly', async () => {
    // ⚠ THE PRICE IS PER WORKSPACE AND THE OLD CARD WAS PER REPOSITORY. One US$120 subscription
    // covering two repositories produced TWO blocks each carrying US$120: each the whole
    // subscription measured against one repository's work, an upper bound, and adding them counted
    // the same money twice. It shipped with a `sharedWithUnits` count telling the reader not to add
    // them up — a caveat compensating for a grain mismatch. The grain moved instead: ONE card, one
    // price, one population, and double-counting is not something a reader can do.
    const s = seeder();
    s.user({ id: 1, login: 'alice' });
    s.user({ id: 2, login: 'coderabbitai', isBot: true });
    s.reviewer({ userId: 2, kind: 'coderabbit', monthlyCents: 12_000 });
    for (const repoId of [10, 11]) {
      s.repo({ id: repoId, name: `r${repoId}`, createdAtMs: now - 400 * DAY });
      for (let i = 1; i <= 6; i += 1) {
        const id = repoId * 100 + i;
        s.pr({ id, repoId, number: i, authorId: 1, merged: true, mergedAgoMs: i * HOUR });
        s.thread({ id, prId: id, path: 'a.ts', line: i, ageMs: 30 * DAY });
        // Spread, so both repositories get a real observed span rather than the degenerate one.
        s.reviewComment({
          id,
          threadId: id,
          prId: id,
          authorId: 2,
          body: 'x'.repeat(40),
          atMs: now - (35 - i) * DAY,
        });
      }
    }
    const body = await placement();
    const units = body.units ?? [];
    expect(units.length).toBe(2);
    expect(body.rollup).toHaveLength(1);
    const card = rollupFor(body, 'coderabbit');
    const cost = card.cost;
    if (cost == null) throw new Error('expected a cost block');
    expect(cost.monthlyUsd).toBe(120);
    expect(cost.pricedReviewers).toBe(1);
    expect(card.liveInRepos).toBe(2);
    expect(card.reposConsidered).toBe(2);
    expect(cost.coveredRepos).toBe(2);
    // ⚠ THE PRICE MEETS THE WHOLE ESTATE'S WORK: 55.190539 ÷ 12 = 4.599212. The per-repository
    // block's answer — the same price over one repository's six merges, 9.198423 — is named so a
    // revert to the old grain is a red test rather than a plausible-looking number.
    expect(cost.perMergedPr).toEqual({ status: 'value', value: 4.599212, mergedPrs: 12 });
    if (cost.perMergedPr.status !== 'value') throw new Error('unreachable');
    expect(cost.perMergedPr.value).not.toBe(9.198423);
    expect(JSON.stringify(body)).not.toContain('sharedWithUnits');

    // ⚠⚠ THE ADDITIVITY INVARIANT, ASSERTED OVER EVERY KEY RATHER THAN SPOT-CHECKED ON ONE. The
    // whole equals the sum of the parts for EVERY counter, which is precisely what makes the
    // evidence table checkable against the headline it sits under — a card whose totals no
    // repository accounts for is the failure this section exists to make impossible. An absent key
    // contributes 0 and never drops the key.
    const groups = ['volume', 'outcome', 'overdueEligible', 'overdueUntouched', 'repository'] as const;
    let checked = 0;
    for (const group of groups) {
      const keys = new Set<string>([
        ...Object.keys(card.counters[group]),
        ...units.flatMap((u) => Object.keys(u.counters[group])),
      ]);
      expect(keys.size, group).toBeGreaterThan(0);
      for (const key of keys) {
        const parts = units.reduce((n, u) => n + (u.counters[group][key] ?? 0), 0);
        expect(card.counters[group][key] ?? 0, `${group}.${key}`).toBe(parts);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(20);
    // …and the invariant is not vacuously true over a table of zeros: the pooled figure is twice
    // each part, so a fold that returned one repository's counters would be red here.
    expect(card.counters.outcome['threadsSettledComplete']).toBe(12);
    for (const unit of units) expect(unit.counters.outcome['threadsSettledComplete']).toBe(6);

    // ⚠ AND THE SPREAD IS A SHAPE OVER THE PLACED SUBSET, NEVER AN AVERAGE OF RANKS. Percentiles
    // come from different cohorts with different n, so a mean of them is not the rank of anything;
    // the card counts how many sit below, at and above their own cohort's median.
    const spread = card.spread;
    if (spread.status !== 'value') throw new Error('expected a spread over two placements');
    expect(spread.placed).toBe(2);
    expect(spread.below + spread.at + spread.above).toBe(spread.placed);
    const sides = { below: 0, at: 0, above: 0 };
    for (const c of card.contributions) {
      const p = c.percentile;
      if (p == null) continue;
      if (p < 50) sides.below += 1;
      else if (p === 50) sides.at += 1;
      else sides.above += 1;
    }
    expect({ below: spread.below, at: spread.at, above: spread.above }).toEqual(sides);
    expectAllFinite(card);
  });

  it('refuses the WORKSPACE money on a TRUNCATED estate, and keeps the counters and the spread', async () => {
    // ⚠ THE TENTH REFUSAL, AND THE ONLY ONE THIS GRAIN OWNS. A request folds at most twelve
    // repositories; past that the response says `truncated: true`. A PER-REPOSITORY figure survives
    // that intact — it is about its own repository and nothing else — but a WORKSPACE figure divides
    // one WHOLE price by a PARTIAL sum, so every one of them reads too high by an amount nothing
    // here can state. It is not an approximation of the answer, it is a different question in the
    // same words.
    //
    // ⚠ AND IT SPARES THE RATES. A sum of counts over twelve repositories is an honest sum over
    // twelve repositories, and a rank distribution is a shape rather than a total — so the counters
    // and the spread render, and the estate-matched expectation keeps its RATES while its two MONEY
    // halves go quiet with the same sentence the cost arms carry.
    const s = seeder();
    s.user({ id: 1, login: 'alice' });
    s.user({ id: 2, login: 'coderabbitai', isBot: true, githubType: 'Bot' });
    s.reviewer({ userId: 2, kind: 'coderabbit', monthlyCents: 12_000 });
    for (let r = 1; r <= 15; r += 1) {
      s.repo({ id: r, name: `repo-${String(r).padStart(2, '0')}`, createdAtMs: now - 400 * DAY });
      for (let i = 1; i <= 6; i += 1) {
        const id = r * 100 + i;
        s.pr({ id, repoId: r, number: i, authorId: 1, merged: true, mergedAgoMs: i * HOUR });
        s.thread({ id, prId: id, path: 'a.ts', line: i, resolved: i <= 2, ageMs: 30 * DAY });
        s.reviewComment({
          id,
          threadId: id,
          prId: id,
          authorId: 2,
          body: 'x'.repeat(40),
          atMs: now - (35 - i) * DAY,
        });
      }
    }
    const body = await placement();
    expect(body.truncated).toBe(true);
    expect(new Set((body.units ?? []).map((u) => u.repoId)).size).toBe(12);
    const card = rollupFor(body, 'coderabbit');
    const cost = card.cost;
    if (cost == null) throw new Error('the price is real; the estate is not whole');
    expect(card.liveInRepos).toBe(12);
    expect(card.reposConsidered).toBe(12);
    // The price itself is whole and still renders — it is every division by a partial sum that goes.
    expect(cost.monthlyUsd).toBe(120);
    expect(cost.windowUsd).toBe(55.190539);
    for (const arm of [cost.perMergedPr, cost.unacted, cost.yours]) {
      expect(arm.status).toBe('refused');
      if (arm.status !== 'refused') throw new Error('unreachable');
      // ⚠ TRUNCATION OUTRANKS EVERY OTHER GUARD. This estate merged plenty, is priced, has a span
      // and has a cohort — so any other reason appearing here would mean the order slipped, and a
      // reader would be told the wrong thing to do about it.
      expect(arm.reason).toBe('workspace_truncated');
      expect(arm.message.length).toBeGreaterThan(40);
      // ⚠ THE SENTENCE NAMES THE REMEDY, which is what makes it a different sentence from the other
      // nine rather than a tenth spelling of "not enough data".
      expect(arm.message).toMatch(/Narrow to a repository/);
    }
    // ⚠ THE RATES SURVIVE, AND SAY SO WITH THE SAME OBJECT — one cause, one account of it.
    const peer = card.expectation;
    if (peer.status !== 'value') throw new Error('a partial estate still has rates');
    expect(peer.yoursRateOnFitted).toBeGreaterThan(0);
    expect(peer.expectedRate).toBeGreaterThan(0);
    expect(peer.perActedOnUsd).toBeNull();
    expect(peer.conversionGapUsd).toBeNull();
    expect(peer.moneyRefusal?.reason).toBe('workspace_truncated');
    // …as do the two sections that are sums and shapes rather than totals.
    expect(card.counters.outcome['threadsSettledComplete']).toBe(72); // 12 repositories × 6
    if (card.spread.status !== 'value') throw new Error('a partial estate still has a spread');
    expect(card.spread.placed).toBe(12);
    expectAllFinite(card);
  });

  it('reads the price of THIS Workspace only — never another Workspace’s figure for the same bot', async () => {
    // ⚠ THE GRAIN RULE, AS A TEST. `monthly_cents` is keyed on (account, WORKSPACE, actor): the
    // same reviewer may legitimately hold a different number in another Workspace, nothing
    // reconciles them, and nothing is meant to. A read scoped only by account would show
    // Workspace 2's US$999 here — and, worse, would do it in heap order on Postgres, so it would
    // work in this suite and flip in production after any UPDATE.
    raw
      .prepare('INSERT INTO workspaces (id, account_id, name, is_default) VALUES (2,?,?,0)')
      .run(ACCOUNT, 'Other');
    seedPriced(); // workspace 1: NO price
    const s = seeder();
    s.reviewer({ userId: 2, kind: 'coderabbit', monthlyCents: 99_900, workspaceId: 2 });
    const body = await placement();
    expect(rollupFor(body, 'coderabbit').cost).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('999');
  });

  it('sums the rows of two logins the Workspace calls ONE reviewer', async () => {
    // Two accounts folded into one vendor are ONE card — the corpus's own semantics — and within one
    // Workspace there is exactly one row per actor, so a total over them is the sanctioned plain
    // sum. It is ACROSS Workspaces that summing is forbidden.
    seedPriced({ monthlyCents: 12_000 });
    const s = seeder();
    s.user({ id: 7, login: 'coderabbitai-2', isBot: true, githubType: 'Bot' });
    s.reviewer({ userId: 7, kind: 'coderabbit', monthlyCents: 3_000 });
    const card = rollupFor(await placement(), 'coderabbit');
    expect(card.reviewers.map((r) => r.login).sort()).toEqual(['coderabbitai', 'coderabbitai-2']);
    expect(card.cost?.monthlyUsd).toBe(150);
    expect(card.cost?.pricedReviewers).toBe(2);
  });
});

describe('the vendor vocabulary map', () => {
  it('maps the seven FITTED vendors and the seven UNSTRATIFIABLE ones, and nothing else', () => {
    for (const kind of ['coderabbit', 'copilot', 'cursor', 'greptile', 'sourcery', 'qodo', 'devin']) {
      expect(corpusVendorForKind(kind), kind).toBe(kind);
    }
    for (const kind of ['baz', 'bito', 'codeant', 'ellipsis', 'entelligence', 'graphite', 'korbit']) {
      expect(corpusVendorForKind(kind), kind).toBe(kind);
    }
    // ⚠ HOST-ONLY KINDS ARE NOT IN THE CORPUS, and each one is a real, popular product a customer
    // may well run. A pooled "AI reviewer" cohort for them is forbidden at any n.
    for (const kind of [
      'deepsource',
      'github_code_quality',
      'github_advanced_security',
      'codex',
      'pierre',
      'vendor',
    ]) {
      expect(corpusVendorForKind(kind), kind).toBeNull();
    }
    // `in_house` IS a corpus string — it names no product, so it earns `vendor_unfittable` rather
    // than "never measured".
    expect(corpusVendorForKind('in_house')).toBe('in_house');
    expect(corpusVendorForKind(null)).toBeNull();
    // ⚠ Never `String(kind)` into a cell key: an unknown kind is null, not itself.
    expect(corpusVendorForKind('some_new_vendor_2027')).toBeNull();
    // …and prototype keys are not vendors.
    expect(corpusVendorForKind('__proto__')).toBeNull();
    expect(corpusVendorForKind('constructor')).toBeNull();
  });
});

describe('anomalies need BOTH a share and a magnitude', () => {
  const cohort = (quantiles: Record<string, number>, ci: [number, number] | null) => ({
    nRepos: 60,
    quantiles,
    ciMedian95: ci,
    direction: 'neutral' as const,
    minUnits: 5,
    unit: 'count_per_pr',
  });

  const volumeMetric = (
    value: number,
    percentile: number,
    median: number,
    ci: [number, number] | null = null,
  ): Record<string, BotBenchmarkPlacementMetric> => ({
    findings_per_merged_pr: {
      status: 'compared',
      value,
      units: 20,
      percentile,
      cohort: cohort({ p10: 0.1, p50: median, p90: median + 0.4 }, ci),
    },
  });

  const context = { cohortRepos: 60, bandLabel: '6 of 10', reviewerName: null };

  it('fires when both gates pass, and carries both numbers', () => {
    const out = anomaliesFor(volumeMetric(3.2, 96, 1.1), context);
    expect(out).toHaveLength(1);
    const a = out[0]!;
    expect(a.kind).toBe('volume');
    expect(a.share.percentile).toBe(96);
    expect(a.share.threshold).toBe(90);
    expect(a.magnitude.gap).toBeCloseTo(2.1, 10);
    expect(a.magnitude.threshold).toBe(1);
    expect(a.units).toBe(20);
    expect(a.bandLabel).toBe('6 of 10');
    expect(a.action.length).toBeGreaterThan(30);
  });

  it('says NOTHING on a share without a magnitude — the Chronology lesson', () => {
    // p96 of a cohort that is fine everywhere is still fine. Somebody is always in the 95th
    // percentile; a percentile alone invents a crisis in a healthy repository.
    expect(anomaliesFor(volumeMetric(1.3, 96, 1.1), context)).toEqual([]);
  });

  it('says NOTHING on a magnitude without a share', () => {
    // Three findings per PR above the median, but only the 60th percentile — the cohort is spread
    // that wide, so this is an ordinary repository in a noisy cohort.
    expect(anomaliesFor(volumeMetric(4.1, 60, 1.1), context)).toEqual([]);
  });

  it('says NOTHING when the value sits inside the cohort’s own median CI', () => {
    // ⚠ THE THIRD GATE. At the 30-repo floor a rate's median CI routinely spans twenty points;
    // a gap inside it is noise reported as a finding.
    expect(anomaliesFor(volumeMetric(3.2, 96, 1.1, [0.9, 3.5]), context)).toEqual([]);
    // …and just outside it, the same numbers DO fire — so the gate is doing work, not sitting there.
    expect(anomaliesFor(volumeMetric(3.2, 96, 1.1, [0.9, 3.0]), context)).toHaveLength(1);
  });

  it('requires the cohort median to be HEALTHY before calling low engagement a problem', () => {
    const low = (median: number): Record<string, BotBenchmarkPlacementMetric> => ({
      acted_on_rate: {
        status: 'compared',
        value: 0.05,
        units: 30,
        percentile: 4,
        cohort: {
          nRepos: 60,
          quantiles: { p10: 0.2, p50: median, p90: 0.9 },
          ciMedian95: null,
          direction: 'higher_is_better',
          minUnits: 5,
          unit: 'rate',
        },
      },
    });
    // Nobody acts on this bot anywhere: that is a fact about the PRODUCT, not about this team, and
    // "retire it" would be the vendor's general reputation wearing the customer's own data.
    expect(anomaliesFor(low(0.3), context)).toEqual([]);
    // The cohort acts on most of what it says, and this team does not. Now it means something.
    const fired = anomaliesFor(low(0.7), context);
    expect(fired).toHaveLength(1);
    expect(fired[0]?.kind).toBe('engagement');
  });

  it('never fires on a refused or uncompared metric — there is no percentile to read', () => {
    expect(
      anomaliesFor(
        {
          findings_per_merged_pr: {
            status: 'excluded',
            reason: 'below_min_units',
            message: 'x',
          },
        },
        context,
      ),
    ).toEqual([]);
    expect(
      anomaliesFor(
        {
          findings_per_merged_pr: {
            status: 'uncompared',
            value: 99,
            units: 40,
            reason: 'cohort_metric_refused',
            cohortRefusal: { rule: 'cell_floor', message: 'x' },
          },
        },
        context,
      ),
    ).toEqual([]);
  });

  it('needs an overlap rate that is worth acting on, not merely extreme', () => {
    const overlap = (value: number, median: number) => ({
      cross_bot_overlap_rate: {
        status: 'compared' as const,
        value,
        units: 40,
        percentile: 97,
        cohort: {
          nRepos: 60,
          quantiles: { p10: 0, p50: median, p90: median + 0.01 },
          ciMedian95: null,
          direction: 'neutral' as const,
          minUnits: 5,
          unit: 'rate',
        },
      },
    });
    // The 97th percentile of a cohort where overlap is near zero everywhere is still near zero —
    // and the MAGNITUDE gate is what stops it, not a separate floor on the value. For a rate the
    // cohort median is non-negative, so `value - median >= 0.1` already implies `value >= 0.1`; a
    // second "and the rate must exceed 10 %" condition was written, mutation-tested, found
    // unfalsifiable and deleted rather than shipped as a guard that cannot fire.
    expect(anomaliesFor(overlap(0.02, 0.001), context)).toEqual([]);
    expect(anomaliesFor(overlap(0.35, 0.02), context)).toHaveLength(1);
    // The implication, asserted rather than argued: nothing under 10 % can reach the magnitude gate.
    expect(anomaliesFor(overlap(0.099, 0), context)).toEqual([]);
    expect(anomaliesFor(overlap(0.1, 0), context)).toHaveLength(1);
  });
});
