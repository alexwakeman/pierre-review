// THE LAND PATH, against REAL GIT. GitHub and the token source are stubbed; git is not, and
// neither is the query layer — the whole feature is a claim about what git does with a tree
// nobody checked out, so a test that mocks git proves nothing worth having.
//
// The clone is a real temp repository injected through `ensureClone`, and `fetchRefIntoClone`
// resolves a "remote" ref out of a table the test controls — which is how the head-moved and
// base-advanced cases are staged without a network.
//
// WHAT THIS PINS, each one a decision that is expensive to get wrong:
//
//   1. THE BYTES THAT LAND ARE THE FOLD'S BYTES. `hash-object -w --stdin` carries no `--path`,
//      so no clean filter runs — asserted against a CRLF file in a clone whose OWN config sets
//      `core.autocrlf=true`.
//   2. FULL IS A MERGE COMMIT, PARTIAL IS NOT. Two parents means "the base branch landed here";
//      a partial resolution has not, and saying so in the commit graph would be a lie the next
//      merge acts on.
//   3. ⚠ THE TWO PARTIAL SEMANTICS, PINNED IN BOTH DIRECTIONS. A region kept as `ours`
//      RE-CONFLICTS on the next merge (self-announcing, safe); a region left at `base` merges
//      CLEANLY and silently takes the base branch's text. That asymmetry is what the copy in
//      the UI is about, so a change to the partial shape has to come back through this test.
//   4. NO CONFLICT MARKER EVER REACHES A COMMITTED BLOB — walked over every blob in the tree,
//      because merge-tree's own tree stores marker content at every conflicted path and the
//      FULL path seeds from it.
//   5. THE GUARDS FIRE BEFORE THE PUSH. `HeadMoved`, `ModelStale`, `NothingToCommit`,
//      `RebaseNotOffered` and `ReservedBranch` all assert the push helper was never called.
//   6. THE REBASE EQUIVALENCE IS A CLAIM ABOUT GIT, so it is checked against a REAL
//      `git rebase` on a scratch clone, not against our own arithmetic.
//
// THE SHARED HARNESS for the land-path suites (land.test.ts, land-partial.test.ts,
// land-guards.test.ts): the stubs, the real-git fixtures and the throwaway DB. It was one
// 1,400-line file whose ~40 real-git cases ran in ONE worker, so that file alone set the wall
// clock of the whole backend run (713s of a 720s run, measured 2026-10-30). Split three ways the
// cases run side by side; nothing about what they assert changed. See docs/TESTING.md.
//
// ⚠ IMPORT THIS FIRST in each suite. The `vi.mock` calls below register when this module is
// evaluated, and every module under test is imported LATER, dynamically, in the `beforeAll` —
// which is also why DATABASE_URL can be set here, before the client opens its connection.
// Each suite gets its OWN temp directory and database, so the three never share a file.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, beforeEach, vi } from 'vitest';

// ⚠ ONE TEMP DIRECTORY PER SUITE, AS THE PROCESS'S TMPDIR. The three suites run at once, and
// "leaves no temp index behind" lists `pierre-conflict-land-*` in tmpdir() — so a shared tmpdir
// would show it another suite's in-flight index (it did, on the first parallel run). os.tmpdir()
// reads TMPDIR on every call, so land.ts, the fixtures and that check all land in here.
const SUITE_TMP = mkdtempSync(join(tmpdir(), 'pierre-land-suite-'));
process.env.TMPDIR = SUITE_TMP;
const DB_PATH = join(SUITE_TMP, 'land.sqlite');
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* ─────────────────────────────── the stubs ─────────────────────────────── */

/** remoteRef → sha, the table `fetchRefIntoClone` reads. Staging a head move is a write here. */
export const remoteRefs = new Map<string, string>();
/** Which temp repository `ensureClone` hands back for the test currently running. */
let cloneDirForTest = '';

export const ensureClone = vi.fn(async () => cloneDirForTest);
export const fetchRefIntoClone = vi.fn(
  async (a: { cloneDir: string; remoteRef: string; destRef: string }) => {
    const sha = remoteRefs.get(a.remoteRef);
    if (!sha) throw new Error(`no fixture ref for ${a.remoteRef}`);
    execFileSync('git', ['update-ref', a.destRef, sha], { cwd: a.cloneDir, env: CLEAN_ENV });
    return sha;
  },
);
// `withRepoLock` stays REAL — the land path takes it three times in sequence and a reentrancy
// mistake there is a deadlock, which a stub would hide.
vi.mock('../review/clone-manager.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ensureClone,
  fetchRefIntoClone,
  cleanupCloneCache: () => {},
}));

