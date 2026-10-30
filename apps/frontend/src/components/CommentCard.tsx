import type { User } from '@pierre-review/shared';
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
      className="flex shrink-0 items-center justify-center rounded-full bg-ui-hover text-meta font-semibold text-ui-ink"
      style={{ width: size, height: size }}
    >
      {label.slice(0, 2).toUpperCase()}
    </span>
  );
}

export function CommentCard({
  comment,
  usersById,
  repoId,
}: {
  comment: { authorId: number | null; body: string; createdAt: string };
  usersById: Map<number, User>;
  repoId?: number;
}): JSX.Element {
  const user = comment.authorId != null ? usersById.get(comment.authorId) : undefined;
  return (
    <div className="flex gap-2">
      <Avatar user={user} />
      <div className="min-w-0 flex-1 rounded-ui border border-ui-line">
        <div className="flex items-center gap-2 border-b border-ui-line px-3 py-1 text-meta">
          <UserName
            user={user}
            fallbackId={comment.authorId}
            repoId={repoId}
            className="font-semibold"
          />
          <span className="text-ui-faint">{relativeTime(comment.createdAt)}</span>
        </div>
        <div className="px-3 py-2">
          <Markdown>{comment.body}</Markdown>
        </div>
      </div>
    </div>
  );
}
