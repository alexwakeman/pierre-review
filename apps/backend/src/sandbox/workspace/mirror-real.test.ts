// THE WORKSPACE MIRROR ON REAL GIT AND A REAL DAEMON (slow project; docs/SANDBOX.md § Testing).
//
//   1. Host side, real git: a shallow repository CANNOT be fetched from a blobless clone until the
//      base tree's blobs are in it (the measured reason `prepare` checks out a worktree first), and
//      can after.
//   2. Docker: `prepareSessionWorkspace` over the real runtime puts each repository at its MIRRORED path
//      on `limn/<key>` at the real base commit, with no remote, `refs/limn/base` set and a clean
//      status; the memories under the SAME project key; the seed at the root, outside every
//      repository; everything owned by the agent; and a commit comes back out as a patch.
//
// Skipped (with the reason) when no daemon answers. Resources carry `limn.test=1` and are removed.
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { projectKey } from '../../ai/session-litter.js';
import { createDockerRuntime } from '../runtime/docker.js';
import type { SandboxRuntime } from '../runtime/types.js';
import { prepareSessionWorkspace, sandboxMountsFor, sessionBranch } from './index.js';
import { planLayout } from './layout.js';
import { SANDBOX_BASE_REF, defaultMirrorSeams, shallowFromClone, type MirrorSeams, type RepoBaseRequest } from './mirror.js';
import type { ResolvedWorkspace } from './check.js';
import type { SessionTicket } from './ticket.js';

const git = (args: string[], cwd?: string): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();

let scratch = '';
/** owner/name → the blobless "clone cache" of a bare origin. */
const caches = new Map<string, { cache: string; sha: string }>();

function makeRepo(name: string, files: Record<string, string>): void {
  const src = join(scratch, 'src', name);
  mkdirSync(src, { recursive: true });
  git(['init', '-q', '-b', 'main', src]);
  for (const [i, extra] of ['first', 'second'].entries()) {
    for (const [f, text] of Object.entries(files)) {
      mkdirSync(join(src, f, '..'), { recursive: true });
      writeFileSync(join(src, f), `${text} ${extra}\n`);
    }
    git(['add', '-A'], src);
    git(['commit', '-qm', `commit ${i + 1}`], src);
  }
  const bare = join(scratch, 'origin', `${name}.git`);
  git(['clone', '-q', '--bare', src, bare]);
  git(['-C', bare, 'config', 'uploadpack.allowFilter', 'true']);
  const cache = join(scratch, 'clones', name);
  git(['clone', '-q', '--filter=blob:none', '--no-checkout', `file://${bare}`, cache]);
  caches.set(name, { cache, sha: git(['-C', cache, 'rev-parse', 'HEAD']) });
}

beforeAll(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'limn-mirror-real-')));
  makeRepo('bng-metric-backend', { 'package.json': '{"name":"backend"}', 'src/app.js': 'console.log(1)' });
  makeRepo('bng-metric-harness', { 'README.md': '# Harness', 'scripts/run.sh': 'echo' });
});

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// The production `prepare`, with the clone cache replaced by the scratch one: a worktree checkout
// hydrates the base tree (lazily, from the file origin), then the shallow repository.
const seams: MirrorSeams = {
  async prepare(req) {
    const { cache, sha } = caches.get(req.name)!;
    const wt = join(scratch, 'wt', `${req.name}-${randomBytes(3).toString('hex')}`);
    git(['-C', cache, 'worktree', 'add', '-q', '--detach', wt, sha]);
    try {
      return await shallowFromClone(cache, sha);
    } finally {
      git(['-C', cache, 'worktree', 'remove', '--force', wt]);
    }
  },
  tarGitDir: defaultMirrorSeams.tarGitDir,
};

