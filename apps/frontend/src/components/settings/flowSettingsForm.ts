import {
  FLOW_BUDGET_DEFAULTS,
  FLOW_BUDGET_MEASURES,
  FLOW_WORKDAY_DEFAULTS,
  validateFlowSettings,
  type FlowBudgetMeasure,
  type FlowSettings,
} from '@pierre-review/shared';

// The Settings form for Chronology's working hours and budgets, as pure functions so
// `apps/frontend/test/flowSettingsForm.test.ts` can pin them without a renderer (the
// `buildPendingMutePatch` precedent).
//
// ⚠ THE SERVER STORES OVERRIDES ONLY, AND THIS IS WHERE "ONLY" IS DECIDED. A field that equals the
// product default is not sent, and a blank budget box means "the default" — so a workspace that
// never changed a budget keeps following the product's, even after someone opened this form and
// pressed Save. The time zone is the exception: its default is the DEPLOYMENT's (the machine's zone
// locally, UTC in the cloud), which a reader may choose on purpose, so a typed zone is always kept.

export interface FlowForm {
  /** '' = the deployment default. */
  timeZone: string;
  days: number[];
  /** 'HH:MM' */
  start: string;
  end: string;
  /** '' = the product default. Strings, because they are what the inputs hold. */
  budgets: Record<FlowBudgetMeasure, { good: string; ok: string }>;
}

export function minuteToTime(m: number): string {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** 'HH:MM' → minutes after midnight; '24:00' is the end of the day. Null when unreadable. */
export function timeToMinute(t: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 24 || mi > 59 || (h === 24 && mi !== 0)) return null;
  return h * 60 + mi;
}

/** The form as it opens: whatever is stored, and the defaults everywhere else. */
export function seedFlowForm(stored: FlowSettings | null | undefined): FlowForm {
  const s = stored ?? {};
  const budgets = {} as FlowForm['budgets'];
  for (const m of FLOW_BUDGET_MEASURES) {
    const b = s.budgets?.[m];
    budgets[m] = {
      good: b?.good != null ? String(b.good) : '',
      ok: b?.ok != null ? String(b.ok) : '',
    };
  }
  return {
    timeZone: s.timeZone ?? '',
    days: [...(s.days ?? FLOW_WORKDAY_DEFAULTS.days)].sort((a, b) => a - b),
    start: minuteToTime(s.startMinute ?? FLOW_WORKDAY_DEFAULTS.startMinute),
    end: minuteToTime(s.endMinute ?? FLOW_WORKDAY_DEFAULTS.endMinute),
    budgets,
  };
}

function sameDays(a: readonly number[], b: readonly number[]): boolean {
  const x = [...new Set(a)].sort((p, q) => p - q);
  const y = [...new Set(b)].sort((p, q) => p - q);
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

function num(s: string): number | undefined {
  const t = s.trim();
  if (t === '') return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : Number.NaN;
}

/** What one Save sends: the whole override set, defaults left out. */
export function buildFlowSettingsBody(form: FlowForm): FlowSettings {
  const body: FlowSettings = {};
  const tz = form.timeZone.trim();
  if (tz !== '') body.timeZone = tz;
  if (!sameDays(form.days, FLOW_WORKDAY_DEFAULTS.days)) {
    body.days = [...new Set(form.days)].sort((a, b) => a - b);
  }
  const start = timeToMinute(form.start);
  const end = timeToMinute(form.end);
  const startOut = start ?? Number.NaN;
  const endOut = end ?? Number.NaN;
  if (startOut !== FLOW_WORKDAY_DEFAULTS.startMinute || endOut !== FLOW_WORKDAY_DEFAULTS.endMinute) {
    body.startMinute = startOut;
    body.endMinute = endOut;
  }
  const budgets: NonNullable<FlowSettings['budgets']> = {};
  for (const m of FLOW_BUDGET_MEASURES) {
    const good = num(form.budgets[m].good);
    const ok = num(form.budgets[m].ok);
    const b: { good?: number; ok?: number } = {};
    if (good !== undefined && good !== FLOW_BUDGET_DEFAULTS[m].good) b.good = good;
    if (ok !== undefined && ok !== FLOW_BUDGET_DEFAULTS[m].ok) b.ok = ok;
    if (b.good !== undefined || b.ok !== undefined) budgets[m] = b;
  }
  if (Object.keys(budgets).length > 0) body.budgets = budgets;
  return body;
}

/**
 * The first problem with the form, in the words the server would use — or null. Adds one check the
 * server cannot make from a partial body: a "good" typed above the DEFAULT "acceptable" would be
 * silently widened, so it is refused here with the same sentence.
 */
export function flowFormProblem(form: FlowForm): string | null {
  if (form.days.length === 0) return 'Pick at least one working day.';
  if (timeToMinute(form.start) == null || timeToMinute(form.end) == null) {
    return 'Enter the working day as two times, like 09:00 and 18:00.';
  }
  const body = buildFlowSettingsBody(form);
  const server = validateFlowSettings(body);
  if (server != null) return server;
  for (const m of FLOW_BUDGET_MEASURES) {
    const good = num(form.budgets[m].good) ?? FLOW_BUDGET_DEFAULTS[m].good;
    const ok = num(form.budgets[m].ok) ?? FLOW_BUDGET_DEFAULTS[m].ok;
    if (ok < good) return '“Acceptable” cannot be tighter than “good”.';
  }
  return null;
}

/** Order-independent equality of two bodies — what "dirty" means for the Save button. */
export function sameFlowBody(a: FlowSettings, b: FlowSettings): boolean {
  const canon = (s: FlowSettings): string =>
    JSON.stringify({
      timeZone: s.timeZone ?? null,
      days: s.days ? [...s.days].sort((x, y) => x - y) : null,
      startMinute: s.startMinute ?? null,
      endMinute: s.endMinute ?? null,
      budgets: FLOW_BUDGET_MEASURES.map((m) => [s.budgets?.[m]?.good ?? null, s.budgets?.[m]?.ok ?? null]),
    });
  return canon(a) === canon(b);
}
