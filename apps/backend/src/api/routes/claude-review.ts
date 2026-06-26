import type { FastifyInstance, FastifyReply } from 'fastify';
import type {
  ActiveReviewsResponse,
  ClaudeKeyResponse,
  ClaudeReviewListResponse,
  ClaudeReviewResponse,
  ClaudeReviewStatusResponse,
  GenerateReviewBody,
  SetClaudeKeyBody,
  PostCommentResult,
  PostReviewBody,
  PostReviewResult,
  UpdateFindingBody,
  UpdateReviewBody,
} from '@pierre-review/shared';
import { config } from '../../config.js';
import {
  getClaudeReviewById,
  getClaudeReviewContext,
  getFindingPostContext,
  getLatestClaudeReview,
  listAllClaudeReviews,
  listClaudeReviewHistory,
} from '../../db/queries.js';
import {
  markFindingPosted,
  markReviewPosted,
  updateFinding,
  updateReviewDraft,
} from '../../review/persist.js';
import {
  getReviewStatus,
  listActiveReviews,
  requestReviewCancel,
  startReview,
} from '../../review/review-manager.js';
import { detectClaudeAuth } from '../../review/auth.js';
import {
  hasUserAnthropicKey,
  setUserAnthropicKey,
} from '../../review/local-settings.js';
import {
  buildAnchorIndex,
  buildReview,
  fallbackAnchor,
  fetchCurrentHeadSha,
  fetchPrDiff,
  findingCommentBody,
  prLevelFindingBody,
  stripNoiseFromDiff,
  submitGithubComment,
  submitGithubIssueComment,
  submitGithubReview,
} from '../../review/post-review.js';
import { isNoiseFile } from '../../review/prompt.js';
import { accountIdOf } from '../plugins/auth.js';

const MODELS = ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5'];
const VERDICTS = ['COMMENT', 'REQUEST_CHANGES', 'APPROVE'];
const REVIEW_MODES = ['auto', 'diff_only', 'worktree'];

const idParam = {
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'integer' } },
  },
};

const reviewIdParam = {
  params: {
    type: 'object',
    required: ['reviewId'],
    properties: { reviewId: { type: 'integer' } },
  },
};

const findingIdParam = {
  params: {
    type: 'object',
    required: ['findingId'],
    properties: { findingId: { type: 'integer' } },
  },
};

const generateSchema = {
  ...idParam,
  body: {
    type: 'object',
    required: ['model'],
    additionalProperties: false,
    properties: {
      model: { type: 'string', enum: MODELS },
      // Review depth. Omitted defaults to 'auto' (the router decides).
      mode: { type: 'string', enum: REVIEW_MODES },
    },
  },
};

const updateReviewSchema = {
  ...reviewIdParam,
  body: {
    type: 'object',
    additionalProperties: false,
    properties: {
      userBody: { type: 'string' },
      userVerdict: { type: 'string', enum: VERDICTS },
    },
  },
};

const updateFindingSchema = {
  ...findingIdParam,
  body: {
    type: 'object',
    additionalProperties: false,
    properties: {
      included: { type: 'boolean' },
      editedBody: { type: 'string' },
    },
  },
};

const postSchema = {
  ...reviewIdParam,
  body: {
    type: 'object',
    required: ['userVerdict'],
    additionalProperties: false,
    properties: { userVerdict: { type: 'string', enum: VERDICTS } },
  },
};

// Feature is opt-in (ENABLE_CLAUDE_REVIEW). When off, mutating routes 404.
function featureOff(reply: FastifyReply): { error: string; message: string } {
  reply.status(404);
  return {
    error: 'NotFound',
    message: 'Claude Review is disabled (set ENABLE_CLAUDE_REVIEW=true).',
  };
}

