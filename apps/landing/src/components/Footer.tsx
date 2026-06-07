import { GitHubMark } from './icons';

export default function Footer() {
  return (
    <footer className="border-t border-white/5">
      <div className="mx-auto flex max-w-6xl flex-col items-center gap-6 px-6 py-14 text-center">
        <span className="brand-title text-3xl text-gray-200">Pierre</span>

        <p className="max-w-md text-sm text-gray-400">
          Local-first, open. Runs on your machine or self-hosted on Railway.
        </p>

        <a
          href="https://github.com/alexwakeman/pierre-review"
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-gray-300 transition hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-sky"
          aria-label="Pierre on GitHub"
        >
          <GitHubMark className="h-4 w-4" />
          View on GitHub
        </a>

        <p className="text-xs text-gray-600">
          © 2026 Pierre. Built for sprint situational awareness.
        </p>
      </div>
    </footer>
  );
}
