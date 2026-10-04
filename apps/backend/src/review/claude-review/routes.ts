import type { FastifyInstance, FastifyReply } from 'fastify';
import type {
  ActiveReviewsResponse,
  ClaudeFindingStory,
  ClaudeReviewListResponse,
  ClaudeReviewPrState,
  ClaudeReviewResponse,
  ClaudeReviewStatesBody,
  ClaudeReviewStatesResponse,
  ClaudeReviewStatusResponse,
  GenerateReviewBody,
  PostCommentResult,
  PostReviewBody,
  PostReviewResult,
  UpdateFindingBody,
  UpdateReviewBody,
} from '@pierre-review/shared';
import {
  CLAUDE_REVIEW_MODELS,
  CLAUDE_REVIEW_STATES_MAX_IDS,
  DEFAULT_CLAUDE_REVIEW_MODEL,
  storyCommentLead,
  stripStoredStoryLead,
} from '@pierre-review/shared';
import type { AgentContext } from '../agent-context.js';
import { autoReviewWaiting } from './auto.js';
import { autoFixOutcomeFor } from '../../coding/ai-fix/auto-fix.js';
import { isFixRunning } from '../../coding/ai-fix/manager.js';
import {
  autoReviewHold,
  AGENTIC_AI_ENABLED,
  getReviewStatus,
  listActiveReviews,
  requestReviewCancel,
  startReview,
  subscribeReviewStream,
} from './manager.js';
import {
  getReviewPrContext,
  getClaudeReviewById,
  getFindingPostContext,
  getLatestClaudeReview,
  getLatestReviewStates,
  getReviewPostContext,
  listAllClaudeReviews,
  listClaudeReviewHistory,
  markFindingPosted,
  markReviewPosted,
  storyOf,
  updateFinding,
  updateReviewDraft,
} from './persist.js';

// The Claude Review product API (CORE, free, LOCAL ONLY). The paths are the historical ones
// (/api/prs/:id/claude-review*, /api/claude-reviews/*, /api/claude-findings/*,
// /api/claude-review/*), unchanged through both moves so the SPA client never changed. Registered
// only by `registerAgenticRoutes` (review/agentic.ts), which refuses in cloud and under
// LIMN_AI_DISABLED; the AGENTIC_AI_ENABLED checks below are the second guard.

const VERDICTS = ['COMMENT', 'REQUEST_CHANGES', 'APPROVE'];