export async function claudeReviewRoutes(app: FastifyInstance): Promise<void> {
  // Latest run + findings + history + auth + enabled.
  app.get(
    '/api/prs/:id/claude-review',
    { schema: idParam },
    async (req): Promise<ClaudeReviewResponse> => {
      const { id } = req.params as { id: number };
      if (!config.claudeReviewEnabled) {
        return {
          enabled: false,
          auth: 'none',
          hasUserKey: false,
          review: null,
          history: [],
        };
      }
      const accountId = accountIdOf(req);
      const auth = detectClaudeAuth();
      return {
        enabled: true,
        auth: auth.status,
        authMessage: auth.status === 'none' ? auth.message : undefined,
        hasUserKey: hasUserAnthropicKey(),
        review: await getLatestClaudeReview(id, accountId),
        history: await listClaudeReviewHistory(id, accountId),
      };
    },
  );

  // Set or clear the locally-stored Anthropic API key (local mode only — the
  // whole route file is unregistered in cloud). An empty `key` clears it.
  app.put(
    '/api/claude-review/key',
    {
      schema: {
        body: {
          type: 'object',
          required: ['key'],
          additionalProperties: false,
          properties: { key: { type: 'string' } },
        },
      },
    },
    async (req): Promise<ClaudeKeyResponse> => {
      const { key } = req.body as SetClaudeKeyBody;
      setUserAnthropicKey(key);
      return { hasUserKey: hasUserAnthropicKey(), auth: detectClaudeAuth().status };
    },
  );

  // Kick off a run. 404 disabled/unknown PR, 400 no auth / no head, 409 busy.
  app.post(
    '/api/prs/:id/claude-review',
    { schema: generateSchema },
    async (req, reply) => {
      const { id } = req.params as { id: number };
      const { model, mode } = req.body as GenerateReviewBody;
      if (!config.claudeReviewEnabled) return featureOff(reply);

      const auth = detectClaudeAuth();
      if (auth.status === 'none') {
        reply.status(400);
        return { error: 'NoClaudeAuth', message: auth.message };
      }

      const result = await startReview(id, model, mode ?? 'auto', app.log);
      if (!result.ok) {
        if (result.reason === 'not_found') {
          reply.status(404);
          return { error: 'NotFound', message: `PR ${id} not found` };
        }
        if (result.reason === 'no_head') {
          reply.status(400);
          return {
            error: 'NoHead',
            message: 'PR has no head commit to review yet.',
          };
        }
        if (result.reason === 'disabled') return featureOff(reply);
        // already_running | busy
        reply.status(409);
        return {
          error: 'Conflict',
          message:
            result.reason === 'already_running'
              ? 'A review is already running or queued for this PR.'
              : 'The review queue is full; try again once some finish.',
        };
      }
      reply.status(202);
      return { reviewId: result.reviewId, status: 'queued' };
    },
  );

  // Live progress poll target.
  app.get(
    '/api/prs/:id/claude-review/status',
    { schema: idParam },
    async (req): Promise<ClaudeReviewStatusResponse> => {
      const { id } = req.params as { id: number };
      if (!config.claudeReviewEnabled) {
        return { status: 'idle', reviewId: null, progress: null };
      }
      return await getReviewStatus(id);
    },
  );

  app.post(
    '/api/prs/:id/claude-review/cancel',
    { schema: idParam },
    async (req, reply) => {
      const { id } = req.params as { id: number };
      if (!config.claudeReviewEnabled) return featureOff(reply);
      const ok = requestReviewCancel(id);
      if (!ok) {
        reply.status(404);
        return { error: 'NotFound', message: 'No running review for this PR.' };
      }
      return { status: 'cancelling' };
    },
  );

  // Cross-PR list of prior Claude reviews (one entry per PR = its most-recent
  // succeeded run, within the timeline window). Static path — registered before
  // the /:reviewId param route so Fastify never mis-routes it.
  app.get(
    '/api/claude-reviews',
    async (req): Promise<ClaudeReviewListResponse> => {
      if (!config.claudeReviewEnabled) return { reviews: [] };
      return { reviews: await listAllClaudeReviews(accountIdOf(req)) };
    },
  );

  // All in-flight reviews (global progress banner). Static path — Fastify
  // prioritises it over the /:reviewId param route.
  app.get(
    '/api/claude-reviews/active',
    async (): Promise<ActiveReviewsResponse> => {
      if (!config.claudeReviewEnabled) return { reviews: [] };
      return { reviews: await listActiveReviews() };
    },
  );

  // A specific past run (with findings) — drives the history selector.
  app.get(
    '/api/claude-reviews/:reviewId',
    { schema: reviewIdParam },
    async (req, reply) => {
      if (!config.claudeReviewEnabled) return featureOff(reply);
      const { reviewId } = req.params as { reviewId: number };
      const review = await getClaudeReviewById(reviewId, accountIdOf(req));
      if (!review) {
        reply.status(404);
        return { error: 'NotFound', message: `Review ${reviewId} not found` };
      }
      return review;
    },
  );

  // Save the user's authored draft (never touches Claude's summary/verdict).
  app.patch(
    '/api/claude-reviews/:reviewId',
    { schema: updateReviewSchema },
    async (req, reply) => {
      if (!config.claudeReviewEnabled) return featureOff(reply);
      const { reviewId } = req.params as { reviewId: number };
      const body = req.body as UpdateReviewBody;
      const ok = await updateReviewDraft(reviewId, body);
      if (!ok) {
        reply.status(404);
        return { error: 'NotFound', message: `Review ${reviewId} not found` };
      }
      return { status: 'ok' };
    },
  );

  // Tick a finding for inline posting and/or save the user's reworded body.
  app.patch(
    '/api/claude-findings/:findingId',
    { schema: updateFindingSchema },
    async (req, reply) => {
      if (!config.claudeReviewEnabled) return featureOff(reply);
      const { findingId } = req.params as { findingId: number };
      const body = req.body as UpdateFindingBody;
      const ok = await updateFinding(findingId, body);
      if (!ok) {
        reply.status(404);
        return { error: 'NotFound', message: `Finding ${findingId} not found` };
      }
      return { status: 'ok' };
    },
  );

  // Post a single finding as a standalone comment (no review submitted). The
  // destination is chosen AUTOMATICALLY from the live diff: anchorable on its own
  // line → an inline comment there; unanchored but its file is in the diff → an
  // inline comment on the file's first change; its file is NOT in the diff (e.g. a
  // deep review on an unchanged file) → a standalone PR-level comment marked as
  // outside the PR's diff. Pins to the run's head SHA; 409 if the PR head has moved.
  app.post(
    '/api/claude-findings/:findingId/post',
    { schema: findingIdParam },
    async (req, reply) => {
      if (!config.claudeReviewEnabled) return featureOff(reply);
      const { findingId } = req.params as { findingId: number };
      const ctx = await getFindingPostContext(findingId, accountIdOf(req));
      if (!ctx) {
        reply.status(404);
        return { error: 'NotFound', message: `Finding ${findingId} not found` };
      }
      const f = ctx.finding;
      try {
        const currentHead = await fetchCurrentHeadSha(
          ctx.owner,
          ctx.name,
          ctx.prNumber,
        );
        if (currentHead !== ctx.reviewHeadSha) {
          reply.status(409);
          return {
            error: 'HeadMoved',
            message:
              'The PR head has moved since this review. Re-review before posting.',
          };
        }

        const postedAt = new Date().toISOString();

        // Anchorable on its own line → inline comment there.
        if (f.line != null && f.anchored) {
          const { commentId } = await submitGithubComment({
            owner: ctx.owner,
            name: ctx.name,
            prNumber: ctx.prNumber,
            commitId: ctx.reviewHeadSha,
            path: f.path,
            line: f.line,
            side: f.side,
            body: findingCommentBody({
              body: f.body,
              editedBody: f.editedBody,
              suggestion: f.suggestion,
            }),
          });
          await markFindingPosted(findingId, commentId, 'inline');
          const result: PostCommentResult = { githubCommentId: commentId, postedAt };
          return result;
        }

        // Otherwise consult the diff. If the file IS in the diff, re-anchor to its
        // first change (inline). If it isn't, post a standalone PR-level comment.
        const { diff } = stripNoiseFromDiff(
          await fetchPrDiff(ctx.owner, ctx.name, ctx.prNumber),
          isNoiseFile,
        );
        const fb = fallbackAnchor(buildAnchorIndex(diff), f.path);
        if (fb) {
          const { commentId } = await submitGithubComment({
            owner: ctx.owner,
            name: ctx.name,
            prNumber: ctx.prNumber,
            commitId: ctx.reviewHeadSha,
            path: f.path,
            line: fb.line,
            side: fb.side,
            body: findingCommentBody(
              { body: f.body, editedBody: f.editedBody, suggestion: f.suggestion },
              { fallbackNote: true },
            ),
          });
          await markFindingPosted(findingId, commentId, 'inline');
          const result: PostCommentResult = { githubCommentId: commentId, postedAt };
          return result;
        }

        // File outside the PR's diff → standalone PR-level (issue) comment.
        const { commentId } = await submitGithubIssueComment({
          owner: ctx.owner,
          name: ctx.name,
          prNumber: ctx.prNumber,
          body: prLevelFindingBody({
            path: f.path,
            line: f.line,
            body: f.body,
            editedBody: f.editedBody,
            suggestion: f.suggestion,
          }),
        });
        await markFindingPosted(findingId, commentId, 'pr_comment');
        const result: PostCommentResult = { githubCommentId: commentId, postedAt };
        return result;
      } catch (err) {
        reply.status(502);
        return {
          error: 'GitHubError',
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  // Post a single GitHub review (or, with ?dryRun=true, return the exact payload
  // without calling GitHub).
  app.post(
    '/api/claude-reviews/:reviewId/post',
    { schema: postSchema },
    async (req, reply) => {
      if (!config.claudeReviewEnabled) return featureOff(reply);
      const { reviewId } = req.params as { reviewId: number };
      const { userVerdict } = req.body as PostReviewBody;
      const dryRun = (req.query as { dryRun?: string }).dryRun === 'true';
      const accountId = accountIdOf(req);

      const ctx = await getClaudeReviewContext(reviewId, accountId);
      if (!ctx) {
        reply.status(404);
        return { error: 'NotFound', message: `Review ${reviewId} not found` };
      }
      const review = await getClaudeReviewById(reviewId, accountId);
      if (!review) {
        reply.status(404);
        return { error: 'NotFound', message: `Review ${reviewId} not found` };
      }

      try {
        // Re-validate against the live head — if it moved, a re-review is needed.
        const currentHead = await fetchCurrentHeadSha(
          ctx.owner,
          ctx.name,
          ctx.prNumber,
        );
        if (currentHead !== ctx.review.headSha) {
          reply.status(409);
          return {
            error: 'HeadMoved',
            message:
              'The PR head has moved since this review. Re-review before posting.',
          };
        }

        // Persist the chosen verdict so the run records what was posted.
        await updateReviewDraft(reviewId, { userVerdict });

        const rawDiff = await fetchPrDiff(ctx.owner, ctx.name, ctx.prNumber);
        const { diff } = stripNoiseFromDiff(rawDiff, isNoiseFile);
        const built = buildReview({
          commitId: ctx.review.headSha,
          body: review.userBody ?? '',
          event: userVerdict,
          includedFindings: review.findings.filter((f) => f.included),
          diff,
        });

        if (dryRun) return built.preview;

        const { reviewId: ghReviewId } = await submitGithubReview({
          owner: ctx.owner,
          name: ctx.name,
          prNumber: ctx.prNumber,
          commitId: ctx.review.headSha,
          body: review.userBody ?? '',
          event: userVerdict,
          comments: built.preview.comments,
        });

        // The review is now LIVE on GitHub and can't be un-posted. Findings whose
        // file isn't in the diff post as standalone PR-level comments alongside it
        // (one issue comment each), so a deep review's findings on unchanged files
        // still land rather than being dropped. Each post is best-effort: a single
        // failed comment must NOT strand the already-posted review (that would leave
        // the run unstamped and tempt a duplicate re-post), so we collect what lands
        // and ALWAYS stamp afterwards. Findings that fail simply stay un-posted and
        // can be posted individually from their row.
        const prCommentResults: { findingId: number; commentId: string }[] = [];
        for (const pc of built.preview.prComments) {
          try {
            const { commentId } = await submitGithubIssueComment({
              owner: ctx.owner,
              name: ctx.name,
              prNumber: ctx.prNumber,
              body: pc.body,
            });
            prCommentResults.push({ findingId: pc.findingId, commentId });
          } catch (err) {
            req.log.warn(
              { err, findingId: pc.findingId, path: pc.path },
              'failed to post a PR-level comment for an off-diff finding',
            );
          }
        }
        await markReviewPosted(
          reviewId,
          ghReviewId,
          built.inlineFindingIds,
          prCommentResults,
        );

        const result: PostReviewResult = {
          postedReviewId: ghReviewId,
          postedAt: new Date().toISOString(),
          postedCommentCount: built.preview.comments.length,
          // Count what actually posted (a comment may have failed best-effort above).
          prCommentCount: prCommentResults.length,
        };
        return result;
      } catch (err) {
        reply.status(502);
        return {
          error: 'GitHubError',
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );
}
