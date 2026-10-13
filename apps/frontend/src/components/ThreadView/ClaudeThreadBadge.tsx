import type { ClaudeThreadAddressed, ClaudeThreadValidity, ThreadDetail } from '@pierre-review/shared';
import { threadPillFor, type ClaudeThreadMarker } from '../../lib/claudeThreadMarker.js';
import { useClaudeThreadJudgements } from '../../hooks/useClaudeThreadJudgements.js';
import { StateBadge } from '../StateBadge.js';
import { ConfidenceBadge } from '../ConfidenceBadge.js';
import { formatDate } from '../../lib/ui.js';
import { PendingClaudeReviewIcon } from '../Icons.js';
import { InfoButton } from '../InfoModal.js';

// The latest Claude review's judgement on a thread, worn IN PLACE OF the derived-state pill and the
// confidence marker (lib/claudeThreadMarker.ts decides when). The AI surface's own tokens and the
// finished-review mark keep it apart from the heuristic pills it replaces. The surface says the
// verdict; which run, the reason and the commit sit behind the ⓘ.

const VALIDITY_WORDS: Record<ClaudeThreadValidity, string> = {
  valid: 'Right',
  partly_valid: 'Partly right',
  not_valid: 'Not right',
  unclear: 'Unsure',
  not_checked: 'Not judged',
};

const ADDRESSED_WORDS: Record<ClaudeThreadAddressed, string> = {
  addressed: 'Addressed',
  partly_addressed: 'Partly addressed',
  not_addressed: 'Not addressed',
  unclear: 'Unsure',
  not_checked: 'Not judged',
};

export function ClaudeThreadBadge({ marker }: { marker: ClaudeThreadMarker }): JSX.Element {
  return (
    <span className="inline-flex shrink-0 items-center gap-0.5" data-noactivate>
      <span
        className="inline-flex items-center gap-1 rounded-full border border-ai-border bg-ai-surface-2 px-2 py-0.5 text-[11px] font-medium text-ai-ink"
        data-testid="claude-thread-badge"
      >
        <PendingClaudeReviewIcon size={12} className="shrink-0 text-ai-signal" />
        {marker.label}
        {marker.stale && <span className="text-ai-muted">· earlier commit</span>}
      </span>
      <InfoButton title="Claude review">
        <p>
          From the Claude review
          {marker.finishedAt ? ` of ${formatDate(marker.finishedAt)}` : ''}, at commit{' '}
          <code className="font-mono">{marker.assessedAtHead.slice(0, 7)}</code>.
        </p>
        {marker.stale && <p>The pull request has new commits since.</p>}
        <p>
          The comment: {VALIDITY_WORDS[marker.validity]}. The code: {ADDRESSED_WORDS[marker.addressed]}.
        </p>
        {marker.explanation && <p className="whitespace-pre-wrap">{marker.explanation}</p>}
        <p className="text-gray-500 dark:text-gray-400">
          Shown instead of “Likely addressed”, which only checks whether a later commit touched the
          file.
        </p>
      </InfoButton>
    </span>
  );
}

/**
 * A thread's state pill, wherever a thread is shown: the Claude marker when the latest review
 * judged it, else the derived-state pill (+ the confidence marker on "Likely addressed" when
 * `withConfidence`). The judgements come from ONE batched read for every PR on screen.
 */
export function ThreadStatePill({
  thread,
  withConfidence = false,
}: {
  thread: Pick<ThreadDetail, 'id' | 'prId' | 'derivedState' | 'addressedConfidence' | 'addressedReason'>;
  withConfidence?: boolean;
}): JSX.Element {
  const judgements = useClaudeThreadJudgements(thread.prId);
  const pill = threadPillFor(thread, judgements);
  if (pill.kind === 'claude') return <ClaudeThreadBadge marker={pill.marker} />;
  return (
    <>
      <StateBadge state={thread.derivedState} />
      {withConfidence && thread.derivedState === 'likely_addressed' && (
        <ConfidenceBadge confidence={thread.addressedConfidence} reason={thread.addressedReason} />
      )}
    </>
  );
}
