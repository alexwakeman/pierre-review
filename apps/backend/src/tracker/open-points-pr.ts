import { CLAUDE_REVIEW_MAX_TICKETS, type TicketOpenPoint } from '@pierre-review/shared';
import type { TrackerContext } from './context.js';
import { githubAccessFor } from './context.js';
import { detectPrTickets } from './enricher.js';
import { prepareTrackerCall } from './calls.js';
import { hasContent, parseCandidates, readStoredTickets, type StoredTicketRow } from './store.js';
import { ownedPr } from './stories.js';
import { syncOnePrNow } from './worker.js';
import { deriveOpenPoints } from './open-points.js';
import { openPointsChoiceFor, readOpenPointsSettings } from './open-points-settings.js';
import type { JiraTransport } from './jira/fetch.js';

// A PR's OPEN POINTS FOR A REVIEW RUN (docs/TRACKERS.md § Open points).
//
// ⚠ A DELIBERATE EXCEPTION TO "read when RECEIVED, never when VIEWED": open points change while a
// ticket is in flight (a design is signed off, copy is confirmed), and a review that names a settled
// point as open misleads the developer. So a review RUN — never a view — re-reads the PR's detected
// tickets through the worker's own path (`syncOnePrNow`, the workspace backoff honoured, the keys
// capped at CLAUDE_REVIEW_MAX_TICKETS) just before it builds its prompt. A row read within
// `FRESH_MS` counts as fresh and is not read again (a Claude + Codex pair's second half, a quick
// re-run). A failed read is NOT fatal: the stored copy is used and the result says so (`fresh: false`).
//
// ⚠ NEVER THROWS: any failure is "no open points".

/** A ticket read this recently is fresh enough for a run. */
export const OPEN_POINTS_FRESH_MS = 2 * 60_000;

export interface PrTicketOpenPoints {
  key: string;
  points: TicketOpenPoint[];
  /** Read from the tracker within OPEN_POINTS_FRESH_MS of the run. */
  fresh: boolean;
  fetchedAt: string | null;
}

export async function openPointsForPr(
  ctx: TrackerContext,
  accountId: number,
  prId: number,
  opts: { refresh: boolean; nowMs?: number; transport?: JiraTransport } = { refresh: false },
): Promise<PrTicketOpenPoints[]> {
  let workspaceId: number | null = null;
  try {
    const pr = await ownedPr(ctx, accountId, prId);
    if (pr == null) return [];
    const found = await detectPrTickets(ctx, accountId, pr);
    if (found == null) return [];
    workspaceId = found.workspaceId;
    const keys = found.keys.slice(0, CLAUDE_REVIEW_MAX_TICKETS);
    if (keys.length === 0) return [];
    const prepared = prepareTrackerCall(found.access, { transport: opts.transport, github: githubAccessFor(ctx, accountId) });
    if (!prepared.ok) return [];
    const { provider, apiRoot } = prepared.call;
    const now = (): number => opts.nowMs ?? Date.now();
    const usable = async () =>
      (await readStoredTickets(ctx, accountId, [prId])).filter((r) => r.apiRoot === apiRoot && r.provider === provider);
    const freshAt = (r: { fetchedAt: Date | null } | undefined, at: number): boolean =>
      r?.fetchedAt != null && new Date(r.fetchedAt).getTime() >= at - OPEN_POINTS_FRESH_MS;
    let rows = await usable();
    const t0 = now();
    if (opts.refresh) {
      const stale = keys.filter((k) => !freshAt(rows.find((r) => r.issueKey === k), t0));
      if (stale.length > 0) {
        try {
          await syncOnePrNow(ctx, accountId, prId, stale, {
            force: false,
            transport: opts.transport,
            now: opts.nowMs != null ? () => opts.nowMs! : undefined,
          });
        } catch (err) {
          const code = err instanceof Error && 'code' in err ? String((err as { code: unknown }).code) : 'unknown';
          ctx.log.warn({ accountId, workspaceId, prId, code }, 'open points: tickets not read again; using the stored copy');
        }
        rows = await usable();
      }
    }
    const settings = await readOpenPointsSettings(ctx, accountId, [found.workspaceId]);
    const out: PrTicketOpenPoints[] = [];
    for (const key of keys) {
      const row = rows.find((r) => r.issueKey === key);
      if (row == null || !hasContent(row)) continue;
      const choice = openPointsChoiceFor(settings, found.workspaceId, apiRoot, row.issueTypeId);
      const { points } = deriveOpenPoints(parseCandidates(row.candidatesJson), row.description, choice);
      if (points.length === 0) continue;
      out.push({
        key,
        points,
        // A failed re-read keeps the old content with an error code: that is the stored copy.
        fresh: row.errorCode == null && freshAt(row, t0),
        fetchedAt: row.fetchedAt != null ? new Date(row.fetchedAt).toISOString() : null,
      });
    }
    return out;
  } catch (err) {
    const code = err instanceof Error && 'code' in err ? String((err as { code: unknown }).code) : 'unknown';
    // ⚠ NOT `{ err }` — never serialise the error object on a tracker path.
    ctx.log.warn({ accountId, workspaceId, prId, code }, 'open points: not read');
    return [];
  }
}

/** One STORED row's open points under its workspace's choice (DB only — the story view's read). []
 *  on any failure. */
export async function storedOpenPoints(ctx: TrackerContext, accountId: number, row: StoredTicketRow): Promise<TicketOpenPoint[]> {
  try {
    const settings = await readOpenPointsSettings(ctx, accountId, [row.workspaceId]);
    const choice = openPointsChoiceFor(settings, row.workspaceId, row.apiRoot, row.issueTypeId);
    return deriveOpenPoints(parseCandidates(row.candidatesJson), row.description, choice).points;
  } catch {
    return [];
  }
}
