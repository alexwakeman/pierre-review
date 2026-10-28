import {
  AI_SUBSCRIPTION_LABELS,
  aiProviderName,
  formatSharePct as formatFineSharePct,
  limnShareScale,
  runWeekShareText,
  type AiBudgetResponse,
  type AiProviderId,
  type AiBudgetStatus,
  type AiUsageView,
  type AiUsageWindowView,
  type MeResponse,
} from '@pierre-review/shared';
import { formatUsd as formatRunUsd } from './ui.js';

// The pure half of the AI spend budget's UI (the meter's words, the toast's sentence), so tests
// can import it without React Query. The DECISION is the server's (`ai/budget.ts` `decideAiBudget`);
// nothing here re-derives whether a run is over budget — it only words what the server said.
// ⚠ A subscription is worded in percentages only; US$ is the API key's alone.

/** Whole dollars from $10 up; cents below. API key only. */
export function formatUsd(n: number): string {
  if (!Number.isFinite(n)) return '$0';
  if (n >= 10) return `$${Math.round(n).toLocaleString('en-GB')}`;
  return `$${n.toFixed(2)}`;
}

/** A share of the week: whole percent; "under 1%" for a little above nothing. */
export function formatSharePct(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0%';
  if (n < 1) return 'under 1%';
  return `${Math.round(n)}%`;
}

/** "Limn has used 2% of your week", or null while the subscription is not known. */
export function usedSentence(status: AiBudgetStatus): string | null {
  const s = status.subscription;
  if (s == null || s.usedSharePct == null) return null;
  return `Limn has used ${formatSharePct(s.usedSharePct)} of your week`;
}

/** "about 25 automatic reviews a working day", or null when not known. */
export function reviewsPerDayText(n: number | null | undefined): string | null {
  if (n == null || !Number.isFinite(n) || n < 0) return null;
  if (n === 0) return 'under one automatic review a working day';
  return `about ${n} automatic review${n === 1 ? '' : 's'} a working day`;
}

/** The meter's line, or null when the budget is off (nothing to show).
 *  Subscription: "Limn: 2% of your week · limit 5%". API key: "This week $4.10 of $25". */
export function meterText(status: AiBudgetStatus): string | null {
  if (!status.enabled || status.mode === 'off') return null;
  if (status.overBudget) return 'Over budget';
  if (status.mode === 'api_key' && status.apiKey != null) {
    return `This week ${formatUsd(status.apiKey.usedUsd)} of ${formatUsd(status.apiKey.weeklyUsd)}`;
  }
  const s = status.subscription;
  if (s == null) return null;
  // Codex reports its plan and its own windows: nothing to pick, only a reading still to come.
  if (status.provider === 'codex') {
    if (s.usedSharePct == null) return 'Limn: usage not read yet';
  } else if (s.subscription == null || s.usedSharePct == null) return 'Limn: pick your subscription';
  if (s.usedSharePct == null) return null;
  return `Limn: ${formatSharePct(s.usedSharePct)} of your week · limit ${s.sharePct}%`;
}

/** "14:30" today, "Mon 14:30" within a week, "3 Nov 14:30" beyond. Empty for null or a bad date. */
export function formatResume(iso: string | null, now: number = Date.now()): string {
  if (iso == null) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const today = new Date(now);
  if (d.toDateString() === today.toDateString()) return time;
  if (t - now < 6 * 24 * 60 * 60 * 1000) return `${d.toLocaleDateString('en-GB', { weekday: 'short' })} ${time}`;
  return `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ${time}`;
}

/** The toast's sentence: "Limn has used its share of your week. Automatic runs resume Tue 09:00."
 *  Over the 5-hour share only (`limitedBy: 'five_hour'`): "…its share of this 5-hour session. …" */
export function pausedSentence(status: AiBudgetStatus, now: number = Date.now()): string {
  const used =
    status.mode === 'api_key'
      ? 'Limn has used its weekly budget.'
      : status.limitedBy === 'five_hour'
        ? 'Limn has used its share of this 5-hour session.'
        : 'Limn has used its share of your week.';
  const when = formatResume(status.resumesAt, now);
  return when === '' ? `${used} Automatic runs are paused.` : `${used} Automatic runs resume ${when}.`;
}

