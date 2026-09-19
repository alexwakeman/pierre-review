// CHRONOLOGY'S WORKING HOURS AND WAIT BUDGETS — per workspace, stored as overrides only.
//
// ⚠ WHY WORKING HOURS. Chronology charges every hour a pull request waits to whoever it is waiting
// on. Measured on a real workspace, 73% of those hours fell outside the team's working day, so a
// PR opened on Friday afternoon was charged a weekend and "Friday" looked like the slowest day.
// Counting only working hours asks the question a team can act on: how long did it wait while
// people were at work?
//
// ⚠ WHY BUDGETS, NOT A BALANCE. An even split between waiting for a reviewer, waiting for the
// author and waiting to merge is not a target: a PR approved on its first review never visits
// its author at all, which is the best outcome and reads as lopsided. Each wait instead gets a
// budget in working hours — "good" and "acceptable" — and the screen shows where three in four
// PRs actually landed against it.
//
// ⚠ STORED AS OVERRIDES, RESOLVED IN ONE PLACE. `workspaces.flow_settings` is NULL until someone
// changes something, and then holds only what they changed. `resolveFlowSettings` fills the rest
// from the product defaults below, so a future change to a default reaches every workspace that
// never overrode it (the blast-radius config precedent). The engine, the route and the Settings
// form all resolve through this one function.

/** The four waits a budget is set for. */
export type FlowBudgetMeasure = 'firstLook' | 'reply' | 'land' | 'lead';

export const FLOW_BUDGET_MEASURES: readonly FlowBudgetMeasure[] = [
  'firstLook',
  'reply',
  'land',
  'lead',
];

export interface FlowBudget {
  /** Working hours. At or under this is "within budget". */
  good: number;
  /** Working hours. Over `good` but at or under this is "acceptable"; over it is "slow". */
  ok: number;
}

/**
 * The product defaults. The first look has an outside source — Google's published review
 * guidance puts one business day as the most a first response should take; "good" is half of
 * that and "acceptable" is the ceiling. The others follow from it:
 *   reply  — the same one-day ceiling on the author's side of each round;
 *   land   — nothing is left to decide once approved, so the merge step itself (merge when ready
 *            makes it zero);
 *   lead   — what the three add up to for a PR with at most one review round.
 */
export const FLOW_BUDGET_DEFAULTS: Record<FlowBudgetMeasure, FlowBudget> = {
  firstLook: { good: 4, ok: 8 },
  reply: { good: 8, ok: 16 },
  land: { good: 1, ok: 4 },
  lead: { good: 8, ok: 16 },
};

/** ISO weekdays, 1 = Monday … 7 = Sunday. */
export const FLOW_WORKDAY_DEFAULTS = {
  days: [1, 2, 3, 4, 5] as number[],
  /** Minutes after local midnight. 09:00. */
  startMinute: 9 * 60,
  /** Minutes after local midnight. 18:00. */
  endMinute: 18 * 60,
};

/** What `workspaces.flow_settings` holds: only the fields someone changed. */
export interface FlowSettings {
  /** An IANA zone, e.g. "Europe/London". */
  timeZone?: string;
  days?: number[];
  startMinute?: number;
  endMinute?: number;
  budgets?: Partial<Record<FlowBudgetMeasure, Partial<FlowBudget>>>;
}

/** The settings in force, every field filled, with which parts are still the defaults. */
export interface ResolvedFlowSettings {
  timeZone: string;
  days: number[];
  startMinute: number;
  endMinute: number;
  budgets: Record<FlowBudgetMeasure, FlowBudget>;
  /** True where nothing was stored — the SPA says "default" beside these. */
  defaults: { timeZone: boolean; hours: boolean; budgets: boolean };
}

/**
 * Resolve stored overrides against the defaults. `fallbackTimeZone` is the deployment's default
 * zone (the machine's own zone locally, UTC in the cloud) and is used only when none was stored.
 *
 * Defensive against a malformed stored value: anything that would not pass `validateFlowSettings`
 * is ignored field by field rather than trusted, so a bad row degrades to the defaults instead of
 * producing nonsense hours.
 */
