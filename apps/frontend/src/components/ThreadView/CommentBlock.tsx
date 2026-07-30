import type { CommentDetail, User } from '@pierre-review/shared';
import { Avatar } from '../CommentCard.js';
import { UserName } from '../UserName.js';
import { Markdown } from '../Markdown.js';
import { relativeTime } from '../../lib/ui.js';
import { NewTag } from './NewCommentHighlight.js';

// One comment in a thread conversation. The first block carries the code
// anchor (passed as `anchor`); replies are conversation only. `showLink` is an
// optional "Show on timeline" affordance (a reply navigates to its own marker —
// the thread root already has the card-header link), rendered left-aligned like
// the parent thread's.
export function CommentBlock({
  comment,
  usersById,
  repoId,
  isNew,
  anchor,
  showLink,
}: {
  comment: CommentDetail;
  usersById: Map<number, User>;
  repoId?: number;
  isNew?: boolean;
  anchor?: JSX.Element | null;
  showLink?: JSX.Element;
}): JSX.Element {
  const user = comment.authorId != null ? usersById.get(comment.authorId) : undefined;
  return (
    <div className={`pl-2 ${isNew ? 'comment-new' : ''}`}>
      <div className="flex items-center gap-2 text-xs">
        {showLink && (
          <>
            {showLink}
            <span className="text-gray-300 dark:text-gray-600">·</span>
          </>
        )}
        <Avatar user={user} size={18} />
        <UserName
          user={user}
          fallbackId={comment.authorId}
          repoId={repoId}
          className="font-semibold"
        />
        <span className="text-gray-400">{relativeTime(comment.createdAt)}</span>
        {isNew && <NewTag />}
      </div>
      {anchor && <div className="mt-1.5">{anchor}</div>}
      {/* NO annotation surface here any more. The AI "Simplified" rewrite used to sit above each
          comment body, which scattered up to five panels through one conversation; all of a
          thread's judgements now render as ONE block under the whole conversation
          (ThreadCheckOutput in ThreadCard). The "original is below, unchanged" invariant survives
          — the entire conversation is above that block — and each rewrite is sublabelled with
          whose comment it rewrites, since it is no longer adjacent to it. */}
      <div className="mt-1 text-sm">
        <Markdown>{comment.body}</Markdown>
      </div>
    </div>
  );
}
