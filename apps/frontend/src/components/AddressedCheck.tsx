import type {
  AddressedCheck,
  AddressedCheckSummary,
  AddressedTargetKind,
  AddressedVerdict,
} from '@pierre-review/shared';
import { ADDRESSED_VERDICTS } from '@pierre-review/shared';
import { ADDRESSED_VERDICT_META } from '../lib/ui.js';
import { useProCapabilities } from '../hooks/useTriage.js';
import { useAddressedCheck, useRunAddressedCheck } from '../hooks/useAddressedCheck.js';
import { usePrAddressedCheck } from '../hooks/usePrAddressedCheck.js';

// The Pro Haiku verdict pill — ✨-marked to distinguish it from the deterministic ConfidenceBadge.
export function AddressedMarker({ check }: { check: AddressedCheck }): JSX.Element {
  const meta = ADDRESSED_VERDICT_META[check.verdict];
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold"
      style={{ backgroundColor: `${meta.color}1a`, color: meta.color }}
      title={check.rationale}
    >
      <span aria-hidden>✨</span>
      {meta.label} · {check.confidence}%
    </span>
  );
}

// Per-item control: shows the retained verdict marker if one exists, else a "Check addressed"
// button that runs the single-item Haiku check. Gated on the prSummary capability (renders null
// otherwise), exactly like ThreadAssessment.
export function AddressedCheckControl({
  kind,
  targetId,
}: {
  kind: AddressedTargetKind;
  targetId: number;
}): JSX.Element | null {
  const enabled = useProCapabilities().prSummary;
  const { data } = useAddressedCheck(kind, targetId, enabled);
  const run = useRunAddressedCheck(kind, targetId);
  if (!enabled) return null;

  const check = data?.check ?? null;
  const noAuth = data?.noAuth || run.data?.noAuth;
  const creditsExhausted = data?.creditsExhausted || run.data?.creditsExhausted;

  return (
    <span className="inline-flex items-center gap-1">
      {check && <AddressedMarker check={check} />}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          run.mutate();
        }}
        disabled={run.isPending}
        className="rounded px-1 py-0.5 text-[10px] font-medium text-violet-600 hover:bg-violet-100 disabled:opacity-50 dark:text-violet-300 dark:hover:bg-violet-900/30"
        title={
          check
            ? 'Re-check whether this was addressed (Pro)'
            : 'Ask Haiku whether the concern was actually addressed by later changes (Pro)'
        }
      >
        {run.isPending ? 'Checking…' : check ? '↻' : '✨ Check addressed'}
      </button>
      {creditsExhausted && (
        <span className="text-[10px] text-amber-600 dark:text-amber-400">out of credits</span>
      )}
      {noAuth && <span className="text-[10px] text-amber-600 dark:text-amber-400">no AI auth</span>}
    </span>
  );
}

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
