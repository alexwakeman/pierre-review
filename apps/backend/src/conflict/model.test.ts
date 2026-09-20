import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { foldFile, foldToText, type ResolvedDecision } from '@pierre-review/shared';
import { config } from '../config.js';
import {
  buildConflictModelInClone,
  conflictFileContent,
  conflictFileEntries,
  decodeStrict,
  disjointWordMerge,
  oracleAgrees,
  oracleConflictRanges,
} from './model.js';
import { conflictModelHash } from './hash.js';
import type { ConflictModel, ConflictModelFile } from './model-types.js';

// REAL TEMP REPOSITORIES, REAL GIT. The clone dir is injected and `token: null`, so nothing
// here touches GitHub or the database — but merge-tree, cat-file and merge-file are the
// genuine articles, because the whole feature is a claim about what git does.

const CLEAN_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_ADVICE: '0',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
};

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

class Repo {
  readonly dir: string;

  constructor() {
    this.dir = mkdtempSync(join(tmpdir(), 'pierre-conflict-'));
    dirs.push(this.dir);
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

  rev(ref: string): string {
    return this.git(['rev-parse', ref]).trim();
  }
}

/**
 * The standard shape: one base commit, then an `ours` branch (the PR head) and a `theirs`
 * branch (the base branch), each with one commit.
 */
function threeWayRepo(
  base: Record<string, string | Buffer>,
  ours: (r: Repo) => void,
  theirs: (r: Repo) => void,
): { repo: Repo; headSha: string; baseSha: string } {
  const repo = new Repo();
  for (const [p, c] of Object.entries(base)) repo.write(p, c);
  repo.commit('base');
  repo.git(['checkout', '-q', '-b', 'ours']);
  ours(repo);
  const headSha = repo.commit('ours');
  repo.git(['checkout', '-q', 'main']);
  repo.git(['checkout', '-q', '-b', 'theirs']);
  theirs(repo);
  const baseSha = repo.commit('theirs');
  return { repo, headSha, baseSha };
}

async function build(
  repo: Repo,
  headSha: string,
  baseSha: string,
): ReturnType<typeof buildConflictModelInClone> {
  return buildConflictModelInClone({
    accountId: 1,
    prId: 42,
    cloneDir: repo.dir,
    owner: 'acme',
    name: 'widgets',
    number: 7,
    headSha,
    baseSha,
    headRef: 'feature',
    baseRef: 'main',
    reservedBranchNames: ['main'],
    // ⚠ `prBranchPushable` is deliberately NOT passed: this builder is network-free and the
    // caller decides, so the default is what every test below sees.
    token: null,
  });
}

/** Build and assert we got a usable model, so every test below reads one line shorter. */
async function ready(repo: Repo, headSha: string, baseSha: string): Promise<ConflictModel> {
  const res = await build(repo, headSha, baseSha);
  if (res.status !== 'ready') {
    throw new Error(`expected a ready model, got ${res.status}`);
  }
  return res.model;
}

/** `config` is declared `as const`, so its TYPE is readonly while the object itself is a
 *  plain mutable one. Narrowing a cap for one test and restoring it in a `finally` is how a
 *  boundary gets exercised without generating a half-megabyte fixture. */
const caps = config as { -readonly [K in keyof typeof config]: (typeof config)[K] };

function fileNamed(model: ConflictModel, path: string): ConflictModelFile {
  const f = model.files.find((x) => x.path === path);
  if (!f) throw new Error(`no file ${path} in [${model.files.map((x) => x.path).join(', ')}]`);
  return f;
}

/* ═════════════════════════════ text ═════════════════════════════ */

describe('buildConflictModelInClone — text', () => {
  it('models a simple contested region', async () => {
    const { repo, headSha, baseSha } = threeWayRepo(
      { 'f.txt': 'a\nb\nc\n' },
      (r) => r.write('f.txt', 'a\nOURS\nc\n'),
      (r) => r.write('f.txt', 'a\nTHEIRS\nc\n'),
    );
    const model = await ready(repo, headSha, baseSha);
    const f = fileNamed(model, 'f.txt');
    expect(f.unsupported).toBeNull();
    expect(f.regions.map((r) => r.kind)).toEqual(['unchanged', 'conflict', 'unchanged']);
    const mid = f.regions[1];
    expect(mid?.base).toEqual(['b']);
    expect(mid?.ours).toEqual(['OURS']);
    expect(mid?.theirs).toEqual(['THEIRS']);
    expect(f.terminators).toEqual({ base: true, ours: true, theirs: true });
    // Region ids are stable within the file for the life of this pinned pair.
    expect(f.regions.map((r) => r.id)).toEqual([1, 2, 3]);
  });

  it('reports a merge git settles on its own as CLEAN, inventing no work', async () => {
    // ⚠ Two edits far enough apart that git auto-merges them. Discovery must never mint a
    // conflict git does not have.
    const { repo, headSha, baseSha } = threeWayRepo(
      { 'f.txt': 'a\nb\nc\nd\ne\nf\ng\nh\n' },
      (r) => r.write('f.txt', 'A\nb\nc\nd\ne\nf\ng\nh\n'),
      (r) => r.write('f.txt', 'a\nb\nc\nd\ne\nf\ng\nH\n'),
    );
    const res = await build(repo, headSha, baseSha);
    expect(res.status).toBe('clean');
    if (res.status === 'clean') {
      expect(res.model.files).toEqual([]);
      expect(res.model.mergedTreeSha).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  it('absorbs adjacent edits from opposite sides into ONE region', async () => {
    const { repo, headSha, baseSha } = threeWayRepo(
      { 'f.txt': 'a\nb\nc\nd\n' },
      (r) => r.write('f.txt', 'a\nOURS\nc\nd\n'),
      (r) => r.write('f.txt', 'a\nb\nTHEIRS\nd\n'),
    );
    const model = await ready(repo, headSha, baseSha);
    const f = fileNamed(model, 'f.txt');
    const conflicts = f.regions.filter((r) => r.kind === 'conflict');
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.base).toEqual(['b', 'c']);
  });

  it('keeps two far-apart contested regions separate', async () => {
    const base = 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\n';
    const { repo, headSha, baseSha } = threeWayRepo(
      { 'f.txt': base },
      (r) => r.write('f.txt', base.replace('l2\n', 'O2\n').replace('l9\n', 'O9\n')),
      (r) => r.write('f.txt', base.replace('l2\n', 'T2\n').replace('l9\n', 'T9\n')),
    );
    const model = await ready(repo, headSha, baseSha);
    expect(fileNamed(model, 'f.txt').regions.filter((r) => r.kind === 'conflict')).toHaveLength(
      2,
    );
  });

  it('preserves CRLF and a missing trailing newline through the fold', async () => {
    const { repo, headSha, baseSha } = threeWayRepo(
      { 'f.txt': 'a\r\nb\r\nc\r\n' },
      (r) => r.write('f.txt', 'a\r\nOURS\r\nc'),
      (r) => r.write('f.txt', 'a\r\nTHEIRS\r\nc\r\n'),
    );
    const model = await ready(repo, headSha, baseSha);
    const f = fileNamed(model, 'f.txt');
    // `\r` stays attached to its line, and the ours side genuinely has no terminator.
    expect(f.regions[0]?.base).toEqual(['a\r']);
    expect(f.terminators.ours).toBe(false);
    expect(f.terminators.theirs).toBe(true);

    const decisions = new Map<number, ResolvedDecision>(
      f.regions
        .filter((r) => r.kind !== 'unchanged')
        .map((r) => [r.id, { decision: 'ours' } as ResolvedDecision]),
    );
    const folded = foldFile({ regions: f.regions, terminators: f.terminators }, decisions);
    expect(folded.ok).toBe(true);
    if (folded.ok) expect(foldToText(folded)).toBe('a\r\nOURS\r\nc');
  });

  it('folds an all-ours resolution back to the ours blob, byte for byte', async () => {
    const oursText = 'alpha\nBETA-OURS\ngamma\n';
    const { repo, headSha, baseSha } = threeWayRepo(
      { 'f.txt': 'alpha\nbeta\ngamma\n' },
      (r) => r.write('f.txt', oursText),
      (r) => r.write('f.txt', 'alpha\nBETA-THEIRS\ngamma\n'),
    );
    const model = await ready(repo, headSha, baseSha);
    const f = fileNamed(model, 'f.txt');
    const decisions = new Map<number, ResolvedDecision>(
      f.regions
        .filter((r) => r.kind !== 'unchanged')
        .map((r) => [r.id, { decision: 'ours' } as ResolvedDecision]),
    );
    const folded = foldFile({ regions: f.regions, terminators: f.terminators }, decisions);
    expect(folded.ok).toBe(true);
    if (folded.ok) expect(Buffer.from(foldToText(folded), 'utf8')).toEqual(
      Buffer.from(oursText, 'utf8'),
    );
  });
});

/* ═════════════════════════════ the byte-integrity gate ═════════════════════════════ */

describe('buildConflictModelInClone — bytes', () => {
  it('REFUSES a Latin-1 file as `not_text`, with no sides attached', async () => {
    // ⚠ THE FINDING THAT WOULD OTHERWISE SHIP GREEN. `caf\xe9\n` has NO NUL byte, so a
    // NUL-only binary check calls it text; `toString('utf8')` would make it `caf�` and
    // the land path would rewrite the WHOLE file as EF BF BD.
    const latin1Base = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]);
    const { repo, headSha, baseSha } = threeWayRepo(
      { 'f.txt': latin1Base },
      (r) => r.write('f.txt', Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x4f, 0x0a])),
      (r) => r.write('f.txt', Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x54, 0x0a])),
    );
    const model = await ready(repo, headSha, baseSha);
    const f = fileNamed(model, 'f.txt');
    expect(f.unsupported).toBe('not_text');
    expect(f.unsupportedLabel).toBe('Not UTF-8 text');
    expect(f.regions).toEqual([]);
    expect(decodeStrict(latin1Base)).toBeNull();
  });

  it('accepts genuinely-UTF-8 accented text', async () => {
    // The other half of the claim: refusing Latin-1 must not refuse é written properly.
    const { repo, headSha, baseSha } = threeWayRepo(
      { 'f.txt': 'café\n' },
      (r) => r.write('f.txt', 'café OURS\n'),
      (r) => r.write('f.txt', 'café THEIRS\n'),
    );
    const model = await ready(repo, headSha, baseSha);
    expect(fileNamed(model, 'f.txt').unsupported).toBeNull();
  });

  it('classifies a binary file as binary, never as text', async () => {
    const { repo, headSha, baseSha } = threeWayRepo(
      { 'bin.dat': Buffer.from([1, 0, 2]) },
      (r) => r.write('bin.dat', Buffer.from([1, 0, 3])),
      (r) => r.write('bin.dat', Buffer.from([1, 0, 4])),
    );
    const model = await ready(repo, headSha, baseSha);
    const f = fileNamed(model, 'bin.dat');
    expect(f.unsupported).toBe('binary');
    expect(f.regions).toEqual([]);
  });
});

