// THE CLAUDE SPEND BUDGET — one optional, per-machine limit that stops Limn's AUTOMATIC model runs
// before they eat the reader's Claude allowance or API bill. OFF until the reader switches it on.
//
// ONE BUDGET PER ACCOUNT (= per machine): the Claude Code login or ANTHROPIC_API_KEY it guards is
// the machine's, not a workspace's. Stored on `accounts.ai_budget_settings`; decided by the backend's
// ONE fold (ai/budget.ts `decideAiBudget`) and enforced by its ONE gate before every automatic run.
// A run the reader starts is never refused — the SPA asks for a second press.
//
// The credential route picks the mode:
//   • Claude subscription (the Claude Code login) — LIMN'S SHARE of the weekly allowance
//     (`weekSharePct`, 1–50, default 5) and of the 5-hour session allowance (`fiveHourSharePct`,
//     1–50; null = SAME AS THE WEEKLY SHARE, the default). Limn adds up its OWN recorded spend
//     (ai_usage) in the current week / 5-hour window and divides it by the subscription's ESTIMATED
//     allowance for that window (SUBSCRIPTION_ESTIMATES). Each window is Claude's real one when its
//     reset time has been read and is still ahead, otherwise the rolling last 7 days / 5 hours.
//     Claude's own usage reading is used for the subscription type, the reset times and the header's
//     account figures — it never blocks. ⚠ The dollar arithmetic is INTERNAL: a subscription carries
//     percentages only, on the wire and on screen (one documented exception: `weekPctPerUsd`, the
//     RATE that turns a run's recorded cost into "x% of your week").
//   • API key — a US$ budget per rolling 7 days. No 5-hour limit.
//
// CODEX (docs/CODEX-PLAN.md § 6 + § 8.1, DECIDED 2026-10-25). The budget judges the ACTIVE provider.
// On a ChatGPT sign-in there are no dollars and no estimate table: Codex reports its OWN windows (a
// 5-hour and a weekly `usedPercent`, WHOLE numbers, with reset times), and Limn's share of a window is
// TOKEN-WEIGHTED —
//     Limn's tokens in the window ÷ the account's tokens in the window × the window's usedPercent
// (Limn's from ai_usage rows with provider 'codex'; the account's from `account/usage/read`). Same
// settings, same 5% default, percentages only. ⚠ The reading is in whole percent, so the share is
// COARSE: while the account's window reads 0% Limn's share reads 0%, and a 5% share can first trip
// when the window reaches 5% with Limn as all of it. Unknown account tokens take the whole
// `usedPercent` as Limn's (the cautious reading). An API key is the weekly US$ budget, as for Claude.
//
// The PURE decision (`decideAiBudget`) and the header's usage view (`aiUsageView`) live HERE so the
// backend and the static demo run the same rules; the backend (ai/budget.ts) gathers their inputs.

/** The Claude subscriptions the budget knows. Names appear only as option labels. */
export type AiSubscriptionKind = 'pro' | 'max5x' | 'max20x' | 'team';
export const AI_SUBSCRIPTION_KINDS: readonly AiSubscriptionKind[] = ['pro', 'max5x', 'max20x', 'team'];
export const AI_SUBSCRIPTION_LABELS: Record<AiSubscriptionKind, string> = {
  pro: 'Pro',
  max5x: 'Max 5x',
  max20x: 'Max 20x',
  team: 'Team',
};

/**
 * ESTIMATES, NOT PUBLISHED LIMITS. The approximate API-price US$ a subscription's week holds before
 * Anthropic's weekly limit bites. Anthropic publishes no such figure (its help page,
 * support.claude.com/en/articles/11145838, says only that a weekly limit exists), so every surface
 * that explains the share must say it is an estimate. The one table: nothing else may hold a copy.
 *
 * Source (as of 2026-10-24): third-party measurement priced at API list rates, cache reads and
 * writes included, for mostly-Sonnet Claude Code use, rounded to a best guess:
 *   • wokey.ai/claude-usage-limits — measured weekly across accounts, week to 2026-10-19
 *     (Pro ~$170/wk; Max 20x ~$1,643/wk; Team standard ~$185/wk);
 *   • SemiAnalysis (Oct 2026, via explainx.ai) and botfarm.run (Feb–Mar 2026) for the ranges and
 *     for Max 5x, which no one measures directly (~49% of Max 20x).
 * Weekly ranges: Pro 125–270, Max 5x 520–1300, Max 20x 1100–2900, Team 150–250. Limits move often;
 * re-check these when Anthropic changes them.
 */
export const SUBSCRIPTION_ESTIMATES: Record<AiSubscriptionKind, { week: number; fiveHour: number }> = {
  // `fiveHour`: the same sources' 5-hour session figures, rounded (Pro ~$15, Max 5x ~$75,
  // Max 20x ~$200, Team standard ~$20). Rougher still than the week — a session's ceiling moves
  // with demand.
  pro: { week: 170, fiveHour: 15 },
  max5x: { week: 800, fiveHour: 75 },
  max20x: { week: 1650, fiveHour: 200 },
  // Team standard seat. (Team Premium measured ~$861 a week.)
  team: { week: 185, fiveHour: 20 },
};

/** Limn's share of the week (and of a 5-hour session): a whole number from 1 to this. */
export const AI_BUDGET_SHARE_MAX = 50;

/** The defaults the Settings form fills in when the reader switches the budget on. */
export const AI_BUDGET_DEFAULTS = {
  weekSharePct: 5,
  weeklyUsd: 25,
} as const;

/**
 * "About N automatic reviews a working day": the typical cost of one automatic review cycle, used
 * when the account has no recorded runs of that kind in the last 28 days (US$ at API prices,
 * INTERNAL — never shown on a subscription).
 */
