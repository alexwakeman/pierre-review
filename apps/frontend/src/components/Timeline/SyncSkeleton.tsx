// First-paint affordance shown over an empty timeline while the initial full
// backfill is still landing rows. PRs are committed newest-first and the board
// fills in within seconds (the timeline refetches as the sync progresses), so
// this converts the brief dead-air into visible, honest progress — no fabricated
// denominator/percentage, just the running count.
export function SyncSkeleton({ prsProcessed }: { prsProcessed: number }): JSX.Element {
  return (
    <div className="absolute inset-0 flex flex-col gap-4 overflow-hidden p-6">
      <div className="text-sm text-gray-500 dark:text-gray-400">
        Loading activity… {prsProcessed} PR{prsProcessed === 1 ? '' : 's'} so far
        <span className="text-gray-400 dark:text-gray-500"> · newest first</span>
      </div>
      <div className="flex flex-col gap-2">
        {Array.from({ length: 7 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3">
            <div className="h-3.5 w-28 shrink-0 animate-pulse rounded bg-gray-200 dark:bg-gray-700" />
            <div
              className="h-3.5 animate-pulse rounded bg-gray-100 dark:bg-gray-800"
              // Deterministic per-row widths so the shimmer looks organic without
              // re-randomising on every render.
              style={{ width: `${30 + ((i * 17) % 55)}%` }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
