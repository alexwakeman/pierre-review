import type { FastifyInstance } from 'fastify';
import type {
  CreateRepoBody,
  RepoSearchResponse,
  RepoSearchResult,
} from '@gh-team-monitor/shared';
import { getGraphqlClient } from '../../github/client.js';
import {
  REPO_ID_QUERY,
  REPO_SEARCH_QUERY,
  type RepoIdResponse,
  type RepoSearchGqlResponse,
} from '../../github/queries.js';
import { upsertRepo } from '../../sync/upsert.js';
import {
  getSyncStatus,
  isSyncRunning,
  runSyncForRepo,
} from '../../sync/sync-manager.js';
import {
  deleteRepo,
  getRepo,
  getWatchedRepoNodeIds,
  listRepos,
} from '../../db/queries.js';

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

const syncSchema = {
  ...idParamSchema,
  querystring: {
    type: 'object',
    additionalProperties: false,
    properties: { full: { type: 'boolean', default: false } },
  },
};

const searchSchema = {
  querystring: {
    type: 'object',
    required: ['q'],
    additionalProperties: false,
    properties: {
      q: { type: 'string', minLength: 1, maxLength: 256 },
      cursor: { type: 'string', minLength: 1 },
      limit: { type: 'integer', default: 10, minimum: 1, maximum: 25 },
    },
  },
};

export async function repoRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/repos', async () => listRepos());

  // Live GitHub repository search for the Add-repo picker. Best-match ordering
  // (GitHub default), already-watched repos filtered out, owned/member repos
  // floated to the top. Detail comes straight from GitHub — nothing persisted.
  app.get('/api/repos/search', { schema: searchSchema }, async (req, reply) => {
    const { q, cursor, limit } = req.query as {
      q: string;
      cursor?: string;
      limit: number;
    };
    const term = q.trim();
    if (!term) {
      reply.status(400);
      return { error: 'BadRequest', message: 'Search query must not be empty' };
    }

    const client = getGraphqlClient();
    let resp: RepoSearchGqlResponse;
    try {
      // NB: the GraphQL variable is `searchQuery`, not `query` — @octokit/graphql
      // reserves `query` for the document body and rejects it as a variable name.
      resp = await client(REPO_SEARCH_QUERY, {
        searchQuery: term,
        first: limit,
        cursor: cursor ?? null,
      });
    } catch (err) {
      reply.status(502);
      return {
        error: 'GitHubError',
        message: err instanceof Error ? err.message : 'GitHub search failed',
      };
    }

    const watched = getWatchedRepoNodeIds();
    const me = resp.viewer.login.toLowerCase();
    const orgLogins = new Set(
      resp.viewer.organizations.nodes.map((o) => o.login.toLowerCase()),
    );

    const results: RepoSearchResult[] = resp.search.nodes
      // Guard the union: type:REPOSITORY yields repositories, but a non-repo node
      // would serialise as {} (no id) — drop those, then drop already-watched.
      .filter((n) => typeof n.id === 'string')
      .filter((n) => !watched.has(n.id))
      .map((n) => {
        const ownerLogin = n.owner.login;
        return {
          githubNodeId: n.id,
          owner: ownerLogin,
          name: n.name,
          fullName: n.nameWithOwner,
          description: n.description,
          ownerAvatarUrl: n.owner.avatarUrl,
          stargazerCount: n.stargazerCount,
          openPrCount: n.pullRequests.totalCount,
          url: n.url,
          isPrivate: n.isPrivate,
          isOwnedOrMember:
            ownerLogin.toLowerCase() === me ||
            orgLogins.has(ownerLogin.toLowerCase()),
        };
      });

    // Float owned/member repos to the top, preserving GitHub's best-match order
    // within each group (Array.prototype.sort is stable on Node ≥ 12).
    results.sort((a, b) => Number(b.isOwnedOrMember) - Number(a.isOwnedOrMember));

    const body: RepoSearchResponse = {
      results,
      hasNextPage: resp.search.pageInfo.hasNextPage,
      cursor: resp.search.pageInfo.endCursor,
    };
    return body;
  });

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
    // A sync in flight would re-create the repo (and its rows) right after we
    // delete them, since the sync's upserts are still running. Refuse until it
    // settles — the cron tick / initial backfill is short.
    if (isSyncRunning(id)) {
      reply.status(409);
      return {
        error: 'Conflict',
        message: 'A sync is running for this repo — try removing it again in a moment.',
      };
    }
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
    { schema: syncSchema },
    async (req, reply) => {
      const { id } = req.params as { id: number };
      if (!getRepo(id)) {
        reply.status(404);
        return { error: 'NotFound', message: `Repo ${id} not found` };
      }
      // ?full=true forces a full backfill (catches CI/thread-resolve changes
      // that don't bump PR.updatedAt and so lag the incremental path).
      const { full } = req.query as { full?: boolean };
      const started = runSyncForRepo(id, app.log, {
        background: true,
        forceFull: full === true,
      });
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