export const AI_CYCLE_COST_FALLBACKS = {
  /** One Claude review (`ai_usage.feature = 'claude_review'`). */
  review: 0.42,
  /** Its design diagrams (`'sequence_diagram'`), counted only while a workspace draws them automatically. */
  diagram: 0.22,
} as const;
/** Working days in a week, for "a working day". */
export const AI_WORKING_DAYS_PER_WEEK = 5;

/**
 * Whole automatic review cycles a working day that Limn's share pays for. 0 or more, never NaN or
 * Infinity: a non-finite or non-positive input reads as nothing to say (null).
 */
export function reviewsPerDayFor(sharePct: number, weekUsd: number, cycleUsd: number): number | null {
  if (![sharePct, weekUsd, cycleUsd].every((n) => Number.isFinite(n))) return null;
  if (sharePct <= 0 || weekUsd <= 0 || cycleUsd <= 0) return null;
  const n = Math.floor(((sharePct / 100) * weekUsd) / AI_WORKING_DAYS_PER_WEEK / cycleUsd);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** One cycle's cost: the mean review, plus the mean diagram run when diagrams are drawn automatically.
 *  A missing, zero or non-finite mean falls back to the typical figure. */
export function cycleCostUsd(input: {
  reviewMeanUsd: number | null;
  diagramMeanUsd: number | null;
  autoDiagrams: boolean;
}): number {
  const pick = (v: number | null, d: number): number => (v != null && Number.isFinite(v) && v > 0 ? v : d);
  const review = pick(input.reviewMeanUsd, AI_CYCLE_COST_FALLBACKS.review);
  return input.autoDiagrams ? review + pick(input.diagramMeanUsd, AI_CYCLE_COST_FALLBACKS.diagram) : review;
}

/** What `accounts.ai_budget_settings` holds (NULL = never set = off with the defaults). Older rows
 *  may still carry `fiveHourPct` / `weekPct` / `dailyUsd`; they are ignored on read. */
export interface AiBudgetSettings {
  enabled: boolean;
  /** Subscription: Limn's share of the weekly allowance, a whole number 1–50. */
  weekSharePct: number;
  /** Subscription: Limn's share of the 5-hour session allowance, a whole number 1–50, or null =
   *  the same as `weekSharePct` (the default; "5% a week → 5% a session"). */
  fiveHourSharePct: number | null;
  /** Subscription: the reader's pick, used where Claude's own report is ambiguous ('max', unknown). */
  subscription: AiSubscriptionKind | null;
  /** API key: the US$ budget per rolling 7 days. */
  weeklyUsd: number;
}

function isSharePct(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= AI_BUDGET_SHARE_MAX;
}

/** The 5-hour share in force: the reader's own, else the weekly share. */
export function effectiveFiveHourSharePct(settings: Pick<AiBudgetSettings, 'weekSharePct' | 'fiveHourSharePct'>): number {
  return settings.fiveHourSharePct ?? settings.weekSharePct;
}

/** Fill a stored (possibly partial, old or NULL) row with the defaults. Never throws. */
export function resolveAiBudgetSettings(raw: Partial<AiBudgetSettings> | null | undefined): AiBudgetSettings {
  const r = (raw ?? {}) as Partial<AiBudgetSettings>;
  const usd = r.weeklyUsd;
  return {
    enabled: r.enabled === true,
    weekSharePct: isSharePct(r.weekSharePct) ? r.weekSharePct : AI_BUDGET_DEFAULTS.weekSharePct,
    fiveHourSharePct: isSharePct(r.fiveHourSharePct) ? r.fiveHourSharePct : null,
    subscription:
      typeof r.subscription === 'string' && (AI_SUBSCRIPTION_KINDS as readonly string[]).includes(r.subscription)
        ? r.subscription
        : null,
    weeklyUsd: typeof usd === 'number' && Number.isFinite(usd) && usd > 0 ? usd : AI_BUDGET_DEFAULTS.weeklyUsd,
  };
}

/**
 * Validate a PUT body. Returns a message for the first problem, or null. Every field is optional;
 * an absent field keeps the stored value. `subscription` and `fiveHourSharePct` accept null (clear;
 * the 5-hour share then follows the weekly one). An unknown key —
 * including the retired `fiveHourPct` / `weekPct` / `dailyUsd` — is refused.
 */
export function validateAiBudgetBody(body: unknown): string | null {
  if (body == null || typeof body !== 'object' || Array.isArray(body)) return 'Send a JSON object.';
  const b = body as Record<string, unknown>;
  const known = new Set(['enabled', 'weekSharePct', 'fiveHourSharePct', 'subscription', 'weeklyUsd']);
  for (const k of Object.keys(b)) if (!known.has(k)) return `Unknown setting: ${k}.`;
  if (b.enabled !== undefined && typeof b.enabled !== 'boolean') return 'enabled must be true or false.';
  if (b.weekSharePct !== undefined && !isSharePct(b.weekSharePct)) {
    return `weekSharePct must be a whole number from 1 to ${AI_BUDGET_SHARE_MAX}.`;
  }
  // null clears it: the 5-hour share follows the weekly one again.
  if (b.fiveHourSharePct !== undefined && b.fiveHourSharePct !== null && !isSharePct(b.fiveHourSharePct)) {
    return `fiveHourSharePct must be a whole number from 1 to ${AI_BUDGET_SHARE_MAX}, or null.`;
  }
  if (
    b.subscription !== undefined &&
    b.subscription !== null &&
    !(typeof b.subscription === 'string' && (AI_SUBSCRIPTION_KINDS as readonly string[]).includes(b.subscription))
  ) {
    return `subscription must be one of ${AI_SUBSCRIPTION_KINDS.join(', ')}, or null.`;
  }
  if (b.weeklyUsd !== undefined) {
    const v = b.weeklyUsd;
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > 100_000) return 'weeklyUsd must be a positive US$ amount.';
  }
  return null;
}

