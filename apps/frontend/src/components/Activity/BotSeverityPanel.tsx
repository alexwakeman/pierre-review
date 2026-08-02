import type { MlSeverity, MlSeverityCounts } from '@pierre-review/shared';
import { ML_SEVERITIES } from '@pierre-review/shared';
import { ML_CATEGORY_LABEL, ML_SEVERITY_META } from '../../lib/ui.js';
import { useBotSeverity, useMlSeverityEnabled } from '../../hooks/useMlLabels.js';

// "What are the bots actually saying?" — the high-level rollup of the ML severity/category
// labels, on the Bots ROI tab above the existing volume/effectiveness numbers.
//
// FREE TIER and NOT AI: the labels come from a small classifier the server runs in the
// background (docs/ML-SEVERITY.md), so nothing here is billed and there is no generate button.
//
// The block is a first cut on purpose — one severity bar per bot plus the category mix. What it
// must NOT do is imply completeness: enrichment is a background sweep that takes real time on a
// large history, so the header states coverage (`labelled` of `labelled + pending`) rather than
// letting a half-labelled corpus read as the whole picture.

const BAR_ORDER: MlSeverity[] = ['critical', 'major', 'minor', 'nit'];

function SeverityBar({
  counts,
  total,
}: {
  counts: MlSeverityCounts;
  total: number;
}): JSX.Element {
  if (total === 0) {
    return <div className="h-2 w-full rounded-full bg-gray-100 dark:bg-gray-800" />;
  }
  return (
    <div className="flex h-2 w-full overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800">
      {BAR_ORDER.map((s) => {
        const n = counts[s];
        if (n === 0) return null;
        const meta = ML_SEVERITY_META[s];
        return (
          <div
            key={s}
            style={{ width: `${(n / total) * 100}%`, backgroundColor: meta.color }}
            title={`${meta.label}: ${n}`}
          />
        );
      })}
    </div>
  );
}

