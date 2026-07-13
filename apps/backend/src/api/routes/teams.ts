import type { FastifyInstance } from 'fastify';
import type { Team, TeamsResponse } from '@pierre-review/shared';
import {
  assignReposToTeam,
  createTeam,
  deleteTeam,
  getTeamRepoIds,
  listTeams,
  removeRepoFromTeam,
  renameTeam,
} from '../../db/queries.js';
import { accountIdOf } from '../plugins/auth.js';

// Teams (CORE): group an account's repos into named teams. Every handler is accountId-scoped;
// id-addressed routes verify ownership (→ 404). Assigning a repo to a team auto-Watches it.

const nameBodySchema = {
  body: {
    type: 'object',
    required: ['name'],
    additionalProperties: false,
    properties: { name: { type: 'string', minLength: 1, maxLength: 120 } },
  },
};

const idParamSchema = {
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'integer' } },
  },
};

const patchSchema = {
  ...idParamSchema,
  body: {
    type: 'object',
    additionalProperties: false,
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 120 },
      repoIds: { type: 'array', items: { type: 'integer' } },
    },
  },
};

const addRepoSchema = {
  ...idParamSchema,
  body: {
    type: 'object',
    required: ['repoId'],
    additionalProperties: false,
    properties: { repoId: { type: 'integer' } },
  },
};

const removeRepoSchema = {
  params: {
    type: 'object',
    required: ['id', 'repoId'],
    properties: { id: { type: 'integer' }, repoId: { type: 'integer' } },
  },
};

export async function teamRoutes(app: FastifyInstance): Promise<void> {
  // Account-scoped ownership lookup (→ null for a foreign/unknown team).
  const findTeam = async (accountId: number, id: number): Promise<Team | null> =>
    (await listTeams(accountId)).find((t) => t.id === id) ?? null;

  app.get('/api/teams', async (req): Promise<TeamsResponse> => ({
    teams: await listTeams(accountIdOf(req)),
  }));

  app.post('/api/teams', { schema: nameBodySchema }, async (req, reply) => {
    const accountId = accountIdOf(req);
    const name = (req.body as { name: string }).name.trim();
    if (!name) {
      reply.status(400);
      return { error: 'BadRequest', message: 'Team name must not be empty' };
    }
    const existing = await listTeams(accountId);
    if (existing.some((t) => t.name === name)) {
      reply.status(400);
      return { error: 'BadRequest', message: `A team named "${name}" already exists` };
    }
    try {
      const team = await createTeam(accountId, name);
      reply.status(201);
      return { team };
    } catch {
      // Unique-constraint fallback (a concurrent create raced us to the same name).
      reply.status(400);
      return { error: 'BadRequest', message: `A team named "${name}" already exists` };
    }
  });

  // Rename and/or REPLACE membership (set the team's repos to exactly `repoIds`). Ownership → 404.
  app.patch('/api/teams/:id', { schema: patchSchema }, async (req, reply) => {
    const accountId = accountIdOf(req);
    const { id } = req.params as { id: number };
    const { name, repoIds } = req.body as { name?: string; repoIds?: number[] };
    if (!(await findTeam(accountId, id))) {
      reply.status(404);
      return { error: 'NotFound', message: `Team ${id} not found` };
    }

    if (name !== undefined) {
      const trimmed = name.trim();
      if (!trimmed) {
        reply.status(400);
        return { error: 'BadRequest', message: 'Team name must not be empty' };
      }
      // Reject a rename that collides with another team's name.
      const others = (await listTeams(accountId)).filter((t) => t.id !== id);
      if (others.some((t) => t.name === trimmed)) {
        reply.status(400);
        return { error: 'BadRequest', message: `A team named "${trimmed}" already exists` };
      }
      await renameTeam(id, accountId, trimmed);
    }

    if (repoIds !== undefined) {
      // Diff current membership → target: assign the new ones (auto-watch), remove the missing.
      const current = await getTeamRepoIds(id, accountId);
      const target = new Set(repoIds);
      const toAdd = repoIds.filter((r) => !current.includes(r));
      const toRemove = current.filter((r) => !target.has(r));
      if (toAdd.length > 0) await assignReposToTeam(id, accountId, toAdd);
      for (const repoId of toRemove) await removeRepoFromTeam(id, repoId, accountId);
    }

    const team = await findTeam(accountId, id);
    return { team };
  });

  app.delete('/api/teams/:id', { schema: idParamSchema }, async (req, reply) => {
    const accountId = accountIdOf(req);
    const { id } = req.params as { id: number };
    const ok = await deleteTeam(id, accountId);
    if (!ok) {
      reply.status(404);
      return { error: 'NotFound', message: `Team ${id} not found` };
    }
    reply.status(204);
    return null;
  });

  // Assign ONE repo to a team (auto-watch). Ownership → 404.
  app.post('/api/teams/:id/repos', { schema: addRepoSchema }, async (req, reply) => {
    const accountId = accountIdOf(req);
    const { id } = req.params as { id: number };
    const { repoId } = req.body as { repoId: number };
    if (!(await findTeam(accountId, id))) {
      reply.status(404);
      return { error: 'NotFound', message: `Team ${id} not found` };
    }
    await assignReposToTeam(id, accountId, [repoId]);
    const team = await findTeam(accountId, id);
    return { team };
  });

  // Unassign ONE repo from a team. Ownership → 404; idempotent (unassigning a non-member 204s).
  app.delete(
    '/api/teams/:id/repos/:repoId',
    { schema: removeRepoSchema },
    async (req, reply) => {
      const accountId = accountIdOf(req);
      const { id, repoId } = req.params as { id: number; repoId: number };
      if (!(await findTeam(accountId, id))) {
        reply.status(404);
        return { error: 'NotFound', message: `Team ${id} not found` };
      }
      await removeRepoFromTeam(id, repoId, accountId);
      reply.status(204);
      return null;
    },
  );
}