/** Where the subscription the budget judges against came from. */
export type AiSubscriptionSource = 'reading' | 'picked';

/** The subscription, from Claude's report and the reader's pick. */
export interface ResolvedAiSubscription {
  /** The subscription to judge against, or null while not known (never blocks). */
  kind: AiSubscriptionKind | null;
  source: AiSubscriptionSource | null;
  /** The choices the picker offers, or null when Claude's report settles it ('pro', 'team'). */
  pickFrom: AiSubscriptionKind[] | null;
}

/**
 * THE ONE SUBSCRIPTION RULE. Claude's report of 'pro' or 'team' is used directly (a pick does not
 * override it). 'max' needs the reader to say Max 5x or Max 20x (the two differ about fourfold);
 * 'enterprise', anything else, or no report: the reader picks from them all. Pure.
 */
export function resolveAiSubscription(
  reported: string | null | undefined,
  picked: AiSubscriptionKind | null,
): ResolvedAiSubscription {
  const r = typeof reported === 'string' ? reported.trim().toLowerCase() : '';
  if (r === 'pro' || r === 'team') return { kind: r, source: 'reading', pickFrom: null };
  if (r === 'max') {
    const pair: AiSubscriptionKind[] = ['max5x', 'max20x'];
    return picked != null && pair.includes(picked)
      ? { kind: picked, source: 'picked', pickFrom: pair }
      : { kind: null, source: null, pickFrom: pair };
  }
  return picked != null
    ? { kind: picked, source: 'picked', pickFrom: [...AI_SUBSCRIPTION_KINDS] }
    : { kind: null, source: null, pickFrom: [...AI_SUBSCRIPTION_KINDS] };
}

/** Which way the budget is judged right now. */
export type AiBudgetMode = 'subscription' | 'api_key' | 'off';

/** The AI provider a budget judges. */
export type AiBudgetProvider = 'claude' | 'codex';

/**
 * Codex (ChatGPT sign-in): the ACCOUNT's tokens in each window — the denominator of the
 * token-weighted share. Null = not known (Limn's share is then taken as the whole window's figure).
 */
export interface AiAccountTokens {
  week: number | null;
  fiveHour: number | null;
}

/**
 * The subscription half of the status. ⚠ PERCENTAGES ONLY — no US$ field, ever (a test asserts it).
 */
export interface AiBudgetSubscriptionStatus {
  /** The subscription judged against, or null until known (then nothing blocks). */
  subscription: AiSubscriptionKind | null;
  subscriptionSource: AiSubscriptionSource | null;
  /** What Claude reported ('pro', 'max', 'team', 'enterprise', …), or null. Display only. */
  reportedSubscription: string | null;
  /** The picker's choices, or null when Claude's report settles it. */
  pickFrom: AiSubscriptionKind[] | null;
  /** The setting: Limn's share of the week, 1–50. */
  sharePct: number;
  /** How much of the week Limn's own runs have used, in % of the allowance. Null while the
   *  subscription is unknown. */
  usedSharePct: number | null;
  /** "About N automatic reviews a working day". Null while the subscription is unknown. */
  reviewsPerDay: number | null;
  /** 'reset' = Claude's real week (its reset time was read); 'rolling' = the last 7 days. */
  window: 'reset' | 'rolling';
  /** The week's reset, when read. ISO-8601. */
  weekResetsAt: string | null;
  /** The 5-hour share in force, 1–50 (the reader's own, else `sharePct`). */
  fiveHourSharePct: number;
  /** True while the 5-hour share follows the weekly one (no separate setting). */
  fiveHourFollowsWeek: boolean;
  /** How much of the current 5-hour session Limn's own runs have used, in % of the session's
   *  allowance. Null while the subscription is unknown. */
  fiveHourUsedSharePct: number | null;
  /** 'reset' = Claude's real 5-hour window (its reset was read and is ahead); 'rolling' = the last
   *  5 hours. */
  fiveHourWindow: 'reset' | 'rolling';
  /** The 5-hour window's reset, when read. ISO-8601. */
  fiveHourResetsAt: string | null;
}

/** The API-key half of the status: US$ over a rolling 7 days. */
export interface AiBudgetApiKeyStatus {
  weeklyUsd: number;
  usedUsd: number;
}

/** The ONE decision, as the API returns it. */
export interface AiBudgetStatus {
  enabled: boolean;
  /** The provider the budget judged (the active one). Absent from an older server ⇒ Claude. */
  provider?: AiBudgetProvider;
  mode: AiBudgetMode;
  /** Which credential the next run uses (ai/credentials.ts). */
  route: 'login' | 'api_key' | 'none';
  /** Set in 'subscription' mode only. */
  subscription: AiBudgetSubscriptionStatus | null;
  /** Set in 'api_key' mode only. */
  apiKey: AiBudgetApiKeyStatus | null;
  /** True ⇒ automatic runs are paused; a run the reader starts asks for a second press. */
  overBudget: boolean;
  /** Which limit paused them: 'week' (the weekly share, or the API key's weekly US$) or
   *  'five_hour' (the 5-hour share). The week wins when both are over. Null when not over. */
  limitedBy: 'week' | 'five_hour' | null;
  /** One plain sentence, or null when nothing needs saying. */
  reason: string | null;
  /** When automatic runs resume (a window's reset, or when enough spend rolls out of the rolling
   *  window; the LATER of the two when both are over). ISO-8601; null when not over or not known. */
  resumesAt: string | null;
}

/**
 * The settings as the API returns them. `weeklyUsd` is the API key's alone: null unless the next run
 * uses an API key, so a subscription never carries a US$ figure on the wire.
 */