/* ═════════════════════════════ structural kinds ═════════════════════════════ */

describe('buildConflictModelInClone — structural conflicts', () => {
  it('names a submodule', async () => {
    const repo = new Repo();
    repo.write('a.txt', 'x\n');
    const s1 = repo.commit('base');
    repo.git(['update-index', '--add', '--cacheinfo', `160000,${s1},sub`]);
    repo.git(['commit', '-q', '-m', 'addsub']);
    repo.git(['checkout', '-q', '-b', 'ours']);
    repo.write('a.txt', 'y\n');
    const s2 = repo.commit('o');
    repo.git(['update-index', '--add', '--cacheinfo', `160000,${s2},sub`]);
    repo.git(['commit', '-q', '-m', 'subo']);
    const headSha = repo.rev('HEAD');
    repo.git(['checkout', '-q', 'main']);
    repo.git(['checkout', '-q', '-b', 'theirs']);
    repo.write('a.txt', 'z\n');
    const s3 = repo.commit('t');
    repo.git(['update-index', '--add', '--cacheinfo', `160000,${s3},sub`]);
    repo.git(['commit', '-q', '-m', 'subt']);
    const baseSha = repo.rev('HEAD');

    const model = await ready(repo, headSha, baseSha);
    expect(fileNamed(model, 'sub').unsupported).toBe('submodule');
    // The text file beside it is still resolvable — one bad file never disables the rest.
    expect(fileNamed(model, 'a.txt').unsupported).toBeNull();
  });

  it('names a symlink-versus-file conflict', async () => {
    const { repo, headSha, baseSha } = threeWayRepo(
      { s: 'a\n' },
      (r) => {
        rmSync(join(r.dir, 's'));
        symlinkSync('target', join(r.dir, 's'));
      },
      (r) => r.write('s', 'b\n'),
    );
    const model = await ready(repo, headSha, baseSha);
    expect(model.files.every((f) => f.unsupported !== null)).toBe(true);
    expect(model.files.some((f) => f.unsupported === 'symlink')).toBe(true);
  });

  it('names a file/directory conflict and strips the ~sha mangling', async () => {
    const { repo, headSha, baseSha } = threeWayRepo(
      { 'fdir.txt': 'fd\n' },
      (r) => {
        rmSync(join(r.dir, 'fdir.txt'));
        r.write('fdir.txt/x', 'inside\n');
      },
      (r) => r.write('fdir.txt', 'fd2\n'),
    );
    const model = await ready(repo, headSha, baseSha);
    const f = fileNamed(model, 'fdir.txt');
    expect(f.unsupported).toBe('file_directory');
    expect(f.path).not.toContain('~');
  });

  it('leaves a real filename containing `~` alone', async () => {
    const { repo, headSha, baseSha } = threeWayRepo(
      { 'we~ird.txt': 'a\n' },
      (r) => r.write('we~ird.txt', 'o\n'),
      (r) => r.write('we~ird.txt', 't\n'),
    );
    const model = await ready(repo, headSha, baseSha);
    expect(fileNamed(model, 'we~ird.txt').unsupported).toBeNull();
  });

  it('names rename/rename, rename/delete and modify/delete', async () => {
    const { repo, headSha, baseSha } = threeWayRepo(
      { 'ren.txt': 'orig\n', 'mv.txt': 'orig\n', 'del.txt': 'del\n' },
      (r) => {
        r.git(['mv', 'ren.txt', 'ren-ours.txt']);
        r.git(['mv', 'mv.txt', 'mv-ours.txt']);
        r.write('del.txt', 'changed\n');
      },
      (r) => {
        r.git(['mv', 'ren.txt', 'ren-theirs.txt']);
        r.git(['rm', '-q', 'mv.txt']);
        r.git(['rm', '-q', 'del.txt']);
      },
    );
    const model = await ready(repo, headSha, baseSha);
    const reasons = new Set(model.files.map((f) => f.unsupported));
    expect(reasons).toContain('rename_rename');
    expect(reasons).toContain('rename_delete');
    expect(reasons).toContain('modify_delete');
    expect(reasons.has(null)).toBe(false);
    // rename/rename names both destinations, so the row can say what happened.
    const rr = model.files.find((f) => f.unsupported === 'rename_rename');
    expect(rr?.relatedPaths.length).toBeGreaterThan(0);
  });

  it('refuses an add/add by name, rather than offering "delete it" as a third button', async () => {
    // Stages 2 and 3 with NO stage 1. Modelling it with an empty base would put "keep the
    // ancestor" — which here means remove the file — beside the two versions with nothing
    // saying so.
    const { repo, headSha, baseSha } = threeWayRepo(
      { 'seed.txt': 'x\n' },
      (r) => r.write('new.txt', 'OURS\n'),
      (r) => r.write('new.txt', 'THEIRS\n'),
    );
    const model = await ready(repo, headSha, baseSha);
    const f = fileNamed(model, 'new.txt');
    expect(f.unsupported).toBe('no_common_ancestor');
    expect(f.unsupportedLabel).toBe('No common ancestor');
  });

  it('names a mode change', async () => {
    const { repo, headSha, baseSha } = threeWayRepo(
      { 'm.sh': 'a\nb\n' },
      (r) => {
        r.write('m.sh', 'a\nOURS\n');
        // The mode has to change ON DISK: `commit()` runs `git add -A`, which re-reads it.
        chmodSync(join(r.dir, 'm.sh'), 0o755);
      },
      (r) => r.write('m.sh', 'a\nTHEIRS\n'),
    );
    const model = await ready(repo, headSha, baseSha);
    expect(fileNamed(model, 'm.sh').unsupported).toBe('mode_change');
  });

  it('lists a mixed conflict in full, with exactly the text file resolvable', async () => {
    // ⚠ The guarantee: an unlisted file is why the PR stays conflicted after a commit with
    // nothing on screen to explain it. Everything is listed; only the reasons differ.
    const { repo, headSha, baseSha } = threeWayRepo(
      { 'f.txt': 'a\nb\nc\n', 'bin.dat': Buffer.from([1, 0, 2]), 'del.txt': 'd\n' },
      (r) => {
        r.write('f.txt', 'a\nOURS\nc\n');
        r.write('bin.dat', Buffer.from([1, 0, 3]));
        r.write('del.txt', 'changed\n');
      },
      (r) => {
        r.write('f.txt', 'a\nTHEIRS\nc\n');
        r.write('bin.dat', Buffer.from([1, 0, 4]));
        r.git(['rm', '-q', 'del.txt']);
      },
    );
    const model = await ready(repo, headSha, baseSha);
    expect(model.files).toHaveLength(3);
    expect(model.totalConflictedPaths).toBe(3);
    expect(model.files.filter((f) => f.unsupported === null)).toHaveLength(1);
    for (const f of model.files) {
      // Every unsupported row carries a noun phrase, with no instruction and no full stop.
      if (f.unsupported) {
        expect(f.unsupportedLabel).toBeTruthy();
        expect(f.unsupportedLabel?.endsWith('.')).toBe(false);
      }
    }
  });
});

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
    // ⚠ `suggestion` is a SESSION fact, not a model fact — it must never be advertised here.
    expect(contested?.allowed).not.toContain('suggestion');
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
