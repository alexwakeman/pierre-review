import type { FastifyInstance } from 'fastify';
import type { SearchHitKind, SearchResponse } from '@pierre-review/shared';
import { resolveWorkspaceScope } from '../../db/queries.js';
import { searchPrs } from '../../db/search.js';
import { accountIdOf } from '../plugins/auth.js';

// Workspace-wide full-text search (CORE, no AI). GET /api/search?q=&workspace=&kinds=&limit=&offset=
// searches the local `search_index` (PR titles + descriptions, review bodies, review-comments,
// PR-comments, and authors) across the active workspace's repos. `workspace` is a plain integer;
// absent / unparseable / another tenant's id all resolve to the account's DEFAULT workspace (never
// a 404 — every id yields the same response shape, so it is not an existence oracle). It is
// resolved to a repo set server-side (`resolveWorkspaceScope`) so a caller can't widen it, and an
// empty workspace resolves to `[]` → no hits, rather than the whole account. `kinds`
// (comma-separated) optionally narrows to one or more hit kinds. Account-scoped in the query layer
// → no cross-tenant leak.
//
// `stories` (first page only): tickets whose key matches the query (exact, then prefix) or whose title
// contains it, from the stored ticket rows of the searched repos' PRs + the workspace's sprint tickets
// (`findStories`, db/search.ts). The SPA lists them FIRST; a click opens the ticket's story tab.
const VALID_KINDS: ReadonlySet<string> = new Set(['pr', 'review', 'review_comment', 'pr_comment']);
const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 25;

export async function searchRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/search', async (req): Promise<SearchResponse> => {
    const q = req.query as {
      q?: string;
      workspace?: string;
      kinds?: string;
      limit?: string;
      offset?: string;
    };
    const accountId = accountIdOf(req);
    const query = (q.q ?? '').trim();
    if (query === '') return { query: '', hits: [], people: [], stories: [], total: 0 };

    const scope = await resolveWorkspaceScope(accountId, q.workspace);
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
      repoIds: scope.repoIds,
      workspaceId: scope.workspaceId,
      kinds: kinds.length > 0 ? kinds : undefined,
      limit,
      offset,
    });
  });
}
