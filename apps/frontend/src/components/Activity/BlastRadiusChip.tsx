import { useState } from 'react';
import { BlastRadiusIcon } from '../Icons.js';
import { blastRadius, count, type BlastPrFields, type BlastVerdict } from '../../lib/ui.js';
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

/** The signal vector, in words. Every figure here is computed — see the note in `BlastRadiusChip`
 *  about why the whole disclosure is free. */
function BlastEvidence({ pr }: { pr: BlastPrFields }): JSX.Element | null {
  const b = pr.blast;
  if (b == null) return null;
  const parts: string[] = [
    count(b.codeFiles, 'code file', 'code files'),
    count(b.testFiles, 'test file', 'test files'),
    `${b.nonCodeFiles} docs/config`,
  ];
  const spread = `${count(b.dirs, 'directory', 'directories')} · ${count(b.subsystems, 'top-level area', 'top-level areas')}`;
  return (
    <div className="border-t border-gray-200 pt-1 text-gray-500 dark:border-gray-700 dark:text-gray-400">
      <div>{parts.join(', ')}</div>
      <div>{spread}</div>
      {/* ⚠ The line count comes from the SAME `codeLoc` the large-PR flag reads. A lower bound
          keeps its "+", because a truncated file list makes every figure above a floor too. */}
      {pr.codeLoc != null && (
        <div>
          {pr.codeLoc.toLocaleString()}
          {pr.codeLocIsLowerBound ? '+' : ''} code lines
          {b.truncated ? ' · GitHub truncated the file list, so these are minimums' : ''}
        </div>
      )}
      {/* ⚠ SAID ONLY WHEN WE LOOKED. `contentKind: null` is the case for most pull requests and
          means the diff was never read — printing "code" for it would assert something nobody
          checked. */}
      {b.contentKind != null && (
        <div>
          {b.contentKind === 'comments'
            ? 'Read from the diff: comments only'
            : b.contentKind === 'formatting'
              ? 'Read from the diff: formatting only'
              : 'Read from the diff: real code changes'}
        </div>
      )}
    </div>
  );
}

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

  // EVERY pull request expands, not only the multi-reason ones.
  //
  // ⚠ THAT IS ONLY TRUE BECAUSE THE DISCLOSURE SHOWS THE EVIDENCE, NOT JUST THE REASONS. An
  // earlier cut opened onto `reasons[]` alone, which on a single-reason pull request meant
  // reading "1 code file in one area, with tests" under a chip already saying "Low · 1 code file
  // in one area, with tests" — the same sentence twice. The signal vector underneath is what
  // makes the click worth making on every pull request.
  //
  // ⚠ FREE FOR EVERY USER, AND THAT IS A FACT ABOUT THE DATA, NOT A PRICING CHOICE: every line
  // below is computed by `blastRadius()` and `blastSignalsFor()`. No model is in this call path.
  // The Pro half of blast radius is the impact NOTE, which is a different component.
  if (!expandable) {
    return (
      <span className={shell} title={verdict.label}>
        {body}
      </span>
    );
  }

  return (
    // ⚠ `self-start`. This sits inside PR-detail's `items-center` metadata row, so without it an
    // expanded panel makes the row tall and vertically CENTRES the author line against it — the
    // line visibly drifts down the moment the reader opens the disclosure.
    <span className="inline-flex flex-col items-start gap-0.5 self-start">
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
        <div className="ml-4 flex flex-col gap-1 text-[11px] text-gray-600 dark:text-gray-300">
          <ul className="list-disc space-y-0.5">
            {/* EVERY reason, not just the headline one. This list is what makes the verdict
                AUDITABLE — the known false positive (a repo whose product IS a database schema)
                is only correctable by a reader who can see that "a database schema" is what
                decided it, and then switch that surface off in Settings. */}
            {verdict.reasons.map((r) => (
              <li key={`${r.kind}:${r.text}`}>{r.text}</li>
            ))}
          </ul>
          {/* THE EVIDENCE the verdict was computed from. Deliberately the raw counts rather than
              a restatement of the reasons: this is the half a reader checks the verdict AGAINST,
              and it is what makes the disclosure worth opening on a pull request whose reason
              list is one line long. */}
          <BlastEvidence pr={pr} />
        </div>
      )}
    </span>
  );
}
