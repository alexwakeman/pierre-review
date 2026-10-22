import { Link, useRoute } from '../router';
import { Wordmark } from './feint/Wordmark';
import { DEMO_PATH } from '../lib/site';

// ---------------------------------------------------------------------------
// The header: a wordmark, four mono links plus "Try the demo". No button, no icon,
// no logo, no sticky backdrop-blur — just a rule under it.
//
// The active page is marked by a 2px vermilion underline on its link, which is
// the one navigational use of the signal colour. When no nav item matches the
// current path (the home page, the legal pages) the underline falls to "Try the
// demo", so the header always carries exactly one marker — matching both mocks.
//
// There is no sign-in. Limn has no hosted app and no accounts; the demo (a static
// build of the real app on sample data) is the only thing a visitor can open here.
//
// NO MOBILE DRAWER. The previous header had a hamburger opening a full-screen
// menu; five mono links at 13px wrap onto a second line well before they need
// one, and a modal drawer is exactly the kind of "box" this direction removes.
// ---------------------------------------------------------------------------

const NAV_LINKS = [
  { to: '/for-developers', label: 'For developers' },
  { to: '/for-managers', label: 'For managers' },
  { to: '/how-we-measure', label: 'How we measure' },
  // Contact is in the header, not only the footer, because it is how an organisation
  // with more than three people gets a licence — a path in a footer is one nobody takes.
  { to: '/contact', label: 'Contact' },
];

// The legacy aliases render a surviving page (App.tsx), so the header has to light up
// the link that page belongs to — otherwise a visitor on /pricing sees a page with no
// nav item marked and the underline falls through to "Try the demo", which is the wrong
// claim about where they are.
//
// ⚠ THIS TABLE MUST TRACK THE ALIASES IN App.tsx. It previously mapped /insights and
// /reviews onto a `/pro` nav link that no longer exists, so it had been inert since the
// restructure — a mapping is only alive while its `to` is in NAV_LINKS.
const ALIAS_OF: Record<string, string> = {
  '/features': '/for-developers',
  '/how-it-works': '/how-we-measure',
  '/bots': '/for-managers',
  '/pro': '/for-managers',
  '/insights': '/for-managers',
  '/reviews': '/for-managers',
  '/pricing': '/contact',
};

function isActive(path: string, to: string): boolean {
  return path === to || ALIAS_OF[path] === to;
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
            to={DEMO_PATH}
            className={`text-ink ${navMatched ? '' : ACTIVE} ${FADE} ${FOCUS}`}
          >
            Try the demo
          </Link>
        </div>
      </nav>
    </header>
  );
}
