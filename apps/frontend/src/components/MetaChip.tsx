import type { StateMeta } from '../lib/ui.js';
import { vendorInk } from '../lib/ui.js';

/**
 * The SURVEY-ROW density of a `StateMeta` pill — a derived state, an addressed confidence, an ML
 * severity — drawn as the tinted-at-10%-opacity chip used wherever one of those records is shown
 * inline in a dense list row or table cell.
 *
 * Promoted here from `Activity/BotCommentCard.tsx`, which is where the form was designed; three
 * other survey surfaces had grown byte-equivalent copies of it (`PeopleReportDetail`'s
 * `StateChip`, `BotPrsDetail`'s inline `<span>`, `ThemeThreadsDetail`'s matched-state chips), so a
 * padding or opacity tweak had to be made in four places to hold.
 *
 * ⚠ THIS IS NOT A REPLACEMENT FOR `StateBadge`, AND THE TWO MUST NOT BE COLLAPSED INTO ONE
 * COMPONENT WITH A SIZE PROP. They are two genuine densities with two audiences: `StateBadge`
 * (rounded-full, `${color}22`, text-xs, a leading dot) is the CONVERSATION HEADER pill — one
 * thread, read at a glance, sized to sit next to a `ConfidenceBadge` and an `MlSeverityBadge` in
 * the same row; `MetaChip` is a SURVEY ROW cell, sized to disappear into a table of twenty. Merged
 * behind one `size` prop, the choice stops being about the audience and becomes whichever value
 * the next caller thinks looks nice. The de-duplication that IS worth doing is the one done here —
 * `ThreadCountChips.tsx` states the rule the same way about the deleted `ThreadDots`: "two
 * byte-identical renderers of one palette is drift waiting to happen".
 *
 * ⚠ IT ISSUES NO QUERY AND TAKES NO ID. Every caller is on the no-queries survey path
 * (`BotCommentCard.tsx`'s header rule) and hands over a `StateMeta` it already holds.
 *
 * `prefix` labels what the chip is ABOUT when the label alone would be ambiguous next to a state
 * chip (`addressed: `); `count` appends a tally for the roll-up form (`Untouched · 4`).
 */
export function MetaChip({
  meta,
  prefix,
  count,
}: {
  meta: StateMeta;
  prefix?: string;
  count?: number;
}): JSX.Element {
  return (
    <span
      className="shrink-0 rounded px-1 py-px text-[10px] font-medium tabular-nums"
      style={{ ...vendorInk(meta.color), background: `${meta.color}1a` }}
      title={meta.description}
    >
      {prefix}
      {meta.label}
      {count !== undefined && ` · ${count}`}
    </span>
  );
}
