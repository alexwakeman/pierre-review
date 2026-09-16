import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// THE CLONE-CACHE JANITOR, against REAL git repositories. Nothing is mocked, because what is
// under test is a filesystem and git-ref fact: whether the two refs an abandoned resolver left
// behind are still there afterwards, and whether the two a LIVE session owns are.
//
// ⚠ CLONE_DIR is redirected to a temp tree BEFORE config.js loads (the clone-hygiene.test.ts
// pattern), or this would run over the developer's own ~/.pierre-review/clones.
const ROOT = mkdtempSync(join(tmpdir(), 'pierre-janitor-'));
const CLONE_DIR = join(ROOT, 'clones');
process.env.CLONE_DIR = CLONE_DIR;
process.env.DATABASE_URL = '/tmp/pierre-conflict-janitor-test.sqlite';
process.env.DEPLOYMENT_MODE = 'local';
process.env.DISABLE_SCHEDULER = 'true';

// ⚠ DYNAMIC, IN `beforeAll`, AND THIS IS NOT A STYLE CHOICE. A static `import` is HOISTED above
// the `process.env.CLONE_DIR` assignment above, so config.js would already hold the developer's
// real ~/.pierre-review/clones by the time it ran — and the first tick would sweep it. The
// clone-hygiene.test.ts comment says the same thing about the same trap.
let runConflictJanitorTick: typeof import('./janitor.js').runConflictJanitorTick;
let sessionIdOfRef: typeof import('./janitor.js').sessionIdOfRef;
let janitorTesting: typeof import('./janitor.js').__testing;
let claimSession: typeof import('./session.js').claimSession;
let sessionTesting: typeof import('./session.js').__testing;

/* eslint-disable @typescript-eslint/no-explicit-any */
const log = { warn: () => {}, info: () => {} } as any;

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
}

/** A real, tiny repo at `<CLONE_DIR>/<owner>__<name>` with one commit. */
function makeClone(entry: string): string {
  const dir = join(CLONE_DIR, entry);
  mkdirSync(dir, { recursive: true });
  git(['init', '-q', '-b', 'main'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'base'], dir);
  return dir;
}

/** The two refs one resolver session leaves in a clone. */
function addSessionRefs(repo: string, sessionId: string): void {
  const head = git(['rev-parse', 'HEAD'], repo).trim();
  for (const side of ['head', 'base']) {
    git(['update-ref', `refs/pierre/conflict/${sessionId}/${side}`, head], repo);
  }
}

const refsIn = (repo: string): string[] =>
  git(['for-each-ref', '--format=%(refname)'], repo)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

beforeAll(async () => {
  ({ runConflictJanitorTick, sessionIdOfRef, __testing: janitorTesting } = await import(
    './janitor.js'
  ));
  ({ claimSession, __testing: sessionTesting } = await import('./session.js'));
  // Fail loudly rather than sweeping a real cache: if the redirect did not take, every
  // assertion below would be measuring the developer's machine.
  expect((await import('../config.js')).config.cloneDir).toBe(CLONE_DIR);
});

beforeEach(() => {
  rmSync(CLONE_DIR, { recursive: true, force: true });
  mkdirSync(CLONE_DIR, { recursive: true });
  sessionTesting.reset();
  janitorTesting.reset();
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  for (const s of ['', '-shm', '-wal']) {
    rmSync('/tmp/pierre-conflict-janitor-test.sqlite' + s, { force: true });
  }
});

describe('sessionIdOfRef', () => {
  it('reads the session id out of a resolver ref', () => {
    expect(sessionIdOfRef('refs/pierre/conflict/abc-123/head')).toBe('abc-123');
    expect(sessionIdOfRef('refs/pierre/conflict/abc-123/base')).toBe('abc-123');
  });

  it('returns null for anything it does not recognise — and an unrecognised ref is KEPT', () => {
    // A janitor that guessed here would delete somebody's objects. `null` routes to the keep
    // branch in `sweepOneClone`, not the delete branch.
    expect(sessionIdOfRef('refs/heads/main')).toBeNull();
    expect(sessionIdOfRef('refs/pierre/conflict/')).toBeNull();
    expect(sessionIdOfRef('refs/pierre/conflict/no-side-segment')).toBeNull();
  });
});

