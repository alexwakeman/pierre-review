import { useEffect, useMemo, useRef, useState } from 'react';
import {
  compactMyTurnSettings,
  DO_NEXT_PRESET_ORDER,
  MY_TURN_DEFAULT_ORDER,
  MY_TURN_SETTING_LABEL,
  MY_TURN_TRUNK_SCOPES,
  presetOf,
  type MyTurnCardReason,
  type MyTurnToggle,
} from '@pierre-review/shared';
import { useMe, useProCapabilities } from '../../hooks/useTriage.js';
import { useSetMyTurnSettings } from '../../hooks/useMyTurnSettings.js';
import { ArrowIcon } from '../Icons.js';
import { SaveButton } from './ui.js';
import {
  ADD_ROWS,
  buildMyTurnSettingsBody,
  isOff,
  moveType,
  movedTypeAnnouncement,
  myTurnFormDirty,
  myTurnFormProblem,
  presetWeights,
  PRESET_DESC,
  PRESET_LABEL,
  resetOrderAndWeights,
  seedMyTurnForm,
  SHOW_ROWS,
  slideWeight,
  TRUNK_SCOPE_LABEL,
  WEIGHT_KEYS,
  WEIGHT_LABEL,
  type MyTurnForm,
  type WeightSlide,
} from './myTurnSettingsForm.js';

// SETTINGS → MY TURN — CORE / free, both deployment modes, every tier. ACCOUNT-grained (one account
// is one reader), stored on the account row and carried by /api/me, so like the blast-radius
// section above it this renders ABOVE SettingsModal's pro-settings loading gate.
//
// ⚠ A TYPE SWITCHED OFF IS REMOVED, NOT HIDDEN. The server gates it inside `getMyTurn`, so the list,
// every count, the brief lines and the notifications shrink together — the copy says so, and says
// "Show in My Turn", never "mute": the Pending mute is a different control that KEEPS a card.
//
// ⚠ THE ID AND THE FOCUSABLE HEADING ARE LOAD-BEARING. Pending's "Customise" link opens Settings
// with `focus: 'my-turn'`, and the modal scrolls to `#settings-my-turn` and focuses its heading.
// That is why this section writes its own shell rather than `SectionShell`, whose title cannot
// take focus.

const SECTION_ID = 'settings-my-turn';
export const MY_TURN_SECTION_HEADING_ID = 'settings-my-turn-heading';

const sub = 'text-xs font-medium text-gray-600 dark:text-gray-300';
const hint = 'text-[12px] text-gray-500 dark:text-gray-400';
const pill = (on: boolean): string =>
  `rounded-full border px-2 py-0.5 text-[12px] font-medium transition-colors ${
    on
      ? 'border-gray-400 bg-gray-100 text-gray-800 dark:border-gray-500 dark:bg-gray-800 dark:text-gray-100'
      : 'border-gray-300 text-gray-600 hover:border-gray-400 dark:border-gray-700 dark:text-gray-300'
  }`;

