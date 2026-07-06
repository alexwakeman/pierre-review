import { useEffect, useRef, useState } from 'react';
import { useClickOutside } from '../hooks/useClickOutside.js';
import { profileUrl } from '../lib/ui.js';
import { ExternalLinkIcon } from './Icons.js';

// The signed-in user chip at the far right of the header: a subtle button (avatar + name)
// that opens a small dropdown menu — "Open Profile on GitHub" and (cloud only) "Sign Out".
// Replaces the old plain profile link + the standalone header sign-out button.
export function UserMenu({
  user,
  canSignOut,
  onSignOut,
  onOpenSettings,
}: {
  user: { login: string; displayName: string | null; avatarUrl: string | null };
  // Sign-out only works in cloud (local has no session / no /api/auth/logout route), so the
  // entry is shown only when true.
  canSignOut: boolean;
  onSignOut: () => void;
  // Opens the user-configuration modal. Shown only when there's at least one Pro setting to
  // configure (the caller gates on capabilities).
  onOpenSettings: (() => void) | null;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const label = user.displayName ?? user.login;

  useClickOutside(rootRef, () => setOpen(false), open);
  // Escape closes the menu. stopPropagation so it doesn't bubble to the global `esc`
  // handler (useKeyboard), which would otherwise leave the current tab/overlay too.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const avatar =
    user.avatarUrl != null ? (
      <img
        src={user.avatarUrl}
        alt={label}
        width={20}
        height={20}
        className="shrink-0 rounded-full"
        style={{ width: 20, height: 20 }}
      />
    ) : (
      <span
        className="flex shrink-0 items-center justify-center rounded-full bg-gray-300 text-[9px] font-semibold text-gray-700 dark:bg-gray-700 dark:text-gray-200"
        style={{ width: 20, height: 20 }}
      >
        {label.slice(0, 2).toUpperCase()}
      </span>
    );

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`flex items-center gap-1.5 rounded px-1.5 py-0.5 text-xs font-medium text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800 ${
          open ? 'bg-gray-100 dark:bg-gray-800' : ''
        }`}
        title={
          user.displayName != null
            ? `Signed in as ${user.displayName} (@${user.login})`
            : `Signed in as ${user.login}`
        }
      >
        {avatar}
        <span className="max-w-[10rem] truncate">{label}</span>
        <span aria-hidden="true" className="text-[9px] text-gray-400">
          ▾
        </span>
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Account menu"
          className="absolute right-0 top-full z-[60] mt-1 w-52 rounded-lg border border-gray-200 bg-white py-1 shadow-lg dark:border-gray-700 dark:bg-gray-900"
        >
          {onOpenSettings != null && (
            <button
              role="menuitem"
              type="button"
              onClick={() => {
                setOpen(false);
                onOpenSettings();
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800"
            >
              <svg
                viewBox="0 0 24 24"
                width="13"
                height="13"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
              Settings
            </button>
          )}
          <a
            role="menuitem"
            href={profileUrl(user.login)}
            target="_blank"
            rel="noreferrer noopener"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800"
          >
            <ExternalLinkIcon size={13} />
            Open Profile on GitHub
          </a>
          {canSignOut && (
            <button
              role="menuitem"
              type="button"
              onClick={() => {
                setOpen(false);
                onSignOut();
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800"
            >
              <svg
                viewBox="0 0 24 24"
                width="13"
                height="13"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <polyline points="16 17 21 12 16 7" />
                <line x1="21" y1="12" x2="9" y2="12" />
              </svg>
              Sign Out
            </button>
          )}
        </div>
      )}
    </div>
  );
}
