import { GitHubMark } from './icons';
import HeroWordmark from './HeroWordmark';

export default function Hero() {
  return (
    <header className="relative overflow-hidden">
      {/* Gradient accent glows drawn from the brand palette. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10"
      >
        <div className="absolute -top-32 left-1/2 h-[36rem] w-[36rem] -translate-x-1/2 rounded-full bg-brand-blueDeep/20 blur-[140px]" />
        <div className="absolute -top-10 right-[10%] h-72 w-72 rounded-full bg-brand-sky/20 blur-[120px]" />
        <div className="absolute top-40 left-[8%] h-72 w-72 rounded-full bg-brand-purple/20 blur-[120px]" />
      </div>

      <nav className="mx-auto flex max-w-6xl items-center justify-between px-6 pt-8">
        <span className="brand-title text-3xl text-gray-100">Pierre</span>
        <a
          href="/api/auth/login"
          className="hidden items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-gray-200 transition hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-sky sm:inline-flex"
        >
          <GitHubMark className="h-4 w-4" />
          Sign in
        </a>
      </nav>

      <div className="mx-auto max-w-4xl px-6 pb-24 pt-20 text-center sm:pt-28">
        <HeroWordmark />

        <h1 className="mx-auto max-w-3xl text-balance text-4xl font-bold leading-tight tracking-tight text-gray-50 sm:text-6xl">
          See your team&apos;s GitHub activity{' '}
          <span className="bg-gradient-to-r from-brand-sky via-brand-blue to-brand-purpleSoft bg-clip-text text-transparent">
            at a glance.
          </span>
        </h1>

        <p className="mx-auto mt-6 max-w-2xl text-pretty text-lg leading-relaxed text-gray-400">
          A timeline-first dashboard for sprint situational awareness — who&apos;s
          doing what, which PRs are stalled, and what needs your review right now.
        </p>

        <div className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row">
          <a
            href="/api/auth/login"
            className="group inline-flex items-center gap-3 rounded-xl bg-gradient-to-r from-brand-blueDeep to-brand-blue px-6 py-3.5 text-base font-semibold text-white shadow-sky-glow transition hover:from-brand-blue hover:to-brand-sky focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-skySoft focus-visible:ring-offset-2 focus-visible:ring-offset-gray-950"
          >
            <GitHubMark className="h-5 w-5" />
            Sign in with GitHub
          </a>
          <a
            href="#features"
            className="text-sm font-medium text-gray-400 transition hover:text-gray-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-sky"
          >
            Explore the features ↓
          </a>
        </div>

        <p className="mt-6 text-sm text-gray-500">
          Local-first and open. No stored credentials — auth runs through GitHub.
        </p>
      </div>
    </header>
  );
}
