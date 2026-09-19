import { Fragment, useId } from 'react';
import {
  FLOW_BUDGET_DEFAULTS,
  FLOW_BUDGET_LABEL,
  FLOW_BUDGET_MEASURES,
  type FlowBudgetMeasure,
  type FlowSettings,
} from '@pierre-review/shared';
import { ArrowIcon } from '../Icons.js';
import {
  budgetScaleNote,
  budgetScaleSteps,
  budgetValue,
  budgetValueText,
  formatBudgetHours,
  formDayHours,
  setBudgetFromSlider,
  sliderPosition,
  type FlowForm,
} from './flowSettingsForm.js';

/** Must match the thumb width in index.css (`.budget-range`) — the default tick is placed from it. */
const THUMB_PX = 14;

/**
 * THE FOUR WAIT BUDGETS as two native range sliders each (Good | Acceptable), on one scale. The
 * behaviour lives in flowSettingsForm.ts, where it is tested; this is layout only.
 *
 * ⚠ A SLIDER RESTING ON ITS DEFAULT SENDS NOTHING. The tick under each track marks the default, and
 * `setBudgetFromSlider` writes '' when a thumb lands on it, so Save stays disabled and the workspace
 * keeps following the product default (the overrides-only rule `buildFlowSettingsBody` enforces).
 */
export function BudgetSliders({
  form,
  setForm,
  stored,
}: {
  form: FlowForm;
  setForm: (f: (prev: FlowForm) => FlowForm) => void;
  stored: FlowSettings | null;
}): JSX.Element {
  const dayHours = formDayHours(form);
  const steps = budgetScaleSteps(dayHours, stored);

  return (
    <div className="text-xs">
      <div className="mb-1 font-medium text-gray-600 dark:text-gray-300">Budgets, in working hours</div>
      {/* ⚠ BELOW `sm` EACH WAIT'S NAME TAKES ITS OWN ROW, above its two sliders. On one row at phone
          width the name column and two value columns left each track 22px (9px at 360px, narrower
          than the thumb) for 17 steps — settable by keyboard only, and a phone has no arrow keys.
          Good and Acceptable stay side by side at every width. */}
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center gap-x-4 gap-y-2 sm:grid-cols-[8.5rem_minmax(0,1fr)_minmax(0,1fr)]">
        <span className="hidden sm:block" />
        <span className="text-[11px] font-medium text-gray-500 dark:text-gray-400">Good</span>
        <span className="text-[11px] font-medium text-gray-500 dark:text-gray-400">Acceptable</span>
        {FLOW_BUDGET_MEASURES.map((m) => (
          <Fragment key={m}>
            <span className="col-span-2 text-xs text-gray-700 sm:col-span-1 dark:text-gray-200">
              {FLOW_BUDGET_LABEL[m]}
            </span>
            {(['good', 'ok'] as const).map((k) => (
              <BudgetSlider
                key={k}
                m={m}
                k={k}
                form={form}
                setForm={setForm}
                steps={steps}
                dayHours={dayHours}
              />
            ))}
          </Fragment>
        ))}
      </div>
      <p className="mt-1.5 text-xs text-gray-500 dark:text-gray-400">
        {budgetScaleNote(steps, dayHours)}
      </p>
    </div>
  );
}

function BudgetSlider({
  m,
  k,
  form,
  setForm,
  steps,
  dayHours,
}: {
  m: FlowBudgetMeasure;
  k: 'good' | 'ok';
  form: FlowForm;
  setForm: (f: (prev: FlowForm) => FlowForm) => void;
  steps: readonly number[];
  dayHours: number;
}): JSX.Element {
  const inputId = useId();
  const value = budgetValue(form, m, k);
  const pos = sliderPosition(steps, value);
  const last = Math.max(1, steps.length - 1);
  // The default is always a step (budgetScaleSteps adds every default), so its tick is exact.
  const tick = sliderPosition(steps, FLOW_BUDGET_DEFAULTS[m][k]).index / last;

  return (
    <div className="flex items-center gap-2">
      <div className="relative h-[22px] min-w-0 flex-1">
        <input
          id={inputId}
          type="range"
          min={0}
          max={steps.length - 1}
          step={1}
          value={pos.index}
          aria-label={`${FLOW_BUDGET_LABEL[m]}, ${k === 'good' ? 'good' : 'acceptable'}`}
          aria-valuetext={budgetValueText(value, dayHours, pos.off)}
          onChange={(e) => {
            const next = steps[Number(e.target.value)];
            if (next != null) setForm((f) => setBudgetFromSlider(f, m, k, next));
          }}
          className="budget-range absolute inset-x-0 top-0"
        />
        <span
          aria-hidden
          className="absolute top-[15px] h-2 w-0.5 bg-gray-700 dark:bg-gray-300"
          style={{ left: `calc(${tick * 100}% - ${tick * THUMB_PX}px + ${THUMB_PX / 2 - 1}px)` }}
        />
      </div>
      <output
        htmlFor={inputId}
        className="inline-flex w-12 shrink-0 items-center justify-end gap-0.5 text-xs tabular-nums text-gray-800 dark:text-gray-100"
      >
        {formatBudgetHours(value)}
        {pos.off != null && <ArrowIcon dir={pos.off === 'above' ? 'right' : 'left'} size={10} />}
      </output>
    </div>
  );
}
