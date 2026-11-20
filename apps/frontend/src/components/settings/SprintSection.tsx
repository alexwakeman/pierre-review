import { useEffect, useRef, useState } from 'react';
import type { SprintComparisonMode, WorkspaceProSettingsUpdate } from '@pierre-review/shared';
import {
  useUpdateWorkspaceProSettings,
  useWorkspaceProSettings,
} from '../../hooks/useWorkspaceProSettings.js';
import { InfoButton } from '../InfoModal.js';
import { Field, SectionShell, inputCls } from './ui.js';
import { SaveState, useAutoSave } from './autosave.js';
import { ScopePendingSection, useSettingsWorkspace } from './workspaceScope.js';
import { Select } from '../ui/index.js';

const PRESETS = [7, 14, 21, 28];
const NONE = 'none';
const LENGTH_OPTIONS = [
  { value: NONE, label: 'No sprint — this workspace doesn’t run one' },
  { value: '7', label: '1 week' },
  { value: '14', label: '2 weeks' },
  { value: '21', label: '3 weeks' },
  { value: '28', label: '4 weeks' },
  { value: 'custom', label: 'Custom…' },
] as const;

const MODE_OPTIONS: { value: SprintComparisonMode; label: string; hint: string }[] = [
  {
    value: 'rolling_14',
    label: 'Rolling 14 days (default)',
    hint: 'Trailing 14 days vs the prior 14 — always a full window, no sprint needed. Best if this workspace doesn’t run fixed sprints.',
  },
  {
    value: 'rolling_7',
    label: 'Rolling 7 days',
    hint: 'Trailing 7 days vs the prior 7 — a tighter, more responsive momentum read.',
  },
  {
    value: 'sprint',
    label: 'Sprint position (like-for-like)',
    hint: 'This sprint SO FAR vs the SAME point in the previous sprint (e.g. day 3 vs day 3). Uses the cadence set above; with no cadence it falls back to rolling 14 days.',
  },
];

/**
 * What ONE write of this section sends. Extracted from the component so the rule can be pinned
 * without a renderer (`apps/frontend/test/sprintSectionPatch.test.ts`).
 *
 * ⚠ EACH HALF IS SENT ONLY WHEN IT CHANGED, even though one write may carry both. The patch is
 * sectioned and `useUpdateWorkspaceProSettings` keys its invalidation sweeps off which sections
 * are PRESENT, not on whether their values differ from the stored ones. An unchanged `sprint`
 * riding along on a mode-only edit would regrid nothing, yet would still push every stored period
 * report through the "the cadence changed" refetch path — and would re-send a `startDate` the
 * server had already normalised.
 *
 * ⚠ `cadenceDays: null` CLEARS THE PAIR — it does not delete the row, which also holds the mode
 * and the issue tracker. `startDate: null` goes with it so a later re-enable does not silently
 * inherit a phase anchor the user cleared months ago.
 *
 * ⚠ AN EMPTY PATCH IS REACHABLE AND MUST STAY LEGAL. Nothing is written when neither half is
 * dirty, but that is a UI rule, not a guarantee; `{}` is a well-formed no-op patch rather than
 * something that throws or writes a default.
 */
export function buildSprintPatch(edit: {
  cadenceDirty: boolean;
  modeDirty: boolean;
  days: number | null;
  start: string;
  mode: SprintComparisonMode;
}): WorkspaceProSettingsUpdate {
  const patch: WorkspaceProSettingsUpdate = {};
  if (edit.cadenceDirty) {
    patch.sprint =
      edit.days != null
        ? { cadenceDays: edit.days, startDate: edit.start === '' ? null : edit.start }
        : { cadenceDays: null, startDate: null };
  }
  if (edit.modeDirty) patch.comparisonMode = edit.mode;
  return patch;
}

