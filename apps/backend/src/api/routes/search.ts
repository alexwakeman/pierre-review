import type { FastifyInstance } from 'fastify';
import type { SearchHitKind, SearchResponse } from '@pierre-review/shared';
import { resolveScopeRepoIds } from '../../db/queries.js';
import { searchPrs } from '../../db/search.js';
import { accountIdOf } from '../plugins/auth.js';

// Cross-team full-text search (CORE, no AI). GET /api/search?q=&scope=&kinds=&limit=&offset=
// searches the local `search_index` (PR titles + descriptions, review bodies, review-comments,
// PR-comments, and authors) across the caller's team/repo scope. `scope` mirrors the Insights /
// Activity scope string ('all' | 'none' | 'teams' | '<teamId>'), resolved to the account's repo set
// server-side (resolveScopeRepoIds) so a caller can't widen it. `kinds` (comma-separated) optionally
// narrows to one or more hit kinds. Account-scoped in the query layer → no cross-tenant leak.
const VALID_KINDS: ReadonlySet<string> = new Set(['pr', 'review', 'review_comment', 'pr_comment']);
const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 25;

export async function searchRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/search', async (req): Promise<SearchResponse> => {
    const q = req.query as {
      q?: string;
      scope?: string;
      kinds?: string;
      limit?: string;
      offset?: string;
    };
    const accountId = accountIdOf(req);
    const query = (q.q ?? '').trim();
    if (query === '') return { query: '', hits: [], people: [], total: 0 };

    const repoIds = await resolveScopeRepoIds(accountId, q.scope ?? 'all');
    const kinds = (q.kinds ?? '')
      .split(',')
      .map((k) => k.trim())
      .filter((k): k is SearchHitKind => VALID_KINDS.has(k));

    const limRaw = Number.parseInt(q.limit ?? '', 10);
    const offRaw = Number.parseInt(q.offset ?? '', 10);
    const limit = Number.isFinite(limRaw) && limRaw > 0 ? Math.min(limRaw, MAX_LIMIT) : DEFAULT_LIMIT;
    const offset = Number.isFinite(offRaw) && offRaw > 0 ? offRaw : 0;

    return searchPrs(accountId, {
      query,
      repoIds,
      kinds: kinds.length > 0 ? kinds : undefined,
      limit,
      offset,
    });
  });
}