/**
 * The Run controls inside a gate: the buttons marked `data-ai-run`, or — when nothing is marked — the
 * gate's ONLY button. A gate holding other buttons (an ⓘ, Discard, Close…) must mark its Run
 * control(s), or nothing in it takes the second press.
 */
export function runButtonsIn(wrap: Pick<ParentNode, 'querySelectorAll'>): HTMLButtonElement[] {
  const marked = Array.from(wrap.querySelectorAll<HTMLButtonElement>('button[data-ai-run]'));
  if (marked.length > 0) return marked;
  const all = Array.from(wrap.querySelectorAll<HTMLButtonElement>('button'));
  return all.length === 1 ? all : [];
}

/** "This 5-hour session: Limn has used under 1% (limit 5%)", or null while not known. */
export function fiveHourUsedSentence(status: AiBudgetStatus): string | null {
  const s = status.subscription;
  if (s == null || s.fiveHourUsedSharePct == null) return null;
  return `This 5-hour session: Limn has used ${formatSharePct(s.fiveHourUsedSharePct)} (limit ${s.fiveHourSharePct}%)`;
}

// ---- a run's cost (B) ----------------------------------------------------------------------------

/**
 * THE ONE WORDING OF A RUN'S COST. API key: US$ ("US$0.42"). Claude subscription: the share of the
 * week it used ("0.3% of your week", "<0.1% of your week"), from the server's rate — never US$. Null
 * (show nothing) while the budget query has not answered, when the subscription is not known, or
 * when there is no credential to judge by, and for a run of the OTHER provider (`runProvider`).
 */
export function runCostText(
  costUsd: number | null | undefined,
  usage: AiUsageView | null | undefined,
  // Who RAN the run (its stored provider). The reading is the ACTIVE provider's: a run by the other
  // provider is not judged by it (nothing shown rather than a figure for the wrong account). Absent ⇒
  // judged by the reading, as before.
  runProvider?: AiProviderId | null,
): string | null {
  if (costUsd == null || !Number.isFinite(costUsd) || usage == null) return null;
  if (runProvider != null && runProvider !== (usage.provider ?? 'claude')) return null;
  // A Codex run on a ChatGPT sign-in has no price (US$ 0) and no per-run share Limn can state (the
  // windows read in whole percent): never US$, nothing at all.
  if (runProvider === 'codex' && usage.route === 'login') return null;
  if (usage.route === 'api_key') return formatRunUsd(costUsd);
  if (usage.route === 'login') return runWeekShareText(costUsd, usage.weekPctPerUsd);
  return null;
}

/**
 * THE OTHER PROVIDER (not the default): the one a manual run's model menu may pick beside the default.
 */
export function otherAiProvider(defaultProvider: AiProviderId): AiProviderId {
  return defaultProvider === 'codex' ? 'claude' : 'codex';
}

/**
 * Is the other provider's budget reading worth a request? Only when it holds a credential (its runs
 * are then priced by it); with none, `runCostText` would say nothing anyway.
 */
export function otherReadingWanted(me: MeResponse | undefined, other: AiProviderId): boolean {
  const ai = me?.ai;
  if (ai?.enabled !== true) return false;
  const route = other === 'codex' ? ai.providers?.codex?.route : ai.providers?.claude?.route;
  return route != null && route !== 'none';
}

/**
 * The reading a run's cost is judged by: the DEFAULT provider's, or — for a run of the other provider
 * (a manual run's per-run pick) — the other's own. Absent `runProvider` ⇒ the default's, as before.
 */
export function usageForRun(
  runProvider: AiProviderId | null | undefined,
  defaultProvider: AiProviderId,
  readings: { default: AiUsageView | null | undefined; other: AiUsageView | null | undefined },
): AiUsageView | null | undefined {
  return runProvider != null && runProvider !== defaultProvider ? readings.other : readings.default;
}

// ---- the header usage item (C) ------------------------------------------------------------------

