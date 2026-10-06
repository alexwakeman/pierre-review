import type { ClaudeReviewVerdict } from '@pierre-review/shared';
import { CheckCircleIcon, CommentIcon, RequestChangesIcon } from './Icons.js';

// The glyph for a Claude review's outcome, drawn in every verdict pill (Open PRs, Pending, the
// review header, the tab label) so the outcome reads by shape as well as colour.
export function VerdictIcon({ verdict, size = 12 }: { verdict: ClaudeReviewVerdict; size?: number }): JSX.Element {
  const Icon =
    verdict === 'APPROVE' ? CheckCircleIcon : verdict === 'REQUEST_CHANGES' ? RequestChangesIcon : CommentIcon;
  return <Icon size={size} aria-hidden />;
}
