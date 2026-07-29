import type {
  PostReviewComment,
  PostReviewPrComment,
  PostReviewPreview,
} from '@pierre-review/shared';
import type {
  PostFindingArgs,
  PostFindingOutcome,
  PostReviewArgs,
  PostReviewOutcome,
} from '../pro/contract.js';
import { isNoiseFile } from './prepare.js';
import {
  buildAnchorIndex,
  fallbackAnchor,
  fetchCurrentHeadSha,
  fetchPrDiff,
  findingCommentBody,
  isFindingAnchored,
  prLevelFindingBody,
  stripNoiseFromDiff,
  submitGithubComment,
  submitGithubIssueComment,
  submitGithubReview,
} from './post-review.js';

// The GitHub-write half of the ctx.review seam. Security-sensitive (per-account gh token +
// line-anchoring), so it stays CORE — the plugin hands over the user's ticked findings (read
// from the core tables) + body/verdict, and core re-checks the head, re-anchors against the
// live diff, and submits. GitHub errors THROW (the plugin's route maps them to 502); a moved
// head returns { headMoved: true } (→ 409). Findings' `body` is pre-resolved (editedBody ??
// body) by the plugin, so findingCommentBody sees editedBody=null and uses `body` as-is.

// ctx.review.postReview — submit ONE GitHub review (inline comments + body + verdict), pinned
// to reviewHeadSha. dryRun returns the preview instead of posting.
export async function postReview(args: PostReviewArgs): Promise<PostReviewOutcome> {
  const currentHead = await fetchCurrentHeadSha(args.owner, args.name, args.prNumber);
  if (currentHead !== args.reviewHeadSha) return { headMoved: true };

  const { diff } = stripNoiseFromDiff(
    await fetchPrDiff(args.owner, args.name, args.prNumber),
    isNoiseFile,
  );
  const index = buildAnchorIndex(diff);
  const comments: PostReviewComment[] = [];
  const prComments: PostReviewPrComment[] = [];
  const inlineFindingIds: number[] = [];
  for (const f of args.includedFindings) {
    const shape = { body: f.body, editedBody: null, suggestion: f.suggestion };
    // Anchorable on its own line → inline comment there.
    if (f.line != null && isFindingAnchored(index, f.path, f.line, f.side)) {
      comments.push({ path: f.path, line: f.line, side: f.side, body: findingCommentBody(shape) });
      inlineFindingIds.push(f.id);
      continue;
    }
    // Its own line isn't addable → anchor to the file's first change if the file is in the
    // diff (inline, with a note); else post as a standalone PR-level comment.
    const fb = fallbackAnchor(index, f.path);
    if (fb) {
      comments.push({
        path: f.path,
        line: fb.line,
        side: fb.side,
        body: findingCommentBody(shape, { fallbackNote: true }),
      });
      inlineFindingIds.push(f.id);
    } else {
      prComments.push({
        findingId: f.id,
        path: f.path,
        body: prLevelFindingBody({
          path: f.path,
          line: f.line,
          body: f.body,
          editedBody: null,
          suggestion: f.suggestion,
        }),
      });
    }
  }

  // Bot-Triage WS2c — Pierre provenance stamps. The visible footer (branding, default off) precedes
  // the hidden HTML marker (invisible/idempotent; also what the fingerprint engine matches) so the
  // marker trails the body. Both default false when the arg is absent → body unchanged.
  const finalBody =
    args.body +
    (args.pierreFooter ? '\n\n---\n🤖 Reviewed with Limn + Claude' : '') +
    (args.pierreMarker ? '\n\n<!-- pierre:claude-review v=1 -->' : '');

  const preview: PostReviewPreview = {
    commitId: args.reviewHeadSha,
    body: finalBody,
    event: args.verdict,
    comments,
    prComments,
  };
  if (args.dryRun) return { preview };

  const { reviewId: ghReviewId } = await submitGithubReview({
    owner: args.owner,
    name: args.name,
    prNumber: args.prNumber,
    commitId: args.reviewHeadSha,
    body: finalBody,
    event: args.verdict,
    comments,
  });

  // Off-diff findings post as standalone PR-level comments alongside the review. Each is
  // best-effort: a single failed comment must NOT strand the already-posted (irreversible)
  // review — collect what lands; the caller stamps only those.
  const prCommentResults: { findingId: number; commentId: string }[] = [];
  for (const pc of prComments) {
    try {
      const { commentId } = await submitGithubIssueComment({
        owner: args.owner,
        name: args.name,
        prNumber: args.prNumber,
        body: pc.body,
      });
      prCommentResults.push({ findingId: pc.findingId, commentId });
    } catch {
      /* best-effort — leave the finding un-posted rather than strand the posted review */
    }
  }

  return {
    postedReviewId: ghReviewId,
    inlineFindingIds,
    prComments: prCommentResults,
    commentCount: comments.length,
    prCommentCount: prCommentResults.length,
  };
}

// ctx.review.postFinding — post ONE finding as a standalone inline / PR-level comment. Uses
// the stored `anchored` to short-circuit to an on-line inline comment; else consults the live
// diff to re-anchor (inline) or fall back to a PR-level comment.
export async function postFinding(args: PostFindingArgs): Promise<PostFindingOutcome> {
  const { owner, name, prNumber, reviewHeadSha, finding: f } = args;
  const currentHead = await fetchCurrentHeadSha(owner, name, prNumber);
  if (currentHead !== reviewHeadSha) return { headMoved: true };
  const shape = { body: f.body, editedBody: null, suggestion: f.suggestion };

  if (f.line != null && f.anchored) {
    const { commentId } = await submitGithubComment({
      owner,
      name,
      prNumber,
      commitId: reviewHeadSha,
      path: f.path,
      line: f.line,
      side: f.side,
      body: findingCommentBody(shape),
    });
    return { commentId, postedCommentKind: 'inline' };
  }

  const { diff } = stripNoiseFromDiff(await fetchPrDiff(owner, name, prNumber), isNoiseFile);
  const fb = fallbackAnchor(buildAnchorIndex(diff), f.path);
  if (fb) {
    const { commentId } = await submitGithubComment({
      owner,
      name,
      prNumber,
      commitId: reviewHeadSha,
      path: f.path,
      line: fb.line,
      side: fb.side,
      body: findingCommentBody(shape, { fallbackNote: true }),
    });
    return { commentId, postedCommentKind: 'inline' };
  }

  const { commentId } = await submitGithubIssueComment({
    owner,
    name,
    prNumber,
    body: prLevelFindingBody({
      path: f.path,
      line: f.line,
      body: f.body,
      editedBody: null,
      suggestion: f.suggestion,
    }),
  });
  return { commentId, postedCommentKind: 'pr_comment' };
}
