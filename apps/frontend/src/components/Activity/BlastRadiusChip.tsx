import { useState } from 'react';
import { BlastRadiusIcon } from '../Icons.js';
import { blastRadius, type BlastPrFields, type BlastVerdict } from '../../lib/ui.js';
import { useBlastConfig } from '../../hooks/useBlastRadius.js';

// THE BLAST-RADIUS CHIP, as rendered on every React surface: the Pending board's `PrMetaRow`, the
// Feed's PR-ref line, and the PR-detail header (which passes `expandable`). The vis-timeline is
// the exception — its bars are raw HTML strings, so the same `blastRadius` resolver is called in
// `Timeline/prBar.ts` instead.
//
// ⚠ IT RENDERS NOTHING unless the resolver returns a verdict, and the resolver returns null for
// BOTH "we never measured this pull request" and "the file list was truncated, so no containment
// claim is honest". There is deliberately no "unknown" chrome — a reader must not be able to tell
// an unmeasured pull request from a low-blast one.
//
// ⚠ LOW IS A POSITIVE AFFORDANCE HERE, WHICH IS WHERE THIS DIVERGES FROM `LargePrFlag`. That one
// says nothing below its threshold, because a small PR needs no announcement. This one's whole
// product promise is the low chip — "you can push this through on a quick eyeball" is the sentence
// the feature exists to put on screen, and it is safe to say precisely because the resolver
// refuses to say it on a partial measurement.
//
// The visual language: an icon whose RING COUNT is the magnitude, plus a colour. Both encode the
// same thing on purpose — colour alone fails a reader who cannot distinguish it, and a 12px shape
// alone is easy to miss.

/** Text colour per level. Each pairing is a light shade with a dark-mode twin, measured against
 *  the page grounds by `test/textContrast.test.ts` — these are not eyeballed.
 *
 *  LOW is deliberately a calm emerald rather than the "success green" the CI dot uses: this is
 *  not a claim that anything passed, it is a claim about scope. MEDIUM is the same muted grey
 *  every other neutral metadata item on the row uses, so it recedes. HIGH borrows amber from
 *  `LargePrFlag` on purpose — the two mean "look harder" and should read as one register — and
 *  the anti-double-count rule below stops them saying it twice. */
const LEVEL_META: Record<
  BlastVerdict['level'],
  { rings: 1 | 2 | 3; className: string; word: string }
> = {
  low: { rings: 1, className: 'text-emerald-700 dark:text-emerald-400', word: 'Low' },
  medium: { rings: 2, className: 'text-gray-500 dark:text-gray-400', word: 'Medium' },
  high: { rings: 3, className: 'text-amber-600 dark:text-amber-500', word: 'High' },
};

export function BlastRadiusChip({
  pr,
  className = '',
  /** Drop the visible word and keep the icon + its accessible label — for rows too tight to
   *  spend the characters. The REASONS survive either way, in the title/label. */
  iconOnly = false,
  /** PR detail only: make the chip a button that discloses the reasons underneath. A board card
   *  must NOT be expandable — the card is a link to the pull request, and a second interactive
   *  target inside it competes with that. */
  expandable = false,
}: {
  pr: BlastPrFields;
  className?: string;
  iconOnly?: boolean;
  expandable?: boolean;
}): JSX.Element | null {
  const config = useBlastConfig();
  const [open, setOpen] = useState(false);
  const verdict = blastRadius(pr, config);
  if (verdict == null) return null;
  const meta = LEVEL_META[verdict.level];

  // ⚠ THE ANTI-DOUBLE-COUNT RULE, rendered. When SIZE is the only reason this is high, the
  // large-PR flag sitting inches away already carries the number — so the chip shows its level
  // and stops. See `BlastVerdict.volumeOnly`.
  const summary = verdict.volumeOnly
    ? meta.word
    : `${meta.word} · ${verdict.reasons[0]!.text.replace(/^Touches /, '').replace(/^Spans /, '')}`;

  const body = (
    <>
      <BlastRadiusIcon rings={meta.rings} size={12} className="inline-block align-[-0.1em]" />
      {/* The full sentence — level AND every reason — is the accessible name; the compact text
          beside it is a visual shorthand and would otherwise be read twice. */}
      <span className="sr-only">{`Blast radius: ${verdict.label}`}</span>
      {!iconOnly && <span aria-hidden="true">{summary}</span>}
    </>
  );

  const shell = `inline-flex shrink-0 items-center gap-1 text-[11px] ${meta.className} ${className}`;

  // ⚠ EXPANDING A SINGLE REASON SAYS IT TWICE. The summary above already IS that reason, so an
  // expander would open onto "1 code file in one area, with tests" under a chip reading "Low · 1
  // code file in one area, with tests". Low and medium always have exactly one reason; the
  // disclosure exists for the HIGH case, where a pull request can trip a surface, a hub, spread
  // and volume at once and the summary can only show the first.
  const worthExpanding = expandable && verdict.reasons.length > 1;

  if (!worthExpanding) {
    return (
      <span className={shell} title={verdict.label}>
        {body}
      </span>
    );
  }

  return (
    <span className="inline-flex flex-col items-start gap-0.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`${shell} rounded hover:underline`}
        aria-expanded={open}
        title={verdict.label}
      >
        {body}
      </button>
      {open && (
        <ul className="ml-4 list-disc space-y-0.5 text-[11px] text-gray-600 dark:text-gray-300">
          {/* EVERY reason, not just the headline one. This list is what makes the verdict
              AUDITABLE — the known false positive (a repo whose product IS a database schema)
              is only correctable by a reader who can see that "a database schema" is what
              decided it, and then switch that surface off in Settings. */}
          {verdict.reasons.map((r) => (
            <li key={`${r.kind}:${r.text}`}>{r.text}</li>
          ))}
        </ul>
      )}
    </span>
  );
}
