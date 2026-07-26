import { useSeo } from '../lib/seo';
import { Link } from '../router';
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

// Terms of service for the hosted app. Kept deliberately short and readable — this
// is a £4/month developer tool run by one person, and a twelve-page indemnity clause
// would be both unenforceable and dishonest about the scale of the thing.
//
// The two clauses that genuinely matter here are §5 (you are responsible for what you
// point Pierre at, because it reads other people's repositories with your token) and
// §7 (AI output is a suggestion, not a review you can rely on).

export default function Terms(): JSX.Element {
  useSeo({
    title: 'Terms of service — Pierre',
    description:
      'The terms for using the hosted Pierre service: what you get, what you are responsible for, billing and cancellation, and the limits of liability.',
    path: '/terms',
  });

  return (
    <LegalPage
      title="Terms of service"
      intro={
        <>
          <p>
            These terms cover the hosted service at{' '}
            <span className="font-mono text-gray-200">pierre-review.com</span>. By signing
            in you agree to them.
          </p>
          <div className="mt-5">
            <LegalNote title="The self-hosted code is under a different licence, not these terms">
              <p>
                Pierre&apos;s source is published under the Functional Source Licence
                (FSL-1.1-MIT), which converts to MIT two years after each release. If you
                clone the repository and run it yourself, that licence governs — not this
                document. These terms only apply to the version we host for you.
              </p>
            </LegalNote>
          </div>
        </>
      }
    >
      <LegalSection id="who" heading="1. Who you are contracting with">
        <P>
          The service is provided by <T>{LEGAL_CONTROLLER}</T>, a sole trader in the United
          Kingdom, contactable at <Mail />. These terms are governed by the laws of England
          and Wales, and the courts of England and Wales have exclusive jurisdiction.
        </P>
        <P>
          You must be at least 16 years old and have a GitHub account to use the service.
        </P>
      </LegalSection>

      <LegalSection id="service" heading="2. What the service does">
        <P>
          Pierre reads pull-request activity from GitHub repositories you nominate and
          presents it as a dashboard. Some features send content to an AI model to produce
          summaries or reviews. The{' '}
          <Link to="/features" className="text-brand-sky underline hover:text-sky-300">
            features
          </Link>{' '}
          and{' '}
          <Link to="/pricing" className="text-brand-sky underline hover:text-sky-300">
            pricing
          </Link>{' '}
          pages describe what is included at each tier.
        </P>
        <P>
          We may change, add or remove features. If a change materially reduces what a paid
          plan provides, we will tell paying users before it takes effect.
        </P>
      </LegalSection>

      <LegalSection id="account" heading="3. Your account">
        <P>
          You are responsible for activity under your account, and for keeping your GitHub
          account secure — anyone who controls your GitHub login can sign in to Pierre as
          you. Tell us at <Mail /> if you believe your account has been misused.
        </P>
        <P>
          You can delete your account at any time from Settings → Your data. Deletion is
          immediate and irreversible.
        </P>
      </LegalSection>

      <LegalSection id="billing" heading="4. Paying for Pro">
        <UL>
          <li>
            Pro is billed monthly in advance through <T>Stripe</T>, which handles all
            payment details. We never see your card number.
          </li>
          <li>
            AI features carry a monthly allowance. When it is used up, AI generation stops
            until the allowance resets at the start of the next month — it does not
            silently keep spending, and you are never billed for overage without asking.
          </li>
          <li>
            <T>Cancel any time.</T> Cancellation takes effect at the end of the period you
            have already paid for; there is no lock-in and no cancellation fee.
          </li>
          <li>
            We do not offer pro-rata refunds for a partial month, but if something went
            genuinely wrong, email <Mail /> and we will sort it out.
          </li>
          <li>
            If a payment fails, Pro features stop and the account falls back to the free
            tier. Your data is not deleted.
          </li>
          <li>
            Prices may change with at least 30 days&apos; notice; the new price applies from
            your next renewal.
          </li>
        </UL>
      </LegalSection>

      <LegalSection id="acceptable" heading="5. What you must not do">
        <P>
          The important one first: Pierre reads GitHub using <em>your</em> access token, so
          it can reach whatever you can reach.{' '}
          <T>
            You are responsible for having the right to access every repository you add
          </T>
          , and for complying with your employer&apos;s or client&apos;s policies about where
          that data may be copied and whether it may be sent to an AI model. Adding a
          repository you are not authorised to export is your breach, not ours.
        </P>
        <P>You also agree not to:</P>
        <UL>
          <li>
            attempt to access another account&apos;s data, or probe, scan or overload the
            service (security research is welcome — see §9);
          </li>
          <li>
            circumvent the plan limits, credit allowances or rate limits, or automate the
            AI features to consume allowance in bulk;
          </li>
          <li>use the service to break the law, or in breach of GitHub&apos;s own terms;</li>
          <li>resell the hosted service as your own.</li>
        </UL>
        <P>
          We may suspend an account that is causing harm to the service or to others. Where
          it is reasonable to do so, we will contact you first.
        </P>
      </LegalSection>

      <LegalSection id="your-data" heading="6. Your data">
        <P>
          You keep all rights in your code and your repository content. We claim no
          ownership and no licence beyond what is needed to run the features you use — store
          it, display it back to you, and pass it to the processors listed in the{' '}
          <Link to="/privacy" className="text-brand-sky underline hover:text-sky-300">
            privacy policy
          </Link>
          . We do not use your code or comments to train any model.
        </P>
      </LegalSection>

      <LegalSection id="ai" heading="7. AI output — read this one">
        <P>
          AI-generated summaries, insights and reviews are <T>suggestions produced by a
          language model</T>. They can be confidently wrong: they miss real bugs, invent
          problems that do not exist, and misread intent. Nothing Pierre generates is a
          substitute for human review, and no AI review is ever posted to GitHub without you
          reading it and pressing the button.
        </P>
        <P>
          You are responsible for anything you post, merge or act on. We accept no liability
          for a defect an AI review failed to find, or for a change made on the strength of
          one.
        </P>
      </LegalSection>

      <LegalSection id="availability" heading="8. Availability">
        <P>
          The service is provided on an <T>as-is, as-available</T> basis, with no uptime
          guarantee and no service-level agreement. It is a small independent product: there
          will be maintenance, and occasionally there will be outages. Data is stored
          durably by our hosting provider, but <T>you should not treat Pierre as the system
          of record</T> — GitHub is. Everything Pierre holds can be re-synced from there.
        </P>
      </LegalSection>

      <LegalSection id="liability" heading="9. Liability">
        <P>
          To the fullest extent the law allows, we exclude the implied warranties of
          merchantability, fitness for a particular purpose and non-infringement. We are not
          liable for indirect or consequential loss, lost profits, lost data or business
          interruption.
        </P>
        <P>
          Where liability cannot be excluded, it is capped at the greater of the amount you
          paid us in the twelve months before the claim, or £50. Nothing here limits
          liability for death or personal injury caused by negligence, for fraud, or for
          anything else that cannot lawfully be limited — and if you are a consumer, your
          statutory rights are unaffected.
        </P>
        <P>
          Found a security problem? Report it privately to <Mail /> and we will not pursue
          you for good-faith testing that respects other users&apos; data and does not
          degrade the service.
        </P>
      </LegalSection>

      <LegalSection id="termination" heading="10. Ending it">
        <P>
          You may stop using the service and delete your account at any time. We may
          terminate or suspend access for a material breach of these terms, or with 30
          days&apos; notice if we discontinue the hosted service — in which case we will
          refund any period you have paid for in advance and give you time to export your
          data.
        </P>
      </LegalSection>

      <LegalSection id="changes" heading="11. Changes to these terms">
        <P>
          We will update the date at the top when these terms change, and give paying users
          notice of anything material. Continuing to use the service after a change means
          you accept it. Every revision is in the public git history.
        </P>
      </LegalSection>
    </LegalPage>
  );
}
