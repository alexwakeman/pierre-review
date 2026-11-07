// THE BASE OF EACH REPOSITORY (candidates.ts). Pinned: the STACKING rule (owner decision 1): the
// reader's own open PR ⇒ base = its head branch at its head; someone else's open PR ⇒ the default branch,
// said in one line; a merged PR changes nothing; the reader's PR from a FORK (read live) is never
// stacked on.
import { describe, expect, it } from 'vitest';
import type { AgentContext } from '../../review/agent-context.js';
import { baseFor, unstackablePrs } from './candidates.js';
import type { StoryBuildTicketPr } from './inputs.js';

const pr = (o: Partial<StoryBuildTicketPr>): StoryBuildTicketPr => ({
  prId: 1,
  repoId: 1,
  number: 1,
  title: 't',
  headSha: 'h1',
  state: 'open',
  headRefName: 'feat/x',
  byReader: false,
  ...o,
});

describe('baseFor — owner decision 1', () => {
  const repo = { id: 1, defaultBranch: 'main' };

  it("stacks on the reader's own open PR (the newest)", () => {
    const b = baseFor(repo, [pr({ prId: 7, number: 12, byReader: true, headRefName: 'feat/a', headSha: 'aaa' }), pr({ prId: 8, number: 15, byReader: true, headRefName: 'feat/b', headSha: 'bbb' })]);
    expect(b).toEqual({ baseRef: 'feat/b', baseSha: 'bbb', stackedOnPrId: 8, stackedOnPrNumber: 15, baseNote: 'Builds on your open PR #15; the new PR targets its branch.' });
  });

  it("someone else's open PR: the default branch, said in one line", () => {
    const b = baseFor(repo, [pr({ number: 12, byReader: false })]);
    expect(b).toEqual({ baseRef: 'main', baseSha: '', stackedOnPrId: null, stackedOnPrNumber: null, baseNote: "#12 on this ticket is someone else's, so this builds from main." });
  });

  it('a merged PR, another repo, or no head branch: the default branch, nothing to say', () => {
    expect(baseFor(repo, [pr({ state: 'merged', byReader: true })]).baseNote).toBeNull();
    expect(baseFor(repo, [pr({ repoId: 2, byReader: true })]).stackedOnPrId).toBeNull();
    expect(baseFor({ id: 1, defaultBranch: null }, [pr({ byReader: true, headRefName: null })])).toMatchObject({ baseRef: 'HEAD', stackedOnPrId: null });
  });

  it("the reader's PR from a FORK is never stacked on: the default branch, said in one line", () => {
    const prs = [pr({ prId: 8, number: 15, byReader: true, headRefName: 'feat/b', headSha: 'bbb' })];
    expect(baseFor(repo, prs, new Map([[8, 'fork']]))).toEqual({
      baseRef: 'main',
      baseSha: '',
      stackedOnPrId: null,
      stackedOnPrNumber: null,
      baseNote: 'Your #15 is from a fork, so this builds from main.',
    });
    expect(baseFor(repo, prs, new Map([[8, 'unknown']])).baseNote).toBe("Couldn't check your #15 on GitHub, so this builds from main.");
  });
});

describe('unstackablePrs — one live read per stacked PR', () => {
  const repo = { id: 1, owner: 'acme', name: 'web', defaultBranch: 'main' };
  const ctxWith = (forks: Record<number, boolean | 'throw'>, calls: number[]): AgentContext =>
    ({
      log: { warn: () => {} },
      github: {
        fetchPrHeadInfo: async (_acc: number, _o: string, _n: string, number: number) => {
          calls.push(number);
          if (forks[number] === 'throw') throw new Error('502');
          return { headSha: 'x', headRef: 'r', headRepoFullName: 'x/y', isFork: forks[number] === true, maintainerCanModify: false, baseRef: 'main' };
        },
      },
    }) as unknown as AgentContext;

  it('a fork falls through to the next own PR; a same-repo PR is stacked on', async () => {
    const prs = [
      pr({ prId: 7, number: 12, byReader: true, headRefName: 'feat/a', headSha: 'aaa' }),
      pr({ prId: 8, number: 15, byReader: true, headRefName: 'feat/b', headSha: 'bbb' }),
    ];
    const calls: number[] = [];
    const out = await unstackablePrs(ctxWith({ 15: true, 12: false }, calls), 1, [repo], prs);
    expect([...out]).toEqual([[8, 'fork']]);
    expect(calls).toEqual([15, 12]);
    expect(baseFor(repo, prs, out)).toMatchObject({ stackedOnPrNumber: 12, baseRef: 'feat/a' });
  });

  it('a failed read is the default branch; nothing stacked ⇒ no read at all', async () => {
    const calls: number[] = [];
    const prs = [pr({ prId: 8, number: 15, byReader: true })];
    expect([...(await unstackablePrs(ctxWith({ 15: 'throw' }, calls), 1, [repo], prs))]).toEqual([[8, 'unknown']]);
    const none: number[] = [];
    expect((await unstackablePrs(ctxWith({}, none), 1, [repo], [pr({ byReader: false })])).size).toBe(0);
    expect(none).toEqual([]);
  });
});
