import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  TICKET_LINKS_MAX_PRS,
  type PrTicketLinks,
  type TicketLink,
  type TicketLinksBody,
  type TicketLinksResponse,
} from '@pierre-review/shared';
import { inChunks, type TrackerContext } from './context.js';
import { detectKeysWithAccess, linksUnknownFor, prLinkColumns, withParsedLinks } from './enricher.js';
import { trackerBaseUrl } from './settings.js';
import { buildTicketRefs, ticketUrl } from './registry.js';
import type { JiraTransport } from './jira/fetch.js';
import { groupByPr, readStoredTickets, toLinkExtras } from './store.js';
import { isBackedOff, kickTrackerSyncForPrs, workspaceCallsFor } from './worker.js';

// ── THE OPEN PRs CARDS' TICKET ROW (CORE, free — the plugin's until apiVersion 23) ─────────────
//
//   POST /api/ticket-links   { prIds }  →  TicketLinksResponse
//
// ONE request for the whole board — the Open PRs list is a board, and nothing on a board fetches
// per card. It makes NO JIRA CALL:
//
//   • DETECTION is DB-only and runs for every listed PR: the SAME `detectKeysWithAccess` the
//     PR-detail chips and the ticket route use (title + head branch against the PR's OWN
//     workspace's tracker settings), batched — one PR read, one membership read, one settings read
//     per distinct workspace. A repo with no membership row, or a workspace with no tracker,
//     answers nothing for that PR (absent, never a guess against another workspace's Jira).
//   • TITLE, STATUS, ASSIGNEE and ISSUE TYPE come from the STORED rows (`tracker_tickets`) the
//     background worker wrote when the PR was received (./worker.ts). A detected ticket in a
//     READING workspace with a token but no row yet (a PR the worker has not reached) KICKS the worker
//     for those PRs and answers `titlesComplete: false`, so the SPA asks again shortly. A
//     workspace in its 401/403 backoff counts as complete — asking again would not change it.
//
// ⚠ NOT A TRACKER PROXY: the body names PULL REQUESTS (ownership-scoped — another tenant's id
// simply finds no row), never keys. The route sits on the `search` rate-limit tier (`tierFor`)
// because its kick spends the customer's tracker quota.

interface PrRow {
  id: number;
  repoId: number;
  title: string | null;
  headRefName: string | null;
  closingIssues: string[] | null;
  linearLinks: string[] | null;
  linearLinksRoot: string | null;
}

export async function ticketLinksForPrs(
  ctx: TrackerContext,
  accountId: number,
  prIds: readonly number[],
  opts: { transport?: JiraTransport; now?: () => number } = {},
): Promise<TicketLinksResponse> {
  const now = opts.now ?? Date.now;
  const ids = [...new Set(prIds)];
  if (ids.length === 0) return { prs: [], titlesComplete: true };

  const pr = ctx.schema.pullRequests;
  const prRows = await inChunks(ids, async (chunk) =>
    (await ctx.db
      .select({
        id: pr.id,
        repoId: pr.repoId,
        title: pr.title,
        headRefName: pr.headRefName,
        ...prLinkColumns(pr),
      })
      .from(pr)
      .where(and(eq(pr.accountId, accountId), inArray(pr.id, chunk)))
      .execute()) as PrRow[],
  ).then((rows) => rows.map((r) => withParsedLinks(r)));
  if (prRows.length === 0) return { prs: [], titlesComplete: true };

  // A repo belongs to EXACTLY ONE workspace (`workspace_repos` unique on (account, repo)).
  const { workspaceOfRepo, calls } = await workspaceCallsFor(
    ctx,
    accountId,
    prRows.map((r) => r.repoId),
    opts.transport,
  );
  const stored = groupByPr(await readStoredTickets(ctx, accountId, prRows.map((r) => r.id)));

  const byId = new Map(prRows.map((r) => [r.id, r]));
  const out: PrTicketLinks[] = [];
  const missing: number[] = [];
  const t0 = now();
  for (const id of ids) {
    const row = byId.get(id);
    if (row == null) continue;
    const wsId = workspaceOfRepo.get(row.repoId);
    if (wsId == null) continue;
    const wc = calls.get(wsId);
    if (wc == null) continue;
    const { provider } = wc.access.issue;
    // GitHub Issues: this PR's closing links have not been read yet — say nothing for it (never
    // "no ticket") and have the worker read them.
    if (linksUnknownFor(provider, row)) {
      if (wc.call != null && !(wc.fp != null && isBackedOff(accountId, wsId, wc.fp, t0)) && !missing.includes(id)) {
        missing.push(id);
      }
      continue;
    }
    const keys = detectKeysWithAccess(wc.access, row);
    const baseUrl = trackerBaseUrl(wc.access.issue);
    if (keys == null || provider == null || baseUrl == null) continue;
    const mine = stored.get(id) ?? [];
    const tickets: TicketLink[] = buildTicketRefs(provider, baseUrl, keys).map((r) => {
      const s =
        wc.call != null
          ? mine.find((m) => m.issueKey === r.key && m.apiRoot === wc.apiRoot && m.provider === wc.call!.provider)
          : undefined;
      if (wc.call != null && s == null && !(wc.fp != null && isBackedOff(accountId, wsId, wc.fp, t0))) {
        if (!missing.includes(id)) missing.push(id);
      }
      return { key: r.key, url: r.url, provider: r.provider, ...toLinkExtras(s) };
    });
    out.push({
      prId: id,
      tickets,
      jiraBrowsePrefix: provider === 'jira' ? ticketUrl('jira', baseUrl, '') : null,
    });
  }
  // A detected ticket the worker has not read: read THOSE PRs now (fire-and-forget, never throws,
  // bounded). Targeted rather than the account pass, so a CLOSED PR — which the open-PR pass never
  // walks — still converges and the SPA's re-ask ends.
  if (missing.length > 0) void kickTrackerSyncForPrs(ctx, accountId, missing, { transport: opts.transport });
  return { prs: out, titlesComplete: missing.length === 0 };
}

export function registerTicketLinksRoute(
  app: FastifyInstance,
  ctx: TrackerContext,
  opts: { transport?: JiraTransport } = {},
): void {
  app.post(
    '/api/ticket-links',
    {
      schema: {
        body: {
          type: 'object',
          required: ['prIds'],
          additionalProperties: false,
          properties: { prIds: { type: 'array', items: { type: 'integer', minimum: 1 } } },
        },
      },
    },
    async (req, reply) => {
      const { prIds } = req.body as TicketLinksBody;
      const unique = [...new Set(prIds)];
      if (unique.length > TICKET_LINKS_MAX_PRS) {
        return reply.code(400).send({
          error: 'TooManyIds',
          message: `At most ${TICKET_LINKS_MAX_PRS} PRs per request; got ${unique.length}.`,
        });
      }
      return ticketLinksForPrs(ctx, ctx.accountIdOf(req), unique, opts);
    },
  );
}
