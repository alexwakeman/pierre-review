import type { ConflictDecision, ConflictRegion } from '@pierre-review/shared';
import type { SlotDecision, SlotRole } from '../../lib/mergeResolver.js';
import {
  AcceptBothIcon,
  AcceptLeftIcon,
  AcceptRightIcon,
  IgnoreHunkIcon,
  PencilIcon,
  SparkleIcon,
  SwapOrderIcon,
  UndoIcon,
  WandIcon,
} from '../Icons.js';
import { EDIT_REGION, INK_CLASS, actionLabels, regionGroupLabel, stateWord } from './copy.js';

// ── THE CONTROL SET FOR ONE REGION ───────────────────────────────────────────────────────────
//
// ⚠ "TAKE THIS SIDE" IS NOT ON THIS STRIP ANY MORE — IT IS THE GUTTER ARROW, AND THERE IS NOW
// ONLY ONE OF IT. `ours` and `theirs` used to sit at the head of this strip AND again as a
// hover-revealed arrow in each gutter: one verb, two controls, every region announcing as a pair
// of identical buttons. The arrow won the job because it sits beside the pane whose lines it
// takes and points into the result, which is the whole sentence without a word in it. It is now
// ALWAYS drawn, carries a real name and a real tab stop, and is no longer `aria-hidden` — see
// `SlotRow`'s `gutter`. The rule that nothing in the resolver is reachable only by hovering did
// not change; the control that has to obey it did.
//
// What is left here is every verb that is NOT about one side: both orders, the order swap, the
// wand, ignore, Ask Claude, Edit and undo — plus the state word, which is the encoding that
// survives a reader who cannot separate the hues, and the only thing that still tells `Ignored`
// from `Needs a decision` now that neither paints a side, or `Your text` from a taken side now
// that both wear the applied green in the centre.
//
// ⚠ EXCEPT WHEN THE PANES ARE STACKED. Below `NARROW_PX` there are no gutter tracks to put an
// arrow in, so `sideTakes` puts the two side verbs back here. One control per verb in EACH
// layout — not a duplicate, a relocation.
//
// ⚠ ROVING TAB STOPS. Only the ACTIVE region's buttons are in the tab order; every other strip's
// are `tabIndex={-1}`, and `SlotRow`'s two gutter arrows read the same `active` prop so they obey
// the same scheme. Four hundred regions is four hundred strips, and without this Tab walks two
// thousand buttons before it reaches the toolbar. The single-key bindings on the panes container
// (`←`/`→`/`b`/`x`/`u`) reach every control on the active region without tabbing at all.
//
// ⚠ `role="group"` + `aria-label` LIVE HERE, NOT ON THE ROW. The row wrapper is
// `display: contents`, which removes it from the accessibility tree entirely, so the grouping and
// the "Conflict 2 of 5 in src/…" position have nowhere else to go. The gutter arrows sit in their
// own grid cells OUTSIDE this group, which is why each of them names its own position — see
// `gutterLabel` in `copy.ts`.

const BTN =
  'flex items-center gap-1 rounded border px-1 py-0.5 text-[11px] leading-none transition-colors ' +
  'border-gray-300 text-gray-700 hover:border-gray-400 hover:bg-gray-100 ' +
  'dark:border-gray-700 dark:text-gray-200 dark:hover:border-gray-600 dark:hover:bg-gray-800';
const BTN_ON =
  'flex items-center gap-1 rounded border px-1 py-0.5 text-[11px] leading-none ' +
  'border-gray-500 bg-gray-100 text-gray-900 dark:border-gray-400 dark:bg-gray-800 dark:text-gray-50';

