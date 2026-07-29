import type { FastifyInstance } from 'fastify';
import type {
  BranchStatusResponse,
  CreateRepoBody,
  RepoSearchResponse,
  RepoSearchResult,
  SuggestedReposResponse,
} from '@pierre-review/shared';
import { getGraphqlClientFor, graphqlTolerant } from '../../github/client.js';
import { getAccessToken } from '../../auth/account.js';
import {
  OWNER_TYPE_QUERY,
  REPO_ID_QUERY,
  REPO_SEARCH_QUERY,
  VIEWER_REPOS_QUERY,
  type GqlSearchRepo,
  type GqlViewerRepo,
  type OwnerTypeResponse,
  type RepoIdResponse,
  type RepoSearchGqlResponse,
  type ViewerReposGqlResponse,
} from '../../github/queries.js';
import { upsertRepo } from '../../sync/upsert.js';
import {
  getSyncStatus,
  isSyncRunning,
  requestSyncCancel,
  runSyncForRepo,
  manualSyncCooldownMs,
  apiSyncSlotsExhausted,
  noteManualSync,
  waitForSyncToStop,
} from '../../sync/sync-manager.js';
import {
  deleteRepo,
  getRepo,
  getWatchedRepoNodeIds,
  listRepos,
  setRepoInboxWatch,
} from '../../db/queries.js';
import { getBranchStatus } from '../../db/branch-queries.js';
import { accountIdOf } from '../plugins/auth.js';

// Local copy of the shared MAX_REPOS_PER_ACCOUNT value. `@pierre-review/shared` is
// a types-only package (not shipped in the published tarball), so the backend must
// only `import type` from it — runtime constants are duplicated here. Keep in sync.
const MAX_REPOS_PER_ACCOUNT = 100;

