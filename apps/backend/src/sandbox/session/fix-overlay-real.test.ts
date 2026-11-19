// THE AI FIX SIBLING OVERLAY ON REAL GIT (slow project; docs/SANDBOX.md § AI Fix sessions → Scope, "The overlay").
// No daemon: the sandbox and the repo store's maintenance container are `sh` on the host (the store mount
// pointed at a temp folder), and the clone cache is a real blobless clone in a scratch `cloneDir`.
//
//   1. `commitPatchToLocalRef` (fix.ts `overlayCommit`'s steps) lays a sibling's built fix on the sibling's
//      head as ONE commit under `refs/pierre/local/ai-fix-overlay/<siblingFixId>/for-<fixId>` in ENSEMBLE'S
//      CLONE CACHE: its parent is the sibling head, its tree has the patch; the reader's clone never sees it.
//   2. With the origin GONE and every non-file transport refused, a `RepoBaseRequest` naming that `localRef`
//      is mirrored into a sandbox repository through BOTH paths (the per-session copy, and the kept repo
//      store, whose `checkLocal` is never asked for the reader's clone): HEAD and `refs/limn/base` are the
//      overlay commit, the file is patched, and the session's `pinRef` points at it.
//   3. The left-out extraction (patches.ts `extractRepoPatch`, as fix.ts runs it on every non-PR repository)
//      against that base: an untouched checkout has NO changed file; an agent edit on top is the only one.
//   4. The local-ref sweep keeps the overlay ref while its owner is held (or its keeper keeps the id), and
//      drops it once released; discard (`dropLocalRefs`) drops one owner only. The session's own pin stays.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { STORE_MOUNT } from '../runtime/labels.js';
import type { ExecEvent, ExecHandle, ExecOptions, RepoStoreRuntime, SandboxRuntime } from '../runtime/types.js';
import type { LayoutRepo, WorkspaceLayout } from '../workspace/layout.js';
import type { RepoBaseRequest } from '../workspace/mirror.js';

const T = vi.hoisted(() => ({ root: '' }));

