// What one Save on the Chronology working-hours form sends.
//
// The server stores OVERRIDES ONLY and resolves the rest from the product defaults, so a later
// change to a default reaches every workspace that never changed it. That promise is kept or broken
// HERE: a form that sent every field on Save would freeze today's defaults into every workspace
// whose owner merely opened Settings.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/flowSettingsForm.test.ts
import { describe, expect, it } from 'vitest';
import {
  FLOW_BUDGET_DEFAULTS,
  FLOW_BUDGET_MEASURES,
  type FlowSettings,
} from '@pierre-review/shared';
import {
  budgetScaleNote,
  budgetScaleSteps,
  budgetValueText,
  buildFlowSettingsBody,
  flowFormProblem,
  formatBudgetHours,
  formDayHours,
  sameFlowBody,
  seedFlowForm,
  setBudgetFromSlider,
  sliderPosition,
  timeToMinute,
} from '../src/components/settings/flowSettingsForm.js';

describe('overrides only', () => {
  it('sends nothing for an untouched form over nothing stored', () => {
    expect(buildFlowSettingsBody(seedFlowForm(null))).toEqual({});
  });

  it('round-trips what is stored, and nothing more', () => {
    const stored = { timeZone: 'Asia/Tokyo', budgets: { firstLook: { good: 2 } } };
    expect(buildFlowSettingsBody(seedFlowForm(stored))).toEqual(stored);
  });

  it('drops a value typed equal to the default', () => {
    const form = seedFlowForm(null);
    form.budgets.lead.good = '8';
    form.days = [5, 4, 3, 2, 1];
    form.start = '09:00';
    expect(buildFlowSettingsBody(form)).toEqual({});
  });

  it('sends the working day as a pair, never half of it', () => {
    const form = seedFlowForm(null);
    form.end = '17:30';
    expect(buildFlowSettingsBody(form)).toEqual({ startMinute: 540, endMinute: 1050 });
  });

  it('treats an order change of the same days as no change', () => {
    expect(sameFlowBody({ days: [1, 2, 3] }, { days: [3, 1, 2] })).toBe(true);
    expect(sameFlowBody({ days: [1, 2, 3] }, { days: [1, 2] })).toBe(false);
  });
});

describe('problems, in the server’s words', () => {
  it('refuses an end before the start', () => {
    const form = seedFlowForm(null);
    form.start = '18:00';
    form.end = '09:00';
    expect(flowFormProblem(form)).toBe('The working day must end after it starts.');
  });

  it('refuses a "good" above the DEFAULT acceptable, which the server would silently widen', () => {
    const form = seedFlowForm(null);
    form.budgets.firstLook.good = '12'; // default acceptable is 8
    expect(flowFormProblem(form)).toBe('“Acceptable” cannot be tighter than “good”.');
  });

  it('refuses no working days at all', () => {
    const form = seedFlowForm(null);
    form.days = [];
    expect(flowFormProblem(form)).toBe('Pick at least one working day.');
  });

  it('reads 24:00 as the end of the day and rejects nonsense', () => {
    expect(timeToMinute('24:00')).toBe(1440);
    expect(timeToMinute('24:30')).toBeNull();
    expect(timeToMinute('9')).toBeNull();
  });
});

