import type { AuthNotice } from '@pierre-review/shared';

// A global strip shown when the `gh` token is no longer authorized for one or more orgs' SAML SSO
// (from /api/me `authNotices`, populated server-side by the sync). Unlike the per-PR banner, this
// doesn't depend on opening a blocked PR or a cache miss. The fix is `gh auth refresh` in a
// terminal; the strip clears itself once the next sync reads the org cleanly.
export function AuthNoticeBanner({ notices }: { notices: AuthNotice[] }): JSX.Element | null {
  if (notices.length === 0) return null;
  const orgs = notices.map((n) => n.org).join(', ');
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-ui-warn/40 bg-ui-warn/10 px-4 py-2 text-meta text-ui-warn">
      <span className="min-w-0">
        <strong className="font-semibold">
          Your GitHub login is not authorized for {orgs}.
        </strong>{' '}
        Its pull requests, CI checks and comments can&rsquo;t be synced until you authorize it for
        single sign-on. Run <code className="font-mono">gh auth refresh</code> in a terminal.
      </span>
    </div>
  );
}
