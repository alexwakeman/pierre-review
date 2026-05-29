import type { CommentDetail, User } from '@gh-team-monitor/shared';
import { Avatar } from '../CommentCard.js';
import { Markdown } from '../Markdown.js';
import { relativeTime, userLabel } from '../../lib/ui.js';
import { NewTag } from './NewCommentHighlight.js';

// One comment in a thread conversation. The first block carries the code
// anchor (passed as `anchor`); replies are conversation only.
export function CommentBlock({
  comment,
  usersById,
  isNew,
  anchor,
}: {
  comment: CommentDetail;
  usersById: Map<number, User>;
  isNew?: boolean;
  anchor?: JSX.Element | null;
}): JSX.Element {
  const user = comment.authorId != null ? usersById.get(comment.authorId) : undefined;
  return (
    <div className={`pl-2 ${isNew ? 'comment-new' : ''}`}>
      <div className="flex items-center gap-2 text-xs">
        <Avatar user={user} size={18} />
        <span className="font-semibold">{userLabel(user, comment.authorId)}</span>
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
