// THE ONE AUTO-POSTED REVIEW ROUTES QUESTIONS LIKE ANY OTHER FINDING (post-seam.ts `postReview`,
// GitHub stubbed): a question anchored on an added line goes INLINE on it; one whose line is not in
// the diff but whose file is goes on the file's first change WITH the fallback note; one on a file
// outside the diff falls back to a PR comment. Every body keeps the footer + marker.
//
//   pnpm --filter @pierre-review/backend test review/post-seam
import { describe, expect, it, vi } from 'vitest';
import { AUTO_POST_FOOTER } from '@pierre-review/shared';

const DIFF = [
  'diff --git a/src/foo.ts b/src/foo.ts',
  'index 1111111..2222222 100644',
  '--- a/src/foo.ts',
  '+++ b/src/foo.ts',
  '@@ -10,3 +10,4 @@',
  ' const a = 1;',
  '+const added = 2;',
  '-const removed = 3;',
  ' const b = 4;',
].join('\n');

const submitGithubReview = vi.fn(async (_a: unknown) => ({ reviewId: 'R9' }));
const submitGithubIssueComment = vi.fn(async (_a: unknown) => ({ commentId: 'IC1' }));
type Got = Array<{ id: number; path: string; line: number | null; side?: 'LEFT' | 'RIGHT' | null; body: string }>;
const fetchReviewComments = vi.fn(async (..._a: unknown[]): Promise<Got> => []);
type Listed = Array<{ id: number; commit_id: string | null; body: string | null; state: string; submitted_at?: string | null }>;
const fetchPrReviews = vi.fn(async (..._a: unknown[]): Promise<Listed> => []);
vi.mock('./post-review.js', async (orig) => ({
  ...(await orig<typeof import('./post-review.js')>()),
  fetchCurrentHeadSha: vi.fn(async () => 'HEAD'),
  fetchPrDiff: vi.fn(async () => DIFF),
  submitGithubReview: (a: unknown) => submitGithubReview(a),
  submitGithubIssueComment: (a: unknown) => submitGithubIssueComment(a),
  fetchReviewComments: (...a: unknown[]) => fetchReviewComments(...a),
  fetchPrReviews: (...a: unknown[]) => fetchPrReviews(...a),
}));

const q = (id: number, path: string, line: number | null) => ({
  id,
  path,
  line,
  side: 'RIGHT' as const,
  anchored: true,
  fileInDiff: true,
  body: `Question ${id}?`,
  suggestion: null,
  storyLead: null,
  footer: AUTO_POST_FOOTER,
});

describe('questions in the one auto review', () => {
  it('inline on their line, else the file’s first change with a note, else a PR comment', async () => {
    const { postReview } = await import('./post-seam.js');
    const { FINDING_COMMENT_MARKER, FALLBACK_ANCHOR_NOTE } = await import('./post-review.js');
    const out = await postReview({
      owner: 'acme',
      name: 'api',
      prNumber: 1,
      reviewHeadSha: 'HEAD',
      body: 'Lead.',
      verdict: 'COMMENT',
      includedFindings: [q(1, 'src/foo.ts', 11), q(2, 'src/foo.ts', 400), q(3, 'src/other.ts', 5)],
      dryRun: false,
    });
    expect(out).toMatchObject({ postedReviewId: 'R9', inlineFindingIds: [1, 2], prComments: [{ findingId: 3, commentId: 'IC1' }] });
    const sent = submitGithubReview.mock.calls[0]![0] as { event: string; comments: Array<{ path: string; line: number; body: string }> };
    expect(sent.event).toBe('COMMENT');
    expect(sent.comments.map((c) => [c.path, c.line])).toEqual([
      ['src/foo.ts', 11],
      ['src/foo.ts', 11],
    ]);
    expect(sent.comments[0]!.body).not.toContain(FALLBACK_ANCHOR_NOTE);
    expect(sent.comments[1]!.body).toContain(FALLBACK_ANCHOR_NOTE);
    const pc = submitGithubIssueComment.mock.calls[0]![0] as { body: string };
    expect(pc.body).toContain('Question 3?');
    for (const b of [...sent.comments.map((c) => c.body), pc.body]) {
      expect(b.endsWith(`${AUTO_POST_FOOTER}\n\n${FINDING_COMMENT_MARKER}`)).toBe(true);
    }
  });
});

