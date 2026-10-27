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
} from '../platform/contract.js';
import { isNoiseFile } from './prepare.js';
import {
  buildAnchorIndex,
  fallbackAnchor,
  fetchCurrentHeadSha,
  fetchPrDiff,
  fetchPrReviews,
  fetchReviewComments,
  findLandedReviewIn,
  findingCommentBody,
  isFindingAnchored,
  matchReviewComments,
  prLevelFindingBody,
  stripNoiseFromDiff,
  submitGithubComment,
  submitGithubIssueComment,
  submitGithubReview,
} from './post-review.js';
import { randomBytes } from 'node:crypto';

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
    const shape = { body: f.body, editedBody: null, suggestion: f.suggestion, storyLead: f.storyLead, severity: f.severity };
    const footer = f.footer ?? null;
    // Anchorable on its own line → inline comment there.
    if (f.line != null && isFindingAnchored(index, f.path, f.line, f.side)) {
      comments.push({ path: f.path, line: f.line, side: f.side, body: findingCommentBody(shape, { footer }) });
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
        body: findingCommentBody(shape, { fallbackNote: true, footer }),
      });
      inlineFindingIds.push(f.id);
    } else {
      prComments.push({
        findingId: f.id,
        path: f.path,
        body: prLevelFindingBody(
          {
            path: f.path,
            line: f.line,
            body: f.body,
            editedBody: null,
            suggestion: f.suggestion,
            storyLead: f.storyLead,
            severity: f.severity,
          },
          { footer },
        ),
      });
    }
  }

  // Bot-Triage WS2c — the Limn provenance stamp. UNCONDITIONAL, and that is the point: this hidden,
  // invisible, idempotent HTML marker is the ONLY producer of the 'pierre' AutomatedReviewerKind
  // (`sync/review-fingerprint.ts` matches exactly this string). Everything downstream of that
  // sentinel — the Bot-ROI "Limn · Claude" row, the ai_verbatim-vs-human_curated provenance,
  // BotPrsDetail's 'pierre' tab, the bot_only_review risk flag — goes dark without it, so the
  // account setting that used to gate it was a switch for silently deleting an analytics lane.
  // DO NOT re-gate this. `PostReviewArgs.pierreMarker?`/`pierreFooter?` remain DECLARED on the
  // contract (both sides, back-compat) but nothing passes them any more; the visible
  // "🤖 Reviewed with Limn + Claude" footer appeared in no detector and is gone.
  // ⚠ `a=` is a per-ATTEMPT nonce, so the read-back after a failed POST (`findLandedReview`) can only
  // ever adopt THIS attempt's review: without it an earlier review with the same body on the same head
  // (every summary-less review is the bare marker) would be adopted, and its findings stamped posted
  // although GitHub never received them. Every reader of the marker matches the PREFIX only.
  const finalBody = args.body + `\n\n<!-- pierre:claude-review v=1 a=${randomBytes(6).toString('hex')} -->`;

  const preview: PostReviewPreview = {
    commitId: args.reviewHeadSha,
    body: finalBody,
    event: args.verdict,
    comments,
    prComments,
  };
  if (args.dryRun) return { preview };

  const startedAt = Date.now();
  let ghReviewId: string;
  try {
    ({ reviewId: ghReviewId } = await submitGithubReview({
      owner: args.owner,
      name: args.name,
      prNumber: args.prNumber,
      commitId: args.reviewHeadSha,
      body: finalBody,
      event: args.verdict,
      comments,
    }));
  } catch (err) {
    // ⚠ AN ERROR IS NOT PROOF NOTHING WAS POSTED. GitHub has answered a review POST with a 422
    // ("An internal error occurred") AND published the review. Look before calling it a failure:
    // a review at this commit with exactly this body (it ends in our marker) that is new since we
    // started (the body carries this attempt's nonce, so no earlier review can match) IS ours, and the rest of the post carries on as if GitHub had said 201.
    const landed = await findLandedReview(args.owner, args.name, args.prNumber, {
      commitId: args.reviewHeadSha,
      body: finalBody,
      sinceMs: startedAt,
    });
    if (landed == null) throw err;
    ghReviewId = landed;
  }

  // Read back the inline comments GitHub just created and pair each with its finding, so the finding
  // keeps its GitHub comment id (→ its Changes-tab thread). ⚠ BEST-EFFORT AND NEVER RETRIED: GitHub
  // has already 201'd the review, so a failed read may not fail the post — the review read falls
  // back to matching the thread's root comment.
  let inlineComments: { findingId: number; commentId: string }[] = [];
  if (comments.length > 0) {
    try {
      const got = await fetchReviewComments(args.owner, args.name, args.prNumber, ghReviewId);
      inlineComments = matchReviewComments(
        comments.map((c, i) => ({ ...c, findingId: inlineFindingIds[i]! })),
        got,
      );
    } catch {
      /* best-effort — the finding stays posted without a comment id */
    }
  }

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
    inlineComments,
    prComments: prCommentResults,
    commentCount: comments.length,
    prCommentCount: prCommentResults.length,
  };
}

