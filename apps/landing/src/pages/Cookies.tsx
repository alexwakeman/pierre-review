import { useCallback, useEffect, useState } from 'react';
import { useSeo } from '../lib/seo';
import { seoFor } from '../lib/routes';
import { Link } from '../router';
import {
  resetConsent,
  consentChoice,
  onConsentChange,
  type ConsentChoice,
} from '../lib/consent';
import { revokeAnalytics } from '../lib/analytics';
import { SITE_NAME } from '../lib/site';
import {
  LEGAL_LINK,
  LegalNote,
  LegalPage,
  LegalSection,
  LegalTable,
  Mail,
  P,
  T,
  UL,
} from '../components/legal';

// The cookie policy. Short, specific, and — importantly — it carries a working
// control rather than telling you to go and edit your browser settings. There is no
// sign-in any more, so the whole list is the two analytics cookies, and they only
// exist if the visitor agreed to them.

export default function Cookies(): JSX.Element {
  useSeo(seoFor('/cookies'));

  // Read after mount (the prerender has no storage) and kept current: the banner
  // that "Change my choice" reopens fires the consent event when answered.
  const [current, setCurrent] = useState<ConsentChoice | null>(null);
  useEffect(() => {
    setCurrent(consentChoice());
    return onConsentChange(setCurrent);
  }, []);

  // Clearing the stored choice fires the consent event, which makes the banner
  // reappear so the visitor can answer again. Also stop any already-loaded tag.
  const change = useCallback(() => {
    revokeAnalytics();
    resetConsent();
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
  }, []);

  return (
    <LegalPage
      pigment="verdigris"
      title="Cookie policy"
      intro={
        <>
          <p>
            This site sets two cookies, both for analytics, and only if you agreed to them.
            There is no sign-in, so there is no session cookie.
          </p>
          <div>
            <LegalNote title="Your current choice">
              <p>
                {current === 'granted'
                  ? 'You have accepted analytics cookies.'
                  : current === 'denied'
                    ? 'You have declined analytics cookies. None are set.'
                    : 'You have not made a choice yet, so no analytics cookies are set.'}
              </p>
              <button
                type="button"
                onClick={change}
                className="btn"
              >
                Change my choice
              </button>
            </LegalNote>
          </div>
        </>
      }
    >
      <LegalSection id="list" heading="Every cookie, in full">
        <LegalTable
          label="Every cookie, in full"
          columns={['Name', 'Type', 'Purpose', 'Lifetime']}
          rows={[
            [
              <code>_ga</code>,
              'Analytics — consent required',
              'Google Analytics: distinguishes one visitor from another so page views can be counted.',
              '2 years',
            ],
            [
              <code>_ga_&lt;ID&gt;</code>,
              'Analytics — consent required',
              'Google Analytics: keeps session state for this specific property.',
              '2 years',
            ],
          ]}
        />
        <P>
          The site also uses your browser&apos;s <T>local storage</T> — not a cookie — to
          remember your cookie choice itself. The demo uses local storage the same way the app
          does, for interface preferences. None of it is sent anywhere.
        </P>
      </LegalSection>

      <LegalSection id="analytics" heading="The analytics cookies, and how they behave">
        <UL>
          <li>
            <T>Nothing loads before you agree.</T> Decline, and the Google Analytics script
            is never downloaded — so Google is not contacted at all, not even to be told
            you refused.
          </li>
          <li>
            <T>Declining costs you nothing.</T> Every feature works identically. There is no
            nag, no reduced functionality, and the banner does not come back.
          </li>
          <li>
            <T>Advertising signals are off.</T> Google Signals and ad personalisation are
            explicitly disabled, so the data cannot be joined to an advertising profile or
            used for remarketing.
          </li>
          <li>
            <T>Changing your mind deletes the cookies.</T> Withdrawing consent expires{' '}
            <code>_ga</code> and{' '}
            <code>_ga_&lt;ID&gt;</code> on your device
            immediately and stops all further measurement.
          </li>
        </UL>
        <P>
          Google is the recipient of this data and acts as our processor; the transfer is to
          the United States. See §§2 and 4 of the{' '}
          <Link to="/privacy" className={LEGAL_LINK}>
            privacy policy
          </Link>{' '}
          for the legal detail.
        </P>
      </LegalSection>

      <LegalSection id="app" heading="The app on your machine">
        <P>
          {SITE_NAME} itself runs on your computer. It has no sign-in and no analytics, and it
          sets <T>no cookies whatsoever</T>.
        </P>
      </LegalSection>

      <LegalSection id="browser" heading="Browser-level controls">
        <P>
          You can also block or delete cookies in your browser&apos;s settings, or use
          Google&apos;s own{' '}
          <a
            href="https://tools.google.com/dlpage/gaoptout"
            target="_blank"
            rel="noreferrer noopener"
            className={LEGAL_LINK}
          >
            Analytics opt-out extension
          </a>
          .
        </P>
        <P>
          Questions about any of this: <Mail />.
        </P>
      </LegalSection>
    </LegalPage>
  );
}
