import { useCallback, useEffect, useState } from 'react';
import { Link } from '../router';
import { analyticsConfigured, initAnalytics, revokeAnalytics } from '../lib/analytics';
import { consentChoice, onConsentChange, setConsent } from '../lib/consent';
import './chrome.css';

// The consent prompt. Three rules it exists to satisfy (see lib/consent.ts for the
// full reasoning):
//   • It appears BEFORE any analytics runs, not alongside it.
//   • Accept and Decline are the same size, weight and one click each — a "Decline"
//     hidden behind a settings sub-page is not freely-given consent.
//   • It never appears at all when no measurement id is configured, because then
//     there is genuinely nothing to consent to (the local-first / self-hosted case,
//     and every dev build). Showing a cookie banner for cookies you don't set is
//     noise that teaches people to click Accept reflexively.
//
// Not a modal and not a scroll-blocker: it does not trap the page, because refusing
// must not be more costly than accepting.

export default function CookieBanner(): JSX.Element | null {
  // `null` = not yet asked → show. A stored 'granted'/'denied' → stay hidden.
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!analyticsConfigured()) return;
    setVisible(consentChoice() === null);
    // The footer's "Cookie settings" clears the stored choice and fires this event,
    // which brings the banner back so the visitor can change their mind.
    return onConsentChange((choice) => setVisible(choice === null));
  }, []);

  const accept = useCallback(() => {
    setConsent('granted');
    initAnalytics();
    setVisible(false);
  }, []);

  const decline = useCallback(() => {
    setConsent('denied');
    revokeAnalytics();
    setVisible(false);
  }, []);

  if (!visible) return null;

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-label="Cookie choices"
      // One dark tile floating at the bottom (styles: chrome.css, .lb-banner). It
      // covers no more than a strip and blocks nothing, so refusing never feels costly.
      className="lb-banner"
    >
      <p>
        We&apos;d like to use Google Analytics to count page views and see which pages
        people find useful. It sets a cookie and shares your IP address with Google.
        Nothing loads unless you say yes, and the site works exactly the same either
        way.{' '}
        <Link to="/cookies">Cookie policy</Link>
        {' · '}
        <Link to="/privacy">Privacy</Link>
      </p>
      {/* Equal visual weight, deliberately. Decline is not a de-emphasised link:
          both are full board buttons of the same size, one outlined, one filled. */}
      <div className="acts">
        <button type="button" onClick={decline} className="btn alt">
          Decline
        </button>
        <button type="button" onClick={accept} className="btn">
          Accept
        </button>
      </div>
    </div>
  );
}