export function resolveFlowSettings(
  raw: FlowSettings | null | undefined,
  fallbackTimeZone: string,
): ResolvedFlowSettings {
  const s = raw ?? {};
  const tzOk = typeof s.timeZone === 'string' && isValidTimeZone(s.timeZone);
  const daysOk =
    Array.isArray(s.days) &&
    s.days.length > 0 &&
    s.days.every((d) => Number.isInteger(d) && d >= 1 && d <= 7);
  const start = s.startMinute;
  const end = s.endMinute;
  const hoursOk =
    Number.isInteger(start) &&
    Number.isInteger(end) &&
    (start as number) >= 0 &&
    (end as number) <= 24 * 60 &&
    (start as number) < (end as number);
  const budgets = {} as Record<FlowBudgetMeasure, FlowBudget>;
  let budgetsDefault = true;
  for (const m of FLOW_BUDGET_MEASURES) {
    const d = FLOW_BUDGET_DEFAULTS[m];
    const o = s.budgets?.[m];
    const good = validHours(o?.good) ? (o!.good as number) : d.good;
    const okRaw = validHours(o?.ok) ? (o!.ok as number) : d.ok;
    if (validHours(o?.good) || validHours(o?.ok)) budgetsDefault = false;
    budgets[m] = { good, ok: Math.max(good, okRaw) };
  }
  return {
    timeZone: tzOk ? (s.timeZone as string) : fallbackTimeZone,
    days: daysOk ? [...new Set(s.days as number[])].sort((a, b) => a - b) : FLOW_WORKDAY_DEFAULTS.days,
    startMinute: hoursOk ? (start as number) : FLOW_WORKDAY_DEFAULTS.startMinute,
    endMinute: hoursOk ? (end as number) : FLOW_WORKDAY_DEFAULTS.endMinute,
    budgets,
    defaults: { timeZone: !tzOk, hours: !daysOk && !hoursOk, budgets: budgetsDefault },
  };
}

function validHours(v: unknown): boolean {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 1000;
}

export function isValidTimeZone(tz: string): boolean {
  if (tz.length === 0 || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * The ONE validator for a settings write — the route rejects with the first problem, and the
 * Settings form shows the same sentence before it ever sends. Returns null when the value is fine.
 */
export function validateFlowSettings(s: FlowSettings): string | null {
  if (s.timeZone !== undefined && !isValidTimeZone(s.timeZone)) {
    return `“${s.timeZone}” is not a time zone this browser or server recognises.`;
  }
  if (s.days !== undefined) {
    if (!Array.isArray(s.days) || s.days.length === 0) return 'Pick at least one working day.';
    if (!s.days.every((d) => Number.isInteger(d) && d >= 1 && d <= 7)) return 'Working days must be Monday to Sunday.';
  }
  const hasStart = s.startMinute !== undefined;
  const hasEnd = s.endMinute !== undefined;
  if (hasStart !== hasEnd) return 'Set both the start and the end of the working day.';
  if (hasStart && hasEnd) {
    const a = s.startMinute as number;
    const b = s.endMinute as number;
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b > 24 * 60) {
      return 'The working day must start and end within the same day.';
    }
    if (a >= b) return 'The working day must end after it starts.';
  }
  for (const m of FLOW_BUDGET_MEASURES) {
    const o = s.budgets?.[m];
    if (o == null) continue;
    for (const k of ['good', 'ok'] as const) {
      if (o[k] !== undefined && !validHours(o[k])) return 'Budgets must be between 0 and 1,000 working hours.';
    }
    if (o.good !== undefined && o.ok !== undefined && o.ok < o.good) {
      return '“Acceptable” cannot be tighter than “good”.';
    }
  }
  return null;
}

/** Plain labels for the four waits, shared by the server's sentences and the SPA's rows. */
export const FLOW_BUDGET_LABEL: Record<FlowBudgetMeasure, string> = {
  firstLook: 'First look',
  reply: 'Reply to review',
  land: 'Approved to merged',
  lead: 'Whole pull request',
};