vi.mock('../../config.js', async (orig) => {
  const real = await orig<typeof import('../../config.js')>();
  return { ...real, config: new Proxy(real.config, { get: (t, k) => (k === 'cloneDir' ? T.root : (t as Record<string | symbol, unknown>)[k]) }) };
});
// No GitHub: `gh` has no token, and the account's token is a dummy (any https fetch is refused anyway).
vi.mock('../../github/auth.js', () => ({
  getGithubToken: () => {
    throw new Error('no gh token in this test');
  },
  getGithubTokenAsync: async () => {
    throw new Error('no gh token in this test');
  },
}));
vi.mock('../../auth/account.js', () => ({
  getAccessToken: async () => 'unused-token',
  getAccountById: async () => ({ displayName: 'Uma', githubLogin: 'u1' }),
}));

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'limn-fix-overlay-real-')));
T.root = join(scratch, 'clones');
const CACHE = join(T.root, 'acme__api');
const ORIGIN = join(scratch, 'origin', 'api.git');
const READER = join(scratch, 'reader', 'api');
const STORE_ROOT = join(scratch, 'store');

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
};
const git = (args: string[], cwd?: string): string => execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv }).trim();
const gitOk = (args: string[], cwd?: string): boolean => {
  try {
    execFileSync('git', args, { cwd, env: gitEnv, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

// ---- the sandbox and the store's maintenance container, as `sh` on the host ----------------------------

function hostExec(argv: string[], opts: ExecOptions = {}): ExecHandle {
  const args = argv.map((a) => a.split(STORE_MOUNT).join(STORE_ROOT));
  const child = spawn(args[0]!, args.slice(1), { cwd: opts.cwd, env: { ...gitEnv, ...(opts.env ?? {}) }, stdio: ['pipe', 'pipe', 'pipe'] });
  const queue: ExecEvent[] = [];
  let closed = false;
  let wake: (() => void) | null = null;
  const push = (e: ExecEvent): void => {
    queue.push(e);
    wake?.();
    wake = null;
  };
  child.stdout.on('data', (d: Buffer) => push({ type: 'stdout', data: d }));
  child.stderr.on('data', (d: Buffer) => push({ type: 'stderr', data: d }));
  child.stdin.on('error', () => {});
  const done = new Promise<{ code: number | null; signal: string | null; timedOut: boolean }>((resolve) => {
    child.on('close', (code, signal) => {
      closed = true;
      wake?.();
      wake = null;
      resolve({ code, signal, timedOut: false });
    });
  });
  if (opts.input != null) child.stdin.end(opts.input);
  else if (!opts.interactive) child.stdin.end();
  async function* events(): AsyncIterable<ExecEvent> {
    for (;;) {
      const e = queue.shift();
      if (e) {
        yield e;
        continue;
      }
      if (closed) return;
      await new Promise<void>((r) => (wake = r));
    }
  }
  return {
    events: events(),
    write: (d) => void child.stdin.write(d),
    end: () => void child.stdin.end(),
    kill: () => void child.kill('SIGKILL'),
    done,
  };
}

async function hostRun(argv: string[], opts: ExecOptions = {}) {
  const { collect } = await import('../runtime/cli.js');
  return collect(hostExec(argv, opts));
}

const repoStore: RepoStoreRuntime = {
  ensure: async () => STORE_ROOT,
  exec: (_owner, argv, opts) => hostExec(argv, opts ?? {}),
  remove: async () => ({ volumes: [], errors: [] }),
};
const runtimeOf = (withStore: boolean): SandboxRuntime =>
  ({
    kind: 'docker',
    ...(withStore ? { repoStore } : {}),
    exec: (_c: string, argv: string[], o?: ExecOptions) => hostExec(argv, o),
    run: (_c: string, argv: string[], o?: ExecOptions) => hostRun(argv, o),
  }) as unknown as SandboxRuntime;

// ---- the fixture ---------------------------------------------------------------------------------------

const REPO_ID = 2;
const SIBLING_FIX_ID = 41;
const FIX_ID = 42;
const OVERLAY_KIND = 'ai-fix-overlay'; // fix.ts SIBLING_OVERLAY_REF_KIND
const OVERLAY_REF = `refs/pierre/local/${OVERLAY_KIND}/${SIBLING_FIX_ID}/for-${FIX_ID}`;
const PIN_REF = `refs/pierre/ai-fix/${FIX_ID}/${REPO_ID}`; // base-refs.ts aiFixBaseRef(FIX_ID, REPO_ID)
// The sibling's built, unpushed fix: one line of a.ts changed.
const SIBLING_PATCH = ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -1,2 +1,2 @@', ' export const a = 1;', '-export const fixMe = false;', '+export const fixMe = true;', ''].join('\n');

let MAIN = '';
let HEAD = '';
let overlay = { ref: '', commitSha: '', treeSha: '', changed: false };
const savedAllow = process.env.GIT_ALLOW_PROTOCOL;

beforeAll(() => {
  // Only local transports exist in this test: an https fetch (GitHub) is refused by git itself.
  process.env.GIT_ALLOW_PROTOCOL = 'file:ext';
  const src = join(scratch, 'src');
  mkdirSync(src, { recursive: true });
  git(['init', '-q', '-b', 'main', src]);
  mkdirSync(join(src, 'lib'));
  writeFileSync(join(src, 'a.ts'), 'export const a = 1;\nexport const fixMe = false;\n');
  writeFileSync(join(src, 'lib', 'b.ts'), 'export const b = 2;\n');
  git(['add', '-A'], src);
  git(['commit', '-qm', 'main'], src);
  MAIN = git(['rev-parse', 'HEAD'], src);
  // The sibling PR's branch.
  git(['checkout', '-qb', 'feature'], src);
  writeFileSync(join(src, 'lib', 'b.ts'), 'export const b = 3;\n');
  git(['add', '-A'], src);
  git(['commit', '-qm', 'sibling pr head'], src);
  HEAD = git(['rev-parse', 'HEAD'], src);
  git(['checkout', '-q', 'main'], src);
  mkdirSync(join(scratch, 'origin'), { recursive: true });
  git(['clone', '-q', '--bare', src, ORIGIN]);
  git(['-C', ORIGIN, 'config', 'uploadpack.allowFilter', 'true']);
  // Ensemble's clone cache: blobless, no checkout (as `ensureClone` makes it).
  mkdirSync(T.root, { recursive: true });
  git(['clone', '-q', '--filter=blob:none', '--no-checkout', `file://${ORIGIN}`, CACHE]);
  // The reader's own clone: complete, with the sibling's head (it would be a valid store source).
  mkdirSync(join(scratch, 'reader'), { recursive: true });
  git(['clone', '-q', `file://${ORIGIN}`, READER]);
  git(['-C', READER, 'fetch', '-q', 'origin', 'feature']);
  mkdirSync(STORE_ROOT, { recursive: true });
}, 60_000);

afterAll(() => {
  if (savedAllow == null) delete process.env.GIT_ALLOW_PROTOCOL;
  else process.env.GIT_ALLOW_PROTOCOL = savedAllow;
  rmSync(scratch, { recursive: true, force: true });
});

const cm = await import('../../review/clone-manager.js');
const ops = await import('../../coding/git-ops.js');
const lr = await import('../../review/local-refs.js');
const { mirrorRepos, defaultMirrorSeams } = await import('../workspace/mirror.js');
const { defaultStoreSeams } = await import('../workspace/store.js');
const { extractRepoPatch } = await import('./patches.js');

const layoutFor = (path: string): WorkspaceLayout =>
  ({
    root: join(scratch, 'ws'),
    folder: null,
    repos: [{ repoId: REPO_ID, fullName: 'acme/api', path, placed: 'default' } as unknown as LayoutRepo],
    startDir: join(scratch, 'ws'),
    startDirReason: 'default',
    memoryProjects: [],
    outside: [],
    notes: [],
  }) as WorkspaceLayout;

const overlayBase = (): RepoBaseRequest =>
  ({ repoId: REPO_ID, owner: 'acme', name: 'api', baseRef: 'feature', baseSha: overlay.commitSha, localRef: overlay.ref, pinRef: PIN_REF }) as RepoBaseRequest;

/** The left-out extraction exactly as fix.ts runs it for a repository that is not the PR's. */
const leftOutOf = (path: string) => extractRepoPatch(runtimeOf(false), 'sandbox', path, { maxBytes: Number.POSITIVE_INFINITY });

/** The checkout untouched ⇒ nothing left out; an agent edit (committed or not) ⇒ only that edit. */
async function expectOnlyTheAgentsEdits(path: string): Promise<void> {
  const untouched = await leftOutOf(path);
  expect(untouched.filesChanged).toEqual([]);
  expect(untouched.patch).toBe('');
  expect(untouched.stat.commits).toBe(0);

  writeFileSync(join(path, 'lib', 'b.ts'), 'export const b = 4;\n');
  git(['commit', '-qam', 'agent edit'], path);
  writeFileSync(join(path, 'new.ts'), 'export const n = 0;\n');
  const edited = await leftOutOf(path);
  expect(edited.filesChanged.sort()).toEqual(['lib/b.ts', 'new.ts']);
  expect(edited.patch).not.toContain('a.ts');
  expect(edited.patch).not.toContain('fixMe');
  expect(edited.stat.commits).toBe(1);
}

describe('the sibling overlay, end to end on real git', () => {
  it('1. lays the sibling fix on the sibling head as ONE commit in the clone cache, never in the reader\'s clone', async () => {
    // overlayCommit's first step: the sibling head is already in the cache, so nothing is fetched.
    const r = await cm.resolveBranchCommit('acme', 'api', { remoteRef: 'refs/pull/7/head', destRef: 'refs/pierre/sandbox-base', sha: HEAD }, 'unused-token');
    expect(r.sha).toBe(HEAD);
    expect(gitOk(['-C', CACHE, 'rev-parse', '--verify', '--quiet', 'refs/pierre/sandbox-base'])).toBe(false);

    overlay = await ops.commitPatchToLocalRef({
      accountId: 1,
      owner: 'acme',
      name: 'api',
      baseRef: 'feature',
      baseSha: HEAD,
      patch: SIBLING_PATCH,
      message: 'AI fix of #7, not pushed',
      key: { kind: OVERLAY_KIND, id: SIBLING_FIX_ID, name: `for-${FIX_ID}` },
    });
    expect(overlay.changed).toBe(true);
    expect(overlay.ref).toBe(OVERLAY_REF);
    expect(git(['-C', CACHE, 'rev-parse', OVERLAY_REF])).toBe(overlay.commitSha);
    expect(git(['-C', CACHE, 'rev-list', '--parents', '-n', '1', overlay.commitSha])).toBe(`${overlay.commitSha} ${HEAD}`);
    expect(git(['-C', CACHE, 'rev-parse', `${overlay.commitSha}^{tree}`])).toBe(overlay.treeSha);
    expect(git(['-C', CACHE, 'show', `${overlay.commitSha}:a.ts`])).toBe('export const a = 1;\nexport const fixMe = true;');
    expect(git(['-C', CACHE, 'show', `${overlay.commitSha}:lib/b.ts`])).toBe('export const b = 3;');
    expect(git(['-C', CACHE, 'diff', '--name-only', HEAD, overlay.commitSha])).toBe('a.ts');
    // The reader's clone: no such commit, no Ensemble ref.
    expect(gitOk(['-C', READER, 'cat-file', '-e', `${overlay.commitSha}^{commit}`])).toBe(false);
    expect(git(['-C', READER, 'for-each-ref', 'refs/pierre/'])).toBe('');
    // Nothing on the origin either: it was never pushed.
    expect(gitOk(['-C', ORIGIN, 'cat-file', '-e', `${overlay.commitSha}^{commit}`])).toBe(false);
    expect(MAIN).not.toBe(HEAD);
  });

  it('2+3a. the per-session copy: no fetch, HEAD is the overlay, and only the agent\'s edits are left out', async () => {
    // GitHub (the origin) is gone from here on: any fetch, lazy blob fetch included, would fail.
    renameSync(ORIGIN, `${ORIGIN}.gone`);
    try {
      // The control: any fetch really fails now (GitHub over https is refused; the origin is gone).
      expect(gitOk(['-C', CACHE, 'fetch', '-q', 'origin'])).toBe(false);
      await expect(cm.resolveBranchCommit('acme', 'api', { remoteRef: 'refs/heads/nope', destRef: 'refs/pierre/x', sha: 'f'.repeat(40) }, 'unused-token')).rejects.toThrow();
      const path = join(scratch, 'sandbox-copy', 'api');
      const prepare = vi.fn(defaultMirrorSeams.prepare);
      const got = await mirrorRepos(runtimeOf(false), 'sandbox', layoutFor(path), new Map([[REPO_ID, overlayBase()]]), `limn/fix-${FIX_ID}`, {
        seams: { prepare, tarGitDir: defaultMirrorSeams.tarGitDir },
      });
      expect(got.failed).toEqual([]);
      expect(got.repos).toEqual([{ repoId: REPO_ID, fullName: 'acme/api', path, sha: overlay.commitSha }]);
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(git(['rev-parse', 'HEAD'], path)).toBe(overlay.commitSha);
      expect(git(['rev-parse', 'refs/limn/base'], path)).toBe(overlay.commitSha);
      expect(git(['symbolic-ref', '--short', 'HEAD'], path)).toBe(`limn/fix-${FIX_ID}`);
      expect(readFileSync(join(path, 'a.ts'), 'utf8')).toBe('export const a = 1;\nexport const fixMe = true;\n');
      expect(git(['status', '--porcelain'], path)).toBe('');
      expect(git(['remote'], path)).toBe('');
      // The session's own pin, in the clone cache; no fetch ref; the temporary worktree removed.
      expect(git(['-C', CACHE, 'rev-parse', PIN_REF])).toBe(overlay.commitSha);
      expect(gitOk(['-C', CACHE, 'rev-parse', '--verify', '--quiet', 'refs/pierre/sandbox-base'])).toBe(false);
      expect(git(['-C', CACHE, 'worktree', 'list', '--porcelain']).split('\n').filter((l) => l.startsWith('worktree ')).length).toBe(1);

      await expectOnlyTheAgentsEdits(path);
    } finally {
      renameSync(`${ORIGIN}.gone`, ORIGIN);
    }
  }, 60_000);

  it('2+3b. the kept repo store: no fetch, never the reader\'s clone, HEAD is the overlay, only the agent\'s edits are left out', async () => {
    renameSync(ORIGIN, `${ORIGIN}.gone`);
    try {
      const seams = {
        resolveBase: vi.fn(defaultStoreSeams.resolveBase),
        checkLocal: vi.fn(defaultStoreSeams.checkLocal),
        hydrateCache: vi.fn(defaultStoreSeams.hydrateCache),
        transfer: vi.fn(defaultStoreSeams.transfer),
      };
      const prepare = vi.fn(defaultMirrorSeams.prepare);
      const owner = { sessionId: 'overlay-test', accountId: 1 };
      const run = (path: string) =>
        mirrorRepos(runtimeOf(true), 'sandbox', layoutFor(path), new Map([[REPO_ID, overlayBase()]]), `limn/fix-${FIX_ID}`, {
          seams: { prepare, tarGitDir: defaultMirrorSeams.tarGitDir },
          store: { owner, seams },
          localClones: new Map([[REPO_ID, [READER]]]),
        });

      const path = join(scratch, 'sandbox-store', 'api');
      const got = await run(path);
      expect(got.failed).toEqual([]);
      expect(got.repos).toEqual([{ repoId: REPO_ID, fullName: 'acme/api', path, sha: overlay.commitSha }]);
      // Through the store (not the per-session copy), from the CLONE CACHE; the reader's clone never asked.
      expect(prepare).not.toHaveBeenCalled();
      expect(seams.checkLocal).not.toHaveBeenCalled();
      expect(seams.hydrateCache).toHaveBeenCalledTimes(1);
      expect(seams.transfer).toHaveBeenCalledTimes(1);
      expect(seams.transfer.mock.calls[0]![3]).toBe(join(CACHE, '.git'));
      expect(got.notes).toEqual([]);
      const storeRepo = join(STORE_ROOT, 'acme__api.git');
      expect(git(['--git-dir', storeRepo, 'rev-parse', `refs/limn/keep/${overlay.commitSha}`])).toBe(overlay.commitSha);
      expect(git(['rev-parse', 'HEAD'], path)).toBe(overlay.commitSha);
      expect(git(['rev-parse', 'refs/limn/base'], path)).toBe(overlay.commitSha);
      expect(readFileSync(join(path, 'a.ts'), 'utf8')).toBe('export const a = 1;\nexport const fixMe = true;\n');
      expect(readFileSync(join(path, '.git', 'objects', 'info', 'alternates'), 'utf8').trim()).toBe(join(STORE_ROOT, 'acme__api.git', 'objects'));
      expect(git(['-C', CACHE, 'rev-parse', PIN_REF])).toBe(overlay.commitSha);
      expect(gitOk(['-C', CACHE, 'rev-parse', '--verify', '--quiet', 'refs/pierre/sandbox-base'])).toBe(false);
      expect(git(['-C', READER, 'for-each-ref', 'refs/pierre/'])).toBe('');

      await expectOnlyTheAgentsEdits(path);

      // A second session reads the store alone: nothing copied again.
      const again = join(scratch, 'sandbox-store-2', 'api');
      const second = await run(again);
      expect(second.repos.map((x) => x.sha)).toEqual([overlay.commitSha]);
      expect(seams.hydrateCache).toHaveBeenCalledTimes(1);
      expect(seams.transfer).toHaveBeenCalledTimes(1);
      expect((await leftOutOf(again)).filesChanged).toEqual([]);
    } finally {
      renameSync(`${ORIGIN}.gone`, ORIGIN);
    }
  }, 60_000);

  it('4. the sweep keeps the overlay ref while held (or kept), drops it once released; discard drops one owner', async () => {
    const refs = (): string[] => git(['-C', CACHE, 'for-each-ref', '--format=%(refname)', 'refs/pierre/local/']).split('\n').filter(Boolean);
    expect(refs()).toEqual([OVERLAY_REF]);

    const release = lr.holdLocalRefs(OVERLAY_KIND, SIBLING_FIX_ID);
    expect(await lr.sweepLocalRefs()).toMatchObject({ deleted: 0, kept: 1 });
    expect(refs()).toEqual([OVERLAY_REF]);
    release();

    // A keeper that still needs the sibling fix (built, unpushed) keeps it too.
    lr.registerLocalRefKeeper(OVERLAY_KIND, async (ids) => new Set(ids.filter((id) => id === SIBLING_FIX_ID)));
    expect(await lr.sweepLocalRefs()).toMatchObject({ deleted: 0, kept: 1 });
    lr.registerLocalRefKeeper(OVERLAY_KIND, async () => new Set());
    expect(await lr.sweepLocalRefs()).toMatchObject({ deleted: 1, kept: 0 });
    expect(refs()).toEqual([]);
    lr.registerLocalRefKeeper(OVERLAY_KIND, null);
    // The session that read it pinned its own base: the commit outlives the overlay ref.
    expect(git(['-C', CACHE, 'rev-parse', PIN_REF])).toBe(overlay.commitSha);
    expect(gitOk(['-C', CACHE, 'cat-file', '-e', `${overlay.commitSha}^{commit}`])).toBe(true);

    // Discard (fix.ts dropSiblingOverlayRefs): only the pushed/discarded sibling fix's overlays go.
    git(['-C', CACHE, 'update-ref', OVERLAY_REF, overlay.commitSha]);
    git(['-C', CACHE, 'update-ref', `refs/pierre/local/${OVERLAY_KIND}/${SIBLING_FIX_ID + 100}/for-${FIX_ID}`, overlay.commitSha]);
    expect(await lr.dropLocalRefs('acme', 'api', OVERLAY_KIND, SIBLING_FIX_ID)).toBe(1);
    expect(refs()).toEqual([`refs/pierre/local/${OVERLAY_KIND}/${SIBLING_FIX_ID + 100}/for-${FIX_ID}`]);
    expect(existsSync(CACHE)).toBe(true);
  }, 60_000);
});
