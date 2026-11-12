// THE REVIEW LOOP'S PROMPT (docs/CLAUDE-REVIEW.md § Reviewing a branch): `buildUserPrompt` with
// `subject: {kind: 'branch'}` reviews a BRANCH with no pull request inside Limn, and its earlier findings'
// "replies" are the BUILD AGENT's answers. Pinned:
//   1. without `subject` every PR prompt is byte-identical (prompt-golden.json, here and in prompts.test.ts);
//   2. with it, the whole prompt is pinned by its OWN golden (__fixtures__/prompt-golden-branch.json, so the
//      PR goldens never move): the header, "What the branch is for", the follow-up wording, the answers;
//   3. nothing in a branch prompt says GitHub posted, replied or "Not posted to GitHub yet".
//   Regenerate the branch golden with PROMPT_GOLDEN_BRANCH_WRITE=1.
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildUserPrompt } from './prompts.js';
import { selectPriorFindings, type PriorFindingForFollowUp } from './follow-up.js';

const GOLDEN_URL = new URL('./__fixtures__/prompt-golden-branch.json', import.meta.url);
const prGolden = JSON.parse(readFileSync(new URL('./__fixtures__/prompt-golden.json', import.meta.url), 'utf8')) as Record<string, string>;

const HEAD = 'b'.repeat(40);
const PRIOR_HEAD = 'a'.repeat(40);
const NONCE = '0123456789abcdef';

const base = {
  repoFullName: 'acme/api',
  prNumber: 42,
  title: 'Add password reset',
  body: 'Adds a reset link.\n\nSee ticket.',
  headSha: HEAD,
  baseRef: 'main',
  changedFiles: ['src/reset.ts', 'src/mail.ts'],
  excludedFiles: ['pnpm-lock.yaml'],
  diff: 'diff --git a/src/reset.ts b/src/reset.ts\n@@ -1,1 +1,2 @@\n a\n+b',
};

function prior(over: Partial<PriorFindingForFollowUp> = {}): PriorFindingForFollowUp {
  return {
    id: 1,
    headSha: PRIOR_HEAD,
    path: 'src/reset.ts',
    line: 12,
    side: 'RIGHT',
    severity: 'warning',
    title: 'Token is never expired',
    body: 'The reset token has no expiry.',
    suggestion: null,
    diffHunk: null,
    anchored: true,
    fileInDiff: true,
    posted: true,
    carried: false,
    ...over,
  };
}

function branchPrompt(): string {
  const plan = selectPriorFindings(
    {
      reviewId: 3,
      headSha: PRIOR_HEAD,
      findings: [
        prior({
          thread: { threadId: 0, threadFindingId: 1, replies: [{ author: 'build agent', body: 'I did not change this: the token expires with the session.', at: '2026-11-12T10:00:00.000Z' }], pushedBack: false },
        }),
        prior({ id: 2, severity: 'nit', title: 'Name the constant', body: 'Name the 3600.', line: 20, raisedBy: 'codex' }),
      ],
    },
    HEAD,
  );
  return buildUserPrompt({ ...base, prNumber: 0, mode: 'worktree', followUp: { plan, since: null }, nonce: NONCE, subject: { kind: 'branch', branch: 'PAY-142' } });
}

describe('buildUserPrompt — a branch with no pull request (the review loop)', () => {
  it('leaves every PR prompt byte-identical when `subject` is absent or null', () => {
    expect(buildUserPrompt({ ...base, mode: 'diff_only' })).toBe(prGolden.diffOnly);
    expect(buildUserPrompt({ ...base, mode: 'diff_only', subject: null })).toBe(prGolden.diffOnly);
  });

  it('is pinned by its own golden', () => {
    const p = branchPrompt();
    if (process.env.PROMPT_GOLDEN_BRANCH_WRITE === '1') writeFileSync(GOLDEN_URL, `${JSON.stringify({ branchFollowUp: p }, null, 2)}\n`);
    const golden = JSON.parse(readFileSync(GOLDEN_URL, 'utf8')) as { branchFollowUp: string };
    expect(p).toBe(golden.branchFollowUp);
  });

  it('names the branch, says what the branch is for, and reads the build agent\'s answers', () => {
    const p = branchPrompt();
    expect(p.startsWith('# Reviewing acme/api branch PAY-142 (no pull request yet)\n')).toBe(true);
    expect(p).toContain('## What the branch is for');
    expect(p).not.toContain('## PR description');
    expect(p).toContain('An earlier review of this branch');
    expect(p).toContain('"The build agent\'s answers"');
    expect(p).toContain("The build agent's answers (oldest first):\nbuild agent:\nI did not change this:");
    expect(p).not.toContain('Replies on GitHub');
    expect(p).not.toContain('Not posted to GitHub yet');
    expect(p).not.toContain('posted the findings below as comments');
  });
});
