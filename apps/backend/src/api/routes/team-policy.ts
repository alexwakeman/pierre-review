import type { FastifyInstance } from 'fastify';
import { and, eq, inArray } from 'drizzle-orm';
import { describeTeamPolicy, type RepoTeamPolicy, type TeamPolicyClashChoiceBody, type TeamPolicyResponse } from '@pierre-review/shared';
import { accountIdOf } from '../plugins/auth.js';
import { db, schema } from '../../db/client.js';
import { resolveWorkspaceScope } from '../../db/queries.js';
import { setWorkspaceClashChoice, storedRepoTeamPolicies, workspaceClashChoice } from '../../db/team-policy.js';
import { orgFeaturesUnlockedFor } from '../../licence/status.js';

// THE TEAM POLICY, for Settings → Team policy (docs/TEAM-POLICY.md; docs/API.md § Team policy).
// DB only: the policies were read from each repo's default branch by sync. No GitHub call, no model.
//
//   GET /api/team-policy?workspace=<id> → TeamPolicyResponse: every member repo, its policy (or
//   problems, or none), whether THIS copy applies policies (a licence key or the evaluation), and the
//   workspace's choice for when repositories' policies differ.
//   PUT /api/team-policy/clash?workspace=<id> { repoId | null } → the new TeamPolicyResponse; 400 when
//   the repo is not one of the workspace's members.
const clashBody = {
  type: 'object',
  required: ['repoId'],
  additionalProperties: false,
  properties: { repoId: { type: ['integer', 'null'], minimum: 1 } },
} as const;

async function teamPolicyFor(accountId: number, workspace: string | number | undefined): Promise<TeamPolicyResponse> {
  const scope = await resolveWorkspaceScope(accountId, workspace);
  const [stored, applied, names, chosen] = await Promise.all([
    storedRepoTeamPolicies(accountId, scope.repoIds),
    orgFeaturesUnlockedFor(accountId),
    scope.repoIds.length === 0
      ? Promise.resolve([])
      : db
          .select({ id: schema.repos.id, owner: schema.repos.owner, name: schema.repos.name })
          .from(schema.repos)
          .where(and(eq(schema.repos.accountId, accountId), inArray(schema.repos.id, scope.repoIds)))
          .execute(),
    workspaceClashChoice(accountId, scope.workspaceId),
  ]);
  const repos: RepoTeamPolicy[] = names
    .map((r) => {
      const s = stored.get(r.id);
      const state: RepoTeamPolicy['state'] = s == null ? 'none' : s.policy == null ? 'invalid' : 'ok';
      return {
        repoId: r.id,
        repo: `${r.owner}/${r.name}`,
        state,
        policy: s?.policy ?? null,
        rules: s?.policy != null ? describeTeamPolicy(s.policy) : [],
        errors: s?.errors ?? [],
        commitOid: s?.commitOid ?? null,
        readAt: s?.readAt.toISOString() ?? null,
      };
    })
    // Repos with a file first, then by name.
    .sort((a, b) => Number(a.state === 'none') - Number(b.state === 'none') || a.repo.localeCompare(b.repo));
  const chosenRepo = chosen == null ? undefined : repos.find((r) => r.repoId === chosen);
  return {
    workspaceId: scope.workspaceId,
    applied,
    notAppliedReason: applied ? null : 'no_licence',
    repos,
    clash: { repoId: chosen, repo: chosenRepo?.repo ?? null, usable: chosen == null || chosenRepo?.state === 'ok' },
  };
}

export async function teamPolicyRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/team-policy', async (req): Promise<TeamPolicyResponse> => {
    const q = req.query as { workspace?: string };
    return teamPolicyFor(accountIdOf(req), q.workspace);
  });

  app.put<{ Body: TeamPolicyClashChoiceBody }>('/api/team-policy/clash', { schema: { body: clashBody } }, async (req, reply) => {
    const accountId = accountIdOf(req);
    const q = req.query as { workspace?: string };
    const scope = await resolveWorkspaceScope(accountId, q.workspace);
    if (!(await setWorkspaceClashChoice(accountId, scope.workspaceId, req.body.repoId))) {
      return reply.status(400).send({ error: 'not_a_member', message: 'That repository is not in this workspace.' });
    }
    return teamPolicyFor(accountId, scope.workspaceId);
  });
}