describe('the clone-cache janitor', () => {
  it('drops the refs of a session that no longer exists', async () => {
    const repo = makeClone('octocat__hello');
    addSessionRefs(repo, 'abandoned-session');
    git(['update-ref', 'refs/heads/keep-me', git(['rev-parse', 'HEAD'], repo).trim()], repo);

    const report = await runConflictJanitorTick(log);

    expect(report.refsDeleted).toBe(2);
    expect(refsIn(repo).filter((r) => r.startsWith('refs/pierre/conflict/'))).toEqual([]);
    // ⚠ NOTHING ELSE. The janitor owns one namespace; a branch is not its business.
    expect(refsIn(repo)).toContain('refs/heads/keep-me');
  });

  it('⚠ KEEPS the refs of a session that is still open', async () => {
    const repo = makeClone('octocat__hello');
    const claim = claimSession(1, 42, { restart: false, autoApply: true });
    if (claim.kind !== 'created') throw new Error('expected a fresh session');
    addSessionRefs(repo, claim.session.sessionId);
    addSessionRefs(repo, 'abandoned-session');

    const report = await runConflictJanitorTick(log);

    // This is the ONE thing the boot sweep does not have to get right — at boot every conflict
    // ref is an orphan by definition, because no job survives a restart. In a running process a
    // session sitting at `ready` still owns its refs and its commit re-reads them; deleting them
    // breaks a resolution somebody is in the middle of.
    expect({ deleted: report.refsDeleted, kept: report.refsKept }).toEqual({ deleted: 2, kept: 2 });
    expect(refsIn(repo).filter((r) => r.startsWith('refs/pierre/conflict/')).sort()).toEqual([
      `refs/pierre/conflict/${claim.session.sessionId}/base`,
      `refs/pierre/conflict/${claim.session.sessionId}/head`,
    ]);
  });

  it('⚠ COLLECTS the refs of a session that expired with nobody left to sweep it', async () => {
    const repo = makeClone('octocat__hello');
    const claim = claimSession(1, 42, { restart: false, autoApply: true });
    if (claim.kind !== 'created') throw new Error('expected a fresh session');
    addSessionRefs(repo, claim.session.sessionId);
    // THE ABANDONED TAB — the case this janitor exists for. The build settled, the reader closed
    // the browser tab (which runs no React cleanup, so the deferred DELETE never landed), and no
    // conflict route is ever called again. Every OTHER sweep in session.ts is request-driven, so
    // if the keep-list did not expire records itself, this session would report itself live on
    // every tick forever and its two refs would be kept against every repack.
    claim.session.openRunning = false;
    claim.session.expiresAt = Date.now() - 1;

    const report = await runConflictJanitorTick(log);

    expect({ deleted: report.refsDeleted, kept: report.refsKept }).toEqual({ deleted: 2, kept: 0 });
    expect(refsIn(repo).filter((r) => r.startsWith('refs/pierre/conflict/'))).toEqual([]);
    expect(sessionTesting.sessions.size).toBe(0);
  });

  it('sweeps every clone in the cache, and skips what is not one', async () => {
    const a = makeClone('octocat__hello');
    const b = makeClone('acme__web');
    addSessionRefs(a, 'gone-a');
    addSessionRefs(b, 'gone-b');
    // Not a clone: no `.git`, and no `owner__name` shape. Both must be skipped silently rather
    // than throwing the tick away.
    mkdirSync(join(CLONE_DIR, 'not-a-clone'), { recursive: true });
    writeFileSync(join(CLONE_DIR, 'stray-file'), 'x');

    const report = await runConflictJanitorTick(log);

    expect({ scanned: report.clonesScanned, deleted: report.refsDeleted }).toEqual({
      scanned: 2,
      deleted: 4,
    });
  });

  it('is a no-op on an empty cache and never throws', async () => {
    rmSync(CLONE_DIR, { recursive: true, force: true });
    const report = await runConflictJanitorTick(log);
    expect(report).toEqual({
      clonesScanned: 0,
      refsDeleted: 0,
      refsKept: 0,
      reposGarbageCollected: 0,
    });
  });
});
