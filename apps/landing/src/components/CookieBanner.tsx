import { useCallback, useEffect, useState } from 'react';
import { InlineLink } from './feint/primitives';
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
      // A ruled strip on paper, not a floating card: no radius, no shadow, no
      // backdrop blur. It reads as a footnote to the page rather than an overlay
      // on top of it, which is the whole point — refusing must not feel costly.
      className="fixed inset-x-0 bottom-0 z-50 border-t border-ink bg-paper"
    >
      <div className="mx-auto flex max-w-canvas flex-col gap-5 px-gutter py-5 rail:flex-row rail:items-center rail:justify-between">
        <p className="max-w-answer text-list">
          We&apos;d like to use Google Analytics to count page views and see which pages
          people find useful. It sets a cookie and shares your IP address with Google.
          Nothing loads unless you say yes, and the site works exactly the same either
          way.{' '}
          <InlineLink to="/cookies">Cookie policy</InlineLink>
          {' · '}
          <InlineLink to="/privacy">Privacy</InlineLink>
        </p>
        {/* Equal visual weight, deliberately. Decline is not a de-emphasised link. */}
        <div className="flex shrink-0 gap-3">
          <button
            type="button"
            onClick={decline}
            className={`${BTN} border border-ink text-ink hover:bg-ink hover:text-paper`}
          >
            Decline
          </button>
          <button
            type="button"
            onClick={accept}
            className={`${BTN} border border-ink bg-ink text-paper hover:bg-[#08080A]`}
          >
            Accept
          </button>
        </div>
      </div>
    </div>
  );
}

const BTN =
  'px-5 py-2.5 font-display text-[15px] font-semibold transition-colors duration-hover ease-standard focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink';
