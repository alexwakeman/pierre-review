// WHICH REPOSITORIES THE PLANNER READS (candidates.ts, the pure half; the DB half runs in routes-db.test.ts).
// Pinned:
//   1. code first: the ticket PRs' repositories in PR order, then their related ones; members only; capped;
//   2. the STACKING rule (owner decision 1): the reader's own open PR ⇒ base = its head branch at its head;
//      someone else's open PR ⇒ the default branch, said in one line; a merged PR changes nothing;
//   3. the shortlist answer: only listed names (case-insensitive), deduplicated, capped; unreadable ⇒ null;
//      the prompt fences every repository text with the nonce.
import { describe, expect, it } from 'vitest';
import { STORY_BUILD_MAX_CANDIDATES } from '@pierre-review/shared';
import { baseFor, codeCandidates, parseShortlist, shortlistPrompt, type WorkspaceRepoInfo } from './candidates.js';
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
