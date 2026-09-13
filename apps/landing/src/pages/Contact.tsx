import { useSeo } from '../lib/seo';
import { seoFor } from '../lib/routes';
import { INSTALL_COMMAND, SITE_NAME } from '../lib/site';
import {
  DashItem,
  MonoLabel,
  RailGrid,
  Section,
  UnderlineLink,
} from '../components/feint/primitives';
import { TierTable } from '../components/feint/TierTable';
import { ContactForm } from '../components/ContactForm';

// ---------------------------------------------------------------------------
// Contact — and, until checkout exists, the way Pro is actually bought.
//
// ⚠ THIS PAGE IS THE PAYMENT PATH. There is no Stripe integration, so every Pro
// call-to-action on the site points here rather than at a checkout that would
// take a card it cannot charge. The offer is genuine and it is stated in the
// first sentence: ask, and Pro is switched on free for a month.
//
// THAT IS A DELIBERATE TRADE AND THE PAGE SAYS WHY. A form is a worse conversion
// step than a card field — but the thing being optimised for right now is
// FEEDBACK from people actually running the product, not revenue, and a
// conversation started by a message is a better start on that than a silent
// subscription. Written as an invitation rather than as an apology for missing
// billing: a reader who has to be told twice that checkout is unfinished stops
// reading.
//
// NO PHONE NUMBER, NO ADDRESS, NO "our team". It is one person answering, the
// page says so, and that is the most useful true thing on it.
//
// ⚠ IT CARRIES THE TIER TABLE, like every other content page, and here that is
// load-bearing rather than consistency: /pricing now RESOLVES TO THIS PAGE (see
// App.tsx and prerender.mjs), so somebody searching for what it costs arrives
// here — and without the table they would find a form and no answer. The table's
// own closing button points back at /contact?topic=pro, which on this page means
// "back to the top, where the form is". That is a return path, not a loop.
// ---------------------------------------------------------------------------

export default function Contact(): JSX.Element {
  useSeo(seoFor('/contact'));

  return (
    <>
      <header className="px-gutter pb-[52px] pt-hero-y">
        <MonoLabel wide className="mb-5 text-secondary">
          Contact
        </MonoLabel>
        <h1 className="mb-6 max-w-[19ch] text-pretty font-display text-hero-sm font-semibold text-ink type:text-page-title">
          Ask, and Pro is on us for a month.
        </h1>
        <p className="mb-[34px] max-w-lede text-pretty text-lede text-ink-soft">
          Card payments are not switched on yet, and rather than hold Pro back until they
          are, we are giving it away for a month to anyone who asks. Send a message, and
          Pro is enabled on your account — every paid surface, no card, nothing to cancel.
        </p>
        <div className="mb-4 flex flex-wrap items-center gap-3.5">
          <UnderlineLink to="/for-developers">What you get, for developers →</UnderlineLink>
          <UnderlineLink to="/for-managers">And for managers →</UnderlineLink>
        </div>
        <p className="mb-11 max-w-reassure font-mono text-mono-nav text-secondary">
          The free tier needs none of this — sign in, or run{' '}
          <span className="text-ink">{INSTALL_COMMAND}</span> on your own machine, and it
          works today.
        </p>
      </header>

      {/* ---------- 01 · the form ---------- */}
      <Section divider="ink">
        <RailGrid rail={{ n: '01', word: 'Message' }}>
          <div className="rail:col-span-2 rail:grid rail:grid-cols-2 rail:gap-grid-gutter">
            <div>
              <ContactForm />
            </div>

            <div className="mt-12 rail:mt-0">
              <h2 className="mb-5 max-w-[24ch] text-pretty font-display text-h3 font-semibold text-ink">
                What happens next
              </h2>
              <ul className="mb-9 flex flex-col gap-3.5 text-ink-body">
                <DashItem>
                  It reaches one person, who replies — usually the same day, and always
                  within two working days.
                </DashItem>
                <DashItem>
                  If you asked for the Pro month, the reply says how it is turned on. There
                  is no card, no invoice and no auto-renewal at the end of it.
                </DashItem>
                <DashItem>
                  If you found something broken, the reply comes from the person who will
                  fix it.
                </DashItem>
                <DashItem>
                  Your email is used to answer you. It is not added to a mailing list and it
                  is not passed to anyone.
                </DashItem>
              </ul>

              <h2 className="mb-5 max-w-[24ch] text-pretty font-display text-h3 font-semibold text-ink">
                Why a month, free
              </h2>
              <p className="mb-4 max-w-answer text-body-sm text-ink-body">
                {SITE_NAME} measures things most teams have never had measured — what a
                fortnight of review actually cost, and what the bots on top of it returned.
                Those readings get better the more estates they are run against, and the
                fastest way to make them better is for people to run them and say what was
                wrong.
              </p>
              <p className="max-w-answer text-body-sm text-ink-body">
                So the month is not a discount waiting to convert. It buys the one thing
                that cannot be bought later: being told what the report got wrong by someone
                who knows their own team.
              </p>
            </div>
          </div>
        </RailGrid>
      </Section>

      {/* ---------- 02 · the other ways ---------- */}
      <Section divider="rule" pad="lg">
        <RailGrid rail={{ n: '02', word: 'Elsewhere' }}>
          <div className="rail:col-span-2">
            <h2 className="mb-5 max-w-[28ch] text-pretty font-display text-h2-sm font-semibold text-ink type:text-h2">
              Or skip the form entirely.
            </h2>
            <p className="mb-4 max-w-answer text-body-sm text-ink-body">
              The whole free tier is open core and it installs in one command. Nothing on
              this page is a gate in front of it —{' '}
              <span className="font-mono text-mono-row text-ink">{INSTALL_COMMAND}</span>{' '}
              runs it against your own repositories using your existing{' '}
              <span className="font-mono text-mono-row text-ink">gh</span> login, stores no
              credentials, and sends nothing anywhere.
            </p>
            <p className="max-w-answer text-body-sm text-ink-body">
              Bugs and feature requests are better as issues than as messages: they are
              public, they are searchable, and somebody else hitting the same thing can add
              to them.
            </p>
          </div>
        </RailGrid>
      </Section>

      <TierTable />
    </>
  );
}