export interface AiBudgetSettingsView extends Omit<AiBudgetSettings, 'weeklyUsd'> {
  weeklyUsd: number | null;
}

/** The settings for the wire, by credential route (see AiBudgetSettingsView). Pure. */
export function aiBudgetSettingsView(
  settings: AiBudgetSettings,
  route: 'login' | 'api_key' | 'none',
): AiBudgetSettingsView {
  return { ...settings, weeklyUsd: route === 'api_key' ? settings.weeklyUsd : null };
}

/** GET /api/ai/budget and PUT /api/ai/budget's answer. */
export interface AiBudgetResponse {
  /** ⚠ `weeklyUsd` is null unless the route is the API key. */
  settings: AiBudgetSettingsView;
  /** True when nothing is stored yet (the form shows the defaults as suggestions). */
  isDefault: boolean;
  status: AiBudgetStatus;
  /** What the header's usage item and its popover show — filled whether or not the budget is on. */
  usage: AiUsageView;
}

/** PUT /api/ai/budget body: any subset of the settings. */
export type AiBudgetBody = Partial<AiBudgetSettings>;

/** One window of Claude's own usage reading. */
export interface AiUsageWindowReading {
  /** Claude's own figure for the WHOLE account, 0–100 (each source converts to this scale
   *  explicitly). Shown in the header; never used to decide. */
  utilization: number | null;
  resetsAtMs: number | null;
  observedAtMs: number;
}

/** The latest subscription usage reading (`accounts.ai_budget_reading`). Server-side state: the
 *  subscription type and the reset times feed the decision; the figures only feed the header. It
 *  never blocks. */
export interface AiUsageReading {
  /** Claude's `seven_day` window. */
  week?: AiUsageWindowReading | null;
  /** Claude's `five_hour` window. */
  fiveHour?: AiUsageWindowReading | null;
  /** Claude's per-model weekly windows (`seven_day_opus`, `seven_day_sonnet`, …), by Claude's key. */
  models?: Record<string, AiUsageWindowReading> | null;
  /** The subscription the SDK's usage probe reported ('pro', 'max', …), when it did. */
  subscriptionType?: string | null;
}

// ---- the usage view (the header item and its popover) ------------------------------------------

/** One window of Claude's account-wide usage, for the wire. */
export interface AiUsageWindowView {
  /** Claude's key: 'five_hour', 'seven_day', 'seven_day_opus', … */
  key: string;
  /** Plain label for a per-model window ('Opus', 'Sonnet'); null for the 5-hour and weekly ones. */
  label: string | null;
  /** Claude's own figure for the whole account, 0–100; null when not read. Remaining = 100 − it. */
  usedPct: number | null;
  /** ISO-8601, when read. */
  resetsAt: string | null;
  /** ISO-8601: when this window was read. */
  observedAt: string;
}

/** Claude's own account-wide reading (login route only). Windows whose reset has passed are dropped
 *  (the figure no longer applies); unknown is absent, never 0. */
export interface AiUsageAccountView {
  /** What Claude reported ('pro', 'max', …), or null. */
  reportedSubscription: string | null;
  /** The subscription after the reader's pick (resolveAiSubscription), or null while unknown. */
  subscription: AiSubscriptionKind | null;
  fiveHour: AiUsageWindowView | null;
  week: AiUsageWindowView | null;
  /** Per-model weekly windows, Opus first, then by key. */
  models: AiUsageWindowView[];
  /** ISO-8601: the newest window's reading, or null when nothing was read. */
  observedAt: string | null;
}

/** Limn's own recorded runs (ai_usage) in the week the budget counts. */
export interface AiUsageLimnView {
  /** ISO-8601 start of that week ([reset − 7 days] when Claude's reset was read, else 7 days ago). */
  weekFrom: string;
  window: 'reset' | 'rolling';
  /** Recorded model runs (ai_usage rows) this week. */
  runs: number;
  /** Summed token counts; null when no run this week reported them. */
  inputTokens: number | null;
  outputTokens: number | null;
  /** Login route with a known subscription: Limn's share of the week / of the 5-hour session, in
   *  % of the ESTIMATED allowance — whether or not the budget is on. Null otherwise. */
  weekSharePct: number | null;
  fiveHourSharePct: number | null;
}

/** API key only: Limn's recorded spend in US$. */
export interface AiUsageApiKeyView {
  weekUsd: number;
  fiveHourUsd: number;
  /** Since midnight on this machine. */
  todayUsd: number;
}

/** GET /api/ai/budget's `usage`. */
export interface AiUsageView {
  /** The provider these figures are for (the active one). Absent from an older server ⇒ Claude. */
  provider?: AiBudgetProvider;
  route: 'login' | 'api_key' | 'none';
  /** Login route only. */
  account: AiUsageAccountView | null;
  limn: AiUsageLimnView;
  /** API key route only. ⚠ Null on a subscription — no US$ amount on that wire. */
  apiKey: AiUsageApiKeyView | null;
  /**
   * Login route with a known subscription: the RATE that turns a run's recorded cost into a share of
   * the week — `% of the week = costUsd × weekPctPerUsd` (`runWeekShareText` does it). Not an amount;
   * the one US$-named field a subscription carries. Null otherwise (an API key shows US$; an unknown
   * subscription shows nothing).
   */
  weekPctPerUsd: number | null;
}

/**
 * A run's cost as a share of the week, for a subscription: "0.3% of your week", "<0.1% of your week".
 * Null when there is nothing honest to say (no rate, no cost). Pure.
 */
