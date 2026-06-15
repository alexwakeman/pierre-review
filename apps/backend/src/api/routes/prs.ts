import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type {
  AddReviewCommentBody,
  AddReviewCommentResult,
  ApprovePrBody,
  ApprovePrResult,
  CreatePrCommentBody,
  CreatePrCommentResult,
  MarkViewedBody,
  PrFileDiff,
  PrFileDiffStatus,
  PrFilesResponse,
} from '@pierre-review/shared';
import { getAccessToken, getAccountUserId } from '../../auth/account.js';
import {
  getPrDetail,
  getPrFilesContext,
  getPrWriteContext,
  markAllViewed,
  markPrViewed,
  upsertLocalPrComment,
  upsertLocalReview,
} from '../../db/queries.js';
import {
  buildFileAnchors,
  fallbackAnchor,
  isFindingAnchored,
} from '../../github/diff-anchor.js';
import {
  addIssueComment,
  fetchHeadShaFor,
  fetchPrFilesWithPatch,
  postInlineComment,
  submitPrReview,
} from '../../github/mutations.js';
import { hydratePrDetail } from '../../sync/hydrate-detail.js';
import { accountIdOf } from '../plugins/auth.js';

// GitHub anchors a file in the PR "Files changed" diff by the SHA-256 of its
// path (matches db/queries.ts + hydrate-detail.ts's diffAnchorId).
function diffAnchorId(path: string): string {
  return createHash('sha256').update(path, 'utf8').digest('hex');
}

const PR_FILE_STATUSES: readonly PrFileDiffStatus[] = [
  'added',
  'modified',
  'removed',
  'renamed',
  'changed',
  'copied',
  'unchanged',
];

// Pass GitHub's REST file status through verbatim when it's one we model, else
// fall back to 'changed' (the catch-all GitHub itself uses).
function normalizeStatus(status: string): PrFileDiffStatus {
  return (PR_FILE_STATUSES as readonly string[]).includes(status)
    ? (status as PrFileDiffStatus)
    : 'changed';
}

const idParamSchema = {
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'integer' } },
  },
};

const markViewedSchema = {
  ...idParamSchema,
  body: {
    type: 'object',
    additionalProperties: false,
    properties: { sha: { type: 'string' } },
  },
};

const markAllViewedSchema = {
  body: {
    type: 'object',
    additionalProperties: false,
    properties: { repoIds: { type: 'array', items: { type: 'integer' } } },
  },
};

const commentSchema = {
  ...idParamSchema,
  body: {
    type: 'object',
    required: ['body'],
    additionalProperties: false,
    properties: { body: { type: 'string' } },
  },
};

const approveSchema = {
  ...idParamSchema,
  body: {
    type: 'object',
    additionalProperties: false,
    properties: { body: { type: 'string' } },
  },
};

const reviewCommentSchema = {
  ...idParamSchema,
  body: {
    type: 'object',
    required: ['path', 'line', 'body'],
    additionalProperties: false,
    properties: {
      path: { type: 'string' },
      line: { type: 'integer' },
      side: { type: 'string', enum: ['LEFT', 'RIGHT'] },
      body: { type: 'string' },
    },
  },
};

