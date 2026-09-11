import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BRANCH_NAME_PATTERN,
  branchNameMessage,
  checkBranchName,
  type BranchNameContext,
} from '../src/lib/branchName.js';

const CTX: BranchNameContext = {
  headRef: 'feature/resolver',
  baseRef: 'develop',
  reserved: ['main', 'develop'],
};

describe('checkBranchName', () => {
  it('accepts a plain new branch name', () => {
    expect(checkBranchName('fix/conflicts-1', CTX)).toBeNull();
    expect(checkBranchName('  fix/conflicts-1  ', CTX)).toBeNull();
  });

  it('refuses an empty name', () => {
    expect(checkBranchName('', CTX)).toBe('empty');
    expect(checkBranchName('   ', CTX)).toBe('empty');
    expect(branchNameMessage('empty', CTX)).toBe('Name the branch.');
  });

  it('refuses a name the convention does not allow', () => {
    // Every one of these is a REAL GitHub branch that this convention refuses, which is correct
    // here (we are inventing the name) and wrong in a push guard (someone else chose theirs).
    for (const bad of ['-evil', 'feature/#123', "user's-branch", 'a+b', 'ünicode/x', 'a..b', '/x']) {
      expect(checkBranchName(bad, CTX), bad).toBe('malformed');
    }
    expect(branchNameMessage('malformed', CTX)).toBe(
      'Branch names start with a letter or digit and can use letters, digits, . _ / and -.',
    );
  });

  it('refuses the PR’s own branch, by name, pointing at the other option', () => {
    expect(checkBranchName('feature/resolver', CTX)).toBe('pr_branch');
    expect(branchNameMessage('pr_branch', CTX)).toBe(
      'That’s this PR’s branch — use “Push to feature/resolver” instead.',
    );
  });

  it('refuses the PR’s base branch', () => {
    expect(checkBranchName('develop', CTX)).toBe('base_branch');
    expect(branchNameMessage('base_branch', CTX)).toBe(
      'That’s this PR’s base branch. Pick another name.',
    );
  });

  it('refuses the repo default branch', () => {
    expect(checkBranchName('main', CTX)).toBe('default_branch');
    expect(branchNameMessage('default_branch', CTX)).toBe(
      'That’s the default branch. Pick another name.',
    );
  });

  it('compares reserved names case-insensitively, like the push guard does', () => {
    // `assertPushTarget` folds case on `protect`; a client check that did not would offer `Main`
    // as a new branch and then watch the server refuse it.
    expect(checkBranchName('Main', CTX)).toBe('default_branch');
    expect(checkBranchName('DEVELOP', CTX)).toBe('base_branch');
    expect(checkBranchName('Feature/Resolver', CTX)).toBe('pr_branch');
  });

  it('names the base branch when it is also the repo default', () => {
    // The more specific truth wins: it is the branch this pull request is merging INTO, which is
    // the fact visible on this screen.
    expect(checkBranchName('main', { ...CTX, baseRef: 'main' })).toBe('base_branch');
  });
});

describe('the mirrored pattern', () => {
  // ⚠ THE GUARD THAT MATTERS. A mirror that has drifted is worse than no mirror: it refuses names
  // the server would take and takes names the server will refuse. If this fails, the backend
  // convention moved and `lib/branchName.ts` has to move with it — do not "fix" the test.
  it('is byte-identical to the one in coding/git-ops.ts', () => {
    const source = readFileSync(
      new URL('../../backend/src/coding/git-ops.ts', import.meta.url).pathname,
      'utf8',
    );
    const match = /if \(!(\/.+?\/)\.test\(branch\)/.exec(source);
    expect(match, 'the branch-name check in git-ops.ts moved or was rewritten').not.toBeNull();
    expect(match?.[1]).toBe(`/${BRANCH_NAME_PATTERN.source}/`);
    // The `..` clause is a second test there and a second test here, for the same reason.
    expect(source).toContain("branch.includes('..')");
  });
});
