import { BlastRadiusIcon } from '../Icons.js';
import { blastRadius, count, type BlastPrFields, type BlastVerdict } from '../../lib/ui.js';
import { useBlastConfig } from '../../hooks/useBlastRadius.js';
import { ClickPopover } from '../InfoModal.js';

// THE BLAST-RADIUS CHIP, as rendered on every React surface: the Pending board's `PrMetaRow`, the
// Feed's PR-ref line, Open PRs, and the PR-detail header. The vis-timeline is the exception — its
// bars are raw HTML strings, so the same `blastRadius` resolver is called in `Timeline/prBar.ts`.
//
// ⚠ THE CHIP SAYS THE LEVEL AND STOPS — icon + "High" / "Medium" / "Low", never a file name or a
// reason after it, and no `title=` carrying them either. It is a button on EVERY surface: a click
// opens a popover (`ClickPopover`, the "i"s' popover) with every reason, the flagged file among
// them, and the evidence. Inside a clickable card the click is ISOLATED (stopPropagation on the
// button, `data-noactivate` on the portalled panel), so it never also opens the pull request.
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
 *  LOW and MEDIUM are grey: reach is a claim about scope, never that anything passed, and green
 *  is kept for "ready to land". HIGH borrows amber from
 *  `LargePrFlag` on purpose — the two mean "look harder" and should read as one register — and
 *  the anti-double-count rule below stops them saying it twice. */
const LEVEL_META: Record<
  BlastVerdict['level'],
  { rings: 1 | 2 | 3; className: string; word: string }
> = {
  // Low is grey ink, not green: green is reserved for "ready to land" (docs/redesign/DESIGN.md § 3).
  low: { rings: 1, className: 'text-ui-faint', word: 'Low' },
  medium: { rings: 2, className: 'text-ui-mute', word: 'Medium' },
  high: { rings: 3, className: 'text-ui-warn', word: 'High' },
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
    <div className="border-t border-ui-line pt-1.5 text-ui-mute">
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

/** A reason's text with its `path` spans set as code — the hub reason names the file it flagged. */
function ReasonText({ text }: { text: string }): JSX.Element {
  const parts = text.split('`');
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <code key={i} className="break-all font-mono text-ui-ink">
            {part}
          </code>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

/** THE POPOVER BODY: every reason (the flagged file among them) and the evidence. Exported for its
 *  test; nothing else renders it. */
export function BlastReasons({ verdict, pr }: { verdict: BlastVerdict; pr: BlastPrFields }): JSX.Element {
  return (
    <div className="flex flex-col gap-1.5" data-testid="blast-reasons">
      {/* EVERY reason, not just the headline one. This list is what makes the verdict AUDITABLE —
          the known false positive (a repo whose product IS a database schema) is only correctable
          by a reader who can see that "a database schema" is what decided it, and then switch
          that surface off in Settings. */}
      <ul className="list-disc space-y-0.5 pl-4 text-ui-ink">
        {verdict.reasons.map((r) => (
          <li key={`${r.kind}:${r.text}`}>
            <ReasonText text={r.text} />
          </li>
        ))}
      </ul>
      {/* THE EVIDENCE the verdict was computed from — the raw counts a reader checks the verdict
          AGAINST, which is what makes the click worth making on a one-reason pull request. */}
      <BlastEvidence pr={pr} />
    </div>
  );
}

/** The chip for a verdict already resolved — `BlastRadiusChip` minus the config read, so a test can
 *  render it without a query client. */
export function BlastRadiusChipView({
  verdict,
  pr,
  className = '',
  iconOnly = false,
  wordOnly = false,
}: {
  verdict: BlastVerdict;
  pr: BlastPrFields;
  className?: string;
  iconOnly?: boolean;
  wordOnly?: boolean;
}): JSX.Element {
  const meta = LEVEL_META[verdict.level];
  const phrase = `${meta.word} reach`;
  return (
    <ClickPopover
      title={phrase}
      triggerLabel={phrase}
      isolate
      testId="blast-radius-chip"
      // ⚠ THE SAME BOX AS `LargePrFlag`, which sits just before it: inline-flex, items-center,
      // gap-1, text-meta, no padding and no min-height — so the two share one height and one
      // centre line. The touch target grows through an absolutely placed ::after, never the box.
      triggerClassName={(open) =>
        `relative inline-flex shrink-0 items-center gap-1 rounded-ui text-meta ${meta.className} ${
          open ? 'underline' : 'hover:underline'
        } focus:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent touch:after:absolute touch:after:-inset-3 touch:after:content-[''] ${className}`
      }
      trigger={
        <>
          <BlastRadiusIcon rings={meta.rings} size={11} className="inline-block align-[-0.1em]" />
          {!iconOnly && <span aria-hidden="true">{wordOnly ? phrase : meta.word}</span>}
        </>
      }
    >
      <BlastReasons verdict={verdict} pr={pr} />
    </ClickPopover>
  );
}

export function BlastRadiusChip({
  pr,
  className = '',
  /** Drop the visible word and keep the icon + its accessible name — for rows too tight to spend
   *  the characters. */
  iconOnly = false,
  /** The level as one phrase, "High reach" — a Pending card's fact line, where a bare "High"
   *  beside other facts would not say what is high. */
  wordOnly = false,
}: {
  pr: BlastPrFields;
  className?: string;
  iconOnly?: boolean;
  wordOnly?: boolean;
}): JSX.Element | null {
  const config = useBlastConfig();
  const verdict = blastRadius(pr, config);
  if (verdict == null) return null;
  return <BlastRadiusChipView verdict={verdict} pr={pr} className={className} iconOnly={iconOnly} wordOnly={wordOnly} />;
}
