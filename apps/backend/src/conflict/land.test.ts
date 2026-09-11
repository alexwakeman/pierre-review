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
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const DB_PATH = '/tmp/pierre-conflict-land-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';

/* ─────────────────────────────── the stubs ─────────────────────────────── */

/** remoteRef → sha, the table `fetchRefIntoClone` reads. Staging a head move is a write here. */
const remoteRefs = new Map<string, string>();
/** Which temp repository `ensureClone` hands back for the test currently running. */
let cloneDirForTest = '';

const ensureClone = vi.fn(async () => cloneDirForTest);
const fetchRefIntoClone = vi.fn(
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

const getAccessToken = vi.fn(async () => 'tok');
// ⚠ SPREAD, NOT REPLACE: `getAccountById` lives here too and must stay REAL — it is what
// decides the committer, and test 12 asserts the committer is the account.
vi.mock('../auth/account.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getAccessToken,
}));

/** The default: a same-repo pull request. Named so a test can override it and put it back —
 *  `mockReset` would take the default with it, and the fork tests below need BOTH the model
 *  build and the land-time re-check to see a fork. */
const sameRepoHeadInfo = async (): Promise<{
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
const fetchPrHeadInfo = vi.fn(sameRepoHeadInfo);
const createPullRequest = vi.fn(async () => ({ number: 99, url: 'https://example.test/pr/99' }));
vi.mock('../github/mutations.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchPrHeadInfo,
  createPullRequest,
}));

const ghRestGetText = vi.fn(
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
const pushRef = vi.fn(async (_t: PushCall) => {});
const pushForceWithLease = vi.fn(async (_t: PushCall) => {});
vi.mock('../coding/git.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  pushRef,
  pushForceWithLease,
}));

const resyncPrAfterWrite = vi.fn(async () => true);
vi.mock('../sync/resync-after-write.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resyncPrAfterWrite,
}));

/* ─────────────────────────────── real git fixtures ─────────────────────────────── */

const CLEAN_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_ADVICE: '0',
  GIT_AUTHOR_NAME: 'Original Author',
  GIT_AUTHOR_EMAIL: 'original@example.com',
  GIT_COMMITTER_NAME: 'Original Author',
  GIT_COMMITTER_EMAIL: 'original@example.com',
};

const tempDirs: string[] = [];

