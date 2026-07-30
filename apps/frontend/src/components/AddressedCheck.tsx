import type {
  AddressedCheckSummary,
  AddressedVerdict,
} from '@pierre-review/shared';
import { ADDRESSED_VERDICTS } from '@pierre-review/shared';
import { ADDRESSED_VERDICT_META } from '../lib/ui.js';
import { useProCapabilities } from '../hooks/useTriage.js';
import { usePrAddressedCheck } from '../hooks/usePrAddressedCheck.js';

// The PR-wide "was this addressed?" batch, and nothing else any more.
//
// The two PER-ITEM surfaces that used to live here — `AddressedMarker` (a ✨ verdict pill) and
// `AddressedCheckControl` (its "✨ Check addressed" button) — are GONE, for two different reasons
// that are worth keeping written down:
//
//  - THE BUTTON was one of several AI buttons a thread card and its list could show at once (this
//    one, ThreadAssessment's "Assess validity", and the run bar's three). They are now the single
//    "Check review" run (CommentAnnotations' ReviewCheckButton / ReviewCheckBar), which produces the
//    addressed verdict together with the rewrite and the validity read in ONE call per target.
//  - THE PILL put the model's RATIONALE in a `title` tooltip — invisible on a touch device and to
//    anyone who doesn't think to hover, and "Likely · 70%" without the reasoning is not something a
//    reader can act on. The identical chip is now the header of the `addressed` annotation panel
//    (CommentAnnotations' verdictChip), which renders the two-section "**Addressed:** / **Still
//    open:**" body inline and open by default.
//
// `usePrAddressedCheck` + this PR-wide button remain because the resolve listing
// (Activity/BotThreadsDetail) still runs the single-axis sweep across a whole PR from outside PR
// detail, where the combined bar isn't mounted.

// Compact summary of a PR-wide run (only verdicts with a nonzero count).
function SummaryChips({ summary }: { summary: AddressedCheckSummary }): JSX.Element {
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {ADDRESSED_VERDICTS.map((v: AddressedVerdict) => {
        const n = summary[v];
        if (n === 0) return null;
        const meta = ADDRESSED_VERDICT_META[v];
        return (
          <span
            key={v}
            className="rounded px-1 py-0.5 text-[10px] font-semibold tabular-nums"
            style={{ backgroundColor: `${meta.color}1a`, color: meta.color }}
          >
            {n} {meta.label.toLowerCase()}
          </span>
        );
      })}
    </span>
  );
}

// PR-wide "check all threads + PR comments" trigger (Pro). Streams one item at a time; shows live
// progress + a rollup ("can I safely resolve these?"). Reused in PR detail + the resolve listing.
export function PrAddressedCheckButton({
  prId,
  compact = false,
}: {
  prId: number;
  compact?: boolean;
}): JSX.Element | null {
  const enabled = useProCapabilities().prSummary;
  const { state, run, stop } = usePrAddressedCheck(prId);
  if (!enabled) return null;

  return (
    <span
      className="inline-flex flex-wrap items-center gap-2"
      onClick={(e) => e.stopPropagation()}
    >
      {state.running ? (
        <>
          <span className="text-[11px] text-gray-500 tabular-nums">
            Checking… {state.done}/{state.total}
          </span>
          <button
            type="button"
            onClick={stop}
            className="rounded border border-amber-400 px-1.5 py-0.5 text-[11px] font-medium text-amber-700 hover:bg-amber-100 dark:border-amber-600 dark:text-amber-300 dark:hover:bg-amber-900/30"
          >
            Stop
          </button>
        </>
      ) : (
        <button
          type="button"
          onClick={run}
          className="rounded border border-violet-400 px-1.5 py-0.5 text-[11px] font-medium text-violet-700 hover:bg-violet-100 dark:border-violet-600 dark:text-violet-200 dark:hover:bg-violet-900/30"
          title="Ask Haiku whether each unresolved thread + PR comment was actually addressed (Pro)"
        >
          {compact ? '✨ Check addressed' : '✨ Check all addressed (Pro)'}
        </button>
      )}
      {state.summary && !state.running && <SummaryChips summary={state.summary} />}
      {state.error && (
        <span className="text-[11px] text-amber-600 dark:text-amber-400">{state.error}</span>
      )}
    </span>
  );
}
