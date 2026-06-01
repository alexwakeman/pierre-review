import type { CommentDetail, User } from '@gh-team-monitor/shared';
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
      <div className="mt-1 text-sm">
        <Markdown>{comment.body}</Markdown>
      </div>
    </div>
  );
}
