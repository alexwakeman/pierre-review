import { useAuthProviders } from '../../hooks/useAuthProviders.js';
import { SectionShell } from './ui.js';

// GitHub App INSTALL (cloud-only, CORE/free). Signing in via the App uses GitHub's
// /login/oauth/authorize flow, which mints a user token and installs NOTHING — so a user can be
// signed in, see the App under "Authorized GitHub Apps", and still have zero installations. The
// install link previously lived ONLY on the signed-out SignInGate, which meant exactly those
// users had no in-app path to it. This section is that path.
//
// Why it matters beyond private repos: webhook deliveries come from an INSTALLATION, never from
// an authorization (OAuth Apps have no webhook mechanism at all). The receiver routes by
// (owner, name) across every account watching the repo, so the unit of coverage is the REPO, not
// the user — one install covers every tenant watching it. Uncovered repos fall back to the poll.
// See docs/REALTIME-SYNC.md.
//
// Rendered only when the deployment offers the GitHub App provider; SettingsModal adds the
// cloud gate. Purely informational + two outbound links — no local state, nothing to save.
export function GithubAppInstallSection(): JSX.Element | null {
  const { data: providers } = useAuthProviders();
  if (!providers?.app || !providers.appSlug) return null;

  const installUrl = `https://github.com/apps/${providers.appSlug}/installations/new`;
  const linkCls =
    'inline-flex items-center gap-1 rounded border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:border-sky-400 hover:text-sky-600 dark:border-gray-700 dark:text-gray-200 dark:hover:text-sky-400';

  return (
    <SectionShell
      title="GitHub App"
      desc="Signing in with GitHub doesn’t install the app. Installing it is a separate, one-time step per account or org — and it’s what unlocks private repos and real-time sync."
    >
      <div className="flex flex-wrap gap-2">
        <a className={linkCls} href={installUrl} target="_blank" rel="noreferrer">
          Install on an account or org ↗
        </a>
        <a
          className={linkCls}
          href="https://github.com/settings/installations"
          target="_blank"
          rel="noreferrer"
        >
          Manage installations ↗
        </a>
      </div>

      <ul className="mt-1 space-y-1 text-[11px] leading-relaxed text-gray-500 dark:text-gray-400">
        <li>
          <span className="font-medium text-gray-600 dark:text-gray-300">Private repos:</span>{' '}
          only readable in orgs where the app is installed. An org owner may need to approve.
        </li>
        <li>
          <span className="font-medium text-gray-600 dark:text-gray-300">Real-time sync:</span>{' '}
          installed repos push changes to Pierre as they happen, instead of waiting for the next
          scheduled poll. Coverage is per <em>repo</em>, not per person — one install covers
          everyone watching that repo.
        </li>
        <li>
          <span className="font-medium text-gray-600 dark:text-gray-300">Not installed?</span>{' '}
          Nothing breaks — those repos just stay on the scheduled poll, which keeps running as the
          backstop either way. Public repos work with no install at all.
        </li>
      </ul>
    </SectionShell>
  );
}