class Repo {
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

interface Fixture {
  repo: Repo;
  headSha: string;
  baseSha: string;
  mergeBaseSha: string;
}

/** One base commit, an `ours` branch (the PR head) and a `theirs` branch (the base branch). */
function threeWay(
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
function use(f: Fixture): void {
  cloneDirForTest = f.repo.dir;
  remoteRefs.clear();
  remoteRefs.set('refs/pull/7/head', f.headSha);
  remoteRefs.set('refs/heads/main', f.baseSha);
}

const A_BASE = 'alpha\none\nbeta\ntwo\ngamma\n';
const B_BASE = 'p\nq\nr\n';

/** a.txt: two contested regions. b.txt: one. */
function twoFileFixture(): Fixture {
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
function oneFileFixture(extraOursCommits = 0): Fixture {
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
let db: any;
let schema: any;
let eq: any;
let closeDb: (() => Promise<void>) | undefined;
let buildConflictModel: any;
let landConflictResolution: any;
let conflictModelHash: any;
let hasConflictMarkers: (s: string) => boolean;
let foldFile: any;
let foldToText: any;
let CONFLICT_GIT_ENV: NodeJS.ProcessEnv;

let prId = 0;
let repoId = 0;

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
async function openModel(): Promise<any> {
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

type Pick = (region: any, index: number) => any;

function resolutionFor(model: any, path: string, pick: Pick): any {
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

function bodyFor(model: any, files: any[], over: Record<string, unknown> = {}): any {
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

async function land(model: any, body: any, suggestions = new Map()): Promise<any> {
  return landConflictResolution({
    accountId: 1,
    prId,
    sessionId: `s${sessionSeq}`,
    model,
    body,
    suggestions,
    onPhase: () => {},
    signal: new AbortController().signal,
    log,
  });
}

/** The error's `code`, or the whole error if it carries none (which is itself a failure). */
async function refusal(fn: () => Promise<unknown>): Promise<string> {
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
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  for (const d of tempDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

beforeEach(() => {
  pushRef.mockClear();
  pushForceWithLease.mockClear();
  createPullRequest.mockClear();
  ghRestGetText.mockClear();
  ghRestGetText.mockResolvedValue({ status: 404, ok: false, text: '' });
});

/* ─────────────────────────────── the tests ─────────────────────────────── */

describe('landConflictResolution — the bytes', () => {
  // Every deterministic decision, one land each, checked against the SHARED fold rather than
  // against a hand-typed string — the fold is what the centre pane rendered, so this is the
  // "what you saw is what lands" claim and not a restatement of the expected text.
  for (const decision of [
    'ours',
    'theirs',
    'base',
    'both_ours_first',
    'both_theirs_first',
  ] as const) {
    it(`commits exactly the fold’s bytes for '${decision}'`, async () => {
      const f = oneFileFixture();
      use(f);
      const model = await openModel();
      const res = await land(
        model,
        bodyFor(model, [resolutionFor(model, 'a.txt', () => decision)]),
      );
      const file = model.files.find((x: any) => x.path === 'a.txt');
      const decisions = new Map(
        file.regions
          .filter((r: any) => r.kind !== 'unchanged')
          .map((r: any) => [r.id, { decision }]),
      );
      const folded = foldFile({ regions: file.regions, terminators: file.terminators }, decisions);
      expect(folded.ok).toBe(true);
      expect(f.repo.bytes(['show', `${res.commitSha}:a.txt`])).toEqual(
        Buffer.from(foldToText(folded), 'utf8'),
      );
    });
  }

  it('`base` on a one-sided region emits the ancestor — the revert case', async () => {
    // b.txt is changed by the PR alone, so its region is `ours_only` and `base` is the ONE
    // decision that removes the PR's own work. It has to reach the blob intact.
    const f = threeWay(
      { 'a.txt': A_BASE, 'b.txt': B_BASE },
      (r) => {
        r.write('a.txt', 'alpha\none-ours\nbeta\ntwo-ours\ngamma\n');
        r.write('b.txt', 'p\nq-ours\nr\n');
      },
      (r) => r.write('a.txt', 'alpha\none-theirs\nbeta\ntwo-theirs\ngamma\n'),
    );
    use(f);
    const model = await openModel();
    // b.txt is not conflicted, so it is not in the model at all — the merge already settled
    // it. The revert case therefore has to be staged INSIDE a conflicted file.
    expect(model.files.map((x: any) => x.path)).toEqual(['a.txt']);
    const file = model.files[0];
    const contested = file.regions.filter((r: any) => r.kind !== 'unchanged');
    expect(contested.every((r: any) => r.kind === 'conflict')).toBe(true);
    const res = await land(
      model,
      bodyFor(model, [resolutionFor(model, 'a.txt', () => 'base')]),
    );
    expect(f.repo.bytes(['show', `${res.commitSha}:a.txt`]).toString('utf8')).toBe(A_BASE);
  });

  it('runs no clean filter, even in a clone whose own config sets core.autocrlf', async () => {
    // ⚠ THE BYTE ROUND-TRIP IS STRUCTURAL, NOT LUCK. `hash-object -w --stdin` carries no
    // `--path`, so there is no path for git to look attributes up against and no filter runs.
    // `CONFLICT_GIT_ENV` nulls the GLOBAL and SYSTEM config; the repo's OWN config is
    // deliberately still honoured, which is what makes this the interesting case.
    expect(CONFLICT_GIT_ENV.GIT_CONFIG_GLOBAL).toBe('/dev/null');
    const crlf = (body: string): string => body.replace(/\n/g, '\r\n');
    const f = threeWay(
      { 'a.txt': crlf(A_BASE) },
      (r) => r.write('a.txt', crlf('alpha\none-ours\nbeta\ntwo-ours\ngamma\n')),
      (r) => r.write('a.txt', crlf('alpha\none-theirs\nbeta\ntwo-theirs\ngamma\n')),
    );
    f.repo.git(['config', 'core.autocrlf', 'true']);
    use(f);
    const model = await openModel();
    const res = await land(
      model,
      bodyFor(model, [resolutionFor(model, 'a.txt', () => 'ours')]),
    );
    const blob = f.repo.bytes(['show', `${res.commitSha}:a.txt`]);
    expect(blob.toString('utf8')).toBe(crlf('alpha\none-ours\nbeta\ntwo-ours\ngamma\n'));
    expect(blob.includes(Buffer.from('\r\n'))).toBe(true);
  });

  it('no conflict marker reaches any committed blob', async () => {
    const f = twoFileFixture();
    use(f);
    const model = await openModel();
    const res = await land(
      model,
      bodyFor(model, [
        resolutionFor(model, 'a.txt', () => 'both_ours_first'),
        resolutionFor(model, 'b.txt', () => 'theirs'),
      ]),
    );
    const entries = f.repo
      .git(['ls-tree', '-r', '--format=%(objectname) %(path)', res.commitSha])
      .split('\n')
      .filter(Boolean);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      const oid = entry.slice(0, entry.indexOf(' '));
      expect(hasConflictMarkers(f.repo.bytes(['cat-file', 'blob', oid]).toString('utf8'))).toBe(
        false,
      );
    }
  });
});

describe('landConflictResolution — full vs partial', () => {
  it('FULL is a two-parent merge commit and the next merge is clean', async () => {
    const f = twoFileFixture();
    use(f);
    const model = await openModel();
    const res = await land(
      model,
      bodyFor(model, [
        resolutionFor(model, 'a.txt', () => 'ours'),
        resolutionFor(model, 'b.txt', () => 'ours'),
      ]),
    );
    expect(res.stillConflicting).toBe(false);
    expect(res.skipped).toEqual([]);
    expect(res.resolvedPaths).toEqual(['a.txt', 'b.txt']);
    const parents = f.repo.git(['rev-list', '--parents', '-n', '1', res.commitSha]).trim().split(' ');
    expect(parents.slice(1)).toEqual([f.headSha, f.baseSha]);
    expect(f.repo.git(['show', '-s', '--format=%s', res.commitSha]).trim()).toBe(
      "Merge branch 'main' into feature",
    );
    // The claim the merge commit makes, checked against git rather than against us.
    expect(f.repo.status(['merge-tree', '--write-tree', res.commitSha, f.baseSha])).toBe(0);
  });

  it('PARTIAL is a one-parent commit and leaves the unresolved file at head’s blob', async () => {
    const f = twoFileFixture();
    use(f);
    const model = await openModel();
    const res = await land(
      model,
      bodyFor(model, [
        resolutionFor(model, 'a.txt', (_r, i) => (i === 0 ? 'theirs' : 'ours')),
      ]),
    );
    expect(res.stillConflicting).toBe(true);
    expect(res.resolvedPaths).toEqual(['a.txt']);
    const parents = f.repo.git(['rev-list', '--parents', '-n', '1', res.commitSha]).trim().split(' ');
    expect(parents.slice(1)).toEqual([f.headSha]);
    // ⚠ IDENTICAL BLOB OID, not merely identical text: the unresolved file is not rewritten,
    // so nothing about the base branch's version of it is silently taken.
    const ours = f.repo.git(['rev-parse', `${f.headSha}:b.txt`]).trim();
    expect(f.repo.git(['rev-parse', `${res.commitSha}:b.txt`]).trim()).toBe(ours);
    // The word "Merge" must not appear: this commit did not land the base branch.
    const message = f.repo.git(['show', '-s', '--format=%B', res.commitSha]);
    expect(message).toContain('Resolve conflicts in 1 of 2 files');
    expect(message).not.toContain('Merge');
  });

  it('⚠ a kept-`ours` region RE-CONFLICTS; a region left at `base` merges silently', async () => {
    // The asymmetry the UI copy is about. Both directions, because a future change to the
    // partial shape has to re-read this and decide again.
    const stagesFor = (repo: Repo, commit: string, base: string): string[] => {
      const out = spawnSync(
        'git',
        ['merge-tree', '--write-tree', '--name-only', commit, base],
        { cwd: repo.dir, env: CLEAN_ENV, encoding: 'utf8' },
      );
      // Section 2 of the non-`-z` output is the conflicted path list.
      return (out.stdout ?? '')
        .split('\n')
        .slice(1)
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && !s.includes(' '));
    };

    const kept = twoFileFixture();
    use(kept);
    const keptModel = await openModel();
    const keptRes = await land(
      keptModel,
      bodyFor(keptModel, [
        resolutionFor(keptModel, 'a.txt', (_r, i) => (i === 0 ? 'theirs' : 'ours')),
      ]),
    );
    expect(kept.repo.status(['merge-tree', '--write-tree', keptRes.commitSha, kept.baseSha])).toBe(1);
    expect(stagesFor(kept.repo, keptRes.commitSha, kept.baseSha)).toContain('a.txt');

    const ignored = twoFileFixture();
    use(ignored);
    const ignoredModel = await openModel();
    const ignoredRes = await land(
      ignoredModel,
      bodyFor(ignoredModel, [
        resolutionFor(ignoredModel, 'a.txt', (_r, i) => (i === 0 ? 'theirs' : 'base')),
      ]),
    );
    // a.txt no longer contests anything — and the base branch's text is what survives.
    expect(stagesFor(ignored.repo, ignoredRes.commitSha, ignored.baseSha)).not.toContain('a.txt');
    // b.txt still contests, so merge-tree exits 1 — the tree oid is on stdout regardless.
    const mergedTree = (
      spawnSync('git', ['merge-tree', '--write-tree', ignoredRes.commitSha, ignored.baseSha], {
        cwd: ignored.repo.dir,
        env: CLEAN_ENV,
        encoding: 'utf8',
      }).stdout ?? ''
    )
      .split('\n')[0]!
      .trim();
    expect(ignored.repo.bytes(['show', `${mergedTree}:a.txt`]).toString('utf8')).toBe(
      'alpha\none-theirs\nbeta\ntwo-theirs\ngamma\n',
    );
  });

  it('an all-`ours` partial writes nothing and pushes nothing', async () => {
    const f = twoFileFixture();
    use(f);
    const model = await openModel();
    expect(
      await refusal(() =>
        land(model, bodyFor(model, [resolutionFor(model, 'a.txt', () => 'ours')])),
      ),
    ).toBe('NothingToCommit');
    expect(pushRef).not.toHaveBeenCalled();
  });

  it('lists an unsupported file as skipped rather than dropping it', async () => {
    const binary = Buffer.from([0x89, 0x00, 0x01, 0x02, 0x0a]);
    const f = threeWay(
      { 'a.txt': A_BASE, 'bin.dat': binary },
      (r) => {
        r.write('a.txt', 'alpha\none-ours\nbeta\ntwo-ours\ngamma\n');
        r.write('bin.dat', Buffer.from([0x89, 0x00, 0x01, 0x03, 0x0a]));
      },
      (r) => {
        r.write('a.txt', 'alpha\none-theirs\nbeta\ntwo-theirs\ngamma\n');
        r.write('bin.dat', Buffer.from([0x89, 0x00, 0x01, 0x04, 0x0a]));
      },
    );
    use(f);
    const model = await openModel();
    const res = await land(
      model,
      bodyFor(model, [
        resolutionFor(model, 'a.txt', (_r, i) => (i === 0 ? 'theirs' : 'ours')),
      ]),
    );
    expect(res.stillConflicting).toBe(true);
    expect(res.skipped.map((s: any) => [s.path, s.reason])).toEqual([['bin.dat', 'binary']]);
    expect(f.repo.git(['show', '-s', '--format=%B', res.commitSha])).toContain(
      'Still conflicting: bin.dat',
    );
    // An unsupported file cannot be sent as a resolution either — the model is the allow-list.
    const stray = model.files.find((x: any) => x.path === 'bin.dat');
    expect(
      await refusal(() =>
        land(model, bodyFor(model, [{ index: stray.index, decisions: [] }])),
      ),
    ).toBe('UnknownFileIndex');
  });
});

describe('landConflictResolution — the refusals', () => {
  it('a moved head refuses before anything is pushed', async () => {
    const f = oneFileFixture();
    use(f);
    const model = await openModel();
    // The head advances between the session opening and the commit.
    f.repo.git(['checkout', '-q', 'feature']);
    f.repo.write('a.txt', 'alpha\none-ours-again\nbeta\ntwo-ours\ngamma\n');
    const moved = f.repo.commit('ours again');
    f.repo.git(['checkout', '-q', 'main']);
    remoteRefs.set('refs/pull/7/head', moved);

    expect(
      await refusal(() =>
        land(model, bodyFor(model, [resolutionFor(model, 'a.txt', () => 'ours')])),
      ),
    ).toBe('HeadMoved');
    expect(pushRef).not.toHaveBeenCalled();
    expect(pushForceWithLease).not.toHaveBeenCalled();
  });

  it('a stale model refuses without writing a single git object', async () => {
    const f = oneFileFixture();
    use(f);
    const model = await openModel();
    const before = f.repo.git(['count-objects', '-v']);
    const body = bodyFor(model, [resolutionFor(model, 'a.txt', () => 'ours')], {
      modelHash: 'not-the-hash',
    });
    expect(await refusal(() => land(model, body))).toBe('ModelStale');
    // Nothing was hashed, no tree was written, nothing was committed.
    expect(f.repo.git(['count-objects', '-v'])).toBe(before);
    expect(pushRef).not.toHaveBeenCalled();
  });

  it('an incomplete decision set is a refusal, never a default', async () => {
    const f = oneFileFixture();
    use(f);
    const model = await openModel();
    const file = model.files[0];
    const contested = file.regions.filter((r: any) => r.kind !== 'unchanged');
    expect(contested.length).toBe(2);
    const short = { index: file.index, decisions: [{ id: contested[0].id, decision: 'ours' }] };
    expect(await refusal(() => land(model, bodyFor(model, [short])))).toBe('IncompleteDecisions');
    expect(pushRef).not.toHaveBeenCalled();
  });

  it('an unknown suggestion id is a refusal, and a valid one lands its stored lines', async () => {
    const f = oneFileFixture();
    use(f);
    const model = await openModel();
    const file = model.files[0];
    const contested = file.regions.filter((r: any) => r.kind !== 'unchanged');
    const withSuggestion = {
      index: file.index,
      decisions: [
        { id: contested[0].id, decision: 'suggestion', suggestionId: 'sug-1' },
        { id: contested[1].id, decision: 'ours' },
      ],
    };
    expect(await refusal(() => land(model, bodyFor(model, [withSuggestion])))).toBe(
      'UnknownSuggestion',
    );

    // A suggestion whose stored ref names ANOTHER region is refused too — a handle that
    // travels is text nobody read in the place it lands.
    const wrongRegion = new Map([
      [
        'sug-1',
        {
          fileIndex: file.index,
          regionId: contested[1].id,
          lines: ['one-merged'],
          endsWithNewline: true,
        },
      ],
    ]);
    expect(
      await refusal(() => land(model, bodyFor(model, [withSuggestion]), wrongRegion)),
    ).toBe('UnknownSuggestion');

    const right = new Map([
      [
        'sug-1',
        {
          fileIndex: file.index,
          regionId: contested[0].id,
          lines: ['one-merged'],
          endsWithNewline: true,
        },
      ],
    ]);
    const res = await land(model, bodyFor(model, [withSuggestion]), right);
    expect(f.repo.bytes(['show', `${res.commitSha}:a.txt`]).toString('utf8')).toBe(
      'alpha\none-merged\nbeta\ntwo-ours\ngamma\n',
    );
  });

  it('refuses the repository’s own branches by name, whatever the case', async () => {
    const f = oneFileFixture();
    use(f);
    const model = await openModel();
    const files = [resolutionFor(model, 'a.txt', () => 'ours')];
    for (const branch of ['main', 'Main', 'MAIN']) {
      expect(
        await refusal(() =>
          land(
            model,
            bodyFor(model, files, { target: { kind: 'new_branch', branch, openPr: false } }),
          ),
        ),
      ).toBe('ReservedBranch');
    }
    expect(
      await refusal(() =>
        land(
          model,
          bodyFor(model, files, {
            target: { kind: 'new_branch', branch: 'a..b', openPr: false },
          }),
        ),
      ),
    ).toBe('InvalidBranch');
    expect(pushRef).not.toHaveBeenCalled();
  });

  it('takes the next free branch name rather than clobbering a live one', async () => {
    const f = oneFileFixture();
    use(f);
    const model = await openModel();
    ghRestGetText.mockImplementation(async (_token: string, path: string) =>
      path.endsWith('/resolve/7')
        ? { status: 200, ok: true, text: '{}' }
        : { status: 404, ok: false, text: '' },
    );
    const res = await land(
      model,
      bodyFor(model, [resolutionFor(model, 'a.txt', () => 'ours')], {
        target: { kind: 'new_branch', branch: 'resolve/7', openPr: true },
      }),
    );
    expect(res.branch).toBe('resolve/7-2');
    expect(res.pushedToPrBranch).toBe(false);
    expect(pushRef).toHaveBeenCalledTimes(1);
    expect(pushRef.mock.calls[0]![0].remoteBranch).toBe('resolve/7-2');
    expect(createPullRequest).toHaveBeenCalledTimes(1);
    expect(res.compareUrl).toBe('https://example.test/pr/99');
  });
});

describe('landConflictResolution — the base moved', () => {
  it('proceeds and says so when the base advanced but the conflict did not', async () => {
    const f = oneFileFixture();
    use(f);
    const model = await openModel();

    // The base branch gains a commit that touches nothing anyone contested.
    f.repo.write('quiet.txt', 'moved on again\n');
    const newBase = f.repo.commit('base branch moves on');
    remoteRefs.set('refs/heads/main', newBase);

    const res = await land(
      model,
      bodyFor(model, [resolutionFor(model, 'a.txt', () => 'ours')]),
    );
    expect(res.baseAdvanced).toBe(true);
    expect(res.baseShaUsed).toBe(newBase);
    // ⚠ The SECOND parent is the new tip, so the commit says which base it actually merged.
    const parents = f.repo.git(['rev-list', '--parents', '-n', '1', res.commitSha]).trim().split(' ');
    expect(parents.slice(1)).toEqual([f.headSha, newBase]);
    expect(f.repo.bytes(['show', `${res.commitSha}:quiet.txt`]).toString('utf8')).toBe(
      'moved on again\n',
    );
  });

  it('refuses when the base advanced INTO the conflict', async () => {
    const f = oneFileFixture();
    use(f);
    const model = await openModel();
    f.repo.write('a.txt', 'alpha\none-theirs\nbeta\ntwo-theirs-again\ngamma\n');
    remoteRefs.set('refs/heads/main', f.repo.commit('base branch edits the conflict'));
    expect(
      await refusal(() =>
        land(model, bodyFor(model, [resolutionFor(model, 'a.txt', () => 'ours')])),
      ),
    ).toBe('ModelStale');
    expect(pushRef).not.toHaveBeenCalled();
  });
});

describe('landConflictResolution — rebase', () => {
  it('reparents a single commit onto the base, and git agrees with the tree', async () => {
    const f = oneFileFixture();
    use(f);
    const model = await openModel();
    expect(model.strategies).toContain('rebase');

    const mergeRes = await land(
      model,
      bodyFor(model, [resolutionFor(model, 'a.txt', () => 'ours')]),
    );
    const mergeTree = f.repo.git(['rev-parse', `${mergeRes.commitSha}^{tree}`]).trim();

    const rebaseModel = await openModel();
    const rebaseRes = await land(
      rebaseModel,
      bodyFor(rebaseModel, [resolutionFor(rebaseModel, 'a.txt', () => 'ours')], {
        strategy: 'rebase',
      }),
    );
    const parents = f.repo
      .git(['rev-list', '--parents', '-n', '1', rebaseRes.commitSha])
      .trim()
      .split(' ');
    expect(parents.slice(1)).toEqual([f.baseSha]);
    // The resolved tree IS the merge path's tree — same three inputs, sides swapped.
    expect(f.repo.git(['rev-parse', `${rebaseRes.commitSha}^{tree}`]).trim()).toBe(mergeTree);
    // The author wrote the code; the account only moved it.
    const ident = f.repo
      .git(['show', '-s', '--format=%an%n%ae%n%cn%n%ce', rebaseRes.commitSha])
      .split('\n');
    expect(ident.slice(0, 2)).toEqual(['Original Author', 'original@example.com']);
    expect(ident.slice(2, 4)).toEqual(['viewer-me', 'viewer-me@users.noreply.github.com']);
    expect(f.repo.git(['show', '-s', '--format=%s', rebaseRes.commitSha]).trim()).toBe('ours');
    expect(pushForceWithLease).toHaveBeenCalledTimes(1);
    expect(pushForceWithLease.mock.calls[0]![0].leaseSha).toBe(f.headSha);

    // ⚠ THE EQUIVALENCE IS A CLAIM ABOUT GIT, so a REAL rebase has to produce the same tree.
    // Resolving each conflicted path with `--theirs` during a rebase takes the commit BEING
    // REPLAYED — which is exactly the all-`ours` resolution above.
    const scratch = mkdtempSync(join(tmpdir(), 'pierre-land-rebase-'));
    tempDirs.push(scratch);
    execFileSync('git', ['clone', '-q', f.repo.dir, scratch], { env: CLEAN_ENV });
    const sgit = (args: string[]): string =>
      execFileSync('git', args, {
        cwd: scratch,
        env: { ...CLEAN_ENV, GIT_EDITOR: 'true' },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    sgit(['checkout', '-q', '--detach', f.headSha]);
    spawnSync('git', ['rebase', '--onto', f.baseSha, f.mergeBaseSha], {
      cwd: scratch,
      env: { ...CLEAN_ENV, GIT_EDITOR: 'true' },
    });
    for (const path of sgit(['diff', '--name-only', '--diff-filter=U']).split('\n').filter(Boolean)) {
      sgit(['checkout', '--theirs', '--', path]);
      sgit(['add', '--', path]);
    }
    spawnSync('git', ['rebase', '--continue'], {
      cwd: scratch,
      env: { ...CLEAN_ENV, GIT_EDITOR: 'true' },
    });
    expect(sgit(['rev-parse', 'HEAD^{tree}']).trim()).toBe(mergeTree);
  });

  it('refuses a rebase above one commit, and builds nothing', async () => {
    const f = oneFileFixture(1);
    use(f);
    const model = await openModel();
    expect(model.strategies).toEqual(['merge']);
    // The plan fixes this copy verbatim: `This branch has 6 commits. Rebasing can conflict
    // once per commit — merge instead.` It names the COUNT (so the reader can check it against
    // their own branch) and it names the way forward. Pin both halves, not the whole sentence,
    // so a wording pass does not have to come back through here — but a reason that stops
    // saying how many commits, or stops offering merge, does.
    expect(model.rebaseUnavailableReason).toContain('2 commits');
    expect(model.rebaseUnavailableReason).toContain('merge instead');
    const before = f.repo.git(['count-objects', '-v']);
    expect(
      await refusal(() =>
        land(
          model,
          bodyFor(model, [resolutionFor(model, 'a.txt', () => 'ours')], { strategy: 'rebase' }),
        ),
      ),
    ).toBe('RebaseNotOffered');
    expect(f.repo.git(['count-objects', '-v'])).toBe(before);
    expect(pushForceWithLease).not.toHaveBeenCalled();
  });
});

describe('landConflictResolution — the surroundings', () => {
  it('disarms an armed auto-merge intent before pushing', async () => {
    // ⚠ NOT COSMETIC. A merge-strategy resolution commit has exactly the two-parent shape the
    // runner's `isOurUpdateMerge` proves against, so a live intent would ADOPT it and land
    // code nobody consented to merge.
    const f = oneFileFixture();
    use(f);
    await db
      .insert(schema.autoMergeRequests)
      .values({
        accountId: 1,
        prId,
        mergeMethod: 'merge',
        updateStrategy: 'merge',
        expectedHeadOid: f.headSha,
        state: 'armed',
        armedAt: new Date(),
        expiresAt: new Date(Date.now() + 3_600_000),
      })
      .execute();
    const model = await openModel();
    const res = await land(
      model,
      bodyFor(model, [resolutionFor(model, 'a.txt', () => 'ours')]),
    );
    expect(res.autoMergeDisarmed).toBe(true);
    const rows = await db
      .select()
      .from(schema.autoMergeRequests)
      .where(eq(schema.autoMergeRequests.prId, prId))
      .execute();
    expect(rows).toEqual([]);
  });

  it('leaves no temp index and no session refs behind, on success or refusal', async () => {
    const leftovers = (): string[] =>
      readdirSync(tmpdir()).filter((n) => n.startsWith('pierre-conflict-land-'));
    const before = new Set(leftovers());

    const f = oneFileFixture();
    use(f);
    const ok = await openModel();
    await land(ok, bodyFor(ok, [resolutionFor(ok, 'a.txt', () => 'ours')]));
    expect(f.repo.git(['for-each-ref', 'refs/pierre/conflict']).trim()).toBe('');

    // The refusal half uses a HEAD MOVE, because that is a bail AFTER the rebuild — the point
    // at which this attempt owns two freshly-fetched refs. ⚠ The clone is resolved BEFORE the
    // rebuild precisely so the teardown can reach them.
    const moving = await openModel();
    f.repo.git(['checkout', '-q', 'feature']);
    f.repo.write('a.txt', 'alpha\none-ours-moved\nbeta\ntwo-ours\ngamma\n');
    remoteRefs.set('refs/pull/7/head', f.repo.commit('head moves'));
    f.repo.git(['checkout', '-q', 'main']);
    expect(
      await refusal(() =>
        land(moving, bodyFor(moving, [resolutionFor(moving, 'a.txt', () => 'ours')])),
      ),
    ).toBe('HeadMoved');
    expect(f.repo.git(['for-each-ref', 'refs/pierre/conflict']).trim()).toBe('');
    expect(leftovers().filter((n) => !before.has(n))).toEqual([]);
    expect(existsSync(join(f.repo.dir, '.git', 'index.lock'))).toBe(false);
  });

  it('re-checks write permission at land time', async () => {
    const f = oneFileFixture();
    use(f);
    const model = await openModel();
    await db
      .update(schema.repos)
      .set({ viewerPermission: 'READ' })
      .where(eq(schema.repos.id, repoId))
      .execute();
    try {
      expect(
        await refusal(() =>
          land(model, bodyFor(model, [resolutionFor(model, 'a.txt', () => 'ours')])),
        ),
      ).toBe('NotPermitted');
      expect(pushRef).not.toHaveBeenCalled();
    } finally {
      await db
        .update(schema.repos)
        .set({ viewerPermission: 'WRITE' })
        .where(eq(schema.repos.id, repoId))
        .execute();
    }
  });

  it('never lets a push land on the repository’s own branches', async () => {
    const f = oneFileFixture();
    use(f);
    const model = await openModel();
    await land(model, bodyFor(model, [resolutionFor(model, 'a.txt', () => 'ours')]));
    expect(pushRef).toHaveBeenCalledTimes(1);
    const target = pushRef.mock.calls[0]![0];
    expect(target.remoteBranch).toBe('feature');
    expect(target.protect).toContain('main');
    expect(target.committish).toMatch(/^[0-9a-f]{40}$/);
  });
});

/* ───────────────── the fork refusal — knowable before the form, enforced at the push ──────────────── */

// ⚠ TWO CHECKS, ONE FACT, AND THE SECOND IS THE AUTHORISATION. `prBranchPushable` exists so the
// landing step never OFFERS "Push to <headRef>" for a head that lives in somebody else's
// repository — the refusal used to arrive only after the reader chose that option and pressed
// the button. The land route still re-reads the same two fields milliseconds before the push.
// Both halves are pinned here, because deleting either one leaves a green suite.
//
// `isFork` / `maintainerCanModify` are not synced columns, so both halves read the same live
// `fetchPrHeadInfo`. ⚠ The land path reads it TWICE — once inside its own fresh model build and
// once at the push — so this replaces the implementation and puts the default back, rather than
// counting calls.
async function withForkHead<T>(headSha: string, fn: () => Promise<T>): Promise<T> {
  fetchPrHeadInfo.mockImplementation(async () => ({
    headSha,
    headRef: 'feature',
    headRepoFullName: 'contributor/widgets',
    isFork: true,
    maintainerCanModify: false,
    baseRef: 'main',
  }));
  try {
    return await fn();
  } finally {
    fetchPrHeadInfo.mockImplementation(sameRepoHeadInfo);
  }
}

describe('a fork that does not allow maintainer edits', () => {
  it('says so on the model, before the reader fills anything in', async () => {
    const f = oneFileFixture();
    use(f);
    const model = await withForkHead(f.headSha, openModel);
    expect(model.prBranchPushable).toBe(false);
    // Pin the two facts, not the whole sentence: a wording pass should not have to come back
    // through here, but a reason that stops naming the fork or the setting should.
    expect(model.prBranchUnavailableReason).toContain('fork');
    expect(model.prBranchUnavailableReason).toContain('maintainer edits');
  });

  it('refuses the push anyway — the flag is an affordance, not the authorisation', async () => {
    const f = oneFileFixture();
    use(f);
    const code = await withForkHead(f.headSha, async () => {
      const model = await openModel();
      return refusal(() =>
        land(model, bodyFor(model, [resolutionFor(model, 'a.txt', () => 'ours')])),
      );
    });
    expect(code).toBe('PushDenied');
    expect(pushRef).not.toHaveBeenCalled();
    expect(pushForceWithLease).not.toHaveBeenCalled();
  });
});

describe('the PR branch when nothing is in the way', () => {
  it('a same-repo pull request offers its own branch', async () => {
    const f = oneFileFixture();
    use(f);
    const model = await openModel();
    expect(model.prBranchPushable).toBe(true);
    expect(model.prBranchUnavailableReason).toBeNull();
  });

  it('and a head-info failure costs the session nothing — it defaults to pushable', async () => {
    // ⚠ THE NON-FATAL HALF. A GitHub hiccup must not turn a working resolver into a dead one:
    // the session says "pushable", the option is offered, and the land route is what refuses.
    // That is exactly the behaviour that shipped before this field existed.
    const f = oneFileFixture();
    use(f);
    fetchPrHeadInfo.mockImplementationOnce(async () => {
      throw new Error('GitHub said no');
    });
    const model = await openModel();
    expect(model.prBranchPushable).toBe(true);
    expect(model.prBranchUnavailableReason).toBeNull();
  });
});