export function MyTurnSection(): JSX.Element {
  const { data: me } = useMe();
  const { claudeReview } = useProCapabilities();
  const save = useSetMyTurnSettings();
  const stored = me?.myTurnSettings ?? null;

  const [form, setForm] = useState<MyTurnForm>(() => seedMyTurnForm(stored));
  // Re-seed when the STORED value changes (first load, after a save) — keyed on the compacted
  // overrides, never the object React Query hands back on every refetch, which would throw away a
  // half-made edit.
  const storedKey = JSON.stringify(compactMyTurnSettings(stored));
  useEffect(() => {
    setForm(seedMyTurnForm(stored));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storedKey]);

  // Claude reviews exist only where the capability is on; elsewhere the type is neither offered
  // nor listed — but it keeps its place in the stored order, and a move steps over it.
  const hidden = useMemo(
    () => new Set<MyTurnCardReason>(claudeReview ? [] : ['claude_review']),
    [claudeReview],
  );
  const showRows = SHOW_ROWS.filter((r) => !hidden.has(r.reason));
  const visibleOrder = form.order.filter((r) => !hidden.has(r));

  // After a move the row's DOM node is re-inserted, which drops focus. Put it back on the same
  // button of the moved row — or its other button, once the row reaches an end. Focus alone tells a
  // screen reader nothing (the row's number is not in either button's name, and at an end focus
  // jumps to the other button), so the move is also said in the live region under the list.
  const moveButtons = useRef(new Map<string, HTMLButtonElement>());
  const pendingFocus = useRef<{ reason: MyTurnCardReason; dir: -1 | 1 } | null>(null);
  const [moved, setMoved] = useState('');
  useEffect(() => {
    const p = pendingFocus.current;
    if (p == null) return;
    pendingFocus.current = null;
    const same = moveButtons.current.get(`${p.reason}:${p.dir}`);
    const other = moveButtons.current.get(`${p.reason}:${-p.dir}`);
    (same != null && !same.disabled ? same : other)?.focus();
    setMoved(movedTypeAnnouncement(form.order, p.reason, MY_TURN_SETTING_LABEL[p.reason], hidden));
  }, [form.order, hidden]);

  // Each slider drag re-shares from where it began, or the rounding drifts the other two.
  const slide = useRef<WeightSlide | null>(null);

  const move = (reason: MyTurnCardReason, dir: -1 | 1): void => {
    pendingFocus.current = { reason, dir };
    setForm((f) => ({ ...f, order: moveType(f.order, reason, dir, hidden) }));
  };
  const setShow = (reason: MyTurnToggle, on: boolean): void =>
    setForm((f) => ({ ...f, show: { ...f.show, [reason]: on } }));

  const preset = presetOf(form.weights);
  const problem = myTurnFormProblem(form);
  const dirty = myTurnFormDirty(form, stored);
  const atDefaultRanking =
    preset === 'balanced' && form.order.every((r, i) => r === MY_TURN_DEFAULT_ORDER[i]);

  return (
    <section
      id={SECTION_ID}
      aria-labelledby={MY_TURN_SECTION_HEADING_ID}
      className="border-b border-gray-100 pb-4 last:border-b-0 dark:border-gray-800"
    >
      <h3
        id={MY_TURN_SECTION_HEADING_ID}
        tabIndex={-1}
        className="text-sm font-semibold text-gray-800 outline-none dark:text-gray-100"
      >
        My Turn
      </h3>
      <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
        What counts as your turn, and how Pending orders cards. Applies to every workspace.
      </p>

      <div className="mt-2.5 space-y-4">
        {/* ── Show in My Turn ─────────────────────────────────────────────────────────────── */}
        <fieldset className="space-y-1.5">
          <legend className={sub}>Show in My Turn</legend>
          <div className="grid gap-x-4 gap-y-1.5 sm:grid-cols-2">
            {showRows.map(({ reason, hint: line }) => (
              <label key={reason} className="flex cursor-pointer items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={form.show[reason]}
                  onChange={(e) => setShow(reason, e.target.checked)}
                />
                <span className="min-w-0">
                  <span className="block text-[12px] font-medium text-gray-700 dark:text-gray-200">
                    {MY_TURN_SETTING_LABEL[reason]}
                  </span>
                  <span className={`block ${hint}`}>{line}</span>
                </span>
              </label>
            ))}
          </div>
          <p className={hint}>
            Switching a type off removes it from My Turn, its counts and its notifications. Review
            requests and new PRs can still show in Waiting on review.
          </p>
        </fieldset>

        {/* ── Add to My Turn ──────────────────────────────────────────────────────────────── */}
        <fieldset className="space-y-1.5">
          <legend className={sub}>Add to My Turn</legend>
          <div className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
            {ADD_ROWS.map((reason) => (
              <label key={reason} className="flex cursor-pointer items-center gap-2 text-[12px]">
                <input
                  type="checkbox"
                  checked={form.show[reason]}
                  onChange={(e) => setShow(reason, e.target.checked)}
                />
                <span className="text-gray-700 dark:text-gray-200">
                  {MY_TURN_SETTING_LABEL[reason]}
                </span>
              </label>
            ))}
          </div>
          <div role="radiogroup" aria-label={MY_TURN_SETTING_LABEL.trunk_red} className="space-y-1">
            <div className="text-[12px] font-medium text-gray-700 dark:text-gray-200">
              {MY_TURN_SETTING_LABEL.trunk_red}
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {MY_TURN_TRUNK_SCOPES.map((scope) => (
                <label key={scope} className="flex cursor-pointer items-center gap-1.5 text-[12px]">
                  <input
                    type="radio"
                    name="my-turn-trunk-scope"
                    checked={form.trunkScope === scope}
                    onChange={() => setForm((f) => ({ ...f, trunkScope: scope }))}
                  />
                  <span className="text-gray-700 dark:text-gray-200">{TRUNK_SCOPE_LABEL[scope]}</span>
                </label>
              ))}
            </div>
          </div>
          <p className={hint}>
            These move out of their own tab into My turn, and notify you unless the repo is muted.
          </p>
        </fieldset>

        {/* ── Order of My turn ────────────────────────────────────────────────────────────── */}
        <div className="space-y-1.5">
          <h4 className={sub}>Order of My turn</h4>
          <p className={hint}>My turn groups cards by type, in this order.</p>
          {/* Up/down buttons, not drag: keyboard- and touch-native, no dependency, and a list of
              fifteen does not need drag. */}
          <ol className="space-y-0.5">
            {visibleOrder.map((reason, i) => {
              const label = MY_TURN_SETTING_LABEL[reason];
              return (
                <li
                  key={reason}
                  className="flex items-center gap-2 rounded px-1 text-[12px] hover:bg-gray-50 dark:hover:bg-gray-800/60"
                >
                  <span className="w-5 shrink-0 text-right tabular-nums text-gray-500 dark:text-gray-400">
                    {i + 1}
                  </span>
                  <span className="min-w-0 flex-1 text-gray-700 dark:text-gray-200">
                    {label}
                    {isOff(form, reason) && (
                      <span className="ml-1 text-gray-500 dark:text-gray-400">(off)</span>
                    )}
                  </span>
                  {([-1, 1] as const).map((dir) => (
                    <button
                      key={dir}
                      type="button"
                      ref={(el) => {
                        const k = `${reason}:${dir}`;
                        if (el) moveButtons.current.set(k, el);
                        else moveButtons.current.delete(k);
                      }}
                      onClick={() => move(reason, dir)}
                      disabled={dir === -1 ? i === 0 : i === visibleOrder.length - 1}
                      aria-label={`Move “${label}” ${dir === -1 ? 'up' : 'down'}`}
                      className="rounded p-1.5 text-gray-600 hover:bg-gray-100 hover:text-gray-900 disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent dark:text-gray-300 dark:hover:bg-gray-800 dark:hover:text-gray-50"
                    >
                      <ArrowIcon dir={dir === -1 ? 'up' : 'down'} size={12} />
                    </button>
                  ))}
                </li>
              );
            })}
          </ol>
          <p aria-live="polite" className="sr-only">
            {moved}
          </p>
        </div>

        {/* ── How Pending ranks cards ─────────────────────────────────────────────────────── */}
        <div className="space-y-2">
          <h4 className={sub}>How Pending ranks cards</h4>
          <p className={hint}>
            Every Pending tab ranks its cards by these three. In My turn they rank cards within each
            type.
          </p>
          {/* NATIVE RADIOS drawn as pills, like the red-default-branch group above: one Tab stop,
              and the arrow keys move AND apply a preset — what a screen reader's "radio button, 1
              of 4" promises. Buttons wearing role="radio" announced that and did neither. */}
          <div className="flex flex-wrap items-center gap-1.5">
            <div role="radiogroup" aria-label="Ranking preset" className="flex flex-wrap gap-1.5">
              {DO_NEXT_PRESET_ORDER.map((p) => (
                <label
                  key={p}
                  className={`${pill(preset === p)} relative cursor-pointer has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-sky-500`}
                >
                  <input
                    type="radio"
                    name="my-turn-preset"
                    className="sr-only"
                    checked={preset === p}
                    onChange={() => setForm((f) => ({ ...f, weights: presetWeights(p) }))}
                  />
                  {PRESET_LABEL[p]}
                </label>
              ))}
            </div>
            {/* Not a choice you can make — what the sliders say when they match no preset. A status,
                OUTSIDE the group: no radio is checked then. */}
            {preset === 'custom' && <span className={pill(true)}>Custom</span>}
          </div>
          {preset !== 'custom' && <p className={hint}>{PRESET_DESC[preset]}</p>}
          <div className="space-y-1">
            {WEIGHT_KEYS.map((k) => {
              const id = `my-turn-weight-${k}`;
              const v = form.weights[k];
              return (
                <div key={k} className="flex items-center gap-2">
                  <label
                    htmlFor={id}
                    className="w-36 shrink-0 text-[12px] text-gray-700 sm:w-44 dark:text-gray-200"
                  >
                    {WEIGHT_LABEL[k]}
                  </label>
                  <input
                    id={id}
                    type="range"
                    min={0}
                    max={100}
                    step={10}
                    value={v}
                    aria-valuetext={`${v} percent`}
                    onChange={(e) => {
                      const s = slideWeight(slide.current, form.weights, k, Number(e.target.value));
                      slide.current = s;
                      setForm((f) => ({ ...f, weights: s.to }));
                    }}
                    className="budget-range min-w-0 flex-1"
                  />
                  <output
                    htmlFor={id}
                    className="w-10 shrink-0 text-right text-xs tabular-nums text-gray-800 dark:text-gray-100"
                  >
                    {v}%
                  </output>
                </div>
              );
            })}
          </div>
          <p className={hint}>They always add up to 100%.</p>
          <button
            type="button"
            onClick={() => setForm(resetOrderAndWeights)}
            disabled={atDefaultRanking}
            className="rounded border border-gray-300 px-2 py-0.5 text-[12px] font-medium text-gray-600 hover:bg-gray-50 disabled:cursor-default disabled:opacity-40 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            Reset
          </button>
        </div>

        {problem != null && (
          <p className="text-[12px] text-red-600 dark:text-red-400" role="alert">
            {problem}
          </p>
        )}
        <SaveButton
          dirty={dirty && problem == null}
          saving={save.isPending}
          onClick={() => save.mutate(buildMyTurnSettingsBody(form))}
        />
        {save.isError && (
          <p className="text-[12px] text-red-600 dark:text-red-400" role="alert">
            {save.error?.message ?? 'Couldn’t save your My Turn settings.'}
          </p>
        )}
      </div>
    </section>
  );
}