export function runWeekShareText(costUsd: number | null | undefined, weekPctPerUsd: number | null | undefined): string | null {
  if (costUsd == null || weekPctPerUsd == null || !Number.isFinite(costUsd) || !Number.isFinite(weekPctPerUsd)) return null;
  if (costUsd < 0 || weekPctPerUsd <= 0) return null;
  return `${formatSharePct(costUsd * weekPctPerUsd)} of your week`;
}

/** A share in %, rounded for reading: "0%", "<0.1%", "0.3%", "4.2%", "12%". Pure. */
export function formatSharePct(pct: number): string {
  if (!Number.isFinite(pct) || pct <= 0) return '0%';
  if (pct < 0.1) return '<0.1%';
  if (pct < 10) return `${(Math.round(pct * 10) / 10).toString()}%`;
  return `${Math.round(pct)}%`;
}

// ---- the pure decision (shared by the backend and the static demo) ------------------------------

export const AI_BUDGET_HOUR_MS = 60 * 60 * 1000;
export const AI_BUDGET_DAY_MS = 24 * AI_BUDGET_HOUR_MS;
export const AI_BUDGET_WEEK_MS = 7 * AI_BUDGET_DAY_MS;
export const AI_BUDGET_FIVE_HOUR_MS = 5 * AI_BUDGET_HOUR_MS;

/** One recorded run (ai_usage): when, its US$ at API prices (internal on a subscription), tokens. */
export interface AiLedgerRow {
  atMs: number;
  usd: number;
  inputTokens?: number | null;
  outputTokens?: number | null;
}

/** The account's typical automatic-review cycle (means over the last 28 days, null = no rows). */
export interface AiCycleCostInput {
  reviewMeanUsd: number | null;
  diagramMeanUsd: number | null;
  /** True when ANY of the account's workspaces draws diagrams automatically. */
  autoDiagrams: boolean;
}

export interface AiBudgetInput {
  settings: AiBudgetSettings;
  route: 'login' | 'api_key' | 'none';
  reading: AiUsageReading | null;
  /** Limn's recorded spend (ai_usage) over at least the last 7 days. */
  ledger: readonly AiLedgerRow[];
  costs: AiCycleCostInput;
  nowMs: number;
  /** The provider judged. Absent ⇒ Claude. */
  provider?: AiBudgetProvider;
  /** Codex on a ChatGPT sign-in: the account's tokens per window (see AiAccountTokens). */
  accountTokens?: AiAccountTokens | null;
}

/**
 * Spend in a rolling window and, when it is at or over `lineUsd`, when enough of it rolls out for the
 * window to drop back under. Pure.
 */
export function rollingSpend(
  ledger: readonly AiLedgerRow[],
  nowMs: number,
  windowMs: number,
  lineUsd: number,
): { usedUsd: number; resumesAtMs: number | null } {
  const rows = ledger.filter((r) => r.atMs > nowMs - windowMs && r.atMs <= nowMs).sort((a, b) => a.atMs - b.atMs);
  const usedUsd = rows.reduce((s, r) => s + r.usd, 0);
  if (usedUsd < lineUsd) return { usedUsd, resumesAtMs: null };
  let left = usedUsd;
  for (const r of rows) {
    left -= r.usd;
    if (left < lineUsd) return { usedUsd, resumesAtMs: r.atMs + windowMs };
  }
  return { usedUsd, resumesAtMs: nowMs + windowMs };
}

const isoOf = (ms: number | null | undefined): string | null => (ms == null ? null : new Date(ms).toISOString());
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** A window's reset, when the reading has one still ahead (and no more than one window ahead). */
function liveReset(w: AiUsageWindowReading | null | undefined, nowMs: number, windowMs: number): number | null {
  const t = w?.resetsAtMs;
  if (t == null || !Number.isFinite(t)) return null;
  return t > nowMs && t - windowMs <= nowMs ? t : null;
}

/** The week's reset, when the reading has one still ahead (and no more than a week ahead). */
export function liveWeekReset(reading: AiUsageReading | null, nowMs: number): number | null {
  return liveReset(reading?.week, nowMs, AI_BUDGET_WEEK_MS);
}

/** The 5-hour window's reset, when the reading has one still ahead (and no more than 5 hours ahead). */
export function liveFiveHourReset(reading: AiUsageReading | null, nowMs: number): number | null {
  return liveReset(reading?.fiveHour, nowMs, AI_BUDGET_FIVE_HOUR_MS);
}

/** Spend in one window — [reset − length, now] when the reset is known, else rolling — against a line. */
function windowSpend(
  ledger: readonly AiLedgerRow[],
  nowMs: number,
  windowMs: number,
  resetMs: number | null,
  lineUsd: number,
): { usedUsd: number; over: boolean; resumesAtMs: number | null } {
  if (resetMs != null) {
    const from = resetMs - windowMs;
    const usedUsd = ledger.filter((r) => r.atMs >= from && r.atMs <= nowMs).reduce((s, r) => s + r.usd, 0);
    const over = usedUsd >= lineUsd;
    return { usedUsd, over, resumesAtMs: over ? resetMs : null };
  }
  const r = rollingSpend(ledger, nowMs, windowMs, lineUsd);
  return { usedUsd: r.usedUsd, over: r.usedUsd >= lineUsd, resumesAtMs: r.resumesAtMs };
}

// ---- Codex: the token-weighted share ------------------------------------------------------------

/**
 * Limn's share of ONE Codex window, in % of the account's allowance for it (docs/CODEX-PLAN.md § 6):
 * `limnTokens ÷ accountTokens × usedPercent`. Pure.
 *   • `usedPercent` null (no reading) ⇒ null: unknown, which never blocks.
 *   • Limn used nothing ⇒ 0, whatever the account did.
 *   • the account's tokens unknown or zero while Limn used some ⇒ the whole `usedPercent` (cautious:
 *     every token in the window is taken as Limn's).
 *   • the ratio is capped at 1 — Limn cannot have used more than the account (a lagging account
 *     count must not inflate the share past the window's own figure).
 */
