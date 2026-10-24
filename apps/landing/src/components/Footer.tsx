import { useCallback } from 'react';
import type { MouseEvent } from 'react';
import { Link } from '../router';
import { resetConsent } from '../lib/consent';
import { analyticsConfigured, revokeAnalytics } from '../lib/analytics';
import { DEMO_PATH, LICENSE_URL, REPO_URL, SITE_NAME } from '../lib/site';

// ---------------------------------------------------------------------------
// The footer, on the board's dark ground (styles: .lb-foot in board.css): the
// name built as four pigment blocks, four columns of links, the picture credits,
// and a last line with the © and "Back to top".
//
// Two of these links are compliance, not decoration, and must stay on every page:
//
//   · "Cookie settings" is the consent-WITHDRAWAL control. GDPR requires
//     withdrawal to be as easy as granting and reachable from a persistent
//     place — not only from a banner that has already been dismissed.
//   · /privacy, /cookies and /terms.
// ---------------------------------------------------------------------------

export default function Footer(): JSX.Element {
  // Clearing the stored choice re-shows the banner (CookieBanner listens for the
  // consent event). Hidden entirely when no measurement id is configured, since
  // then there is genuinely no consent to withdraw.
  const changeCookieChoice = useCallback(() => {
    revokeAnalytics();
    resetConsent();
  }, []);

  const backToTop = useCallback((e: MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
  }, []);

  const letters = SITE_NAME.toUpperCase().split('');

  return (
    <footer className="lb-foot">
      <div className="blocks" role="img" aria-label={SITE_NAME}>
        {letters.map((ch, i) => (
          <div key={i} className="blk" aria-hidden="true">
            {ch}
          </div>
        ))}
      </div>

      <div className="flinks">
        <div>
          <Link to="/#gather">Gather</Link>
          <Link to="/#check">Check</Link>
          <Link to="/#act">Act</Link>
        </div>
        <div>
          <Link to="/getting-started">Getting started</Link>
          <Link to="/reporting">Reporting and metrics</Link>
          <Link to="/how-we-measure">How we measure</Link>
        </div>
        <div>
          <Link to={DEMO_PATH}>Demo</Link>
          <Link to="/contact">Contact</Link>
          <a href={REPO_URL} target="_blank" rel="noreferrer noopener">
            GitHub
          </a>
          <a href={LICENSE_URL} target="_blank" rel="noreferrer noopener">
            Licence
          </a>
        </div>
        <div>
          <Link to="/privacy">Privacy</Link>
          <Link to="/cookies">Cookies</Link>
          <Link to="/terms">Terms</Link>
          {analyticsConfigured() && (
            <button type="button" onClick={changeCookieChoice}>
              Cookie settings
            </button>
          )}
        </div>
        <p className="c muted">
          Pictures: Nicholas Hilliard, self-portrait, 1577; a leaf from a Book of Hours, around 1500
          (The Met); Jacques de Guyse at his desk, Master of Antoine Rolin, around 1500; illuminated
          initials H and N (Art Institute of Chicago, CC0). Public domain or CC0.
        </p>
      </div>

      <div className="last">
        <span>© 2026 {SITE_NAME}</span>
        <a className="btn" href="#" onClick={backToTop}>
          Back to top
        </a>
      </div>
    </footer>
  );
}
