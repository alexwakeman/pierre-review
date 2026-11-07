// THE REPO STORE ON REAL GIT AND A REAL DAEMON (slow project; docs/SANDBOX.md § The repo store).
//
//   1. Real git: which local clones may give objects (complete, has the commit) and which may not
//      (shallow, partial, missing commit, not a repository).
//   2. Docker: objects copied from a DIRTY local clone into a test-named store by the maintenance
//      container; a sandbox builds its repository from the store, read-only, at exactly the commit; a
//      second base copies only what the store lacks; the reader's clone is not written (every path's
//      mtime and size, and `git status`), its hooks and fsmonitor never run.
//
// Skipped (with the reason) when no daemon answers. Resources carry `limn.test=1` and are removed,
// the store volume included.
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDockerRuntime } from '../runtime/docker.js';
import { collect } from '../runtime/cli.js';
import type { SandboxRuntime } from '../runtime/types.js';
import { checkLocalSource, cloneFromStore, storeRepoDir, transferIntoStore } from './store.js';

const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_OPTIONAL_LOCKS: '0' };
const git = (args: string[], cwd?: string): string => execFileSync('git', args, { cwd, encoding: 'utf8', env }).trim();

let scratch = '';
let reader = '';
const shas: string[] = [];

function commit(dir: string, files: Record<string, string>, msg: string): string {
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(join(dir, f, '..'), { recursive: true });
    writeFileSync(join(dir, f), text);
  }
  git(['add', '-A'], dir);
  git(['commit', '-qm', msg], dir);
  return git(['rev-parse', 'HEAD'], dir);
}

/** Every path under `dir` with its mtime and size (the proof nothing was written). */
function snapshot(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      const st = lstatSync(p);
      out.push(`${p} ${st.mtimeMs} ${st.size}`);
      if (st.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out.sort();
}

beforeAll(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'limn-store-real-')));
  reader = join(scratch, 'reader', 'bng-metric-backend');
  mkdirSync(reader, { recursive: true });
  git(['init', '-q', '-b', 'main', reader]);
  shas.push(commit(reader, { 'package.json': '{"name":"backend"}\n', 'src/app.js': 'console.log(1)\n', 'big/data.bin': randomBytes(200_000).toString('hex') }, 'one'));
  shas.push(commit(reader, { 'src/app.js': 'console.log(2)\n' }, 'two'));
  shas.push(commit(reader, { 'src/app.js': 'console.log(3)\n' }, 'three'));
  // DIRTY: a stash, a staged change, an edit, an untracked file.
  writeFileSync(join(reader, 'src/app.js'), 'stashed\n');
  git(['stash', '-q'], reader);
  writeFileSync(join(reader, 'staged.txt'), 'staged\n');
  git(['add', 'staged.txt'], reader);
  writeFileSync(join(reader, 'package.json'), '{"name":"edited"}\n');
  writeFileSync(join(reader, 'untracked.txt'), 'mine\n');
  // Hooks and an fsmonitor that would leave a mark if anything ran them.
  const mark = join(scratch, 'ran');
  for (const hook of ['post-checkout', 'pre-push', 'post-index-change', 'reference-transaction', 'pre-auto-gc']) {
    writeFileSync(join(reader, '.git', 'hooks', hook), `#!/bin/sh\necho ${hook} >> ${mark}\n`);
    chmodSync(join(reader, '.git', 'hooks', hook), 0o755);
  }
  writeFileSync(join(scratch, 'fsmonitor.sh'), `#!/bin/sh\necho fsmonitor >> ${mark}\n`);
  chmodSync(join(scratch, 'fsmonitor.sh'), 0o755);
  git(['config', 'core.fsmonitor', join(scratch, 'fsmonitor.sh')], reader);
  if (existsSync(mark)) rmSync(mark);
}, 60_000);

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('which local clone may give objects', () => {
  it('a complete clone with the commit, yes; shallow, partial, without the commit or not a repository, no', async () => {
    expect(await checkLocalSource(reader, shas[2]!)).toEqual({ ok: true, gitDir: join(reader, '.git') });
    expect(await checkLocalSource(reader, 'f'.repeat(40))).toEqual({ ok: false, reason: 'it does not have the base commit' });
    const origin = join(scratch, 'origin.git');
    git(['clone', '-q', '--bare', reader, origin]);
    git(['-C', origin, 'config', 'uploadpack.allowFilter', 'true']);
    const shallow = join(scratch, 'shallow');
    git(['clone', '-q', '--depth', '1', `file://${origin}`, shallow]);
    expect(await checkLocalSource(shallow, shas[2]!)).toEqual({ ok: false, reason: 'it is a shallow clone' });
    const partial = join(scratch, 'partial');
    git(['clone', '-q', '--filter=blob:none', '--no-checkout', `file://${origin}`, partial]);
    expect(await checkLocalSource(partial, shas[2]!)).toEqual({ ok: false, reason: 'it is a partial clone' });
    mkdirSync(join(scratch, 'plain'));
    expect(await checkLocalSource(join(scratch, 'plain'), shas[2]!)).toEqual({ ok: false, reason: 'it is not a git repository' });
  }, 60_000);
});

