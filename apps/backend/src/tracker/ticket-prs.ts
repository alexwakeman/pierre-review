import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  TICKET_PRS_MAX,
  isTrackerIdent,
  parseTicketIdent,
  trackerTicketRow,
  type JiraStatusCategory,
  type TicketPrsResponse,
  type TicketPrsTicket,
  type TimelinePr,
  type TrackerProvider,
} from '@pierre-review/shared';
import { inChunks, resolveRequestWorkspaceId, type TrackerContext } from './context.js';
import { ticketMembers } from './peers.js';
import { maybeAdapterFor } from './registry.js';
import { issueOf, readWorkspaceTrackerRow } from './settings.js';

// ── THE TICKET TAB (CORE, free) — one ticket's pull requests, in isolation ─────────────────────
//
//   GET /api/ticket-prs?workspace=<id>&ident=<trackerTicketIdent>  →  TicketPrsResponse
//
// Contract: packages/shared/src/ticket-prs.ts. DB-only — the stored ticket rows the worker wrote
// (`tracker_tickets`, manual links included), joined to `pull_requests` and built into the SAME
// `TimelinePr` rows the Open PRs cards draw (`buildTimelinePrs`). NO tracker call, NO GitHub call.
//
//   • MEMBERSHIP is the ticket review's (`ticketMembers`): this account, the same site + key, ANY
//     workspace, state 'ok'. A PR in a repo of THIS workspace is LISTED; a PR elsewhere is COUNTED
//     (`outsideWorkspace`), never listed.
//   • The ident must name the workspace tracker's CURRENT provider + site, else `found: false` (an
//     unparseable ident too) — a 200 with empty lists, never a 404 (no existence oracle).
//
// ⚠ Every read predicates on accountId (ticket rows, PRs, workspace membership).
// GET, DB-only: the `read` tier (spelled in `tierFor`).

/* eslint-disable @typescript-eslint/no-explicit-any */
type PrRowLike = { id: number; repoId: number; state: string; updatedAt: Date | null; mergedAt: Date | null; closedAt: Date | null };

/** Builds the TimelinePr rows. Injected so a test need not load db/queries.ts; production imports it
 *  LAZILY (db/queries.ts imports the PR-detail enricher, which imports the tracker runtime). */
export type BuildTimelinePrs = (rows: any[], accountId: number) => Promise<TimelinePr[]>;

const defaultBuild: BuildTimelinePrs = async (rows, accountId) =>
  (await import('../db/queries.js')).buildTimelinePrs(rows, accountId);

const ms = (d: Date | null | undefined): number => (d == null ? 0 : new Date(d).getTime());

function cap<T>(list: T[]): { list: T[]; truncated: boolean } {
  return list.length > TICKET_PRS_MAX ? { list: list.slice(0, TICKET_PRS_MAX), truncated: true } : { list, truncated: false };
}