// How long to wait before each read-back of a failed review POST (GitHub may publish it a moment
// after answering). Exported so a test can make it instant.
export const LANDED_READBACK_DELAYS_MS: number[] = [0, 2000];

/** The review a failed POST created anyway, or null. Never throws (a failed read is "not found").
 *  Also the SonarCloud post's read-back (sonar/post.ts). */
export async function findLandedReview(
  owner: string,
  name: string,
  prNumber: number,
  want: { commitId: string; body: string; sinceMs: number },
): Promise<string | null> {
  for (const delay of LANDED_READBACK_DELAYS_MS) {
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    try {
      const hit = findLandedReviewIn(await fetchPrReviews(owner, name, prNumber), want);
      if (hit != null) return hit;
    } catch {
      /* unreadable: try again, then give up — the original error stands */
    }
  }
  return null;
}

// ctx.review.postFinding — post ONE finding as a standalone inline / PR-level comment. Uses
// the stored `anchored` to short-circuit to an on-line inline comment; else consults the live
// diff to re-anchor (inline) or fall back to a PR-level comment.
export async function postFinding(args: PostFindingArgs): Promise<PostFindingOutcome> {
  const { owner, name, prNumber, reviewHeadSha, finding: f } = args;
  const currentHead = await fetchCurrentHeadSha(owner, name, prNumber);
  if (currentHead !== reviewHeadSha) return { headMoved: true };
  const shape = { body: f.body, editedBody: null, suggestion: f.suggestion, storyLead: f.storyLead, severity: f.severity };
  const footer = f.footer ?? null;
  const prLevelBody = (outsideDiffNote: boolean): string =>
    prLevelFindingBody(
      {
        path: f.path,
        line: f.line,
        body: f.body,
        editedBody: null,
        suggestion: f.suggestion,
        storyLead: f.storyLead,
        severity: f.severity,
      },
      { outsideDiffNote, footer },
    );

  // A forced PR-level comment (auto-posting's questions): never inline, and the file it names IS
  // in the diff, so no "outside the diff" note.
  if (args.prLevel) {
    const { commentId } = await submitGithubIssueComment({ owner, name, prNumber, body: prLevelBody(false) });
    return { commentId, postedCommentKind: 'pr_comment' };
  }

  if (f.line != null && f.anchored) {
    const { commentId } = await submitGithubComment({
      owner,
      name,
      prNumber,
      commitId: reviewHeadSha,
      path: f.path,
      line: f.line,
      side: f.side,
      body: findingCommentBody(shape, { footer }),
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
      body: findingCommentBody(shape, { fallbackNote: true, footer }),
    });
    return { commentId, postedCommentKind: 'inline' };
  }

  const { commentId } = await submitGithubIssueComment({
    owner,
    name,
    prNumber,
    body: prLevelBody(true),
  });
  return { commentId, postedCommentKind: 'pr_comment' };
}
