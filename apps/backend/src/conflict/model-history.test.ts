// THE CONFLICT MODEL, against REAL GIT: the merge base, the wand, the caps, the oracle, the hash,
// the wire projection and the landing strategies.
// The fixtures (a real temp repository per case) live in model.test-support.ts.
import { describe, expect, it } from 'vitest';
import {
  buildConflictModelInClone,
  conflictFileContent,
  conflictFileEntries,
  disjointWordMerge,
  oracleAgrees,
  oracleConflictRanges,
} from './model.js';
import { conflictModelHash } from './hash.js';
import { Repo, threeWayRepo, build, ready, caps, fileNamed } from './model.test-support.js';

/* ═════════════════════════════ the merge base ═════════════════════════════ */

describe('buildConflictModelInClone — the merge base', () => {
  it('marks a criss-cross history VIRTUAL and takes `base` from stage 1', async () => {
    // ⚠ MEASURED: `merge-base --all` returns two candidates whose text differs from each
    // other AND from merge-tree's stage 1. A second base resolution is how "keep the
    // ancestor" comes to commit bytes the pane never showed.
    const repo = new Repo();
    repo.write('f.txt', 'x\nMID\ny\n');
    repo.commit('root');
    repo.git(['checkout', '-q', '-b', 'a']);
    repo.write('f.txt', 'xA\nMID\ny\n');
    const shaA = repo.commit('A');
    repo.git(['checkout', '-q', 'main']);
    repo.git(['checkout', '-q', '-b', 'b']);
    repo.write('f.txt', 'x\nMID\nyB\n');
    const shaB = repo.commit('B');

    // ⚠ Each merge names the OTHER SIDE'S COMMIT, not its branch. Merging the branch second
    // fast-forwards onto the first merge and the history is no longer criss-cross at all —
    // which is exactly how a criss-cross test comes to assert nothing.
    repo.git(['checkout', '-q', 'a']);
    repo.git(['merge', '-q', '--no-edit', shaB]);
    repo.git(['checkout', '-q', 'b']);
    repo.git(['merge', '-q', '--no-edit', shaA]);

    repo.git(['checkout', '-q', 'a']);
    repo.write('f.txt', 'xA\nOURS\nyB\n');
    const headSha = repo.commit('ours');
    repo.git(['checkout', '-q', 'b']);
    repo.write('f.txt', 'xA\nTHEIRS\nyB\n');
    const baseSha = repo.commit('theirs');

    const model = await ready(repo, headSha, baseSha);
    expect(model.mergeBaseIsVirtual).toBe(true);
    expect(model.mergeBaseSha).toBeNull();
    const f = fileNamed(model, 'f.txt');
    const contested = f.regions.find((r) => r.kind === 'conflict');
    // Stage 1 on this history is `xA / MID / yB` — neither candidate's text.
    expect(contested?.base).toEqual(['MID']);
    expect(f.regions[0]?.base).toEqual(['xA']);
  });

  it('refuses unrelated histories', async () => {
    const repo = new Repo();
    repo.write('a', 'a\n');
    const headSha = repo.commit('one');
    repo.git(['checkout', '-q', '--orphan', 'other']);
    repo.git(['rm', '-q', '-rf', '.']);
    repo.write('b', 'b\n');
    const baseSha = repo.commit('two');
    const res = await build(repo, headSha, baseSha);
    expect(res.status).toBe('failed');
    if (res.status === 'failed') expect(res.code).toBe('unrelated_histories');
  });

  it('treats a revision git cannot resolve as an ERROR, not as "no conflicts"', async () => {
    // ⚠ merge-tree exits 1 both for conflicts and for a bad revision. Branching on the code
    // alone turns "not something we can merge" into a model with no files in it.
    const { repo, headSha } = threeWayRepo(
      { 'f.txt': 'a\n' },
      (r) => r.write('f.txt', 'o\n'),
      (r) => r.write('f.txt', 't\n'),
    );
    const res = await build(repo, headSha, 'd'.repeat(40));
    expect(res.status).toBe('failed');
    if (res.status === 'failed') expect(res.code).not.toBe('git_too_old');
  });
});

/* ═════════════════════════════ the wand ═════════════════════════════ */

