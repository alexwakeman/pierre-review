// THE LAND PATH, against REAL GIT: the refusals and the confirming step (pin 5).
// What the land suites pin, and why, is written once at the top of land.test-support.ts, with
// the stubs, the real-git fixtures and the temp DB this file shares with the other two.
import { describe, expect, it } from 'vitest';
// ⚠ FIRST among the app imports: it registers the mocks and points DATABASE_URL at a temp file.
import {
  remoteRefs,
  createPullRequest,
  ghRestGetText,
  pushRef,
  pushForceWithLease,
  syncOnePr,
  schedulePrSettle,
  use,
  twoFileFixture,
  oneFileFixture,
  resolutionFor,
  bodyFor,
  openModel,
  land,
  refusal,
  db,
  schema,
  eq,
  landConflictResolution,
  prId,
  repoId,
  setGithubView,
} from './land.test-support.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

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

  // ── THE READER'S OWN TEXT ───────────────────────────────────────────────────────────────
  //
  // The manual edit reuses the suggestion's mechanism exactly — validated text held in the
  // session, an opaque handle on the wire — so it gets the same three assertions. The reason
  // they are worth repeating rather than trusting: these are the two guards standing between
  // an attacker-supplied id and a blob in somebody's repository, and each one is a single `&&`
  // clause away from not existing.
  it('an unknown edit id is a refusal, and a valid one lands the bytes the reader typed', async () => {
    const f = oneFileFixture();
    use(f);
    const model = await openModel();
    const file = model.files[0];
    const contested = file.regions.filter((r: any) => r.kind !== 'unchanged');
    const withEdit = {
      index: file.index,
      decisions: [
        { id: contested[0].id, decision: 'edited', editId: 'edit-1' },
        { id: contested[1].id, decision: 'ours' },
      ],
    };
    expect(await refusal(() => land(model, bodyFor(model, [withEdit])))).toBe('UnknownEdit');

    // ⚠ A HANDLE THAT TRAVELS IS TEXT NOBODY READ IN THE PLACE IT LANDS. The edit route pinned
    // this text to ONE region's fingerprint; a commit body naming a different region must not
    // redeem it.
    const wrongRegion = new Map([
      [
        'edit-1',
        {
          fileIndex: file.index,
          regionId: contested[1].id,
          lines: ['typed-by-hand'],
          endsWithNewline: true,
        },
      ],
    ]);
    expect(await refusal(() => land(model, bodyFor(model, [withEdit]), new Map(), wrongRegion))).toBe(
      'UnknownEdit',
    );

    // ...and an edit stored for another FILE is refused on the same clause.
    const wrongFile = new Map([
      [
        'edit-1',
        {
          fileIndex: file.index + 99,
          regionId: contested[0].id,
          lines: ['typed-by-hand'],
          endsWithNewline: true,
        },
      ],
    ]);
    expect(await refusal(() => land(model, bodyFor(model, [withEdit]), new Map(), wrongFile))).toBe(
      'UnknownEdit',
    );

    const right = new Map([
      [
        'edit-1',
        {
          fileIndex: file.index,
          regionId: contested[0].id,
          lines: ['typed-by-hand'],
          endsWithNewline: true,
        },
      ],
    ]);
    const res = await land(model, bodyFor(model, [withEdit]), new Map(), right);
    expect(f.repo.bytes(['show', `${res.commitSha}:a.txt`]).toString('utf8')).toBe(
      'alpha\ntyped-by-hand\nbeta\ntwo-ours\ngamma\n',
    );
  });

  it('a hand-edited LAST region sets the file’s terminator from its stored flag', async () => {
    // Fold rule 4. `endsWithNewline: false` on the last region's decision is the only thing
    // deciding whether the committed blob ends in a newline — guess it at file level and a
    // "\ No newline at end of file" appears in the diff on a line nobody touched.
    const f = oneFileFixture();
    use(f);
    const model = await openModel();
    const file = model.files[0];
    const regions = file.regions.filter((r: any) => r.kind !== 'unchanged');
    const last = regions[regions.length - 1];
    const decisions = regions.map((r: any) =>
      r.id === last.id
        ? { id: r.id, decision: 'edited', editId: 'tail' }
        : { id: r.id, decision: 'ours' },
    );
    const edits = new Map([
      [
        'tail',
        { fileIndex: file.index, regionId: last.id, lines: ['typed-tail'], endsWithNewline: true },
      ],
    ]);
    const res = await land(
      model,
      bodyFor(model, [{ index: file.index, decisions }]),
      new Map(),
      edits,
    );
    // `gamma` is an `unchanged` region AFTER the last decidable one, so the file's terminator
    // still comes off the base — what this proves is that the edited lines were spliced in the
    // right place and nothing else moved.
    expect(f.repo.bytes(['show', `${res.commitSha}:a.txt`]).toString('utf8')).toBe(
      'alpha\none-ours\nbeta\ntyped-tail\ngamma\n',
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
    // The PR it opened is synced too, by number INSIDE the original PR's repo — so it exists
    // locally before the reader is pointed at it.
    expect(syncOnePr).toHaveBeenCalledWith(repoId, 99, expect.anything());
  });
});

