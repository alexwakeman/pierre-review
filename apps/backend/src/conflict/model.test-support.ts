// THE SHARED FIXTURES for the conflict-model suites (model.test.ts, model-history.test.ts).
// REAL TEMP REPOSITORIES, REAL GIT. The clone dir is injected and `token: null`, so nothing
// here touches GitHub or the database — but merge-tree, cat-file and merge-file are the
// genuine articles, because the whole feature is a claim about what git does.
//
// One file of ~40 real-git cases ran in ONE worker and was the second-longest file in the
// backend run; split in two the halves run side by side. See docs/TESTING.md.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll } from 'vitest';
import { config } from '../config.js';
import { buildConflictModelInClone } from './model.js';
import type { ConflictModel, ConflictModelFile } from './model-types.js';

export const CLEAN_ENV = {
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

export class Repo {
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
export function threeWayRepo(
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

export async function build(
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
export async function ready(repo: Repo, headSha: string, baseSha: string): Promise<ConflictModel> {
  const res = await build(repo, headSha, baseSha);
  if (res.status !== 'ready') {
    throw new Error(`expected a ready model, got ${res.status}`);
  }
  return res.model;
}

/** `config` is declared `as const`, so its TYPE is readonly while the object itself is a
 *  plain mutable one. Narrowing a cap for one test and restoring it in a `finally` is how a
 *  boundary gets exercised without generating a half-megabyte fixture. */
export const caps = config as { -readonly [K in keyof typeof config]: (typeof config)[K] };

export function fileNamed(model: ConflictModel, path: string): ConflictModelFile {
  const f = model.files.find((x) => x.path === path);
  if (!f) throw new Error(`no file ${path} in [${model.files.map((x) => x.path).join(', ')}]`);
  return f;
}
