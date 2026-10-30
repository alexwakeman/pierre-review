// THE LAND PATH, against REAL GIT: the bytes, the base moving and the rebase (pins 1, 4 and 6).
// What the land suites pin, and why, is written once at the top of land.test-support.ts, with
// the stubs, the real-git fixtures and the temp DB this file shares with the other two.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// ⚠ FIRST among the app imports: it registers the mocks and points DATABASE_URL at a temp file.
import {
  remoteRefs,
  pushRef,
  pushForceWithLease,
  CLEAN_ENV,
  tempDirs,
  threeWay,
  use,
  twoFileFixture,
  oneFileFixture,
  resolutionFor,
  bodyFor,
  openModel,
  land,
  refusal,
  landConflictResolution,
  hasConflictMarkers,
  foldFile,
  foldToText,
  CONFLICT_GIT_ENV,
  A_BASE,
  B_BASE,
} from './land.test-support.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

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
