// THE AI REVIEW ON THE PR OVERVIEW, above the Checks row: the SAME facts the Open PRs side panel
// shows (Activity/OpenPrsAiReview.tsx `DrawerAiReview`), drawn in the Overview's row layout — the
// verdict and its commit, the findings, the earlier review, CI, what was posted, when it ran, and
// the one action. It reads the same batched answers Open PRs reads (`useClaudeReviewStates`,
// `useCiReviewStates`) for this one PR, so the two never tell different stories.
//
// Hidden when AI is off (`me.ai.enabled`, the caller's `enabled`). The panel's Story check line is
// left out here: the PR header's criteria chips and the Ticket row carry the story already.
import { useMemo } from 'react';
import { useClaudeReviewStates } from '../../hooks/useClaudeReview.js';
import { useCiReviewStates } from '../../hooks/useCiReview.js';
import { DrawerAiReview } from '../Activity/OpenPrsAiReview.js';

export function PrOverviewAiReview({
  prId,
  enabled,
  onOpenReview,
  onOpenFix,
}: {
  prId: number;
  enabled: boolean;
  onOpenReview: () => void;
  onOpenFix: () => void;
}): JSX.Element | null {
  const ids = useMemo(() => [prId], [prId]);
  const { data: claudeData } = useClaudeReviewStates(ids, enabled);
  const { data: ciData } = useCiReviewStates(ids, enabled);
  if (!enabled) return null;
  const state = claudeData?.states.find((st) => st.prId === prId);
  const ciState = ciData?.states.find((st) => st.prId === prId);
  const skip = claudeData?.teamClaimSkips?.find((sk) => sk.prId === prId) ?? null;
  return (
    <DrawerAiReview
      layout="overview"
      prId={prId}
      state={state}
      ciState={ciState}
      teamClaimSkip={skip}
      ticketPills={[]}
      onOpenReview={onOpenReview}
      onOpenFix={onOpenFix}
    />
  );
}
