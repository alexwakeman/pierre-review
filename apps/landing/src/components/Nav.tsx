import { Link, useRoute } from '../router';
import { SITE_NAME } from '../lib/site';

// ---------------------------------------------------------------------------
// The header, as three tiles of the board (styles: .lb-nav in board.css): an ink
// tile carrying the name, a surface tile with the four page links, and a flat
// gold "Run it now" tile that lands on the home page's run section.
//
// The active page is marked by a gold underline on its link (aria-current="page").
// The home page and the legal pages match no link, so nothing is marked there.
//
// There is no sign-in. Limn has no hosted app and no accounts.
//
// NO MOBILE DRAWER. On a phone the link tile is hidden, as in the design, and the
// same four links follow as a second row of small text under the tiles. A modal
// drawer is a box this design does not need.
// ---------------------------------------------------------------------------

const NAV_LINKS = [
  { to: '/getting-started', label: 'Getting started' },
  { to: '/reporting', label: 'Reporting and metrics' },
  { to: '/how-we-measure', label: 'How we measure' },
  // Contact is in the header, not only the footer, because it is how an organisation
  // with more than three people gets a licence — a path in a footer is one nobody takes.
  { to: '/contact', label: 'Contact' },
];

// The legacy aliases render a surviving page (App.tsx), so the header has to light up
// the link that page belongs to — otherwise a visitor on /pricing sees a page with no
// nav item marked.
//
// ⚠ THIS TABLE MUST TRACK THE ALIASES IN App.tsx. It previously mapped /insights and
// /reviews onto a `/pro` nav link that no longer exists, so it had been inert since the
// restructure — a mapping is only alive while its `to` is in NAV_LINKS.
const ALIAS_OF: Record<string, string> = {
  '/for-developers': '/getting-started',
  '/for-managers': '/reporting',
  '/features': '/getting-started',
  '/how-it-works': '/how-we-measure',
  '/bots': '/reporting',
  '/pro': '/reporting',
  '/insights': '/reporting',
  '/reviews': '/reporting',
  '/pricing': '/contact',
};

function isActive(path: string, to: string): boolean {
  return path === to || ALIAS_OF[path] === to;
}

export default function Nav(): JSX.Element {
  const path = useRoute();

  const links = NAV_LINKS.map((l) => (
    <Link key={l.to} to={l.to} aria-current={isActive(path, l.to) ? 'page' : undefined}>
      {l.label}
    </Link>
  ));

  return (
    <header className="lb-nav">
      <nav aria-label="Primary">
        <div className="bar">
          <Link to="/" className="mark" aria-current={path === '/' ? 'page' : undefined}>
            {SITE_NAME}
          </Link>
          <div className="links">{links}</div>
          <Link to="/#run" className="go">
            Run it now
          </Link>
        </div>
        {/* Phones and narrow tablets (board.css shows it under 961px, where .links is hidden). */}
        <div className="links-sm">{links}</div>
      </nav>
    </header>
  );
}