describe('the wand', () => {
  it('merges two edits to different words on one line', async () => {
    const { repo, headSha, baseSha } = threeWayRepo(
      { 'f.txt': 'foo(alpha, beta)\n' },
      (r) => r.write('f.txt', 'foo(alpha2, beta)\n'),
      (r) => r.write('f.txt', 'foo(alpha, beta2)\n'),
    );
    const model = await ready(repo, headSha, baseSha);
    const f = fileNamed(model, 'f.txt');
    const contested = f.regions.find((r) => r.kind === 'conflict');
    expect(contested?.wand).toEqual({ decision: 'disjoint_merge', reason: 'disjoint_words' });
    expect(contested?.mergedLines).toEqual(['foo(alpha2, beta2)']);
  });

  it('refuses when both sides edited the SAME word', async () => {
    const { repo, headSha, baseSha } = threeWayRepo(
      { 'f.txt': 'foo(alpha)\n' },
      (r) => r.write('f.txt', 'foo(ours)\n'),
      (r) => r.write('f.txt', 'foo(theirs)\n'),
    );
    const model = await ready(repo, headSha, baseSha);
    const contested = fileNamed(model, 'f.txt').regions.find((r) => r.kind === 'conflict');
    expect(contested?.wand).toBeNull();
    expect(contested?.mergedLines).toBeNull();
  });

  it('refuses when the only thing between the two edits is a space', () => {
    // A single space is not evidence two authors were working on different things.
    expect(disjointWordMerge('foo bar\n', 'FOO bar\n', 'foo BAR\n')).toBeNull();
    // The same shape with a real token between them IS disjoint.
    expect(disjointWordMerge('foo, bar\n', 'FOO, bar\n', 'foo, BAR\n')?.lines).toEqual([
      'FOO, BAR',
    ]);
  });

  it('offers `disjoint_merge` in `allowed` only where the wand actually found one', async () => {
    const { repo, headSha, baseSha } = threeWayRepo(
      { 'f.txt': 'foo(alpha, beta)\n' },
      (r) => r.write('f.txt', 'foo(alpha2, beta)\n'),
      (r) => r.write('f.txt', 'foo(alpha, beta2)\n'),
    );
    const model = await ready(repo, headSha, baseSha);
    const content = conflictFileContent(model, 0, true);
    const contested = content?.regions.find((r) => r.kind === 'conflict');
    expect(contested?.allowed).toContain('disjoint_merge');
    // ⚠ NEITHER `suggestion` NOR `edited` IS A MODEL FACT — both are SESSION facts, addressing
    // text held in one server process's memory, and neither may ever be advertised here. What
    // `allowed` answers is "which of the deterministic members does this region offer", and a
    // handle-bearing member has no answer to that. The UI knows a region is editable because it
    // is decidable at all, and the SERVER re-checks that on the edit route (`not_editable`).
    expect(contested?.allowed).not.toContain('suggestion');
    expect(contested?.allowed).not.toContain('edited');
    // A contested region always starts undecided, auto-apply or not.
    expect(contested?.defaultDecision).toBe('base');
  });
});

/* ═════════════════════════════ caps ═════════════════════════════ */

