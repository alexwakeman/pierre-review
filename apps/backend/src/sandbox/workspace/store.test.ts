// THE REPO STORE'S DECISIONS over the fake runtime and fake host steps (docs/SANDBOX.md § The repo store):
// when objects are copied and from where, the fallbacks, the one note about the reader's clones, the
// bounded concurrency, and the per-session copy as the last resort. Real git and a real daemon:
// store-real.test.ts (slow project).
import { describe, expect, it } from 'vitest';
import { createFakeRuntime, type FakeRuntime } from '../runtime/fake.js';
import type { ExecHandle, RepoStoreRuntime, SandboxRuntime } from '../runtime/types.js';
import type { LayoutRepo, WorkspaceLayout } from './layout.js';
import { MIRROR_CONCURRENCY, mapBounded, mirrorRepos, type MirrorSeams, type RepoBaseRequest } from './mirror.js';
import { IN_SANDBOX_FROM_STORE, storeRepoDir, type StoreSeams } from './store.js';
import { sandboxMountsFor } from './index.js';

const sha = (n: number): string => n.toString(16).padStart(40, 'a');
const owner = { sessionId: 's1', accountId: 1 };

function layoutOf(names: string[]): WorkspaceLayout {
  const repos: LayoutRepo[] = names.map((name, i) => ({ repoId: i + 1, owner: 'DEFRA', name, fullName: `DEFRA/${name}`, path: `/w/${name}`, placed: 'folder' }));
  return { root: '/w', folder: '/w', repos, startDir: '/w', startDirReason: 'folder', memoryProjects: [], outside: [], notes: [] };
}

function basesOf(layout: WorkspaceLayout): Map<number, RepoBaseRequest> {
  return new Map(layout.repos.map((r) => [r.repoId, { repoId: r.repoId, owner: r.owner, name: r.name, baseRef: 'main', baseSha: null, pinRef: `refs/pierre/p/${r.repoId}` }]));
}

/** A fake runtime with a store: `present` is what the store holds (`<dir> <sha>`). */
function withStore(present: Set<string>): { rt: SandboxRuntime & FakeRuntime; builds: string[] } {
  const fake = createFakeRuntime();
  const builds: string[] = [];
  fake.onExec((argv) => argv[2] === IN_SANDBOX_FROM_STORE, (ctx) => {
    const [, , , , dest, , s, dir] = ctx.argv;
    if (!present.has(`${dir} ${s}`)) return 75;
    builds.push(dest!);
    ctx.stdout(`${s}\n`);
    return 0;
  });
  const store: RepoStoreRuntime = {
    ensure: async () => 'limn-repo-store-test',
    exec: (): ExecHandle => {
      throw new Error('the fake host steps never start a maintenance container');
    },
    remove: async () => ({ volumes: [], errors: [] }),
  };
  Object.defineProperty(fake, 'repoStore', { value: store });
  return { rt: fake as SandboxRuntime & FakeRuntime, builds };
}

interface Log {
  checked: string[];
  transfers: Array<{ dir: string; gitDir: string }>;
  hydrated: string[];
  cleaned: string[];
}

function seamsFor(present: Set<string>, o: { local?: Record<string, 'ok' | string>; transferFails?: (gitDir: string) => boolean; resolveFails?: string[] } = {}): { seams: StoreSeams; log: Log } {
  const log: Log = { checked: [], transfers: [], hydrated: [], cleaned: [] };
  const shaOf = (name: string): string => sha(name.length);
  const seams: StoreSeams = {
    async resolveBase(req) {
      if (o.resolveFails?.includes(req.name)) throw new Error('GitHub did not answer');
      return { sha: shaOf(req.name) };
    },
    async checkLocal(path, s) {
      log.checked.push(path);
      const verdict = o.local?.[path] ?? 'it does not have the base commit';
      return verdict === 'ok' ? { ok: true, gitDir: `${path}/.git` } : { ok: false, reason: verdict };
    },
    async hydrateCache(req) {
      log.hydrated.push(req.name);
      return { gitDir: `/cache/${req.name}/.git`, cleanup: async () => void log.cleaned.push(req.name) };
    },
    async transfer(_store, _owner, dir, gitDir, s) {
      if (o.transferFails?.(gitDir)) throw new Error('fsck failed');
      log.transfers.push({ dir, gitDir });
      present.add(`${dir} ${s}`);
    },
  };
  return { seams, log };
}

