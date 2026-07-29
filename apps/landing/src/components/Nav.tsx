import { Link, useRoute } from '../router';
import { Wordmark } from './feint/Wordmark';

// ---------------------------------------------------------------------------
// The header: a wordmark, four mono links, and "Sign in". No button, no icon,
// no logo, no sticky backdrop-blur — just a rule under it.
//
// The active page is marked by a 2px vermilion underline on its link, which is
// the one navigational use of the signal colour. When no nav item matches the
// current path (the home page, the legal pages) the underline falls to "Sign
// in", so the header always carries exactly one marker — matching both mocks.
//
// NO MOBILE DRAWER. The previous header had a hamburger opening a full-screen
// menu; five mono links at 13px wrap onto a second line well before they need
// one, and a modal drawer is exactly the kind of "box" this direction removes.
// ---------------------------------------------------------------------------

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

const ACTIVE = 'border-b-2 border-signal-fill pb-0.5 text-ink';
const FADE = 'transition-colors duration-hover ease-standard';
const FOCUS =
  'focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink';

export default function Nav(): JSX.Element {
  const path = useRoute();
  const navMatched = NAV_LINKS.some((l) => isActive(path, l.to));

  return (
    <header className="border-b border-rule px-gutter py-[26px]">
      <nav
        aria-label="Primary"
        className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-4"
      >
        <Link to="/" aria-label={`Home`} className={`${FOCUS}`}>
          <Wordmark />
        </Link>

        <div className="flex flex-wrap items-baseline gap-x-5 gap-y-2 font-mono text-mono-nav text-nav-idle type:gap-x-[30px]">
          {NAV_LINKS.map((l) => {
            const active = isActive(path, l.to);
            return (
              <Link
                key={l.to}
                to={l.to}
                aria-current={active ? 'page' : undefined}
                className={`${active ? ACTIVE : 'hover:text-ink'} ${FADE} ${FOCUS}`}
              >
                {l.label}
              </Link>
            );
          })}
          <Link
            to="/api/auth/login"
            className={`text-ink ${navMatched ? '' : ACTIVE} ${FADE} ${FOCUS}`}
          >
            Sign in
          </Link>
        </div>
      </nav>
    </header>
  );
}
