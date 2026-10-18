import { and, desc, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import type {
  PrState,
  SearchHit,
  SearchHitKind,
  SearchPerson,
  SearchResponse,
  SearchStory,
} from '@pierre-review/shared';
import { SEARCH_STORIES_MAX, trackerTicketIdent, type TrackerProvider } from '@pierre-review/shared';
import { db, schema, runTransaction } from './client.js';

// Cross-repo text search over the local `search_index` (CORE, no AI), scoped to ONE workspace's
// repos. The match is a PORTABLE case-insensitive SUBSTRING (`lower(col) LIKE pattern ESCAPE '\'`,
// term lowercased in JS) so the SAME query runs on SQLite (local) and Postgres (cloud) — no dialect
// fork, no FTS operator. Substring is the right semantics for the user's goal ("pinpoint where
// certain text exists"). Every query filters on the denormalized `accountId`, so cross-account
// isolation is a single indexed predicate. A Postgres `pg_trgm` GIN index (see schema.pg.ts) is a
// drop-in accelerator.
//
// ⚠ NOTHING HERE PERSISTS A SCOPE. `search_index` stores `accountId` + `repoId` and the scope is
// applied at QUERY time from the caller's resolved repo list, so the workspace refactor needs no
// data migration on this table — unlike the plugin's report caches, which persist a `scope_key`.
//
// Case-folding caveat: SQL `lower()` folds ASCII on both dialects, but only Postgres folds non-ASCII
// (accents, Cyrillic, …) — better-sqlite3 has no ICU. So a lowercase-accented query for
// upper-accented content ("café" ⇢ "CAFÉ") matches on cloud but not locally. Acceptable: the corpus
// (code, PR text) is ASCII-dominant, and closing it would need a normalized column + migration for a
// rare case. ASCII search — the overwhelming majority — is identical on both.

const { searchIndex, pullRequests, repos, users } = schema;
const { reviews: reviewsT, reviewComments: rcT, prComments: pcT } = schema;

const MAX_TERMS = 6;
const SNIPPET_RADIUS = 90;

const asDate = (d: Date | number | null): Date =>
  d instanceof Date ? d : new Date(d == null ? 0 : Number(d) * (Number(d) > 1e12 ? 1 : 1000));

// Collapse whitespace + hard-cap the indexed text (shared with the persist path in upsert.ts). A
// review/description can be arbitrarily long; the index only needs enough to match + snippet.
export const SEARCH_TEXT_MAX = 4000;
export function searchText(...parts: Array<string | null | undefined>): string {
  const joined = parts
    .map((p) => (p ?? '').trim())
    .filter((p) => p.length > 0)
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim();
  return joined.length > SEARCH_TEXT_MAX ? joined.slice(0, SEARCH_TEXT_MAX) : joined;
}

// Split a raw query into up to MAX_TERMS lowercased terms; a "quoted phrase" is one term. The
// terms are ANDed for hits (all must appear) and ORed for people (any name fragment matches).
function parseTerms(query: string): string[] {
  const terms: string[] = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(query)) != null && terms.length < MAX_TERMS) {
    const t = (m[1] ?? m[2] ?? '').trim().toLowerCase();
    if (t) terms.push(t);
  }
  return terms;
}

// A `%term%` LIKE pattern with the LIKE metacharacters (%, _, \) escaped so the term matches
// literally (paired with `ESCAPE '\'` in likeCol).
function likePattern(term: string): string {
  return `%${term.replace(/([\\%_])/g, '\\$1')}%`;
}

// `lower(col) LIKE pattern ESCAPE '\'` — the portable substring predicate. `pattern` is bound as a
// parameter (no injection); the ESCAPE clause is literal SQL identical on both dialects.
function likeCol(col: SQL | unknown, pattern: string): SQL {
  return sql`lower(${col}) like ${pattern} escape '\\'`;
}

