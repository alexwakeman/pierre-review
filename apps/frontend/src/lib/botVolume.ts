import type { BotVolumeBot } from '@pierre-review/shared';

// Pure formatting + lookup helpers for the ROI table's "Comments/PR" column (bot-comment VOLUME).
// CORE/free, no AI.
//
// ⚠ NOTHING HERE COMPUTES A NUMBER. Every count, average, expectation and ratio arrives from
// `/api/bot-analytics/volume*`, which folds the column and the size chart from ONE scan
// precisely so they cannot disagree — a client-side re-derivation would be a second opinion about
// the same window, which is the failure this whole surface was specced against. These functions
// only decide how an existing number READS, and each one exists because the obvious rendering of
// its input is a lie:
//   • an average of 0.04 must not print as "0.0" (it would read as "this bot says nothing");
//   • a bot absent from the response "said nothing", which is a dash, not a zero.

/**
 * Index a volume response's bots by their `u<userId>` key — the SAME key spelling
 * `BotVendorAnalytics.key` uses, which is what lets the ROI table join this onto the row it
 * already renders.
 *
 * ⚠ A BOT WITH NO COMMENTS IN THE WINDOW IS ABSENT FROM THE RESPONSE (unlike the ROI table's
 * dormant rows, which survive on their 12-week trend). So a miss here means "this bot said nothing
 * in this window", and the cell must render a DASH, never a 0 — the ROI table dashes every other
 * dormant metric for exactly that reason.
 */
export function volumeByKey(bots: BotVolumeBot[] | undefined): Map<string, BotVolumeBot> {
  return new Map((bots ?? []).map((b) => [b.key, b]));
}

/**
 * A per-PR average, as the column prints it.
 *
 * ONE decimal place: the wire carries 2dp, but a table cell reading "16.89" invites a precision
 * this number does not have (it moves with every merge). The interesting cases are the ends:
 *   • exactly 0 → "0" (a real, flat answer: this bot commented on PRs but said nothing here —
 *     unreachable today, since a bot with no comments is omitted entirely, but it must not print
 *     as an empty cell if it ever does);
 *   • 0 < v < 0.05 → "<0.1", because `toFixed(1)` would round it to "0.0" and the reader cannot
 *     tell that apart from silence. Measured: mrdoob/three.js's per-scope-PR averages sit near
 *     this floor precisely because 656 of its 796 merged PRs drew nothing.
 * `null` (no denominator — the bot commented on nothing, or the scope has no merged PRs) is the
 * caller's dash, not a zero.
 */
export function formatAvg(v: number | null): string {
  if (v == null) return '—';
  if (v === 0) return '0';
  if (v > 0 && v < 0.05) return '<0.1';
  return v.toFixed(1);
}