export function SlotStrip({
  region,
  slot,
  role,
  fileIndex,
  ordinal,
  total,
  path,
  baseRef,
  active,
  sideTakes,
  onAskClaude,
  askInFlight,
  onEdit,
  editOpen,
  onActivate,
  onDecide,
}: {
  region: ConflictRegion;
  slot: SlotDecision;
  role: SlotRole;
  fileIndex: number;
  ordinal: number;
  total: number;
  path: string;
  baseRef: string;
  active: boolean;
  /** The panes are stacked, so there are no gutter tracks and the two single-side takes have
   *  nowhere else to live. See the header: a relocation, never a second copy. */
  sideTakes: boolean;
  /** Offer "Ask Claude" on this region. Absent ⇒ the control does not render AT ALL — the reader
   *  is unentitled, or the resolver is running somewhere the plugin is not. ABSENT, NEVER LOCKED:
   *  a lock inside a screen already doing its whole job would advertise into a working feature. */
  onAskClaude?: (() => void) | undefined;
  /** An Ask is in flight for this region. */
  askInFlight?: boolean;
  /** Open the text box for this region's result. Offered on EVERY decidable region — it is not a
   *  side, so there is no kind that withholds it — and absent only on `unchanged`, which is
   *  context and which this strip never renders for anyway. CORE and free: no tier check. */
  onEdit?: (() => void) | undefined;
  /** The text box is open for this region, so the button reads as the toggle it is. */
  editOpen?: boolean;
  onActivate: () => void;
  /** `null` clears the decision back to undecided — the region-level undo. */
  onDecide: (decision: ConflictDecision | null) => void;
}): JSX.Element {
  const labels = actionLabels(baseRef);
  const tab = active ? 0 : -1;
  const allows = (d: ConflictDecision): boolean => region.allowed.includes(d);
  const wandOffered = region.wand?.reason === 'disjoint_words' && allows('disjoint_merge');

  const button = (
    key: string,
    on: boolean,
    label: string,
    icon: JSX.Element,
    decision: ConflictDecision | null,
    text?: string,
  ): JSX.Element => (
    <button
      key={key}
      type="button"
      tabIndex={tab}
      aria-pressed={on}
      title={label}
      aria-label={label}
      onClick={() => {
        onActivate();
        onDecide(decision);
      }}
      className={on ? BTN_ON : BTN}
    >
      {icon}
      {text != null && <span>{text}</span>}
    </button>
  );

  return (
    <div
      role="group"
      aria-label={regionGroupLabel(region, ordinal, total, path)}
      data-mr-region={`${fileIndex}:${region.id}`}
      onFocus={onActivate}
      onMouseDown={onActivate}
      className={`flex flex-wrap items-center gap-1 px-1 py-1 ${
        active ? 'bg-gray-100 dark:bg-gray-900' : ''
      }`}
    >
      <span className={`mr-1 text-[11px] font-medium ${role == null ? '' : INK_CLASS[role]}`}>
        {stateWord(region, slot)}
      </span>
      {sideTakes &&
        allows('ours') &&
        button('ours', slot.kind === 'left', labels.left, <AcceptLeftIcon size={13} />, 'ours')}
      {sideTakes &&
        allows('theirs') &&
        button('theirs', slot.kind === 'right', labels.right, <AcceptRightIcon size={13} />, 'theirs')}
      {allows('both_ours_first') &&
        button(
          'both',
          slot.kind === 'both-lr' || slot.kind === 'both-rl',
          slot.kind === 'both-rl' ? labels.bothRl : labels.bothLr,
          <AcceptBothIcon size={13} />,
          slot.kind === 'both-rl' ? 'both_theirs_first' : 'both_ours_first',
        )}
      {/* ⚠ THE ORDER IS A SEPARATE CONTROL THAT SAYS WHICH ORDER IT IS. Two icons differing only
          in which arrow enters first are the same picture at 13px, and a `title` carrying the
          real distinction is hover-only. So the order rides visible text. */}
      {(slot.kind === 'both-lr' || slot.kind === 'both-rl') &&
        allows('both_theirs_first') &&
        button(
          'swap',
          false,
          labels.swap,
          <SwapOrderIcon size={13} />,
          slot.kind === 'both-lr' ? 'both_theirs_first' : 'both_ours_first',
          slot.kind === 'both-lr' ? 'Yours first' : `${baseRef} first`,
        )}
      {wandOffered &&
        button('wand', slot.kind === 'wand', WAND_LABEL, <WandIcon size={13} />, 'disjoint_merge')}
      {allows('base') &&
        button('ignore', slot.kind === 'ignored', labels.ignore, <IgnoreHunkIcon size={13} />, 'base')}
      {/* ⚠ THE ONE PAID CONTROL ON THIS SCREEN, and the only one that is not a decision: it asks,
          it does not apply. Nothing enters the reader's decisions until they press "Use this" on
          the suggestion the centre cell then shows. `SparkleIcon` because a model produced it —
          `WandIcon` beside it is the DETERMINISTIC word merge, which is free, and the two marks
          must not be swapped. */}
      {onAskClaude != null && region.kind === 'conflict' && (
        <button
          type="button"
          tabIndex={tab}
          disabled={askInFlight === true}
          title={ASK_LABEL}
          aria-label={ASK_LABEL}
          onClick={() => {
            onActivate();
            onAskClaude();
          }}
          className={`${BTN} disabled:opacity-60`}
        >
          <SparkleIcon size={13} />
          <span>{askInFlight === true ? 'Asking…' : 'Ask Claude'}</span>
        </button>
      )}
      {/* ⚠ NOT A DECISION, LIKE "Ask Claude" BESIDE IT — it opens a box, and the region stays
          exactly as it was until the reader presses Save. So it does NOT go through `onDecide`
          (which would also refuse it: `'edited'` is deliberately absent from `region.allowed`,
          being a session fact rather than a model one) and it carries `aria-expanded` rather
          than `aria-pressed`, because what it toggles is a panel, not a state of the region.
          It sits LAST among the verbs and before Undo: the side takes and the wand are what
          most regions need, and this is the way out when none of them fits. */}
      {onEdit != null && (
        <button
          type="button"
          tabIndex={tab}
          aria-expanded={editOpen === true}
          title={labels.edit}
          aria-label={labels.edit}
          onClick={() => {
            onActivate();
            onEdit();
          }}
          className={editOpen === true ? BTN_ON : BTN}
        >
          <PencilIcon size={13} />
          <span>{EDIT_REGION}</span>
        </button>
      )}
      {slot.kind !== 'unapplied' &&
        button('undo', false, labels.undo, <UndoIcon size={13} />, null)}
    </div>
  );
}

/** Named here rather than in `copy.ts` because it is the per-region form of the toolbar's
 *  sentence: the toolbar's wand does the file, this one does this region. */
const WAND_LABEL = 'Merge both edits — they don’t overlap';

/** ⚠ IT NAMES WHAT HAPPENS NEXT, not what it produces. The button asks; the reader decides. */
const ASK_LABEL = 'Ask Claude to merge this change';
