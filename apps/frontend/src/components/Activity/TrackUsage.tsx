import { useAiUsage } from '../../hooks/useAiUsage.js';

// AI usage, month-to-date. The two seams are metered DIFFERENTLY (see AiUsageResponse):
//  - SUMMARIES (cheap one-shot Haiku completions — digests, sprint report, insights chat, PR
//    summary, CI analysis, themes) by a monthly TURN COUNT (N summaries/month).
//  - AGENTIC TOOLS (Agent-SDK runs — Claude Review, AI Fix) by CREDITS ($ cost, shown as credits,
//    never dollars).
// Each resets at the UTC month boundary. Local mode is unmetered (null limit/allowance → no bar,
// just a running total). Mounted only when the "Track usage" panel is open, so it fetches lazily.

// The first of NEXT month (UTC) in a short human label — when the monthly budgets reset.
function resetLabel(monthStartIso: string): string {
  const d = new Date(monthStartIso);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toLocaleDateString(
    undefined,
    { month: 'short', day: 'numeric' },
  );
}

// One seam's meter: a used/limit bar when metered (limit != null), else an unmetered running
// total. `unit` is the noun ("summaries" / "cr"); `remaining` is the seam's own remaining figure.
function SeamMeter({
  label,
  hint,
  used,
  limit,
  remaining,
  unit,
  resetOn,
}: {
  label: string;
  hint: string;
  used: number;
  limit: number | null;
  remaining: number | null;
  unit: string;
  resetOn: string;
}): JSX.Element {
  const metered = limit != null;
  const exhausted = metered && (remaining ?? 0) <= 0;
  const pct = metered && limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  return (
    <div className="py-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <div className="text-[12px] font-medium text-gray-700 dark:text-gray-200">{label}</div>
          <div className="text-[10px] text-gray-400">{hint}</div>
        </div>
        <div className="whitespace-nowrap text-sm font-semibold tabular-nums text-gray-800 dark:text-gray-100">
          {used.toLocaleString()}
          {metered && <span className="text-gray-400"> / {limit.toLocaleString()}</span>}{' '}
          <span className="text-[10px] font-normal text-gray-400">{unit}</span>
        </div>
      </div>
      {metered && (
        <>
          <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
            <div
              className={`h-full rounded-full ${exhausted ? 'bg-amber-500' : 'bg-ai-signal-fill'}`}
              style={{ width: `${pct}%` }}
            />
          </div>
          <div
            className={`mt-1 text-[10px] tabular-nums ${exhausted ? 'font-medium text-amber-600 dark:text-amber-400' : 'text-gray-400'}`}
          >
            {exhausted
              ? `None left — resets ${resetOn}.`
              : `${(remaining ?? 0).toLocaleString()} ${unit} left · resets ${resetOn}`}
          </div>
        </>
      )}
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
          {monthLabel ? `${monthLabel} to date` : 'month to date'}
        </span>
      </div>
      {isLoading ? (
        <div className="h-20 animate-pulse rounded bg-gray-100 dark:bg-gray-900/40" />
      ) : isError || !data ? (
        <div className="text-[11px] text-gray-400">Usage isn’t available.</div>
      ) : (
        <>
          <div className="divide-y divide-gray-100 dark:divide-gray-800/60">
            <SeamMeter
              label="Summaries"
              hint="digests · sprint · chat · analyses"
              used={data.summaryTurnsUsed}
              limit={data.summaryTurnLimit}
              remaining={data.summaryTurnsRemaining}
              unit="summaries"
              resetOn={resetLabel(data.monthStart)}
            />
            <SeamMeter
              label="Agentic tools"
              hint="Claude Review · AI Fix"
              used={data.agentCreditsUsed}
              limit={data.agentAllowanceCredits}
              remaining={data.agentCreditsRemaining}
              unit="cr"
              resetOn={resetLabel(data.monthStart)}
            />
          </div>
          <div className="mt-1.5 text-[10px] text-gray-400">
            Summaries are counted per month; agentic tools draw from a monthly credit balance. Both
            reset on the 1st.
          </div>
        </>
      )}
    </div>
  );
}