// A short excerpt of the matched text, centred on the earliest matched term (so the reader sees WHY
// it matched). Falls back to the head of the text when only the author matched.
function makeSnippet(body: string, terms: string[]): string {
  const lower = body.toLowerCase();
  let idx = -1;
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i >= 0 && (idx < 0 || i < idx)) idx = i;
  }
  if (idx < 0) {
    return body.length > SNIPPET_RADIUS * 2 ? `${body.slice(0, SNIPPET_RADIUS * 2)}…` : body;
  }
  const start = Math.max(0, idx - SNIPPET_RADIUS);
  const end = Math.min(body.length, idx + SNIPPET_RADIUS);
  return `${start > 0 ? '…' : ''}${body.slice(start, end).trim()}${end < body.length ? '…' : ''}`;
}

const toIso = (d: Date | number | null): string => {
  if (d == null) return '';
  const ms = d instanceof Date ? d.getTime() : Number(d) * (Number(d) > 1e12 ? 1 : 1000);
  return new Date(ms).toISOString();
};

export interface SearchOpts {
  query: string;
  // The repos to search — the active workspace's membership, already intersected with any explicit
  // `?repoIds=` narrow by `resolveWorkspaceScope`. It is a CONCRETE list and is NEVER null: `[]`
  // means "this workspace is empty" and returns nothing. There is deliberately no "null = every
  // repo the account has" branch any more — that sentinel is exactly how a scope that resolved to
  // zero repos silently widened to the whole account (§5.1).
  repoIds: number[];
  kinds?: SearchHitKind[];
  limit: number;
  offset: number;
  // The resolved workspace — its sprint tickets join the Stories facet (a ticket with no PR still has
  // a story). Absent ⇒ stories come from the searched repos' PRs only.
  workspaceId?: number | null;
}

export async function searchPrs(accountId: number, opts: SearchOpts): Promise<SearchResponse> {
  const query = opts.query.trim();
  const terms = parseTerms(query);
  // No terms, or an empty workspace → nothing to match.
  if (terms.length === 0 || opts.repoIds.length === 0) {
    return { query, hits: [], people: [], stories: [], total: 0 };
  }

  // Each term must match the body OR the author's login/display name (ANDed across terms).
  const termMatch = (term: string): SQL => {
    const pat = likePattern(term);
    return or(
      likeCol(searchIndex.body, pat),
      likeCol(users.githubLogin, pat),
      likeCol(users.displayName, pat),
    )!;
  };
  const repoFilter = inArray(searchIndex.repoId, opts.repoIds);
  const kindFilter =
    opts.kinds && opts.kinds.length > 0 ? inArray(searchIndex.kind, opts.kinds) : undefined;
  const where = and(
    eq(searchIndex.accountId, accountId),
    repoFilter,
    kindFilter,
    ...terms.map(termMatch),
  );

  const [rows, totalRows, people, stories] = await Promise.all([
    db
      .select({
        kind: searchIndex.kind,
        prId: searchIndex.prId,
        refId: searchIndex.refId,
        threadId: searchIndex.threadId,
        authorId: searchIndex.authorId,
        body: searchIndex.body,
        createdAt: searchIndex.createdAt,
        prNumber: pullRequests.number,
        prTitle: pullRequests.title,
        prState: pullRequests.state,
        repoId: repos.id,
        repoOwner: repos.owner,
        repoName: repos.name,
        authorLogin: users.githubLogin,
        authorAvatar: users.avatarUrl,
      })
      .from(searchIndex)
      .innerJoin(pullRequests, eq(searchIndex.prId, pullRequests.id))
      .innerJoin(repos, eq(searchIndex.repoId, repos.id))
      .leftJoin(users, eq(searchIndex.authorId, users.id))
      .where(where)
      .orderBy(desc(searchIndex.createdAt))
      .limit(opts.limit)
      .offset(opts.offset)
      .execute(),
    db
      .select({ n: sql<number>`count(*)` })
      // Only the users join is needed for the WHERE (author match); pullRequests/repos joins are
      // display-only, so the count skips them.
      .from(searchIndex)
      .leftJoin(users, eq(searchIndex.authorId, users.id))
      .where(where)
      .execute(),
    findPeople(accountId, opts.repoIds, terms),
    opts.offset === 0 ? findStories(accountId, opts.repoIds, opts.workspaceId ?? null, query) : Promise.resolve([]),
  ]);

  const hits: SearchHit[] = rows.map((r) => ({
    kind: r.kind as SearchHitKind,
    prId: r.prId,
    prNumber: r.prNumber,
    prTitle: r.prTitle,
    prState: r.prState as PrState,
    repoId: r.repoId,
    repoFullName: `${r.repoOwner}/${r.repoName}`,
    refId: r.refId,
    threadId: r.threadId,
    authorId: r.authorId,
    authorLogin: r.authorLogin ?? null,
    authorAvatarUrl: r.authorAvatar ?? null,
    snippet: makeSnippet(r.body, terms),
    createdAt: toIso(r.createdAt),
  }));

  return { query, hits, people, stories, total: Number(totalRows[0]?.n ?? 0) };
}

