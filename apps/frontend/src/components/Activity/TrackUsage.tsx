import { useAiUsage } from '../../hooks/useAiUsage.js';

// AI usage, expressed in CREDITS (never dollars) for transparency. Month-to-date, split
// between the two seams that spend: SUMMARIES (cheap one-shot LLM completions — digests,
// sprint report, PR summary, CI analysis) and AGENTIC TOOLS (Agent-SDK runs — Claude
// Review, AI Fix). Covers ALL account AI spend, including work outside the watched repos.
// Mounted only when the "Track Usage" panel is open, so it fetches lazily.
//
// Metered plans (paid cloud) also carry an allowance (e.g. 2,500 cr/mo) → a used/allowance
// meter + a "resets on the 1st" note, and generation blocks once it's spent. Local mode is
// unmetered (allowanceCredits null → no bar).

// The first of NEXT month (UTC) in a short human label — when the monthly allowance resets.
function resetLabel(monthStartIso: string): string {
  const d = new Date(monthStartIso);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toLocaleDateString(
    undefined,
    { month: 'short', day: 'numeric' },
  );
}

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
        (() => {
          const allowance = data.allowanceCredits;
          const metered = allowance != null;
          const remaining = data.remainingCredits ?? 0;
          const exhausted = metered && remaining <= 0;
          const pct =
            metered && allowance > 0
              ? Math.min(100, Math.round((data.totalCredits / allowance) * 100))
              : 0;
          return (
            <>
              {metered && (
                <div className="mb-2">
                  <div className="flex items-baseline justify-between gap-3">
                    <div className="text-[13px] font-semibold tabular-nums text-gray-800 dark:text-gray-100">
                      {data.totalCredits.toLocaleString()}
                      <span className="text-gray-400"> / {allowance.toLocaleString()}</span>{' '}
                      <span className="text-[10px] font-normal text-gray-400">cr</span>
                    </div>
                    <div
                      className={`text-[11px] tabular-nums ${exhausted ? 'font-medium text-amber-600 dark:text-amber-400' : 'text-gray-500 dark:text-gray-400'}`}
                    >
                      {exhausted ? 'out of credits' : `${remaining.toLocaleString()} left`}
                    </div>
                  </div>
                  <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
                    <div
                      className={`h-full rounded-full ${exhausted ? 'bg-amber-500' : 'bg-violet-500'}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <div className="mt-1 text-[10px] text-gray-400">
                    {exhausted
                      ? `Out of AI credits — resets ${resetLabel(data.monthStart)}.`
                      : `digest ≈ 9 cr · sprint ≈ 10 cr · resets ${resetLabel(data.monthStart)}`}
                  </div>
                </div>
              )}
              <div className="divide-y divide-gray-100 dark:divide-gray-800/60">
                <Row label="Summaries" credits={data.summaryCredits} hint="digests · sprint report · analyses" />
                <Row label="Agentic tools" credits={data.agentCredits} hint="Claude Review · AI Fix" />
              </div>
              {!metered && (
                <div className="mt-1 flex items-baseline justify-between gap-3 border-t border-gray-200 pt-1.5 dark:border-gray-700">
                  <div className="text-[12px] font-semibold text-gray-700 dark:text-gray-200">Total this month</div>
                  <div className="whitespace-nowrap text-base font-semibold tabular-nums text-violet-600 dark:text-violet-300">
                    {data.totalCredits.toLocaleString()}{' '}
                    <span className="text-[10px] font-normal text-gray-400">cr</span>
                  </div>
                </div>
              )}
              <div className="mt-1.5 text-[10px] text-gray-400">
                An approximate measure of model usage across everything Pierre runs for you.
              </div>
            </>
          );
        })()
      )}
    </div>
  );
}