describe('a Claude + Codex pair’s comments', () => {
  it('name who raised them on the ONE severity lead, inline and PR-level alike', async () => {
    submitGithubReview.mockClear();
    submitGithubIssueComment.mockClear();
    const { postReview } = await import('./post-seam.js');
    await postReview({
      owner: 'acme',
      name: 'api',
      prNumber: 1,
      reviewHeadSha: 'HEAD',
      body: 'Lead.',
      verdict: 'COMMENT',
      includedFindings: [
        { ...q(1, 'src/foo.ts', 11), severity: 'warning', severityTag: 'Codex' },
        { ...q(3, 'src/other.ts', 5), severity: 'nit', severityTag: 'Claude' },
      ],
      dryRun: false,
    });
    const sent = submitGithubReview.mock.calls[0]![0] as { comments: Array<{ body: string }> };
    expect(sent.comments[0]!.body.split('\n')[0]).toBe('**Warning** · Codex');
    const pc = submitGithubIssueComment.mock.calls[0]![0] as { body: string };
    expect(pc.body.split('\n')[0]).toBe('**Nit** · Claude · `src/other.ts:5`');
  });
});

describe('the review’s inline comment ids are read back', () => {
  const args = (ids: number[]) => ({
    owner: 'acme',
    name: 'api',
    prNumber: 1,
    reviewHeadSha: 'HEAD',
    body: 'Lead.',
    verdict: 'COMMENT' as const,
    includedFindings: ids.map((id) => q(id, 'src/foo.ts', 11)),
    dryRun: false,
  });

  it('pairs each finding with the comment GitHub created for it', async () => {
    const { postReview } = await import('./post-seam.js');
    submitGithubReview.mockClear();
    fetchReviewComments.mockImplementationOnce(async () => {
      const sent = (submitGithubReview.mock.calls[0]![0] as { comments: Array<{ path: string; line: number; body: string }> }).comments;
      // GitHub answers out of order, with CRLF line endings.
      return [
        { id: 502, path: sent[1]!.path, line: sent[1]!.line, side: 'RIGHT', body: sent[1]!.body.replace(/\n/g, '\r\n') },
        { id: 501, path: sent[0]!.path, line: sent[0]!.line, side: 'RIGHT', body: sent[0]!.body },
      ];
    });
    const out = await postReview(args([7, 8]));
    expect(fetchReviewComments.mock.calls.at(-1)).toEqual(['acme', 'api', 1, 'R9']);
    expect(out).toMatchObject({
      postedReviewId: 'R9',
      inlineFindingIds: [7, 8],
      inlineComments: [
        { findingId: 7, commentId: '501' },
        { findingId: 8, commentId: '502' },
      ],
    });
  });

  it('⚠ a failed read never fails the post', async () => {
    const { postReview } = await import('./post-seam.js');
    fetchReviewComments.mockRejectedValueOnce(new Error('GitHub REST GET -> 502'));
    const before = fetchReviewComments.mock.calls.length;
    const out = await postReview(args([7]));
    expect(out).toMatchObject({ postedReviewId: 'R9', inlineFindingIds: [7], inlineComments: [] });
    // Read once, never retried.
    expect(fetchReviewComments.mock.calls.length - before).toBe(1);
  });
});

