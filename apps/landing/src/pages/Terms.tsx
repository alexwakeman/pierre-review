import { useSeo } from '../lib/seo';
import { seoFor } from '../lib/routes';
import { Link } from '../router';
import { DEMO_PATH, FREE_TEAM_SIZE, INSTALL_COMMAND, LICENSE_URL, SITE_NAME } from '../lib/site';
import {
  LEGAL_CONTROLLER,
  LegalNote,
  LegalPage,
  LegalSection,
  Mail,
  P,
  T,
  UL,
} from '../components/legal';

// Terms of use. Kept short and readable.
//
// There is no hosted service any more, so there are no accounts, no billing and no
// service levels to describe. What is left: this website (marketing pages, the demo,
// the contact form), and the software itself — which is governed by the Limn License
// at the repository root, NOT by this page. §3 summarises that licence and says the
// licence wins; FREE_TEAM_SIZE mirrors it.
//
// The two clauses that genuinely matter are §4 (you are responsible for what you point
// Limn at, because it reads repositories with your token) and §5 (AI output is a
// suggestion, not a review you can rely on).

const LINK =
  'border-b border-signal-fill text-ink transition-colors duration-hover ease-standard hover:text-signal-text';

export default function Terms(): JSX.Element {
  useSeo(seoFor('/terms'));

  return (
    <LegalPage
      title="Terms of use"
      intro={
        <>
          <p>
            These terms cover this website, <span className="font-mono text-ink">limn-review.com</span>,
            and the {SITE_NAME} software you install from npm. There is no hosted version of{' '}
            {SITE_NAME} and no account to sign up for.
          </p>
          <div className="mt-5">
            <LegalNote title="The software is licensed under the Limn License">
              <p>
                Your right to use the software comes from the{' '}
                <a href={LICENSE_URL} target="_blank" rel="noreferrer noopener" className={LINK}>
                  Limn License
                </a>
                , published with the source. It is free for individuals and for organisations
                where no more than {FREE_TEAM_SIZE} people use it. Above that, the organisation
                needs a commercial licence. §3 summarises it; where the two differ, the licence
                wins.
              </p>
            </LegalNote>
          </div>
        </>
      }
    >
      <LegalSection id="who" heading="1. Who you are dealing with">
        <P>
          {SITE_NAME} is made by <T>{LEGAL_CONTROLLER}</T>, a sole trader in the United
          Kingdom, contactable at <Mail />. These terms are governed by the laws of England
          and Wales, and the courts of England and Wales have exclusive jurisdiction.
        </P>
      </LegalSection>

      <LegalSection id="what" heading="2. What Limn is">
        <P>
          {SITE_NAME} is software that runs on your own computer. You install and start it with{' '}
          <span className="font-mono text-ink">{INSTALL_COMMAND}</span>. It reads pull-request
          activity from the GitHub repositories you choose, using your own GitHub login, and
          stores it in a file on your machine. We do not run a server for it and we receive
          none of that data.
        </P>
        <P>
          This website has three parts: the pages describing {SITE_NAME}, a{' '}
          <Link to={DEMO_PATH} className={LINK}>
            demo
          </Link>{' '}
          that runs in your browser on invented sample data, and a{' '}
          <Link to="/contact" className={LINK}>
            contact form
          </Link>
          .
        </P>
      </LegalSection>

      <LegalSection id="licence" heading="3. The licence, in short">
        <UL>
          <li>
            <T>Free for individuals</T>, and for any organisation where no more than{' '}
            {FREE_TEAM_SIZE} people use {SITE_NAME}.
          </li>
          <li>
            <T>More users than that</T> (affiliates count together) need a commercial
            licence. Ask through the{' '}
            <Link to="/contact?topic=licence" className={LINK}>
              contact form
            </Link>
            .
          </li>
          <li>
            <T>No competing product.</T> You may not use {SITE_NAME}, or its source, to build or
            offer a product that competes with it.
          </li>
        </UL>
        <P>
          This is a summary for convenience. The{' '}
          <a href={LICENSE_URL} target="_blank" rel="noreferrer noopener" className={LINK}>
            Limn License
          </a>{' '}
          is the binding text.
        </P>
      </LegalSection>

      <LegalSection id="responsibility" heading="4. What you are responsible for">
        <P>
          {SITE_NAME} reads GitHub using <em>your</em> access token, so it can reach whatever you
          can reach.{' '}
          <T>You are responsible for having the right to access every repository you add</T>,
          and for following your employer&apos;s or client&apos;s rules about where that data
          may be copied and whether it may be sent to an AI model.
        </P>
        <P>
          The AI features run on your own Claude Code login or Anthropic API key. Content they
          send goes from your machine to Anthropic under your own agreement with Anthropic. We
          are not in that path.
        </P>
        <P>On this website, you agree not to:</P>
        <UL>
          <li>probe, scan or overload the site (security research is welcome — see §7);</li>
          <li>use the contact form to send spam or anything unlawful.</li>
        </UL>
      </LegalSection>

      <LegalSection id="ai" heading="5. AI output — read this one">
        <P>
          AI-written reviews, fixes, notes and plans are <T>suggestions produced by a language
          model</T>. They can be confidently wrong: they miss real bugs, invent problems that
          do not exist, and misread intent. Nothing {SITE_NAME} generates replaces human
          review. A review is posted, and a fix pushed, only when you press the button or
          switch on the automatic setting yourself.
        </P>
        <P>
          You are responsible for anything you post, merge or act on. We accept no liability
          for a defect an AI review failed to find, or for a change made on the strength of
          one.
        </P>
      </LegalSection>

      <LegalSection id="liability" heading="6. No warranty, and liability">
        <P>
          {SITE_NAME} and this website are provided <T>as is</T>, with no warranty of any kind,
          including merchantability, fitness for a particular purpose and non-infringement.
          GitHub is the system of record; everything {SITE_NAME} holds can be synced again from
          there.
        </P>
        <P>
          To the fullest extent the law allows, we are not liable for indirect or
          consequential loss, lost profits, lost data or business interruption. Nothing here
          limits liability for death or personal injury caused by negligence, for fraud, or
          for anything else that cannot lawfully be limited — and if you are a consumer, your
          statutory rights are unaffected.
        </P>
      </LegalSection>

      <LegalSection id="security" heading="7. Security reports">
        <P>
          Found a security problem? Report it privately to <Mail /> rather than opening a
          public issue. We will not pursue good-faith testing that does not degrade the site
          or touch anyone else&apos;s data.
        </P>
      </LegalSection>

      <LegalSection id="changes" heading="8. Changes to these terms">
        <P>
          We will update the date at the top when these terms change. Every revision is in the
          public git history.
        </P>
      </LegalSection>
    </LegalPage>
  );
}