// The "Stories" facet: tickets whose KEY matches the query (exact, then prefix) or, for a query of
// 3+ characters, whose TITLE contains it. Two stored sources, no tracker call: the tickets the
// searched repos' PRs name (`tracker_tickets`, scoped by the same repo list as the hits) and the
// workspace's sprint tickets (`sprint_tickets`, which may have no PR). One row per ticket (its ident).
const TICKET_KEY_QUERY = /^[A-Za-z][A-Za-z0-9_]*-\d*$|^[^\s]+#\d*$/;
const MATCH_RANK: Record<SearchStory['match'], number> = { key: 0, key_prefix: 1, title: 2 };

export async function findStories(
  accountId: number,
  repoIds: number[],
  workspaceId: number | null,
  rawQuery: string,
): Promise<SearchStory[]> {
  const q = rawQuery.trim().replace(/^"|"$/g, '');
  if (q.length < 2 || q.length > 120) return [];
  const lower = q.toLowerCase();
  const keyish = TICKET_KEY_QUERY.test(q);
  const keyPat = `${lower.replace(/([\\%_])/g, '\\$1')}%`;
  const titlePat = likePattern(lower);
  const byTitle = q.length >= 3;
  if (!keyish && !byTitle) return [];

  const tt = schema.trackerTickets;
  const st = schema.sprintTickets;
  const keyMatch = (col: unknown): SQL => likeCol(col, keyPat);
  const matchOf = (key: string, title: string | null): SearchStory['match'] | null => {
    const k = key.toLowerCase();
    if (k === lower) return 'key';
    if (keyish && k.startsWith(lower)) return 'key_prefix';
    if (byTitle && title != null && title.toLowerCase().includes(lower)) return 'title';
    return null;
  };
  const cond = (keyCol: unknown, titleCol: unknown): SQL =>
    byTitle ? or(keyish ? keyMatch(keyCol) : sql`false`, likeCol(titleCol, titlePat))! : keyMatch(keyCol);

  const [prRows, sprintRows] = await Promise.all([
    repoIds.length === 0
      ? Promise.resolve([])
      : db
          .select({
            provider: tt.provider,
            apiRoot: tt.apiRoot,
            issueKey: tt.issueKey,
            title: tt.title,
            status: tt.statusName,
            prId: tt.prId,
            prState: pullRequests.state,
          })
          .from(tt)
          .innerJoin(pullRequests, eq(tt.prId, pullRequests.id))
          .where(and(eq(tt.accountId, accountId), eq(pullRequests.accountId, accountId), inArray(pullRequests.repoId, repoIds), cond(tt.issueKey, tt.title)))
          .limit(200)
          .execute(),
    workspaceId == null
      ? Promise.resolve([])
      : db
          .select({ ident: st.ident, issueKey: st.issueKey, title: st.title, status: st.statusName })
          .from(st)
          .where(and(eq(st.accountId, accountId), eq(st.workspaceId, workspaceId), cond(st.issueKey, st.title)))
          .limit(50)
          .execute(),
  ]);

  const out = new Map<string, SearchStory>();
  const prIds = new Map<string, Set<number>>();
  const openIds = new Map<string, Set<number>>();
  for (const r of prRows) {
    const match = matchOf(r.issueKey, r.title ?? null);
    if (match == null) continue;
    const ident = trackerTicketIdent(r.provider as TrackerProvider, r.apiRoot, r.issueKey);
    const prs = prIds.get(ident) ?? new Set<number>();
    const open = openIds.get(ident) ?? new Set<number>();
    prs.add(r.prId);
    if (r.prState === 'open') open.add(r.prId);
    prIds.set(ident, prs);
    openIds.set(ident, open);
    const prev = out.get(ident);
    out.set(ident, {
      ident,
      key: r.issueKey,
      title: prev?.title ?? r.title ?? null,
      status: prev?.status ?? r.status ?? null,
      prCount: prs.size,
      openPrCount: open.size,
      match,
    });
  }
  for (const r of sprintRows) {
    const match = matchOf(r.issueKey, r.title);
    if (match == null) continue;
    const prev = out.get(r.ident);
    if (prev != null) {
      prev.title ??= r.title;
      prev.status = r.status ?? prev.status;
      continue;
    }
    out.set(r.ident, { ident: r.ident, key: r.issueKey, title: r.title, status: r.status ?? null, prCount: 0, openPrCount: 0, match });
  }
  return [...out.values()]
    .sort((a, b) => MATCH_RANK[a.match] - MATCH_RANK[b.match] || b.openPrCount - a.openPrCount || b.prCount - a.prCount || a.key.localeCompare(b.key, undefined, { numeric: true }))
    .slice(0, SEARCH_STORIES_MAX);
}

