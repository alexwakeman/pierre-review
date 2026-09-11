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

describe('buildCommitBody', () => {
  it('omits a half-decided file WHOLE rather than sending part of it', () => {
    // ⚠ THE RULE THIS FILE EXISTS FOR. `decisions` is exhaustive per file server-side, so a
    // partially serialised file is `IncompleteDecisions` — which refuses the WHOLE commit and takes
    // every other file's work down with it.
    const s = session([entry(0, 'src/a.ts'), entry(1, 'src/b.ts')]);
    const loaded = {
      0: content(0, 'src/a.ts', [region(1, 'conflict')]),
      1: content(1, 'src/b.ts', [region(1, 'conflict'), region(2, 'conflict')]),
    };
    const body = buildCommitBody({
      session: s,
      loaded,
      decisions: { '0:1': 'ours', '1:1': 'theirs' },
      suggestionIds: {},
      strategy: 'merge',
      target: { kind: 'pr_branch' },
    });
    expect(body.files.map((f) => f.index)).toEqual([0]);
    expect(body.files[0]?.decisions).toEqual([{ id: 1, decision: 'ours' }]);
  });

  it('echoes the pins the reader was looking at', () => {
    const s = session([entry(0, 'src/a.ts')]);
    const body = buildCommitBody({
      session: s,
      loaded: { 0: content(0, 'src/a.ts', [region(1, 'conflict')]) },
      decisions: { '0:1': 'ours' },
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
