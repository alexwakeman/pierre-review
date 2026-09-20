import { describe, expect, it } from 'vitest';
import type {
  ConflictCommitResult,
  ConflictFileContent,
  ConflictFileEntry,
  ConflictRegion,
  ConflictSession,
} from '@pierre-review/shared';
import {
  buildCommitBody,
  commitPlan,
  landingTargets,
  stillConflictingPaths,
} from '../src/lib/conflictCommit.js';

// Region ids are stable only WITHIN their file, so every fixture here reuses 1/2/3 across files
// deliberately: a fold keyed on a bare region id cross-links one file's region onto another's.
function region(id: number, kind: ConflictRegion['kind']): ConflictRegion {
  return {
    id,
    kind,
    fingerprint: `fp-${id}`,
    base: [],
    ours: [],
    theirs: [],
    defaultDecision: 'base',
    allowed: ['base', 'ours', 'theirs'],
    wand: null,
  };
}

function entry(index: number, path: string, over: Partial<ConflictFileEntry> = {}): ConflictFileEntry {
  return {
    index,
    path,
    relatedPaths: [],
    unsupported: null,
    unsupportedLabel: null,
    regionCount: 2,
    conflictCount: 1,
    // ⚠ THE GATE'S DENOMINATOR FOR A FILE NOBODY OPENED. Two decidable regions to match the two
    // this fixture's `content()` callers hand in.
    decidableCount: 2,
    wandResolvableCount: 0,
    maxSideBytes: 100,
    ...over,
  };
}

function content(index: number, path: string, regions: ConflictRegion[]): ConflictFileContent {
  return { index, path, terminators: { base: true, ours: true, theirs: true }, regions };
}

function session(
  files: ConflictFileEntry[],
  over: Partial<ConflictSession> = {},
): ConflictSession {
  return {
    sessionId: 'sess-1',
    prId: 7,
    status: 'ready',
    phase: null,
    error: null,
    headSha: 'head0000',
    baseSha: 'base0000',
    modelHash: 'model0000',
    mergeBaseSha: 'mb00',
    mergeBaseIsVirtual: false,
    baseRef: 'main',
    headRef: 'feature/x',
    files,
    unsupportedIndexes: files.filter((f) => f.unsupported != null).map((f) => f.index),
    fullyResolvable: files.every((f) => f.unsupported == null),
    autoApplied: true,
    renameDetection: 'on',
    truncated: false,
    totalConflictedPaths: files.length,
    strategies: ['merge'],
    rebaseUnavailableReason: null,
    prBranchPushable: true,
    prBranchUnavailableReason: null,
    reservedBranchNames: ['main'],
    commit: null,
    ...over,
  };
}

describe('commitPlan', () => {
  it('splits the files into what goes in and what stays conflicted', () => {
    const s = session([
      entry(0, 'src/a.ts'),
      entry(1, 'src/b.ts'),
      entry(2, 'src/c.ts'),
      entry(3, 'assets/logo.png', {
        unsupported: 'binary',
        unsupportedLabel: 'A binary file',
        regionCount: 0,
        conflictCount: 0,
        decidableCount: 0,
      }),
    ]);
    const loaded = {
      0: content(0, 'src/a.ts', [region(1, 'conflict'), region(2, 'ours_only')]),
      1: content(1, 'src/b.ts', [region(1, 'conflict'), region(2, 'conflict')]),
      2: content(2, 'src/c.ts', [region(1, 'conflict')]),
    };
    const decisions = {
      '0:1': 'ours' as const,
      '0:2': 'ours' as const,
      // b.ts is HALF decided.
      '1:1': 'theirs' as const,
    };

    const plan = commitPlan(s, loaded, decisions);
    expect(plan.totalFiles).toBe(4);
    expect(plan.resolved.map((r) => r.path)).toEqual(['src/a.ts']);
    expect(plan.stillConflicted.map((r) => r.path)).toEqual([
      'src/b.ts',
      'src/c.ts',
      'assets/logo.png',
    ]);
    // Each row says WHY, in its own words — the server's noun phrase for the unsupported one.
    expect(plan.stillConflicted.map((r) => r.label)).toEqual([
      '1 of 2 decided',
      'Nothing decided',
      'A binary file',
    ]);
    // Contested regions in the RESOLVED files only: a.ts's one conflict, not the `ours_only` beside
    // it and not b.ts's decided half.
    expect(plan.conflictsResolved).toBe(1);
  });

  it('calls a file nobody opened untouched, not resolved', () => {
    const s = session([entry(0, 'src/a.ts')]);
    const plan = commitPlan(s, {}, {});
    expect(plan.resolved).toEqual([]);
    expect(plan.stillConflicted[0]?.state).toBe('untouched');
    expect(plan.stillConflicted[0]?.label).toBe('Not opened');
  });
});