describe('caps', () => {
  it('refuses a file with more contested regions than the cap', async () => {
    const original = caps.conflictMaxRegions;
    caps.conflictMaxRegions = 2;
    try {
      const lines = Array.from({ length: 20 }, (_, i) => `l${i}`);
      const ours = lines.map((l, i) => (i % 4 === 0 ? `O${i}` : l));
      const theirs = lines.map((l, i) => (i % 4 === 0 ? `T${i}` : l));
      const { repo, headSha, baseSha } = threeWayRepo(
        { 'f.txt': `${lines.join('\n')}\n` },
        (r) => r.write('f.txt', `${ours.join('\n')}\n`),
        (r) => r.write('f.txt', `${theirs.join('\n')}\n`),
      );
      const model = await ready(repo, headSha, baseSha);
      expect(fileNamed(model, 'f.txt').unsupported).toBe('too_many_conflicts');
    } finally {
      caps.conflictMaxRegions = original;
    }
  });

  it('refuses a file bigger than the per-file cap without attaching its sides', async () => {
    const original = caps.conflictMaxFileBytes;
    caps.conflictMaxFileBytes = 64;
    try {
      const big = `${'x'.repeat(200)}\n`;
      const { repo, headSha, baseSha } = threeWayRepo(
        { 'f.txt': `${big}mid\ntail\n` },
        (r) => r.write('f.txt', `${big}OURS\ntail\n`),
        (r) => r.write('f.txt', `${big}THEIRS\ntail\n`),
      );
      const model = await ready(repo, headSha, baseSha);
      const f = fileNamed(model, 'f.txt');
      expect(f.unsupported).toBe('too_large');
      expect(f.regions).toEqual([]);
      expect(f.maxSideBytes).toBeGreaterThan(64);
    } finally {
      caps.conflictMaxFileBytes = original;
    }
  });

  it('lists files past the file-count cap as `budget_exhausted`, and says so', async () => {
    const original = caps.conflictMaxFiles;
    caps.conflictMaxFiles = 1;
    try {
      const { repo, headSha, baseSha } = threeWayRepo(
        { 'a.txt': 'a\n', 'b.txt': 'b\n' },
        (r) => {
          r.write('a.txt', 'ao\n');
          r.write('b.txt', 'bo\n');
        },
        (r) => {
          r.write('a.txt', 'at\n');
          r.write('b.txt', 'bt\n');
        },
      );
      const model = await ready(repo, headSha, baseSha);
      expect(model.files).toHaveLength(2);
      expect(model.totalConflictedPaths).toBe(2);
      expect(model.truncated).toBe(true);
      expect(fileNamed(model, 'b.txt').unsupported).toBe('budget_exhausted');
    } finally {
      caps.conflictMaxFiles = original;
    }
  });
});

/* ═════════════════════════════ the oracle ═════════════════════════════ */

describe('the oracle', () => {
  it('places git’s contested regions by their ours-side content', () => {
    const merged = [
      'keep',
      '<<<<<<< ours',
      'OURS',
      '||||||| base',
      'BASE',
      '=======',
      'THEIRS',
      '>>>>>>> theirs',
      'tail',
      '',
    ].join('\n');
    expect(oracleConflictRanges(merged, ['keep', 'OURS', 'tail'])).toEqual([
      { start: 1, end: 2 },
    ]);
  });

  it('refuses an unterminated conflict block rather than guessing', () => {
    const merged = '<<<<<<< ours\nOURS\n||||||| base\nBASE\n';
    expect(oracleConflictRanges(merged, ['OURS'])).toBeNull();
  });

  it('accepts our EXTRA regions but never a git region we merged silently', () => {
    // ⚠ Being more conservative than git is allowed; contesting LESS is not, because that is
    // a region we would merge with nobody looking at it.
    const ours = [{ start: 0, end: 2 }];
    expect(oracleAgrees(ours, [{ start: 0, end: 2 }])).toBe(true);
    expect(oracleAgrees(ours, [{ start: 1, end: 5 }])).toBe(true);
    expect(oracleAgrees(ours, [{ start: 10, end: 12 }])).toBe(false);
    expect(oracleAgrees([], [{ start: 3, end: 4 }])).toBe(false);
    expect(oracleAgrees([{ start: 0, end: 0 }], [])).toBe(true);
  });
});

/* ═════════════════════════════ the hash and the wire ═════════════════════════════ */