export function codexWindowSharePct(limnTokens: number, accountTokens: number | null, usedPercent: number | null): number | null {
  if (usedPercent == null || !Number.isFinite(usedPercent)) return null;
  const used = Math.min(100, Math.max(0, usedPercent));
  if (!Number.isFinite(limnTokens) || limnTokens <= 0) return 0;
  if (accountTokens == null || !Number.isFinite(accountTokens) || accountTokens <= 0) return used;
  return Math.min(1, limnTokens / accountTokens) * used;
}

/** Which budget window: Codex's `primary` (300 min) is the 5-hour one, `secondary` the week. */
export type AiBudgetWindow = 'week' | 'five_hour';

/**
 * Where a window starts, as the budget counts it: [reset − length] when the reading's reset is known
 * and ahead, else the rolling [now − length]. `inclusive` says whether a row AT the start counts (the
 * reset-anchored window includes its start; the rolling one does not). Pure — the backend asks the
 * account's tokens for exactly this span.
 */
export function budgetWindowStart(
  reading: AiUsageReading | null,
  nowMs: number,
  which: AiBudgetWindow,
): { fromMs: number; inclusive: boolean } {
  const len = which === 'week' ? AI_BUDGET_WEEK_MS : AI_BUDGET_FIVE_HOUR_MS;
  const reset = which === 'week' ? liveWeekReset(reading, nowMs) : liveFiveHourReset(reading, nowMs);
  return reset != null ? { fromMs: reset - len, inclusive: true } : { fromMs: nowMs - len, inclusive: false };
}

/** Limn's recorded tokens (input + output) in a window; a run that reported none counts 0. Pure. */
export function ledgerTokensIn(ledger: readonly AiLedgerRow[], fromMs: number, inclusive: boolean, nowMs: number): number {
  let n = 0;
  for (const r of ledger) {
    if (!(inclusive ? r.atMs >= fromMs : r.atMs > fromMs) || r.atMs > nowMs) continue;
    const i = typeof r.inputTokens === 'number' && Number.isFinite(r.inputTokens) ? r.inputTokens : 0;
    const o = typeof r.outputTokens === 'number' && Number.isFinite(r.outputTokens) ? r.outputTokens : 0;
    n += i + o;
  }
  return n;
}

/** A window's `usedPercent`, while its reset is still ahead (a passed reset's figure no longer applies). */
function liveUsedPercent(w: AiUsageWindowReading | null | undefined, reset: number | null): number | null {
  if (w == null || w.utilization == null) return null;
  if (w.resetsAtMs != null && reset == null) return null;
  return w.utilization;
}

/** Limn's token-weighted share of each Codex window. Pure. */
export function codexShares(input: {
  reading: AiUsageReading | null;
  ledger: readonly AiLedgerRow[];
  accountTokens: AiAccountTokens | null | undefined;
  nowMs: number;
}): { week: number | null; fiveHour: number | null } {
  const { reading, ledger, nowMs } = input;
  const one = (which: AiBudgetWindow): number | null => {
    const { fromMs, inclusive } = budgetWindowStart(reading, nowMs, which);
    const reset = which === 'week' ? liveWeekReset(reading, nowMs) : liveFiveHourReset(reading, nowMs);
    const used = liveUsedPercent(which === 'week' ? reading?.week : reading?.fiveHour, reset);
    const account = (which === 'week' ? input.accountTokens?.week : input.accountTokens?.fiveHour) ?? null;
    const share = codexWindowSharePct(ledgerTokensIn(ledger, fromMs, inclusive, nowMs), account, used);
    return share == null ? null : round2(share);
  };
  return { week: one('week'), fiveHour: one('five_hour') };
}

function codexSubscriptionStatus(input: AiBudgetInput): {
  sub: AiBudgetSubscriptionStatus;
  overWeek: boolean;
  overFiveHour: boolean;
  weekResumesAtMs: number | null;
  fiveHourResumesAtMs: number | null;
} {
  const { settings, reading, nowMs } = input;
  const weekReset = liveWeekReset(reading, nowMs);
  const fiveReset = liveFiveHourReset(reading, nowMs);
  const fiveShare = effectiveFiveHourSharePct(settings);
  const shares = codexShares({ reading, ledger: input.ledger, accountTokens: input.accountTokens, nowMs });
  const overWeek = shares.week != null && shares.week >= settings.weekSharePct;
  const overFiveHour = shares.fiveHour != null && shares.fiveHour >= fiveShare;
  return {
    sub: {
      // No Claude subscription kind and no picker: Codex reports its plan and its own windows.
      subscription: null,
      subscriptionSource: null,
      reportedSubscription: reading?.subscriptionType ?? null,
      pickFrom: null,
      sharePct: settings.weekSharePct,
      usedSharePct: shares.week,
      // No dollar cycle cost on a ChatGPT plan to estimate "reviews a day" from.
      reviewsPerDay: null,
      window: weekReset != null ? 'reset' : 'rolling',
      weekResetsAt: isoOf(weekReset),
      fiveHourSharePct: fiveShare,
      fiveHourFollowsWeek: settings.fiveHourSharePct == null,
      fiveHourUsedSharePct: shares.fiveHour,
      fiveHourWindow: fiveReset != null ? 'reset' : 'rolling',
      fiveHourResetsAt: isoOf(fiveReset),
    },
    overWeek,
    overFiveHour,
    // The window's own figure falls back at its reset; with no reset read, a share is never over.
    weekResumesAtMs: overWeek ? weekReset : null,
    fiveHourResumesAtMs: overFiveHour ? fiveReset : null,
  };
}

