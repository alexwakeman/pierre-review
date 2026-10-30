import type { FastifyInstance } from 'fastify';
import {
  DEPENDENCY_ECOSYSTEMS,
  DEPENDENCY_MERGE_ALL_MAX,
  DEPENDENCY_UPDATE_LEVELS,
  type DependencyAutomationLogResponse,
  type DependencyAutomationPatch,
  type DependencyMergeAllBody,
  type DependencyMergeAllResponse,
  type WorkspaceDependencyAutoMergeResponse,
} from '@pierre-review/shared';
import { resolveWorkspaceScope } from '../../db/queries.js';
import {
  getDependencyAutoMerge,
  runDependencyMergeAll,
  setDependencyAutoMerge,
} from '../../merge/dependency-policy.js';
import {
  getDependencyAutomation,
  listDependencyAutomationLog,
  setDependencyAutomation,
} from '../../merge/dependency-automation.js';
import { accountIdOf } from '../plugins/auth.js';

// DEPENDENCY AUTO-MERGE (CORE, free, both modes) — docs/MERGE-CI-TRUNK.md § Dependency auto-merge.
//
//   POST /api/dependencies/merge-all?workspace=  Pending → Dependencies' "Merge or arm all". Body
//        { prIds, dryRun? }: the tab's listed PRs, re-checked one by one (account, workspace,
//        open, dependency automation, write access). Sequential; `github_write` tier.
//   GET / PUT /api/workspaces/:id/dependency-auto-merge  the per-workspace setting, OFF by default.
//        DB-only; ownership → 404.
//   GET / PUT /api/workspaces/:id/dependency-automation  Settings → Dependencies: the three switches
//        (merge, approve, resolve conflicts), the policy and the trusted bots. DB-only; → 404.
//   GET /api/dependencies/automation-log?workspace=  what the automation did (Pending →
//        Dependencies, fetched on a click). DB-only.

/** The most the Dependencies tab can list (shared, so the SPA sends at most this too). */
const MERGE_ALL_MAX = DEPENDENCY_MERGE_ALL_MAX;

const mergeAllSchema = {
  body: {
    type: 'object',
    required: ['prIds'],
    additionalProperties: false,
    properties: {
      prIds: {
        type: 'array',
        maxItems: MERGE_ALL_MAX,
        items: { type: 'integer', minimum: 1 },
      },
      dryRun: { type: 'boolean' },
    },
  },
};

const idParam = {
  params: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } },
};

export async function dependencyMergeRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/dependencies/merge-all', { schema: mergeAllSchema }, async (req) => {
    const accountId = accountIdOf(req);
    const q = req.query as { workspace?: string };
    const body = req.body as DependencyMergeAllBody;
    const scope = await resolveWorkspaceScope(accountId, q.workspace);
    const dryRun = body.dryRun === true;
    const items = await runDependencyMergeAll({
      accountId,
      workspaceId: scope.workspaceId,
      repoIds: scope.repoIds,
      prIds: body.prIds,
      dryRun,
      log: req.log,
    });
    const resp: DependencyMergeAllResponse = { workspaceId: scope.workspaceId, dryRun, items };
    return resp;
  });

  app.get('/api/workspaces/:id/dependency-auto-merge', { schema: idParam }, async (req, reply) => {
    const { id } = req.params as { id: number };
    const setting = await getDependencyAutoMerge(accountIdOf(req), id);
    if (!setting) {
      reply.status(404);
      return { error: 'NotFound', message: `Workspace ${id} not found` };
    }
    const resp: WorkspaceDependencyAutoMergeResponse = {
      workspaceId: id,
      dependencyAutoMerge: setting,
    };
    return resp;
  });

  app.put(
    '/api/workspaces/:id/dependency-auto-merge',
    {
      schema: {
        ...idParam,
        body: {
          type: 'object',
          required: ['enabled'],
          additionalProperties: false,
          properties: { enabled: { type: 'boolean' } },
        },
      },
      // Fastify's validator COERCES types, so `"true"` or 1 would read as a switch. Raw check.
      preValidation: async (req, reply) => {
        const raw = (req.body ?? {}) as Record<string, unknown>;
        if (typeof raw.enabled !== 'boolean') {
          reply.status(400);
          return reply.send({ error: 'BadRequest', message: '`enabled` must be true or false.' });
        }
      },
    },
    async (req, reply) => {
      const accountId = accountIdOf(req);
      const { id } = req.params as { id: number };
      const { enabled } = req.body as { enabled: boolean };
      if (!(await setDependencyAutoMerge(accountId, id, enabled))) {
        reply.status(404);
        return { error: 'NotFound', message: `Workspace ${id} not found` };
      }
      const resp: WorkspaceDependencyAutoMergeResponse = {
        workspaceId: id,
        dependencyAutoMerge: { enabled },
      };
      return resp;
    },
  );

  app.get('/api/dependencies/automation-log', async (req) => {
    const accountId = accountIdOf(req);
    const q = req.query as { workspace?: string };
    const scope = await resolveWorkspaceScope(accountId, q.workspace);
    const resp: DependencyAutomationLogResponse = {
      workspaceId: scope.workspaceId,
      items: await listDependencyAutomationLog(accountId, scope.repoIds),
    };
    return resp;
  });

  app.get('/api/workspaces/:id/dependency-automation', { schema: idParam }, async (req, reply) => {
    const { id } = req.params as { id: number };
    const resp = await getDependencyAutomation(accountIdOf(req), id);
    if (!resp) {
      reply.status(404);
      return { error: 'NotFound', message: `Workspace ${id} not found` };
    }
    return resp;
  });

  app.put(
    '/api/workspaces/:id/dependency-automation',
    {
      schema: {
        ...idParam,
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            autoMerge: { type: 'boolean' },
            autoApprove: { type: 'boolean' },
            autoResolveConflicts: { type: 'boolean' },
            maxLevel: { type: 'string', enum: [...DEPENDENCY_UPDATE_LEVELS] },
            securityOnly: { type: 'boolean' },
            ecosystems: {
              type: ['array', 'null'],
              maxItems: DEPENDENCY_ECOSYSTEMS.length,
              items: { type: 'string', enum: [...DEPENDENCY_ECOSYSTEMS] },
            },
            trustedBotIds: { type: 'array', maxItems: 200, items: { type: 'integer', minimum: 1 } },
          },
        },
      },
      // Fastify's validator COERCES types, so `"true"` or 1 would read as a switch. Raw check.
      preValidation: async (req, reply) => {
        const raw = (req.body ?? {}) as Record<string, unknown>;
        for (const k of ['autoMerge', 'autoApprove', 'autoResolveConflicts', 'securityOnly']) {
          if (k in raw && typeof raw[k] !== 'boolean') {
            reply.status(400);
            return reply.send({ error: 'BadRequest', message: `\`${k}\` must be true or false.` });
          }
        }
      },
    },
    async (req, reply) => {
      const accountId = accountIdOf(req);
      const { id } = req.params as { id: number };
      const patch = req.body as DependencyAutomationPatch;
      if (!(await setDependencyAutomation(accountId, id, patch))) {
        reply.status(404);
        return { error: 'NotFound', message: `Workspace ${id} not found` };
      }
      return await getDependencyAutomation(accountId, id);
    },
  );
}