const legacySeams = (): MirrorSeams & { prepared: string[] } => {
  const prepared: string[] = [];
  return {
    prepared,
    async prepare(req) {
      prepared.push(req.name);
      return { sha: sha(req.name.length), dir: '/tmp/x', cleanup: async () => {} };
    },
    async *tarGitDir() {
      yield Buffer.from('tar');
    },
  };
};

describe('the repo store path', () => {
  it('a warm store copies nothing and reads no clone', async () => {
    const layout = layoutOf(['backend', 'harness']);
    const present = new Set(layout.repos.map((r) => `${storeRepoDir(r.owner, r.name)} ${sha(r.name.length)}`));
    const { rt, builds } = withStore(present);
    const { seams, log } = seamsFor(present);
    const res = await mirrorRepos(rt, 'box', layout, basesOf(layout), 'limn/x', { store: { owner, seams }, localClones: new Map([[1, ['/home/backend']]]) });
    expect(res.repos.map((r) => [r.fullName, r.sha])).toEqual([['DEFRA/backend', sha(7)], ['DEFRA/harness', sha(7)]]);
    expect(builds).toEqual(['/w/backend', '/w/harness']);
    expect(log).toEqual({ checked: [], transfers: [], hydrated: [], cleaned: [] });
    expect(res.notes).toEqual([]);
  });

  it('copies from the reader\'s clone when it has the commit, else from the clone cache (one note)', async () => {
    const layout = layoutOf(['backend', 'docs', 'frontend']);
    const present = new Set<string>();
    const { rt } = withStore(present);
    const { seams, log } = seamsFor(present, { local: { '/home/backend': 'ok' } });
    const res = await mirrorRepos(rt, 'box', layout, basesOf(layout), 'limn/x', {
      store: { owner, seams },
      localClones: new Map([[1, ['/home/backend']], [2, ['/home/docs']]]),
    });
    expect(res.failed).toEqual([]);
    expect(res.repos).toHaveLength(3);
    expect(log.transfers.sort((a, b) => a.dir.localeCompare(b.dir))).toEqual([
      { dir: 'DEFRA__backend.git', gitDir: '/home/backend/.git' },
      { dir: 'DEFRA__docs.git', gitDir: '/cache/docs/.git' },
      { dir: 'DEFRA__frontend.git', gitDir: '/cache/frontend/.git' },
    ]);
    expect(log.hydrated.sort()).toEqual(['docs', 'frontend']);
    expect(log.cleaned.sort()).toEqual(['docs', 'frontend']);
    // Only a repository WITH a local clone that was not used is named.
    expect(res.notes).toEqual(["Copied from Limn's own clone, not yours: DEFRA/docs (it does not have the base commit)."]);
  });

  it('tries the next local clone, and the cache when copying from the local one fails', async () => {
    const layout = layoutOf(['backend']);
    const present = new Set<string>();
    const { rt } = withStore(present);
    const { seams, log } = seamsFor(present, { local: { '/a/backend': 'it is a shallow clone', '/b/backend': 'ok' }, transferFails: (g) => g.startsWith('/b/') });
    const res = await mirrorRepos(rt, 'box', layout, basesOf(layout), 'limn/x', { store: { owner, seams }, localClones: new Map([[1, ['/a/backend', '/b/backend']]]) });
    expect(log.checked).toEqual(['/a/backend', '/b/backend']);
    expect(log.transfers).toEqual([{ dir: 'DEFRA__backend.git', gitDir: '/cache/backend/.git' }]);
    expect(res.repos).toHaveLength(1);
    expect(res.notes).toEqual(["Copied from Limn's own clone, not yours: DEFRA/backend (copying from it failed)."]);
  });

  it('a store step that fails falls back to the per-session copy; a base that cannot be resolved does not', async () => {
    const layout = layoutOf(['backend', 'harness']);
    const present = new Set<string>();
    const { rt } = withStore(present);
    rt.onExec(/tar -x/, (ctx) => {
      ctx.stdout(`${sha(7)}\n`);
      return 0;
    });
    const { seams } = seamsFor(present, { transferFails: () => true, resolveFails: ['harness'] });
    const legacy = legacySeams();
    const res = await mirrorRepos(rt, 'box', layout, basesOf(layout), 'limn/x', { store: { owner, seams }, seams: legacy });
    expect(legacy.prepared).toEqual(['backend']);
    expect(res.repos.map((r) => r.fullName)).toEqual(['DEFRA/backend']);
    expect(res.failed).toEqual([{ repoId: 2, fullName: 'DEFRA/harness', reason: 'GitHub did not answer' }]);
  });

  it('without a store mounted, every repository takes the per-session copy', async () => {
    const layout = layoutOf(['backend']);
    const { rt } = withStore(new Set());
    rt.onExec(/tar -x/, (ctx) => {
      ctx.stdout(`${sha(7)}\n`);
      return 0;
    });
    const legacy = legacySeams();
    const res = await mirrorRepos(rt, 'box', layout, basesOf(layout), 'limn/x', { seams: legacy });
    expect(legacy.prepared).toEqual(['backend']);
    expect(res.repos).toHaveLength(1);
  });
});