describe('the commit gate', () => {
  // ⚠ WHAT THIS EXISTS FOR. A half-decided file used to be dropped from the commit body and
  // listed as "Still conflicted" — a silent exclusion wearing a label. Nothing is excluded from a
  // commit without the reader choosing it now, and `canCommit` is the one predicate that says so.

  it('blocks while any supported file still has an undecided region', () => {
    const s = session([entry(0, 'src/a.ts'), entry(1, 'src/b.ts')]);
    const loaded = {
      0: content(0, 'src/a.ts', [region(1, 'conflict'), region(2, 'ours_only')]),
      1: content(1, 'src/b.ts', [region(1, 'conflict'), region(2, 'conflict')]),
    };
    const plan = commitPlan(s, loaded, { '0:1': 'ours', '0:2': 'ours', '1:1': 'theirs' });
    expect(plan.canCommit).toBe(false);
    expect(plan.outstanding).toEqual([
      { index: 1, path: 'src/b.ts', remaining: 1, opened: true },
    ]);
    expect(plan.decidableTotal).toBe(4);
    expect(plan.decidedTotal).toBe(3);
  });

  it('counts a file nobody opened from the manifest, not from regions it does not have', () => {
    // The load-bearing one. A file whose regions were never fetched carries no decisions and
    // cannot be folded — its whole `decidableCount` is outstanding, or the gate would open over
    // work nobody has seen.
    const s = session([entry(0, 'src/a.ts', { decidableCount: 1 }), entry(1, 'src/b.ts', { decidableCount: 3 })]);
    const plan = commitPlan(s, { 0: content(0, 'src/a.ts', [region(1, 'conflict')]) }, { '0:1': 'ours' });
    expect(plan.canCommit).toBe(false);
    expect(plan.outstanding).toEqual([
      { index: 1, path: 'src/b.ts', remaining: 3, opened: false },
    ]);
    expect(plan.decidableTotal).toBe(4);
    expect(plan.decidedTotal).toBe(1);
  });

  it('never lists an unsupported file as outstanding — the model excluded it, not the reader', () => {
    const s = session([
      entry(0, 'src/a.ts', { decidableCount: 1 }),
      entry(1, 'assets/logo.png', {
        unsupported: 'binary',
        unsupportedLabel: 'A binary file',
        regionCount: 0,
        conflictCount: 0,
        decidableCount: 0,
      }),
    ]);
    const plan = commitPlan(s, { 0: content(0, 'src/a.ts', [region(1, 'conflict')]) }, { '0:1': 'ours' });
    expect(plan.outstanding).toEqual([]);
    expect(plan.canCommit).toBe(true);
    // It is still named on screen, with the server's own noun phrase.
    expect(plan.stillConflicted.map((r) => r.label)).toEqual(['A binary file']);
  });

  it('still refuses when every file is unsupported', () => {
    const s = session([
      entry(0, 'assets/logo.png', {
        unsupported: 'binary',
        unsupportedLabel: 'A binary file',
        regionCount: 0,
        conflictCount: 0,
        decidableCount: 0,
      }),
    ]);
    const plan = commitPlan(s, {}, {});
    expect(plan.outstanding).toEqual([]);
    // Nothing outstanding, and nothing to commit either.
    expect(plan.canCommit).toBe(false);
  });

  it('⚠ a file with nothing decidable neither ships nor blocks', () => {
    const s = session([
      entry(0, 'src/a.ts', { decidableCount: 1 }),
      entry(1, 'src/empty.ts', { regionCount: 2, conflictCount: 0, decidableCount: 0 }),
    ]);
    const plan = commitPlan(
      s,
      {
        0: content(0, 'src/a.ts', [region(1, 'conflict')]),
        1: content(1, 'src/empty.ts', [region(1, 'unchanged'), region(2, 'unchanged')]),
      },
      { '0:1': 'ours' },
    );
    expect(plan.resolved.map((r) => r.path)).toEqual(['src/a.ts']);
    expect(plan.outstanding).toEqual([]);
    expect(plan.canCommit).toBe(true);
    // ⚠ NOT "Nothing decided" — that accuses the reader of something there was nothing to do.
    expect(plan.rows[1]?.label).toBe('Nothing to decide');
    // ⚠ AND IT MUST STILL BE NAMED ON SCREEN. It is dropped from the commit and the pull request
    // stays conflicted on it, so it rides `notCarried` — the list the landing step renders. A
    // filter of `state === 'unsupported'` would leave it nowhere at all.
    expect(plan.notCarried.map((r) => r.path)).toEqual(['src/empty.ts']);
  });

  it('⚠ `notCarried` is every dropped file, never just the unsupported ones', () => {
    const s = session([
      entry(0, 'src/done.ts', { decidableCount: 1 }),
      entry(1, 'src/half.ts', { decidableCount: 2 }),
      entry(2, 'src/empty.ts', { regionCount: 1, conflictCount: 0, decidableCount: 0 }),
      entry(3, 'assets/logo.png', {
        unsupported: 'binary',
        unsupportedLabel: 'A binary file',
        regionCount: 0,
        conflictCount: 0,
        decidableCount: 0,
      }),
    ]);
    const plan = commitPlan(
      s,
      {
        0: content(0, 'src/done.ts', [region(1, 'conflict')]),
        1: content(1, 'src/half.ts', [region(1, 'conflict'), region(2, 'ours_only')]),
        2: content(2, 'src/empty.ts', [region(1, 'unchanged')]),
      },
      { '0:1': 'ours', '1:1': 'ours' },
    );
    // The half-decided file is named ABOVE, in "Still to decide", and holds the commit shut — so
    // it must NOT be repeated here.
    expect(plan.outstanding.map((o) => o.path)).toEqual(['src/half.ts']);
    expect(plan.notCarried.map((r) => r.path)).toEqual(['src/empty.ts', 'assets/logo.png']);
    // Every file the commit will not carry is named in exactly one of the two lists.
    const named = new Set([
      ...plan.resolved.map((r) => r.path),
      ...plan.outstanding.map((o) => o.path),
      ...plan.notCarried.map((r) => r.path),
    ]);
    expect(named.size).toBe(s.files.length);
  });

  it('opens the commit only when every decidable region in every supported file is answered', () => {
    const s = session([entry(0, 'src/a.ts'), entry(1, 'src/b.ts')]);
    const loaded = {
      0: content(0, 'src/a.ts', [region(1, 'conflict'), region(2, 'ours_only')]),
      1: content(1, 'src/b.ts', [region(1, 'theirs_only'), region(2, 'conflict')]),
    };
    const plan = commitPlan(s, loaded, {
      '0:1': 'ours',
      '0:2': 'base',
      '1:1': 'theirs',
      '1:2': 'both_ours_first',
    });
    expect(plan.canCommit).toBe(true);
    expect(plan.outstanding).toEqual([]);
    expect(plan.resolved.map((r) => r.path)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(plan.decidedTotal).toBe(plan.decidableTotal);
  });
});

describe('buildCommitBody', () => {
  it('omits a half-decided file WHOLE rather than sending part of it', () => {
    // ⚠ THE SECOND LINE OF DEFENCE, NOW UNREACHABLE FROM THE UI. `plan.canCommit` is false while
    // b.ts holds an unanswered region, and the landing step's button gates on it — so this state
    // cannot be submitted. It is pinned anyway: `decisions` is exhaustive per file server-side,
    // so a partially serialised file is `IncompleteDecisions`, which refuses the WHOLE commit and
    // takes every other file's work down with it.
    const s = session([entry(0, 'src/a.ts'), entry(1, 'src/b.ts')]);
    const loaded = {
      0: content(0, 'src/a.ts', [region(1, 'conflict')]),
      1: content(1, 'src/b.ts', [region(1, 'conflict'), region(2, 'conflict')]),
    };
    const decisions = { '0:1': 'ours', '1:1': 'theirs' } as const;
    const plan = commitPlan(s, loaded, decisions);
    expect(plan.canCommit).toBe(false);
    const body = buildCommitBody({
      session: s,
      plan,
      loaded,
      decisions,
      suggestionIds: {},
      strategy: 'merge',
      target: { kind: 'pr_branch' },
    });
    expect(body.files.map((f) => f.index)).toEqual([0]);
    expect(body.files[0]?.decisions).toEqual([{ id: 1, decision: 'ours' }]);
  });

  it('echoes the pins the reader was looking at', () => {
    const s = session([entry(0, 'src/a.ts', { decidableCount: 1 })]);
    const loaded = { 0: content(0, 'src/a.ts', [region(1, 'conflict')]) };
    const decisions = { '0:1': 'ours' } as const;
    const body = buildCommitBody({
      session: s,
      plan: commitPlan(s, loaded, decisions),
      loaded,
      decisions,
      suggestionIds: {},
      strategy: 'rebase',
      target: { kind: 'new_branch', branch: 'fix/x', openPr: true },
    });
    expect(body.sessionId).toBe('sess-1');
    expect(body.expectedHeadSha).toBe('head0000');
    expect(body.expectedBaseSha).toBe('base0000');
    expect(body.modelHash).toBe('model0000');
    expect(body.strategy).toBe('rebase');
    expect(body.target).toEqual({ kind: 'new_branch', branch: 'fix/x', openPr: true });
  });
});

describe('stillConflictingPaths', () => {
  it('unions the server’s refusals with the files we never sent', () => {
    // ⚠ TWO POPULATIONS. A file we omitted because the reader half-decided it never reached the
    // server, so it cannot appear in `result.skipped` — naming only one list leaves the reader with
    // a still-conflicted PR for a reason nothing on screen mentioned.
    const s = session([
      entry(0, 'src/a.ts'),
      entry(1, 'src/b.ts'),
      entry(2, 'assets/logo.png', {
        unsupported: 'binary',
        unsupportedLabel: 'A binary file',
        regionCount: 0,
        conflictCount: 0,
        decidableCount: 0,
      }),
    ]);
    const plan = commitPlan(
      s,
      {
        0: content(0, 'src/a.ts', [region(1, 'conflict')]),
        1: content(1, 'src/b.ts', [region(1, 'conflict'), region(2, 'conflict')]),
      },
      { '0:1': 'ours', '1:1': 'ours' },
    );
    const result: ConflictCommitResult = {
      strategy: 'merge',
      branch: 'feature/x',
      pushedToPrBranch: true,
      commitSha: 'abcdef1234',
      resolvedPaths: ['src/a.ts'],
      skipped: [{ index: 2, path: 'assets/logo.png', reason: 'binary', label: 'A binary file' }],
      stillConflicting: true,
      baseAdvanced: false,
      baseShaUsed: 'base0000',
      autoMergeDisarmed: false,
      compareUrl: null,
      visible: true,
    };
    expect(stillConflictingPaths(result, plan)).toEqual(['assets/logo.png', 'src/b.ts']);
  });
});

/* ───────────────────────────── where the commit goes ───────────────────────────── */

// ⚠ THE LANDING STEP USED TO OFFER AN OPTION THAT COULD NOT WORK. "Push to <headRef>" was always
// rendered, because the session carried no fact about whether the head branch was writable — so a
// fork pull request without maintainer edits was refused only AFTER the reader chose that target
// and pressed "Commit and push". The session now carries the fact and the option is HIDDEN.
//
// This is the fold `LandingStep` renders through. The frontend suite has no DOM renderer, so the
// component's own JSX is not under test here — what is under test is the decision it renders,
// which is where the two ways of getting this wrong live.
describe('landingTargets', () => {
  it('offers the PR branch, and starts on it, when the branch can be pushed to', () => {
    const t = landingTargets(session([entry(0, 'a.ts')]), false);
    expect(t.offerPrBranch).toBe(true);
    expect(t.toNewBranch).toBe(false);
    // No note: there is nothing to explain when both options are on screen.
    expect(t.prBranchNote).toBeNull();
  });

  it('hides the PR branch and starts on the new branch when it cannot', () => {
    const s = session([entry(0, 'a.ts')], {
      prBranchPushable: false,
      prBranchUnavailableReason: 'This pull request comes from a fork.',
    });
    const t = landingTargets(s, false);
    expect(t.offerPrBranch).toBe(false);
    expect(t.toNewBranch).toBe(true);
    // The server's sentence, verbatim — this screen does not compose its own.
    expect(t.prBranchNote).toBe('This pull request comes from a fork.');
  });

  it('⚠ still lands on the new branch when the radio state says otherwise', () => {
    // THE RACE. `newBranchChosen` is the reader's radio state and starts false; a session that
    // arrives — or flips — after the mount would otherwise leave the commit body carrying
    // `pr_branch` for a target the screen never offered. Derived, never corrected by a setState.
    const s = session([entry(0, 'a.ts')], {
      prBranchPushable: false,
      prBranchUnavailableReason: 'This pull request comes from a fork.',
    });
    expect(landingTargets(s, false).toNewBranch).toBe(true);
  });

  it('and the reader can still choose the new branch when the PR branch is on offer', () => {
    const t = landingTargets(session([entry(0, 'a.ts')]), true);
    expect(t.offerPrBranch).toBe(true);
    expect(t.toNewBranch).toBe(true);
  });
});
