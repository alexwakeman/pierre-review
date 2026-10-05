import { reviewedAgoLabel } from '../lib/claudeReviewColumn.js';
import { dateTime } from '../lib/ui.js';

/** "reviewed 2 days ago" beside a finished Claude review, the exact date and time on hover. ONE
 *  component for the Open PRs panel, the Pending card's Claude line and the Claude Review tab. */
export function ReviewedAgo({ at, className = 'text-xs' }: { at: string | null | undefined; className?: string }): JSX.Element | null {
  if (at == null) return null;
  return (
    <span className={`whitespace-nowrap text-ai-muted ${className}`} title={dateTime(at)}>
      {reviewedAgoLabel(at)}
    </span>
  );
}
