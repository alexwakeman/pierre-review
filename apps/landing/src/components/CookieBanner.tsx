import { useCallback, useEffect, useState } from 'react';
import { Link } from '../router';
import { analyticsConfigured, initAnalytics, revokeAnalytics } from '../lib/analytics';
import { consentChoice, onConsentChange, setConsent } from '../lib/consent';

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
      className="fixed inset-x-0 bottom-0 z-50 border-t border-white/10 bg-gray-950/95 backdrop-blur supports-[backdrop-filter]:bg-gray-950/80"
    >
      <div className="mx-auto flex max-w-4xl flex-col gap-4 px-5 py-4 sm:px-6 md:flex-row md:items-center md:justify-between">
        <p className="text-sm leading-relaxed text-gray-300">
          We&apos;d like to use Google Analytics to count page views and see which pages
          people find useful. It sets a cookie and shares your IP address with Google.
          Nothing loads unless you say yes, and the site works exactly the same either
          way.{' '}
          <Link to="/cookies" className="text-brand-sky underline hover:text-sky-300">
            Cookie policy
          </Link>
          {' · '}
          <Link to="/privacy" className="text-brand-sky underline hover:text-sky-300">
            Privacy
          </Link>
        </p>
        <div className="flex shrink-0 gap-2.5">
          {/* Equal visual weight, deliberately. Decline is not a de-emphasised link. */}
          <button
            type="button"
            onClick={decline}
            className="flex-1 rounded-lg border border-white/15 bg-white/5 px-4 py-2 text-sm font-semibold text-gray-200 transition hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-sky md:flex-none"
          >
            Decline
          </button>
          <button
            type="button"
            onClick={accept}
            className="flex-1 rounded-lg border border-white/15 bg-white/10 px-4 py-2 text-sm font-semibold text-white transition hover:bg-white/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-sky md:flex-none"
          >
            Accept
          </button>
        </div>
      </div>
    </div>
  );
}
