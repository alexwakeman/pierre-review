import type { ThreadDetail, User } from '@pierre-review/shared';
import { StateBadge } from '../StateBadge.js';
import { ConfidenceBadge } from '../ConfidenceBadge.js';
import { ReviewCheckButton, ThreadCheckOutput } from '../CommentAnnotations.js';
import { MlSeverityBadge, worstSeverity } from '../MlSeverityBadge.js';
import { mlLabelKey, useMlLabelIndex, useMlSeverityEnabled } from '../../hooks/useMlLabels.js';
import { ShowOnTimeline } from '../ShowOnTimeline.js';
import { CommentBlock } from './CommentBlock.js';
import { CodeAnchor } from './CodeAnchor.js';
import { MarkThreadDone } from './MarkThreadDone.js';
import { safeExternalUrl } from '../../lib/ui.js';
import { ResolveThread } from './ResolveThread.js';
import { ReplyComposer } from './ReplyComposer.js';
import { isNewComment } from './NewCommentHighlight.js';

// A single review thread rendered conversation-first: the code it's anchored to
// sits inside the opening comment, replies follow as plain conversation.
export function ThreadCard({
  thread,
  usersById,
  prUrl,
  repoId,
  selected,
  viewedSince,
  inMyTurn = false,
  highlightCommentId,
  onOpenInPr,
}: {
  thread: ThreadDetail;
  usersById: Map<number, User>;
  prUrl: string;
  repoId?: number;
  selected?: boolean;
  viewedSince?: string | null;
  // True when this thread is in the user's My Turn set (awaiting their response);
  // shows a "Done" affordance to clear it from the queue.
  inMyTurn?: boolean;
  // When set, ONLY this comment is marked "new" (the Activity feed highlights the
  // specific comment a card represents). When null/undefined, fall back to the
  // viewedSince heuristic (the PR-detail Threads tab).
  highlightCommentId?: number | null;
  // When provided, the whole card HEADER becomes a clickable region that deep-links this thread
  // inside its PR (search results + theme drill-downs) — a large, discoverable target. The
  // header's own controls (Show-on-timeline / addressed / resolve, all <button>s) keep working
  // via a closest() guard. Inert (a plain header) when omitted.
  onOpenInPr?: () => void;
}): JSX.Element {
  const anchorHunk = thread.comments[0]?.diffHunk ?? null;
  const lineLabel = thread.line != null ? `line ${thread.line}` : 'file-level';
  // ONE shared per-PR query, whichever of the eight ThreadCard mount sites this is. React Query
  // dedupes it across every card on the same PR, and it is skipped entirely when the deployment
  // has no severity-api (npx), so an OSS install issues nothing.
  const mlEnabled = useMlSeverityEnabled();
  const mlIndex = useMlLabelIndex(thread.prId, mlEnabled);
  // The thread's WORST non-summary severity — triage without expanding the conversation.
  const threadWorst = mlIndex
    ? worstSeverity(
        thread.comments
          .map((c) => mlIndex.get(mlLabelKey('review_comment', c.id)))
          .filter((l): l is NonNullable<typeof l> => l != null),
      )
    : undefined;

  return (
    <div
      className={`rounded-md border px-2.5 py-2 ${
        selected
          ? 'border-amber-400 bg-amber-400/5'
          : 'border-gray-200 dark:border-gray-800'
      }`}
    >
      <div
        className={`mb-2 flex items-center gap-2 text-[11px] text-gray-400${
          onOpenInPr
            ? ' -mx-1 cursor-pointer rounded px-1 hover:bg-sky-50 dark:hover:bg-sky-950/20'
            : ''
        }`}
        role={onOpenInPr ? 'button' : undefined}
        tabIndex={onOpenInPr ? 0 : undefined}
        title={onOpenInPr ? 'Open this thread in its PR' : undefined}
        onClick={
          onOpenInPr
            ? (e) => {
                // Clicking anywhere on the header opens the thread in its PR — EXCEPT the header's
                // own controls (all <button>s), which keep working via the closest() guard.
                if ((e.target as HTMLElement).closest('a,button,input,textarea,[data-noactivate]'))
                  return;
                onOpenInPr();
              }
            : undefined
        }
        onKeyDown={
          onOpenInPr
            ? (e) => {
                if (e.target !== e.currentTarget) return;
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onOpenInPr();
                }
              }
            : undefined
        }
      >
        {/* State pill anchored top-LEFT on every thread card — so a resolved (or otherwise-
            stateful) thread is legible at a glance without expanding it, and all thread cards
            read uniformly. */}
        <StateBadge state={thread.derivedState} />
        {thread.derivedState === 'likely_addressed' && (
          <ConfidenceBadge
            confidence={thread.addressedConfidence}
            reason={thread.addressedReason}
          />
        )}
        {/* The worst ML severity anywhere in this conversation (summaries excluded). Renders
            nothing when no comment in the thread is labelled — which is also the state of every
            thread on a deployment with no model. */}
        <MlSeverityBadge label={threadWorst} compact />
        <ShowOnTimeline
          prId={thread.prId}
          at={thread.createdAt}
          event={{ type: 'review_comment', refId: thread.id }}
          title="Show this thread on the timeline"
        />
        <span className="text-gray-300 dark:text-gray-600">·</span>
        <span
          className={
            onOpenInPr
              ? 'font-medium text-gray-500 underline decoration-dotted underline-offset-2 dark:text-gray-400'
              : undefined
          }
        >
          {lineLabel}
        </span>
        {thread.isOutdated && <span>· outdated</span>}
        {/* Pro (prSummary): the ONE AI check, spent on this thread alone — rewrite its wall of bot
            text, sanity-check the point, and judge what is actually still open. Deliberately NOT
            gated on `!thread.isResolved`: the rewrite and the validity read are still worth having
            on a resolved thread, and the server omits the addressed judgement for one, so no extra
            judgement is billed that the PR-wide run would not have produced anyway. */}
        <ReviewCheckButton
          prId={thread.prId}
          target={{ targetKind: 'thread', targetId: thread.id }}
        />
        <span className="ml-auto flex items-center gap-2">
          {inMyTurn && <MarkThreadDone threadId={thread.id} />}
          <ResolveThread
            prId={thread.prId}
            threadId={thread.id}
            isResolved={thread.isResolved}
          />
        </span>
      </div>

      <div className="space-y-3">
        {thread.comments.map((c, i) => (
          <CommentBlock
            key={c.id}
            comment={c}
            usersById={usersById}
            repoId={repoId}
            mlLabel={mlIndex?.get(mlLabelKey('review_comment', c.id))}
            isNew={
              highlightCommentId != null
                ? c.id === highlightCommentId
                : isNewComment(c.createdAt, viewedSince)
            }
            anchor={
              i === 0 ? (
                <CodeAnchor diffHunk={anchorHunk} threadId={thread.id} />
              ) : undefined
            }
            // Replies get their own "Show" (the root is covered by the card-header
            // link above). All review-comment events share the thread's refId, so
            // navigation disambiguates the specific reply by its createdAt instant.
            showLink={
              i > 0 ? (
                <ShowOnTimeline
                  prId={thread.prId}
                  at={c.createdAt}
                  event={{ type: 'review_comment', refId: thread.id }}
                  title="Show this reply on the timeline"
                />
              ) : undefined
            }
          />
        ))}
      </div>

      {/* Pro (prSummary): the WHOLE "Check review" output for this thread, in ONE block, directly
          under the conversation — i.e. under the last reply, which is where the old standalone
          "Comment check" panel sat. The three judgements key on three different ids (a rewrite per
          comment, validity on the root comment, addressed on the thread), so they cannot be one
          <CommentAnnotations>; ThreadCheckOutput assembles them off the same shared per-PR query.
          Renders NOTHING — and issues no request of its own — when the thread has none. */}
      <ThreadCheckOutput thread={thread} usersById={usersById} />

      <div className="mt-2 space-y-1.5 pl-2 text-[11px]">
        <ReplyComposer prId={thread.prId} threadId={thread.id} />
        <div>
          <a
            href={safeExternalUrl(thread.url) ?? `${prUrl}/files`}
            target="_blank"
            rel="noreferrer noopener"
            className="text-blue-500 hover:underline"
          >
            ↗ {thread.url ? 'View thread on GitHub' : 'Reply on GitHub'}
          </a>
        </div>
      </div>
    </div>
  );
}