// ── THE SLIDERS ──────────────────────────────────────────────────────────────────────────────
//
// A range input holds an index, so each slider is a position on one stepped scale. The overrides-
// only promise above survives only if the scale bends to the data: every default must be a step (a
// thumb resting on it sends nothing), and every stored value must either be a step or be left alone.
describe('the budget scale', () => {
  it('is the sub-day steps, then whole and half working days, then the defaults', () => {
    expect(budgetScaleSteps(9, null)).toEqual([0.5, 1, 1.5, 2, 3, 4, 5, 6, 7, 8, 9, 13.5, 16, 18, 27, 36, 45]);
    expect(budgetScaleSteps(8, null)).toEqual([0.5, 1, 1.5, 2, 3, 4, 5, 6, 7, 8, 12, 16, 24, 32, 40]);
  });

  it('holds every default, whatever the working day', () => {
    for (const d of [1, 7.75, 9, 12]) {
      const steps = budgetScaleSteps(d, null);
      for (const m of FLOW_BUDGET_MEASURES) {
        expect(steps).toContain(FLOW_BUDGET_DEFAULTS[m].good);
        expect(steps).toContain(FLOW_BUDGET_DEFAULTS[m].ok);
      }
    }
  });

  it('makes a stored in-range value a step, so Save cannot move it', () => {
    const stored: FlowSettings = { budgets: { lead: { ok: 13 } } };
    const steps = budgetScaleSteps(9, stored);
    expect(steps).toContain(13);
    expect(sliderPosition(steps, 13)).toEqual({ index: steps.indexOf(13), off: null });
    expect(buildFlowSettingsBody(seedFlowForm(stored))).toEqual(stored);
  });

  it('pins a stored value past the range at the end, and keeps it', () => {
    const stored: FlowSettings = { budgets: { lead: { ok: 100 } } };
    const steps = budgetScaleSteps(9, stored);
    expect(steps).not.toContain(100);
    expect(sliderPosition(steps, 100)).toEqual({ index: steps.length - 1, off: 'above' });
    expect(buildFlowSettingsBody(seedFlowForm(stored))).toEqual(stored);
    expect(formatBudgetHours(100)).toBe('100h');
  });

  it('pins a value below the range at the start', () => {
    const steps = budgetScaleSteps(9, null);
    expect(sliderPosition(steps, 0.25)).toEqual({ index: 0, off: 'below' });
    expect(formatBudgetHours(0.25)).toBe('15m');
  });

  it('puts a value between two steps on the nearer, the lower on a tie', () => {
    expect(sliderPosition([4, 8], 6)).toEqual({ index: 0, off: null });
    expect(sliderPosition([4, 8], 7)).toEqual({ index: 1, off: null });
  });

  it('says where it ends: five working days, or the hours when a default lies past them', () => {
    expect(budgetScaleNote(budgetScaleSteps(9, null), 9)).toMatch(/to 5 working days \(45h\)\.$/);
    // A 1-hour day: five days is 5h, but the 16h defaults are still on the scale.
    expect(budgetScaleNote(budgetScaleSteps(1, null), 1)).toMatch(/to 16h\.$/);
  });
});

describe('moving a slider', () => {
  it('sends nothing when it comes to rest on the default', () => {
    let form = setBudgetFromSlider(seedFlowForm(null), 'lead', 'ok', 18);
    expect(buildFlowSettingsBody(form)).toEqual({ budgets: { lead: { ok: 18 } } });
    form = setBudgetFromSlider(form, 'lead', 'ok', 16);
    expect(form.budgets.lead.ok).toBe('');
    expect(buildFlowSettingsBody(form)).toEqual({});
  });

  // Pushing the other thumb along would write an override on a slider nobody touched.
  it('stops Good at Acceptable, and Acceptable at Good, without pushing either', () => {
    const f = setBudgetFromSlider(seedFlowForm(null), 'firstLook', 'good', 13.5);
    expect(f.budgets.firstLook).toEqual({ good: '8', ok: '' });
    expect(buildFlowSettingsBody(f)).toEqual({ budgets: { firstLook: { good: 8 } } });

    const g = seedFlowForm(null);
    g.budgets.firstLook.good = '6';
    expect(setBudgetFromSlider(g, 'firstLook', 'ok', 3).budgets.firstLook).toEqual({ good: '6', ok: '6' });
  });
});

describe('the working day and the words', () => {
  it("reads the day's length off the form, and the default day when it cannot", () => {
    const form = seedFlowForm(null);
    form.start = '09:00';
    form.end = '17:00';
    expect(formDayHours(form)).toBe(8);
    form.end = 'nonsense';
    expect(formDayHours(form)).toBe(9);
    form.end = '08:00'; // ends before it starts
    expect(formDayHours(form)).toBe(9);
  });

  it('describes a value in working hours, and in days where it is a day multiple', () => {
    expect(budgetValueText(18, 9, null)).toBe('18 working hours, 2 working days');
    expect(budgetValueText(4, 9, null)).toBe('4 working hours');
    expect(budgetValueText(1, 9, null)).toBe('1 working hour');
    expect(budgetValueText(9, 9, null)).toBe('9 working hours, 1 working day');
    // 1.5 × 8.75h = 13.125h, which the scale rounds to 13h.
    expect(budgetValueText(13, 8.75, null)).toBe('13 working hours, about 1.5 working days');
    expect(budgetValueText(100, 9, 'above')).toBe('100 working hours, beyond this scale');
  });

  it('prints hours exactly, never rounded and never in days', () => {
    expect(formatBudgetHours(0.5)).toBe('30m');
    expect(formatBudgetHours(4)).toBe('4h');
    expect(formatBudgetHours(13.5)).toBe('13.5h');
    expect(formatBudgetHours(45)).toBe('45h');
  });
});
