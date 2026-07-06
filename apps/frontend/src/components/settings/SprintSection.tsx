import { useState } from 'react';
import { Field, SaveButton, SectionShell, inputCls, type SectionProps } from './ui.js';

const PRESETS = [7, 14, 21, 28];

// Sprint cadence + start date. Defines the rolling window the Insights metrics summarize (the
// current sprint auto-advances: start + N whole cadence-lengths up to today). Open PRs always
// count regardless of age — see getTeamInsights.
export function SprintSection({ settings, save, saving }: SectionProps): JSX.Element {
  const savedDays = settings.sprint.cadenceDays ?? 14;
  const savedStart = settings.sprint.startDate?.slice(0, 10) ?? '';
  const [days, setDays] = useState<number>(savedDays);
  const [custom, setCustom] = useState<boolean>(!PRESETS.includes(savedDays));
  const [start, setStart] = useState<string>(savedStart);

  const dirty = days !== savedDays || start !== savedStart;

  return (
    <SectionShell
      title="Sprint"
      desc="Defines the window your Insights metrics summarize. Open PRs always count, even if older than the sprint."
    >
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
      <Field label="Start date" hint="The day your first/any sprint began — cadence rolls forward from here.">
        <input
          type="date"
          className={inputCls}
          value={start}
          onChange={(e) => setStart(e.target.value)}
        />
      </Field>
      <SaveButton
        dirty={dirty}
        saving={saving}
        onClick={() =>
          save({ sprint: { cadenceDays: days, startDate: start === '' ? null : start } })
        }
      />
    </SectionShell>
  );
}
