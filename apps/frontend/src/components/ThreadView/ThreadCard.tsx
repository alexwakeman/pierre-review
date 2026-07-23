import type { ThreadDetail, User } from '@pierre-review/shared';
import { StateBadge } from '../StateBadge.js';
import { ConfidenceBadge } from '../ConfidenceBadge.js';
import { AddressedCheckControl } from '../AddressedCheck.js';
import { ShowOnTimeline } from '../ShowOnTimeline.js';
import { CommentBlock } from './CommentBlock.js';
import { CodeAnchor } from './CodeAnchor.js';
import { MarkThreadDone } from './MarkThreadDone.js';
import { ResolveThread } from './ResolveThread.js';
import { ReplyComposer } from './ReplyComposer.js';
import { ThreadAssessment } from './ThreadAssessment.js';
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
        {!thread.isResolved && (
          <AddressedCheckControl kind="thread" targetId={thread.id} />
        )}
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

      {/* Pro (prSummary): a critical, retained AI second opinion on this thread's originating
          comment, with the thread + diff as context. Sits above the reply box — read it, then
          decide what to do (and reply inline). Renders nothing without the capability. */}
      <ThreadAssessment threadId={thread.id} diffHunk={anchorHunk} />

      <div className="mt-2 space-y-1.5 pl-2 text-[11px]">
        <ReplyComposer prId={thread.prId} threadId={thread.id} />
        <div>
          <a
            href={thread.url ?? `${prUrl}/files`}
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