describe('landConflictResolution — confirming verifies the head', () => {
  // ⚠ THE BUG THIS PINS: confirming used to be a bare resync whose `visible` was "a sync ran".
  // GitHub attaches a push, and recomputes mergeability, asynchronously — so that read could
  // store the OLD head (or the new one with a stale CONFLICTING) and still say `visible: true`,
  // and the Pending board re-served the "Conflicts" card the reader had just resolved.

  it('the pushed commit is the stored head: visible, and nothing left to settle', async () => {
    const f = oneFileFixture();
    use(f);
    const model = await openModel();
    const res = await land(model, bodyFor(model, [resolutionFor(model, 'a.txt', () => 'ours')]));
    expect(res.visible).toBe(true);
    expect(schedulePrSettle).not.toHaveBeenCalled();
    const [row] = await db
      .select()
      .from(schema.pullRequests)
      .where(eq(schema.pullRequests.id, prId))
      .execute();
    expect(row.headSha).toBe(res.commitSha);
  });

  it('a stale head is NOT visible — bounded re-reads, then the settle ladder takes over', async () => {
    const f = oneFileFixture();
    use(f);
    setGithubView('stale-head');
    const model = await openModel();
    const res = await land(model, bodyFor(model, [resolutionFor(model, 'a.txt', () => 'ours')]));
    expect(res.visible).toBe(false);
    // The resync plus the inline re-reads — bounded, never a loop.
    expect(syncOnePr.mock.calls.length).toBeGreaterThan(1);
    expect(syncOnePr.mock.calls.length).toBeLessThanOrEqual(4);
    // A FULL resolution pushed to the PR's own branch: the ladder must not stop on the stale
    // CONFLICTING/DIRTY — a KNOWN value, which "both merge columns known" alone would accept.
    expect(schedulePrSettle).toHaveBeenCalledTimes(1);
    expect(schedulePrSettle).toHaveBeenCalledWith(1, prId, expect.anything(), {
      headSha: res.commitSha,
      notConflicting: true,
    });
  });

  it('the new head with a stale CONFLICTING verdict is visible, and still hands off', async () => {
    const f = oneFileFixture();
    use(f);
    setGithubView('pushed-head-stale-conflict');
    const model = await openModel();
    const res = await land(model, bodyFor(model, [resolutionFor(model, 'a.txt', () => 'ours')]));
    expect(res.visible).toBe(true);
    expect(schedulePrSettle).toHaveBeenCalledWith(1, prId, expect.anything(), {
      headSha: res.commitSha,
      notConflicting: true,
    });
  });

  it('a PARTIAL resolution never expects the conflict to clear', async () => {
    const f = twoFileFixture();
    use(f);
    setGithubView('pushed-head-stale-conflict');
    const model = await openModel();
    const res = await land(
      model,
      bodyFor(model, [resolutionFor(model, 'a.txt', (_r, i) => (i === 0 ? 'theirs' : 'ours'))]),
    );
    expect(res.stillConflicting).toBe(true);
    expect(res.visible).toBe(true);
    // Head met, both merge columns known, and CONFLICTING is the honest answer for a partial —
    // nothing to wait for.
    expect(schedulePrSettle).not.toHaveBeenCalled();
  });
});
