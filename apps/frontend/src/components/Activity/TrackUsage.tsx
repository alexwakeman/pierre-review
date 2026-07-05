import { useAiUsage } from '../../hooks/useAiUsage.js';

// AI usage, expressed in CREDITS (never dollars) for transparency. Month-to-date, split
// between the two seams that spend: SUMMARIES (cheap one-shot LLM completions — digests,
// sprint report, PR summary, CI analysis) and AGENTIC TOOLS (Agent-SDK runs — Claude
// Review, AI Fix). Covers ALL account AI spend, including work outside the watched repos.
// Mounted only when the "Track Usage" panel is open, so it fetches lazily.

function Row({ label, credits, hint }: { label: string; credits: number; hint: string }): JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <div>
        <div className="text-[12px] font-medium text-gray-700 dark:text-gray-200">{label}</div>
        <div className="text-[10px] text-gray-400">{hint}</div>
      </div>
      <div className="whitespace-nowrap text-sm font-semibold tabular-nums text-gray-800 dark:text-gray-100">
        {credits.toLocaleString()} <span className="text-[10px] font-normal text-gray-400">cr</span>
      </div>
    </div>
  );
}

export function TrackUsage(): JSX.Element {
  const { data, isLoading, isError } = useAiUsage(true);
  const monthLabel = data
    ? new Date(data.monthStart).toLocaleDateString(undefined, { month: 'long' })
    : '';

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-800 dark:bg-gray-900/40">
      <div className="mb-1 flex items-baseline gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-300">
          AI usage
        </h3>
        <span className="text-[11px] text-gray-400">
          {monthLabel ? `${monthLabel} to date · credits` : 'month to date · credits'}
        </span>
      </div>
      {isLoading ? (
        <div className="h-16 animate-pulse rounded bg-gray-100 dark:bg-gray-900/40" />
      ) : isError || !data ? (
        <div className="text-[11px] text-gray-400">Usage isn’t available.</div>
      ) : (
        <>
          <div className="divide-y divide-gray-100 dark:divide-gray-800/60">
            <Row label="Summaries" credits={data.summaryCredits} hint="digests · sprint report · analyses" />
            <Row label="Agentic tools" credits={data.agentCredits} hint="Claude Review · AI Fix" />
          </div>
          <div className="mt-1 flex items-baseline justify-between gap-3 border-t border-gray-200 pt-1.5 dark:border-gray-700">
            <div className="text-[12px] font-semibold text-gray-700 dark:text-gray-200">Total this month</div>
            <div className="whitespace-nowrap text-base font-semibold tabular-nums text-violet-600 dark:text-violet-300">
              {data.totalCredits.toLocaleString()}{' '}
              <span className="text-[10px] font-normal text-gray-400">cr</span>
            </div>
          </div>
          <div className="mt-1.5 text-[10px] text-gray-400">
            An approximate measure of model usage across everything Pierre runs for you.
          </div>
        </>
      )}
    </div>
  );
}
