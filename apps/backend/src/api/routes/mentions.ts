import type { FastifyInstance } from 'fastify';
import type { MentionCandidate } from '@pierre-review/shared';
import { getScopeMentionCandidates, resolveWorkspaceScope } from '../../db/queries.js';
import { accountIdOf } from '../plugins/auth.js';

// Workspace-wide @mention candidates (CORE) — the scope-wide sibling of
// GET /api/prs/:id/mention-candidates. Powers the ad-hoc Insights "Ask about the workspace" box,
// whose questions span the whole selected scope rather than one PR.
//
// `?workspace=<id>` is a plain integer; absent / unparseable / another tenant's id all resolve to
// the account's DEFAULT workspace (never a 404 — every id yields the same response shape, so it is
// not an existence oracle). `resolveWorkspaceScope` turns it into the workspace's repo ids
// server-side, so a caller cannot widen it, and an empty workspace yields `[]` → no candidates,
// rather than the account's whole roster. Self + bots excluded. Returns a bare MentionCandidate[]
// exactly like the PR route so MentionTextarea can consume it directly — each row carrying
// `isMaintainer` (has merged a PR in the SCOPE's repos), which the picker sorts and shields on.
export async function mentionsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/mention-candidates', async (req): Promise<MentionCandidate[]> => {
    const q = req.query as { workspace?: string };
    const accountId = accountIdOf(req);
    const scope = await resolveWorkspaceScope(accountId, q.workspace);
    return getScopeMentionCandidates(accountId, scope.repoIds);
  });
}