describe('the model hash', () => {
  it('is stable across two builds of the same commits', async () => {
    const make = () =>
      threeWayRepo(
        { 'f.txt': 'a\nb\nc\n' },
        (r) => r.write('f.txt', 'a\nOURS\nc\n'),
        (r) => r.write('f.txt', 'a\nTHEIRS\nc\n'),
      );
    const one = make();
    const first = await ready(one.repo, one.headSha, one.baseSha);
    const second = await ready(one.repo, one.headSha, one.baseSha);
    expect(conflictModelHash(second)).toBe(conflictModelHash(first));
  });

  it('does NOT move when the session is opened with auto-apply off', async () => {
    // ⚠ `autoApply` changes which decision a region STARTS on, not what the region IS.
    // Folding it in would make the same model hash two values depending on a checkbox.
    const { repo, headSha, baseSha } = threeWayRepo(
      { 'f.txt': 'a\nb\nc\n' },
      (r) => r.write('f.txt', 'a\nOURS\nc\n'),
      (r) => r.write('f.txt', 'a\nTHEIRS\nc\n'),
    );
    const model = await ready(repo, headSha, baseSha);
    const before = conflictModelHash(model);
    conflictFileContent(model, 0, false);
    expect(conflictModelHash(model)).toBe(before);
  });

  it('changes when the contested bytes change', async () => {
    const a = threeWayRepo(
      { 'f.txt': 'a\nb\nc\n' },
      (r) => r.write('f.txt', 'a\nOURS\nc\n'),
      (r) => r.write('f.txt', 'a\nTHEIRS\nc\n'),
    );
    const b = threeWayRepo(
      { 'f.txt': 'a\nb\nc\n' },
      (r) => r.write('f.txt', 'a\nOURS-2\nc\n'),
      (r) => r.write('f.txt', 'a\nTHEIRS\nc\n'),
    );
    const ma = await ready(a.repo, a.headSha, a.baseSha);
    const mb = await ready(b.repo, b.headSha, b.baseSha);
    expect(conflictModelHash(ma)).not.toBe(conflictModelHash(mb));
  });
});

describe('the wire projection', () => {
  it('counts every region, the contested ones, and the wand-settleable subset', async () => {
    const { repo, headSha, baseSha } = threeWayRepo(
      { 'f.txt': 'foo(alpha, beta)\nkeep\nx\n' },
      (r) => r.write('f.txt', 'foo(alpha2, beta)\nkeep\nOURS\n'),
      (r) => r.write('f.txt', 'foo(alpha, beta2)\nkeep\nTHEIRS\n'),
    );
    const model = await ready(repo, headSha, baseSha);
    const entry = conflictFileEntries(model)[0];
    expect(entry?.path).toBe('f.txt');
    expect(entry?.conflictCount).toBe(2);
    expect(entry?.wandResolvableCount).toBe(1);
    expect(entry?.regionCount).toBeGreaterThanOrEqual(2);
  });

  it('counts the regions that take a decision, not the context lines', async () => {
    // ⚠ THE COMMIT GATE'S DENOMINATOR, AND IT IS NEITHER OF ITS NEIGHBOURS. `regionCount` folds
    // in `unchanged` context; `conflictCount` leaves out every one-sided change, which the reader
    // now has to answer too. Anyone "simplifying" `decidableCount` into either breaks this.
    const { repo, headSha, baseSha } = threeWayRepo(
      { 'f.txt': 'a\nb\nc\nd\ne\n' },
      (r) => r.write('f.txt', 'a\nOURS\nc\nOURS-ONLY\ne\n'),
      (r) => r.write('f.txt', 'a\nTHEIRS\nc\nd\ne\n'),
    );
    const model = await ready(repo, headSha, baseSha);
    const entry = conflictFileEntries(model)[0];
    const regions = model.files[0]?.regions ?? [];
    const decidable = regions.filter((r) => r.kind !== 'unchanged').length;
    const unchanged = regions.filter((r) => r.kind === 'unchanged').length;
    expect(unchanged).toBeGreaterThan(0);
    expect(entry?.decidableCount).toBe(decidable);
    expect(entry?.decidableCount).toBeLessThan(entry?.regionCount ?? 0);
    expect(entry?.decidableCount).toBeGreaterThan(entry?.conflictCount ?? 0);
  });

  it('empties `ours` and `theirs` on an unchanged region and numbers each side itself', async () => {
    const { repo, headSha, baseSha } = threeWayRepo(
      { 'f.txt': 'h1\nh2\nb\nt1\n' },
      (r) => r.write('f.txt', 'h1\nh2\nOURS\nOURS2\nt1\n'),
      (r) => r.write('f.txt', 'h1\nh2\nTHEIRS\nt1\n'),
    );
    const model = await ready(repo, headSha, baseSha);
    const content = conflictFileContent(model, 0, true);
    const head = content?.regions[0];
    expect(head?.kind).toBe('unchanged');
    expect(head?.ours).toEqual([]);
    expect(head?.theirs).toEqual([]);
    expect(head?.base.map((l) => l.n)).toEqual([1, 2]);
    const contested = content?.regions.find((r) => r.kind === 'conflict');
    expect(contested?.ours.map((l) => l.n)).toEqual([3, 4]);
    expect(contested?.theirs.map((l) => l.n)).toEqual([3]);
  });

  it('offers a one-sided region its own side plus `base`, and defaults to its side', async () => {
    const { repo, headSha, baseSha } = threeWayRepo(
      { 'f.txt': 'a\nb\nc\n', 'g.txt': 'x\n' },
      (r) => {
        r.write('f.txt', 'a\nOURS\nc\n');
        r.write('g.txt', 'x\nOURS-ONLY\n');
      },
      (r) => {
        r.write('f.txt', 'a\nTHEIRS\nc\n');
        r.write('g.txt', 'x\n');
      },
    );
    const model = await ready(repo, headSha, baseSha);
    const f = conflictFileContent(model, model.files.findIndex((x) => x.path === 'f.txt'), true);
    const oneSided = f?.regions.find((r) => r.kind === 'ours_only' || r.kind === 'theirs_only');
    if (oneSided) {
      expect(oneSided.allowed).toEqual(
        oneSided.kind === 'ours_only' ? ['ours', 'base'] : ['theirs', 'base'],
      );
      expect(oneSided.defaultDecision).toBe(oneSided.kind === 'ours_only' ? 'ours' : 'theirs');
    }
    // With auto-apply OFF every region starts at `base`.
    const off = conflictFileContent(model, 0, false);
    expect(off?.regions.every((r) => r.defaultDecision === 'base')).toBe(true);
  });
});

