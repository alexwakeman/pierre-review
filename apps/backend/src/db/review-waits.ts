// ── HOW LONG EACH OUTSTANDING REVIEW REQUEST HAS WAITED (CORE, deterministic, no model) ────────
//
// One fold, three readers: the Pending board's "Waiting on others" rows and its "Over the review
// target" note (`getWorkspaceInsights`, board fold only), and the PR pane's reviewers area
// (`GET /api/prs/:id/review-waits`). docs/BACKEND.md § Waiting on others.
//
// ⚠ THE TARGET IS CHRONOLOGY'S FIRST-LOOK BUDGET ("good"), per workspace, in WORKING hours — the
// value Settings → Workspace → Working hours and budgets already holds. There is no second setting.
//
// ⚠ WHO HOLDS THE BALL is `review_requests` — GitHub's OUTSTANDING requests, reconciled by delete +
// reinsert on every walk, and dropped by GitHub the moment the person reviews. So a row IS "asked
// and has not reviewed since". Requests to automation (a Copilot review, a bot account) are left
// out — asking a bot is not asking someone to look (Chronology's `firstRequestOf` rule) — and so
// is a request to the PR's author.
//
// ⚠ THE CLOCK is the NEWEST stored `requested` event naming that reviewer (a re-request restarts
// it), else the PR's first request, else its opening — the same fallback the My Turn
// `review_request` card dates itself with. A team is matched to its events by slug (GitHub derives
// the slug from the name); no match falls back the same way. The history keeps the first 25 events
// per PR, so a very busy PR can fall back to an EARLIER clock — an over-statement of the wait,
// never an invented zero.
import { and, eq, inArray } from 'drizzle-orm';
import type { ReviewWait } from '@pierre-review/shared';
import { db, schema } from './client.js';
import { getResolvedFlowSettings } from './flow-settings.js';
import { buildWorkingCalendar } from './working-hours.js';

const { reviewRequests, reviewRequestEvents } = schema;

/** The PR fields the clock needs. */
export interface ReviewWaitPr {
  id: number;
  authorId: number | null;
  openedAt: Date;
  firstReviewRequestedAt: Date | null;
}

export interface ReviewWaitsResult {
  /** Per PR: every outstanding request to a person or team, longest wait first. A PR with none is
   *  absent. */
  waits: Map<number, ReviewWait[]>;
  /** The workspace's review target — the first-look budget's "good" value, working hours. */
  targetHours: number;
}

/** GitHub's slug for a team name: lower case, every run of other characters one hyphen. */
export function teamSlugOf(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** One decimal, so float noise stays off the wire. */
function oneDp(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * The outstanding requests on `prs`, each with its working-hour wait in `workspaceId`'s calendar.
 * `isAutomation` is the caller's bot predicate (the board passes its workspace's union, the PR
 * route the same union for the PR's workspace).
 */
export async function reviewWaitsFor(
  accountId: number,
  workspaceId: number,
  prs: readonly ReviewWaitPr[],
  isAutomation: (userId: number) => boolean,
  nowMs: number,
): Promise<ReviewWaitsResult> {
  const settings = await getResolvedFlowSettings(accountId, workspaceId);
  const targetHours = settings.budgets.firstLook.good;
  const waits = new Map<number, ReviewWait[]>();
  if (prs.length === 0) return { waits, targetHours };
  const byId = new Map(prs.map((p) => [p.id, p]));
  const ids = [...byId.keys()];

  const [reqRows, eventRows] = await Promise.all([
    db
      .select({ prId: reviewRequests.prId, userId: reviewRequests.userId, teamName: reviewRequests.teamName })
      .from(reviewRequests)
      .where(inArray(reviewRequests.prId, ids))
      .execute(),
    db
      .select({
        prId: reviewRequestEvents.prId,
        occurredAt: reviewRequestEvents.occurredAt,
        reviewerKind: reviewRequestEvents.reviewerKind,
        reviewerUserId: reviewRequestEvents.reviewerUserId,
        teamSlug: reviewRequestEvents.teamSlug,
      })
      .from(reviewRequestEvents)
      .where(and(inArray(reviewRequestEvents.prId, ids), eq(reviewRequestEvents.kind, 'requested')))
      .execute(),
  ]);

  // The newest `requested` event per (PR, person) and per (PR, team slug).
  const newestUser = new Map<string, number>();
  const newestTeam = new Map<string, number>();
  for (const e of eventRows) {
    const at = e.occurredAt.getTime();
    if (e.reviewerKind === 'user' && e.reviewerUserId != null) {
      const k = `${e.prId}:${e.reviewerUserId}`;
      if (at > (newestUser.get(k) ?? -Infinity)) newestUser.set(k, at);
    } else if (e.reviewerKind === 'team' && e.teamSlug != null) {
      const k = `${e.prId}:${e.teamSlug.toLowerCase()}`;
      if (at > (newestTeam.get(k) ?? -Infinity)) newestTeam.set(k, at);
    }
  }

  type Raw = { prId: number; userId: number | null; teamName: string | null; sinceMs: number };
  const raws: Raw[] = [];
  const seen = new Set<string>();
  for (const r of reqRows) {
    const pr = byId.get(r.prId);
    if (pr == null) continue;
    if (r.userId != null) {
      if (r.userId === pr.authorId || isAutomation(r.userId)) continue;
    } else if (r.teamName == null) continue;
    // `review_requests` has no unique index — never list one reviewer twice.
    const key = r.userId != null ? `${r.prId}:u${r.userId}` : `${r.prId}:t${r.teamName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const fallback = (pr.firstReviewRequestedAt ?? pr.openedAt).getTime();
    const event =
      r.userId != null
        ? newestUser.get(`${r.prId}:${r.userId}`)
        : // A locally stamped team is `owner/slug`; a synced one is GitHub's display name.
          newestTeam.get(`${r.prId}:${teamSlugOf((r.teamName as string).split('/').pop() ?? '')}`);
    // Clamped to the PR's own life: a request dated before the PR opened counts from the opening.
    const sinceMs = Math.min(nowMs, Math.max(event ?? fallback, pr.openedAt.getTime()));
    raws.push({ prId: r.prId, userId: r.userId, teamName: r.userId != null ? null : r.teamName, sinceMs });
  }
  if (raws.length === 0) return { waits, targetHours };

  const fromMs = raws.reduce((lo, r) => Math.min(lo, r.sinceMs), nowMs);
  const cal = buildWorkingCalendar(settings, fromMs, nowMs);
  for (const r of raws) {
    const list = waits.get(r.prId) ?? [];
    list.push({
      userId: r.userId,
      teamName: r.teamName,
      since: new Date(r.sinceMs).toISOString(),
      workHours: oneDp(cal.between(r.sinceMs, nowMs)),
    });
    waits.set(r.prId, list);
  }
  for (const list of waits.values()) {
    list.sort((a, b) => b.workHours - a.workHours || a.since.localeCompare(b.since));
  }
  return { waits, targetHours };
}

/** The note a card carries when its longest wait is over the target; undefined otherwise. */
export function overTarget(
  waitedHours: number | null | undefined,
  targetHours: number,
): { targetHours: number; waitedHours: number } | undefined {
  if (waitedHours == null || !(waitedHours > targetHours)) return undefined;
  return { targetHours, waitedHours };
}
