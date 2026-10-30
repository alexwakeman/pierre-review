// THE CONFLICT MODEL, against REAL GIT: text, bytes and the structural conflicts.
// The fixtures (a real temp repository per case) live in model.test-support.ts.
import { chmodSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { foldFile, foldToText, type ResolvedDecision } from '@pierre-review/shared';
import { buildConflictModelInClone, decodeStrict } from './model.js';
import { Repo, threeWayRepo, build, ready, fileNamed } from './model.test-support.js';

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
