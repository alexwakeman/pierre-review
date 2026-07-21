import type { FastifyInstance } from 'fastify';
import type { User } from '@pierre-review/shared';
import { getScopeMentionCandidates, resolveScopeRepoIds } from '../../db/queries.js';
import { accountIdOf } from '../plugins/auth.js';

// Scope-wide @mention candidates (CORE) — the team/repo-scoped sibling of
// GET /api/prs/:id/mention-candidates. Powers the ad-hoc Insights "Ask about the sprint" box,
// whose questions span the whole selected scope rather than one PR. `scope` mirrors the Insights
// scope string ('all' | 'none' | 'teams' | '<teamId>'); it's resolved to the account's repo set
// server-side (resolveScopeRepoIds), so a caller can't widen it. Self + bots excluded. Returns a
// bare User[] exactly like the PR route so MentionTextarea can consume it directly.
export async function mentionsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/mention-candidates', async (req): Promise<User[]> => {
    const q = req.query as { scope?: string };
    const accountId = accountIdOf(req);
    const repoIds = await resolveScopeRepoIds(accountId, q.scope ?? 'all');
    return getScopeMentionCandidates(accountId, repoIds);
  });
}
