import { Link } from '../router';
import { GitHubMark } from './icons';

const COLUMNS: { heading: string; links: { label: string; to: string }[] }[] = [
  {
    heading: 'Product',
    links: [
      { label: 'Features', to: '/features' },
      { label: 'Insights', to: '/insights' },
      { label: 'Claude Review', to: '/reviews' },
      { label: 'How it works', to: '/how-it-works' },
    ],
  },
  {
    heading: 'Get started',
    links: [
      { label: 'Sign in with GitHub', to: '/api/auth/login' },
      { label: 'Run it locally', to: '/how-it-works#run-locally' },
      { label: 'Roadmap', to: '/how-it-works#roadmap' },
    ],
  },
  {
    heading: 'Project',
    links: [
      { label: 'GitHub repository', to: 'https://github.com/alexwakeman/pierre-review' },
      { label: 'Report an issue', to: 'https://github.com/alexwakeman/pierre-review/issues' },
    ],
  },
];

export default function Footer(): JSX.Element {
  return (
    <footer className="mt-24 border-t border-white/5 bg-white/[0.015]">
      <div className="mx-auto max-w-6xl px-5 py-14 sm:px-6">
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <Link to="/" className="brand-title text-3xl text-gray-200">
              Pierre
            </Link>
            <p className="mt-3 max-w-xs text-sm leading-relaxed text-gray-400">
              The team&apos;s GitHub activity, at a glance. Local-first and open — run it
              on your machine or self-host the multi-tenant cloud.
            </p>
            <a
              href="https://github.com/alexwakeman/pierre-review"
              target="_blank"
              rel="noreferrer noopener"
              className="mt-5 inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-gray-300 transition hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-sky"
            >
              <GitHubMark className="h-4 w-4" />
              View on GitHub
            </a>
          </div>

          {COLUMNS.map((col) => (
            <div key={col.heading}>
              <h3 className="text-sm font-semibold text-gray-200">{col.heading}</h3>
              <ul className="mt-4 space-y-2.5">
                {col.links.map((l) => (
                  <li key={l.label}>
                    <Link
                      to={l.to}
                      className="text-sm text-gray-400 transition hover:text-gray-100"
                      {...(l.to.startsWith('http')
                        ? { target: '_blank', rel: 'noreferrer noopener' }
                        : {})}
                    >
                      {l.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-12 flex flex-col items-center justify-between gap-3 border-t border-white/5 pt-6 text-center sm:flex-row sm:text-left">
          <p className="text-xs text-gray-600">
            © 2026 Pierre. Built for sprint situational awareness.
          </p>
          <p className="text-xs text-gray-600">
            Best on the desktop today · mobile-ready builds are on the roadmap.
          </p>
        </div>
      </div>
    </footer>
  );
}
