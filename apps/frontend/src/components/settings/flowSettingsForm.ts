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
// product default is not sent, and a blank budget (a slider resting on its default mark) means
// "the default" — so a workspace that never changed a budget keeps following the product's, even
// after someone opened this form and pressed Save. The time zone is the exception: its default is
// the DEPLOYMENT's (the machine's zone locally, UTC in the cloud), which a reader may choose on
// purpose, so a picked zone is always kept.

export interface FlowForm {
  /** '' = the deployment default. */
  timeZone: string;
  days: number[];
  /** 'HH:MM' */
  start: string;
  end: string;
  /** '' = the product default. Strings, so a stored value is carried exactly as stored until a
   *  slider moves it (Save cannot rewrite what nobody touched). */
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

// ── THE BUDGET SLIDERS ─────────────────────────────────────────────────────────────────────────
//
// Each wait gets two native range sliders (Good | Acceptable) over ONE stepped scale shared by all
// eight, so a thumb's position compares across rows the way the Chronology chart's one axis does.
// A range input can only hold an index, so the scale is a list of working hours and the slider's
// value is a position in it.
//
// ⚠ "A WORKING DAY" IS THIS WORKSPACE'S DAY, READ LIVE FROM THE FORM. Budgets are measured against
// that calendar, so "1 working day" on the scale must mean its day, not a fixed 8 or 9 hours.
//
// ⚠ THE SCALE BENDS TO WHAT IS STORED, NEVER THE OTHER WAY. Every default is a step (so a slider
// can rest on it and send nothing), and every stored value inside the range is a step (so Save
// cannot move it). A stored value outside the range — the API allows up to 1,000 hours — is
// pinned at that end, shown with its TRUE value, and left untouched until someone moves it.

/** Steps below one working day. */
export const BUDGET_SUB_DAY_STEPS: readonly number[] = [0.5, 1, 1.5, 2, 3, 4, 5, 6, 7, 8];
/** Whole and half working days on the scale; the last is where it ends. */
export const BUDGET_DAY_MULTIPLES: readonly number[] = [1, 1.5, 2, 3, 4, 5];

function roundHalf(h: number): number {
  return Math.round(h * 2) / 2;
}

/** The working day's length in hours, from the form's start and end; the default day when unreadable. */
export function formDayHours(form: FlowForm): number {
  const start = timeToMinute(form.start);
  const end = timeToMinute(form.end);
  if (start != null && end != null && end > start) return (end - start) / 60;
  return (FLOW_WORKDAY_DEFAULTS.endMinute - FLOW_WORKDAY_DEFAULTS.startMinute) / 60;
}

/** Where the scale ends: five working days, or the largest default when a day is very short. */
function scaleTop(dayHours: number): number {
  return Math.max(
    roundHalf(5 * dayHours),
    ...FLOW_BUDGET_MEASURES.flatMap((m) => [FLOW_BUDGET_DEFAULTS[m].good, FLOW_BUDGET_DEFAULTS[m].ok]),
  );
}

/**
 * Sorted, unique working hours:
 *   · BUDGET_SUB_DAY_STEPS below one working day;
 *   · roundHalf(k × dayHours) for k in BUDGET_DAY_MULTIPLES;
 *   · every FLOW_BUDGET_DEFAULTS value (so every slider can REST on its default);
 *   · every stored budget inside [0.5, top] (so a stored off-grid value is exact and Save cannot move it),
 * where top = max(roundHalf(5 × dayHours), 16). A stored value outside [0.5, top] is NOT added — it is pinned.
 */
export function budgetScaleSteps(dayHours: number, stored: FlowSettings | null | undefined): number[] {
  const top = scaleTop(dayHours);
  const steps = new Set<number>(BUDGET_SUB_DAY_STEPS.filter((h) => h < dayHours));
  for (const k of BUDGET_DAY_MULTIPLES) steps.add(roundHalf(k * dayHours));
  for (const m of FLOW_BUDGET_MEASURES) {
    steps.add(FLOW_BUDGET_DEFAULTS[m].good);
    steps.add(FLOW_BUDGET_DEFAULTS[m].ok);
    for (const v of [stored?.budgets?.[m]?.good, stored?.budgets?.[m]?.ok]) {
      if (typeof v === 'number' && v >= 0.5 && v <= top) steps.add(v);
    }
  }
  // A very short day rounds its multiples below half an hour; a budget of 0 is not one.
  return [...steps].filter((h) => h >= 0.5).sort((a, b) => a - b);
}

export interface SliderPosition {
  index: number;
  off: 'below' | 'above' | null;
}

/** Exact → its step. Outside the scale → pinned at that end with `off` set. Between two steps
 *  (the working day changed) → the nearer, lower on a tie, `off` null. */
export function sliderPosition(steps: readonly number[], value: number): SliderPosition {
  const last = steps.length - 1;
  const exact = steps.indexOf(value);
  if (exact !== -1) return { index: exact, off: null };
  if (value < (steps[0] ?? 0)) return { index: 0, off: 'below' };
  if (value > (steps[last] ?? 0)) return { index: last, off: 'above' };
  let best = 0;
  for (let i = 1; i <= last; i++) {
    if (Math.abs((steps[i] ?? 0) - value) < Math.abs((steps[best] ?? 0) - value)) best = i;
  }
  return { index: best, off: null };
}

/** The value a slider shows: the form string, or the product default when blank. */
export function budgetValue(form: FlowForm, m: FlowBudgetMeasure, k: 'good' | 'ok'): number {
  const v = num(form.budgets[m][k]);
  return v !== undefined && Number.isFinite(v) ? v : FLOW_BUDGET_DEFAULTS[m][k];
}

/** A slider moved. GOOD NEVER PASSES ACCEPTABLE and neither pushes the other: the moving value is
 *  clamped at the other's value (pushing would silently write an override on a slider nobody touched).
 *  A value equal to the product default is written as '' — "follow the default". */
export function setBudgetFromSlider(
  form: FlowForm,
  m: FlowBudgetMeasure,
  k: 'good' | 'ok',
  value: number,
): FlowForm {
  const other = budgetValue(form, m, k === 'good' ? 'ok' : 'good');
  const v = k === 'good' ? Math.min(value, other) : Math.max(value, other);
  const text = v === FLOW_BUDGET_DEFAULTS[m][k] ? '' : String(v);
  return { ...form, budgets: { ...form.budgets, [m]: { ...form.budgets[m], [k]: text } } };
}

/** The sentence under the sliders. The scale ends at five working days unless a day is so short
 *  that a default lies beyond that, and then it names the hours alone rather than claim five days. */
export function budgetScaleNote(steps: readonly number[], dayHours: number): string {
  const top = steps[steps.length - 1] ?? 0;
  const end =
    top === roundHalf(5 * dayHours) ? `5 working days (${formatBudgetHours(top)})` : formatBudgetHours(top);
  return `The mark under each track is the default; a wait left on it follows the default. The scale runs from half an hour to ${end}.`;
}

/** "30m", "4h", "13.5h", "45h" — hours, never days (the formatWorkHours rule), and never rounded:
 *  a budget is a setting, so the figure beside a slider is the exact one that will be stored. */
export function formatBudgetHours(h: number): string {
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}m`;
  return `${Number(h.toFixed(2))}h`;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** For aria-valuetext: "4 working hours", "1 working hour", "18 working hours, 2 working days",
 *  "13 working hours, about 1.5 working days" (when a day multiple was rounded to the half hour),
 *  "100 working hours, beyond this scale". */
export function budgetValueText(h: number, dayHours: number, off: SliderPosition['off']): string {
  const amount =
    h < 1
      ? plural(Math.max(1, Math.round(h * 60)), 'working minute', 'working minutes')
      : plural(Number(h.toFixed(2)), 'working hour', 'working hours');
  if (off != null) return `${amount}, beyond this scale`;
  for (const k of BUDGET_DAY_MULTIPLES) {
    if (roundHalf(k * dayHours) !== h) continue;
    const days = plural(k, 'working day', 'working days');
    return k * dayHours === h ? `${amount}, ${days}` : `${amount}, about ${days}`;
  }
  return amount;
}
