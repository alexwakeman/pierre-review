import { useCallback } from 'react';
import type { MouseEvent } from 'react';
import { Link } from '../router';
import { resetConsent } from '../lib/consent';
import { analyticsConfigured, revokeAnalytics } from '../lib/analytics';
import { LICENSE_URL, REPO_URL, SITE_NAME } from '../lib/site';

// ---------------------------------------------------------------------------
// The footer, on the board's dark ground (styles: .lb-foot in board.css): 
// four columns of links, the picture credits,
// and a last line with the © and "Back to top".
//
// Two of these links are compliance, not decoration, and must stay on every page:
//
//   · "Cookie settings" is the consent-WITHDRAWAL control. GDPR requires
//     withdrawal to be as easy as granting and reachable from a persistent
//     place — not only from a banner that has already been dismissed.
//   · /privacy, /cookies and /terms.
//
// The docs (/docs/**) have no footer: DocsApp.tsx ends on one line that carries the
// same compliance links (DocsLegal), so they are still on every page.
// ---------------------------------------------------------------------------

/** "Cookie settings": clearing the stored choice re-shows the banner (CookieBanner listens for
 *  the consent event). Shared with the docs' legal line. */
export function changeCookieChoice(): void {
  revokeAnalytics();
  resetConsent();
}

export default function Footer(): JSX.Element {
  const backToTop = useCallback((e: MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
  }, []);

  return (
    <footer className="lb-foot">
      <div className="flinks">
        <div>
          <Link to="/everything-else#open-prs">Open pull requests</Link>
          <Link to="/everything-else#reporting">Reporting</Link>
          <Link to="/everything-else#how-we-measure">How we measure</Link>
        </div>
        <div>
          <Link to="/docs">Docs</Link>
          <Link to="/docs/changelog">Changelog</Link>
          <Link to="/build">Build</Link>
          <Link to="/ensemble-review">Ensemble review</Link>
          <Link to="/automation">Automation</Link>
          <Link to="/everything-else">Everything else</Link>
        </div>
        <div>
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
          <Link to="/terms">Terms and conditions</Link>
          {/* Hidden when no measurement id is configured: there is no consent to withdraw. */}
          {analyticsConfigured() && (
            <button type="button" onClick={changeCookieChoice}>
              Cookie settings
            </button>
          )}
        </div>
        <p className="c muted">
          Every picture here is drawn in code, from one banded quarter-circle.
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