// The "People" facet: authors whose login/display name matches ANY term AND who have indexed
// activity in the searched repos (so the person is real + relevant), ranked by how much they've
// authored. `repoIds` is the same concrete workspace-bounded list `searchPrs` matched on — the
// caller has already returned empty for `[]`, so the facet can never widen past the hits.
async function findPeople(
  accountId: number,
  repoIds: number[],
  terms: string[],
): Promise<SearchPerson[]> {
  const nameMatch = or(
    ...terms.map((t) => {
      const pat = likePattern(t);
      return or(likeCol(users.githubLogin, pat), likeCol(users.displayName, pat))!;
    }),
  );
  const repoFilter = inArray(searchIndex.repoId, repoIds);
  const n = sql<number>`count(*)`;
  const rows = await db
    .select({
      id: users.id,
      login: users.githubLogin,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
      n,
    })
    .from(searchIndex)
    .innerJoin(users, eq(searchIndex.authorId, users.id))
    .where(and(eq(searchIndex.accountId, accountId), repoFilter, nameMatch))
    .groupBy(users.id, users.githubLogin, users.displayName, users.avatarUrl)
    .orderBy(desc(n))
    .limit(10)
    .execute();
  return rows.map((r) => ({
    id: r.id,
    login: r.login,
    displayName: r.displayName ?? null,
    avatarUrl: r.avatarUrl ?? null,
    matchCount: Number(r.n),
  }));
}

