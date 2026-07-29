import type { AuthNotice } from '@pierre-review/shared';

// A global strip shown when the account's sign-in token is no longer authorized for one or more
// orgs' SAML SSO (from /api/me `authNotices`, populated server-side by the sync). Unlike the
// per-PR banner, this doesn't depend on opening a blocked PR or a cache miss. "Reconnect GitHub"
// hits /api/auth/reconnect, which revokes the app's grant (forcing a fresh consent + the SAML SSO
// step) and re-runs sign-in. It self-dismisses once the next sync reads the org cleanly.
export function AuthNoticeBanner({ notices }: { notices: AuthNotice[] }): JSX.Element | null {
  if (notices.length === 0) return null;
  const orgs = notices.map((n) => n.org).join(', ');
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-amber-400/50 bg-amber-400/10 px-4 py-2 text-xs text-amber-800 dark:text-amber-200">
      <span className="min-w-0">
        <strong className="font-semibold">
          Your GitHub sign-in is no longer authorized for {orgs}.
        </strong>{' '}
        Its pull requests, CI checks and comments can&rsquo;t be synced until you re-authorize
        (SAML single sign-on).
      </span>
      <a
        href="/api/auth/reconnect"
        className="ml-auto whitespace-nowrap rounded border border-amber-500/60 px-2.5 py-0.5 font-medium hover:bg-amber-400/20"
      >
        Reconnect GitHub
      </a>
      <span className="w-full text-[11px] text-amber-700/80 dark:text-amber-300/70">
        Reconnect signs you in again through SSO. If it doesn&rsquo;t clear, your org may restrict
        third-party OAuth apps — an org owner has to approve Limn once.
      </span>
    </div>
  );
}
