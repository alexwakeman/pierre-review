import type { ReactNode } from 'react';
import type { StoredSynthesis } from '@pierre-review/shared';
import { useMe, useProCapabilities } from '../../hooks/useTriage.js';
import { useAiUsage } from '../../hooks/useAiUsage.js';
import {
  useGenerateSynthesis,
  useSynthesis,
  useSynthesisGenerating,
  type SynthesisDescriptor,
} from '../../hooks/useSynthesis.js';

// The synthesis VERDICT card (plan P2.1 / D4) — mounted by the drill-down surfaces (P2.2) and the
// Measure "What they're flagging" card (P2.3). Contract with its host surface:
//
//  - `children` is the host's own receipt list (collapsed or full — the host decides). It is
//    ALWAYS rendered, whatever the synthesis state: a failed or absent synthesis renders NOTHING
//    EXTRA and the deterministic list stays primary (§8.20). The card never wraps the list in a
//    gate that could lose it.
//  - Every rendered number is SERVER-COMPUTED (D4): the "<count> <label>" cluster lines take
//    `cluster.count` (|validated itemIds|), the remainder line takes `remainderCount`, and the
//    coverage line takes analyzed/total — nothing here counts, sums or re-derives.
//  - Free-tier posture: capability off + cloud → the Pro chip and a one-line nudge; capability
//    off + OSS/local → null (absence, never an error) — the DetectedReviewersTable cost-nudge
//    precedent. Nothing is fetched either way (useSynthesis gates on `activityDigest`).
//  - Staleness is PASSIVE: the GET's `stale` flag renders a badge + Regenerate; nothing
//    regenerates on its own (the annotations staleness model).
//
// Two mounts of one scope share the generate mutation key (useSynthesisGenerating — the
// CiAnalysisCard lesson), so `busy` here survives a tab switch mid-run and cannot invite a second
// billed POST.

function ClusterLines({ synthesis }: { synthesis: StoredSynthesis }): JSX.Element {
  return (
    <div className="mt-2 space-y-1">
      {synthesis.clusters.map((c, i) => (
        <div key={`${i}-${c.label}`} className="flex items-baseline gap-2 text-[12px]">
          <span className="shrink-0 tabular-nums font-semibold text-gray-800 dark:text-gray-100">
            {c.count.toLocaleString()}
          </span>
          <span className="min-w-0 flex-1 text-gray-700 dark:text-gray-200">{c.label}</span>
          {c.configFixable && (
            <span
              className="shrink-0 rounded bg-amber-500/10 px-1 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400"
              title="This whole cluster looks addressable from the bot's own configuration — see the Advisor for an evidence-backed change. A hint, never an action."
            >
              config-fixable
            </span>
          )}
        </div>
      ))}
      {synthesis.remainderCount > 0 && (
        <div className="flex items-baseline gap-2 text-[12px] text-gray-400">
          <span className="shrink-0 tabular-nums">{synthesis.remainderCount.toLocaleString()}</span>
          <span>more without a recurring pattern</span>
        </div>
      )}
    </div>
  );
}

function CoverageLine({ synthesis }: { synthesis: StoredSynthesis }): JSX.Element {
  return (
    <div className="mt-2 border-t border-violet-200/50 pt-1.5 text-[10px] text-gray-400 dark:border-violet-900/40">
      Summarised {synthesis.analyzedCount.toLocaleString()} of{' '}
      {synthesis.totalCount.toLocaleString()} item{synthesis.totalCount === 1 ? '' : 's'}
      {synthesis.truncated ? ' (the newest — items beyond the cap were not analysed)' : ''}.
      Generated {new Date(synthesis.generatedAt).toLocaleString()}.
    </div>
  );
}

