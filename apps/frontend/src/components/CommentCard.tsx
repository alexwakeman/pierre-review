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
  return <Monogram label={label} size={size} />;
}

/**
 * The no-avatar fallback: initials on a VISIBLE tone circle, tinted per person (a hue hashed from
 * the name, low alpha, so it reads on both themes and the ink keeps its contrast). ONE initial
 * below 24px — two bold letters in a 14px circle spilled out of it and ran into the name
 * ("MOMorgan Diaz"). Two only from 24px. Decorative: the name beside it (or the `title`) says who.
 */
export function Monogram({ label, size = 24 }: { label: string; size?: number }): JSX.Element {
  const letters = (size < 24 ? label.slice(0, 1) : label.slice(0, 2)).toUpperCase();
  let h = 0;
  for (let i = 0; i < label.length; i++) h = (h * 31 + label.charCodeAt(i)) % 360;
  return (
    <span
      aria-hidden
      title={label}
      className="flex shrink-0 select-none items-center justify-center overflow-hidden rounded-full bg-ui-sel text-meta font-semibold leading-none text-ui-ink"
      style={{ width: size, height: size, backgroundImage: `linear-gradient(hsl(${h} 45% 55% / 0.28), hsl(${h} 45% 55% / 0.28))` }}
    >
      {letters}
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
      <div className="min-w-0 flex-1 rounded-ui bg-ui-surface">
        <div className="flex min-w-0 items-center gap-2 px-3 pt-1.5 text-meta">
          <span className="min-w-0 truncate whitespace-nowrap">
            <UserName
              user={user}
              fallbackId={comment.authorId}
              repoId={repoId}
              className="font-semibold"
            />
          </span>
          <span className="shrink-0 whitespace-nowrap text-ui-faint">{relativeTime(comment.createdAt)}</span>
        </div>
        <div className="px-3 py-2">
          <Markdown>{comment.body}</Markdown>
        </div>
      </div>
    </div>
  );
}