const createRepoSchema = {
  body: {
    type: 'object',
    required: ['owner', 'name'],
    additionalProperties: false,
    properties: {
      owner: { type: 'string', minLength: 1 },
      name: { type: 'string', minLength: 1 },
      // When true, also Watch the repo for the inbox on add (the picker passes
      // true for "yours" repos). Optional; defaults to not-watched.
      watch: { type: 'boolean' },
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

const watchSchema = {
  ...idParamSchema,
  body: {
    type: 'object',
    required: ['inboxWatch'],
    additionalProperties: false,
    properties: { inboxWatch: { type: 'boolean' } },
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

// `repoIds=1,2,3` → [1,2,3]; absent/blank/garbage → null ("every repo in the account").
function parseIntList(raw: string | undefined): number[] | null {
  if (!raw) return null;
  const ids = raw
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n));
  return ids.length > 0 ? ids : null;
}

export async function repoRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/repos', async (req) => listRepos(accountIdOf(req)));

  // Default-branch status ("is trunk green?") for every repo in scope: the head snapshot plus
  // the recent trunk commits with their own CI state. A pure DB read off what the branch sync
  // already persisted — never a live GitHub call, hence the plain `read` rate-limit tier.
  // Informational only: nothing here feeds attention counts, My Turn, or any badge.
  app.get('/api/branch-status', async (req): Promise<BranchStatusResponse> => {
    const q = req.query as { repoIds?: string };
    return getBranchStatus(accountIdOf(req), parseIntList(q.repoIds));
  });

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

    const accountId = accountIdOf(req);

    // Translate the user term into a literal GitHub search query. An `owner/...`
    // prefix scopes results to that owner (org:/user: qualifier — resolved by type);
    // the remainder (or the whole term) is matched against the repo NAME only
    // (`in:name`), and `needle` drives the literal re-rank below.
    const client = getGraphqlClientFor(await getAccessToken(accountId));
    const slash = term.indexOf('/');
    const owner = slash >= 0 ? term.slice(0, slash).trim() : '';
    const rest = slash >= 0 ? term.slice(slash + 1).trim() : term;
    let searchQuery: string;
    let needle: string;
    if (owner) {
      // `owner/...` → scope to that owner. Note a stray leading slash ("/foo") leaves
      // owner empty and falls through to the plain branch (no malformed `user:` query).
      needle = rest;
      let qualifier = `user:${owner}`;
      try {
        const ownerResp: OwnerTypeResponse = await client(OWNER_TYPE_QUERY, {
          login: owner,
        });
        const kind = ownerResp.repositoryOwner?.__typename ?? null;
        if (kind == null) {
          // Owner login doesn't exist → no possible matches.
          return { results: [], hasNextPage: false, cursor: null };
        }
        qualifier = kind === 'Organization' ? `org:${owner}` : `user:${owner}`;
      } catch (err) {
        // Lookup failed (network / rate limit) — default to user: scoping and run the
        // search anyway. Logged so a wrong-scope result is diagnosable.
        req.log.warn(
          { err, owner },
          'repo search: owner-type lookup failed; defaulting to user: scope',
        );
      }
      searchQuery = rest ? `${qualifier} ${rest} in:name` : qualifier;
    } else {
      // Plain term (or a stray leading slash) → literal repo-name search.
      needle = rest;
      searchQuery = rest ? `${rest} in:name` : term;
    }

    let resp: RepoSearchGqlResponse;
    try {
      // NB: the GraphQL variable is `searchQuery`, not `query` — @octokit/graphql
      // reserves `query` for the document body and rejects it as a variable name.
      resp = await client(REPO_SEARCH_QUERY, {
        searchQuery,
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

    const watched = await getWatchedRepoNodeIds(accountId);
    const me = resp.viewer.login.toLowerCase();
    const orgLogins = new Set(
      resp.viewer.organizations.nodes
        .filter((o): o is { login: string } => o != null)
        .map((o) => o.login.toLowerCase()),
    );

    const results: RepoSearchResult[] = resp.search.nodes
      // GitHub returns a NULL node for any hit the token can't fully resolve (a scoped
      // GitHub-App token in cloud hits this; the local `gh` PAT sees them all), and {} for
      // a (theoretical) non-repo node. Drop both null-safely BEFORE reading `id`/`owner`,
      // then drop already-watched. (This null node is the cloud-only crash source.)
      .filter((n): n is GqlSearchRepo => n != null && typeof n.id === 'string')
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

    // Re-rank for literal matching: closest name match first (exact < prefix <
    // substring < other), then your own/org repos, then stars. Array.prototype.sort
    // is stable (Node ≥ 12), so GitHub's best-match order breaks remaining ties.
    const lc = needle.toLowerCase();
    const nameTier = (name: string): number => {
      if (!lc) return 0;
      const n = name.toLowerCase();
      if (n === lc) return 0;
      if (n.startsWith(lc)) return 1;
      if (n.includes(lc)) return 2;
      return 3;
    };
    results.sort((a, b) => {
      const t = nameTier(a.name) - nameTier(b.name);
      if (t !== 0) return t;
      const own = Number(b.isOwnedOrMember) - Number(a.isOwnedOrMember);
      if (own !== 0) return own;
      return b.stargazerCount - a.stargazerCount;
    });

    const body: RepoSearchResponse = {
      results,
      hasNextPage: resp.search.pageInfo.hasNextPage,
      cursor: resp.search.pageInfo.endCursor,
    };
    return body;
  });

  // First-run onboarding: the viewer's recently-active repositories, detected from their
  // GitHub activity (recent pushes + contributions). Same token idiom as /search; already-
  // watched repos filtered out; mapped to the picker's RepoSearchResult shape and ordered
  // most-recently-pushed first, capped at 30. Detail comes straight from GitHub — nothing
  // persisted. Local's broad `gh` token surfaces private + org repos; a scoped cloud token
  // surfaces only what it can read (both are handled by the same null-tolerant merge below).
  app.get('/api/repos/suggested', async (req, reply) => {
    const accountId = accountIdOf(req);
    const client = getGraphqlClientFor(await getAccessToken(accountId));

    let resp: ViewerReposGqlResponse;
    try {
      // Tolerate PARTIAL GraphQL errors (a scoped cloud token forbidden one sub-field answers
      // 200 + partial data) — the null-drop merge below is built for exactly that. Only a
      // response with NO usable data (auth failure, rate limit, network) 502s.
      resp = await graphqlTolerant<ViewerReposGqlResponse>(
        client,
        VIEWER_REPOS_QUERY,
        {},
        (errors) => req.log.warn({ errors }, 'partial viewer-repos response'),
      );
    } catch (err) {
      reply.status(502);
      return {
        error: 'GitHubError',
        message: err instanceof Error ? err.message : 'GitHub request failed',
      };
    }
    if (resp?.viewer == null) return { results: [] } satisfies SuggestedReposResponse;

    const me = resp.viewer.login.toLowerCase();
    const orgLogins = new Set(
      resp.viewer.organizations.nodes
        .filter((o): o is { login: string } => o != null)
        .map((o) => o.login.toLowerCase()),
    );

    // Merge the two recency-ordered lists, deduping by repo node id and keeping the more
    // recent pushedAt. Null node arrays (scoped token) and null nodes are dropped BEFORE any
    // field read (ISO-8601 pushedAt strings compare lexically; a null pushedAt sorts last).
    const byId = new Map<string, GqlViewerRepo>();
    const merged = [
      ...(resp.viewer.repositories.nodes ?? []),
      ...(resp.viewer.repositoriesContributedTo.nodes ?? []),
    ];
    for (const n of merged) {
      if (n == null || typeof n.id !== 'string') continue;
      const existing = byId.get(n.id);
      if (existing == null || (n.pushedAt ?? '') > (existing.pushedAt ?? '')) {
        byId.set(n.id, n);
      }
    }

    const watched = await getWatchedRepoNodeIds(accountId);
    const results: RepoSearchResult[] = [...byId.values()]
      .filter((n) => !watched.has(n.id))
      // Most-recently-pushed first; a missing pushedAt sorts to the bottom.
      .sort((a, b) => (b.pushedAt ?? '').localeCompare(a.pushedAt ?? ''))
      .slice(0, 30)
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

    const body: SuggestedReposResponse = { results };
    return body;
  });

  app.post('/api/repos', { schema: createRepoSchema }, async (req, reply) => {
    const { owner, name } = req.body as CreateRepoBody;
    const accountId = accountIdOf(req);

    let resp: RepoIdResponse;
    try {
      const client = getGraphqlClientFor(await getAccessToken(accountId));
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

    // Enforce the per-account repo cap. Re-adding an already-watched repo is an
    // idempotent no-op (it doesn't grow the count), so only genuinely NEW repos
    // are blocked once at the limit.
    const watched = await getWatchedRepoNodeIds(accountId);
    if (
      watched.size >= MAX_REPOS_PER_ACCOUNT &&
      !watched.has(resp.repository.id)
    ) {
      reply.status(409);
      return {
        error: 'RepoLimitExceeded',
        message: `You can watch at most ${MAX_REPOS_PER_ACCOUNT} repositories. Remove one to add another.`,
      };
    }

    const canonOwner = resp.repository.owner.login;
    const canonName = resp.repository.name;
    const repoId = await upsertRepo(
      canonOwner,
      canonName,
      resp.repository.id,
      null,
      accountId,
    );

    // Auto-watch every newly-added repo for the inbox (so its activity flows into the feed +
    // team scopes by default). Idempotent on re-add and preserves an existing watch-start
    // (setRepoInboxWatch only stamps the start when unset). The `watch` body field is now
    // vestigial — every add watches — but the schema still accepts it for back-compat.
    await setRepoInboxWatch(accountId, repoId, true);

    // Kick off the initial backfill in the background.
    runSyncForRepo(repoId, app.log, { background: true });

    reply.status(201);
    return getRepo(repoId, accountId);
  });

  // Toggle "Watch for inbox" on a repo. Activity-only: it does not affect timeline
  // visibility or syncing. Ownership-scoped → 404 for a repo this account doesn't own.
  app.patch('/api/repos/:id', { schema: watchSchema }, async (req, reply) => {
    const { id } = req.params as { id: number };
    const { inboxWatch } = req.body as { inboxWatch: boolean };
    const accountId = accountIdOf(req);
    const ok = await setRepoInboxWatch(accountId, id, inboxWatch);
    if (!ok) {
      reply.status(404);
      return { error: 'NotFound', message: `Repo ${id} not found` };
    }
    return getRepo(id, accountId);
  });

  app.delete('/api/repos/:id', { schema: idParamSchema }, async (req, reply) => {
    const { id } = req.params as { id: number };
    const accountId = accountIdOf(req);
    // Ownership check first: a repo this account doesn't own is a 404 (and we
    // must not consult the repoId-keyed sync managers for someone else's repo).
    if (!(await getRepo(id, accountId))) {
      reply.status(404);
      return { error: 'NotFound', message: `Repo ${id} not found` };
    }
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
    const ok = await deleteRepo(id, accountId);
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
      if (!(await getRepo(id, accountIdOf(req)))) {
        reply.status(404);
        return { error: 'NotFound', message: `Repo ${id} not found` };
      }
      // ?full=true forces a full backfill (catches CI/thread-resolve changes
      // that don't bump PR.updatedAt and so lag the incremental path).
      const { full } = req.query as { full?: boolean };
      const forceFull = full === true;

      // Per-repo cooldown. `runSyncForRepo`'s own guard only refuses a sync already in
      // flight for this repo — it did not stop a caller re-firing the moment one finished,
      // so a loop could keep a forced 90-day backfill running permanently and drain the
      // tenant's GitHub quota (breaking their real sync for the rest of the hour).
      const waitMs = manualSyncCooldownMs(id, forceFull);
      if (waitMs > 0) {
        const retryAfter = Math.ceil(waitMs / 1000);
        reply.status(429).header('Retry-After', String(retryAfter));
        return {
          error: 'TooManyRequests',
          message: forceFull
            ? `A deep sync for this repo ran recently — try again in ${retryAfter}s.`
            : `This repo was synced moments ago — try again in ${retryAfter}s.`,
          retryAfter,
        };
      }
      // Process-wide cap on API-triggered syncs. The "deep sync everything" action fires one
      // POST per repo; without this, 100 concurrent GraphQL walks run inside the single
      // Fastify process and starve every other request (in cloud, every other tenant).
      if (apiSyncSlotsExhausted()) {
        reply.status(429).header('Retry-After', '30');
        return {
          error: 'TooManyRequests',
          message: 'Too many syncs are already running — try again shortly.',
          retryAfter: 30,
        };
      }

      // NOTE the `await`: this was previously assigned un-awaited, so `started` was always a
      // truthy Promise and the 409 below could never fire. `background: true` still returns
      // as soon as the sync is launched, so awaiting costs nothing.
      const started = await runSyncForRepo(id, app.log, {
        background: true,
        forceFull,
      });
      if (!started) {
        reply.status(409);
        return { error: 'Conflict', message: 'A sync is already running for this repo' };
      }
      noteManualSync(id);
      reply.status(202);
      return { status: 'started' };
    },
  );

  app.get(
    '/api/repos/:id/sync-status',
    { schema: idParamSchema },
    async (req, reply) => {
      const { id } = req.params as { id: number };
      if (!(await getRepo(id, accountIdOf(req)))) {
        reply.status(404);
        return { error: 'NotFound', message: `Repo ${id} not found` };
      }
      return getSyncStatus(id);
    },
  );

  // Cancel an in-flight sync. Signals the sync loop to stop, waits for it to
  // settle, then — if this repo never completed a sync (an initial backfill the
  // user is aborting) — deletes it and its partially-loaded data. An established
  // repo whose re-sync was cancelled keeps everything. Drives the modal's Cancel.
  app.post('/api/repos/:id/cancel', { schema: idParamSchema }, async (req, reply) => {
    const { id } = req.params as { id: number };
    const accountId = accountIdOf(req);
    if (!(await getRepo(id, accountId))) {
      reply.status(404);
      return { error: 'NotFound', message: `Repo ${id} not found` };
    }
    requestSyncCancel(id);
    await waitForSyncToStop(id, 30_000);
    // Re-read AFTER it stops: if the sync actually finished during the wait, the
    // repo is now "synced" and must NOT be deleted (avoids a cancel-vs-finish race).
    const fresh = await getRepo(id, accountId);
    const neverSynced =
      fresh != null &&
      fresh.lastFullSyncAt == null &&
      fresh.lastIncrementalSyncAt == null;
    let deleted = false;
    if (neverSynced && !isSyncRunning(id)) deleted = await deleteRepo(id, accountId);
    reply.status(200);
    return { repoId: id, deleted };
  });
}
