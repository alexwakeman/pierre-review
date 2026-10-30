// THE LAND PATH, against REAL GIT: full vs partial, the surroundings and the fork refusal (pins 2 and 3).
// What the land suites pin, and why, is written once at the top of land.test-support.ts, with
// the stubs, the real-git fixtures and the temp DB this file shares with the other two.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// ⚠ FIRST among the app imports: it registers the mocks and points DATABASE_URL at a temp file.
import {
  remoteRefs,
  sameRepoHeadInfo,
  fetchPrHeadInfo,
  pushRef,
  pushForceWithLease,
  CLEAN_ENV,
  threeWay,
  use,
  twoFileFixture,
  oneFileFixture,
  resolutionFor,
  bodyFor,
  openModel,
  land,
  refusal,
  Repo,
  db,
  schema,
  eq,
  landConflictResolution,
  prId,
  repoId,
  A_BASE,
} from './land.test-support.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

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

  // ⚠ THIS ONE TEST IS TWO OF EVERYTHING — two fixtures, two model builds, two lands — because
  // the asymmetry it pins only exists as a comparison, so both halves have to be built and
  // landed for real. That makes it roughly double the git spawns of every other test in this
  // file, and the file-wide 90s ceiling (vitest.config.ts, which measures the per-spawn tax and
  // explains where the number came from) is a budget for ONE land. Measured at 113s during a
  // full `pnpm test` with a green assertion behind it, while its single-land neighbours in the
  // same run came in at 62-71s. So: the same 90s budget, twice. Not a licence to be slow —
  // `conflict/git.ts` still kills any single git command at 120s, so a hung or lock-waiting git
  // fails the run rather than sitting here.
  const TWO_LANDS_TIMEOUT_MS = 180_000;
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
  }, TWO_LANDS_TIMEOUT_MS);

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