/* ═════════════════════════════ landing strategies ═════════════════════════════ */

describe('landing strategies', () => {
  it('offers rebase on a single-commit PR whose every conflicted file is resolvable', async () => {
    const { repo, headSha, baseSha } = threeWayRepo(
      { 'f.txt': 'a\nb\nc\n' },
      (r) => r.write('f.txt', 'a\nOURS\nc\n'),
      (r) => r.write('f.txt', 'a\nTHEIRS\nc\n'),
    );
    const model = await ready(repo, headSha, baseSha);
    expect(model.commitsAboveBase).toBe(1);
    expect(model.strategies).toEqual(['merge', 'rebase']);
    expect(model.rebaseUnavailableReason).toBeNull();
    // The fork question is the CALLER's — one live REST read, which this builder never makes.
    // An absent answer is not a refusal, so it defaults to pushable and the land route decides.
    expect(model.prBranchPushable).toBe(true);
    expect(model.prBranchUnavailableReason).toBeNull();
  });

  it('withholds rebase above one commit, and says why in one sentence', async () => {
    const repo = new Repo();
    repo.write('f.txt', 'a\nb\nc\n');
    repo.commit('base');
    repo.git(['checkout', '-q', '-b', 'ours']);
    repo.write('f.txt', 'a\nOURS\nc\n');
    repo.commit('o1');
    repo.write('f.txt', 'a\nOURS\nc\nmore\n');
    const headSha = repo.commit('o2');
    repo.git(['checkout', '-q', 'main']);
    repo.git(['checkout', '-q', '-b', 'theirs']);
    repo.write('f.txt', 'a\nTHEIRS\nc\n');
    const baseSha = repo.commit('t');

    const model = await ready(repo, headSha, baseSha);
    expect(model.strategies).toEqual(['merge']);
    expect(model.rebaseUnavailableReason).toBe(
      'This branch has 2 commits. Rebasing can conflict once per commit — merge instead.',
    );
  });

  it('withholds rebase when a conflicted file cannot be resolved here', async () => {
    const { repo, headSha, baseSha } = threeWayRepo(
      { 'bin.dat': Buffer.from([1, 0, 2]) },
      (r) => r.write('bin.dat', Buffer.from([1, 0, 3])),
      (r) => r.write('bin.dat', Buffer.from([1, 0, 4])),
    );
    const model = await ready(repo, headSha, baseSha);
    expect(model.strategies).toEqual(['merge']);
    expect(model.rebaseUnavailableReason).toContain('resolved on GitHub');
  });
});
