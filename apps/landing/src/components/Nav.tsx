import { useEffect, useState } from 'react';
import { Link, useRoute } from '../router';
import { GitHubMark, MenuIcon, CloseIcon } from './icons';

const NAV_LINKS = [
  { to: '/features', label: 'Open Core' },
  { to: '/pro', label: 'Pro' },
  { to: '/pricing', label: 'Pricing' },
  { to: '/how-it-works', label: 'How it works' },
];

function isActive(path: string, to: string): boolean {
  // Legacy /insights and /reviews render the Pro page — light the Pro link up.
  if (to === '/pro' && (path === '/insights' || path === '/reviews')) return true;
  return path === to;
}

export default function Nav(): JSX.Element {
  const path = useRoute();
  const [open, setOpen] = useState(false);

  // Close the mobile menu whenever the route changes.
  useEffect(() => {
    setOpen(false);
  }, [path]);

  // Lock scroll + close on Esc while the drawer is open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = '';
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <header className="sticky top-0 z-50 border-b border-white/5 bg-gray-950/80 backdrop-blur supports-[backdrop-filter]:bg-gray-950/60">
      <nav
        aria-label="Primary"
        className="mx-auto flex max-w-6xl items-center justify-between px-5 py-3.5 sm:px-6"
      >
        <Link
          to="/"
          className="brand-title text-2xl text-gray-100 transition hover:text-white sm:text-3xl"
          aria-label="Pierre — home"
        >
          Pierre
        </Link>

        {/* desktop links */}
        <div className="hidden items-center gap-1 md:flex">
          {NAV_LINKS.map((l) => (
            <Link
              key={l.to}
              to={l.to}
              className={`rounded-lg px-3 py-2 text-sm font-medium transition ${
                isActive(path, l.to)
                  ? 'text-white'
                  : 'text-gray-400 hover:text-gray-100'
              }`}
              aria-current={isActive(path, l.to) ? 'page' : undefined}
            >
              {l.label}
            </Link>
          ))}
          <a
            href="/api/auth/login"
            className="ml-2 inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3.5 py-2 text-sm font-medium text-gray-100 transition hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-sky"
          >
            <GitHubMark className="h-4 w-4" />
            Sign in
          </a>
        </div>

        {/* mobile hamburger */}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="inline-flex items-center justify-center rounded-lg border border-white/10 bg-white/5 p-2 text-gray-200 transition hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-sky md:hidden"
          aria-label={open ? 'Close menu' : 'Open menu'}
          aria-expanded={open}
        >
          {open ? <CloseIcon className="h-5 w-5" /> : <MenuIcon className="h-5 w-5" />}
        </button>
      </nav>

      {/* mobile drawer */}
      {open && (
        <div className="md:hidden">
          <div className="space-y-1 border-t border-white/5 bg-gray-950/95 px-5 pb-6 pt-3">
            {NAV_LINKS.map((l) => (
              <Link
                key={l.to}
                to={l.to}
                className={`block rounded-lg px-3 py-3 text-base font-medium transition ${
                  isActive(path, l.to)
                    ? 'bg-white/5 text-white'
                    : 'text-gray-300 hover:bg-white/5 hover:text-white'
                }`}
                aria-current={isActive(path, l.to) ? 'page' : undefined}
              >
                {l.label}
              </Link>
            ))}
            <a
              href="/api/auth/login"
              className="mt-2 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-brand-blueDeep to-brand-blue px-4 py-3 text-base font-semibold text-white shadow-sky-glow"
            >
              <GitHubMark className="h-5 w-5" />
              Sign in with GitHub
            </a>
          </div>
        </div>
      )}
    </header>
  );
}
