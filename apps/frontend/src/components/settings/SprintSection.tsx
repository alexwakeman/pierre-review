import { useState } from 'react';
import type { SprintComparisonMode } from '@pierre-review/shared';
import { Field, SaveButton, SectionShell, inputCls, type SectionProps } from './ui.js';

const PRESETS = [7, 14, 21, 28];

const MODE_OPTIONS: { value: SprintComparisonMode; label: string; hint: string }[] = [
  {
    value: 'rolling_14',
    label: 'Rolling 14 days (default)',
    hint: 'Trailing 14 days vs the prior 14 — always a full window, no sprint needed. Best if you don’t run fixed sprints.',
  },
  {
    value: 'rolling_7',
    label: 'Rolling 7 days',
    hint: 'Trailing 7 days vs the prior 7 — a tighter, more responsive momentum read.',
  },
  {
    value: 'sprint',
    label: 'Sprint position (like-for-like)',
    hint: 'This sprint SO FAR vs the SAME point in the previous sprint (e.g. day 3 vs day 3). Needs a start date + cadence below.',
  },
];

// Comparison-window model for the Insights flow-metrics + sprint report, plus the (optional)
// sprint cadence/start that the 'sprint' mode uses. Accounts without sprints leave it on a rolling
// window and never set a date; the "Clear sprint dates" action disables sprints entirely.
export function SprintSection({ settings, save, saving }: SectionProps): JSX.Element {
  const savedMode = settings.sprint.comparisonMode;
  const savedDays = settings.sprint.cadenceDays ?? 14;
  const savedStart = settings.sprint.startDate?.slice(0, 10) ?? '';
  const [mode, setMode] = useState<SprintComparisonMode>(savedMode);
  const [days, setDays] = useState<number>(savedDays);
  const [custom, setCustom] = useState<boolean>(!PRESETS.includes(savedDays));
  const [start, setStart] = useState<string>(savedStart);

  const isSprint = mode === 'sprint';
  const dirty =
    mode !== savedMode || (isSprint && (days !== savedDays || start !== savedStart));
  const hasSprintDates = savedStart !== '' || settings.sprint.cadenceDays != null;
  const activeHint = MODE_OPTIONS.find((o) => o.value === mode)?.hint;

  // Save: in 'sprint' mode persist the cadence+start too; in a rolling mode change ONLY the mode
  // (leave any stored cadence/start untouched — unused by rolling, kept in case they switch back).
  const onSave = (): void =>
    save({
      sprint: isSprint
        ? { comparisonMode: mode, cadenceDays: days, startDate: start === '' ? null : start }
        : { comparisonMode: mode },
    });

  // Disable sprints entirely: clear the dates AND drop 'sprint' mode back to the rolling default.
  const clearSprint = (): void => {
    const nextMode: SprintComparisonMode = mode === 'sprint' ? 'rolling_14' : mode;
    setMode(nextMode);
    setStart('');
    setCustom(false);
    setDays(14);
    save({ sprint: { comparisonMode: nextMode, cadenceDays: null, startDate: null } });
  };

  return (
    <SectionShell
      title="Sprint"
      desc="How the Insights flow-metrics compare over time. Open PRs always count, regardless of the window."
    >
      <Field label="Comparison window" hint={activeHint}>
        <select
          className={inputCls}
          value={mode}
          onChange={(e) => setMode(e.target.value as SprintComparisonMode)}
        >
          {MODE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </Field>

      {isSprint && (
        <>
          <Field label="Cadence">
            <select
              className={inputCls}
              value={custom ? 'custom' : String(days)}
              onChange={(e) => {
                if (e.target.value === 'custom') {
                  setCustom(true);
                } else {
                  setCustom(false);
                  setDays(Number(e.target.value));
                }
              }}
            >
              <option value="7">1 week</option>
              <option value="14">2 weeks</option>
              <option value="21">3 weeks</option>
              <option value="28">4 weeks</option>
              <option value="custom">Custom…</option>
            </select>
          </Field>
          {custom && (
            <Field label="Sprint length (days)">
              <input
                type="number"
                min={1}
                max={90}
                className={inputCls}
                value={days}
                onChange={(e) => setDays(Math.max(1, Math.min(90, Number(e.target.value) || 1)))}
              />
            </Field>
          )}
          <Field
            label="Start date"
            hint="The day your first/any sprint began — cadence rolls forward from here."
          >
            <input
              type="date"
              className={inputCls}
              value={start}
              onChange={(e) => setStart(e.target.value)}
            />
          </Field>
          {start === '' && (
            <p className="text-[11px] text-amber-600 dark:text-amber-400">
              Set a start date to use sprint-position comparison — until then the Insights fall
              back to a rolling 14-day window.
            </p>
          )}
        </>
      )}

      <SaveButton dirty={dirty} saving={saving} onClick={onSave} />

      {hasSprintDates && (
        <div className="mt-3 border-t border-gray-100 pt-3 dark:border-gray-800">
          <button
            type="button"
            onClick={clearSprint}
            disabled={saving}
            className="text-[11px] text-gray-400 underline hover:text-red-500 disabled:opacity-50"
            title="Remove the sprint start date + cadence and use a rolling 14-day tracker"
          >
            Clear sprint dates (disable sprints)
          </button>
        </div>
      )}
    </SectionShell>
  );
}
