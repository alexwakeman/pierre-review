// A BUILD'S BASE COMMITS, PINNED (base-refs.ts) over a real git repository in a scratch clone root. Pinned:
//   1. one ref per (session, repository), `refs/pierre/story-build/<buildId>/<repoId>`, at the base sha;
//   2. the sweep deletes every ref its keep-list does not name, and KEEPS a ref it cannot parse;
//   3. only a 40-hex sha is ever written.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseStoryBuildBaseRef, pinStoryBuildBase, storyBuildBaseRef, sweepStoryBuildBaseRefs } from './base-refs.js';

let root = '';
let clone = '';
let sha = '';
const git = (...args: string[]): string => execFileSync('git', ['-C', clone, ...args], { encoding: 'utf8' }).trim();
const refs = (): string[] => git('for-each-ref', '--format=%(refname)', 'refs/pierre/').split('\n').filter(Boolean).sort();

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'pierre-sb-refs-'));
  clone = join(root, 'acme__web');
  mkdirSync(clone);
  execFileSync('git', ['init', '-q', clone]);
  writeFileSync(join(clone, 'a.txt'), 'a\n');
  git('add', 'a.txt');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'a');
  sha = git('rev-parse', 'HEAD');
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('base refs', () => {
  it('spells and parses one ref per (session, repository)', () => {
    expect(storyBuildBaseRef(12, 3)).toBe('refs/pierre/story-build/12/3');
    expect(parseStoryBuildBaseRef('refs/pierre/story-build/12/3')).toEqual({ buildId: 12, repoId: 3 });
    expect(parseStoryBuildBaseRef('refs/pierre/story-build/12')).toBeNull();
    expect(parseStoryBuildBaseRef('refs/pierre/story-plan-base')).toBeNull();
  });

  it('pins the sha; the sweep drops what the keep-list does not name and keeps what it cannot parse', async () => {
    await pinStoryBuildBase(clone, 1, 10, sha);
    await pinStoryBuildBase(clone, 2, 10, sha);
    await pinStoryBuildBase(clone, 2, 11, sha);
    await pinStoryBuildBase(clone, 3, 10, 'not-a-sha');
    git('update-ref', 'refs/pierre/story-build/odd', sha);
    expect(git('rev-parse', storyBuildBaseRef(1, 10))).toBe(sha);
    let asked: Array<{ buildId: number; repoId: number }> = [];
    const deleted = await sweepStoryBuildBaseRefs(async (r) => {
      asked = [...r];
      return new Set(['2/11']);
    }, root);
    expect(asked).toHaveLength(3);
    expect(deleted).toBe(2);
    expect(refs()).toEqual(['refs/pierre/story-build/2/11', 'refs/pierre/story-build/odd']);
  });
});
