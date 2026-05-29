import type { FastifyInstance } from 'fastify';
import type { CreateRepoBody } from '@gh-team-monitor/shared';
import { getGraphqlClient } from '../../github/client.js';
import { REPO_ID_QUERY, type RepoIdResponse } from '../../github/queries.js';
import { upsertRepo } from '../../sync/upsert.js';
import {
  getSyncStatus,
  runSyncForRepo,
} from '../../sync/sync-manager.js';
import { deleteRepo, getRepo, listRepos } from '../../db/queries.js';

const createRepoSchema = {
  body: {
    type: 'object',
    required: ['owner', 'name'],
    additionalProperties: false,
    properties: {
      owner: { type: 'string', minLength: 1 },
      name: { type: 'string', minLength: 1 },
    },
  },
};

const idParamSchema = {
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'integer' } },
  },
};

export async function repoRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/repos', async () => listRepos());

  app.post('/api/repos', { schema: createRepoSchema }, async (req, reply) => {
    const { owner, name } = req.body as CreateRepoBody;

    const client = getGraphqlClient();
    let resp: RepoIdResponse;
    try {
      resp = await client(REPO_ID_QUERY, { owner, name });
    } catch (err) {
      reply.status(502);
      return {
        error: 'GitHubError',
        message: err instanceof Error ? err.message : 'GitHub request failed',
      };
    }
    if (!resp.repository) {
      reply.status(404);
      return {
        error: 'NotFound',
        message: `Repository ${owner}/${name} not found or inaccessible. Check the name and your gh auth / SSO.`,
      };
    }

    const canonOwner = resp.repository.owner.login;
    const canonName = resp.repository.name;
    const repoId = upsertRepo(canonOwner, canonName, resp.repository.id);

    // Kick off the initial backfill in the background.
    runSyncForRepo(repoId, app.log, { background: true });

    reply.status(201);
    return getRepo(repoId);
  });

  app.delete('/api/repos/:id', { schema: idParamSchema }, async (req, reply) => {
    const { id } = req.params as { id: number };
    const ok = deleteRepo(id);
    if (!ok) {
      reply.status(404);
      return { error: 'NotFound', message: `Repo ${id} not found` };
    }
    reply.status(204);
    return null;
  });

  app.post(
    '/api/repos/:id/sync',
    { schema: idParamSchema },
    async (req, reply) => {
      const { id } = req.params as { id: number };
      if (!getRepo(id)) {
        reply.status(404);
        return { error: 'NotFound', message: `Repo ${id} not found` };
      }
      const started = runSyncForRepo(id, app.log, { background: true });
      if (!started) {
        reply.status(409);
        return { error: 'Conflict', message: 'A sync is already running for this repo' };
      }
      reply.status(202);
      return { status: 'started' };
    },
  );

  app.get(
    '/api/repos/:id/sync-status',
    { schema: idParamSchema },
    async (req, reply) => {
      const { id } = req.params as { id: number };
      const status = getSyncStatus(id);
      if (!getRepo(id)) {
        reply.status(404);
        return { error: 'NotFound', message: `Repo ${id} not found` };
      }
      return status;
    },
  );
}
