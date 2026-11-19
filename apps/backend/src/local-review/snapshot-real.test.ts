// REVIEW A LOCAL BRANCH ON REAL GIT (slow project; docs/CLAUDE-REVIEW.md § Reviewing a local branch).
//
//   1. THE CLIENT'S SNAPSHOT (snapshot.ts): base..HEAD plus the uncommitted TRACKED changes, as a bundle, built in
//      a temporary object directory — the reader's .git is BYTE-UNCHANGED (every file's path, mtime, size and
//      content; the index; the refs; `git status`), and an untracked file is never in it. The base rules
//      (origin's default branch, a stacked upstream, --base), the refusals (nothing to review, a base GitHub
//      lacks, too large).
//   2. THE SERVER'S INTAKE (clone-manager.ts `fetchBundleIntoClone`): the bundle into the clone cache (a full
//      clone and a BLOBLESS one, as the real cache) under a local pinned ref; garbage, a wrong head, a base the
//      cache cannot get and an object fsck rejects are refused with a plain line.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' };
const git = (args: string[], cwd?: string): string => execFileSync('git', args, { cwd, encoding: 'utf8', env }).trim();

let scratch = '';
let origin = '';
let reader = '';
let cloneRoot = '';
let S: typeof import('./snapshot.js');
let CM: typeof import('../review/clone-manager.js');

function commit(dir: string, files: Record<string, string>, msg: string): string {
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(join(dir, f, '..'), { recursive: true });
    writeFileSync(join(dir, f), text);
  }
  git(['add', '-A'], dir);
  git(['commit', '-qm', msg], dir);
  return git(['rev-parse', 'HEAD'], dir);
}

/** Every path under `dir` with its mtime, size and content hash (the proof nothing was written). */
function fingerprint(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      const st = lstatSync(p);
      const h = st.isFile() ? createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 16) : '-';
      out.push(`${p} ${st.mtimeMs} ${st.size} ${h}`);
      if (st.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out.sort();
}

let baseSha = '';
let featureSha = '';

beforeAll(async () => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'ensemble-local-review-real-')));
  cloneRoot = join(scratch, 'clones');
  process.env.CLONE_DIR = cloneRoot;
  // "GitHub": a bare repository with main.
  const seed = join(scratch, 'seed');
  git(['init', '-q', '-b', 'main', seed]);
  baseSha = commit(seed, { 'src/app.ts': 'export const a = 1;\n', 'README.md': '# api\n' }, 'base');
  origin = join(scratch, 'origin.git');
  git(['clone', '-q', '--bare', seed, origin]);
  git(['config', 'uploadpack.allowfilter', 'true'], origin);
  git(['config', 'uploadpack.allowAnySHA1InWant', 'true'], origin);
  // The reader's clone: origin points at GitHub (as the real one does), its remote-tracking refs came from the bare.
  reader = join(scratch, 'reader');
  git(['clone', '-q', origin, reader]);
  git(['remote', 'set-url', 'origin', 'git@github.com:acme/api.git'], reader);
  git(['checkout', '-q', '-b', 'feature/PAY-142-refunds'], reader);
  commit(reader, { 'src/refund.ts': 'export function refund() { return 1; }\n' }, 'PAY-142 add refunds');
  featureSha = commit(reader, { 'src/app.ts': 'export const a = 2;\n' }, 'Bump a');
  S = await import('./snapshot.js');
  CM = await import('../review/clone-manager.js');
});

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

