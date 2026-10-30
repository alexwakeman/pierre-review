import { useEffect, useState } from 'react';
import { useWorkspaces, useWorkspaceMutations } from '../../hooks/useWorkspaces.js';
import { useMe } from '../../hooks/useTriage.js';
import { inputCls, SaveButton, SectionShell } from './ui.js';
import { ScopePendingSection, useSettingsWorkspace } from './workspaceScope.js';
import { BudgetSliders } from './BudgetSliders.js';
import { TimeZoneCombobox } from './TimeZoneCombobox.js';
import {
  buildFlowSettingsBody,
  flowFormProblem,
  sameFlowBody,
  seedFlowForm,
  type FlowForm,
} from './flowSettingsForm.js';

const DAYS: { iso: number; short: string }[] = [
  { iso: 1, short: 'Mon' },
  { iso: 2, short: 'Tue' },
  { iso: 3, short: 'Wed' },
  { iso: 4, short: 'Thu' },
  { iso: 5, short: 'Fri' },
  { iso: 6, short: 'Sat' },
  { iso: 7, short: 'Sun' },
];

/**
 * CHRONOLOGY'S WORKING HOURS AND WAIT BUDGETS for the selected workspace, stored on the workspace
 * row.
 *
 * ⚠ BLANK MEANS DEFAULT. A budget slider resting on its default mark follows the product default,
 * and the form sends only what differs from it (`buildFlowSettingsBody`), so a later change to a
 * default still reaches this workspace. The time zone's "Default (<zone>)" entry is the blank one.
 * "Reset to defaults" sends `{}`.
 */
export function FlowSettingsSection(): JSX.Element {
  const { workspaceId } = useSettingsWorkspace();
  const workspaces = useWorkspaces();
  const me = useMe();
  const { setWorkspaceFlowSettings } = useWorkspaceMutations();

  const workspace = workspaces.data?.find((w) => w.id === workspaceId) ?? null;
  const stored = workspace?.flowSettings ?? null;
  const defaultZone =
    me.data?.workTimeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';

  const [form, setForm] = useState<FlowForm>(() => seedFlowForm(stored));
  // Re-seed when the workspace or the STORED value changes — keyed on the values, not the object
  // identity React Query hands back on every refetch (the PendingMuteSection rule).
  const storedKey = `${workspaceId}|${JSON.stringify(stored)}`;
  useEffect(() => {
    setForm(seedFlowForm(stored));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storedKey]);

  if (workspaceId == null || workspace == null) {
    return <ScopePendingSection title="Working hours and budgets" failed={workspaces.isError} />;
  }

  const problem = flowFormProblem(form);
  const body = buildFlowSettingsBody(form);
  const storedBody = buildFlowSettingsBody(seedFlowForm(stored));
  const dirty = !sameFlowBody(body, storedBody);

  const toggleDay = (iso: number): void =>
    setForm((f) => ({
      ...f,
      days: f.days.includes(iso) ? f.days.filter((d) => d !== iso) : [...f.days, iso].sort((a, b) => a - b),
    }));

  return (
    <SectionShell
      title="Working hours and budgets"
      desc="Chronology counts only the hours your team works, and holds each wait against a budget. Nights, weekends and days off are not counted as waiting."
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1 text-body">
          <label htmlFor="flow-tz" className="font-medium text-ui-mute">
            Time zone
          </label>
          <TimeZoneCombobox
            id="flow-tz"
            value={form.timeZone}
            onChange={(tz) => setForm((f) => ({ ...f, timeZone: tz }))}
            defaultZone={defaultZone}
          />
        </div>
        <div className="flex flex-col gap-1 text-body">
          <span className="font-medium text-ui-mute">Working day</span>
          <div className="flex items-center gap-2">
            <input
              type="time"
              aria-label="Start of the working day"
              className={inputCls}
              value={form.start}
              onChange={(e) => setForm((f) => ({ ...f, start: e.target.value }))}
            />
            <span className="text-ui-mute">to</span>
            <input
              type="time"
              aria-label="End of the working day"
              className={inputCls}
              value={form.end}
              onChange={(e) => setForm((f) => ({ ...f, end: e.target.value }))}
            />
          </div>
        </div>
      </div>

      <div className="text-body">
        <div className="mb-1 font-medium text-ui-mute">Working days</div>
        <div className="flex flex-wrap gap-1.5">
          {DAYS.map((d) => {
            const on = form.days.includes(d.iso);
            return (
              <button
                key={d.iso}
                type="button"
                aria-pressed={on}
                onClick={() => toggleDay(d.iso)}
                className={`rounded-ui border px-2 py-0.5 text-body ${
                  on
                    ? 'border-transparent bg-ui-accent-fill text-ui-on-accent'
                    : 'border-ui-line text-ui-mute hover:bg-ui-hover'
                }`}
              >
                {d.short}
              </button>
            );
          })}
        </div>
      </div>

      <BudgetSliders form={form} setForm={setForm} stored={stored} />

      {problem != null && (
        <p className="text-body text-ui-danger" role="alert">
          {problem}
        </p>
      )}

      <div className="flex items-center gap-3">
        <SaveButton
          dirty={dirty && problem == null}
          saving={setWorkspaceFlowSettings.isPending}
          onClick={() => setWorkspaceFlowSettings.mutate({ id: workspaceId, settings: body })}
        />
        {stored != null && (
          <button
            type="button"
            disabled={setWorkspaceFlowSettings.isPending}
            onClick={() => setWorkspaceFlowSettings.mutate({ id: workspaceId, settings: {} })}
            className="hit text-meta text-ui-mute hover:underline disabled:opacity-40"
          >
            Reset to defaults
          </button>
        )}
      </div>
      {setWorkspaceFlowSettings.isError && (
        <div className="text-body text-ui-danger">
          {(setWorkspaceFlowSettings.error as Error)?.message ?? 'Couldn’t save the working hours.'}
        </div>
      )}
    </SectionShell>
  );
}
