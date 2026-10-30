import { and, eq, gte, inArray, lt } from 'drizzle-orm';
import {
  AI_USAGE_FEATURE_GROUPS,
  aiModelName,
  aiUsageFeatureGroup,
  claudeModelRole,
  emptyAiUsageFigures,
  formatTokens,
  isSpecialistFeature,
  trackerTicketIdent,
  AI_MODEL_FOR_ROLE,
  type AiModelRole,
  type AiUsageCostUnit,
  type AiUsageDayBucket,
  type AiUsageFeatureGroup,
  type AiUsageFigures,
  type AiUsageInsight,
  type AiUsagePrRef,
  type AiUsagePrRow,
  type AiUsageReportResponse,
  type AiUsageStoryRow,
  type AiUsageSuggestion,
  type AiUsageWeek,
  type TrackerProvider,
} from '@pierre-review/shared';
import { db, schema } from './client.js';
import type { BotScope } from './queries.js';
import { measuredTo, reportingWindowInfo, type ReportingWindow } from './reporting-window.js';

// REPORTS → AI USAGE — the fold behind GET /api/ai/usage-report (docs/API.md; types in packages/shared
// ai-usage-report.ts). DB only: no model, no GitHub, no tracker.
//
//   • THE LEDGER (`ai_usage`, one row per billable run) is the population for every TOTAL: the
//     feature groups, the day chart, the top pull requests and the 12 weeks.
//   • SCOPE. A row tied to a pull request belongs to that PR's repository's workspace; a row tied
//     only to a repository, to that repository's. A row tied to NEITHER (sprint view, docs, the
//     one-shot summaries) is MACHINE-WIDE: it is counted in every workspace and the response says
//     how many such runs there are (`machineWideRuns`). A row whose PR is gone (the ledger survives
//     pruning) and carries no repository cannot be placed and is left out.
//   • THE WINDOW is the workspace's reporting window, resolved ONCE by the route
//     (`getReportingWindow`). The 12 weeks are the LABELLED exception, read in the same request.
//   • THE RUN TABLES (`claude_reviews`, `ticket_reviews`) carry what the ledger does not — status,
//     trigger, head, diff size, cache reads — and feed the suggestions and insights only. Top stories
//     take a story's own ticket reviews from `ticket_reviews` (they name the ticket; the ledger names
//     only the origin PR) plus every other ledger row of its pull requests.
//   • COST: ONE unit, Claude's (`costUnit`). The route converts US$ to a share of a week with the
//     budget's own rate BEFORE this fold sees it, so a subscription's figures never hold US$.
//
// ⚠ Every sentence here names a count, a share or a token figure — never a cost. The SPA words the
// cost through lib/aiBudget.ts, the ONE place a cost becomes text.

const CHUNK = 400;
const DAY_MS = 86_400_000;
export const AI_USAGE_WEEKS = 12;
export const AI_USAGE_TOP_ROWS = 10;
/** A review over this many diff bytes is a "large diff" for the suggestion. */
export const AI_USAGE_LARGE_DIFF_BYTES = 150_000;
/** Auto reviews a PR may take before the rest count as the saving. */
export const AI_USAGE_AUTO_REVIEWS_KEPT = 2;
/** Manual reviews a PR may take before the rest count as the saving. */
export const AI_USAGE_MANUAL_REVIEWS_KEPT = 3;

export interface LedgerRowIn {
  feature: string;
  provider: string | null;
  model: string;
  /** Already in the response's cost unit (US$ or % of a week), Claude rows only; 0 otherwise. */
  cost: number;
  inputTokens: number | null;
  outputTokens: number | null;
  prId: number | null;
  repoId: number | null;
  occurredAtMs: number;
}

export interface ReviewRowIn {
  prId: number;
  status: string;
  trigger: 'manual' | 'auto';
  kind: 'replies' | null;
  provider: string | null;
  model: string;
  /** In the cost unit (Claude rows); 0 otherwise. */
  cost: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  diffBytes: number | null;
  createdAtMs: number;
}

export interface TicketReviewRowIn {
  ident: string;
  key: string | null;
  title: string | null;
  status: string;
  trigger: string;
  provider: string | null;
  cost: number;
  inputTokens: number | null;
  outputTokens: number | null;
  createdAtMs: number;
}

