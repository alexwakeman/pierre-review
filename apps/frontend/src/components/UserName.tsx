import type { User } from '@pierre-review/shared';
import { profileUrl, userLabel } from '../lib/ui.js';
import { useMaintainersByRepo } from '../hooks/useMaintainers.js';
import { MaintainerShield } from './MaintainerShield.js';

/**
 * A contributor's display name, rendered as a link to their GitHub profile when
 * we know their login. Falls back to plain text for unknown / id-only actors.
 * `stopPropagation` keeps a click on the name from also triggering a parent
 * row/PR selection handler.
 *
 * When `repoId` is supplied and the user has merge rights in that repo (has
 * merged a PR there), a maintainer shield is appended after the name — matching
 * the badge on the timeline contributor rows.
 */
export function UserName({
  user,
  fallbackId,
  repoId,
  className,
}: {
  user: User | undefined;
  fallbackId: number | null;
  repoId?: number;
  className?: string;
}): JSX.Element {
  // Hook is called unconditionally (rules of hooks); the shared query is
  // deduped by React Query so many UserNames stay cheap.
  const maintainersByRepo = useMaintainersByRepo();
  const isMaintainer =
    repoId != null &&
    user != null &&
    (maintainersByRepo.get(repoId)?.has(user.id) ?? false);
  const shield = isMaintainer ? <MaintainerShield /> : null;

  const label = userLabel(user, fallbackId);
  const name = !user?.githubLogin ? (
    <span className={className}>{label}</span>
  ) : (
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

  if (!shield) return name;
  return (
    <span className="inline-flex items-center gap-1">
      {name}
      {shield}
    </span>
  );
}
