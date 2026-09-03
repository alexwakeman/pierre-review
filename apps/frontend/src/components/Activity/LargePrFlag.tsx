import { WarningIcon } from '../Icons.js';
import { largePrFlag } from '../../lib/ui.js';
import { useLargePrThreshold } from '../../hooks/useLargePr.js';
import type { PrCodeLocFields } from '../../hooks/useLargePr.js';

// The large-PR flag as rendered on every REACT surface: the Feed's PR-ref line, the Pending
// board's `PrMetaRow`, and the PR-detail header. (The vis-timeline is the exception — its bars
// are raw HTML strings, so the flag goes in `Timeline/prBar.ts`'s tooltip via the same
// `largePrFlag` resolver.)
//
// SUBTLE, and the restraint is the point: this is INFORMATION, not an error. A muted amber
// 11px icon and a small line of text — no filled badge, no border, no red. A big PR is a
// perfectly normal thing for a person to have opened.
//
// ⚠ IT RENDERS NOTHING unless `largePrFlag` returns a verdict, and that function returns null
// for BOTH "not large" and "we never measured it" (see lib/ui.ts for the three data traps).
// There is deliberately no "unknown" chrome and no "small PR" affordance — a reader must not be
// able to tell an unmeasured PR from a small one, because we cannot.
export function LargePrFlag({
  pr,
  className = '',
  /** Drop the visible text and keep only the icon + its accessible label — for rows too tight
   *  to spend a dozen characters on. The NUMBER survives either way, in the title/label. */
  iconOnly = false,
}: {
  pr: PrCodeLocFields;
  className?: string;
  iconOnly?: boolean;
}): JSX.Element | null {
  const threshold = useLargePrThreshold();
  const flag = largePrFlag(pr, threshold);
  if (flag == null) return null;
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 text-[11px] text-amber-600/90 dark:text-amber-500/80 ${className}`}
      title={flag.label}
    >
      <WarningIcon size={11} className="inline-block align-[-0.1em]" />
      {/* The sentence — with the count and the threshold in it — is the accessible name; the
          compact text beside it is a visual shorthand and would otherwise be read twice. */}
      <span className="sr-only">{flag.label}</span>
      {!iconOnly && <span aria-hidden="true">{flag.short}</span>}
    </span>
  );
}
