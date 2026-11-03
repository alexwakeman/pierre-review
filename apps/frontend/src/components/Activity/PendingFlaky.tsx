import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { CiFlakySummary, PrDetail } from '@pierre-review/shared';
import { api } from '../../api/client.js';
import { useRerunCi } from '../../hooks/useCiRerun.js';
import { DETAIL_GC_TIME } from '../../hooks/usePr.js';
import { distinctRunIds } from '../CheckList.js';
import { FLAKY_CHIP_CLASS, flakyCountLabel, flakyTitle } from '../FlakyChecks.js';

// THE PENDING CARD'S FLAKY LINE AND RE-RUN (docs/MERGE-CI-TRUNK.md § Flaky checks). Rendered on the
// red-build cards only (ci_failing 'your_pr', my_turn `own_ci_red`), from the card's `ciFlaky`.

/** The Pending card's line: "Flaky" (one) or "2 flaky", then the names; the tooltip says why. */
export function PendingFlakyLine({ flaky }: { flaky: CiFlakySummary }): JSX.Element {
  const title = flaky.checks.map((c) => `${c.name}: ${flakyTitle(c.reasons)}`).join('\n');
  return (
    <div className="mt-1.5 flex min-w-0 items-center gap-1.5 text-meta text-ui-mute" title={title}>
      <span className={FLAKY_CHIP_CLASS} data-testid="flaky-chip">
        {flakyCountLabel(flaky.checks.length)}
      </span>
      <span className="min-w-0 truncate">{flaky.checks.map((c) => c.name).join(', ')}</span>
    </div>
  );
}

/**
 * "Re-run failed jobs" on the Pending card — the Checks tab's re-run (`useRerunCi`, the same route
 * and mutation, so the server settles the PR and the SPA refetches via `invalidateAfterPrWrite`).
 *
 * ⚠ NOTHING FETCHES ON MOUNT. The card holds check NAMES, not Actions run ids, so the click reads
 * the PR's checks first (the PR pane's own `['pr', id]` query, fresh), then re-runs the failed jobs
 * of each failing run. A failing check outside GitHub Actions has no run to re-run: the reader is
 * told so, nothing is sent. The caller hides this unless `flakyRerunOffered`.
 */
export function PendingFlakyRerun({ prId, className }: { prId: number; className: string }): JSX.Element {
  const qc = useQueryClient();
  const rerun = useRerunCi(prId);
  const [reading, setReading] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const busy = reading || rerun.isPending;

  const onClick = async (): Promise<void> => {
    setNote(null);
    setReading(true);
    let pr: PrDetail;
    try {
      pr = await qc.fetchQuery<PrDetail>({
        queryKey: ['pr', prId],
        queryFn: () => api.pr(prId),
        staleTime: 0,
        gcTime: DETAIL_GC_TIME,
      });
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Couldn't read the checks.");
      return;
    } finally {
      setReading(false);
    }
    const runIds = distinctRunIds(pr.checkRuns, true);
    if (runIds.length === 0) {
      setNote('These checks do not run on GitHub Actions. Re-run them on GitHub.');
      return;
    }
    rerun.mutate(
      { runIds, mode: 'failed' },
      { onSuccess: (o) => setNote(o.failed > 0 ? `Re-run requested. ${o.failed} couldn't be re-run.` : 'Re-run requested.') },
    );
  };

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button
        type="button"
        disabled={busy}
        onClick={(e) => {
          e.stopPropagation();
          void onClick();
        }}
        className={className}
        title="Re-run only the failed jobs. Every failing check here is flaky."
      >
        {busy ? 'Requesting…' : 'Re-run failed jobs'}
      </button>
      {note != null && !busy && <span className="text-meta text-ui-mute">{note}</span>}
      {rerun.isError && !busy && (
        <span className="text-meta text-ui-danger">
          {rerun.error instanceof Error ? rerun.error.message : 'Re-run failed'}
        </span>
      )}
    </span>
  );
}