describe("the client's snapshot", () => {
  it("sends base..HEAD plus uncommitted tracked changes, never an untracked file, and leaves the reader's .git byte-unchanged", async () => {
    writeFileSync(join(reader, 'src/app.ts'), 'export const a = 3; // uncommitted\n');
    writeFileSync(join(reader, 'README.md'), '# api\nstaged\n');
    git(['add', 'README.md'], reader);
    writeFileSync(join(reader, 'secret.env'), 'TOKEN=never-sent\n');
    const before = { files: fingerprint(join(reader, '.git')), status: git(['status', '--porcelain'], reader), refs: git(['for-each-ref'], reader), objects: git(['count-objects', '-v'], reader) };

    const snap = await S.snapshotBranch({ cwd: join(reader, 'src'), includeUncommitted: true });

    expect(fingerprint(join(reader, '.git'))).toEqual(before.files);
    expect(git(['status', '--porcelain'], reader)).toBe(before.status);
    expect(git(['for-each-ref'], reader)).toBe(before.refs);
    expect(git(['count-objects', '-v'], reader)).toBe(before.objects);
    expect(snap).toMatchObject({ owner: 'acme', name: 'api', branch: 'feature/PAY-142-refunds', baseRef: 'origin/main', baseSha, commitSha: featureSha, uncommittedChanges: true });
    expect(snap.headSha).not.toBe(featureSha);
    expect(snap.subjects).toEqual(['Bump a', 'PAY-142 add refunds']);

    // The bundle, read in a throwaway clone of "GitHub": the snapshot's tree has the edits, not the untracked file.
    const check = join(scratch, 'check');
    git(['clone', '-q', '--bare', origin, check]);
    const file = join(scratch, 'b.bundle');
    writeFileSync(file, snap.bundle);
    expect(git(['bundle', 'list-heads', file], check)).toBe(`${snap.headSha} refs/heads/review`);
    git(['fetch', '-q', file, 'refs/heads/review:refs/heads/got'], check);
    const files = git(['ls-tree', '-r', '--name-only', 'got'], check).split('\n');
    expect(files.sort()).toEqual(['README.md', 'src/app.ts', 'src/refund.ts']);
    expect(git(['show', 'got:src/app.ts'], check)).toBe('export const a = 3; // uncommitted');
    expect(git(['show', 'got:README.md'], check)).toBe('# api\nstaged');
    expect(git(['rev-parse', 'got^'], check)).toBe(featureSha);
    rmSync(check, { recursive: true, force: true });

    // Opting out sends HEAD itself.
    const plain = await S.snapshotBranch({ cwd: reader, includeUncommitted: false });
    expect(plain.headSha).toBe(featureSha);
    expect(plain.uncommittedChanges).toBe(false);
    git(['checkout', '-q', '--', 'src/app.ts'], reader);
    git(['reset', '-q', 'HEAD', 'README.md'], reader);
    git(['checkout', '-q', '--', 'README.md'], reader);
    rmSync(join(reader, 'secret.env'));
  });

  it("hashes with the reader's GLOBAL line-ending config, and leaves a FILTERED file (Git LFS) at HEAD's version", async () => {
    git(['checkout', '-q', '-b', 'eol', 'feature/PAY-142-refunds'], reader);
    commit(reader, { '.gitattributes': '*.bin filter=lfs\n', 't.txt': 'x\n', 'a.bin': 'pointer v1\n' }, 'eol files');
    git(['push', '-q', origin, 'eol'], reader);
    git(['fetch', '-q', origin, '+refs/heads/*:refs/remotes/origin/*'], reader);
    const committed = git(['rev-parse', 'HEAD'], reader);
    writeFileSync(join(reader, 't.txt'), 'x\r\nz\r\n');
    writeFileSync(join(reader, 'a.bin'), 'RAW BINARY CONTENT\n');
    // The reader's GLOBAL config (as Git for Windows' system config sets it): autocrlf on, an LFS driver defined.
    const home = join(scratch, 'home');
    mkdirSync(home, { recursive: true });
    const marker = join(scratch, 'filter-ran');
    writeFileSync(join(home, '.gitconfig'), `[core]\n\tautocrlf = true\n[filter "lfs"]\n\tclean = sh -c 'touch ${marker}; cat'\n\trequired = true\n`);
    const oldHome = process.env.HOME;
    process.env.HOME = home;
    const before = fingerprint(join(reader, '.git'));
    try {
      const snap = await S.snapshotBranch({ cwd: reader, includeUncommitted: true, base: 'origin/eol' });
      expect(fingerprint(join(reader, '.git'))).toEqual(before);
      expect(snap.uncommittedChanges).toBe(true);
      expect(snap.skippedFiltered).toEqual(['a.bin']);
      const check = join(scratch, 'check-eol');
      git(['clone', '-q', '--bare', origin, check]);
      const file = join(scratch, 'eol.bundle');
      writeFileSync(file, snap.bundle);
      git(['fetch', '-q', file, 'refs/heads/review:refs/heads/got'], check);
      // CRLF in the working file, LF in the blob (what the reader would commit).
      expect(execFileSync('git', ['cat-file', 'blob', 'got:t.txt'], { cwd: check, env }).toString('utf8')).toBe('x\nz\n');
      expect(git(['rev-parse', 'got:a.bin'], check)).toBe(git(['rev-parse', `${committed}:a.bin`], reader));
      expect(() => lstatSync(marker)).toThrow();
      rmSync(check, { recursive: true, force: true });
    } finally {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
      git(['checkout', '-q', '--', 't.txt', 'a.bin'], reader);
      git(['checkout', '-q', 'feature/PAY-142-refunds'], reader);
    }
  });

  it('reads a stacked branch against its upstream, and a --base', async () => {
    git(['push', '-q', origin, 'feature/PAY-142-refunds'], reader);
    git(['fetch', '-q', origin, '+refs/heads/*:refs/remotes/origin/*'], reader);
    git(['checkout', '-q', '-b', 'stacked', '--track', 'origin/feature/PAY-142-refunds'], reader);
    commit(reader, { 'src/more.ts': 'x\n' }, 'More');
    const s = await S.snapshotBranch({ cwd: reader, includeUncommitted: true });
    expect(s.baseRef).toBe('origin/feature/PAY-142-refunds');
    expect(s.baseSha).toBe(featureSha);
    const b = await S.snapshotBranch({ cwd: reader, includeUncommitted: true, base: 'origin/main' });
    expect(b.baseSha).toBe(baseSha);
    git(['checkout', '-q', 'feature/PAY-142-refunds'], reader);
  });

  it('refuses with one plain line: nothing to review, a base GitHub lacks, too large, not a repository', async () => {
    git(['checkout', '-q', '-b', 'empty', 'origin/main'], reader);
    await expect(S.snapshotBranch({ cwd: reader, includeUncommitted: true })).rejects.toThrow(/^Nothing to review: the branch has no commits after origin\/main and no uncommitted changes\.$/);
    const local = commit(reader, { 'x.txt': 'local only\n' }, 'local');
    git(['checkout', '-q', '-b', 'on-local', local], reader);
    commit(reader, { 'y.txt': 'y\n' }, 'y');
    await expect(S.snapshotBranch({ cwd: reader, includeUncommitted: false, base: local })).rejects.toThrow(/is on no branch of origin, so GitHub may not have it/);
    git(['checkout', '-q', 'feature/PAY-142-refunds'], reader);
    await expect(S.snapshotBranch({ cwd: reader, includeUncommitted: false, maxBytes: 10 })).rejects.toThrow(/too large to send/);
    await expect(S.snapshotBranch({ cwd: scratch, includeUncommitted: false })).rejects.toThrow('This folder is not inside a git repository.');
  });
});

