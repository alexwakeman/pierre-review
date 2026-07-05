import { useMemo, useState } from 'react';
import type { DigestPrRef } from '@pierre-review/shared';
import { useProCapabilities } from '../../hooks/useTriage.js';
import { useSprintReport, useRefreshSprintReport } from '../../hooks/useSprintReport.js';
import { usePinnedTabs, type PinnedPr } from '../../store/pinnedTabs.js';
import { buildPrRefIndex, renderInlineMarkdown } from './prRefLinks.js';

// A Pro Haiku summary OF the Insights, pinned atop the Insights rail: headline metrics +
// prioritised, PR-linked issues, repos ranked by activity + code volume. Cost-safe: it
// only generates on an explicit Generate/Regenerate. `stale` flags that the Insights
// changed since it was written, so the lead knows to regenerate. Referenced PRs are
// clickable → the PR detail (Overview), mirroring the digest's #N refs.

function refMeta(ref: DigestPrRef): PinnedPr {
  return {
    id: ref.prId as number,
    number: ref.prNumber,
    title: ref.title ?? `#${ref.prNumber}`,
    repoFullName: ref.repoFullName,
    authorLogin: ref.authorLogin,
    authorDisplayName: null,
    authorAvatarUrl: null,
  };
}

// The report body rendered with inline `owner/name#N` PR links — the SAME presentation
// the Feed digest uses (shared prRefLinks) — plus a light markdown pass for the report's
// headers / bold headline / bullets.
function SprintReportBody({
  summary,
  prRefs,
  onOpenPr,
}: {
  summary: string;
  prRefs: DigestPrRef[];
  onOpenPr: (ref: DigestPrRef) => void;
}): JSX.Element {
  const index = useMemo(() => buildPrRefIndex(prRefs), [prRefs]);
  const lines = summary
    .split('\n')
    // Strip code-span backticks — the model sometimes wraps the PR token in them, which
    // would otherwise render as literal `…` around the inline link.
    .map((l) => l.replace(/`/g, '').replace(/\s+$/, ''))
    .filter((l) => l.trim() !== '');
  return (
    <div className="space-y-1">
      {lines.map((line, i) => {
        const header = /^#{1,6}\s+(.*)$/.exec(line);
        if (header != null)
          return (
            <div
              key={i}
              className="mt-2 text-[13px] font-semibold text-gray-800 dark:text-gray-100"
            >
              {renderInlineMarkdown(header[1] ?? '', index, onOpenPr)}
            </div>
          );
        const bullet = /^[-*]\s+(.*)$/.exec(line.trim());
        if (bullet != null)
          return (
            <div key={i} className="flex gap-1.5 text-[13px] text-gray-700 dark:text-gray-200">
              <span aria-hidden className="select-none text-gray-400">
                •
              </span>
              <span className="min-w-0">
                {renderInlineMarkdown(bullet[1] ?? '', index, onOpenPr)}
              </span>
            </div>
          );
        return (
          <div
            key={i}
            className="text-[13px] leading-relaxed text-gray-700 dark:text-gray-200"
          >
            {renderInlineMarkdown(line, index, onOpenPr)}
          </div>
        );
      })}
    </div>
  );
}

export function SprintReportCard(): JSX.Element | null {
  const { activityDigest } = useProCapabilities();
  const openPrDetailTab = usePinnedTabs((s) => s.openPrDetailTab);
  const { data, isLoading } = useSprintReport(activityDigest);
  const refresh = useRefreshSprintReport();
  const [collapsed, setCollapsed] = useState(false);

  // The AI digest capability is the gate (the report shares the digest's Haiku seam +
  // cost throttle). Absent → render nothing, exactly like the digest banner.
  if (!activityDigest) return null;

  const report = data?.report ?? null;
  const busy = refresh.isPending;

  return (
    <div className="rounded-lg border border-violet-200 bg-violet-50/40 p-3 dark:border-violet-900/60 dark:bg-violet-950/20">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className="flex items-center gap-1.5 text-sm font-semibold text-gray-700 dark:text-gray-200"
        >
          <span className="w-3 select-none text-gray-400">{collapsed ? '▸' : '▾'}</span>
          Sprint report
        </button>
        <span className="rounded bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-600 dark:text-violet-300">
          Pro · AI
        </span>
        {report?.stale && (
          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
            Insights changed — regenerate
          </span>
        )}
        {report && (
          <span className="hidden text-[11px] text-gray-400 sm:inline">
            {report.model}
          </span>
        )}
        <button
          type="button"
          onClick={() => refresh.mutate()}
          disabled={busy}
          className="ml-auto rounded border border-violet-300 px-1.5 py-0.5 text-[11px] font-medium text-violet-700 hover:bg-violet-100 disabled:opacity-50 dark:border-violet-700 dark:text-violet-300 dark:hover:bg-violet-900/30"
          title="Generate a fresh sprint report from the current Insights (uses the Haiku model)"
        >
          {busy ? 'Generating…' : report ? '↻ Regenerate' : 'Generate'}
        </button>
      </div>

      {refresh.isError && (
        <div className="mt-2 text-[11px] text-red-500">
          {(refresh.error as Error)?.message ?? 'Couldn’t generate the report.'}
        </div>
      )}

      {!collapsed && (
        <div className="mt-2">
          {isLoading ? (
            <div className="h-16 animate-pulse rounded bg-violet-500/5" />
          ) : report ? (
            <>
              <SprintReportBody
                summary={report.summary}
                prRefs={report.prRefs}
                onOpenPr={(r) => openPrDetailTab(refMeta(r), { fromActivity: true })}
              />
              <div className="mt-1.5 text-[10px] text-gray-400">
                Generated {new Date(report.generatedAt).toLocaleString()}
                {report.costUsd != null && report.costUsd > 0
                  ? ` · $${report.costUsd.toFixed(4)}`
                  : ''}
              </div>
            </>
          ) : (
            <div className="text-[11px] text-gray-500 dark:text-gray-400">
              A prioritised, PR-linked summary of what needs attention this sprint —
              generated from the Insights below. Click <span className="font-medium">Generate</span>.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
