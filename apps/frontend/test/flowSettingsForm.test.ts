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
  buildFlowSettingsBody,
  flowFormProblem,
  sameFlowBody,
  seedFlowForm,
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
