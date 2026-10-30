import { useState } from 'react';
import { aiProviderName, type ThreadDetail } from '@pierre-review/shared';
import {
  CLAUDE_FINDING_LABEL,
  CLAUDE_STATE_LABEL,
  CLAUDE_VALIDITY_LABEL,
  threadPillFor,
  type ClaudeFindingPill,
  type ClaudeStatePill,
  type ClaudeThreadMarker,
  type ClaudeValidityPill,
} from '../../lib/claudeThreadMarker.js';
import { useClaudeThreadJudgements } from '../../hooks/useClaudeThreadJudgements.js';
import { StateBadge } from '../StateBadge.js';
import { ConfidenceBadge } from '../ConfidenceBadge.js';
import { ChevronIcon, PendingClaudeReviewIcon } from '../Icons.js';
import { InfoButton } from '../InfoModal.js';

// The freshest Claude judgement on a thread, worn IN PLACE OF the derived-state pill and the
// confidence marker (lib/claudeThreadMarker.ts decides when, and owns every word): TWO pills —
// is the comment right, and where does the code stand — then Claude's one-line reason under them
// (`ClaudeThreadReason`). The longer explanation opens only when the reader expands that line.

// Words first, colour second: every pill states itself in text, so the tint never carries meaning.
const VALIDITY_TONE: Record<ClaudeValidityPill, string> = {
  holds_up: 'text-ai-ink',
  partly: 'text-ai-ink',
  doesnt_hold: 'text-gray-600 dark:text-gray-300',
  unclear: 'text-gray-600 dark:text-gray-300',
};

const STATE_TONE: Record<ClaudeStatePill, string> = {
  resolved: 'border-emerald-500/40 text-emerald-700 dark:text-emerald-300',
  addressed: 'border-emerald-500/40 text-emerald-700 dark:text-emerald-300',
  partly_addressed: 'border-amber-500/40 text-amber-800 dark:text-amber-300',
  open: 'border-gray-300 text-gray-700 dark:border-gray-600 dark:text-gray-200',
};

const FINDING_TONE: Record<ClaudeFindingPill, string> = {
  addressed: 'text-emerald-700 dark:text-emerald-300',
  no_longer_applies: 'text-emerald-700 dark:text-emerald-300',
  reply_accepted: 'text-ai-ink',
  partly_addressed: 'text-amber-800 dark:text-amber-300',
  fix_later: 'text-ai-ink',
  not_addressed: 'text-ai-ink',
  pushed_back: 'text-ai-ink',
};