export interface HeaderUsage {
  /** What the figure is, for screen readers only: "AI quota for Limn:". The item shows just the figure. */
  label: string;
  /** The one figure: "40%", "US$4.10"; null when nothing is known. */
  figure: string | null;
  /** 'near' at 80% of a limit, 'over' once the server says over budget. */
  tone: 'normal' | 'near' | 'over';
  /** One sentence saying what the figure is. */
  title: string;
}

/** A ratio in % for the header: whole percent, "<1%" for a little above nothing. */
function ratioPct(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0%';
  if (n < 1) return '<1%';
  return `${Math.round(n)}%`;
}

/**
 * The header item's ONE figure. Null when there is no credential (nothing to show).
 *  • Subscription, budget on, subscription known: how much of Limn's share is used — the week or the
 *    5-hour session, whichever is closer to its limit (the title says which).
 *  • Subscription otherwise: Claude's own whole-account weekly figure, when read.
 *  • API key, budget on: % of the weekly US$ budget. Off: this week's spend in US$.
 */
export function headerUsageOf(data: AiBudgetResponse): HeaderUsage | null {
  const { status, usage } = data;
  if (usage.route === 'none') return null;
  const over = status.overBudget;
  const toneOf = (pct: number): HeaderUsage['tone'] => (over ? 'over' : pct >= 80 ? 'near' : 'normal');

  if (usage.route === 'api_key') {
    if (status.mode === 'api_key' && status.apiKey != null && status.apiKey.weeklyUsd > 0) {
      const pct = (status.apiKey.usedUsd / status.apiKey.weeklyUsd) * 100;
      return {
        label: 'AI quota for Limn:',
        figure: ratioPct(pct),
        tone: toneOf(pct),
        title: `Limn has used ${ratioPct(pct)} of its weekly budget (${formatRunUsd(status.apiKey.usedUsd)} of ${formatRunUsd(status.apiKey.weeklyUsd)})`,
      };
    }
    if (usage.apiKey != null) {
      return {
        label: 'Limn AI, last 7 days:',
        figure: formatRunUsd(usage.apiKey.weekUsd),
        tone: 'normal',
        title: `Limn’s ${aiProviderName(usage.provider)} runs over the last 7 days: ${formatRunUsd(usage.apiKey.weekUsd)}`,
      };
    }
    return { label: 'AI usage', figure: null, tone: 'normal', title: 'AI usage' };
  }

  const s = status.mode === 'subscription' ? status.subscription : null;
  if (s != null && s.usedSharePct != null && s.sharePct > 0) {
    const week = (s.usedSharePct / s.sharePct) * 100;
    const five =
      s.fiveHourUsedSharePct != null && s.fiveHourSharePct > 0 ? (s.fiveHourUsedSharePct / s.fiveHourSharePct) * 100 : null;
    // Over: name the limit the server says paused runs. Otherwise the one closer to its limit.
    const useFive = over ? status.limitedBy === 'five_hour' : five != null && five > week;
    const pct = useFive && five != null ? five : week;
    return {
      label: 'AI quota for Limn:',
      figure: ratioPct(pct),
      tone: toneOf(pct),
      title: useFive
        ? `Limn has used ${ratioPct(pct)} of its share of this 5-hour session`
        : `Limn has used ${ratioPct(pct)} of its share of your week`,
    };
  }
  const acct = usage.account?.week?.usedPct;
  if (acct != null) {
    const name = aiProviderName(usage.provider);
    return {
      label: `${name} this week:`,
      figure: ratioPct(acct),
      tone: acct >= 80 ? 'near' : 'normal',
      title: `Your ${name} account has used ${ratioPct(acct)} of this week`,
    };
  }
  return { label: 'AI usage', figure: null, tone: 'normal', title: 'AI usage' };
}

export interface UsageRow {
  label: string;
  value: string;
  /** How full the row's bar is, 0–100 (a limit's share used, or Claude's own window used); none = no bar. */
  barPct?: number;
  /** One short line under the bar: the window ("Resets Thu 09:00", "Last 7 days"). */
  note?: string;
}