// ---- backfill (startup) ------------------------------------------------------------------------
// Index PRs that predate the search feature from ALREADY-STORED data (title + review/comment
// bodies; the description only when pullRequests.body was persisted, i.e. non-lean — lean PRs get
// their description indexed on the next sync via bodyText). Idempotent: only touches PRs that have
// no search rows yet, in bounded batches, so a second run after a full pass is a cheap NOT-EXISTS
// scan. Safe to fire-and-forget at startup.
export async function backfillSearchIndex(batchSize = 200, maxBatches = 2000): Promise<number> {
  let indexed = 0;
  for (let b = 0; b < maxBatches; b++) {
    const prRows = (await db
      .select({
        id: pullRequests.id,
        accountId: pullRequests.accountId,
        repoId: pullRequests.repoId,
        title: pullRequests.title,
        body: pullRequests.body,
        authorId: pullRequests.authorId,
        openedAt: pullRequests.openedAt,
      })
      .from(pullRequests)
      .where(
        sql`not exists (select 1 from ${searchIndex} where ${searchIndex.prId} = ${pullRequests.id})`,
      )
      .limit(batchSize)
      .execute()) as Array<{
      id: number;
      accountId: number;
      repoId: number;
      title: string;
      body: string | null;
      authorId: number | null;
      openedAt: Date | number | null;
    }>;
    if (prRows.length === 0) break;

    const prIds = prRows.map((p) => p.id);
    const acctOf = new Map(prRows.map((p) => [p.id, p.accountId]));
    const repoOf = new Map(prRows.map((p) => [p.id, p.repoId]));

    const [revRows, rcRows, pcRows] = await Promise.all([
      db
        .select({ id: reviewsT.id, prId: reviewsT.prId, authorId: reviewsT.authorId, body: reviewsT.body, at: reviewsT.submittedAt })
        .from(reviewsT)
        .where(inArray(reviewsT.prId, prIds))
        .execute(),
      db
        .select({ id: rcT.id, prId: rcT.prId, threadId: rcT.threadId, authorId: rcT.authorId, body: rcT.body, at: rcT.createdAt })
        .from(rcT)
        .where(inArray(rcT.prId, prIds))
        .execute(),
      db
        .select({ id: pcT.id, prId: pcT.prId, authorId: pcT.authorId, body: pcT.body, at: pcT.createdAt })
        .from(pcT)
        .where(inArray(pcT.prId, prIds))
        .execute(),
    ]);

    const rows: Array<typeof searchIndex.$inferInsert> = [];
    for (const p of prRows) {
      const text = searchText(p.title, p.body);
      if (text)
        rows.push({
          accountId: p.accountId,
          repoId: p.repoId,
          prId: p.id,
          kind: 'pr',
          refId: p.id,
          threadId: null,
          authorId: p.authorId,
          body: text,
          createdAt: asDate(p.openedAt),
        });
    }
    for (const r of revRows) {
      const text = searchText(r.body);
      if (text)
        rows.push({
          accountId: acctOf.get(r.prId)!,
          repoId: repoOf.get(r.prId)!,
          prId: r.prId,
          kind: 'review',
          refId: r.id,
          threadId: null,
          authorId: r.authorId,
          body: text,
          createdAt: asDate(r.at),
        });
    }
    for (const c of rcRows) {
      const text = searchText(c.body);
      if (text)
        rows.push({
          accountId: acctOf.get(c.prId)!,
          repoId: repoOf.get(c.prId)!,
          prId: c.prId,
          kind: 'review_comment',
          refId: c.id,
          threadId: c.threadId,
          authorId: c.authorId,
          body: text,
          createdAt: asDate(c.at),
        });
    }
    for (const c of pcRows) {
      const text = searchText(c.body);
      if (text)
        rows.push({
          accountId: acctOf.get(c.prId)!,
          repoId: repoOf.get(c.prId)!,
          prId: c.prId,
          kind: 'pr_comment',
          refId: c.id,
          threadId: null,
          authorId: c.authorId,
          body: text,
          createdAt: asDate(c.at),
        });
    }

    // One transaction per batch. A concurrent live persistPr may have populated some of these PRs
    // (with the richer, lean-safe rows from bodyText) BETWEEN this batch's un-indexed SELECT and
    // here. Re-check inside the tx and INSERT only for PRs that STILL have no rows — never delete —
    // so the backfill can neither clobber those fresh rows with its staler snapshot nor duplicate
    // them. Chunked under SQLite's bound-variable limit.
    await runTransaction(async (tx) => {
      const already = (await tx
        .select({ prId: searchIndex.prId })
        .from(searchIndex)
        .where(inArray(searchIndex.prId, prIds))
        .execute()) as Array<{ prId: number }>;
      const populated = new Set(already.map((r) => r.prId));
      const fresh = rows.filter((r) => !populated.has(r.prId));
      for (let i = 0; i < fresh.length; i += 100) {
        await tx.insert(searchIndex).values(fresh.slice(i, i + 100)).execute();
      }
    });
    indexed += prRows.length;
    if (prRows.length < batchSize) break; // last partial batch
  }
  return indexed;
}