const idParam = {
  params: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } },
};
const reviewIdParam = {
  params: { type: 'object', required: ['reviewId'], properties: { reviewId: { type: 'integer' } } },
};
const findingIdParam = {
  params: { type: 'object', required: ['findingId'], properties: { findingId: { type: 'integer' } } },
};
// ⚠ `model` is the OFFERED list (shared CLAUDE_REVIEW_MODELS), so a retired id (the old Opus 4.8)
// is a 400 here while its old runs still render, their id printed raw. Omitted ⇒ the default.
const generateSchema = {
  ...idParam,
  body: {
    type: 'object',
    additionalProperties: false,
    properties: {
      model: { type: 'string', enum: [...CLAUDE_REVIEW_MODELS] },
      // No `ticket`/`tickets`: a PR review checks no story (the ticket review does, `POST
      // /api/ticket-reviews`). Fastify's ajv runs with `removeAdditional`, so a stale key from an
      // older SPA is stripped, exactly like the retired `mode`.
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
    properties: { included: { type: 'boolean' }, editedBody: { type: 'string' } },
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

function featureOff(reply: FastifyReply): { error: string; message: string } {
  reply.status(404);
  return {
    error: 'NotFound',
    message: 'Claude Review is off here. It runs on your machine: npx limn-review',
  };
}

// Resolve a finding row's posted body (the user's reword if any, else Claude's wording). A story
// finding's stored lead (older rows, or a reword started from one) is removed here, because the
// comment builders add the story line themselves (`storyLead`).
const resolvedBody = (f: { body: string; editedBody: string | null }, story?: ClaudeFindingStory | null): string =>
  stripStoredStoryLead(f.editedBody && f.editedBody.trim() ? f.editedBody : f.body, story);

/**
 * Fold the manager's live AUTO-review holds over the stored latest runs, for the Open PRs column.
 * An auto review still waiting in its lane has NO ROW, so the database alone would show the PR as
 * never reviewed and offer a Review button the start route then refuses (409
 * AutoReviewInProgress). Such a PR is reported as `queued` with `reviewId: null` and
 * `trigger: 'auto'`; a stored auto run in flight takes the hold's status (`queued` / `running`).
 * Account-scoped: `autoReviewHold` answers null for another account's item.
 */
export function withAutoHolds(
  stored: ClaudeReviewPrState[],
  prIds: readonly number[],
  accountId: number,
): ClaudeReviewPrState[] {
  const byPr = new Map(stored.map((s) => [s.prId, s]));
  const out = [...stored];
  for (const prId of prIds) {
    const hold = autoReviewHold(prId, accountId);
    if (hold == null) continue;
    const row = byPr.get(prId);
    if (row != null && row.trigger === 'auto' && (row.status === 'queued' || row.status === 'running')) {
      row.status = hold;
      continue;
    }
    const lane: ClaudeReviewPrState = {
      prId,
      reviewId: null,
      status: hold,
      verdict: null,
      reviewedHeadSha: null,
      finishedAt: null,
      ticket: null,
      headMoved: false,
      trigger: 'auto',
    };
    const at = out.findIndex((s) => s.prId === prId);
    if (at >= 0) out[at] = lane;
    else out.push(lane);
  }
  return out;
}

export function registerClaudeReviewRoutes(app: FastifyInstance, ctx: AgentContext): void {
  // Latest run + findings + history + auth + enabled.
  app.get('/api/prs/:id/claude-review', { schema: idParam }, async (req): Promise<ClaudeReviewResponse> => {
    const { id } = req.params as { id: number };
    if (!AGENTIC_AI_ENABLED) {
      return {
        enabled: false,
        auth: 'none',
        review: null,
        history: [],
      };
    }
    const accountId = ctx.accountIdOf(req);
    const auth = ctx.llm.detectAuth();
    const review = await getLatestClaudeReview(ctx, id, accountId);
    const autoReview = autoReviewHold(id, accountId);
    return {
      enabled: true,
      auth: auth.status,
      authMessage: auth.status === 'none' ? auth.message : undefined,
      review,
      history: await listClaudeReviewHistory(ctx, id, accountId),
      autoReview,
      // A hold in the lane outranks the sweeper's wait (it is already past it).
      autoReviewWaiting: autoReview ? null : autoReviewWaiting(id, accountId),
      autoFix: review ? autoFixOutcomeFor(review.id, accountId) : null,
    };
  });

  // ⚠ `GET`/`PUT /api/claude-review/key` ARE DELETED, AND MUST NOT COME BACK. The BYO Anthropic
  // key that lived in `~/.pierre-review/config.json` is RETIRED: local Claude Review resolves
  // credentials from an ambient Claude session first (so a subscription pays, not a meter) and
  // otherwise leaves the environment's `ANTHROPIC_API_KEY` alone — TWO RUNGS, no stored secret, no
  // form. `ctx.review.setLocalKey` went with them, so there is no seam left to write through, and
  // `getLocalKeyStatus` went later with the budget route (below).
  //
  // Cloud never used any of this (it runs on `SUMMARY_ANTHROPIC_API_KEY` and the Settings section
  // never rendered there). An already-stored key is left on disk untouched and simply never read:
  // the decision was to stop reading it, not to destroy somebody's file — which is also why there
  // is no "clear it" route here. A route that writes the file is a write path back.

  // ⚠ `PUT /api/claude-review/budget` IS DELETED too. The per-review budget is the environment's
  // `REVIEW_BUDGET_USD` alone (default $6.75, covering a deep run's specialists) — not a setting.

  // Kick off a run.
  app.post('/api/prs/:id/claude-review', { schema: generateSchema }, async (req, reply) => {
    const { id } = req.params as { id: number };
    const body = (req.body ?? {}) as GenerateReviewBody;
    const model = body.model ?? DEFAULT_CLAUDE_REVIEW_MODEL;
    if (!AGENTIC_AI_ENABLED) return featureOff(reply);

    const auth = ctx.llm.detectAuth();
    if (auth.status === 'none') {
      reply.status(400);
      return { error: 'NoClaudeAuth', message: auth.message };
    }

    const accountId = ctx.accountIdOf(req);
    const result = await startReview(ctx, accountId, id, model);
    if (!result.ok) {
      if (result.reason === 'not_found') {
        reply.status(404);
        return { error: 'NotFound', message: `PR ${id} not found` };
      }
      if (result.reason === 'no_head') {
        reply.status(400);
        return { error: 'NoHead', message: 'PR has no head commit to review yet.' };
      }
      if (result.reason === 'credits_exhausted') {
        reply.status(402);
        return {
          error: 'CreditsExhausted',
          message: 'Out of monthly agentic AI credits — resets on the 1st.',
        };
      }
      if (result.reason === 'disabled') return featureOff(reply);
      // An auto review is queued or running on this PR: manual start is locked until it ends.
      if (result.reason === 'auto_in_progress') {
        reply.status(409);
        return {
          error: 'AutoReviewInProgress',
          auto: result.auto,
          message: result.auto === 'running' ? 'Auto review running.' : 'Auto review queued.',
        };
      }
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
  });

  app.get('/api/prs/:id/claude-review/status', { schema: idParam }, async (req): Promise<ClaudeReviewStatusResponse> => {
    const { id } = req.params as { id: number };
    if (!AGENTIC_AI_ENABLED) return { status: 'idle', reviewId: null, progress: null };
    return getReviewStatus(ctx, ctx.accountIdOf(req), id);
  });

  // Live progress STREAM (SSE).
  app.get('/api/prs/:id/claude-review/stream', { schema: idParam }, async (req, reply) => {
    const { id } = req.params as { id: number };
    const accountId = ctx.accountIdOf(req);

    // OWNERSHIP BEFORE hijack — the pattern ai-fix/routes.ts already uses, and the reason it
    // matters here is not tidiness: `subscribeReviewStream(id, …)` keys on prId alone, so
    // subscribing first attached the caller to whatever run held that prId. Combined with
    // getReviewStatus's (now fixed) unscoped snapshot, a foreign running PR produced a live
    // feed of another tenant's agent activity — file paths and source snippets from a private
    // repo — and the stream never tore itself down, because teardown only happens when the
    // snapshot stops reporting 'running'. 404 before anything is subscribed or hijacked; after
    // hijack() the headers are already committed and a clean status is impossible.
    if (!(await getReviewPrContext(ctx, id, accountId))) {
      return reply.code(404).send({ error: 'NotFound', message: `PR ${id} not found` });
    }

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (data: unknown): void => {
      if (!raw.writableEnded) raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    if (!AGENTIC_AI_ENABLED) {
      send({ type: 'done', status: 'idle', reviewId: null });
      raw.end();
      return;
    }
    let closed = false;
    let unsubscribe: (() => void) | null = null;
    const heartbeat = setInterval(() => {
      if (!raw.writableEnded) raw.write(': hb\n\n');
    }, 15000);
    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe?.();
      if (!raw.writableEnded) raw.end();
    };
    // Subscribe BEFORE the snapshot so a terminal `done` during setup isn't missed.
    unsubscribe = subscribeReviewStream(id, (e) => {
      send(e);
      if (e.type === 'done') cleanup();
    });
    req.raw.on('close', cleanup);
    const snap = await getReviewStatus(ctx, ctx.accountIdOf(req), id);
    send({ type: 'snapshot', ...snap });
    if (snap.status !== 'running' && snap.status !== 'queued') {
      send({ type: 'done', status: snap.status, reviewId: snap.reviewId });
      cleanup();
    }
  });

  app.post('/api/prs/:id/claude-review/cancel', { schema: idParam }, async (req, reply) => {
    const { id } = req.params as { id: number };
    if (!AGENTIC_AI_ENABLED) return featureOff(reply);
    // Scoped by account: cancelling is a state change on a BILLED run, so one tenant must not
    // be able to abort another's by guessing a PR id.
    if (!requestReviewCancel(id, ctx.accountIdOf(req))) {
      reply.status(404);
      return { error: 'NotFound', message: 'No running review for this PR.' };
    }
    return { status: 'cancelling' };
  });

  app.get('/api/claude-reviews', async (req): Promise<ClaudeReviewListResponse> => {
    if (!AGENTIC_AI_ENABLED) return { reviews: [] };
    return { reviews: await listAllClaudeReviews(ctx, ctx.accountIdOf(req)) };
  });

  // The Open PRs table's "Claude review" column: the LATEST run for each listed PR, ONE request for
  // the whole table (never one per row). DB-only — `tierFor` keeps it on `read` although it is a
  // POST under the Claude Review family. Over the cap is a 400, never a silent truncation.
  app.post(
    '/api/claude-review/states',
    {
      schema: {
        body: {
          type: 'object',
          required: ['prIds'],
          additionalProperties: false,
          properties: { prIds: { type: 'array', items: { type: 'integer' } } },
        },
      },
    },
    async (req, reply): Promise<ClaudeReviewStatesResponse | { error: string; message: string }> => {
      const { prIds } = req.body as ClaudeReviewStatesBody;
      const unique = [...new Set(prIds)];
      if (unique.length > CLAUDE_REVIEW_STATES_MAX_IDS) {
        reply.status(400);
        return {
          error: 'TooManyIds',
          message: `At most ${CLAUDE_REVIEW_STATES_MAX_IDS} PRs per request; got ${unique.length}.`,
        };
      }
      if (!AGENTIC_AI_ENABLED) return { states: [] };
      const accountId = ctx.accountIdOf(req);
      const stored = await getLatestReviewStates(ctx, unique, accountId, isFixRunning);
      return { states: withAutoHolds(stored, unique, accountId) };
    },
  );

  app.get('/api/claude-reviews/active', async (req): Promise<ActiveReviewsResponse> => {
    if (!AGENTIC_AI_ENABLED) return { reviews: [] };
    // Account-scoped: the queue is process-global, so an unscoped listing handed every tenant
    // the repo name, PR number and PR title of every other tenant's running review.
    return { reviews: await listActiveReviews(ctx.accountIdOf(req)) };
  });

  app.get('/api/claude-reviews/:reviewId', { schema: reviewIdParam }, async (req, reply) => {
    if (!AGENTIC_AI_ENABLED) return featureOff(reply);
    const { reviewId } = req.params as { reviewId: number };
    const review = await getClaudeReviewById(ctx, reviewId, ctx.accountIdOf(req));
    if (!review) {
      reply.status(404);
      return { error: 'NotFound', message: `Review ${reviewId} not found` };
    }
    return review;
  });

  app.patch('/api/claude-reviews/:reviewId', { schema: updateReviewSchema }, async (req, reply) => {
    if (!AGENTIC_AI_ENABLED) return featureOff(reply);
    const { reviewId } = req.params as { reviewId: number };
    const body = req.body as UpdateReviewBody;
    const accountId = ctx.accountIdOf(req);
    // Ownership: only update a review this account owns.
    if (!(await getClaudeReviewById(ctx, reviewId, accountId))) {
      reply.status(404);
      return { error: 'NotFound', message: `Review ${reviewId} not found` };
    }
    await updateReviewDraft(ctx, reviewId, body);
    return { status: 'ok' };
  });

  app.patch('/api/claude-findings/:findingId', { schema: updateFindingSchema }, async (req, reply) => {
    if (!AGENTIC_AI_ENABLED) return featureOff(reply);
    const { findingId } = req.params as { findingId: number };
    const body = req.body as UpdateFindingBody;
    const accountId = ctx.accountIdOf(req);
    // Ownership check before the write (the finding's review must belong to this account).
    if (!(await getFindingPostContext(ctx, findingId, accountId))) {
      reply.status(404);
      return { error: 'NotFound', message: `Finding ${findingId} not found` };
    }
    await updateFinding(ctx, findingId, body);
    return { status: 'ok' };
  });

  // Post a single finding as a standalone comment (destination chosen from the live diff).
  app.post('/api/claude-findings/:findingId/post', { schema: findingIdParam }, async (req, reply) => {
    if (!AGENTIC_AI_ENABLED) return featureOff(reply);
    const { findingId } = req.params as { findingId: number };
    const accountId = ctx.accountIdOf(req);
    const fctx = await getFindingPostContext(ctx, findingId, accountId);
    if (!fctx) {
      reply.status(404);
      return { error: 'NotFound', message: `Finding ${findingId} not found` };
    }
    const f = fctx.finding;
    const story = storyOf(f);
    // A story finding's comment opens on its story line, built from the run's tickets.
    const storyReview = story ? await getClaudeReviewById(ctx, f.reviewId, accountId) : null;
    try {
      const outcome = await ctx.review.postFinding({
        owner: fctx.owner,
        name: fctx.name,
        prNumber: fctx.prNumber,
        reviewHeadSha: fctx.reviewHeadSha,
        finding: {
          id: f.id,
          path: f.path,
          line: f.line,
          side: f.side,
          anchored: f.anchored,
          fileInDiff: f.fileInDiff,
          body: resolvedBody(f, story),
          suggestion: f.suggestion,
          storyLead: story ? storyCommentLead({ title: f.title, story }, storyReview?.tickets ?? []) : null,
        },
      });
      if (outcome.headMoved) {
        reply.status(409);
        return {
          error: 'HeadMoved',
          message: 'The PR head has moved since this review. Re-review before posting.',
        };
      }
      await markFindingPosted(ctx, findingId, outcome.commentId, outcome.postedCommentKind);
      const result: PostCommentResult = {
        githubCommentId: outcome.commentId,
        postedAt: new Date().toISOString(),
      };
      return result;
    } catch (err) {
      reply.status(502);
      return { error: 'GitHubError', message: err instanceof Error ? err.message : String(err) };
    }
  });

  // Post a single GitHub review (or, with ?dryRun=true, the exact payload without posting).
  app.post('/api/claude-reviews/:reviewId/post', { schema: postSchema }, async (req, reply) => {
    if (!AGENTIC_AI_ENABLED) return featureOff(reply);
    const { reviewId } = req.params as { reviewId: number };
    const { userVerdict } = req.body as PostReviewBody;
    const dryRun = (req.query as { dryRun?: string }).dryRun === 'true';
    const accountId = ctx.accountIdOf(req);

    const pctx = await getReviewPostContext(ctx, reviewId, accountId);
    const review = await getClaudeReviewById(ctx, reviewId, accountId);
    if (!pctx || !review) {
      reply.status(404);
      return { error: 'NotFound', message: `Review ${reviewId} not found` };
    }

    // (Provenance stamping is no longer read from settings. The hidden
    // `<!-- pierre:claude-review v=1 -->` marker is now appended UNCONDITIONALLY by core's
    // `review/post-seam.ts` — it is the only producer of the 'pierre' AutomatedReviewerKind, so a
    // toggle that switched it off silently deleted the Bot-ROI "Limn · Claude" row and the
    // verbatim-vs-curated provenance. The visible footer, which matched no detector at all, is
    // gone entirely.)

    try {
      // Persist the chosen verdict so the run records what was posted.
      await updateReviewDraft(ctx, reviewId, { userVerdict });

      const outcome = await ctx.review.postReview({
        owner: pctx.owner,
        name: pctx.name,
        prNumber: pctx.prNumber,
        reviewHeadSha: pctx.reviewHeadSha,
        body: review.userBody ?? '',
        verdict: userVerdict,
        includedFindings: review.findings
          // A finding already on GitHub (posted on its own, or in an earlier submitted review) is
          // DONE: the SPA offers no "Post again", and a re-submitted review must not post it twice.
          .filter((f) => f.included && f.postedAt == null)
          .map((f) => ({
            id: f.id,
            path: f.path,
            line: f.line,
            side: f.side,
            anchored: f.anchored,
            fileInDiff: f.fileInDiff,
            body: resolvedBody(f, f.story),
            suggestion: f.suggestion,
            storyLead: f.story ? storyCommentLead({ title: f.title, story: f.story }, review.tickets ?? []) : null,
          })),
        dryRun,
      });

      if (outcome.headMoved) {
        reply.status(409);
        return {
          error: 'HeadMoved',
          message: 'The PR head has moved since this review. Re-review before posting.',
        };
      }
      if ('preview' in outcome) return outcome.preview;

      await markReviewPosted(ctx, reviewId, outcome.postedReviewId, outcome.inlineFindingIds, outcome.prComments);
      const result: PostReviewResult = {
        postedReviewId: outcome.postedReviewId,
        postedAt: new Date().toISOString(),
        postedCommentCount: outcome.commentCount,
        prCommentCount: outcome.prCommentCount,
      };
      return result;
    } catch (err) {
      reply.status(502);
      return { error: 'GitHubError', message: err instanceof Error ? err.message : String(err) };
    }
  });
}
