import type { User } from '@gh-team-monitor/shared';
import { relativeTime, userLabel } from '../lib/ui.js';
import { Markdown } from './Markdown.js';
import { UserName } from './UserName.js';

export function Avatar({
  user,
  size = 24,
}: {
  user: User | undefined;
  size?: number;
}): JSX.Element {
  const label = userLabel(user, null);
  if (user?.avatarUrl) {
    return (
      <img
        src={user.avatarUrl}
        alt={label}
        width={size}
        height={size}
        className="shrink-0 rounded-full"
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-full bg-gray-300 text-[10px] font-semibold text-gray-700 dark:bg-gray-700 dark:text-gray-200"
      style={{ width: size, height: size }}
    >
      {label.slice(0, 2).toUpperCase()}
    </span>
  );
}

export function CommentCard({
  comment,
  usersById,
}: {
  comment: { authorId: number | null; body: string; createdAt: string };
  usersById: Map<number, User>;
}): JSX.Element {
  const user = comment.authorId != null ? usersById.get(comment.authorId) : undefined;
  return (
    <div className="flex gap-2">
      <Avatar user={user} />
      <div className="min-w-0 flex-1 rounded-md border border-gray-200 dark:border-gray-800">
        <div className="flex items-center gap-2 border-b border-gray-100 px-3 py-1 text-xs dark:border-gray-800">
          <UserName user={user} fallbackId={comment.authorId} className="font-semibold" />
          <span className="text-gray-400">{relativeTime(comment.createdAt)}</span>
        </div>
        <div className="px-3 py-2">
          <Markdown>{comment.body}</Markdown>
        </div>
      </div>
    </div>
  );
}