// ⚠ GitHub answered a review POST with 422 "An internal error occurred" AND published the review
// (PR 4 of DEFRA/bng-metric-template, 2026-10-14) — the run was recorded failed and the reader posted
// the same comment again. The seam now looks before it calls it a failure.
describe('a failed review POST that landed anyway', () => {
  const args = {
    owner: 'acme',
    name: 'api',
    prNumber: 1,
    reviewHeadSha: 'HEAD',
    body: 'Lead.',
    verdict: 'COMMENT' as const,
    includedFindings: [q(7, 'src/foo.ts', 11)],
    dryRun: false,
  };
  const internalError = () =>
    Object.assign(new Error('GitHub REST POST /repos/acme/api/pulls/1/reviews -> 422: An internal error occurred, please try again.'), { status: 422 });

  it('is found by commit + exact body and carries on as a success', async () => {
    const seam = await import('./post-seam.js');
    seam.LANDED_READBACK_DELAYS_MS.splice(0, Infinity, 0, 0);
    let sent = '';
    submitGithubReview.mockImplementationOnce(async (a: unknown) => {
      sent = (a as { body: string }).body;
      throw internalError();
    });
    fetchPrReviews.mockImplementationOnce(async () => [
      // Decoys: an older identical one, another commit, another body, and an EARLIER review with the
      // same lead on this head inside the clock-skew window (another attempt: another nonce).
      { id: 10, commit_id: 'HEAD', body: sent, state: 'COMMENTED', submitted_at: '2020-01-01T00:00:00Z' },
      { id: 11, commit_id: 'OLD', body: sent, state: 'COMMENTED', submitted_at: new Date().toISOString() },
      { id: 12, commit_id: 'HEAD', body: 'Other.', state: 'COMMENTED', submitted_at: new Date().toISOString() },
      { id: 13, commit_id: 'HEAD', body: sent.replace(/\n/g, '\r\n'), state: 'COMMENTED', submitted_at: new Date().toISOString() },
      { id: 14, commit_id: 'HEAD', body: 'Lead.\n\n<!-- pierre:claude-review v=1 a=000000000000 -->', state: 'COMMENTED', submitted_at: new Date().toISOString() },
    ]);
    fetchReviewComments.mockImplementationOnce(async () => [{ id: 600, path: 'src/foo.ts', line: 11, side: 'RIGHT', body: '' }]);
    const out = await seam.postReview(args);
    expect(sent).toMatch(/^Lead\.\n\n<!-- pierre:claude-review v=1 a=[0-9a-f]{12} -->$/);
    expect(out).toMatchObject({ postedReviewId: '13', inlineFindingIds: [7] });
    expect(fetchReviewComments.mock.calls.at(-1)).toEqual(['acme', 'api', 1, '13']);
  });

  it('⚠ an earlier review with the same body on this head is NEVER adopted (the nonce differs)', async () => {
    const seam = await import('./post-seam.js');
    seam.LANDED_READBACK_DELAYS_MS.splice(0, Infinity, 0, 0);
    submitGithubReview.mockImplementation(async () => {
      throw internalError();
    });
    fetchPrReviews.mockImplementation(async () => [
      // A summary-less review posted 30s earlier: before the nonce, the bare marker matched.
      { id: 7, commit_id: 'HEAD', body: 'Lead.\n\n<!-- pierre:claude-review v=1 a=aaaaaaaaaaaa -->', state: 'COMMENTED', submitted_at: new Date(Date.now() - 30_000).toISOString() },
      { id: 8, commit_id: 'HEAD', body: 'Lead.\n\n<!-- pierre:claude-review v=1 -->', state: 'COMMENTED', submitted_at: new Date(Date.now() - 30_000).toISOString() },
    ]);
    try {
      await expect(seam.postReview(args)).rejects.toThrow(/internal error/);
    } finally {
      submitGithubReview.mockReset();
      submitGithubReview.mockImplementation(async () => ({ reviewId: 'R9' }));
      fetchPrReviews.mockReset();
      fetchPrReviews.mockImplementation(async () => []);
    }
  });

  it('nothing found (after a second look) ⇒ the original error stands', async () => {
    const seam = await import('./post-seam.js');
    seam.LANDED_READBACK_DELAYS_MS.splice(0, Infinity, 0, 0);
    submitGithubReview.mockImplementationOnce(async () => {
      throw internalError();
    });
    fetchPrReviews.mockClear();
    fetchPrReviews.mockRejectedValueOnce(new Error('502')).mockResolvedValueOnce([]);
    await expect(seam.postReview(args)).rejects.toThrow(/internal error/);
    expect(fetchPrReviews).toHaveBeenCalledTimes(2);
  });
});