describe('host side: a shallow repository from the blobless clone cache', () => {
  it('fails before the base tree is checked out, and works after', async () => {
    makeRepo('cold', { 'a.txt': 'a' });
    const { cache, sha } = caches.get('cold')!;
    await expect(shallowFromClone(cache, sha)).rejects.toThrow();
    const wt = join(scratch, 'wt', 'cold');
    git(['-C', cache, 'worktree', 'add', '-q', '--detach', wt, sha]);
    const s = await shallowFromClone(cache, sha);
    expect(git(['-C', s.dir, 'rev-parse', SANDBOX_BASE_REF])).toBe(sha);
    expect(git(['-C', s.dir, 'remote'])).toBe('');
    expect(git(['-C', s.dir, 'rev-list', '--count', sha])).toBe('1');
    await s.cleanup();
  }, 60_000);
});

const docker = process.env.SANDBOX_CLI || 'docker';
const probe = spawnSync(docker, ['info', '--format', '{{.OSType}}'], { encoding: 'utf8', timeout: 20_000 });
const daemon = probe.status === 0 && probe.stdout.trim() === 'linux';
if (!daemon) console.warn(`[mirror-real] Docker part SKIPPED: no Linux container daemon answers`);

describe.skipIf(!daemon)('the mirror in a real sandbox', () => {
  const instance = `test-${randomBytes(4).toString('hex')}`;
  const owner = { sessionId: `t${randomBytes(4).toString('hex')}`, accountId: 1 };
  const rt: SandboxRuntime = createDockerRuntime({ instance, extraLabels: { 'limn.test': '1' } });
  const FOLDER = '/Users/limn-test/Projects/DEFRA/bng-fe-be';
  let sandbox = '';
  const sh = async (cmd: string, cwd?: string): Promise<string> => {
    const r = await rt.run(sandbox, ['bash', '-c', cmd], { timeoutMs: 60_000, cwd });
    if (r.code !== 0) throw new Error(`${cmd}: ${r.stderr}`);
    return String(r.stdout).trim();
  };

  const repos = [
    { repoId: 1, owner: 'DEFRA', name: 'bng-metric-backend' },
    { repoId: 2, owner: 'DEFRA', name: 'bng-metric-harness' },
  ];
  const harness = `${FOLDER}/bng-metric-harness`;
  const key = projectKey(harness);

  beforeAll(async () => {
    const image = process.env.LIMN_SANDBOX_TEST_IMAGE ?? (await rt.ensureImage()).ref;
    const net = await rt.createNetwork(owner);
    const layout = planLayout({
      repos,
      folder: FOLDER,
      match: {
        matched: [{ repoId: 2, fullName: 'DEFRA/bng-metric-harness', localPath: harness, alsoAt: [] }],
        missing: [repos[0]!],
        outside: [{ fullName: 'DEFRA/cdp-app-config', localPath: `${FOLDER}/cdp-app-config` }],
      },
      memoryProjects: [{ dir: harness, key, memoryCount: 2 }],
    });
    const volume = await rt.createVolume(owner, 'ws');
    const { mounts, workdir } = sandboxMountsFor(layout, volume);
    sandbox = (
      await rt.startSandbox({ ...owner, image, network: net.name, env: {}, mounts, workdir, resources: { cpus: 1, memoryBytes: 1024 ** 3, pids: 256, diskBytes: 1024 ** 3 } })
    ).name;

    // The reader's Claude files, in a scratch Claude folder.
    const claudeDir = join(scratch, 'claude');
    mkdirSync(join(claudeDir, 'projects', key, 'memory'), { recursive: true });
    writeFileSync(join(claudeDir, 'projects', key, 'memory', 'MEMORY.md'), '- [Uploader](uploader.md)\n');
    writeFileSync(join(claudeDir, 'projects', key, 'memory', 'uploader.md'), 'cdp-uploader rejects viruses with 400.\n');
    writeFileSync(join(claudeDir, 'projects', key, 'transcript.jsonl'), '{"never":"copied"}\n');
    writeFileSync(join(claudeDir, 'CLAUDE.md'), '# Mine\n');
    const places = { home: '/nowhere', dataDir: '/nowhere/.limn', claude: { claudeDir, projectsDir: join(claudeDir, 'projects'), litter: [] } };

    const bases = new Map<number, RepoBaseRequest>(
      repos.map((r) => [r.repoId, { repoId: r.repoId, owner: r.owner, name: r.name, baseRef: 'main', baseSha: caches.get(r.name)!.sha, pinRef: `refs/pierre/story-build/1/${r.repoId}` }]),
    );
    const ticket: SessionTicket = {
      ident: 'jira:https://x.atlassian.net#BMD-1',
      key: 'BMD-1',
      title: 'Test',
      url: null,
      description: 'Do a thing.',
      acceptanceCriteriaText: '',
      criteria: [{ n: 1, text: 'The thing is done' }],
      criteriaSource: 'brief',
      openPoints: [],
      comments: null,
      prs: [],
      gaps: null,
      fresh: true,
      readAt: null,
    };
    const resolved = { folder: FOLDER, problem: null, match: null, scan: null, projects: [], layout } as ResolvedWorkspace;
    const prepared = await prepareSessionWorkspace(rt, sandbox, {
      resolved,
      places,
      bases,
      branch: sessionBranch('BMD-1'),
      ticket,
      mode: 'implement',
      userClaudeMd: true,
      userSkills: false,
      services: null,
      seams,
    });
    expect(prepared.mirror.failed).toEqual([]);
    expect(prepared.notes).toEqual(['Not in this workspace, left out: DEFRA/cdp-app-config.']);
  }, 20 * 60_000);

  afterAll(async () => {
    await rt.destroy(owner.sessionId);
    const left = await rt.sweep([], { dryRun: true });
    expect(left).toEqual({ containers: [], networks: [], volumes: [], images: [], errors: [] });
  }, 120_000);

  it('puts each repository at its mirrored path, on the branch, at the real base, with no remote', async () => {
    for (const r of repos) {
      const dir = `${FOLDER}/${r.name}`;
      expect(await sh('git rev-parse HEAD; git branch --show-current; git remote; git rev-parse refs/limn/base; git status --porcelain | wc -l', dir)).toBe(
        [caches.get(r.name)!.sha, 'BMD-1', caches.get(r.name)!.sha, '0'].join('\n'),
      );
    }
    expect(await sh(`cat ${FOLDER}/bng-metric-harness/README.md`)).toBe('# Harness second');
    expect(await sh(`stat -c %U ${FOLDER} ${FOLDER}/bng-metric-backend/src/app.js ${harness}`)).toBe('agent\nagent\nagent');
    expect(await sh(`ls ${FOLDER}/bng-metric-harness/.git/hooks 2>/dev/null | wc -l`)).toBe('0');
  }, 60_000);

  it('copies the memories under the same key (never a transcript) and the seed at the root', async () => {
    expect(await sh(`ls /home/agent/.claude/projects/${key}`)).toBe('memory');
    expect(await sh(`ls /home/agent/.claude/projects/${key}/memory`)).toBe('MEMORY.md\nuploader.md');
    expect(await sh('cat /home/agent/.claude/CLAUDE.md')).toBe('# Mine');
    expect(await sh(`ls ${FOLDER}`)).toBe('AGENTS.md\nCLAUDE.md\nTICKET.md\nbng-metric-backend\nbng-metric-harness');
    expect(await sh(`grep -c 'cdp-app-config' ${FOLDER}/CLAUDE.md`)).toBe('1');
  }, 60_000);

  it('gives a commit back as a patch against the base', async () => {
    await sh('echo "new" > NEW.md && git add NEW.md && git commit -qm "Add NEW" && git format-patch --stdout refs/limn/base..BMD-1 | grep -c "^+new$"', harness);
  }, 60_000);
});