function subscriptionStatus(input: AiBudgetInput): {
  sub: AiBudgetSubscriptionStatus;
  overWeek: boolean;
  overFiveHour: boolean;
  weekResumesAtMs: number | null;
  fiveHourResumesAtMs: number | null;
} {
  if (input.provider === 'codex') return codexSubscriptionStatus(input);
  const { settings, reading, ledger, nowMs } = input;
  const reported = reading?.subscriptionType ?? null;
  const resolved = resolveAiSubscription(reported, settings.subscription);
  const weekReset = liveWeekReset(reading, nowMs);
  const fiveReset = liveFiveHourReset(reading, nowMs);
  const fiveShare = effectiveFiveHourSharePct(settings);
  const base: AiBudgetSubscriptionStatus = {
    subscription: resolved.kind,
    subscriptionSource: resolved.source,
    reportedSubscription: reported,
    pickFrom: resolved.pickFrom,
    sharePct: settings.weekSharePct,
    usedSharePct: null,
    reviewsPerDay: null,
    window: weekReset != null ? 'reset' : 'rolling',
    weekResetsAt: isoOf(weekReset),
    fiveHourSharePct: fiveShare,
    fiveHourFollowsWeek: settings.fiveHourSharePct == null,
    fiveHourUsedSharePct: null,
    fiveHourWindow: fiveReset != null ? 'reset' : 'rolling',
    fiveHourResetsAt: isoOf(fiveReset),
  };
  // Not known yet: nothing to judge with, never blocks.
  if (resolved.kind == null) {
    return { sub: base, overWeek: false, overFiveHour: false, weekResumesAtMs: null, fiveHourResumesAtMs: null };
  }
  const est = SUBSCRIPTION_ESTIMATES[resolved.kind];
  const week = windowSpend(ledger, nowMs, AI_BUDGET_WEEK_MS, weekReset, (est.week * settings.weekSharePct) / 100);
  const five = windowSpend(ledger, nowMs, AI_BUDGET_FIVE_HOUR_MS, fiveReset, (est.fiveHour * fiveShare) / 100);
  return {
    sub: {
      ...base,
      usedSharePct: round2((week.usedUsd / est.week) * 100),
      reviewsPerDay: reviewsPerDayFor(settings.weekSharePct, est.week, cycleCostUsd(input.costs)),
      fiveHourUsedSharePct: round2((five.usedUsd / est.fiveHour) * 100),
    },
    overWeek: week.over,
    overFiveHour: five.over,
    weekResumesAtMs: week.resumesAtMs,
    fiveHourResumesAtMs: five.resumesAtMs,
  };
}

/** THE ONE DECISION. Pure. Switched off (or no credential) never blocks. */
export function decideAiBudget(input: AiBudgetInput): AiBudgetStatus {
  const { settings, route } = input;
  const off: AiBudgetStatus = {
    enabled: settings.enabled,
    ...(input.provider ? { provider: input.provider } : {}),
    mode: 'off',
    route,
    subscription: null,
    apiKey: null,
    overBudget: false,
    limitedBy: null,
    reason: null,
    resumesAt: null,
  };
  if (!settings.enabled || route === 'none') return off;
  if (route === 'api_key') {
    const { usedUsd, resumesAtMs } = rollingSpend(input.ledger, input.nowMs, AI_BUDGET_WEEK_MS, settings.weeklyUsd);
    const over = usedUsd >= settings.weeklyUsd;
    return {
      ...off,
      mode: 'api_key',
      apiKey: { weeklyUsd: settings.weeklyUsd, usedUsd: round2(usedUsd) },
      overBudget: over,
      limitedBy: over ? 'week' : null,
      reason: over ? 'Limn has used its weekly budget.' : null,
      resumesAt: over ? isoOf(resumesAtMs) : null,
    };
  }
  const { sub, overWeek, overFiveHour, weekResumesAtMs, fiveHourResumesAtMs } = subscriptionStatus(input);
  const over = overWeek || overFiveHour;
  let reason: string | null = null;
  if (overWeek) reason = 'Limn has used its share of your week.';
  else if (overFiveHour) reason = 'Limn has used its share of this 5-hour session.';
  else if (input.provider === 'codex') {
    if (sub.usedSharePct == null && sub.fiveHourUsedSharePct == null) reason = 'Limn has not read your Codex usage yet.';
  } else if (sub.subscription == null) {
    reason =
      sub.reportedSubscription?.trim().toLowerCase() === 'max'
        ? 'Pick Max 5x or Max 20x so Limn can work out its share.'
        : 'Pick your Claude subscription so Limn can work out its share.';
  }
  // Runs resume once EVERY window that is over has cleared: the later of the two.
  const resumes = [overWeek ? weekResumesAtMs : null, overFiveHour ? fiveHourResumesAtMs : null].filter(
    (t): t is number => t != null,
  );
  return {
    ...off,
    mode: 'subscription',
    subscription: sub,
    overBudget: over,
    limitedBy: overWeek ? 'week' : overFiveHour ? 'five_hour' : null,
    reason,
    resumesAt: over && resumes.length > 0 ? isoOf(Math.max(...resumes)) : null,
  };
}

/** Plain label for a per-model weekly window key ('seven_day_opus' → 'Opus'). */
export function aiUsageModelLabel(key: string): string {
  const rest = key.replace(/^seven_day_/, '').replace(/_/g, ' ').trim();
  return rest === '' ? key : rest.charAt(0).toUpperCase() + rest.slice(1);
}

