import { useCallback } from 'react';
import { Link } from '../router';
import { resetConsent } from '../lib/consent';
import { analyticsConfigured, revokeAnalytics } from '../lib/analytics';
import { ARCADE_ENABLED, ARCADE_PATH, REPO_URL, SITE_NAME } from '../lib/site';

// ---------------------------------------------------------------------------
// The footer, condensed to two mono lines — a © line with a link row, and the
// desktop-today note. It replaced five columns of nineteen links.
//
// DELIBERATELY WIDER THAN THE MOCK. The design's pricing footer carries no links
// at all and its home footer carries four; two of the links that drops are
// compliance rather than decoration:
//
//   · "Cookie settings" is the consent-WITHDRAWAL control. GDPR requires
//     withdrawal to be as easy as granting and reachable from a persistent
//     place — not only from a banner that has already been dismissed.
//   · /cookies and /terms must stay reachable from every page.
//
// The design README explicitly permits this ("the full existing footer link
// columns can be restored from the live site; the mock shows the condensed
// form"), so this keeps the condensed FORM and restores the required links.
// ---------------------------------------------------------------------------

const FADE = 'transition-colors duration-hover ease-standard';
const FOCUS =
  'focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink';
const LINK = `hover:text-ink ${FADE} ${FOCUS}`;

export default function Footer(): JSX.Element {
  // Clearing the stored choice re-shows the banner (CookieBanner listens for the
  // consent event). Hidden entirely when no measurement id is configured, since
  // then there is genuinely no consent to withdraw.
  const changeCookieChoice = useCallback(() => {
    revokeAnalytics();
    resetConsent();
  }, []);

  return (
    <footer className="border-t border-rule px-gutter py-[26px] font-mono text-mono-caption text-secondary">
      <div className="flex flex-wrap items-baseline justify-between gap-x-8 gap-y-3">
        <span>© 2026 {SITE_NAME}. Built for sprint situational awareness.</span>

        <span className="flex flex-wrap items-baseline gap-x-5 gap-y-2">
          {ARCADE_ENABLED && (
            <Link to={ARCADE_PATH} className={LINK}>
              Inbox Invaders
            </Link>
          )}
          <a
            href={REPO_URL}
            target="_blank"
            rel="noreferrer noopener"
            className={LINK}
          >
            GitHub
          </a>
          <Link to="/privacy" className={LINK}>
            Privacy
          </Link>
          <Link to="/cookies" className={LINK}>
            Cookies
          </Link>
          <Link to="/terms" className={LINK}>
            Terms
          </Link>
          {analyticsConfigured() && (
            <button type="button" onClick={changeCookieChoice} className={LINK}>
              Cookie settings
            </button>
          )}
        </span>
      </div>

      <p className="mt-4 max-w-caption">
        {SITE_NAME} is a desktop experience today — a phone-friendly build is on the{' '}
        <Link
          to="/how-it-works#roadmap"
          className={`border-b border-rule-strong text-nav-idle ${LINK}`}
        >
          roadmap
        </Link>
        .
      </p>
    </footer>
  );
}