/** A bar's fill, clamped to 0–100; undefined for a figure that isn't a number. */
function barOf(pct: number | null | undefined): number | undefined {
  if (pct == null || !Number.isFinite(pct)) return undefined;
  return Math.min(100, Math.max(0, pct));
}
export interface UsageSection {
  title: string;
  rows: UsageRow[];
}
export interface UsageDetail {
  /** Whose figures these are. */
  provider: AiProviderId;
  heading: string;
  /** The paused sentence, while automatic runs are paused. */
  paused: string | null;
  sections: UsageSection[];
  /** "Updated 4 min ago" for the provider's own reading; null when nothing was read. */
  updated: string | null;
}

/** Compact token count: 1234 → "1.2k", 1_200_000 → "1.2M". */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

function ago(iso: string, now: number): string | null {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const min = Math.max(0, Math.round((now - t) / 60_000));
  if (min < 1) return 'Updated just now';
  if (min < 60) return `Updated ${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `Updated ${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  return `Updated ${d} day${d === 1 ? '' : 's'} ago`;
}

/** "31% used · 69% left · resets Tue 09:00" — unknown parts left out. Null when nothing is known. */
function windowValue(w: AiUsageWindowView, now: number): string | null {
  const parts: string[] = [];
  if (w.usedPct != null) {
    const used = Math.min(100, Math.max(0, w.usedPct));
    parts.push(`${Math.round(used)}% used`, `${Math.round(100 - used)}% left`);
  }
  const when = formatResume(w.resetsAt, now);
  if (when !== '') parts.push(`resets ${when}`);
  return parts.length === 0 ? null : parts.join(' · ');
}

function capitalise(s: string): string {
  const t = s.trim();
  return t === '' ? t : t.charAt(0).toUpperCase() + t.slice(1);
}

/** A ChatGPT plan as every surface names it: 'plus' → "ChatGPT Plus". */
export function chatGptPlanLabel(plan: string): string {
  return `ChatGPT ${capitalise(plan)}`;
}

/** "Resets Thu 09:00" when the provider told us the window's reset, else the rolling span it counts. */
export function windowNote(resetsAt: string | null | undefined, rolling: string, now: number = Date.now()): string {
  const when = formatResume(resetsAt ?? null, now);
  return when === '' ? rolling : `Resets ${when}`;
}

/**
 * One Limn share row: "0.4% · limit 5%" with a bar against the limit, or — no limit set — "0.4% · max
 * 50%" with a bar against the most Limn can be given (`limnShareScale`). Null while the share is unknown.
 */
function limnShareRow(
  label: string,
  sharePct: number | null,
  status: AiBudgetStatus,
  which: 'week' | 'five_hour',
  note: string,
): UsageRow | null {
  if (sharePct == null || !Number.isFinite(sharePct)) return null;
  const { maxPct, limitSet } = limnShareScale(status, which);
  return {
    label,
    value: `${formatFineSharePct(sharePct)} · ${limitSet ? 'limit' : 'max'} ${maxPct}%`,
    barPct: barOf((sharePct / maxPct) * 100),
    note,
  };
}

/** Every provider's popover block, the default first, then each other one in use (`others`). Pure. */
export function usageDetailsOf(data: AiBudgetResponse, now: number = Date.now()): UsageDetail[] {
  const first = usageDetailOf(data, now);
  const rest = (data.others ?? [])
    .filter((o) => o.provider !== first.provider)
    .map((o) => usageDetailOf(o, now));
  return [first, ...rest];
}

/** One provider's popover block. Pure; unknown pieces are left out, never shown as 0. */
export function usageDetailOf(
  data: Pick<AiBudgetResponse, 'status' | 'usage'>,
  now: number = Date.now(),
): UsageDetail {
  const { status, usage } = data;
  const provider: AiProviderId = usage.provider ?? status.provider ?? 'claude';
  const paused = status.overBudget ? pausedSentence(status, now) : null;
  const limn = usage.limn;
  const tokens: string[] = [];
  if (limn.inputTokens != null) tokens.push(`${formatTokens(limn.inputTokens)} in`);
  if (limn.outputTokens != null) tokens.push(`${formatTokens(limn.outputTokens)} out`);
  const runsRows: UsageRow[] = [{ label: 'Runs this week', value: limn.runs.toLocaleString('en-GB') }];
  if (tokens.length > 0) runsRows.push({ label: 'Tokens this week', value: tokens.join(' · ') });

  if (usage.route === 'api_key') {
    const rows: UsageRow[] = [];
    const k = usage.apiKey;
    const budget = status.mode === 'api_key' ? status.apiKey : null;
    if (k != null) {
      rows.push({
        label: 'Last 7 days',
        value:
          budget != null && budget.weeklyUsd > 0
            ? `${formatRunUsd(k.weekUsd)} of ${formatRunUsd(budget.weeklyUsd)} · ${ratioPct((budget.usedUsd / budget.weeklyUsd) * 100)}`
            : formatRunUsd(k.weekUsd),
        barPct: budget != null && budget.weeklyUsd > 0 ? barOf((budget.usedUsd / budget.weeklyUsd) * 100) : undefined,
      });
      rows.push({ label: 'Last 5 hours', value: formatRunUsd(k.fiveHourUsd) });
      rows.push({ label: 'Today', value: formatRunUsd(k.todayUsd) });
    }
    return {
      provider,
      heading: usage.provider === 'codex' ? 'OpenAI API key' : 'Anthropic API key',
      paused,
      sections: [{ title: 'Limn’s runs', rows: [...rows, ...runsRows] }],
      updated: null,
    };
  }

  const acct = usage.account;
  const kind = acct?.subscription ?? null;
  const reported = acct?.reportedSubscription ?? null;
  const name = aiProviderName(usage.provider);
  // Codex runs on a ChatGPT plan ("Codex · ChatGPT Plus"); Claude names its own subscription.
  const heading =
    usage.provider === 'codex'
      ? reported != null && reported.trim() !== ''
        ? `Codex · ChatGPT ${capitalise(reported)}`
        : 'Codex'
      : kind != null
        ? `Claude ${AI_SUBSCRIPTION_LABELS[kind]}`
        : reported != null && reported.trim() !== ''
          ? `Claude ${capitalise(reported)}`
          : 'Claude';

  // Limn's share of each window, the 5-hour session first (the account section's order). The windows
  // are the provider's own when it told us their reset (an older server sends no reset: rolling).
  const limnRows = [
    limnShareRow(
      'This 5-hour session',
      limn.fiveHourSharePct,
      status,
      'five_hour',
      windowNote(limn.fiveHourResetsAt, 'Last 5 hours', now),
    ),
    limnShareRow('This week', limn.weekSharePct, status, 'week', windowNote(limn.weekResetsAt, 'Last 7 days', now)),
  ].filter((r): r is UsageRow => r != null);
  const sections: UsageSection[] = [{ title: 'Limn’s share', rows: [...limnRows, ...runsRows] }];

  const acctRows: UsageRow[] = [];
  const push = (label: string, w: AiUsageWindowView | null | undefined): void => {
    if (w == null) return;
    const v = windowValue(w, now);
    if (v != null) acctRows.push({ label, value: v, barPct: barOf(w.usedPct) });
  };
  push('5-hour session', acct?.fiveHour);
  push('Week', acct?.week);
  for (const m of acct?.models ?? []) push(`${m.label ?? m.key}, week`, m);
  if (acctRows.length > 0) sections.push({ title: `Your ${name} account`, rows: acctRows });

  return {
    provider,
    heading,
    paused,
    sections,
    updated: acct?.observedAt != null && acctRows.length > 0 ? ago(acct.observedAt, now) : null,
  };
}

/**
 * Codex on a ChatGPT sign-in: its OWN two windows for Settings → AI spend, in percent only —
 * "Codex, 5-hour session: 12% used · 88% left · resets 14:30". Empty on Claude (its windows stay in
 * the header popover, unchanged), on an API key, or before a reading.
 */
export function codexWindowLines(usage: AiUsageView, now: number = Date.now()): string[] {
  if (usage.provider !== 'codex' || usage.route !== 'login' || usage.account == null) return [];
  const out: string[] = [];
  const one = (label: string, w: AiUsageWindowView | null): void => {
    if (w == null) return;
    const v = windowValue(w, now);
    if (v != null) out.push(`${label}: ${v}`);
  };
  one('Codex, 5-hour session', usage.account.fiveHour);
  one('Codex, week', usage.account.week);
  return out;
}
