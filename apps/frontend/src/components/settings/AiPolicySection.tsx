import { useState } from 'react';
import type { AiUpdateMode } from '@pierre-review/shared';
import { Field, SaveButton, SectionShell, inputCls, type SectionProps } from './ui.js';

const MIN_INTERVAL = 5; // floor (backend also enforces >= its MIN_INTERVAL_SEC)

const MODES: { value: AiUpdateMode; label: string; desc: string }[] = [
  { value: 'manual', label: 'Manual', desc: 'Only regenerate when you click Refresh.' },
  { value: 'interval', label: 'Every N minutes', desc: 'Regenerate on a timer (unchanged repos cost nothing).' },
  { value: 'on_change', label: 'When a change is detected', desc: 'Regenerate after a sync that changed a watched repo.' },
];

// How the AI summaries / digests refresh: manually, on a fixed interval, or whenever a sync
// detects a change. Interval and on-change run through the same cheap payload-hash cache, so an
// unchanged repo re-bills nothing.
export function AiPolicySection({ settings, save, saving }: SectionProps): JSX.Element {
  const saved = settings.aiUpdate;
  const [mode, setMode] = useState<AiUpdateMode>(saved.mode);
  const [minutes, setMinutes] = useState<number>(saved.intervalMinutes);

  const dirty = mode !== saved.mode || (mode === 'interval' && minutes !== saved.intervalMinutes);

  return (
    <SectionShell title="AI summary updates" desc="Controls when the Pro Haiku digests / sprint report regenerate.">
      <div className="space-y-1.5">
        {MODES.map((m) => (
          <label key={m.value} className="flex items-start gap-2 text-xs">
            <input
              type="radio"
              name="ai-update-mode"
              className="mt-0.5"
              checked={mode === m.value}
              onChange={() => setMode(m.value)}
            />
            <span>
              <span className="font-medium text-gray-700 dark:text-gray-200">{m.label}</span>
              <span className="block text-[11px] text-gray-400">{m.desc}</span>
            </span>
          </label>
        ))}
      </div>
      {mode === 'interval' && (
        <Field label="Interval (minutes)" hint={`Minimum ${MIN_INTERVAL}.`}>
          <input
            type="number"
            min={MIN_INTERVAL}
            className={inputCls}
            value={minutes}
            onChange={(e) => setMinutes(Math.max(MIN_INTERVAL, Number(e.target.value) || MIN_INTERVAL))}
          />
        </Field>
      )}
      <SaveButton
        dirty={dirty}
        saving={saving}
        onClick={() => save({ aiUpdate: { mode, intervalMinutes: minutes } })}
      />
    </SectionShell>
  );
}