function windowView(key: string, label: string | null, w: AiUsageWindowReading | null | undefined, nowMs: number): AiUsageWindowView | null {
  if (w == null) return null;
  // A window whose reset has passed has rolled over: its figure no longer applies.
  if (w.resetsAtMs != null && w.resetsAtMs <= nowMs) return null;
  if (w.utilization == null && w.resetsAtMs == null) return null;
  return {
    key,
    label,
    usedPct: w.utilization == null ? null : Math.round(w.utilization * 10) / 10,
    resetsAt: isoOf(w.resetsAtMs),
    observedAt: new Date(w.observedAtMs).toISOString(),
  };
}

export interface AiUsageViewInput {
  settings: AiBudgetSettings;
  route: 'login' | 'api_key' | 'none';
  reading: AiUsageReading | null;
  /** Limn's recorded runs over at least the last 7 days. */
  ledger: readonly AiLedgerRow[];
  nowMs: number;
  /** Start of "today" on this machine (local midnight), epoch ms. */
  todayFromMs: number;
  /** The provider these figures are for. Absent ⇒ Claude. */
  provider?: AiBudgetProvider;
  /** Codex on a ChatGPT sign-in: the account's tokens per window. */
  accountTokens?: AiAccountTokens | null;
}

/** The header's usage view. Pure. ⚠ No US$ amount on the login route (only the documented rate). */
export function aiUsageView(input: AiUsageViewInput): AiUsageView {
  const { settings, route, reading, ledger, nowMs } = input;
  const login = route === 'login';
  const weekReset = login ? liveWeekReset(reading, nowMs) : null;
  const weekFromMs = weekReset != null ? weekReset - AI_BUDGET_WEEK_MS : nowMs - AI_BUDGET_WEEK_MS;
  const inWeek = ledger.filter((r) => (weekReset != null ? r.atMs >= weekFromMs : r.atMs > weekFromMs) && r.atMs <= nowMs);
  const sumTokens = (pick: (r: AiLedgerRow) => number | null | undefined): number | null => {
    const xs = inWeek.map(pick).filter((n): n is number => typeof n === 'number' && Number.isFinite(n));
    return xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0);
  };
  const spend = (fromMs: number, inclusive: boolean): number =>
    ledger.filter((r) => (inclusive ? r.atMs >= fromMs : r.atMs > fromMs) && r.atMs <= nowMs).reduce((s, r) => s + r.usd, 0);

  let account: AiUsageAccountView | null = null;
  let weekSharePct: number | null = null;
  let fiveHourSharePct: number | null = null;
  let weekPctPerUsd: number | null = null;
  if (login && input.provider === 'codex') {
    // Codex: its own two windows, its plan as reported, and Limn's TOKEN-WEIGHTED shares. No Claude
    // subscription kind, no per-model windows, no US$ rate (a ChatGPT run has no price).
    const fiveHour = windowView('five_hour', null, reading?.fiveHour, nowMs);
    const week = windowView('seven_day', null, reading?.week, nowMs);
    const seen = [fiveHour, week].filter((w): w is AiUsageWindowView => w != null).map((w) => w.observedAt);
    account = {
      reportedSubscription: reading?.subscriptionType ?? null,
      subscription: null,
      fiveHour,
      week,
      models: [],
      observedAt: seen.length === 0 ? null : seen.sort().at(-1)!,
    };
    const shares = codexShares({ reading, ledger, accountTokens: input.accountTokens, nowMs });
    weekSharePct = shares.week;
    fiveHourSharePct = shares.fiveHour;
  } else if (login) {
    const kind = resolveAiSubscription(reading?.subscriptionType ?? null, settings.subscription).kind;
    const models = Object.entries(reading?.models ?? {})
      .map(([k, w]) => windowView(k, aiUsageModelLabel(k), w, nowMs))
      .filter((w): w is AiUsageWindowView => w != null)
      .sort((a, b) => (a.key === 'seven_day_opus' ? -1 : b.key === 'seven_day_opus' ? 1 : a.key.localeCompare(b.key)));
    const fiveHour = windowView('five_hour', null, reading?.fiveHour, nowMs);
    const week = windowView('seven_day', null, reading?.week, nowMs);
    const seen = [fiveHour, week, ...models].filter((w): w is AiUsageWindowView => w != null).map((w) => w.observedAt);
    account = {
      reportedSubscription: reading?.subscriptionType ?? null,
      subscription: kind,
      fiveHour,
      week,
      models,
      observedAt: seen.length === 0 ? null : seen.sort().at(-1)!,
    };
    if (kind != null) {
      const est = SUBSCRIPTION_ESTIMATES[kind];
      const fiveReset = liveFiveHourReset(reading, nowMs);
      const fiveUsd = fiveReset != null ? spend(fiveReset - AI_BUDGET_FIVE_HOUR_MS, true) : spend(nowMs - AI_BUDGET_FIVE_HOUR_MS, false);
      weekSharePct = round2((inWeek.reduce((s, r) => s + r.usd, 0) / est.week) * 100);
      fiveHourSharePct = round2((fiveUsd / est.fiveHour) * 100);
      weekPctPerUsd = 100 / est.week;
    }
  }
  return {
    ...(input.provider ? { provider: input.provider } : {}),
    route,
    account,
    limn: {
      weekFrom: new Date(weekFromMs).toISOString(),
      window: weekReset != null ? 'reset' : 'rolling',
      runs: inWeek.length,
      inputTokens: sumTokens((r) => r.inputTokens),
      outputTokens: sumTokens((r) => r.outputTokens),
      weekSharePct,
      fiveHourSharePct,
    },
    apiKey:
      route === 'api_key'
        ? {
            weekUsd: round2(spend(nowMs - AI_BUDGET_WEEK_MS, false)),
            fiveHourUsd: round2(spend(nowMs - AI_BUDGET_FIVE_HOUR_MS, false)),
            todayUsd: round2(spend(input.todayFromMs, true)),
          }
        : null,
    weekPctPerUsd,
  };
}
