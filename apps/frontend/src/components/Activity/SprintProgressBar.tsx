import type { SprintProgress } from './sprintPathsModel.js';

// THIS SPRINT'S THIN PROGRESS BAR (styles: index.css `.sg-progress*`) — under the page's toolbar
// (SprintView.tsx: a sprint read, refreshing, ticket summaries, the sprint builder) and beside the
// Critical path view's "Working out the critical paths" line.
// Indeterminate (a sliding segment) for 'busy', a filled share for 'share'. Never blocks what it sits on;
// the caller positions and sizes it through `className`.

export function SprintProgressBar({
  progress,
  className,
  testId = 'sprint-progress',
}: {
  progress: SprintProgress;
  className: string;
  testId?: string;
}): JSX.Element | null {
  if (progress == null) return null;
  const share = progress.kind === 'share' ? Math.round(progress.value * 100) : null;
  return (
    <div
      role="progressbar"
      aria-label={progress.label}
      aria-valuemin={share != null ? 0 : undefined}
      aria-valuemax={share != null ? 100 : undefined}
      aria-valuenow={share ?? undefined}
      data-testid={testId}
      data-kind={progress.kind}
      className={`sg-progress overflow-hidden ${className}`}
    >
      {share != null ? (
        <div className="sg-progress-share h-full" style={{ width: `${Math.max(2, share)}%` }} />
      ) : (
        <div className="sg-progress-busy h-full" />
      )}
    </div>
  );
}
