import type { FastifyInstance } from 'fastify';
import type {
  Workspace,
  WorkspacePendingMuteUpdate,
  WorkspacesResponse,
} from '@pierre-review/shared';
import {
  assignReposToWorkspace,
  createWorkspace,
  deleteWorkspace,
  listWorkspaces,
  rehomeReposToDefault,
  renameWorkspace,
} from '../../db/queries.js';
import { setWorkspacePendingMute } from '../../db/pending-mute.js';
import { accountIdOf } from '../plugins/auth.js';

// Workspaces (CORE): the ONE scope this app has. A workspace groups an account's repos, and a repo
// belongs to EXACTLY ONE workspace — a database fact (`workspace_repos`, UNIQUE (account_id,
// repo_id)). Every handler is accountId-scoped; id-addressed routes verify ownership (→ 404).
//
// ⚠ ASSIGNMENT IS A MOVE, NOT AN ADD, AND THERE IS NO "UNASSIGN". The old `DELETE
// /api/teams/:id/repos/:repoId` route is GONE and must not come back: there is no "belongs to no
// workspace" state to drop a repo into, so removing it from a workspace *is* moving it to the
// account's Default. The client expresses that by POSTing the repo to Default (or by omitting it
// from a PATCH's `repoIds`, which re-homes it here).
//
// ⚠ ASSIGNMENT WRITES MEMBERSHIP AND NOTHING ELSE. There is no second visibility axis any more:
// the "watched" concept (`repos.inbox_watch`) is DELETED, so every repo in a workspace is fully
// live — Feed, Activity, My Turn and Bots all cover it. `assignReposToWorkspace` therefore touches
// only `workspace_repos`, and the drop path (`rehomeReposToDefault`) touches only `workspace_repos`
// too. Do not reintroduce a per-repo visibility flag here: the workspace IS the scope.
//
// ⚠ THE PENDING MUTE IS NOT THAT FLAG, AND THE DISTINCTION IS EXACT. `PUT /:id/pending-mute`
// (below) writes `workspaces.pending_muted` and `pending_muted_repos` — the two independently-owned
// halves of "stop these Pending items claiming my turn". A muted repo stays FULLY LIVE on every
// screen: Feed, Timeline, Activity, Bots and the Pending board all still cover it, and the broad
// `myTurn` count is unchanged. What a mute moves is the OWNERSHIP CLAIM a row makes — `getMyTurn`
// downgrades its `relevance` to 'none' — so the card relabels to the neutral "Review or reply",
// the browser notification stops and the `myTurnPersonal` figures drop it. `inbox_watch` decided
// whether work APPEARED (a second scope competing with membership, which is why it went); this
// decides whether work may INTERRUPT. Membership is still the only visibility axis. It is also
// deliberately NOT part of the PATCH above: a mute is not a rename and not a membership move, and
// one Save that could do all three is one Save whose blast radius nobody can state.
//
// ⚠ THE DEFAULT WORKSPACE IS RENAMEABLE BUT NOT DELETABLE. DELETE returns **409
// `{error:'DefaultWorkspace'}`** for it — a distinct, explained status, not a 500 out of the
// constraint and not a 404 pretending it isn't there: it is where new repos land and where a
// deleted workspace's repos and reviewer rows are re-homed, so its absence has no meaning.

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