/**
 * The sprint grid for the CURRENTLY-SELECTED workspace: how long a sprint is, where its
 * boundaries fall, and how two stretches of time are compared against each other.
 *
 * ⚠ THIS USED TO BE TWO SECTIONS AND IS NOW ONE. There was a "Sprint (account default)" section
 * sitting above a per-workspace override, with a "Cadence source" select choosing between them.
 * There is NO account-level cadence any more (plugin migration 0031): `resolveSprintCadence` reads
 * the workspace row or answers "no cadence" — two states, no chain. A `cadenceDays` of null is not
 * "inherit", it is NO SPRINT GRID: the comparison window degrades to rolling-14 and the Reports
 * sprint grain refuses, which is exactly what an unconfigured account already did.
 *
 * ⚠ EVERY CONTROL HERE IS AT ONE GRAIN — THE WORKSPACE'S — AND THAT IS WHY THERE IS ONE WRITE.
 * The comparison MODE was the last account-wide knob in this modal, fenced off in its own box
 * under a "Applies to every workspace" caption and its own Save button, justified by a comment
 * reading "a reading preference with no per-team meaning". THAT CLAIM WAS FALSE, and it was the
 * mode's composition with the cadence that made it false: under `'sprint'`, a workspace WITH a
 * cadence got a sprint-position window while one WITHOUT silently got rolling-14, so a single
 * account setting produced two different window SHAPES across one reader's workspaces with
 * nothing on screen saying so. The mode moved onto the same row as the cadence it composes with
 * in plugin migration 0032, the fence came down, and the two Saves became one (and, since Settings
 * saves as you go, one write).
 *
 * ⚠ THE RULE THAT KEPT THEM APART IS SPENT HERE, NOT REPEALED. One write spanning TWO GRAINS is
 * still how an edit meant for one team travels silently to every team — so a control added to
 * this modal at the ACCOUNT grain still belongs above the "Workspace" heading, in its own section
 * with its own write, never inside a workspace-scoped one. What changed is that this section no
 * longer has such a control, not that mixing them became safe.
 *
 * ⚠ THE WORKSPACE IS NAMED ONCE, IN THE MODAL'S "Workspace" HEADING, NOT IN THIS TITLE. Three
 * sections each appending "— acme-web" to their heading was the same fact three times; the group
 * heading above them owns it now. What stays in this copy is the BLAST RADIUS ("only this
 * workspace"), which is a different claim and still has to be made beside the controls.
 *
 * ⚠ IT DISCLOSES WHAT A CADENCE CHANGE DOES TO EXISTING REPORTS, before the change: the line
 * shows whenever a cadence is set, so it is read before the length or start date is touched
 * (Settings saves as you go — ./autosave.tsx — so there is no later moment to say it). Stored reports
 * are artifacts people forward: changing the cadence regrids the period boundaries, so reports
 * measured under the old one stop being LISTED as periods. They are not destroyed and not
 * rewritten — they move to the Reports pane's archive and stay readable. Saying so is the
 * difference between a setting and a surprise. The MODE never regrids anything, so it is
 * deliberately not part of that disclosure.
 */
