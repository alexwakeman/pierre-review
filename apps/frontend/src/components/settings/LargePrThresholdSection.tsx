import { useEffect, useState } from 'react';
import { LARGE_PR_CODE_LOC_DEFAULT } from '@pierre-review/shared';
import { useMe } from '../../hooks/useTriage.js';
import { useSetLargePrThreshold } from '../../hooks/useLargePr.js';
import { Field, SaveButton, SectionShell, inputCls } from './ui.js';

// The large-PR threshold — CORE / free, both deployment modes, every tier. A pull request whose
// CODE churn (documentation, config, lockfiles, generated and vendored output all excluded by the
// backend before the sum) reaches this many lines gets a subtle flag wherever it is listed.
//
// ⚠ ONE NUMBER PER ACCOUNT, and it is stored SERVER-SIDE. It deliberately does NOT live in the
// Zustand filter store: `store/filters.ts` persists and RESETS from one shared list, so a
// threshold parked there would be silently wiped by "Clear filters" — a setting the user typed
// once, gone on an unrelated click. It is also not per-workspace: "how big is too big to review"
// is a property of the reader, not of a repo grouping.
//
// Independent of pro_settings (it is a plain /api/me field), so like BenchmarkConsentSection it
// renders ABOVE SettingsModal's pro-settings loading gate.

/** Empty input = "no opinion" = the product default. Anything else must be a positive whole
 *  number of lines. Returns the value to POST, or an error string to show instead. */
function parseDraft(draft: string): { value: number | null } | { error: string } {
  const trimmed = draft.trim();
  if (trimmed === '') return { value: null };
  // Explicit digits-only test rather than Number(): `Number('1e4')`, `' 12 '` and `'1.0'` all
  // coerce to something plausible, and the server would take them.
  if (!/^\d+$/.test(trimmed)) return { error: 'Enter a whole number of lines, or leave empty.' };
  const n = Number(trimmed);
  if (!Number.isSafeInteger(n) || n <= 0) return { error: 'Enter a number greater than zero.' };
  return { value: n };
}

export function LargePrThresholdSection(): JSX.Element {
  const { data: me } = useMe();
  const save = useSetLargePrThreshold();

  // The STORED value, which is null whenever the account is on the default — that is exactly
  // what `largePrCodeLocThresholdIsDefault` exists to tell us, since the resolved number alone
  // cannot distinguish "the user typed 1500" from "the user typed nothing".
  const stored: number | null =
    me == null || me.largePrCodeLocThresholdIsDefault ? null : me.largePrCodeLocThreshold;
  const storedText = stored == null ? '' : String(stored);

  const [draft, setDraft] = useState(storedText);
  // Re-seed when the server value changes (first load, and after a successful save).
  useEffect(() => {
    setDraft(storedText);
  }, [storedText]);

  const parsed = parseDraft(draft);
  const error = 'error' in parsed ? parsed.error : null;
  const dirty = draft.trim() !== storedText;

  return (
    <SectionShell
      title="Large pull requests"
      desc="Flag a pull request once its code churn passes this many lines. Documentation, config, lockfiles and generated or vendored files don’t count — a 4,000-line lockfile bump is not a large PR."
    >
      <Field
        label="Threshold (lines of code changed)"
        htmlFor="large-pr-threshold"
        hint={
          <>
            Leave empty to use the default of{' '}
            {LARGE_PR_CODE_LOC_DEFAULT.toLocaleString()} lines. Applies to every workspace, and
            takes effect everywhere the moment you save.
          </>
        }
      >
        <input
          id="large-pr-threshold"
          type="text"
          inputMode="numeric"
          className={`${inputCls} max-w-[10rem]`}
          value={draft}
          placeholder={`Default (${LARGE_PR_CODE_LOC_DEFAULT.toLocaleString()})`}
          onChange={(e) => setDraft(e.target.value)}
          aria-invalid={error != null}
          aria-describedby={error != null ? 'large-pr-threshold-error' : undefined}
        />
      </Field>

      {error != null && (
        <div id="large-pr-threshold-error" className="text-[11px] text-red-500">
          {error}
        </div>
      )}

      <SaveButton
        dirty={dirty && error == null}
        saving={save.isPending}
        onClick={() => {
          if (error != null || !('value' in parsed)) return;
          save.mutate(parsed.value);
        }}
      />

      {save.isError && (
        <div className="text-[11px] text-red-500">
          {(save.error as Error)?.message ?? 'Couldn’t save your threshold.'}
        </div>
      )}
    </SectionShell>
  );
}