describe('bounded concurrency', () => {
  it(`runs at most ${MIRROR_CONCURRENCY} at once and keeps the order`, async () => {
    let inFlight = 0;
    let most = 0;
    const out = await mapBounded([5, 1, 4, 2, 3, 1, 2], MIRROR_CONCURRENCY, async (n) => {
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise((r) => setTimeout(r, n * 3));
      inFlight--;
      return n * 10;
    });
    expect(most).toBe(MIRROR_CONCURRENCY);
    expect(out).toEqual([50, 10, 40, 20, 30, 10, 20]);
  });

  it('mirrors repositories in parallel, results in the layout order', async () => {
    const names = ['a1', 'b22', 'c333', 'd4444', 'e55555'];
    const layout = layoutOf(names);
    const present = new Set(layout.repos.map((r) => `${storeRepoDir(r.owner, r.name)} ${sha(r.name.length)}`));
    const { rt } = withStore(present);
    let inFlight = 0;
    let most = 0;
    const { seams } = seamsFor(present);
    const slow: StoreSeams = {
      ...seams,
      async resolveBase(req) {
        inFlight++;
        most = Math.max(most, inFlight);
        await new Promise((r) => setTimeout(r, 15 - req.name.length));
        inFlight--;
        return seams.resolveBase(req);
      },
    };
    const res = await mirrorRepos(rt, 'box', layout, basesOf(layout), 'limn/x', { store: { owner, seams: slow } });
    expect(most).toBe(3);
    expect(res.repos.map((r) => r.fullName)).toEqual(names.map((n) => `DEFRA/${n}`));
  });
});

describe('the mounts and the names', () => {
  it('mounts the store read-only beside the session volume', () => {
    const layout = layoutOf(['x']);
    expect(sandboxMountsFor(layout, 'limn-s1-vol-ws', 'limn-repo-store-d1').mounts).toEqual([
      { kind: 'volume', name: 'limn-s1-vol-ws', target: '/w' },
      { kind: 'volume', name: 'limn-repo-store-d1', target: '/limn-store', readOnly: true },
    ]);
    expect(sandboxMountsFor(layout, 'v').mounts).toHaveLength(1);
    expect(() => sandboxMountsFor({ ...layout, root: '/limn-store/x' }, 'v', 's')).toThrow(/inside the repo store/);
  });

  it('names a store folder per repository and refuses anything path-like', () => {
    expect(storeRepoDir('DEFRA', 'bng-metric-harness')).toBe('DEFRA__bng-metric-harness.git');
    expect(() => storeRepoDir('..', 'x')).toThrow();
    expect(() => storeRepoDir('a/b', 'x')).toThrow();
    expect(() => storeRepoDir('a', '.git')).toThrow();
  });
});