export function SynthesisCard({
  workspaceId,
  descriptor,
  title = 'What this adds up to',
  className,
  children,
}: {
  workspaceId: number | null;
  descriptor: SynthesisDescriptor;
  title?: string;
  className?: string;
  /** The host surface's receipt list — ALWAYS rendered, synthesis or not (§8.20). */
  children?: ReactNode;
}): JSX.Element | null {
  const { activityDigest } = useProCapabilities();
  const isCloud = useMe().data?.deploymentMode === 'cloud';

  const query = useSynthesis(workspaceId, descriptor, activityDigest);
  const generate = useGenerateSynthesis(workspaceId, descriptor);
  const busy = useSynthesisGenerating(workspaceId, descriptor);
  const usage = useAiUsage(activityDigest);
  const outOfCredits =
    usage.data?.summaryTurnLimit != null && (usage.data.summaryTurnsRemaining ?? 0) <= 0;

  // Capability off: OSS renders the list alone (absence, never an error); cloud renders the one
  // Pro nudge above it.
  if (!activityDigest) {
    if (!isCloud) return children == null ? null : <>{children}</>;
    return (
      <>
        <p className="mb-2 text-[10px] text-gray-400">
          <span className="mr-1 rounded bg-violet-500/15 px-1 text-[10px] font-semibold text-violet-600 dark:text-violet-300">
            Pro
          </span>
          Summaries of what this list adds up to are part of Pro — upgrade to get a clustered
          verdict above the receipts.
        </p>
        {children}
      </>
    );
  }

  const resp = query.data;
  const synthesis = resp?.enabled ? (resp.synthesis ?? null) : null;
  // The plugin tier is off server-side (enabled:false), or the read failed: nothing extra — the
  // deterministic list stays primary (§8.20).
  if (query.isError || (resp != null && !resp.enabled)) {
    return children == null ? null : <>{children}</>;
  }

  const generateNotice = generate.data?.throttled
    ? 'A summary is already generating — showing the latest shortly.'
    : generate.data?.creditsExhausted
      ? 'Out of AI credits this month — the summary resumes on the 1st.'
      : generate.data?.empty
        ? 'Nothing to summarise in this scope yet.'
        : null;

  return (
    <>
      <div
        className={`rounded-lg border border-violet-200 bg-violet-50/40 p-3 dark:border-violet-900/60 dark:bg-violet-950/20 ${className ?? ''}`}
        data-testid="synthesis-card"
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-gray-800 dark:text-gray-100">{title}</span>
          <span className="shrink-0 rounded bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-600 dark:text-violet-300">
            Pro
          </span>
          {synthesis && resp?.stale && (
            <span
              className="shrink-0 rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400"
              title="The items below have changed since this summary was generated — the counts still describe the set it was computed over."
            >
              stale
            </span>
          )}
          <button
            type="button"
            onClick={() => generate.mutate()}
            disabled={busy || outOfCredits || workspaceId == null}
            className="ml-auto rounded bg-violet-600 px-2.5 py-0.5 text-[11px] font-semibold text-white hover:bg-violet-500 disabled:opacity-50"
            title={
              outOfCredits
                ? 'Out of AI credits — resets next month'
                : 'Group this list into recurring clusters (runs the Haiku model; unchanged items cost nothing)'
            }
          >
            {busy ? 'Summarising…' : synthesis ? '↻ Regenerate' : 'Summarise'}
          </button>
        </div>

        {generate.isError && (
          <div className="mt-1.5 text-[11px] text-red-500">
            {(generate.error as Error)?.message ?? 'Couldn’t generate the summary.'}
          </div>
        )}
        {!generate.isError && generateNotice && (
          <div className="mt-1.5 text-[11px] text-gray-400">{generateNotice}</div>
        )}
        {outOfCredits && (
          <div className="mt-1.5 text-[11px] text-amber-600 dark:text-amber-400">
            Out of AI credits this month — any existing summary still shows.
          </div>
        )}

        {synthesis ? (
          <div key={synthesis.generatedAt} className="digest-fade-in">
            <ClusterLines synthesis={synthesis} />
            <CoverageLine synthesis={synthesis} />
          </div>
        ) : busy ? (
          <div className="mt-2 h-12 animate-pulse rounded bg-violet-500/5" />
        ) : (
          <p className="mt-1 text-[11px] text-gray-400">
            No summary yet — Summarise groups this list into recurring clusters, with every count
            computed from the items themselves.
          </p>
        )}
      </div>
      {children}
    </>
  );
}
