import { useAuthProviders } from '../../hooks/useAuthProviders.js';
import { ExternalLinkIcon } from '../Icons.js';
import { InfoButton } from '../InfoModal.js';
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
      desc="Signing in with GitHub doesn’t install the app. Installing it is a separate, one-time step per account or org, and it is what unlocks private repos and real-time sync."
      info={
        <InfoButton title="GitHub App">
          <ul className="list-disc space-y-1 pl-5">
            <li>
              <strong>Private repos</strong> are readable only in orgs where the app is installed.
              An org owner may need to approve the install.
            </li>
            <li>
              <strong>Real-time sync:</strong> installed repos send changes to Limn as they happen,
              instead of waiting for the next scheduled check. One install covers everyone watching
              that repo.
            </li>
            <li>
              <strong>Not installed?</strong> Nothing breaks. Those repos are checked on the
              schedule, which runs either way. Public repos work with no install.
            </li>
          </ul>
        </InfoButton>
      }
    >
      <div className="flex flex-wrap gap-2">
        <a className={linkCls} href={installUrl} target="_blank" rel="noreferrer">
          Install on an account or org
          <ExternalLinkIcon size={11} />
        </a>
        <a
          className={linkCls}
          href="https://github.com/settings/installations"
          target="_blank"
          rel="noreferrer"
        >
          Manage installations
          <ExternalLinkIcon size={11} />
        </a>
      </div>
    </SectionShell>
  );
}
