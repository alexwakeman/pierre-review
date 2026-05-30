import type { User } from '@gh-team-monitor/shared';
import { profileUrl, userLabel } from '../lib/ui.js';

/**
 * A contributor's display name, rendered as a link to their GitHub profile when
 * we know their login. Falls back to plain text for unknown / id-only actors.
 * `stopPropagation` keeps a click on the name from also triggering a parent
 * row/PR selection handler.
 */
export function UserName({
  user,
  fallbackId,
  className,
}: {
  user: User | undefined;
  fallbackId: number | null;
  className?: string;
}): JSX.Element {
  const label = userLabel(user, fallbackId);
  if (!user?.githubLogin) {
    return <span className={className}>{label}</span>;
  }
  return (
    <a
      href={profileUrl(user.githubLogin)}
      target="_blank"
      rel="noreferrer noopener"
      onClick={(e) => e.stopPropagation()}
      title={`@${user.githubLogin} on GitHub`}
      className={[className, 'hover:underline'].filter(Boolean).join(' ')}
    >
      {label}
    </a>
  );
}