export function ClaudeThreadPills({
  marker,
  noInfo = false,
}: {
  marker: ClaudeThreadMarker;
  /** Leave out the ⓘ — for a pill drawn INSIDE another button (a button may not hold a button). */
  noInfo?: boolean;
}): JSX.Element {
  const by = aiProviderName(marker.provider);
  return (
    <span className="inline-flex shrink-0 items-center gap-1" data-noactivate>
      {marker.finding != null && (
        <span
          className={`inline-flex items-center gap-1 rounded-full border border-ai-border bg-ai-surface-2 px-2 py-0.5 text-meta font-medium ${FINDING_TONE[marker.finding]}`}
          data-testid="claude-thread-finding"
        >
          <PendingClaudeReviewIcon size={12} className="shrink-0 text-ai-signal" />
          {CLAUDE_FINDING_LABEL[marker.finding]}
          {marker.state == null && marker.stale && (
            <span className="text-gray-500 dark:text-gray-400">· earlier commit</span>
          )}
        </span>
      )}
      {marker.validity != null && (
        <span
          className={`inline-flex items-center gap-1 rounded-full border border-ai-border bg-ai-surface-2 px-2 py-0.5 text-meta font-medium ${VALIDITY_TONE[marker.validity]}`}
          data-testid="claude-thread-validity"
        >
          <PendingClaudeReviewIcon size={12} className="shrink-0 text-ai-signal" />
          {CLAUDE_VALIDITY_LABEL[marker.validity]}
          {marker.state == null && marker.stale && (
            <span className="text-gray-500 dark:text-gray-400">· earlier commit</span>
          )}
        </span>
      )}
      {marker.state != null && (
        <span
          className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-meta font-medium ${STATE_TONE[marker.state]}`}
          data-testid="claude-thread-state"
        >
          {marker.validity == null && marker.finding == null && (
            <PendingClaudeReviewIcon size={12} className="shrink-0 text-ai-signal" />
          )}
          {CLAUDE_STATE_LABEL[marker.state]}
          {marker.stale && <span className="text-gray-500 dark:text-gray-400">· earlier commit</span>}
        </span>
      )}
      {!noInfo && (
        <InfoButton title={`${by}’s judgement`}>
          {/* No run kind or date: a Check threads run re-judges only the threads that changed, so
              a judgement carried from the review would be credited to the wrong run. The commit is
              the judgement's own. */}
          <p>
            From {by}, at commit <code className="font-mono">{marker.assessedAtHead.slice(0, 7)}</code>.
          </p>
          {marker.stale && <p>The pull request has new commits since.</p>}
          {marker.finding != null ? (
            <p>
              {by} posted this comment. The pill says what the latest review that checked it
              found: in the code, or in a reply on the thread. Resolved is GitHub’s own state.
            </p>
          ) : marker.state != null ? (
            <p>
              {marker.validity != null
                ? 'The first pill says whether the comment holds up. The second says where the code stands: '
                : 'The pill says where the code stands: '}
              Resolved is GitHub’s own state; Addressed, Partly addressed and Open are {by}’s
              reading of the code.
            </p>
          ) : (
            <p>The pill says whether the comment holds up. {by} did not check the code for this one.</p>
          )}
          <p className="text-gray-500 dark:text-gray-400">
            Shown instead of “Likely addressed”, which only checks whether a later commit touched
            the file.
          </p>
        </InfoButton>
      )}
    </span>
  );
}

/**
 * A thread's state pill(s), wherever a thread is shown: the Claude pills when a Claude run judged
 * it, else the derived-state pill (+ the confidence marker on "Likely addressed" when
 * `withConfidence`). The judgements come from ONE batched read for every PR on screen.
 */
export function ThreadStatePill({
  thread,
  withConfidence = false,
  noInfo = false,
}: {
  thread: Pick<
    ThreadDetail,
    'id' | 'prId' | 'derivedState' | 'addressedConfidence' | 'addressedReason'
  >;
  withConfidence?: boolean;
  noInfo?: boolean;
}): JSX.Element {
  const judgements = useClaudeThreadJudgements(thread.prId);
  const pill = threadPillFor(thread, judgements);
  if (pill.kind === 'claude') return <ClaudeThreadPills marker={pill.marker} noInfo={noInfo} />;
  return (
    <>
      <StateBadge state={thread.derivedState} />
      {withConfidence && thread.derivedState === 'likely_addressed' && (
        <ConfidenceBadge confidence={thread.addressedConfidence} reason={thread.addressedReason} />
      )}
    </>
  );
}

/**
 * Claude's ONE-LINE reason under the pills; the longer explanation only once expanded. Renders
 * nothing when the thread has no Claude judgement, or the judgement carries neither.
 */
export function ClaudeThreadReason({
  thread,
}: {
  thread: Pick<ThreadDetail, 'id' | 'prId' | 'derivedState'>;
}): JSX.Element | null {
  const judgements = useClaudeThreadJudgements(thread.prId);
  const pill = threadPillFor(thread, judgements);
  const [open, setOpen] = useState(false);
  if (pill.kind !== 'claude') return null;
  const { reason, explanation } = pill.marker;
  if (reason == null && explanation == null) return null;
  const more = explanation != null && explanation.trim() !== '' && explanation.trim() !== reason;
  return (
    <div
      className="mb-2 text-meta text-gray-700 dark:text-gray-300"
      data-testid="claude-thread-reason"
    >
      <div className="flex items-start gap-1">
        <span className="min-w-0 flex-1">{reason ?? `${aiProviderName(pill.marker.provider)}’s explanation`}</span>
        {more && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="hit inline-flex shrink-0 items-center gap-0.5 rounded-ui px-1 text-meta text-sky-700 hover:bg-sky-50 dark:text-sky-300 dark:hover:bg-sky-950/40"
          >
            {open ? 'Less' : 'More'}
            <ChevronIcon dir={open ? 'up' : 'down'} size={10} />
          </button>
        )}
      </div>
      {open && more && <p className="mt-1 whitespace-pre-wrap">{explanation}</p>}
    </div>
  );
}