export function BotSeverityPanel({
  workspaceId,
  repoIds,
}: {
  workspaceId: number | null;
  repoIds: number[] | null;
}): JSX.Element | null {
  const enabled = useMlSeverityEnabled();
  const { data, isLoading } = useBotSeverity(workspaceId, repoIds, enabled);

  // Not configured on this deployment (the `npx` case) → the feature does not exist here, so
  // say nothing rather than explaining an absence.
  if (!enabled) return null;
  if (isLoading || !data) return null;
  // Configured but nothing labelled yet, and nothing waiting either: there is no bot text in
  // this workspace at all. An empty chart would be noise.
  if (data.labelled === 0 && data.pending === 0) return null;

  const total = data.labelled;
  const coverage = total + data.pending > 0 ? total / (total + data.pending) : 0;
  const highFindings = data.totals.bySeverity.major + data.totals.bySeverity.critical;
  const highShare = data.totals.findings > 0 ? highFindings / data.totals.findings : 0;
  // `backend` without `modernbert-onnx` means the server answered from the marker heuristic.
  // A deployment in that state produces materially worse severities, so it is stated, not hidden.
  const fallbackOnly =
    data.backends.length > 0 && data.backends.every((b) => !b.includes('modernbert-onnx'));

  return (
    <div className="rounded-lg border border-gray-200 p-3 dark:border-gray-800">
      <div className="mb-2 flex flex-wrap items-baseline gap-2">
        <h3 className="text-sm font-semibold">What the bots are flagging</h3>
        <span
          className="text-[11px] text-gray-400"
          title="Severity and category are predicted by a small local model, not an LLM. Advisory — treat major+critical together as 'high' rather than trusting critical alone."
        >
          model-scored · advisory
        </span>
        {data.pending > 0 && (
          <span className="ml-auto text-[11px] text-gray-400 tabular-nums">
            {total.toLocaleString()} of {(total + data.pending).toLocaleString()} bot comments
            scored ({Math.round(coverage * 100)}%) — the rest are still being processed
          </span>
        )}
      </div>

      {fallbackOnly && (
        <div className="mb-2 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] text-amber-700 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
          The scoring service is running its heuristic fallback, not the trained model — these
          severities are low quality. See docs/ML-SEVERITY.md.
        </div>
      )}

      {/* Totals strip */}
      <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="rounded border border-gray-200 px-2 py-1.5 dark:border-gray-800">
          <div className="text-[10px] uppercase tracking-wide text-gray-400">Findings</div>
          <div className="text-lg font-semibold tabular-nums">
            {data.totals.findings.toLocaleString()}
          </div>
          <div className="text-[10px] text-gray-400">
            + {data.totals.summaries.toLocaleString()} walkthrough/summary
          </div>
        </div>
        <div className="rounded border border-gray-200 px-2 py-1.5 dark:border-gray-800">
          <div className="text-[10px] uppercase tracking-wide text-gray-400">
            High severity
          </div>
          <div
            className="text-lg font-semibold tabular-nums"
            style={{ color: ML_SEVERITY_META.major.color }}
          >
            {Math.round(highShare * 100)}%
          </div>
          <div className="text-[10px] text-gray-400">
            {highFindings.toLocaleString()} major or critical
          </div>
        </div>
        <div className="rounded border border-gray-200 px-2 py-1.5 dark:border-gray-800">
          <div className="text-[10px] uppercase tracking-wide text-gray-400">Nits</div>
          <div
            className="text-lg font-semibold tabular-nums"
            style={{ color: ML_SEVERITY_META.nit.color }}
          >
            {data.totals.findings > 0
              ? Math.round((data.totals.bySeverity.nit / data.totals.findings) * 100)
              : 0}
            %
          </div>
          <div className="text-[10px] text-gray-400">
            {data.totals.bySeverity.nit.toLocaleString()} trivial or optional
          </div>
        </div>
        <div className="rounded border border-gray-200 px-2 py-1.5 dark:border-gray-800">
          <div className="text-[10px] uppercase tracking-wide text-gray-400">Top topic</div>
          <div className="truncate text-lg font-semibold">
            {data.totals.byCategory[0]
              ? (ML_CATEGORY_LABEL[data.totals.byCategory[0].category] ??
                data.totals.byCategory[0].category)
              : '—'}
          </div>
          <div className="text-[10px] text-gray-400">
            {data.totals.byCategory[0]
              ? `${data.totals.byCategory[0].count.toLocaleString()} findings`
              : 'no categorised findings yet'}
          </div>
        </div>
      </div>

      {/* Per-bot severity mix */}
      <table className="w-full text-left text-xs">
        <thead className="text-[10px] uppercase tracking-wide text-gray-400">
          <tr>
            <th className="py-1 pr-2 font-medium">Bot</th>
            <th className="py-1 pr-2 text-right font-medium">Scored</th>
            <th className="w-1/3 py-1 pr-2 font-medium">Severity mix</th>
            <th className="py-1 pr-2 text-right font-medium">High</th>
            <th className="py-1 font-medium">Top categories</th>
          </tr>
        </thead>
        <tbody>
          {data.rows.map((r) => (
            <tr key={r.reviewerKey} className="border-t border-gray-100 dark:border-gray-800">
              <td className="py-1.5 pr-2 font-medium">{r.label}</td>
              <td className="py-1.5 pr-2 text-right tabular-nums text-gray-500">
                {r.labelled.toLocaleString()}
                {r.summaries > 0 && (
                  <span className="ml-1 text-[10px] text-gray-400">
                    ({r.summaries} summary)
                  </span>
                )}
              </td>
              <td className="py-1.5 pr-2">
                <SeverityBar counts={r.bySeverity} total={r.labelled} />
              </td>
              <td
                className="py-1.5 pr-2 text-right font-semibold tabular-nums"
                style={{ color: ML_SEVERITY_META.major.color }}
                title="Major + critical as a share of this bot's non-summary findings."
              >
                {Math.round(r.highShare * 100)}%
              </td>
              <td className="py-1.5">
                <span className="flex flex-wrap gap-1">
                  {r.topCategories.slice(0, 3).map((c) => (
                    <span
                      key={c.category}
                      className="rounded bg-gray-100 px-1 py-0.5 text-[10px] font-medium text-gray-500 dark:bg-gray-800 dark:text-gray-400"
                    >
                      {ML_CATEGORY_LABEL[c.category] ?? c.category} {c.count}
                    </span>
                  ))}
                  {r.topCategories.length === 0 && (
                    <span className="text-[10px] text-gray-400">—</span>
                  )}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* The legend doubles as the vocabulary key for the badges on individual comments. */}
      <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-gray-400">
        {ML_SEVERITIES.map((s) => (
          <span key={s} className="inline-flex items-center gap-1">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: ML_SEVERITY_META[s].color }}
            />
            {ML_SEVERITY_META[s].label}
          </span>
        ))}
        <span className="ml-auto">
          Summary/walkthrough comments are excluded from severity shares and category counts.
        </span>
      </div>
    </div>
  );
}
