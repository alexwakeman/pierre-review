import { useEffect, useState } from 'react';

// The OAuth callback (api/routes/auth.ts) redirects here with ?auth=<reason>
// when a sign-in doesn't complete, instead of dumping a raw JSON error. Map each
// reason to a friendly line; unknown reasons fall back to the generic failure.
const AUTH_MESSAGES: Record<string, string> = {
  expired: 'Your sign-in link expired. Please sign in again.',
  failed: 'We couldn’t complete sign-in with GitHub. Please try again.',
  error: 'Something went wrong reaching GitHub. Please try again in a moment.',
  unavailable: 'That sign-in method isn’t enabled on this deployment.',
};

// Which sign-in providers this deployment offers (from GET /api/auth/providers).
interface Providers {
  oauth: boolean;
  app: boolean;
  appSlug: string;
}

const GithubMark = (): JSX.Element => (
  <svg viewBox="0 0 16 16" width="18" height="18" fill="currentColor" aria-hidden="true">
    <path
      fillRule="evenodd"
      d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z"
    />
  </svg>
);

/**
 * Full-screen dark gate shown to signed-out CLOUD visitors who land directly on
 * `/app`. In local mode `/api/me` never 401s, so this never renders. Each button
 * is a full-page navigation (an anchor to a provider's OAuth login route), NOT a
 * fetch — the backend redirects through GitHub. The deployment may offer the OAuth
 * App (public repos), the GitHub App (adds private org repos via install), or both.
 */
export function SignInGate(): JSX.Element {
  // Read the failed-sign-in reason once, then strip ?auth= from the URL so a
  // manual reload doesn't keep showing a stale message.
  const [authMessage] = useState<string | null>(() => {
    const reason = new URLSearchParams(window.location.search).get('auth');
    if (!reason) return null;
    return AUTH_MESSAGES[reason] ?? 'We couldn’t complete sign-in. Please try again.';
  });
  useEffect(() => {
    if (!authMessage) return;
    const url = new URL(window.location.href);
    url.searchParams.delete('auth');
    window.history.replaceState({}, '', url.pathname + url.search + url.hash);
  }, [authMessage]);

  // Ask the backend which sign-in methods are configured. Default to OAuth-only so the
  // common deployment still shows a working button if the request is slow/blocked.
  const [providers, setProviders] = useState<Providers>({ oauth: true, app: false, appSlug: '' });
  useEffect(() => {
    let alive = true;
    fetch('/api/auth/providers', { credentials: 'include' })
      .then((r) => (r.ok ? (r.json() as Promise<Providers>) : null))
      .then((p) => {
        if (alive && p) setProviders(p);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // The OAuth App is the primary (frictionless) button when present; otherwise the App.
  const both = providers.oauth && providers.app;

  return (
    <div className="flex h-full min-h-screen w-full items-center justify-center bg-gray-950 px-4 text-gray-100">
      <div className="flex w-full max-w-sm flex-col items-center rounded-2xl border border-gray-800 bg-gray-900/40 px-8 py-10 text-center shadow-xl">
        <span className="brand-title text-4xl" title="Pierre — a play on “PR”">
          Pierre
        </span>
        <p className="mt-4 text-sm text-gray-400">
          Sign in to view your team&rsquo;s GitHub activity — pull requests,
          reviews, and what needs your attention.
        </p>
        {authMessage && (
          <div
            role="alert"
            className="mt-6 w-full rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200"
          >
            {authMessage}
          </div>
        )}

        <div className="mt-7 flex w-full flex-col gap-3">
          {providers.oauth && (
            <a
              href="/api/auth/login/oauth"
              className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-sky-400 focus:ring-offset-2 focus:ring-offset-gray-950"
            >
              <GithubMark />
              Sign in with GitHub
            </a>
          )}
          {providers.app && (
            <div className="flex w-full flex-col gap-1">
              <a
                href="/api/auth/login/app"
                className={`inline-flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-sky-400 focus:ring-offset-2 focus:ring-offset-gray-950 ${
                  both
                    ? 'border border-gray-700 bg-transparent text-gray-100 hover:bg-gray-800'
                    : 'bg-blue-600 text-white hover:bg-blue-700'
                }`}
              >
                <GithubMark />
                Sign in with the Pierre GitHub App
              </a>
              <span className="px-1 text-[11px] leading-snug text-amber-500/80">
                Scope may be limited: private org repos only appear once an org admin
                installs the app on your org — until then you&rsquo;ll see public repos.
              </span>
            </div>
          )}
        </div>

        {both && (
          <p className="mt-4 text-[11px] leading-relaxed text-gray-500">
            <span className="text-gray-400">GitHub</span> = public repositories, instant,
            no install. <span className="text-gray-400">GitHub App</span> = also private
            repos, but only in orgs that have installed the app.
          </p>
        )}

        <p className="mt-4 text-xs leading-relaxed text-gray-500">
          Public repositories work either way, with no install. To watch{' '}
          <strong className="font-semibold text-gray-400">private</strong> org repos, sign
          in with the GitHub App and{' '}
          {providers.app && providers.appSlug ? (
            <a
              className="underline decoration-gray-600 underline-offset-2 hover:text-gray-300"
              href={`https://github.com/apps/${providers.appSlug}/installations/new`}
              target="_blank"
              rel="noreferrer"
            >
              install it
            </a>
          ) : (
            'install it'
          )}{' '}
          on that org (an org owner may need to approve). Revoke anytime from your GitHub
          settings.
        </p>
      </div>
    </div>
  );
}
