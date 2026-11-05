// THE AI REVIEW ON THE PR OVERVIEW, a CARD of its own between "Can it land" and Checks: the SAME
// facts the Open PRs side panel shows (Activity/OpenPrsAiReview.tsx `DrawerAiReview`), drawn on the
// AI surface (the `--ai-*` tokens) with a real heading and its own label column, so it never reads
// as more of the Overview's rows — the
// verdict and its commit, the findings, the earlier review, CI, what was posted, when it ran, and
// the one action. It reads the same batched answers Open PRs reads (`useClaudeReviewStates`,
// `useCiReviewStates`) for this one PR, so the two never tell different stories.
//
// Hidden when AI is off (`me.ai.enabled`, the caller's `enabled`). The panel's Story check line is
// left out here: the PR header's criteria chips and the Ticket row carry the story already.
import { useMemo } from 'react';
import { stillOpenByName } from '@pierre-review/shared';
import { useClaudeReviewStates } from '../../hooks/useClaudeReview.js';
import { useCiReviewStates } from '../../hooks/useCiReview.js';
import { useClaudeThreadJudgements } from '../../hooks/useClaudeThreadJudgements.js';
import { stillOpenPoints, type StillOpenPoint } from '../../lib/claudeThreadMarker.js';
import { DrawerAiReview } from '../Activity/OpenPrsAiReview.js';
import { InfoButton } from '../InfoModal.js';
import { cx, FOCUS_RING, TEXT_LINK } from '../ui/index.js';

export function PrOverviewAiReview({
  prId,
  enabled,
  onOpenReview,
  onOpenFix,
  onShowThread,
}: {
  prId: number;
  enabled: boolean;
  onOpenReview: () => void;
  onOpenFix: () => void;
  /** Open one thread (PrDetail `showThread`): the "Still open" list links into it. */
  onShowThread?: (threadId: number) => void;
}): JSX.Element | null {
  const ids = useMemo(() => [prId], [prId]);
  const { data: claudeData } = useClaudeReviewStates(ids, enabled);
  const { data: ciData } = useCiReviewStates(ids, enabled);
  // The thread cards' ONE batched read (no fetch of its own): the points a Limn holds open.
  const judgements = useClaudeThreadJudgements(enabled ? prId : null);
  const stillOpen = stillOpenPoints(judgements);
  if (!enabled) return null;
  const state = claudeData?.states.find((st) => st.prId === prId);
  const ciState = ciData?.states.find((st) => st.prId === prId);
  const skip = claudeData?.teamClaimSkips?.find((sk) => sk.prId === prId) ?? null;
  return (
    <div className="mx-4 mt-3 rounded-ui border border-ai-border bg-ai-surface md:mx-5" data-testid="pr-ai-review-card">
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
    {stillOpen.length > 0 && <StillOpenList points={stillOpen} onShowThread={onShowThread} />}
    </div>
  );
}

const LINK = cx('hit inline-flex min-w-0 items-center rounded-ui text-left', TEXT_LINK, FOCUS_RING);

/**
 * "Still open (N)": every earlier point a Limn — yours or a teammate's — holds open now, each a link
 * into its thread (docs/CLAUDE-REVIEW.md § Still-open points). The one place on the Overview that
 * answers "which point is the review waiting on?".
 */
export function StillOpenList({
  points,
  onShowThread,
}: {
  points: readonly StillOpenPoint[];
  onShowThread?: (threadId: number) => void;
}): JSX.Element {
  return (
    <div className="border-t border-ai-border px-3 pb-2.5 pt-2" data-testid="pr-ai-review-still-open">
      <div className="flex items-center gap-1">
        <h4 className="m-0 text-meta font-semibold text-ui-ink">Still open ({points.length})</h4>
        <InfoButton title="Still open">
          <p>
            Earlier review comments that a Limn review found not addressed yet. Your own Limn’s and
            your teammates’ Limn reviews are both listed. The newest review of each thread decides.
          </p>
          <p>
            When a Limn review posts, it replies “Still open” on each of these threads. It reopens a
            resolved thread once at most.
          </p>
        </InfoButton>
      </div>
      <ul className="m-0 mt-1 list-none space-y-1 p-0">
        {points.map((p) => {
          const where = p.stillOpen.path ? `${p.stillOpen.path}${p.stillOpen.line != null ? `:${p.stillOpen.line}` : ''}` : 'A thread';
          return (
            <li key={p.threadId} className="text-body text-ui-ink" data-testid="pr-ai-review-still-open-item">
              {onShowThread ? (
                <button type="button" className={cx(LINK, 'font-mono text-meta')} onClick={() => onShowThread(p.threadId)}>
                  {where}
                </button>
              ) : (
                <span className="font-mono text-meta">{where}</span>
              )}
              <span className="text-meta text-ui-mute">
                {' · '}
                {stillOpenByName(p.stillOpen.by)}
                {p.stillOpen.threadResolved ? ' · resolved on GitHub' : ''}
              </span>
              {p.stillOpen.reason && <div className="text-meta text-ui-ink">{p.stillOpen.reason}</div>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
