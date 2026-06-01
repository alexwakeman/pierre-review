import type { ThreadDetail, User } from '@gh-team-monitor/shared';
import { StateBadge } from '../StateBadge.js';
import { ShowOnTimeline } from '../ShowOnTimeline.js';
import { CommentBlock } from './CommentBlock.js';
import { CodeAnchor } from './CodeAnchor.js';
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
}: {
  thread: ThreadDetail;
  usersById: Map<number, User>;
  prUrl: string;
  repoId?: number;
  selected?: boolean;
  viewedSince?: string | null;
}): JSX.Element {
  const anchorHunk = thread.comments[0]?.diffHunk ?? null;

  return (
    <div
      className={`rounded-md border px-2.5 py-2 ${
        selected
          ? 'border-amber-400 bg-amber-400/5'
          : 'border-gray-200 dark:border-gray-800'
      }`}
    >
      <div className="mb-2 flex items-center gap-2 text-[11px] text-gray-400">
        <ShowOnTimeline
          prId={thread.prId}
          at={thread.createdAt}
          event={{ type: 'review_comment', refId: thread.id }}
          title="Show this thread on the timeline"
        />
        <span className="text-gray-300 dark:text-gray-600">·</span>
        {thread.line != null ? <span>line {thread.line}</span> : <span>file-level</span>}
        {thread.isOutdated && <span>· outdated</span>}
        <span className="ml-auto">
          <StateBadge state={thread.derivedState} />
        </span>
      </div>

      <div className="space-y-3">
        {thread.comments.map((c, i) => (
          <CommentBlock
            key={c.id}
            comment={c}
            usersById={usersById}
            repoId={repoId}
            isNew={isNewComment(c.createdAt, viewedSince)}
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

      <div className="mt-2 pl-2 text-[11px]">
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
  );
}
