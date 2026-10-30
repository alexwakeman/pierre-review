import { profileUrl } from '../lib/ui.js';
import { ExternalLinkIcon, GearIcon } from './Icons.js';
import { Menu, type MenuEntry } from './ui/Menu.js';
import { cx, FOCUS_RING } from './ui/cx.js';

// The account menu at the foot of the sidebar: who is signed in (avatar + name, "@login" in the
// trigger's title), Settings, and the GitHub profile. Built on the shared `Menu` (one popover at a
// time, type-ahead, its own Escape, a bottom sheet on a phone); it opens UPWARD from the foot.
//
// ⚠ The trigger's `title` starts "Signed in as" and the item is named "Settings": scripts/
// verify-demo.mjs and record-demo.mjs open Settings through exactly those two.
export function UserMenu({
  user,
  onOpenSettings,
}: {
  user: { login: string; displayName: string | null; avatarUrl: string | null };
  // Opens the user-configuration modal.
  onOpenSettings: (() => void) | null;
}): JSX.Element {
  const label = user.displayName ?? user.login;

  const avatar =
    user.avatarUrl != null ? (
      <img
        src={user.avatarUrl}
        alt=""
        width={20}
        height={20}
        className="shrink-0 rounded-full"
        style={{ width: 20, height: 20 }}
      />
    ) : (
      <span
        aria-hidden
        className="flex shrink-0 items-center justify-center rounded-full bg-ui-hover text-meta font-semibold text-ui-ink"
        style={{ width: 20, height: 20 }}
      >
        {label.slice(0, 2).toUpperCase()}
      </span>
    );

  const items: MenuEntry[] = [
    { heading: `@${user.login}`, id: 'who' },
    ...(onOpenSettings != null
      ? [{ id: 'settings', label: 'Settings', icon: <GearIcon size={13} />, onSelect: onOpenSettings }]
      : []),
    {
      id: 'profile',
      label: 'Open Profile on GitHub',
      icon: <ExternalLinkIcon size={13} />,
      onSelect: () => window.open(profileUrl(user.login), '_blank', 'noopener,noreferrer'),
    },
  ];

  return (
    <Menu
      label="Account menu"
      side="top"
      className="w-full min-w-0"
      items={items}
      trigger={(props) => (
        <button
          type="button"
          {...props}
          title={
            user.displayName != null
              ? `Signed in as ${user.displayName} (@${user.login})`
              : `Signed in as ${user.login}`
          }
          className={cx(
            'flex h-8 w-full min-w-0 items-center gap-2 rounded-ui px-2 text-left text-body text-ui-mute hover:bg-ui-hover hover:text-ui-ink touch:h-11',
            props['aria-expanded'] && 'bg-ui-hover text-ui-ink',
            FOCUS_RING,
          )}
        >
          {avatar}
          <span className="min-w-0 flex-1 truncate">{label}</span>
        </button>
      )}
    />
  );
}