const docker = process.env.SANDBOX_CLI || 'docker';
const probe = spawnSync(docker, ['info', '--format', '{{.OSType}}'], { encoding: 'utf8', timeout: 20_000 });
const daemon = probe.status === 0 && probe.stdout.trim() === 'linux';
if (!daemon) console.warn(`[store-real] Docker part SKIPPED: no Linux container daemon answers`);

describe.skipIf(!daemon)('the store on a real daemon', () => {
  const instance = `test-${randomBytes(4).toString('hex')}`;
  const owner = { sessionId: `t${randomBytes(4).toString('hex')}`, accountId: 1 };
  const rt: SandboxRuntime = createDockerRuntime({ instance, extraLabels: { 'limn.test': '1' } });
  const dir = storeRepoDir('DEFRA', 'bng-metric-backend');
  let sandbox = '';
  let before: string[] = [];
  let statusBefore = '';
  const sh = async (cmd: string, cwd?: string): Promise<{ code: number | null; out: string; err: string }> => {
    const r = await rt.run(sandbox, ['bash', '-c', cmd], { timeoutMs: 60_000, ...(cwd ? { cwd } : {}) });
    return { code: r.code, out: String(r.stdout).trim(), err: r.stderr.trim() };
  };
  const counts = async (): Promise<Record<string, string>> => {
    const r = await collect(rt.repoStore!.exec(owner, ['sh', '-c', `git --git-dir=/limn-store/${dir} count-objects -v`]));
    return Object.fromEntries(String(r.stdout).trim().split('\n').map((l) => l.split(': ')));
  };
  const storeObjects = async (): Promise<number> => {
    const kv = await counts();
    return Number(kv.count) + Number(kv['in-pack']);
  };
  const storeKiB = async (): Promise<number> => {
    const kv = await counts();
    return Number(kv.size) + Number(kv['size-pack']);
  };

  beforeAll(async () => {
    before = snapshot(reader);
    statusBefore = git(['-c', 'core.fsmonitor=false', 'status', '--porcelain=v2', '--branch'], reader);
    await rt.ensureImage();
    const net = await rt.createNetwork(owner);
    const volume = await rt.createVolume(owner, 'ws');
    const store = await rt.repoStore!.ensure();
    expect(store).toBe(`limn-repo-store-${instance}`);
    sandbox = (
      await rt.startSandbox({
        ...owner,
        image: (await rt.ensureImage()).ref,
        network: net.name,
        env: {},
        mounts: [
          { kind: 'volume', name: volume, target: '/w' },
          { kind: 'volume', name: store, target: '/limn-store', readOnly: true },
        ],
        workdir: '/w',
        resources: { cpus: 1, memoryBytes: 1024 ** 3, pids: 256, diskBytes: 1024 ** 3 },
      })
    ).name;
    await rt.run(sandbox, ['sh', '-c', 'git config --global user.name t; git config --global user.email t@t']);
  }, 20 * 60_000);

  afterAll(async () => {
    await rt.destroy(owner.sessionId);
    const removed = await rt.repoStore!.remove();
    expect(removed).toEqual({ volumes: [`limn-repo-store-${instance}`], errors: [] });
    const left = spawnSync(docker, ['volume', 'ls', '-q', '--filter', `label=limn.store=${instance}`], { encoding: 'utf8' }).stdout.trim();
    expect(left).toBe('');
    expect(await rt.sweep([], { dryRun: true })).toEqual({ containers: [], networks: [], volumes: [], images: [], errors: [] });
  }, 120_000);

  it('a repository from an empty store needs the objects; after the copy it is exactly the commit', async () => {
    expect(await cloneFromStore(rt, sandbox, '/w/bng-metric-backend', 'limn/bmd-1', shas[1]!, dir)).toBe('need');
    expect((await sh('ls /w')).out).toBe('');
    await transferIntoStore(rt.repoStore!, owner, dir, join(reader, '.git'), shas[1]!);
    expect(await cloneFromStore(rt, sandbox, '/w/bng-metric-backend', 'limn/bmd-1', shas[1]!, dir)).toBe(shas[1]);
    const r = await sh('git rev-parse HEAD refs/limn/base; git branch --show-current; git remote; git status --porcelain | wc -l; ls .git/hooks 2>/dev/null | wc -l; cat src/app.js; git log --oneline | wc -l', '/w/bng-metric-backend');
    expect(r.out.split('\n')).toEqual([shas[1], shas[1], 'limn/bmd-1', '0', '0', 'console.log(2)', '1']); // `git remote` prints nothing
    // A commit comes back out as a patch against the base.
    const p = await sh('echo new > NEW.md && git add NEW.md && git commit -qm "Add NEW" && git format-patch --stdout refs/limn/base..limn/bmd-1 | grep -c "^+new$"', '/w/bng-metric-backend');
    expect(p.out).toBe('1');
    // The store checked every object on the way in, and never collects garbage.
    const cfg = await collect(rt.repoStore!.exec(owner, ['sh', '-c', `git --git-dir=/limn-store/${dir} config --get-regexp '^(fetch.fsckobjects|transfer.fsckobjects|gc.auto)$'`]));
    expect(String(cfg.stdout).trim().split('\n').sort()).toEqual(['fetch.fsckobjects true', 'gc.auto 0', 'transfer.fsckobjects true']);
  }, 120_000);

  it('the sandbox cannot write the store', async () => {
    const t = await sh(`touch /limn-store/x; git --git-dir=/limn-store/${dir} update-ref refs/heads/evil HEAD 2>&1; rm -rf /limn-store/${dir}/objects 2>&1; ls /limn-store/${dir}/objects | wc -l`);
    expect(t.err + t.out).toMatch(/Read-only file system/);
    expect(Number(t.out.split('\n').pop())).toBeGreaterThan(1);
    expect((await sh(`stat -c %U /limn-store/${dir}/HEAD`)).out).toBe('root');
  }, 60_000);

  it('a second base copies only what the store lacks', async () => {
    const had = await storeObjects();
    const kib = await storeKiB();
    await transferIntoStore(rt.repoStore!, owner, dir, join(reader, '.git'), shas[2]!);
    // "three" changed one file: a commit, the root tree, `src/`, one blob — plus at most the one delta
    // base `index-pack --fix-thin` copies in to complete a thin pack. Never the 400 KB blob again.
    expect((await storeObjects()) - had).toBeGreaterThanOrEqual(4);
    expect((await storeObjects()) - had).toBeLessThanOrEqual(5);
    expect((await storeKiB()) - kib).toBeLessThan(16);
    expect(await cloneFromStore(rt, sandbox, '/w/second', 'limn/bmd-2', shas[2]!, dir)).toBe(shas[2]);
    expect((await sh('cat src/app.js; git status --porcelain | wc -l', '/w/second')).out).toBe('console.log(3)\n0');
    // The same base again: nothing to copy.
    const after = await storeObjects();
    await transferIntoStore(rt.repoStore!, owner, dir, join(reader, '.git'), shas[2]!);
    expect(await storeObjects()).toBe(after);
  }, 120_000);

  it('never wrote the reader\'s clone, nor ran its hooks or fsmonitor', () => {
    expect(snapshot(reader)).toEqual(before);
    expect(git(['-c', 'core.fsmonitor=false', 'status', '--porcelain=v2', '--branch'], reader)).toBe(statusBefore);
    expect(git(['-c', 'core.fsmonitor=false', 'stash', 'list'], reader)).toMatch(/^stash@\{0\}/);
    expect(existsSync(join(scratch, 'ran'))).toBe(false);
  });
});
