import { describe, expect, it } from 'vitest';
import type { TimelinePr } from '@pierre-review/shared';
import { hasNewSinceLastViewed, newActivityWords, repoStatusSummary } from '@pierre-review/shared';

// The repo status fold (packages/shared/src/repo-status.ts): the sidebar repo row's red and blue
// dots and the status panel at the top of the repo view. One fold, so the two can never disagree.

let nextId = 1;
function pr(over: Partial<TimelinePr> = {}): TimelinePr {
  const id = nextId++;
  return {
    id,
    repoId: 1,
    number: 100 + id,
    title: `PR ${id}`,
    authorId: 2,
    state: 'open',
    isDraft: false,
    ciStatus: 'success',
    mergeable: 'mergeable',
    mergeStateStatus: 'clean',
    reviewRequestedFromMe: false,
    newSinceLastViewed: null,
    ...over,
  } as TimelinePr;
}

describe('repoStatusSummary', () => {
  it('a quiet repo has no lines and neither dot', () => {
    const s = repoStatusSummary({ prs: [pr(), pr({ newSinceLastViewed: { comments: 0, reviews: 0, commits: 0 } })] }, null);
    expect(s.lines).toEqual([]);
    expect(s.attention).toBe(false);
    expect(s.hasNew).toBe(false);
    expect(s.attentionWords).toBeNull();
    expect(s.newWords).toBeNull();
  });

  it('an all-zero newSinceLastViewed (a PR you opened, nothing since) is NOT new', () => {
    expect(hasNewSinceLastViewed({ comments: 0, reviews: 0, commits: 0 })).toBe(false);
    expect(hasNewSinceLastViewed(null)).toBe(false);
    expect(hasNewSinceLastViewed({ comments: 0, reviews: 1, commits: 0 })).toBe(true);
  });

  it('red lines come in a fixed order: your review, the default branch, CI, conflicts', () => {
    const s = repoStatusSummary(
      {
        prs: [
          pr({ mergeable: 'conflicting' }),
          pr({ ciStatus: 'failure' }),
          pr({ ciStatus: 'error' }),
          pr({ reviewRequestedFromMe: true }),
        ],
      },
      { branchName: 'main', ciStatus: 'failure' },
    );
    expect(s.lines.map((l) => l.kind)).toEqual(['review_requested', 'trunk_failing', 'ci_failing', 'conflicts']);
    expect(s.lines.map((l) => l.text)).toEqual([
      '1 pull request is waiting for your review',
      'main is failing CI',
      '2 pull requests are failing CI',
      '1 pull request has merge conflicts',
    ]);
    expect(s.attention).toBe(true);
    expect(s.hasNew).toBe(false);
    expect(s.attentionWords).toBe(
      'Needs attention: 1 pull request is waiting for your review; main is failing CI; 2 pull requests are failing CI; 1 pull request has merge conflicts',
    );
    expect(s.lines.find((l) => l.kind === 'trunk_failing')?.prs).toEqual([]);
  });

  it('drafts do not count for CI, conflicts or review requests; closed PRs count for nothing', () => {
    const s = repoStatusSummary(
      {
        prs: [
          pr({ isDraft: true, ciStatus: 'failure', mergeStateStatus: 'dirty', reviewRequestedFromMe: true }),
          pr({ state: 'merged', ciStatus: 'failure' }),
        ],
      },
      { branchName: 'main', ciStatus: 'success' },
    );
    expect(s.lines).toEqual([]);
  });

  it('a default branch with no name, or not failing, adds no line', () => {
    expect(repoStatusSummary({ prs: [] }, { branchName: null, ciStatus: 'failure' }).lines).toEqual([]);
    expect(repoStatusSummary({ prs: [] }, { branchName: 'main', ciStatus: 'pending' }).lines).toEqual([]);
  });

  it('the blue line spells out what is new, per PR, with when you last opened it', () => {
    const a = pr({ number: 7, newSinceLastViewed: { comments: 1, reviews: 0, commits: 0 } });
    const b = pr({ number: 8, isDraft: true, newSinceLastViewed: { comments: 2, reviews: 1, commits: 3 } });
    const s = repoStatusSummary(
      { prs: [a, b], unreadPrs: [{ prId: b.id, lastViewedAt: '2026-10-30T10:00:00.000Z' }] },
      null,
    );
    expect(s.attention).toBe(false);
    expect(s.hasNew).toBe(true);
    expect(s.lines).toHaveLength(1);
    const line = s.lines[0]!;
    expect(line.tone).toBe('new');
    expect(line.text).toBe('3 comments, 1 review and 3 commits on 2 pull requests since you last opened them');
    expect(s.newWords).toBe('New: 3 comments, 1 review and 3 commits on 2 pull requests since you last opened them');
    // Most new first; a draft's new activity still counts (it is a conversation).
    expect(line.prs.map((p) => [p.number, p.detail, p.since])).toEqual([
      [8, '2 comments, 1 review and 3 commits', '2026-10-30T10:00:00.000Z'],
      [7, '1 comment', null],
    ]);
  });

  it('copes with an answer cached before unreadPrs existed', () => {
    const s = repoStatusSummary({ prs: [pr({ newSinceLastViewed: { comments: 0, reviews: 0, commits: 1 } })] }, null);
    expect(s.lines[0]?.text).toBe('1 commit on 1 pull request since you last opened it');
    expect(s.lines[0]?.prs[0]?.since).toBeNull();
  });

  it('red lines come before the blue one', () => {
    const s = repoStatusSummary(
      { prs: [pr({ ciStatus: 'failure', newSinceLastViewed: { comments: 1, reviews: 0, commits: 0 } })] },
      null,
    );
    expect(s.lines.map((l) => l.tone)).toEqual(['attention', 'new']);
  });
});

describe('newActivityWords', () => {
  it('joins the non-zero parts in plain English', () => {
    expect(newActivityWords({ comments: 0, reviews: 0, commits: 0 })).toBe('');
    expect(newActivityWords({ comments: 1, reviews: 0, commits: 0 })).toBe('1 comment');
    expect(newActivityWords({ comments: 2, reviews: 0, commits: 1 })).toBe('2 comments and 1 commit');
  });
});
