// Related repos (docs/CLAUDE-REVIEW.md § Related repos): the symmetric read of the stored pairs, and
// the "Also read" label of each peer kind.
import { describe, expect, it } from 'vitest';
import { reviewPeerReadLabel } from '@pierre-review/shared';
import { relatedTo } from '../src/hooks/useRelatedRepos.js';

describe('relatedTo', () => {
  it('reads a pair from either side', () => {
    const pairs = [
      { repoId: 1, relatedRepoId: 2 },
      { repoId: 2, relatedRepoId: 5 },
      { repoId: 3, relatedRepoId: 4 },
    ];
    expect(relatedTo(pairs, 2)).toEqual([1, 5]);
    expect(relatedTo(pairs, 4)).toEqual([3]);
    expect(relatedTo(pairs, 9)).toEqual([]);
  });
});

describe('reviewPeerReadLabel', () => {
  it('names a PR by number, a branch by name, and says when it is the default branch', () => {
    expect(reviewPeerReadLabel({ repoFullName: 'acme/api', kind: 'pr', source: 'related_repo', number: 21, branch: 'x' })).toBe('acme/api#21');
    expect(
      reviewPeerReadLabel({ repoFullName: 'DEFRA/bng-metric-backend', kind: 'branch', source: 'related_repo', number: null, branch: 'bmd-1048-created-area-edit' }),
    ).toBe('DEFRA/bng-metric-backend @ bmd-1048-created-area-edit');
    expect(reviewPeerReadLabel({ repoFullName: 'acme/sdk', kind: 'default_branch', source: 'related_repo', number: null, branch: 'main' })).toBe(
      'acme/sdk @ main (default branch)',
    );
    expect(reviewPeerReadLabel({ repoFullName: 'acme/sdk', kind: 'default_branch', source: 'related_repo', number: null, branch: null })).toBe(
      'acme/sdk (default branch)',
    );
  });
});