export const getAccessToken = vi.fn(async () => 'tok');
// ⚠ SPREAD, NOT REPLACE: `getAccountById` lives here too and must stay REAL — it is what
// decides the committer, and test 12 asserts the committer is the account.
vi.mock('../auth/account.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getAccessToken,
}));

/** The default: a same-repo pull request. Named so a test can override it and put it back —
 *  `mockReset` would take the default with it, and the fork tests below need BOTH the model
 *  build and the land-time re-check to see a fork. */
export const sameRepoHeadInfo = async (): Promise<{
  headSha: string;
  headRef: string;
  headRepoFullName: string;
  isFork: boolean;
  maintainerCanModify: boolean;
  baseRef: string;
}> => ({
  headSha: remoteRefs.get('refs/pull/7/head') ?? '',
  headRef: 'feature',
  headRepoFullName: 'acme/widgets',
  isFork: false,
  maintainerCanModify: true,
  baseRef: 'main',
});
export const fetchPrHeadInfo = vi.fn(sameRepoHeadInfo);
export const createPullRequest = vi.fn(async () => ({ number: 99, url: 'https://example.test/pr/99' }));
vi.mock('../github/mutations.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchPrHeadInfo,
  createPullRequest,
}));

export const ghRestGetText = vi.fn(
  async (_token: string, _path: string) => ({ status: 404, ok: false, text: '' }),
);
vi.mock('../github/client.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ghRestGetText,
}));

interface PushCall {
  remoteBranch: string;
  committish: string;
  protect: string[];
  leaseSha?: string;
}
/** The commit the most recent push carried — what GitHub would attach to the PR. */
let lastPushedSha: string | null = null;
export const pushRef = vi.fn(async (t: PushCall) => {
  lastPushedSha = t.committish;
});
export const pushForceWithLease = vi.fn(async (t: PushCall) => {
  lastPushedSha = t.committish;
});
vi.mock('../coding/git.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  pushRef,
  pushForceWithLease,
}));

/**
 * What the stubbed targeted sync "reads from GitHub" for PR #7 after the push — the three cases
 * the confirming step has to tell apart, because GitHub attaches a push and computes
 * mergeability ASYNCHRONOUSLY:
 *   'pushed-head'                — the pushed commit is the head and GitHub has recomputed.
 *   'stale-head'                 — GitHub has not attached the push yet: the old head, CONFLICTING.
 *   'pushed-head-stale-conflict' — the new head, but GitHub still reports CONFLICTING / DIRTY.
 * The settle-and-verify tail is REAL (sync/resync-after-write.ts + the facts read); only the
 * GitHub fetch and the background ladder's scheduler are stubbed.
 */
export type GithubView = 'pushed-head' | 'stale-head' | 'pushed-head-stale-conflict';
let githubView: GithubView = 'pushed-head';
/** A test file cannot assign an imported binding, so the GitHub view is set through here. */
export function setGithubView(v: GithubView): void {
  githubView = v;
}
export const syncOnePr = vi.fn(async (_repoId: number, number: number, _log?: unknown, _o?: unknown) => {
  // The resolver's "new branch + open a PR" syncs PR #99 — nothing in this DB to write.
  if (number !== 7) return true;
  const set: Record<string, unknown> =
    githubView === 'stale-head'
      ? { mergeable: 'conflicting', mergeStateStatus: 'dirty' }
      : githubView === 'pushed-head-stale-conflict'
        ? { mergeable: 'conflicting', mergeStateStatus: 'dirty' }
        : { mergeable: 'mergeable', mergeStateStatus: 'clean' };
  if (githubView !== 'stale-head' && lastPushedSha) set.headSha = lastPushedSha;
  await db.update(schema.pullRequests).set(set).where(eq(schema.pullRequests.id, prId)).execute();
  return true;
});
vi.mock('../sync/sync-one-pr.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  syncOnePr,
}));

export const schedulePrSettle = vi.fn();
vi.mock('../sync/pr-settle.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  schedulePrSettle,
}));

/* ─────────────────────────────── real git fixtures ─────────────────────────────── */

export const CLEAN_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_ADVICE: '0',
  GIT_AUTHOR_NAME: 'Original Author',
  GIT_AUTHOR_EMAIL: 'original@example.com',
  GIT_COMMITTER_NAME: 'Original Author',
  GIT_COMMITTER_EMAIL: 'original@example.com',
};

export const tempDirs: string[] = [];

export class Repo {
  readonly dir: string;

  constructor() {
    this.dir = mkdtempSync(join(tmpdir(), 'pierre-land-repo-'));
    tempDirs.push(this.dir);
    this.git(['init', '-q', '-b', 'main', '.']);
  }