describe("the server's intake", () => {
  const ref = (id: number) => `refs/pierre/local/local-review/${id}/head`;

  it('fetches the bundle into a full and a blobless clone under the local pinned ref', async () => {
    const snap = await S.snapshotBranch({ cwd: reader, includeUncommitted: false });
    const file = join(scratch, 'in.bundle');
    writeFileSync(file, snap.bundle);
    // The cache's clone of acme/api (a full clone here).
    mkdirSync(cloneRoot, { recursive: true });
    git(['clone', '-q', '--no-checkout', origin, CM.repoCloneDir('acme', 'api')]);
    await CM.fetchBundleIntoClone('acme', 'api', { bundlePath: file, baseSha: snap.baseSha, headSha: snap.headSha, destRef: ref(1) }, null);
    expect(git(['rev-parse', ref(1)], CM.repoCloneDir('acme', 'api'))).toBe(snap.headSha);
    // A blobless clone, as the real cache: the thin bundle's deltas resolve.
    git(['clone', '-q', '--no-checkout', '--filter=blob:none', `file://${origin}`, CM.repoCloneDir('acme', 'lean')]);
    await CM.fetchBundleIntoClone('acme', 'lean', { bundlePath: file, baseSha: snap.baseSha, headSha: snap.headSha, destRef: ref(2) }, null);
    expect(git(['rev-parse', ref(2)], CM.repoCloneDir('acme', 'lean'))).toBe(snap.headSha);
  });

  it('refuses garbage, a wrong head, a base it cannot get, and an object fsck rejects', async () => {
    const dir = CM.repoCloneDir('acme', 'api');
    const garbage = join(scratch, 'garbage.bundle');
    writeFileSync(garbage, 'not a bundle');
    await expect(CM.fetchBundleIntoClone('acme', 'api', { bundlePath: garbage, baseSha, headSha: featureSha, destRef: ref(3) }, null)).rejects.toThrow('The upload is not a git bundle.');

    const snap = await S.snapshotBranch({ cwd: reader, includeUncommitted: false });
    const file = join(scratch, 'ok.bundle');
    writeFileSync(file, snap.bundle);
    await expect(CM.fetchBundleIntoClone('acme', 'api', { bundlePath: file, baseSha, headSha: baseSha, destRef: ref(4) }, null)).rejects.toThrow(/exactly one branch, at the head commit/);
    await expect(CM.fetchBundleIntoClone('acme', 'api', { bundlePath: file, baseSha: 'e'.repeat(40), headSha: snap.headSha, destRef: ref(5) }, null)).rejects.toThrow(/is not on GitHub/);
    await expect(CM.fetchBundleIntoClone('acme', 'api', { bundlePath: file, baseSha, headSha: snap.headSha, destRef: 'refs/heads/x' }, null)).rejects.toThrow('Not a local ref Ensemble keeps.');

    // A malformed commit (a bad author line) that only fsck catches.
    const bad = join(scratch, 'bad');
    git(['clone', '-q', origin, bad]);
    const tree = git(['rev-parse', 'HEAD^{tree}'], bad);
    const body = `tree ${tree}\nparent ${baseSha}\nauthor no-email-here 1700000000 +0000\ncommitter t <t@t> 1700000000 +0000\n\nbad\n`;
    writeFileSync(join(scratch, 'commit.txt'), body);
    const badSha = git(['hash-object', '-t', 'commit', '--literally', '-w', join(scratch, 'commit.txt')], bad);
    git(['update-ref', 'refs/heads/review', badSha], bad);
    const badBundle = join(scratch, 'bad.bundle');
    git(['bundle', 'create', '-q', badBundle, 'refs/heads/review', `^${baseSha}`], bad);
    await expect(CM.fetchBundleIntoClone('acme', 'api', { bundlePath: badBundle, baseSha, headSha: badSha, destRef: ref(6) }, null)).rejects.toThrow(/^Ensemble could not read the bundle/);
    expect(() => git(['rev-parse', '--verify', '--quiet', ref(6)], dir)).toThrow();
  });
});
