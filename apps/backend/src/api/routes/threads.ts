import type { FastifyInstance } from 'fastify';
import type {
  ReplyResult,
  ReplyToThreadBody,
  ResolveThreadBody,
  ResolveThreadResult,
} from '@pierre-review/shared';
import { getAccessToken, getAccountUserId } from '../../auth/account.js';
import {
  getThreadDetail,
  getThreadWriteContext,
  stampThreadRepliedState,
  stampThreadResolved,
  upsertLocalReply,
} from '../../db/queries.js';
import {
  addReviewThreadReply,
  setReviewThreadResolved,
} from '../../github/mutations.js';
import { hydrateThreadDetail } from '../../sync/hydrate-detail.js';
import { accountIdOf } from '../plugins/auth.js';

const idParamSchema = {
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'integer' } },
  },
};

const replySchema = {
  ...idParamSchema,
  body: {
    type: 'object',
    required: ['body'],
    additionalProperties: false,
    properties: { body: { type: 'string' } },
  },
};

const resolveSchema = {
  ...idParamSchema,
  body: {
    type: 'object',
    required: ['resolved'],
    additionalProperties: false,
    properties: { resolved: { type: 'boolean' } },
  },
};

export async function threadRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/threads/:id', { schema: idParamSchema }, async (req, reply) => {
    const { id } = req.params as { id: number };
    const accountId = accountIdOf(req);
    const thread = await getThreadDetail(id, accountId);
    if (!thread) {
      reply.status(404);
      return { error: 'NotFound', message: `Thread ${id} not found` };
    }
    return hydrateThreadDetail(thread, accountId);
  });

  // Reply to an existing review thread. GraphQL addPullRequestReviewThreadReply,
  // then optimistically stamp the new comment locally so it shows before sync.
  app.post(
    '/api/threads/:id/reply',
    { schema: replySchema },
    async (req, reply) => {
      const { id } = req.params as { id: number };
      const { body } = req.body as ReplyToThreadBody;
      const accountId = accountIdOf(req);

      const ctx = await getThreadWriteContext(id, accountId);
      if (!ctx) {
        reply.status(404);
        return { error: 'NotFound', message: `Thread ${id} not found` };
      }

      try {
        const token = await getAccessToken(accountId);
        const gh = await addReviewThreadReply(token, ctx.threadNodeId, body);
        const authorId = await getAccountUserId(accountId);
        const rowId = await upsertLocalReply(ctx.prId, id, authorId, gh);
        // Bump the parent thread off 'untouched' so its badge reflects the reply
        // before the next sync re-derives.
        await stampThreadRepliedState(id);
        const result: ReplyResult = {
          id: rowId,
          authorId,
          body: gh.body,
          diffHunk: null,
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

  // Resolve (resolved=true) or unresolve (resolved=false) a review thread, then
  // stamp the local derivedState so the UI reflects it before the next sync.
  app.post(
    '/api/threads/:id/resolve',
    { schema: resolveSchema },
    async (req, reply) => {
      const { id } = req.params as { id: number };
      const { resolved } = req.body as ResolveThreadBody;
      const accountId = accountIdOf(req);

      const ctx = await getThreadWriteContext(id, accountId);
      if (!ctx) {
        reply.status(404);
        return { error: 'NotFound', message: `Thread ${id} not found` };
      }

      try {
        const token = await getAccessToken(accountId);
        const gh = await setReviewThreadResolved(
          token,
          ctx.threadNodeId,
          resolved,
        );
        // Ownership already confirmed above, so the stamp is non-null.
        const derivedState = await stampThreadResolved(id, resolved, accountId);
        const result: ResolveThreadResult = {
          threadId: id,
          isResolved: gh.isResolved,
          derivedState: derivedState ?? (resolved ? 'resolved' : 'untouched'),
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
