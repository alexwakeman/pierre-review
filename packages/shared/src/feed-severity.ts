// THE FEED'S BOT FILTERS — one severity scale across every bot, and the bot-type (role) filter.
//
// The Feed's Bots side narrows by two chip rows: SEVERITY (Critical / Major / Minor / Nit, plus
// Unscored) and BOT TYPE (one chip per ReviewerRole). Both are applied by the SERVER, before the
// plain-activity cap and the page slice (GET /api/activity/feed `severities` / `botRoles`), so a
// narrowed page is never an empty slice of a wider stream.
//
// ONE severity scale, two sources:
//   - Ensemble's own posted finding declares its severity in its lead line (`limnFindingPost`):
//     blocker → Critical, warning → Major, question → Minor, nit → Nit (`LIMN_ML_SEVERITY`).
//   - every other bot comment / review body carries the ML score (`ml_comment_labels`).
// The comment's own declared severity WINS over an ML score. An item with neither is "Unscored" —
// a chip of its own, so nothing on the Bots side can silently disappear behind the row.
import { LIMN_ML_SEVERITY, type LimnSeverity } from './limn-severity.js';
import { REVIEWER_ROLES, type MlSeverity, type ReviewerRole } from './types.js';

/** A Feed item's severity bucket: the ML scale, or `unscored`. */
export type FeedSeverity = MlSeverity | 'unscored';

/** Display order of the severity chips: worst first, Unscored last. */
export const FEED_SEVERITIES: readonly FeedSeverity[] = ['critical', 'major', 'minor', 'nit', 'unscored'];

export const FEED_SEVERITY_LABEL: Record<FeedSeverity, string> = {
  critical: 'Critical',
  major: 'Major',
  minor: 'Minor',
  nit: 'Nit',
  unscored: 'Unscored',
};

/**
 * THE mapping. `limnSeverity` (the comment's own declared severity) wins over `mlSeverity`; with
 * neither the item is `unscored`. Pure.
 */
export function feedSeverityOf(input: {
  limnSeverity?: LimnSeverity | null;
  mlSeverity?: MlSeverity | null;
}): FeedSeverity {
  if (input.limnSeverity != null) return LIMN_ML_SEVERITY[input.limnSeverity];
  if (input.mlSeverity != null) return input.mlSeverity;
  return 'unscored';
}

function isFeedSeverity(s: string): s is FeedSeverity {
  return (FEED_SEVERITIES as readonly string[]).includes(s);
}

function isReviewerRoleValue(s: string): s is ReviewerRole {
  return (REVIEWER_ROLES as readonly string[]).includes(s);
}

/**
 * Parse a comma-separated `?severities=` value. Absent, empty, or nothing recognised → null
 * (no narrowing: every severity). Unknown words are dropped. Pure.
 */
export function parseFeedSeverities(raw: string | null | undefined): FeedSeverity[] | null {
  if (!raw) return null;
  const out = [...new Set(raw.split(',').map((s) => s.trim()).filter(isFeedSeverity))];
  return out.length > 0 ? out : null;
}

/**
 * Parse a comma-separated `?botRoles=` value. Absent, empty, or nothing recognised → null (no
 * narrowing: every bot type). Unknown words are dropped. Pure.
 */
export function parseFeedBotRoles(raw: string | null | undefined): ReviewerRole[] | null {
  if (!raw) return null;
  const out = [...new Set(raw.split(',').map((s) => s.trim()).filter(isReviewerRoleValue))];
  return out.length > 0 ? out : null;
}
