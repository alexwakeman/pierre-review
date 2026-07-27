import { useState } from 'react';
import type { User } from '@pierre-review/shared';
import { profileUrl, userLabel } from '../lib/ui.js';
import { useMaintainersByRepo } from '../hooks/useMaintainers.js';
import { MaintainerShield } from './MaintainerShield.js';
import { UserProfilePopover } from './UserProfilePopover.js';

/**
 * A contributor's display name. Clicking it opens the user popover — their contribution
 * totals in the surrounding context, plus links to their GitHub profile and to their
 * activity feed. (It used to be a bare link straight to GitHub; the profile is still one
 * click away, inside the popover.) Falls back to plain text for unknown / id-only actors.
 * `stopPropagation` keeps a click on the name from also triggering a parent row/PR
 * selection handler.
 *
 * When `repoId` is supplied and the user has merge rights in that repo (has merged a PR
 * there), a maintainer shield is appended after the name — matching the badge on the
 * timeline contributor rows. `repoId` ALSO scopes the popover's numbers to that repo, so
 * pass it wherever the name is rendered in a PR context.
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
  const [open, setOpen] = useState(false);
  // A CALLBACK ref, not useRef: the popover needs the anchor NODE during render, and a plain
  // ref's `.current` read at render time is stale for exactly one render after the node
  // changes. State re-renders on attach, so the popover always anchors to the live element.
  const [anchorEl, setAnchorEl] = useState<HTMLAnchorElement | null>(null);
  const isMaintainer =
    repoId != null &&
    user != null &&
    (maintainersByRepo.get(repoId)?.has(user.id) ?? false);
  const shield = isMaintainer ? <MaintainerShield /> : null;

  const label = userLabel(user, fallbackId);
  // The popover is keyed on a real user id — an id-only/unknown actor has nothing to show,
  // so it stays plain text (as before).
  const userId = user?.id ?? null;
  const login = user?.githubLogin ?? null;
  // Still an <a href> to the profile, exactly as before: a MODIFIED click (⌘/ctrl/shift/alt)
  // or a non-primary button keeps opening GitHub in a new tab, and the element stays inline
  // so no call site's layout shifts. A plain left click is intercepted for the popover
  // instead — the profile link lives inside it. Same contract as the timeline row labels.
  const name =
    userId == null ? (
      <span className={className}>{label}</span>
    ) : (
      <a
        ref={setAnchorEl}
        href={login ? profileUrl(login) : undefined}
        target={login ? '_blank' : undefined}
        rel={login ? 'noreferrer noopener' : undefined}
        data-user-handle={userId}
        onClick={(e) => {
          e.stopPropagation();
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; // let the browser open GitHub
          e.preventDefault();
          setOpen((v) => !v);
        }}
        title={login ? `@${login} — activity & stats` : 'Activity & stats'}
        className={[className, 'cursor-pointer hover:underline'].filter(Boolean).join(' ')}
      >
        {label}
      </a>
    );

  const popover =
    open && userId != null && anchorEl != null ? (
      <UserProfilePopover
        user={user}
        userId={userId}
        repoId={repoId ?? null}
        anchor={{ kind: 'element', el: anchorEl }}
        onDismiss={() => setOpen(false)}
      />
    ) : null;

  // The returned tree's SHAPE must not depend on `open`. It used to: with no shield, a closed
  // UserName returned the bare <a> and an open one returned a <span> wrapping it. React sees
  // the root element type change, unmounts the <a> and mounts a fresh one — so the anchor the
  // popover had just been handed was a detached node with a zero rect, and the card landed in
  // the top-left corner instead of under the name. Keying the shape on `shield` alone (which
  // can't change while the popover is open) keeps the anchor node stable across the toggle.
  if (!shield)
    return (
      <>
        {name}
        {popover}
      </>
    );
  return (
    <span className="inline-flex items-center gap-1">
      {name}
      {shield}
      {popover}
    </span>
  );
}
