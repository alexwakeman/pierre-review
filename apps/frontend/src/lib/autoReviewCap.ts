import type { AutoReviewUsage } from '@pierre-review/shared';

// THE DAILY AUTO-REVIEW LIMIT TOAST'S PURE HALF (components/AutoReviewCapToast.tsx).
//
// It reads the `usage` the auto-review GET already returns (`GET /api/workspaces/:id/auto-review`:
// today's auto code reviews in this workspace since 00:00 UTC, the cap in force, the next 00:00 UTC)
// and folds it into ONE of three states:
//  • 'near'    — at least `AUTO_REVIEW_CAP_NEAR_SHARE` of the cap used, and at least
//                `AUTO_REVIEW_CAP_NEAR_MIN` runs, but not the whole cap;
//  • 'reached' — the cap used (`used` can pass `cap` when the cap was lowered mid-day);
//  • null      — nothing to say.
//
// A dismissal holds for ONE (workspace, UTC day, state): a dismissed 'near' still shows 'reached'
// later that day, and tomorrow starts clean.

export const AUTO_REVIEW_CAP_NEAR_SHARE = 0.8;
export const AUTO_REVIEW_CAP_NEAR_MIN = 2;

export type AutoReviewCapState = 'near' | 'reached';

export interface AutoReviewCapView {
  state: AutoReviewCapState;
  used: number;
  cap: number;
  resetsAt: string;
}

export function autoReviewCapState(usage: AutoReviewUsage | null | undefined): AutoReviewCapView | null {
  if (usage == null) return null;
  const { used, cap, resetsAt } = usage;
  if (!Number.isFinite(used) || !Number.isFinite(cap) || cap <= 0) return null;
  if (used >= cap) return { state: 'reached', used, cap, resetsAt };
  if (used >= AUTO_REVIEW_CAP_NEAR_MIN && used >= cap * AUTO_REVIEW_CAP_NEAR_SHARE) {
    return { state: 'near', used, cap, resetsAt };
  }
  return null;
}

/** The UTC day a `resetsAt` closes ("2026-11-03" for a reset at 2026-11-04T00:00Z). */
export function utcDayOf(resetsAt: string): string {
  const ms = Date.parse(resetsAt);
  if (!Number.isFinite(ms)) return 'unknown';
  return new Date(ms - 86_400_000).toISOString().slice(0, 10);
}

/** The dismissal key: one workspace, one UTC day, one state. */
export function autoReviewCapDismissKey(workspaceId: number, view: AutoReviewCapView): string {
  return `${workspaceId}:${utcDayOf(view.resetsAt)}:${view.state}`;
}

/** Keep only today's keys (a key from another day can never match again). */
export function pruneCapDismissals(keys: readonly string[], view: AutoReviewCapView): string[] {
  const day = utcDayOf(view.resetsAt);
  return keys.filter((k) => k.split(':')[1] === day);
}

/** "7:00 pm", or "1:00 am tomorrow" when the reset falls on the reader's next local day. */
export function capResumeText(resetsAt: string, nowMs: number, locale?: string): string {
  const ms = Date.parse(resetsAt);
  if (!Number.isFinite(ms)) return 'midnight UTC';
  const at = new Date(ms);
  const time = at.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
  const now = new Date(nowMs);
  const sameDay =
    at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth() && at.getDate() === now.getDate();
  return sameDay ? time : `${time} tomorrow`;
}

/** The toast's label and summary. */
export function autoReviewCapCopy(view: AutoReviewCapView, nowMs: number, locale?: string): { label: string; summary: string } {
  if (view.state === 'near') {
    return { label: 'Auto reviews', summary: `${view.used} of ${view.cap} used today.` };
  }
  return {
    label: 'Auto reviews stopped for today',
    summary: `The daily limit of ${view.cap} is used. They start again at ${capResumeText(view.resetsAt, nowMs, locale)}.`,
  };
}