export interface PrMetaIn {
  id: number;
  number: number;
  title: string;
  repoFullName: string;
}

export interface StoryLinkIn {
  ident: string;
  key: string;
  title: string | null;
}

export interface AiUsageFoldInput {
  nowMs: number;
  fromMs: number;
  /** The measured end, min(window end, now). */
  toMs: number;
  costUnit: AiUsageCostUnit | null;
  /** Ledger rows already scoped to the workspace, from the earlier of `fromMs` and the 12 weeks. */
  ledger: readonly LedgerRowIn[];
  /** Code-review runs on this workspace's PRs created in the window. */
  reviews: readonly ReviewRowIn[];
  /** This workspace's ticket reviews created in the window. */
  ticketReviews: readonly TicketReviewRowIn[];
  prs: ReadonlyMap<number, PrMetaIn>;
  storyLinks: ReadonlyMap<number, readonly StoryLinkIn[]>;
  /** Local midnight at or before `ms` (injected so tests pin a time zone). */
  dayStart?: (ms: number) => number;
}

/** Local midnight at or before `ms`. */
export function localDayStart(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function addDays(ms: number, n: number): number {
  const d = new Date(ms);
  d.setDate(d.getDate() + n);
  return d.getTime();
}

/** The Monday on or before `ms`, at local midnight. */
export function localWeekStart(ms: number, dayStart: (ms: number) => number = localDayStart): number {
  const d = new Date(dayStart(ms));
  const back = (d.getDay() + 6) % 7;
  return dayStart(addDays(d.getTime(), -back));
}

/** The first instant the 12 weeks cover. */
export function weeksFromMs(nowMs: number, dayStart: (ms: number) => number = localDayStart): number {
  return dayStart(addDays(localWeekStart(nowMs, dayStart), -7 * (AI_USAGE_WEEKS - 1)));
}

function tokensOf(r: { inputTokens: number | null; outputTokens: number | null }): number | null {
  if (r.inputTokens == null && r.outputTokens == null) return null;
  return (r.inputTokens ?? 0) + (r.outputTokens ?? 0);
}

function isCodex(provider: string | null): boolean {
  return provider === 'codex';
}

/** Add one run to a figures record. */
function add(f: AiUsageFigures, r: { provider: string | null; cost: number; inputTokens: number | null; outputTokens: number | null }): void {
  f.runs += 1;
  const t = tokensOf(r) ?? 0;
  f.tokens += t;
  if (isCodex(r.provider)) f.codexTokens += t;
  else {
    f.claudeTokens += t;
    if (f.claudeCost != null && Number.isFinite(r.cost) && r.cost > 0) f.claudeCost += r.cost;
  }
}

function sumOf(rows: readonly ReviewRowIn[], unit: AiUsageCostUnit | null): AiUsageFigures {
  const f = emptyAiUsageFigures(unit);
  for (const r of rows) add(f, r);
  return f;
}

function pct(part: number, whole: number): number {
  return whole <= 0 ? 0 : Math.round((part / whole) * 100);
}

function plural(n: number, one: string, many: string = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** A model id's role on its provider (the backend's own resolution, read back). */
export function modelRole(provider: string | null, model: string): AiModelRole {
  if (isCodex(provider)) {
    const m = AI_MODEL_FOR_ROLE.codex;
    return model === m.deep ? 'deep' : model === m.fast ? 'fast' : 'standard';
  }
  return claudeModelRole(model);
}

function byCountDesc<T>(rows: T[], tokens: (r: T) => number, runs: (r: T) => number): T[] {
  return rows.sort((a, b) => tokens(b) - tokens(a) || runs(b) - runs(a));
}

/** THE PURE FOLD (tests pin it): everything but the reads. */
export function foldAiUsageReport(
  input: AiUsageFoldInput,
): Omit<AiUsageReportResponse, 'workspaceId' | 'window'> {
  const unit = input.costUnit;
  const dayStart = input.dayStart ?? localDayStart;
  const { fromMs, toMs, nowMs } = input;
  const inWindow = (ms: number): boolean => ms >= fromMs && ms < toMs;
  const windowRows = input.ledger.filter((r) => inWindow(r.occurredAtMs));

  // ---- totals + groups + days ----
  const totals = emptyAiUsageFigures(unit);
  const groups = new Map<AiUsageFeatureGroup, AiUsageFigures>();
  const dayStarts: number[] = [];
  for (let d = dayStart(fromMs); d < toMs; d = addDays(d, 1)) dayStarts.push(d);
  const dayIndex = new Map(dayStarts.map((d, i) => [d, i]));
  const days: AiUsageDayBucket[] = dayStarts.map((d) => ({ start: new Date(d).toISOString(), tokens: {} }));
  let machineWideRuns = 0;
  let unmeasuredRuns = 0;
  for (const r of windowRows) {
    add(totals, r);
    const g = aiUsageFeatureGroup(r.feature);
    let gf = groups.get(g);
    if (gf == null) groups.set(g, (gf = emptyAiUsageFigures(unit)));
    add(gf, r);
    if (r.prId == null && r.repoId == null) machineWideRuns += 1;
    const t = tokensOf(r);
    if (t == null) unmeasuredRuns += 1;
    const i = dayIndex.get(dayStart(r.occurredAtMs));
    if (i != null && t != null && t > 0) {
      const b = days[i]!;
      b.tokens[g] = (b.tokens[g] ?? 0) + t;
    }
  }
  const groupRows = AI_USAGE_FEATURE_GROUPS.flatMap((g) => {
    const f = groups.get(g);
    return f == null ? [] : [{ group: g, figures: f }];
  }).sort((a, b) => b.figures.tokens - a.figures.tokens || b.figures.runs - a.figures.runs);

  // ---- top pull requests ----
  const byPr = new Map<number, AiUsageFigures>();
  for (const r of windowRows) {
    if (r.prId == null || !input.prs.has(r.prId)) continue;
    let f = byPr.get(r.prId);
    if (f == null) byPr.set(r.prId, (f = emptyAiUsageFigures(unit)));
    add(f, r);
  }
  const topPrs: AiUsagePrRow[] = byCountDesc(
    [...byPr.entries()].map(([prId, figures]) => {
      const m = input.prs.get(prId)!;
      return { prId, number: m.number, title: m.title, repoFullName: m.repoFullName, figures };
    }),
    (r) => r.figures.tokens,
    (r) => r.figures.runs,
  ).slice(0, AI_USAGE_TOP_ROWS);

  // ---- top stories: the story's own ticket reviews + every other ledger row of its PRs ----
  const stories = new Map<string, { row: AiUsageStoryRow; prs: Set<number> }>();
  const story = (ident: string, key: string | null, title: string | null) => {
    let s = stories.get(ident);
    if (s == null) {
      s = { row: { ident, key: key ?? ident, title, prCount: 0, figures: emptyAiUsageFigures(unit) }, prs: new Set() };
      stories.set(ident, s);
    }
    if (s.row.title == null && title != null) s.row.title = title;
    return s;
  };
  for (const t of input.ticketReviews) {
    if (!inWindow(t.createdAtMs)) continue;
    add(story(t.ident, t.key, t.title).row.figures, t);
  }
  for (const r of windowRows) {
    if (r.prId == null || aiUsageFeatureGroup(r.feature) === 'story') continue;
    for (const link of input.storyLinks.get(r.prId) ?? []) {
      const s = story(link.ident, link.key, link.title);
      add(s.row.figures, r);
      s.prs.add(r.prId);
    }
  }
  const topStories = byCountDesc(
    [...stories.values()].map((s) => ({ ...s.row, prCount: s.prs.size })),
    (r) => r.figures.tokens,
    (r) => r.figures.runs,
  ).slice(0, AI_USAGE_TOP_ROWS);

  // ---- the 12 weeks (LABELLED exception) ----
  const firstWeek = weeksFromMs(nowMs, dayStart);
  const weekStarts: number[] = [];
  for (let i = 0, w = firstWeek; i < AI_USAGE_WEEKS; i += 1, w = addDays(w, 7)) weekStarts.push(dayStart(w));
  const weeks: AiUsageWeek[] = weekStarts.map((w, i) => ({
    start: new Date(w).toISOString(),
    partial: i === AI_USAGE_WEEKS - 1,
    figures: emptyAiUsageFigures(unit),
  }));
  for (const r of input.ledger) {
    if (r.occurredAtMs < firstWeek || r.occurredAtMs >= nowMs + 1) continue;
    const i = weekStarts.findIndex((w, k) => r.occurredAtMs >= w && (k === weekStarts.length - 1 || r.occurredAtMs < weekStarts[k + 1]!));
    if (i >= 0) add(weeks[i]!.figures, r);
  }
  const weeklySlope = slopeOf(weeks.filter((w) => !w.partial).map((w) => w.figures.tokens));

  // ---- suggestions + insights (the run tables) ----
  const reviews = input.reviews.filter((r) => inWindow(r.createdAtMs));
  const full = reviews.filter((r) => r.kind == null && r.status !== 'queued' && r.status !== 'running');
  const suggestions: AiUsageSuggestion[] = [];
  const insights: AiUsageInsight[] = [];
  // The pull requests behind a suggestion, most first, named (≤ 5; an unnamed PR is skipped).
  const refs = (counts: ReadonlyMap<number, number>): AiUsagePrRef[] =>
    topIds(counts)
      .flatMap((id) => {
        const p = input.prs.get(id);
        return p == null ? [] : [{ prId: id, number: p.number, title: p.title, repoFullName: p.repoFullName }];
      })
      .slice(0, 5);

  // 1. Auto review re-running on many pushes.
  const autoByPr = groupByPr(full.filter((r) => r.trigger === 'auto'));
  {
    let runs = 0;
    let reruns = 0;
    const excess: ReviewRowIn[] = [];
    const prExcess = new Map<number, number>();
    for (const [prId, rows] of autoByPr) {
      runs += rows.length;
      reruns += rows.length - 1;
      const extra = rows.slice(AI_USAGE_AUTO_REVIEWS_KEPT);
      excess.push(...extra);
      if (extra.length > 0) prExcess.set(prId, extra.length);
    }
    if (excess.length >= 2) {
      suggestions.push({
        kind: 'auto_rereviews',
        fact: `Auto review ran ${plural(runs, 'time')} on ${plural(autoByPr.size, 'pull request')}; ${reruns} ${reruns === 1 ? 'was a re-review' : 'were re-reviews'} after new pushes or comments.`,
        action: `Saving if each pull request were auto-reviewed at most ${AI_USAGE_AUTO_REVIEWS_KEPT} times.`,
        saving: savingOf(excess, unit),
        setting: 'auto-review',
        prs: refs(prExcess),
      });
    }
  }

  // 2. Runs that failed or were stopped after spending.
  {
    const failedReviews = reviews.filter((r) => (r.status === 'failed' || r.status === 'cancelled') && (tokensOf(r) ?? 0) > 0);
    const failedTickets = input.ticketReviews.filter(
      (t) => inWindow(t.createdAtMs) && (t.status === 'failed' || t.status === 'cancelled') && (tokensOf(t) ?? 0) > 0,
    );
    const n = failedReviews.length + failedTickets.length;
    if (n >= 2) {
      const saving = savingOf([...failedReviews, ...failedTickets], unit);
      const anyAuto = failedReviews.some((r) => r.trigger === 'auto') || failedTickets.some((t) => t.trigger !== 'manual');
      const prCounts = new Map<number, number>();
      for (const r of failedReviews) prCounts.set(r.prId, (prCounts.get(r.prId) ?? 0) + 1);
      suggestions.push({
        kind: 'failed_runs',
        fact: `${plural(n, 'run')} failed or ${n === 1 ? 'was' : 'were'} stopped after using ${formatTokens(saving.tokens)} tokens.`,
        action: 'Tokens spent with no result.',
        saving,
        setting: anyAuto ? 'auto-review' : null,
        prs: refs(prCounts),
      });
    }
  }

  // 3. Large-diff reviews dominating code review.
  const codeFull = full.filter((r) => r.status === 'succeeded' || r.status === 'failed' || r.status === 'cancelled');
  {
    const codeTokens = codeFull.reduce((n, r) => n + (tokensOf(r) ?? 0), 0);
    const large = codeFull.filter((r) => (r.diffBytes ?? 0) >= AI_USAGE_LARGE_DIFF_BYTES);
    const rest = codeFull.filter((r) => (r.diffBytes ?? 0) < AI_USAGE_LARGE_DIFF_BYTES && tokensOf(r) != null);
    const largeTokens = large.reduce((n, r) => n + (tokensOf(r) ?? 0), 0);
    const typical = median(rest.map((r) => tokensOf(r)!));
    const typicalCost = median(rest.filter((r) => !isCodex(r.provider)).map((r) => r.cost));
    if (large.length >= 2 && codeTokens > 0 && largeTokens / codeTokens >= 0.25 && typical != null) {
      const f = emptyAiUsageFigures(unit);
      for (const r of large) {
        const t = tokensOf(r) ?? 0;
        f.tokens += Math.max(0, t - typical);
        if (f.claudeCost != null && !isCodex(r.provider) && typicalCost != null) f.claudeCost += Math.max(0, r.cost - typicalCost);
      }
      const prCounts = new Map<number, number>();
      for (const r of large) prCounts.set(r.prId, (prCounts.get(r.prId) ?? 0) + (tokensOf(r) ?? 0));
      suggestions.push({
        kind: 'large_diffs',
        fact: `${plural(large.length, 'review')} of diffs over ${Math.round(AI_USAGE_LARGE_DIFF_BYTES / 1000)} KB used ${pct(largeTokens, codeTokens)}% of code review tokens.`,
        action: 'Saving if they had cost a typical review. Smaller pull requests review for less.',
        saving: { tokens: f.tokens, claudeCost: f.claudeCost },
        setting: null,
        prs: refs(prCounts),
      });
    }
  }

  // 4. Model mix: the deepest model against the standard one, measured on this workspace's own runs.
  {
    const byRole = { deep: [] as ReviewRowIn[], standard: [] as ReviewRowIn[], fast: [] as ReviewRowIn[] };
    for (const r of codeFull) byRole[modelRole(r.provider, r.model)].push(r);
    const roleTokens = (rs: ReviewRowIn[]) => rs.reduce((n, r) => n + (tokensOf(r) ?? 0), 0);
    const all = roleTokens(codeFull);
    if (codeFull.length > 0 && all > 0) {
      const deepPct = pct(roleTokens(byRole.deep), all);
      const deepModel = byRole.deep[0] != null ? aiModelName(byRole.deep[0].model) : null;
      insights.push({
        kind: 'model_mix',
        text:
          byRole.deep.length === 0
            ? 'No code review ran on the deepest model.'
            : `${deepPct}% of code review tokens went to the deepest model${deepModel != null ? ` (${deepModel})` : ''}.`,
      });
    }
    const measured = (rs: ReviewRowIn[]) => rs.filter((r) => tokensOf(r) != null);
    const deep = measured(byRole.deep);
    const std = measured(byRole.standard);
    if (deep.length >= 3 && std.length >= 3) {
      const meanTok = (rs: ReviewRowIn[]) => roleTokens(rs) / rs.length;
      const claudeOf = (rs: ReviewRowIn[]) => rs.filter((r) => !isCodex(r.provider));
      const meanCost = (rs: ReviewRowIn[]) => (rs.length === 0 ? null : rs.reduce((n, r) => n + r.cost, 0) / rs.length);
      const dTok = Math.max(0, meanTok(deep) - meanTok(std));
      const dc = meanCost(claudeOf(deep));
      const sc = meanCost(claudeOf(std));
      const costSaving = unit == null || dc == null || sc == null ? null : Math.max(0, dc - sc) * claudeOf(deep).length;
      if (dTok > 0 || (costSaving ?? 0) > 0) {
        const prCounts = new Map<number, number>();
        for (const r of deep) prCounts.set(r.prId, (prCounts.get(r.prId) ?? 0) + 1);
        suggestions.push({
          kind: 'deep_model',
          fact: `${plural(deep.length, 'code review')} ran on the deepest model and ${plural(std.length, 'code review')} on the standard one.`,
          action: "Saving if the deepest model's reviews had cost the standard model's average.",
          saving: { tokens: Math.round(dTok * deep.length), claudeCost: costSaving },
          setting: 'ai-effort',
          prs: refs(prCounts),
        });
      }
    }
  }

  // 5. Pull requests reviewed by hand many times.
  {
    const manualByPr = groupByPr(full.filter((r) => r.trigger === 'manual'));
    const excess: ReviewRowIn[] = [];
    const prExcess = new Map<number, number>();
    let prs = 0;
    let runs = 0;
    for (const [prId, rows] of manualByPr) {
      if (rows.length <= AI_USAGE_MANUAL_REVIEWS_KEPT) continue;
      prs += 1;
      runs += rows.length;
      const extra = rows.slice(AI_USAGE_MANUAL_REVIEWS_KEPT);
      excess.push(...extra);
      prExcess.set(prId, extra.length);
    }
    if (prs > 0) {
      suggestions.push({
        kind: 'many_reviews',
        fact: `${plural(prs, 'pull request')} had more than ${AI_USAGE_MANUAL_REVIEWS_KEPT} reviews started by hand (${runs} in all).`,
        action: `Saving if each had been reviewed at most ${AI_USAGE_MANUAL_REVIEWS_KEPT} times.`,
        saving: savingOf(excess, unit),
        setting: null,
        prs: refs(prExcess),
      });
    }
  }

  // ---- insights ----
  {
    const claudeRuns = reviews.filter((r) => !isCodex(r.provider) && r.inputTokens != null);
    const input_ = claudeRuns.reduce((n, r) => n + (r.inputTokens ?? 0), 0);
    const cached = claudeRuns.reduce((n, r) => n + (r.cacheReadTokens ?? 0), 0);
    if (input_ + cached > 0) {
      insights.push({ kind: 'cache', text: `Claude read ${pct(cached, input_ + cached)}% of its review input from its cache.` });
    }
  }
  {
    const code = groups.get('code');
    const spec = windowRows.filter((r) => isSpecialistFeature(r.feature)).reduce((n, r) => n + (tokensOf(r) ?? 0), 0);
    if (code != null && code.tokens > 0 && spec > 0) {
      insights.push({ kind: 'specialists', text: `Specialists used ${pct(spec, code.tokens)}% of code review tokens.` });
    }
  }
  if (full.length > 0) {
    const auto = full.filter((r) => r.trigger === 'auto').length;
    insights.push({ kind: 'auto_share', text: `${auto} of ${plural(full.length, 'code review')} ran automatically.` });
  }
  if (unmeasuredRuns > 0) {
    insights.push({ kind: 'unmeasured', text: `${plural(unmeasuredRuns, 'run')} recorded no token count and ${unmeasuredRuns === 1 ? 'is' : 'are'} counted as runs only.` });
  }

  suggestions.sort((a, b) => b.saving.tokens - a.saving.tokens);
  return {
    costUnit: unit,
    totals,
    machineWideRuns,
    unmeasuredRuns,
    days,
    groups: groupRows,
    topPrs,
    topStories,
    weeks,
    weeklySlope,
    suggestions,
    insights,
  };
}

function groupByPr(rows: readonly ReviewRowIn[]): Map<number, ReviewRowIn[]> {
  const m = new Map<number, ReviewRowIn[]>();
  for (const r of [...rows].sort((a, b) => a.createdAtMs - b.createdAtMs)) {
    const l = m.get(r.prId);
    if (l == null) m.set(r.prId, [r]);
    else l.push(r);
  }
  return m;
}

function savingOf(
  rows: readonly { provider: string | null; cost: number; inputTokens: number | null; outputTokens: number | null }[],
  unit: AiUsageCostUnit | null,
): Pick<AiUsageFigures, 'tokens' | 'claudeCost'> {
  const f = emptyAiUsageFigures(unit);
  for (const r of rows) add(f, r);
  return { tokens: f.tokens, claudeCost: f.claudeCost };
}

function topIds(counts: ReadonlyMap<number, number>): number[] {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .map(([id]) => id);
}

function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Least-squares slope (per step) over `ys`; null with fewer than 3 points. */
export function slopeOf(ys: readonly number[]): number | null {
  const n = ys.length;
  if (n < 3) return null;
  const mx = (n - 1) / 2;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  ys.forEach((y, x) => {
    num += (x - mx) * (y - my);
    den += (x - mx) * (x - mx);
  });
  return den === 0 ? null : num / den;
}

// ---- the reads ---------------------------------------------------------------------------------

async function chunked<T, R>(items: readonly T[], read: (chunk: T[]) => Promise<R[]>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(...(await read(items.slice(i, i + CHUNK))));
  return out;
}

/** The cost conversion the route hands in: the unit and the multiplier from a Claude row's US$. */
export interface AiUsageCostRate {
  unit: AiUsageCostUnit | null;
  /** 1 for US$; the budget's `weekPctPerUsd` for a share of a week. */
  perUsd: number;
}

export async function getAiUsageReport(
  accountId: number,
  scope: BotScope,
  window: ReportingWindow,
  nowMs: number,
  rate: AiUsageCostRate,
): Promise<AiUsageReportResponse> {
  const { aiUsage, pullRequests: pr, repos, claudeReviews: cr, ticketReviews: tr, trackerTickets: tt } = schema;
  const fromMs = window.fromMs;
  const toMs = Math.max(fromMs, measuredTo(window, nowMs));
  const sinceMs = Math.min(fromMs, weeksFromMs(nowMs));
  const inScope = new Set(scope.repoIds);
  const toCost = (provider: string | null, usd: number | null): number =>
    rate.unit == null || isCodex(provider) || usd == null || !Number.isFinite(usd) ? 0 : usd * rate.perUsd;

  // 1. The ledger since the earlier of the window and the 12 weeks.
  const raw = await db
    .select({
      feature: aiUsage.feature,
      provider: aiUsage.provider,
      model: aiUsage.model,
      costUsd: aiUsage.costUsd,
      inputTokens: aiUsage.inputTokens,
      outputTokens: aiUsage.outputTokens,
      prId: aiUsage.prId,
      repoId: aiUsage.repoId,
      occurredAt: aiUsage.occurredAt,
    })
    .from(aiUsage)
    .where(and(eq(aiUsage.accountId, accountId), gte(aiUsage.occurredAt, new Date(sinceMs))))
    .execute();

  // 2. Code-review runs in the window on this workspace's PRs.
  const reviewRaw =
    scope.repoIds.length === 0
      ? []
      : await db
          .select({
            prId: cr.prId,
            status: cr.status,
            trigger: cr.trigger,
            kind: cr.kind,
            provider: cr.provider,
            model: cr.model,
            costUsd: cr.costUsd,
            inputTokens: cr.inputTokens,
            outputTokens: cr.outputTokens,
            cacheReadTokens: cr.cacheReadTokens,
            diffBytes: cr.diffBytes,
            createdAt: cr.createdAt,
          })
          .from(cr)
          .innerJoin(pr, and(eq(pr.id, cr.prId), eq(pr.accountId, accountId)))
          .where(
            and(
              eq(cr.accountId, accountId),
              inArray(pr.repoId, scope.repoIds),
              gte(cr.createdAt, new Date(fromMs)),
              lt(cr.createdAt, new Date(toMs)),
            ),
          )
          .execute();
  const reviews: ReviewRowIn[] = reviewRaw.map((r) => ({
    prId: r.prId,
    status: r.status,
    trigger: r.trigger,
    kind: r.kind ?? null,
    provider: r.provider,
    model: r.model,
    cost: toCost(r.provider, r.costUsd),
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    cacheReadTokens: r.cacheReadTokens,
    diffBytes: r.diffBytes,
    createdAtMs: r.createdAt.getTime(),
  }));

  // 3. Every PR the ledger or a review names: its repository decides the workspace (a review's PR is
  //    in scope by its query; it is read here only for its name).
  const prIds = [...new Set([...raw.flatMap((r) => (r.prId == null ? [] : [r.prId])), ...reviews.map((r) => r.prId)])];
  const prRows = await chunked(prIds, (chunk) =>
    db
      .select({ id: pr.id, repoId: pr.repoId, number: pr.number, title: pr.title })
      .from(pr)
      .where(and(eq(pr.accountId, accountId), inArray(pr.id, chunk)))
      .execute(),
  );
  const prRepo = new Map(prRows.map((p) => [p.id, p.repoId]));
  const ledger: LedgerRowIn[] = [];
  for (const r of raw) {
    const repoId = r.prId != null ? (prRepo.get(r.prId) ?? r.repoId) : r.repoId;
    if (r.prId != null && repoId == null) continue; // a pruned PR with no repository: cannot be placed
    if (repoId != null && !inScope.has(repoId)) continue;
    ledger.push({
      feature: r.feature,
      provider: r.provider,
      model: r.model,
      cost: toCost(r.provider, r.costUsd),
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      prId: r.prId != null && prRepo.has(r.prId) ? r.prId : null,
      repoId,
      occurredAtMs: r.occurredAt.getTime(),
    });
  }

  // 4. PR names (in-scope only).
  const scopedPrs = prRows.filter((p) => inScope.has(p.repoId));
  const repoIds = [...new Set(scopedPrs.map((p) => p.repoId))];
  const repoRows = await chunked(repoIds, (chunk) =>
    db
      .select({ id: repos.id, owner: repos.owner, name: repos.name })
      .from(repos)
      .where(and(eq(repos.accountId, accountId), inArray(repos.id, chunk)))
      .execute(),
  );
  const repoName = new Map(repoRows.map((r) => [r.id, `${r.owner}/${r.name}`]));
  const prs = new Map<number, PrMetaIn>();
  for (const p of scopedPrs) {
    const name = repoName.get(p.repoId);
    if (name != null) prs.set(p.id, { id: p.id, number: p.number, title: p.title ?? '', repoFullName: name });
  }

  // 5. This workspace's ticket reviews in the window.
  const ticketRaw = await db
    .select({
      ident: tr.ticketIdent,
      key: tr.ticketKey,
      title: tr.ticketTitle,
      status: tr.status,
      trigger: tr.trigger,
      provider: tr.provider,
      costUsd: tr.costUsd,
      inputTokens: tr.inputTokens,
      outputTokens: tr.outputTokens,
      createdAt: tr.createdAt,
    })
    .from(tr)
    .where(
      and(
        eq(tr.accountId, accountId),
        eq(tr.workspaceId, scope.workspaceId),
        gte(tr.createdAt, new Date(fromMs)),
        lt(tr.createdAt, new Date(toMs)),
      ),
    )
    .execute();
  const ticketReviews: TicketReviewRowIn[] = ticketRaw.map((t) => ({
    ident: t.ident,
    key: t.key,
    title: t.title,
    status: t.status,
    trigger: t.trigger,
    provider: t.provider,
    cost: toCost(t.provider, t.costUsd),
    inputTokens: t.inputTokens,
    outputTokens: t.outputTokens,
    createdAtMs: t.createdAt.getTime(),
  }));

  // 6. Story links of the PRs that used AI in the window: the stored, readable ticket rows.
  const windowPrIds = [...new Set(ledger.flatMap((r) => (r.prId != null && r.occurredAtMs >= fromMs && r.occurredAtMs < toMs ? [r.prId] : [])))];
  const ticketRows = await chunked(windowPrIds, (chunk) =>
    db
      .select({ prId: tt.prId, provider: tt.provider, apiRoot: tt.apiRoot, issueKey: tt.issueKey, title: tt.title })
      .from(tt)
      .where(and(eq(tt.accountId, accountId), eq(tt.workspaceId, scope.workspaceId), eq(tt.state, 'ok'), inArray(tt.prId, chunk)))
      .execute(),
  );
  const storyLinks = new Map<number, StoryLinkIn[]>();
  for (const t of ticketRows) {
    const ident = trackerTicketIdent(t.provider as TrackerProvider, t.apiRoot, t.issueKey);
    const list = storyLinks.get(t.prId) ?? [];
    if (!list.some((l) => l.ident === ident)) list.push({ ident, key: t.issueKey, title: t.title });
    storyLinks.set(t.prId, list);
  }

  const body = foldAiUsageReport({
    nowMs,
    fromMs,
    toMs,
    costUnit: rate.unit,
    ledger,
    reviews,
    ticketReviews,
    prs,
    storyLinks,
  });
  return { workspaceId: scope.workspaceId, window: reportingWindowInfo(window, nowMs), ...body };
}