  git(args: string[]): string {
    return execFileSync('git', args, {
      cwd: this.dir,
      env: CLEAN_ENV,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  /** Exit status only — for the commands whose VERDICT is the assertion. */
  status(args: string[]): number {
    const r = spawnSync('git', args, { cwd: this.dir, env: CLEAN_ENV });
    return r.status ?? -1;
  }

  bytes(args: string[]): Buffer {
    return execFileSync('git', args, { cwd: this.dir, env: CLEAN_ENV });
  }

  write(path: string, content: string | Buffer): void {
    const full = join(this.dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }

  commit(message: string): string {
    this.git(['add', '-A']);
    this.git(['commit', '-q', '-m', message]);
    return this.git(['rev-parse', 'HEAD']).trim();
  }
}

export interface Fixture {
  repo: Repo;
  headSha: string;
  baseSha: string;
  mergeBaseSha: string;
}

/** One base commit, an `ours` branch (the PR head) and a `theirs` branch (the base branch). */
export function threeWay(
  base: Record<string, string | Buffer>,
  ours: (r: Repo) => void,
  theirs: (r: Repo) => void,
  extraOursCommits = 0,
): Fixture {
  const repo = new Repo();
  for (const [p, c] of Object.entries(base)) repo.write(p, c);
  const mergeBaseSha = repo.commit('base');
  repo.git(['checkout', '-q', '-b', 'feature']);
  ours(repo);
  let headSha = repo.commit('ours');
  for (let i = 0; i < extraOursCommits; i++) {
    repo.write(`extra-${i}.txt`, `extra ${i}\n`);
    headSha = repo.commit(`extra ${i}`);
  }
  repo.git(['checkout', '-q', 'main']);
  theirs(repo);
  const baseSha = repo.commit('theirs');
  return { repo, headSha, baseSha, mergeBaseSha };
}

/** Point the stubs at this fixture. */
export function use(f: Fixture): void {
  cloneDirForTest = f.repo.dir;
  remoteRefs.clear();
  remoteRefs.set('refs/pull/7/head', f.headSha);
  remoteRefs.set('refs/heads/main', f.baseSha);
}

export const A_BASE = 'alpha\none\nbeta\ntwo\ngamma\n';
export const B_BASE = 'p\nq\nr\n';

/** a.txt: two contested regions. b.txt: one. */
export function twoFileFixture(): Fixture {
  return threeWay(
    { 'a.txt': A_BASE, 'b.txt': B_BASE },
    (r) => {
      r.write('a.txt', 'alpha\none-ours\nbeta\ntwo-ours\ngamma\n');
      r.write('b.txt', 'p\nq-ours\nr\n');
    },
    (r) => {
      r.write('a.txt', 'alpha\none-theirs\nbeta\ntwo-theirs\ngamma\n');
      r.write('b.txt', 'p\nq-theirs\nr\n');
    },
  );
}

/** One conflicted file, and a base-branch change to a file nobody contested. */
export function oneFileFixture(extraOursCommits = 0): Fixture {
  return threeWay(
    { 'a.txt': A_BASE, 'quiet.txt': 'unchanged\n' },
    (r) => r.write('a.txt', 'alpha\none-ours\nbeta\ntwo-ours\ngamma\n'),
    (r) => {
      r.write('a.txt', 'alpha\none-theirs\nbeta\ntwo-theirs\ngamma\n');
      r.write('quiet.txt', 'moved on\n');
    },
    extraOursCommits,
  );
}

/* ─────────────────────────────── the app under test ─────────────────────────────── */

/* eslint-disable @typescript-eslint/no-explicit-any */
export let db: any;
export let schema: any;
export let eq: any;
let closeDb: (() => Promise<void>) | undefined;
export let buildConflictModel: any;
export let landConflictResolution: any;
export let conflictModelHash: any;
export let hasConflictMarkers: (s: string) => boolean;
export let foldFile: any;
export let foldToText: any;
export let CONFLICT_GIT_ENV: NodeJS.ProcessEnv;

export let prId = 0;
export let repoId = 0;

const log = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
  child: () => log,
} as any;

let sessionSeq = 0;

/** Open a session the way the route does: through the ONE builder, against the real DB row. */
export async function openModel(): Promise<any> {
  const res = await buildConflictModel({
    accountId: 1,
    prId,
    sessionId: `s${++sessionSeq}`,
  });
  if (!res || res.status !== 'ready') {
    throw new Error(`expected a ready model, got ${res ? res.status : 'null'}`);
  }
  return res.model;
}

export type Pick = (region: any, index: number) => any;

export function resolutionFor(model: any, path: string, pick: Pick): any {
  const file = model.files.find((f: any) => f.path === path);
  if (!file) throw new Error(`no file ${path} in the model`);
  const decisions = file.regions
    .filter((r: any) => r.kind !== 'unchanged')
    .map((r: any, i: number) => {
      const chosen = pick(r, i);
      return typeof chosen === 'string' ? { id: r.id, decision: chosen } : { id: r.id, ...chosen };
    });
  return { index: file.index, decisions };
}

export function bodyFor(model: any, files: any[], over: Record<string, unknown> = {}): any {
  return {
    sessionId: 's',
    expectedHeadSha: model.headSha,
    expectedBaseSha: model.baseSha,
    modelHash: conflictModelHash(model),
    strategy: 'merge',
    target: { kind: 'pr_branch' },
    files,
    ...over,
  };
}

export async function land(
  model: any,
  body: any,
  suggestions = new Map(),
  edits = new Map(),
): Promise<any> {
  return landConflictResolution({
    accountId: 1,
    prId,
    sessionId: `s${sessionSeq}`,
    model,
    body,
    suggestions,
    edits,
    onPhase: () => {},
    signal: new AbortController().signal,
    log,
  });
}

/** The error's `code`, or the whole error if it carries none (which is itself a failure). */
export async function refusal(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    const code = (err as { code?: string }).code;
    return code ?? `uncoded: ${String(err)}`;
  }
  return 'no error thrown';
}

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../db/run-migrations.js');
  const client = await import('../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  ({ eq } = await import('drizzle-orm'));
  ({ buildConflictModel } = await import('./model.js'));
  ({ landConflictResolution } = await import('./land.js'));
  ({ conflictModelHash } = await import('./hash.js'));
  ({ hasConflictMarkers } = await import('../coding/merge.js'));
  ({ foldFile, foldToText } = await import('@pierre-review/shared'));
  ({ CONFLICT_GIT_ENV } = await import('./git.js'));
  // The inline head wait is ~7s of wall clock in production; a stale-head case must not cost a
  // test that. The SHAPE (bounded re-reads, then hand off) is what is under test, not the gaps.
  const { __setSettleInlineTiming } = await import('../sync/resync-after-write.js');
  __setSettleInlineTiming({ delaysMs: [5, 5, 5], budgetMs: 1_000 });

  const { accounts, repos, pullRequests, users } = schema;
  // Migration 0008 seeds account 1 with an EMPTY github_login, and the committer ident falls
  // back to 'pierre-review' on one — which would make the "committer is the account" half of
  // the rebase test vacuous.
  await db.update(accounts).set({ githubLogin: 'viewer-me' }).where(eq(accounts.id, 1)).execute();
  const [author] = await db
    .insert(users)
    .values({ githubLogin: 'alice-dev', githubNodeId: 'U_alice', isBot: false })
    .returning()
    .execute();
  const [repoRow] = await db
    .insert(repos)
    .values({
      accountId: 1,
      owner: 'acme',
      name: 'widgets',
      githubNodeId: 'R_land',
      defaultBranch: 'main',
      defaultBranchName: 'main',
      viewerPermission: 'WRITE',
    })
    .returning()
    .execute();
  repoId = repoRow.id;
  const [prRow] = await db
    .insert(pullRequests)
    .values({
      githubNodeId: 'PR_land',
      accountId: 1,
      repoId,
      number: 7,
      title: 'land fixture',
      authorId: author.id,
      state: 'open',
      headRefName: 'feature',
      baseRefName: 'main',
      headSha: 'unused',
      openedAt: new Date(),
      updatedAt: new Date(),
    })
    .returning()
    .execute();
  prId = prRow.id;
});

afterAll(async () => {
  await closeDb?.();
  rmSync(SUITE_TMP, { recursive: true, force: true });
  for (const d of tempDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

beforeEach(async () => {
  pushRef.mockClear();
  pushForceWithLease.mockClear();
  createPullRequest.mockClear();
  ghRestGetText.mockClear();
  ghRestGetText.mockResolvedValue({ status: 404, ok: false, text: '' });
  syncOnePr.mockClear();
  schedulePrSettle.mockClear();
  githubView = 'pushed-head';
  lastPushedSha = null;
  // The stored row as a conflicting PR looks before any push.
  await db
    .update(schema.pullRequests)
    .set({ headSha: 'unused', mergeable: 'conflicting', mergeStateStatus: 'dirty' })
    .where(eq(schema.pullRequests.id, prId))
    .execute();
});

