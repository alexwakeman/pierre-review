// THE AI REVIEW ON THE PR OVERVIEW: the newest Limn review (the reader's own or a teammate's, named
// when not the reader's), its verdict, its open findings by severity, three lines of its summary, and
// a link to the AI Review tab. The words are lib/aiReviewOverview.ts.
//
// ⚠ NO REQUEST OF ITS OWN. It observes `['claude-review', prId]`, the query PrDetail's AI Review tab
// pill (`useClaudeReviewTabPill`) already keeps for this PR, with `staleTime: Infinity` so mounting it
// never triggers a refetch: it shows what the pill's read holds and updates when that does.
// Hidden when AI is off (`me.ai.enabled`, the caller's `enabled`) or there is no finished review.
import { useQuery } from '@tanstack/react-query';
import type { ClaudeReviewResponse } from '@pierre-review/shared';
import { api } from '../../api/client.js';
import { aiReviewOverview } from '../../lib/aiReviewOverview.js';
import { CLAUDE_VERDICT_LABEL } from '../../lib/claudeReviewColumn.js';
import { SEVERITY_CLASS, VERDICT_CLASS } from '../../lib/claudeReviewFollowUp.js';
import { REVIEW_CHIP } from '../../lib/reviewStyles.js';
import { dateTime, relativeTime } from '../../lib/ui.js';
import { VERDICT_PILL } from '../Activity/ClaudeReviewCell.js';
import { VerdictIcon } from '../VerdictIcon.js';

export function AiReviewOverview({
  prId,
  enabled,
  onOpen,
}: {
  prId: number;
  enabled: boolean;
  onOpen: () => void;
}): JSX.Element | null {
  const { data } = useQuery<ClaudeReviewResponse>({
    queryKey: ['claude-review', prId],
    queryFn: () => api.claudeReview(prId),
    enabled,
    staleTime: Infinity,
  });
  const m = enabled ? aiReviewOverview(data) : null;
  if (m == null) return null;
  return (
    <section
      data-testid="pr-ai-review-overview"
      aria-label="AI review"
      className="mx-4 mt-2 space-y-1.5 rounded-ui bg-ui-surface px-3 py-2 text-meta md:mx-5"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h3 className="font-semibold text-ui-ink">{m.whose ?? 'AI review'}</h3>
        {m.verdict != null && (
          <span className={`${VERDICT_PILL} ${VERDICT_CLASS[m.verdict]}`}>
            <VerdictIcon verdict={m.verdict} size={11} />
            {CLAUDE_VERDICT_LABEL[m.verdict]}
          </span>
        )}
        <span className="text-ui-mute" title={dateTime(m.at)}>
          {relativeTime(m.at)}
        </span>
        <button
          type="button"
          onClick={onOpen}
          className="hit ml-auto rounded-ui px-1.5 py-0.5 font-medium text-ui-ink underline underline-offset-2 hover:text-ui-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
        >
          Open AI Review
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {m.open === 0 ? (
          <span className="text-ui-mute">No open findings</span>
        ) : (
          <>
            {m.counts.map((c) => (
              <span key={c.severity} className={`${REVIEW_CHIP} ${SEVERITY_CLASS[c.severity]}`}>
                {c.label}
              </span>
            ))}
            {m.unlabelled > 0 && <span className={`${REVIEW_CHIP} ${SEVERITY_CLASS.nit}`}>{m.unlabelled} other</span>}
          </>
        )}
      </div>
      {m.excerpt != null && <p className="line-clamp-3 break-words text-body text-ui-ink">{m.excerpt}</p>}
    </section>
  );
}