export async function ticketPrs(
  ctx: TrackerContext,
  accountId: number,
  workspaceId: number,
  ident: string,
  build: BuildTimelinePrs = defaultBuild,
): Promise<TicketPrsResponse> {
  const empty: TicketPrsResponse = {
    workspaceId,
    ident,
    found: false,
    ticket: null,
    open: [],
    merged: [],
    closed: [],
    outsideWorkspace: 0,
    truncated: false,
  };
  const parsed = parseTicketIdent(ident);
  if (!isTrackerIdent(parsed)) return empty;
  const row = trackerTicketRow(parsed);

  const issue = issueOf(await readWorkspaceTrackerRow(ctx, accountId, workspaceId));
  const adapter = maybeAdapterFor(issue.provider);
  if (issue.provider == null || adapter == null || issue.provider !== row.provider) return empty;
  const siteRoot = adapter.siteRoot(issue.baseUrl);
  if (siteRoot == null || siteRoot !== row.apiRoot) return empty;

  // The ticket's own facts: the freshest READ row on this site (title, browse URL, status).
  const t = ctx.schema.trackerTickets;
  const metaRows = (await ctx.db
    .select({ title: t.title, url: t.url, statusName: t.statusName, statusCategory: t.statusCategory })
    .from(t)
    .where(
      and(
        eq(t.accountId, accountId),
        eq(t.provider, row.provider),
        eq(t.apiRoot, row.apiRoot),
        eq(t.issueKey, row.issueKey),
        eq(t.state, 'ok'),
        isNotNull(t.fetchedAt),
      ),
    )
    .orderBy(desc(t.fetchedAt), desc(t.id))
    .limit(1)
    .execute()) as Array<{ title: string | null; url: string; statusName: string | null; statusCategory: string | null }>;
  const meta = metaRows[0];
  const category = meta?.statusCategory;
  const ticket: TicketPrsTicket | null =
    meta == null
      ? null
      : {
          key: row.issueKey,
          title: meta.title,
          url: meta.url !== '' ? meta.url : null,
          provider: row.provider as TrackerProvider,
          status:
            meta.statusName != null && meta.statusName !== ''
              ? {
                  name: meta.statusName,
                  category: category === 'new' || category === 'indeterminate' || category === 'done' ? (category as JiraStatusCategory) : null,
                }
              : null,
        };

  const found: TicketPrsResponse = { ...empty, found: true, ticket };
  const members = await ticketMembers(ctx, accountId, ident);
  if (members.length === 0) return found;

  const pr = ctx.schema.pullRequests;
  const prRows = await inChunks([...new Set(members.map((m) => m.prId))], async (chunk) =>
    (await ctx.db
      .select()
      .from(pr)
      .where(and(eq(pr.accountId, accountId), inArray(pr.id, chunk)))
      .execute()) as PrRowLike[],
  );
  if (prRows.length === 0) return found;

  const wr = ctx.schema.workspaceRepos;
  const inWs = new Set(
    (
      (await ctx.db
        .select({ repoId: wr.repoId })
        .from(wr)
        .where(and(eq(wr.accountId, accountId), eq(wr.workspaceId, workspaceId)))
        .execute()) as Array<{ repoId: number }>
    ).map((r) => r.repoId),
  );
  const listed = prRows.filter((p) => inWs.has(p.repoId));
  const outsideWorkspace = prRows.length - listed.length;

  const open = listed.filter((p) => p.state === 'open').sort((a, b) => ms(b.updatedAt) - ms(a.updatedAt) || b.id - a.id);
  const merged = listed.filter((p) => p.state === 'merged').sort((a, b) => ms(b.mergedAt) - ms(a.mergedAt) || b.id - a.id);
  const closed = listed
    .filter((p) => p.state === 'closed')
    .sort((a, b) => ms(b.closedAt ?? b.updatedAt) - ms(a.closedAt ?? a.updatedAt) || b.id - a.id);
  const o = cap(open);
  const m = cap(merged);
  const c = cap(closed);

  // ONE build over every listed row, then split back in each list's order.
  const page = [...o.list, ...m.list, ...c.list];
  const built = page.length === 0 ? [] : await build(page, accountId);
  const byId = new Map(built.map((b) => [b.id, b]));
  const pick = (rows: PrRowLike[]): TimelinePr[] => rows.flatMap((r) => (byId.has(r.id) ? [byId.get(r.id)!] : []));

  return {
    ...found,
    open: pick(o.list),
    merged: pick(m.list),
    closed: pick(c.list),
    outsideWorkspace,
    truncated: o.truncated || m.truncated || c.truncated,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export function registerTicketPrsRoute(app: FastifyInstance, ctx: TrackerContext): void {
  app.get<{ Querystring: { workspace?: string; ident?: string } }>(
    '/api/ticket-prs',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            workspace: { type: 'string', maxLength: 20 },
            ident: { type: 'string', maxLength: 600 },
          },
        },
      },
    },
    async (req) => {
      const accountId = ctx.accountIdOf(req);
      const workspaceId = await resolveRequestWorkspaceId(ctx, accountId, req.query.workspace);
      return ticketPrs(ctx, accountId, workspaceId, req.query.ident ?? '');
    },
  );
}
