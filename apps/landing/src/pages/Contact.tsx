import { useSeo } from '../lib/seo';
import { seoFor } from '../lib/routes';
import { DEMO_PATH, FREE_TEAM_SIZE, INSTALL_COMMAND, LICENSE_URL, SITE_NAME } from '../lib/site';
import {
  DashItem,
  MonoLabel,
  RailGrid,
  Section,
  UnderlineLink,
} from '../components/feint/primitives';
import { GetStarted } from '../components/feint/GetStarted';
import { ContactForm } from '../components/ContactForm';

// ---------------------------------------------------------------------------
// Contact — and the way an organisation gets a licence.
//
// Limn is free for individuals, and for organisations where no more than FREE_TEAM_SIZE
// people use it (the Limn License at the repository root). More users than that need a
// commercial licence, and there is no checkout: it starts
// with a message here. So the first sentence says who this page is for, and the
// form opens on the licence topic when the visitor arrives from a licence link
// (`?topic=licence`).
//
// NO PHONE NUMBER, NO ADDRESS, NO "our team". It is one person answering, the
// page says so, and that is the most useful true thing on it.
//
// /pricing RESOLVES TO THIS PAGE (App.tsx and prerender.mjs): somebody asking what it
// costs finds the answer in the first two lines — nothing, unless more than
// FREE_TEAM_SIZE people in the organisation use it.
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
          More than {FREE_TEAM_SIZE} users? Ask for a licence here.
        </h1>
        <p className="mb-[34px] max-w-lede text-pretty text-lede text-ink-soft">
          {SITE_NAME} is free for individuals, and for organisations where no more than{' '}
          {FREE_TEAM_SIZE} people use it. More users than that need a licence. Send a message and we will sort one out. Questions and bug
          reports are welcome here too.
        </p>
        <div className="mb-4 flex flex-wrap items-center gap-3.5">
          <UnderlineLink to={DEMO_PATH}>Try the demo first →</UnderlineLink>
          <UnderlineLink to={LICENSE_URL}>Read the licence →</UnderlineLink>
        </div>
        <p className="mb-11 max-w-reassure font-mono text-mono-nav text-secondary">
          Using it on your own, or no more than {FREE_TEAM_SIZE} people in your organisation use
          it? You need none of this —
          run <span className="text-ink">{INSTALL_COMMAND}</span> and it works today.
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
                  If you asked about a licence, the reply says what it covers and what it
                  costs for the size of your organisation.
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
                Who needs a licence
              </h2>
              <p className="mb-4 max-w-answer text-body-sm text-ink-body">
                Count the people in your organisation who use {SITE_NAME}. Up to{' '}
                {FREE_TEAM_SIZE}, it is free. More than {FREE_TEAM_SIZE}, the organisation needs
                a licence.
              </p>
              <p className="max-w-answer text-body-sm text-ink-body">
                The full terms are in the Limn License, published with the source.
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
              Nothing on this page is a gate in front of the app.{' '}
              <span className="font-mono text-mono-row text-ink">{INSTALL_COMMAND}</span>{' '}
              runs it against your own repositories using your existing{' '}
              <span className="font-mono text-mono-row text-ink">gh</span> login, stores no
              credentials, and sends nothing to us.
            </p>
            <p className="max-w-answer text-body-sm text-ink-body">
              Bugs and feature requests are better as issues than as messages: they are
              public, they are searchable, and somebody else hitting the same thing can add
              to them.
            </p>
          </div>
        </RailGrid>
      </Section>

      <GetStarted />
    </>
  );
}
