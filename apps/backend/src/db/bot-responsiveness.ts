// Workspace-level REVIEW-bot responsiveness — the two headline tiles on Bots Monitoring.
// A PURE fold (no DB) over the touch map getBotBehaviourAnalytics already builds, so the tiles
// and the per-bot rows measure the SAME touches, the SAME bots (the workspace's stored
// role-'review' set) and the SAME clock rule. The DB-side caller lives in db/queries.ts.
//
// Per PR, the reviewing bots are pooled into ONE cohort:
//   • time to first review = the FIRST touch by ANY review bot − ready-for-review (when observed
//     at/before that touch), else − opened. The per-bot ttfr rule, applied to the pooled first touch.
//   • follow-ups = every touch after that first one, by ANY review bot (a second bot's first pass
//     counts: the PR got more bot review after the first). Same counting as the per-bot
//     followupRatePct / avgFollowups (each review / comment row is one touch).
// Headline figures cover PRs whose pooled first touch lands in the window [fromMs, …); the weekly
// series buckets every trend-span PR by its first-touch week on the caller's week boundaries.
// Unknown is not zero: no PRs ⇒ null figures, `prs: 0`.
import type {
  BotResponsiveness,
  BotResponsivenessWeekPoint,
} from '@pierre-review/shared';

const HOUR = 3_600_000;

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}
// Nearest-rank, identical to db/queries.ts percentileOf (the per-bot ttfrP90Hours).
function percentile(xs: number[], p: number): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1));
  return s[idx]!;
}
const rate = (withFollowup: number, total: number): number | null =>
  total > 0 ? Math.round((withFollowup / total) * 100) : null;
const mean1 = (sum: number, n: number): number | null =>
  n > 0 ? Math.round((sum / n) * 10) / 10 : null;

export interface BotResponsivenessInput {
  // userId → prId → touch times (ms). Only review bots' touches, trend span ⊇ window.
  touchesByUserPr: ReadonlyMap<number, ReadonlyMap<number, ReadonlyArray<{ ms: number }>>>;
  openedMsByPr: ReadonlyMap<number, number>; // a PR missing here is skipped (no clock start)
  readyMsByPr: ReadonlyMap<number, number>; // earliest observed ready-for-review
  fromMs: number; // window start
  weekStarts: readonly string[]; // THE trend week boundaries (ISO), oldest → newest
  weekIndexOf: (ms: number) => number;
}

export function emptyBotResponsiveness(weekStarts: readonly string[]): BotResponsiveness {
  return {
    prs: 0,
    ttfrMedianHours: null,
    ttfrP90Hours: null,
    ttfrBaseline: null,
    followupRatePct: null,
    avgFollowups: null,
    trend: weekStarts.map((weekStart) => ({
      weekStart,
      prs: 0,
      ttfrMedianHours: null,
      followupRatePct: null,
      avgFollowups: null,
    })),
  };
}

export function foldBotResponsiveness(input: BotResponsivenessInput): BotResponsiveness {
  const { touchesByUserPr, openedMsByPr, readyMsByPr, fromMs, weekStarts, weekIndexOf } = input;

  // Pool every review bot's touches per PR.
  const byPr = new Map<number, number[]>();
  for (const prs of touchesByUserPr.values())
    for (const [prId, touches] of prs) {
      let arr = byPr.get(prId);
      if (!arr) {
        arr = [];
        byPr.set(prId, arr);
      }
      for (const t of touches) arr.push(t.ms);
    }

  const ttfr: number[] = [];
  const tally = { ready: 0, opened: 0 };
  let withFollowup = 0;
  let extraSum = 0;
  const weeks = weekStarts.map(() => ({ ttfr: [] as number[], withFollowup: 0, extraSum: 0 }));

  for (const [prId, times] of byPr) {
    const openedMs = openedMsByPr.get(prId);
    if (openedMs == null || times.length === 0) continue;
    const firstMs = Math.min(...times);
    const readyMs = readyMsByPr.get(prId);
    const useReady = readyMs != null && readyMs <= firstMs;
    const hours = Math.max(0, (firstMs - (useReady ? readyMs : openedMs)) / HOUR);
    const extra = times.length - 1;

    const w = weeks[weekIndexOf(firstMs)];
    if (w) {
      w.ttfr.push(hours);
      w.extraSum += extra;
      if (extra > 0) w.withFollowup += 1;
    }
    if (firstMs >= fromMs) {
      ttfr.push(hours);
      tally[useReady ? 'ready' : 'opened'] += 1;
      extraSum += extra;
      if (extra > 0) withFollowup += 1;
    }
  }

  const n = ttfr.length;
  const trend: BotResponsivenessWeekPoint[] = weeks.map((w, i) => ({
    weekStart: weekStarts[i]!,
    prs: w.ttfr.length,
    ttfrMedianHours: median(w.ttfr),
    followupRatePct: rate(w.withFollowup, w.ttfr.length),
    avgFollowups: mean1(w.extraSum, w.ttfr.length),
  }));
  return {
    prs: n,
    ttfrMedianHours: median(ttfr),
    ttfrP90Hours: percentile(ttfr, 0.9),
    ttfrBaseline:
      n === 0
        ? null
        : tally.ready > 0 && tally.opened > 0
          ? 'mixed'
          : tally.ready > 0
            ? 'ready'
            : 'opened',
    followupRatePct: rate(withFollowup, n),
    avgFollowups: mean1(extraSum, n),
    trend,
  };
}
