import { and, eq } from 'drizzle-orm';
import { parseTicketIdent, type TicketOpenPoint } from '@pierre-review/shared';
import type { TrackerContext } from './context.js';
import { OPEN_POINTS_FRESH_MS, openPointsForPr } from './open-points-pr.js';
import { deriveOpenPoints } from './open-points.js';
import { openPointsChoiceFor, readOpenPointsSettings } from './open-points-settings.js';
import { parseCandidates } from './store.js';

// A TICKET READ AGAIN AT A WORKSPACE SESSION'S START (docs/TRACKERS.md § Open points; docs/SANDBOX.md
// § The ticket). The same deliberate exception a PR review RUN makes — a session is a RUN the reader
// started, never a view — widened from "the PR's tickets" to "this ticket":
//
//   • the ticket has PRs  → `openPointsForPr(…, {refresh: true})` on up to TWO of them (open first):
//                           the worker's own path, its backoff honoured, a row read in the last
//                           OPEN_POINTS_FRESH_MS not read again. Its story text lands in the same rows;
//   • it has none         → the workspace's SPRINT LIST read, marked due and run now (the path
//                           `POST /api/sprint-stories/refresh` takes), waited for at most `waitMs`;
//                           the points come from the refreshed `sprint_tickets` row.
//
// ⚠ NEVER THROWS, never fatal: on any failure the stored copy is used and `fresh` is false.

export const TICKET_REFRESH_WAIT_MS = 20_000;
export const TICKET_REFRESH_MAX_PRS = 2;

export interface FreshTicketOpenPoints {
  points: TicketOpenPoint[];
  /** Read from the tracker within OPEN_POINTS_FRESH_MS of the start. */
  fresh: boolean;
  /** ISO time of the copy the points came from, or null. */
  fetchedAt: string | null;
}

export async function refreshTicketForSession(
  ctx: TrackerContext,
  accountId: number,
  workspaceId: number,
  ident: string,
  prs: ReadonlyArray<{ prId: number; state: 'open' | 'merged' }>,
  opts: { nowMs?: number; waitMs?: number } = {},
): Promise<FreshTicketOpenPoints> {
  const none: FreshTicketOpenPoints = { points: [], fresh: false, fetchedAt: null };
  const parsed = parseTicketIdent(ident);
  if (parsed == null || parsed.kind === 'manual') return none;
  const key = parsed.key;
  try {
    if (prs.length > 0) {
      const ordered = [...prs].sort((a, b) => (a.state === b.state ? a.prId - b.prId : a.state === 'open' ? -1 : 1));
      let best: FreshTicketOpenPoints | null = null;
      for (const pr of ordered.slice(0, TICKET_REFRESH_MAX_PRS)) {
        const got = (await openPointsForPr(ctx, accountId, pr.prId, { refresh: true, nowMs: opts.nowMs })).find(
          (t) => t.key.toLowerCase() === key.toLowerCase(),
        );
        if (got == null) continue;
        const cand = { points: got.points, fresh: got.fresh, fetchedAt: got.fetchedAt };
        if (best == null || (cand.fresh && !best.fresh)) best = cand;
        if (best.fresh) break;
      }
      // A ticket whose points are all settled has no entry: fresh, with none.
      return best ?? { points: [], fresh: true, fetchedAt: null };
    }

    // No PR: the sprint list read. LAZY: db/sprint-store opens the core database at import.
    const store = await import('../db/sprint-store.js');
    const { readWorkspaceSprintOnce } = await import('./sprint/read.js');
    await store.noteSprintViewed(accountId, workspaceId);
    await store.markSprintReadDue(accountId, workspaceId);
    const wait = opts.waitMs ?? TICKET_REFRESH_WAIT_MS;
    await Promise.race([
      readWorkspaceSprintOnce(ctx, accountId, workspaceId).catch(() => null),
      new Promise((r) => setTimeout(r, wait).unref?.()),
    ]);
    const st = ctx.schema.sprintTickets;
    const rows = (await ctx.db
      .select({
        description: st.description,
        candidatesJson: st.candidatesJson,
        apiRoot: st.apiRoot,
        issueTypeId: st.issueTypeId,
        fetchedAt: st.fetchedAt,
      })
      .from(st)
      .where(and(eq(st.accountId, accountId), eq(st.workspaceId, workspaceId), eq(st.ident, ident)))
      .limit(1)
      .execute()) as Array<{ description: string; candidatesJson: string | null; apiRoot: string; issueTypeId: string | null; fetchedAt: Date }>;
    const row = rows[0];
    if (row == null) return none;
    const settings = await readOpenPointsSettings(ctx, accountId, [workspaceId]);
    const choice = openPointsChoiceFor(settings, workspaceId, row.apiRoot, row.issueTypeId);
    const { points } = deriveOpenPoints(parseCandidates(row.candidatesJson), row.description, choice);
    const at = new Date(row.fetchedAt).getTime();
    return { points, fresh: at >= (opts.nowMs ?? Date.now()) - OPEN_POINTS_FRESH_MS, fetchedAt: new Date(at).toISOString() };
  } catch (err) {
    const code = err instanceof Error && 'code' in err ? String((err as { code: unknown }).code) : 'unknown';
    // ⚠ NOT `{ err }` — never serialise the error object on a tracker path.
    ctx.log.warn({ accountId, workspaceId, code }, 'session ticket: not read again; using the stored copy');
    return none;
  }
}
