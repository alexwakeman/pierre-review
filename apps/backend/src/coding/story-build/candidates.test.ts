// WHICH REPOSITORIES THE PLANNER READS (candidates.ts, the pure half; the DB half runs in routes-db.test.ts).
// Pinned:
//   1. code first: the ticket PRs' repositories in PR order, then their related ones; members only; capped;
//   2. the STACKING rule (owner decision 1): the reader's own open PR ⇒ base = its head branch at its head;
//      someone else's open PR ⇒ the default branch, said in one line; a merged PR changes nothing; the
//      reader's PR from a FORK (read live) is never stacked on;
//   3. the shortlist answer: only listed names (case-insensitive), deduplicated, capped; unreadable ⇒ null;
//      the prompt fences every repository text with the nonce.
import { describe, expect, it } from 'vitest';
import { STORY_BUILD_MAX_CANDIDATES } from '@pierre-review/shared';
import type { AgentContext } from '../../review/agent-context.js';
import { baseFor, codeCandidates, parseShortlist, shortlistPrompt, unstackablePrs, type WorkspaceRepoInfo } from './candidates.js';
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

describe('codeCandidates', () => {
  it('ticket repos in PR order, then related; members only; deduplicated', () => {
    const prs = [pr({ prId: 9, repoId: 3 }), pr({ prId: 2, repoId: 1 }), pr({ prId: 5, repoId: 3 })];
    const related = new Map([[1, [4, 3, 99]], [3, [2]]]);
    expect(codeCandidates(prs, related, new Set([1, 2, 3, 4]))).toEqual([
      { repoId: 1, source: 'ticket_pr' },
      { repoId: 3, source: 'ticket_pr' },
      { repoId: 4, source: 'related' },
      { repoId: 2, source: 'related' },
    ]);
  });

  it(`stops at ${STORY_BUILD_MAX_CANDIDATES}`, () => {
    const prs = Array.from({ length: 9 }, (_, i) => pr({ prId: i + 1, repoId: i + 1 }));
    expect(codeCandidates(prs, new Map(), new Set(prs.map((p) => p.repoId)))).toHaveLength(STORY_BUILD_MAX_CANDIDATES);
  });
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

const REPOS: WorkspaceRepoInfo[] = [
  { id: 1, owner: 'acme', name: 'web', description: 'The web app', defaultBranch: 'main', recentTitles: ['Add cart'], lastActivityMs: 2 },
  { id: 2, owner: 'acme', name: 'api', description: null, defaultBranch: 'main', recentTitles: [], lastActivityMs: 1 },
  { id: 3, owner: 'acme', name: 'infra', description: null, defaultBranch: 'main', recentTitles: [], lastActivityMs: 3 },
];

describe('the shortlist', () => {
  it('keeps only listed names, case-insensitively, deduplicated, capped', () => {
    expect(parseShortlist('Sure: {"repos": ["ACME/api", "acme/nope", "acme/api", "acme/web", "acme/infra"]}', REPOS, 2)).toEqual([2, 1]);
  });

  it('an unreadable answer is null (the caller asks once more)', () => {
    expect(parseShortlist('no json here', REPOS, 3)).toBeNull();
    expect(parseShortlist('{"repos": "acme/web"}', REPOS, 3)).toBeNull();
    expect(parseShortlist('{"repos": [}', REPOS, 3)).toBeNull();
  });

  it('fences the ticket and the repository texts', () => {
    const p = shortlistPrompt({ story: { key: 'ACME-1', title: 'Refunds', text: 'Refund by card' }, repos: REPOS, room: 4, nonce: 'n0nce' });
    expect(p).toContain('---BEGIN TICKET n0nce---\nACME-1: Refunds\n\nRefund by card\n---END TICKET n0nce---');
    expect(p).toMatch(/---BEGIN REPOSITORIES n0nce---\n- acme\/web\n {2}About: The web app\n {2}Recently merged: Add cart/);
    expect(p).toContain('Pick at most 4 repositories');
  });
});
