import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  TICKET_MERGED_PRS_MAX_KEYS,
  canonicalTicketKey,
  trackerTicketIdent,
  type TicketMergedPr,
  type TicketMergedPrs,
  type TicketMergedPrsResponse,
} from '@pierre-review/shared';
import { inChunks, resolveRequestWorkspaceId, type TrackerContext } from './context.js';
import { maybeAdapterFor } from './registry.js';
import { issueOf, readWorkspaceTrackerRow } from './settings.js';

// ── THE OPEN PRs TICKET STACKS' MERGED PANEL (CORE, free — the plugin's until apiVersion 23) ───
//
//   GET /api/ticket-merged-prs?workspace=<id>&keys=ENG-7,ENG-8  →  TicketMergedPrsResponse
//
// ONE request for the whole grouped board — nothing on a board fetches per stack. DB-only: the
// stored ticket rows (`tracker_tickets`) the background worker wrote when each PR was received,
// joined to `pull_requests`. It makes NO TRACKER CALL.
//
//   • SCOPE: the workspace's own tracker site. `?workspace=` resolves like every scoped route (absent /
//     unknown / another tenant's → the Default) and is echoed. The keys are read on THAT site's
//     `api_root` only — the board's stacks were detected against it — so a key cannot reach another
//     site's rows. A workspace whose tracker does not READ tickets answers `tickets: []`.
//   • MEMBERSHIP is the ticket review's (`ticketMembers`, ./peers.ts): rows of this account
//     on that site, ANY repo and ANY workspace, state 'ok'. The same ticket is the same ticket
//     wherever its PRs live.
//   • ONLY MERGED: `pull_requests.state = 'merged'`; a closed-unmerged PR is not work that landed.
//     Open PRs are the board's own cards and are not repeated here.
//
// ⚠ Every read predicates on accountId (the ticket rows, the PRs and the repos). `users` is GLOBAL
// and is read only by the author ids of this account's own PRs.
//
// GET, DB-only: the `read` tier (spelled in `tierFor`).

/** "eng-7, ENG-8,,ENG-7" → ['ENG-7', 'ENG-8'] (malformed keys dropped). A GitHub issue key
 *  (`Owner/Repo#12`, any case) is kept lower-cased (shared `canonicalTicketKey`). null = over the cap. */
