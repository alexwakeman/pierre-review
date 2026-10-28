import type { AgentContext } from '../../review/agent-context.js';
import { buildHeld, enqueueBuild } from '../manager.js';
import { isBuilding, listDocRows, requeueDoc, stampDocsUsed, wikiDocRows, wikiStateOf, workspacesUsedSince, type DocRow } from '../store.js';
import { quickCheckWikiDoc } from './build.js';

// KEEPING WIKI DOCUMENTS CURRENT (docs/REFERENCE-DOCS.md § Wiki sources → Refresh). Three triggers, ONE
// cheap check (build.ts `quickCheckWikiDoc`: no page body is read) and ONE refresh (a build with
// `full: false` — only the changed pages are read and only the changed sections summarised):
//
//   the cadence    every hour, the wiki documents of workspaces whose library was USED in the last
//                  7 days (`workspaces.docs_used_at`), not checked for WIKI_CHECK_INTERVAL_MS, past any
//                  429 Retry-After — at most WIKI_CHECKS_PER_TICK per tick, oldest check first.
//   before use     a review / ticket review / story check that reads the library kicks a check of the
//                  workspace's wiki documents not checked in the last WIKI_PRE_USE_MIN_AGE_MS. It never
//                  waits: the run reads the current version, the refresh lands for the next one.
//   Refresh now    the document's button (routes.ts) queues the refresh directly.
//
// ⚠ The first two are AUTOMATIC: their refresh asks the spend budget before any model call and is
// SKIPPED, never queued, when over (manager.ts). The check itself costs no model.

export const WIKI_CHECK_INTERVAL_MS = 3 * 3600_000;
export const WIKI_USED_WINDOW_MS = 7 * 24 * 3600_000;
export const WIKI_PRE_USE_MIN_AGE_MS = 15 * 60_000;
export const WIKI_CHECKS_PER_TICK = 10;
export const WIKI_REFRESH_CRON = '41 * * * *';
const USED_STAMP_THROTTLE_MS = 10 * 60_000;

let bound: AgentContext | null = null;
const checking = new Set<number>();
const usedStamped = new Map<string, number>();

/** Boot (review/agentic.ts): remember the context and schedule the cadence. */
export function bindWikiRefresh(ctx: AgentContext): void {
  bound = ctx;
  ctx.registerScheduledJob(WIKI_REFRESH_CRON, async () => void (await runWikiRefreshTick(ctx)), 'reference-docs-wiki-refresh');
}

/** Test seam. */
export function _bindWikiRefreshForTest(ctx: AgentContext | null): void {
  bound = ctx;
}

/** Stamp the workspace's library as used (throttled; never throws). */
export function noteDocsUsed(accountId: number, workspaceId: number, now = Date.now()): void {
  const key = `${accountId}:${workspaceId}`;
  const last = usedStamped.get(key) ?? 0;
  if (now - last < USED_STAMP_THROTTLE_MS) return;
  usedStamped.set(key, now);
  void stampDocsUsed(accountId, workspaceId, new Date(now)).catch(() => {});
}

/** Is this wiki document due a check at `now` (given a minimum age since its last one)? Pure. */
export function wikiCheckDue(row: Pick<DocRow, 'status' | 'builtAt' | 'wiki'>, now: number, minAgeMs: number): boolean {
  const s = wikiStateOf(row.wiki);
  if (!s || row.builtAt == null || isBuilding(row.status)) return false;
  if (s.retryAfter != null && s.retryAfter > now) return false;
  return s.lastCheckedAt == null || now - s.lastCheckedAt >= minAgeMs;
}

/** Check one document; queue its refresh when something changed. Returns what the check said. */
export async function checkAndMaybeRefresh(ctx: AgentContext, row: DocRow, automatic: boolean, now: () => number = Date.now): Promise<string> {
  if (checking.has(row.id) || buildHeld(row.id)) return 'busy';
  checking.add(row.id);
  try {
    const res = await quickCheckWikiDoc(row, now);
    if (res === 'changed' && (await requeueDoc(row.accountId, row.id))) {
      enqueueBuild(ctx, row.accountId, row.workspaceId, row.id, { full: false, automatic });
    }
    return res;
  } catch (err) {
    ctx.log.warn(`reference doc ${row.id}: wiki check failed: ${err instanceof Error ? err.message : String(err)}`);
    return 'error';
  } finally {
    checking.delete(row.id);
  }
}

/** One tick of the cadence (exported for its test). */
export async function runWikiRefreshTick(ctx: AgentContext, now: () => number = Date.now): Promise<number> {
  const t = now();
  const used = new Set((await workspacesUsedSince(new Date(t - WIKI_USED_WINDOW_MS))).map((w) => `${w.accountId}:${w.workspaceId}`));
  if (used.size === 0) return 0;
  const due = (await wikiDocRows())
    .filter((r) => used.has(`${r.accountId}:${r.workspaceId}`) && wikiCheckDue(r, t, WIKI_CHECK_INTERVAL_MS))
    .sort((a, b) => (wikiStateOf(a.wiki)?.lastCheckedAt ?? 0) - (wikiStateOf(b.wiki)?.lastCheckedAt ?? 0))
    .slice(0, WIKI_CHECKS_PER_TICK);
  for (const row of due) await checkAndMaybeRefresh(ctx, row, true, now);
  return due.length;
}

/**
 * BEFORE A RUN READS THE LIBRARY (context.ts `reviewDocsFor`, the story check): stamp the library as
 * used and, in the background, check its wiki documents not checked recently. Never blocks, never throws.
 */
export function kickWikiRefresh(accountId: number, workspaceId: number): void {
  noteDocsUsed(accountId, workspaceId);
  const ctx = bound;
  if (!ctx) return;
  void (async () => {
    const rows = (await listDocRows(accountId, workspaceId)).filter((r) => r.sourceKind === 'wiki' && wikiCheckDue(r, Date.now(), WIKI_PRE_USE_MIN_AGE_MS));
    for (const row of rows.slice(0, WIKI_CHECKS_PER_TICK)) await checkAndMaybeRefresh(ctx, row, true);
  })().catch(() => {});
}