export async function prRoutes(app: FastifyInstance): Promise<void> {
  // Bulk "mark all seen": stamp every open PR (optionally scoped to repoIds) viewed
  // at its head, clearing all new-since badges at once. Static path — no :id — so it
  // doesn't collide with /api/prs/:id.
  app.post('/api/prs/mark-all-viewed', { schema: markAllViewedSchema }, async (req) => {
    const { repoIds } = (req.body ?? {}) as { repoIds?: number[] };
    const count = await markAllViewed(
      accountIdOf(req),
      repoIds && repoIds.length > 0 ? repoIds : null,
    );
    return { status: 'ok', count };
  });

  app.get('/api/prs/:id', { schema: idParamSchema }, async (req, reply) => {
    const { id } = req.params as { id: number };
    const accountId = accountIdOf(req);
    const pr = await getPrDetail(id, accountId);
    if (!pr) {
      reply.status(404);
      return { error: 'NotFound', message: `PR ${id} not found` };
    }
    // Cloud lean mode: fill in bulky text from GitHub (no-op in local). The client
    // caches the result in IndexedDB keyed by updatedAt so unchanged PRs don't refetch.
    return hydratePrDetail(pr, accountId);
  });

  // Record that the local user has seen this PR up to `sha` (defaults to the
  // current head). Clears "new since last viewed" badges.
  app.post(
    '/api/prs/:id/mark-viewed',
    { schema: markViewedSchema },
    async (req, reply) => {
      const { id } = req.params as { id: number };
      const { sha } = (req.body ?? {}) as MarkViewedBody;
      const ok = await markPrViewed(id, accountIdOf(req), sha);
      if (!ok) {
        reply.status(404);
        return { error: 'NotFound', message: `PR ${id} not found` };
      }
      return { status: 'ok' };
    },
  );

  // Explicit "I've seen this" without opening — same effect as mark-viewed.
  app.post(
    '/api/prs/:id/dismiss',
    { schema: idParamSchema },
    async (req, reply) => {
      const { id } = req.params as { id: number };
      const ok = await markPrViewed(id, accountIdOf(req));
      if (!ok) {
        reply.status(404);
        return { error: 'NotFound', message: `PR ${id} not found` };
      }
      return { status: 'ok' };
    },
  );

  // Post a new issue-level (general) PR comment, then optimistically stamp it
  // locally so it shows before the next sync.
  app.post(
    '/api/prs/:id/comment',
    { schema: commentSchema },
    async (req, reply) => {
      const { id } = req.params as { id: number };
      const { body } = req.body as CreatePrCommentBody;
      const accountId = accountIdOf(req);

      const ctx = await getPrWriteContext(id, accountId);
      if (!ctx) {
        reply.status(404);
        return { error: 'NotFound', message: `PR ${id} not found` };
      }

      try {
        const token = await getAccessToken(accountId);
        const gh = await addIssueComment(
          token,
          ctx.owner,
          ctx.name,
          ctx.number,
          body,
        );
        const authorId = await getAccountUserId(accountId);
        const rowId = await upsertLocalPrComment(ctx.prId, authorId, gh);
        const result: CreatePrCommentResult = {
          id: rowId,
          authorId,
          body: gh.body,
          createdAt: new Date(gh.createdAt).toISOString(),
          url: gh.url,
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

  // Approve the PR. Server re-checks (matching getPrDetail.viewerCanApprove) that
  // the viewer has write+ permission and isn't the author; else 403. On success
  // submits an APPROVE review and stamps it locally. A GitHub 422 (e.g. a
  // self-approve race) bubbles to the 502 catch.
  app.post(
    '/api/prs/:id/approve',
    { schema: approveSchema },
    async (req, reply) => {
      const { id } = req.params as { id: number };
      const { body } = (req.body ?? {}) as ApprovePrBody;
      const accountId = accountIdOf(req);

      const ctx = await getPrWriteContext(id, accountId);
      if (!ctx) {
        reply.status(404);
        return { error: 'NotFound', message: `PR ${id} not found` };
      }

      const viewerUserId = await getAccountUserId(accountId);
      const canApprove =
        viewerUserId != null &&
        viewerUserId !== ctx.authorId &&
        ['WRITE', 'MAINTAIN', 'ADMIN'].includes(ctx.viewerPermission ?? '');
      if (!canApprove) {
        reply.status(403);
        return {
          error: 'NotPermitted',
          message:
            'You need write access to this repo and cannot approve your own PR.',
        };
      }

      try {
        const token = await getAccessToken(accountId);
        const gh = await submitPrReview(token, ctx.owner, ctx.name, ctx.number, {
          event: 'APPROVE',
          body,
        });
        const rowId = await upsertLocalReview(ctx.prId, viewerUserId, gh);
        const result: ApprovePrResult = {
          id: rowId,
          authorId: viewerUserId,
          state: 'approved',
          body: gh.body,
          submittedAt: new Date(gh.submittedAt).toISOString(),
          url: gh.url,
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

  // Add ONE inline review comment, posted immediately. Validates the requested
  // (path, line, side) lands on an addable diff line; if not, re-anchors to the
  // file's first changed line; if the file has no changes at all, returns a
  // not-anchored result without posting.
  app.post(
    '/api/prs/:id/review-comment',
    { schema: reviewCommentSchema },
    async (req, reply) => {
      const { id } = req.params as { id: number };
      const { path, line, body } = req.body as AddReviewCommentBody;
      const side: 'LEFT' | 'RIGHT' =
        (req.body as AddReviewCommentBody).side ?? 'RIGHT';
      const accountId = accountIdOf(req);

      const ctx = await getPrWriteContext(id, accountId);
      if (!ctx) {
        reply.status(404);
        return { error: 'NotFound', message: `PR ${id} not found` };
      }

      try {
        const token = await getAccessToken(accountId);
        // Resolve the LIVE head (not the possibly-stale DB head): commit_id must
        // pin to the same commit whose diff we validate the line against below,
        // or GitHub 422s the line as "not part of the diff".
        const head = await fetchHeadShaFor(
          token,
          ctx.owner,
          ctx.name,
          ctx.number,
        );

        // Find the requested file's REST patch (header-less) to validate anchoring.
        const { files } = await fetchPrFilesWithPatch(
          token,
          ctx.owner,
          ctx.name,
          ctx.number,
        );
        const file = files.find((f) => f.filename === path);
        const anchors = buildFileAnchors(path, file?.patch ?? null);
        // A single-file AnchorIndex for the pure helpers.
        const index = new Map([[path, anchors]]);

        let finalLine = line;
        let finalSide = side;
        let anchored = true;
        if (!isFindingAnchored(index, path, line, side)) {
          const fb = fallbackAnchor(index, path);
          if (!fb) {
            // The file has no changes in the diff → can't post inline.
            const result: AddReviewCommentResult = {
              commentId: null,
              url: null,
              line,
              side,
              anchored: false,
            };
            return result;
          }
          finalLine = fb.line;
          finalSide = fb.side;
          anchored = false;
        }

        const gh = await postInlineComment(
          token,
          ctx.owner,
          ctx.name,
          ctx.number,
          { commitId: head, path, line: finalLine, side: finalSide, body },
        );
        const result: AddReviewCommentResult = {
          commentId: gh.databaseId,
          url: gh.url,
          line: finalLine,
          side: finalSide,
          anchored,
        };
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // A 422 means GitHub rejected the line as not part of the diff (e.g. the
        // head shifted between our diff fetch and the post). Surface it as the
        // structured "couldn't place" result so the FE's recovery UX engages
        // (open on GitHub) instead of a generic error toast.
        if (/->\s*422\b/.test(message)) {
          const result: AddReviewCommentResult = {
            commentId: null,
            url: null,
            line,
            side,
            anchored: false,
          };
          return result;
        }
        reply.status(502);
        return { error: 'GitHubError', message };
      }
    },
  );

  // Changes tab: per-file diff patches, loaded on demand. Degrades to an empty
  // list on a GitHub fetch error (never 500s) so the tab fails gracefully.
  app.get('/api/prs/:id/files', { schema: idParamSchema }, async (req, reply) => {
    const { id } = req.params as { id: number };
    const accountId = accountIdOf(req);

    const ctx = await getPrFilesContext(id, accountId);
    if (!ctx) {
      reply.status(404);
      return { error: 'NotFound', message: `PR ${id} not found` };
    }

    try {
      const token = await getAccessToken(accountId);
      const { files, truncated } = await fetchPrFilesWithPatch(
        token,
        ctx.owner,
        ctx.name,
        ctx.number,
      );
      const mapped: PrFileDiff[] = files.map((f) => ({
        path: f.filename,
        previousPath: f.previous_filename ?? null,
        status: normalizeStatus(f.status),
        additions: f.additions,
        deletions: f.deletions,
        patch: f.patch ?? null,
        githubUrl: `${ctx.prUrl}/files#diff-${diffAnchorId(f.filename)}`,
        blobUrl: f.blob_url,
      }));
      const result: PrFilesResponse = { files: mapped, truncated };
      return result;
    } catch {
      // Graceful degrade — the Changes tab shows "no files" rather than 500ing.
      const result: PrFilesResponse = { files: [], truncated: false };
      return result;
    }
  });
}