export function parseKeys(raw: string | undefined): string[] | null {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of (raw ?? '').split(',')) {
    const k = canonicalTicketKey(part);
    if (k == null || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out.length > TICKET_MERGED_PRS_MAX_KEYS ? null : out;
}

interface PrRow {
  id: number;
  repoId: number;
  number: number;
  title: string;
  authorId: number | null;
  mergedAt: Date | null;
}

export async function ticketMergedPrs(
  ctx: TrackerContext,
  accountId: number,
  workspaceId: number,
  keys: readonly string[],
): Promise<TicketMergedPrsResponse> {
  const empty: TicketMergedPrsResponse = { workspaceId, tickets: [] };
  if (keys.length === 0) return empty;
  const issue = issueOf(await readWorkspaceTrackerRow(ctx, accountId, workspaceId));
  const adapter = maybeAdapterFor(issue.provider);
  if (issue.provider == null || adapter?.reader == null) return empty;
  const provider = issue.provider;
  const apiRoot = adapter.siteRoot(issue.baseUrl);
  if (apiRoot == null) return empty;

  const t = ctx.schema.trackerTickets;
  const links = (await ctx.db
    .select({ prId: t.prId, issueKey: t.issueKey })
    .from(t)
    .where(
      and(
        eq(t.accountId, accountId),
        eq(t.provider, provider),
        eq(t.apiRoot, apiRoot),
        inArray(t.issueKey, [...keys]),
        eq(t.state, 'ok'),
      ),
    )
    .execute()) as Array<{ prId: number; issueKey: string }>;
  if (links.length === 0) return empty;

  const pr = ctx.schema.pullRequests;
  const prRows = await inChunks([...new Set(links.map((l) => l.prId))], async (chunk) =>
    (await ctx.db
      .select({
        id: pr.id,
        repoId: pr.repoId,
        number: pr.number,
        title: pr.title,
        authorId: pr.authorId,
        mergedAt: pr.mergedAt,
      })
      .from(pr)
      .where(and(eq(pr.accountId, accountId), inArray(pr.id, chunk), eq(pr.state, 'merged')))
      .execute()) as PrRow[],
  );
  if (prRows.length === 0) return empty;

  const reposT = ctx.schema.repos;
  const repoRows = await inChunks([...new Set(prRows.map((p) => p.repoId))], async (chunk) =>
    (await ctx.db
      .select({ id: reposT.id, owner: reposT.owner, name: reposT.name })
      .from(reposT)
      .where(and(eq(reposT.accountId, accountId), inArray(reposT.id, chunk)))
      .execute()) as Array<{ id: number; owner: string; name: string }>,
  );
  const repoName = new Map(repoRows.map((r) => [r.id, `${r.owner}/${r.name}`]));

  const usersT = ctx.schema.users;
  const authorIds = [...new Set(prRows.flatMap((p) => (p.authorId != null ? [p.authorId] : [])))];
  const userRows =
    authorIds.length === 0
      ? []
      : await inChunks(authorIds, async (chunk) =>
          (await ctx.db
            .select({
              id: usersT.id,
              githubLogin: usersT.githubLogin,
              displayName: usersT.displayName,
              avatarUrl: usersT.avatarUrl,
            })
            .from(usersT)
            .where(inArray(usersT.id, chunk))
            .execute()) as Array<{ id: number; githubLogin: string; displayName: string | null; avatarUrl: string | null }>,
        );
  const userById = new Map(userRows.map((u) => [u.id, u]));

  const merged = new Map<number, TicketMergedPr>();
  for (const p of prRows) {
    const repoFullName = repoName.get(p.repoId);
    // A PR whose repo is not this account's is not answered (defence in depth: the PR read
    // already predicates on accountId).
    if (repoFullName == null || p.mergedAt == null) continue;
    const u = p.authorId != null ? userById.get(p.authorId) : undefined;
    merged.set(p.id, {
      prId: p.id,
      repoId: p.repoId,
      repoFullName,
      number: p.number,
      title: p.title,
      authorLogin: u?.githubLogin ?? null,
      authorDisplayName: u?.displayName ?? null,
      authorAvatarUrl: u?.avatarUrl ?? null,
      mergedAt: new Date(p.mergedAt).toISOString(),
    });
  }

  const byKey = new Map<string, Map<number, TicketMergedPr>>();
  for (const l of links) {
    const m = merged.get(l.prId);
    if (m == null) continue;
    let set = byKey.get(l.issueKey);
    if (set == null) byKey.set(l.issueKey, (set = new Map()));
    set.set(m.prId, m);
  }
  const tickets: TicketMergedPrs[] = [];
  for (const key of keys) {
    const set = byKey.get(key);
    if (set == null || set.size === 0) continue;
    const prs = [...set.values()].sort(
      (a, b) => (a.mergedAt < b.mergedAt ? 1 : a.mergedAt > b.mergedAt ? -1 : a.prId - b.prId),
    );
    tickets.push({ key, ident: trackerTicketIdent(provider, apiRoot, key), prs });
  }
  return { workspaceId, tickets };
}

export function registerTicketMergedPrsRoute(app: FastifyInstance, ctx: TrackerContext): void {
  app.get<{ Querystring: { workspace?: string; keys?: string } }>(
    '/api/ticket-merged-prs',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            workspace: { type: 'string', maxLength: 20 },
            keys: { type: 'string', maxLength: 8000 },
          },
        },
      },
    },
    async (req, reply) => {
      const accountId = ctx.accountIdOf(req);
      const keys = parseKeys(req.query.keys);
      if (keys == null) {
        return reply.code(400).send({
          error: 'TooManyKeys',
          message: `At most ${TICKET_MERGED_PRS_MAX_KEYS} tickets per request.`,
        });
      }
      const workspaceId = await resolveRequestWorkspaceId(ctx, accountId, req.query.workspace);
      return ticketMergedPrs(ctx, accountId, workspaceId, keys);
    },
  );
}