export function SprintSection(): JSX.Element {
  const { workspaceId } = useSettingsWorkspace();
  const query = useWorkspaceProSettings(workspaceId != null, workspaceId);
  const mutation = useUpdateWorkspaceProSettings(workspaceId);
  const data = query.data;

  // Local edit state, re-seeded whenever the resolved workspace or the STORED VALUES change. An
  // uncontrolled seed would keep the previous workspace's numbers in the inputs after a switch —
  // and the autosave would then write them onto the new one (`seededFor` holds it back).
  //
  // ⚠ KEYED ON THE VALUES, NOT ON THE RESPONSE OBJECT. React Query hands back a new object
  // identity on every background refetch (a window focus past the 60s staleTime is enough), so a
  // `[data]` dependency would silently revert a half-made edit while the user was still in it.
  const [days, setDays] = useState<number | null>(null);
  const [custom, setCustom] = useState(false);
  const [start, setStart] = useState('');
  // ⚠ THE MODE IS IN THE SIGNATURE TOO, now that it is stored on this row. Leaving it out would
  // strand the select on the previous workspace's mode after a scope switch — and this section's
  // autosave would write it there.
  const [mode, setMode] = useState<SprintComparisonMode>('rolling_14');
  const signature = `${workspaceId ?? 'none'}:${data?.cadenceDays ?? 'none'}:${data?.startDate?.slice(0, 10) || 'none'}:${data?.comparisonMode ?? 'none'}`;
  const [seededFor, setSeededFor] = useState<number | null>(null);
  // What this section last wrote: its echo must not re-seed over an edit made since.
  const sent = useRef<string | null>(null);
  useEffect(() => {
    if (data == null) return;
    setSeededFor(workspaceId);
    if (sent.current === signature) {
      sent.current = null;
      return;
    }
    setDays(data.cadenceDays);
    setCustom(data.cadenceDays != null && !PRESETS.includes(data.cadenceDays));
    setStart(data.startDate?.slice(0, 10) ?? '');
    setMode(data.comparisonMode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  const activeHint = MODE_OPTIONS.find((o) => o.value === mode)?.hint;

  const savedDays = data?.cadenceDays ?? null;
  const savedStart = data?.startDate?.slice(0, 10) ?? '';
  const savedMode = data?.comparisonMode;
  const enabled = days != null;
  const cadenceDirty = data != null && (days !== savedDays || (enabled && start !== savedStart));
  const modeDirty = data != null && mode !== savedMode;
  const dirty = cadenceDirty || modeDirty;
  const draftSignature = `${workspaceId ?? 'none'}:${days ?? 'none'}:${(enabled && start) || 'none'}:${mode}`;
  // Saves as you go (./autosave.tsx): a select writes at once, a typed length or a date after a
  // short pause and on blur.
  const autosave = useAutoSave({
    key: draftSignature,
    ready: dirty && workspaceId != null && seededFor === workspaceId,
    busy: mutation.isPending,
    run: () => {
      // Matches `signature` once the server echoes it (a cleared cadence clears the date too).
      sent.current = draftSignature;
      mutation.mutate(buildSprintPatch({ cadenceDirty, modeDirty, days, start, mode }));
    },
  });

  // ⚠ NOTHING RENDERS AGAINST AN UNRESOLVED SCOPE. `workspaceId === null` means "not resolved
  // yet", and an editor seeded from whatever the server picked as Default would save one team's
  // cadence onto another. (SettingsModal holds the whole Workspace half back for the same reason;
  // this guard is the one at the point of the WRITE, and stays.)
  if (workspaceId == null || data == null) {
    return <ScopePendingSection title="Sprint cadence" failed={query.isError} />;
  }


  return (
    <SectionShell
      title="Sprint cadence and comparison window"
      desc="Applies to this workspace only. Every other workspace sets its own."
      info={
        <InfoButton title="Sprint cadence and comparison window">
          <p>
            The sprint length sets this workspace’s Reports periods and its “Sprint to date”
            range.
          </p>
          <p>
            The comparison window is the window Reports measures: the flow metrics, Activity and
            Reach by repository, and Chronology&rsquo;s first option. Open pull requests and Red
            checks now count what is open right now, so the window does not change them.
          </p>
          <p>
            Changing the sprint length moves the period boundaries. Reports already generated are
            kept unchanged and stay readable under Earlier cadences at the bottom of the Reports
            pane.
          </p>
        </InfoButton>
      }
    >
      <Field
        group
        label="Sprint length"
        hint={
          enabled
            ? undefined
            : 'No sprint grid: Reports cannot generate at the sprint grain and the comparison window below falls back to a rolling 14 days.'
        }
      >
        <Select
          label="Sprint length"
          className="w-full sm:w-auto"
          value={days == null ? NONE : custom ? 'custom' : String(days)}
          options={LENGTH_OPTIONS}
          onChange={(v) => {
            autosave.now();
            if (v === NONE) {
              setCustom(false);
              setDays(null);
            } else if (v === 'custom') {
              setCustom(true);
              setDays(days ?? 14);
            } else {
              setCustom(false);
              setDays(Number(v));
            }
          }}
        />
      </Field>

      {enabled && (
        <>
          {custom && (
            <Field label="Sprint length (days)">
              <input
                type="number"
                min={1}
                max={90}
                className={inputCls}
                value={days}
                onChange={(e) => setDays(Math.max(1, Math.min(90, Number(e.target.value) || 1)))}
                onBlur={autosave.flush}
              />
            </Field>
          )}
          <Field
            label="Start date"
            hint="Any day one of this workspace’s sprints began — the cadence rolls forward and backward from here, so it sets where the boundaries fall, not when history starts."
          >
            {/* ⚠ The theme is a CLASS on <html> while `color-scheme` follows the OS, so on a light
                OS the native calendar button painted dark-on-dark in the dark theme and the
                picker looked gone. The input carries its own scheme per theme, and a click
                anywhere on it opens the calendar (Chrome otherwise opens it only from the
                small button). */}
            <input
              type="date"
              className={`${inputCls} cursor-pointer [color-scheme:light] dark:[color-scheme:dark]`}
              value={start}
              onChange={(e) => setStart(e.target.value)}
              onBlur={autosave.flush}
              onClick={(e) => {
                try {
                  e.currentTarget.showPicker?.();
                } catch {
                  // Not allowed here (no user activation, or inside a cross-origin frame): the
                  // field's own calendar button still works.
                }
              }}
            />
          </Field>
          {start === '' && (
            <p className="text-meta text-ui-warn">
              A cadence needs a start date to locate its boundaries. Until one is set, this
              workspace has no period grid and Reports cannot generate.
            </p>
          )}
        </>
      )}

      {/* The comparison window — the SAME grain as the cadence above it since plugin migration
          0032, so no fence, no second caption and no second write. */}
      <Field group label="Comparison window" hint={activeHint}>
        <Select
          label="Comparison window"
          className="w-full sm:w-auto"
          value={mode}
          options={MODE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
          onChange={(v) => {
            autosave.now();
            setMode(v);
          }}
        />
      </Field>

      {/* ⚠ THE DISCLOSURE. Stated BEFORE the change (whenever a cadence is set, or a new one is being
          made), because a change is written as it is made. The mode never regrids, so it is not
          part of it. */}
      {(savedDays != null || cadenceDirty) && (
        <p className="rounded-ui bg-ui-raise px-2 py-1.5 text-meta text-ui-warn">
          Changing the sprint length or start date moves this workspace’s period boundaries. Reports already generated are{' '}
          <span className="font-medium">kept unchanged</span> but leave the period picker; they
          stay readable under <span className="font-medium">Earlier cadences</span> at the bottom
          of the Reports pane.
        </p>
      )}

      <SaveState section="Sprint cadence" mutation={mutation} dirty={dirty} />
    </SectionShell>
  );
}