// ⚠ BOTH KEYS OPTIONAL, AND `{}` IS A LEGAL NO-OP. The two halves are independently owned, so a
// Save that touched only one must not carry an invented value for the other — `undefined` means
// "leave this fact alone", which is what makes the union a union rather than a chain. Bounded
// `repoIds` because the body is attacker-shaped; ids outside the workspace's membership are
// IGNORED by the writer rather than rejected, so a stale client list degrades instead of 400ing.
const pendingMuteSchema = {
  ...idParamSchema,
  body: {
    type: 'object',
    additionalProperties: false,
    properties: {
      muted: { type: 'boolean' },
      mutedRepoIds: { type: 'array', items: { type: 'integer' }, maxItems: 2000 },
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

export async function workspaceRoutes(app: FastifyInstance): Promise<void> {
  // Account-scoped ownership lookup (→ null for a foreign/unknown workspace, so every one of those
  // 404s rather than becoming an existence oracle over another tenant's ids). `listWorkspaces` also
  // repairs the two silent invariants — every account has a Default, every repo has a membership
  // row — so a handler that reaches this has a coherent picture to act on.
  const findWorkspace = async (accountId: number, id: number): Promise<Workspace | null> =>
    (await listWorkspaces(accountId)).find((w) => w.id === id) ?? null;

  app.get('/api/workspaces', async (req): Promise<WorkspacesResponse> => ({
    workspaces: await listWorkspaces(accountIdOf(req)),
  }));

  app.post('/api/workspaces', { schema: nameBodySchema }, async (req, reply) => {
    const accountId = accountIdOf(req);
    const name = (req.body as { name: string }).name.trim();
    if (!name) {
      reply.status(400);
      return { error: 'BadRequest', message: 'Workspace name must not be empty' };
    }
    const existing = await listWorkspaces(accountId);
    if (existing.some((w) => w.name === name)) {
      reply.status(400);
      return { error: 'BadRequest', message: `A workspace named "${name}" already exists` };
    }
    try {
      // Always `isDefault: false` — `ensureDefaultWorkspace` is the only writer of `true`, and the
      // partial unique index would reject a second one anyway.
      const workspace = await createWorkspace(accountId, name);
      reply.status(201);
      return { workspace };
    } catch {
      // Unique-constraint fallback (a concurrent create raced us to the same name).
      reply.status(400);
      return { error: 'BadRequest', message: `A workspace named "${name}" already exists` };
    }
  });

  // Rename and/or SET the membership to exactly `repoIds`. Ownership → 404.
  //
  // `repoIds` is the workspace's exact intended membership, diffed against what it holds now:
  //   • ids ADDED are MOVED in from wherever they were.
  //   • ids DROPPED go to the account's Default via `rehomeReposToDefault`.
  // Both sides are MEMBERSHIP-ONLY writes — no `repos` UPDATE on either path.
  // ⚠ Dropping an id from the DEFAULT workspace's own membership is a legal no-op: Default is where
  // "removed" repos go, so there is nowhere further to move them. That is the model, not a bug —
  // the only way a repo leaves Default is by being assigned to another workspace.
  app.patch('/api/workspaces/:id', { schema: patchSchema }, async (req, reply) => {
    const accountId = accountIdOf(req);
    const { id } = req.params as { id: number };
    const { name, repoIds } = req.body as { name?: string; repoIds?: number[] };
    const current = await findWorkspace(accountId, id);
    if (!current) {
      reply.status(404);
      return { error: 'NotFound', message: `Workspace ${id} not found` };
    }

    if (name !== undefined) {
      const trimmed = name.trim();
      if (!trimmed) {
        reply.status(400);
        return { error: 'BadRequest', message: 'Workspace name must not be empty' };
      }
      // Reject a rename that collides with another workspace's name. RENAMING THE DEFAULT IS
      // ALLOWED: it is not deletable, which is a different thing — a user who wants to call their
      // primary workspace "Platform" is not asking to remove the fallback everything re-homes into.
      const others = (await listWorkspaces(accountId)).filter((w) => w.id !== id);
      if (others.some((w) => w.name === trimmed)) {
        reply.status(400);
        return { error: 'BadRequest', message: `A workspace named "${trimmed}" already exists` };
      }
      try {
        await renameWorkspace(id, accountId, trimmed);
      } catch {
        reply.status(400);
        return { error: 'BadRequest', message: `A workspace named "${trimmed}" already exists` };
      }
    }

    if (repoIds !== undefined) {
      const target = new Set(repoIds);
      const toAdd = repoIds.filter((r) => !current.repoIds.includes(r));
      const toRemove = current.repoIds.filter((r) => !target.has(r));
      if (toAdd.length > 0) await assignReposToWorkspace(id, accountId, toAdd);
      if (toRemove.length > 0) await rehomeReposToDefault(accountId, toRemove);
    }

    const workspace = await findWorkspace(accountId, id);
    if (!workspace) {
      reply.status(404);
      return { error: 'NotFound', message: `Workspace ${id} not found` };
    }
    return { workspace };
  });

  // Delete a workspace. Its repos AND its reviewer rows are re-homed to Default inside one
  // transaction FIRST (`deleteWorkspace`), so the FK cascade finds nothing to destroy — without
  // that step it would take every manual verdict, every manual vendor name and every price in the
  // workspace with it, silently and with no undo, while the repos survived.
  //
  // THREE OUTCOMES, THREE STATUSES: 404 for a foreign/unknown id, **409 `{error:'DefaultWorkspace'}`
  // for the default row**, 204 otherwise. The 409 is a real answer with a reason, not the 500 a bare
  // constraint violation would produce.
  app.delete('/api/workspaces/:id', { schema: idParamSchema }, async (req, reply) => {
    const accountId = accountIdOf(req);
    const { id } = req.params as { id: number };
    const outcome = await deleteWorkspace(id, accountId);
    if (outcome === 'not_found') {
      reply.status(404);
      return { error: 'NotFound', message: `Workspace ${id} not found` };
    }
    if (outcome === 'is_default') {
      reply.status(409);
      return {
        error: 'DefaultWorkspace',
        message:
          'The default workspace cannot be deleted: it is where new repos land and where the ' +
          'repos and reviewers of a deleted workspace are re-homed. Rename it instead.',
      };
    }
    reply.status(204);
    return null;
  });

  // MOVE one repo into this workspace. It is a MOVE:
  // the repo leaves whatever workspace it was in, because the (account_id, repo_id) unique means it
  // can only ever have one membership row. Ownership → 404; a repo the account doesn't own is
  // silently dropped by the query layer rather than acknowledged.
  app.post('/api/workspaces/:id/repos', { schema: addRepoSchema }, async (req, reply) => {
    const accountId = accountIdOf(req);
    const { id } = req.params as { id: number };
    const { repoId } = req.body as { repoId: number };
    if (!(await findWorkspace(accountId, id))) {
      reply.status(404);
      return { error: 'NotFound', message: `Workspace ${id} not found` };
    }
    await assignReposToWorkspace(id, accountId, [repoId]);
    const workspace = await findWorkspace(accountId, id);
    if (!workspace) {
      reply.status(404);
      return { error: 'NotFound', message: `Workspace ${id} not found` };
    }
    return { workspace };
  });

  // THE PENDING MUTE for this workspace — CORE and FREE on every tier, in both deployment modes.
  //
  // TWO INDEPENDENT FACTS, OR-ed, NEVER A CHAIN: `muted` is the whole workspace,
  // `mutedRepoIds` is the exact muted set WITHIN this workspace's membership. Either may be sent
  // alone. A repo is muted when either says so; clearing one neither reveals nor overwrites the
  // other. (`null`-means-inherit is a named bug class here — the reviewer price, the Slack target,
  // the sprint cadence all had it. There is no resolver, there is one union: db/pending-mute.ts.)
  //
  // ⚠ THE REPO LIST IS SCOPED TO THIS WORKSPACE'S MEMBERSHIP BY THE WRITER, and that is a
  // correctness rule: without it, saving workspace A's settings screen would clear every mute the
  // reader had set in workspaces B and C, because the stored row is repo-grained and carries no
  // workspace id. Ids outside the membership are ignored, and rows for repos outside it are left
  // alone. Tenancy is ALSO structural — `repo_id` arrives in this body and the composite FK
  // `(repo_id, account_id) → repos(id, account_id)` makes a cross-account pair fail in the
  // DATABASE, not in whichever handler remembered to check.
  //
  // Ownership → 404, like every other id-addressed route here. Echoes the refreshed workspace so
  // the client re-seeds from the server's answer rather than from what it just sent.
  app.put(
    '/api/workspaces/:id/pending-mute',
    { schema: pendingMuteSchema },
    async (req, reply) => {
      const accountId = accountIdOf(req);
      const { id } = req.params as { id: number };
      const patch = req.body as WorkspacePendingMuteUpdate;
      if (!(await setWorkspacePendingMute(accountId, id, patch))) {
        reply.status(404);
        return { error: 'NotFound', message: `Workspace ${id} not found` };
      }
      const workspace = await findWorkspace(accountId, id);
      if (!workspace) {
        reply.status(404);
        return { error: 'NotFound', message: `Workspace ${id} not found` };
      }
      return { workspace };
    },
  );

  // NOTE: there is deliberately NO `DELETE /api/workspaces/:id/repos/:repoId`. See the header
  // comment — "remove" is "move to Default", which the client expresses as
  // `POST /api/workspaces/<defaultId>/repos`.
}
