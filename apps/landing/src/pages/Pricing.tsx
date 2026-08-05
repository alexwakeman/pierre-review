import { useEffect, useState } from 'react';
import { useSeo } from '../lib/seo';
import { seoFor } from '../lib/routes';
import { INSTALL_COMMAND, SITE_NAME } from '../lib/site';
import {
  InlineLink,
  MonoLabel,
  MonoLink,
  OutlineButton,
  RailGrid,
  RuledItem,
  Section,
  SignalButton,
} from '../components/feint/primitives';
import { TerminalPanel } from '../components/feint/Terminal';
import { PixelIcon } from '../components/feint/PixelIcon';

// ---------------------------------------------------------------------------
// The pricing page — three tiers, one hairline of promotion.
//
// Free sits under a 1px ink rule, Pro under the single vermilion rule (the
// entire visual promotion of the recommended tier), Pro+ under ink again. No
// card, no fill, no badge, no shadow, no "most popular" ribbon. Feature lists
// are rule-separated rows — no ticks, no icons.
//
// THE MODEL: per SEAT, per month, billed annually — Pro $15 ($19 month-to-
// month), Pro+ $29 ($35 month-to-month). A seat is someone who signs in;
// watchers and leads count, bots never do. Pro+ is BYO Anthropic key: the
// model spend is the customer's, at cost, which is why a flat price can carry
// unlimited agentic use without a metering trap.
//
// PRICE COPIES, kept in lockstep by hand: "fifteen dollars" in the H1, the
// three numerals + month-to-month notes in the tier table, the Home §08
// mini-table, the Pro page's hero pills and CTA, ROUTE_SEO['/pricing'], and
// the JSON-LD AggregateOffer in index.html — which ships on EVERY prerendered
// page, not just this one.
// ---------------------------------------------------------------------------

const FREE_FEATURES = [
  'Unlimited repos & contributors',
  `Activity console + cross-repo feed — the view ${SITE_NAME} opens on`,
  'The timeline board — repos down the side, time across the top',
  'The bot receipt — severity, category, cost & overlap from an independent ML model (hosted today; coming to the local install)',
  'Review-thread states — resolved / likely addressed / replied / untouched',
  'PR detail with inline diffs, CI logs and suggested reviewers',
  `Reply, resolve, approve, request reviewers, rebase & merge from ${SITE_NAME}`,
  'Cross-repo search, workspaces & comparison metrics',
  `Runs 100% local — ${INSTALL_COMMAND}, your data never leaves your machine`,
];

const PRO_FEATURES = [
  'Attention & risk digests — what the bots posted, what was acted on, which threads need a human',
  'Thread validity checks, inline while you review',
  '“Was this addressed?” — immediate, with a confidence gauge',
  'Themes & reports across human and bot reviews, by severity',
  'Chat with your repos + ad-hoc charts — pin the keepers, re-run past reports',
  'CI failures summarised to root cause, inline',
  'Reviewer suggestions from commit history — requested in one click',
  'Flow metrics with drill-downs · Slack digests · Jira & Linear links',
];

const PROPLUS_FEATURES = [
  'Everything in Pro',
  'Claude Review — context-aware, deep or quick, routed automatically',
  'Review memory — every run learns from what you kept, cut and reworded',
  'Reword or simplify any finding — post one review, in your voice',
  'AI Fix — pick the comments that matter, review the diff, push',
  'CI auto-fix — diagnosis to pushed fix in two clicks',
  'Runs on your Anthropic key — your models, your spend, metered in-app',
];

const FAQ: { q: string; a: string }[] = [
  {
    q: 'Is free really free?',
    a: `Yes. ${SITE_NAME} is open-core: the free dashboard is the product, not a trial. The Activity feed, the timeline, PR detail with real GitHub write actions, the bot receipt — all of it stays free, with no repo or seat limits. The paid tiers add layers on top.`,
  },
  {
    q: 'Why is the bot grading free?',
    a: `Because a measurement you have to pay for is a measurement you'd doubt. The grading model is ${SITE_NAME}'s own and runs on plain CPU — no LLM meter — so it costs next to nothing to serve, and the paid tiers are the layers on top of the ruler, never the ruler itself. It runs in the hosted service today; grading in the local install is on the roadmap.`,
  },
  {
    q: 'What counts as a seat?',
    a: 'Anyone who signs in. The lead who only watches counts; the bot never does. Seats are reassignable, so a departure doesn’t strand one.',
  },
  {
    q: 'Do I need an Anthropic key?',
    a: 'Only for Pro+ — Claude Review and AI Fix run on your own Anthropic API key, with usage metered transparently in-app. Everything in Pro (digests, validity, themes, chat, CI diagnosis) is included in the subscription, no key needed.',
  },
  {
    q: 'Do you rank my engineers?',
    a: 'No. Everything is team- and process-grain: bots get graded, people don’t. Mirrors, not scorecards — by design, not as a setting.',
  },
  {
    q: 'What happens if my payment fails?',
    a: 'You drop to Free, gracefully. Nothing is deleted, nothing locks you out of your data — you keep the whole dashboard, receipt included, and lose only the paid layers until billing is sorted.',
  },
  {
    q: 'Do you train on my code?',
    a: `Never. Your data is yours — private and confidential, forever. ${SITE_NAME} never trains on it, never shares it, and in local mode it never even leaves your machine. The grading model was trained on public GitHub bot reviews, not on you.`,
  },
  {
    q: 'Can I self-host?',
    a: `The Open Core tier, fully — ${INSTALL_COMMAND} runs the whole free dashboard on your machine, and the multi-tenant cloud deployment is self-hostable too. Pro and Pro+ are subscriptions that unlock on any deployment as the hosted rollout lands.`,
  },
];

/**
 * One FAQ row. Native <details>/<summary>, so keyboard support and the no-JS
 * case are free and there is no custom accordion to maintain. The +/− swaps via
 * the `group-open:` variant — no state, no JS.
 */
function FaqRow({ q, a, open }: { q: string; a: string; open?: boolean }): JSX.Element {
  return (
    <details className="group border-b border-rule" open={open}>
      <summary className="flex items-baseline justify-between gap-6 py-5 font-display text-[20px] font-semibold text-ink">
        {q}
        <span aria-hidden="true" className="shrink-0 font-mono text-[14px] text-signal-text">
          <span className="group-open:hidden">+</span>
          <span className="hidden group-open:inline">−</span>
        </span>
      </summary>
      <p className="mb-[22px] max-w-answer text-body-sm">{a}</p>
    </details>
  );
}

export default function Pricing(): JSX.Element {
  useSeo(seoFor('/pricing'));

  // The checkout endpoint bounces back here with ?checkout=unavailable while
  // hosted billing is still rolling out.
  const [checkoutUnavailable, setCheckoutUnavailable] = useState(false);
  useEffect(() => {
    setCheckoutUnavailable(
      new URLSearchParams(window.location.search).get('checkout') === 'unavailable',
    );
  }, []);

  return (
    <>
      {/* ---------- hero ---------- */}
      <Section divider="none" pad="none" className="pb-12 pt-20">
        <RailGrid rail={{ word: 'Pricing' }} cols="one">
          <div>
            <h1 className="mb-6 max-w-[24ch] text-pretty font-display text-hero-sm font-semibold text-ink type:text-page-title">
              Open-core and free. Pro from{' '}
              <span className="text-signal-text">fifteen dollars</span> a seat.
            </h1>
            <p className="max-w-[58ch] text-lede">
              The dashboard is free, local-first, and yours forever — and the bot receipt
              is free with a hosted sign-in. Pro reads the board for you; Pro+ closes the
              loop with Claude. Each costs less than the review-bot seat it audits.
            </p>

            {checkoutUnavailable && (
              <p
                role="status"
                className="mt-8 border-y border-rule py-3.5 font-mono text-mono-nav text-ink-soft"
              >
                <span className="mr-3 text-mono-label uppercase text-signal-text">
                  Heads up
                </span>
                Checkout isn’t live yet — the paid tiers are rolling out; run it locally
                today.
              </p>
            )}
          </div>
        </RailGrid>
      </Section>

      {/* ---------- tiers ----------
          Free and Pro+ under ink hairlines, Pro under the vermilion one. That
          single rule is the whole promotion of the recommended tier. */}
      <Section divider="none" pad="none" className="pb-section-y">
        <RailGrid rail={{ word: 'Tiers' }} cols="one">
          <div>
            <div className="grid gap-grid-gutter rail:grid-cols-3">
              {/* Free */}
              <div className="border-t border-ink pt-[26px]">
                <div className="mb-1 flex items-baseline justify-between gap-4">
                  <h2 className="font-display text-[30px] font-semibold tracking-[-0.02em] text-ink">
                    Free
                  </h2>
                  <MonoLabel className="text-secondary">Open core</MonoLabel>
                </div>
                <div className="mb-1 mt-[22px] font-display text-price font-semibold text-ink">
                  $0
                </div>
                <MonoLabel className="mb-6 text-secondary">forever</MonoLabel>
                <p className="mb-6 text-body-sm">
                  Everything you need to see your team — and your bots — clearly.
                </p>

                <ul className="mb-7 flex flex-col">
                  {FREE_FEATURES.map((f, i) => (
                    <RuledItem key={f} last={i === FREE_FEATURES.length - 1}>
                      {f}
                    </RuledItem>
                  ))}
                </ul>

                <TerminalPanel command={INSTALL_COMMAND} size="sm" className="mb-4" />
                <p className="font-mono text-mono-nav text-secondary">
                  Or <InlineLink to="/api/auth/login">sign in with GitHub</InlineLink>.
                </p>
              </div>

              {/* Pro */}
              <div className="border-t border-signal-fill pt-[26px]">
                <div className="mb-1 flex items-baseline justify-between gap-4">
                  <h2 className="font-display text-[30px] font-semibold tracking-[-0.02em] text-ink">
                    Pro
                  </h2>
                  <MonoLabel className="text-signal-text">The intelligence layer</MonoLabel>
                </div>
                {/* 46px display type, so `signal-text` is not required for contrast —
                    but it carries meaning here, and the darker stop is the one that
                    is legible at every size. */}
                <div className="mb-1 mt-[22px] font-display text-price font-semibold text-signal-text">
                  $15
                </div>
                <MonoLabel className="mb-6 text-secondary">
                  per seat / month · billed annually · $19 monthly
                </MonoLabel>
                <p className="mb-6 text-body-sm">
                  Everything in Free, read for you: judgement on top of the receipt.
                </p>

                <ul className="mb-7 flex flex-col">
                  {PRO_FEATURES.map((f, i) => (
                    <RuledItem key={f} last={i === PRO_FEATURES.length - 1}>
                      {f}
                    </RuledItem>
                  ))}
                </ul>

                <SignalButton
                  to="/api/billing/checkout"
                  className="mb-4 w-full py-4 text-center"
                >
                  Get Pro
                </SignalButton>
                <p className="font-mono text-mono-caption text-secondary">
                  Billing via Stripe · cancel any time · a declined card downgrades you
                  gracefully to Free — nothing is deleted.
                </p>
              </div>

              {/* Pro+ */}
              <div className="border-t border-ink pt-[26px]">
                <div className="mb-1 flex items-baseline justify-between gap-4">
                  <h2 className="font-display text-[30px] font-semibold tracking-[-0.02em] text-ink">
                    Pro+
                  </h2>
                  <MonoLabel className="text-secondary">The full loop</MonoLabel>
                </div>
                <div className="mb-1 mt-[22px] font-display text-price font-semibold text-ink">
                  $29
                </div>
                <MonoLabel className="mb-6 text-secondary">
                  per seat / month · billed annually · $35 monthly
                </MonoLabel>
                <p className="mb-6 text-body-sm">
                  Everything in Pro, plus the agentic loop — review, fix, push, one app.
                </p>

                <ul className="mb-7 flex flex-col">
                  {PROPLUS_FEATURES.map((f, i) => (
                    <RuledItem key={f} last={i === PROPLUS_FEATURES.length - 1}>
                      {f}
                    </RuledItem>
                  ))}
                </ul>

                <OutlineButton
                  to="/api/billing/checkout"
                  className="mb-4 w-full py-4 text-center"
                >
                  Get Pro+
                </OutlineButton>
                <p className="font-mono text-mono-caption text-secondary">
                  BYO Anthropic key — the model spend is yours, at cost, metered
                  transparently in-app. No surprise bills.
                </p>
              </div>
            </div>

            {/* The seat, defined once, under the whole table. */}
            <p className="mt-8 border-t border-rule pt-4 font-mono text-mono-nav text-secondary">
              A seat is someone who signs in — watchers and leads count, bots never do.
              Reassign freely.
            </p>
          </div>
        </RailGrid>
      </Section>

      {/* ---------- Pro+ · your key ---------- */}
      <Section tone="alt" pad="none" className="py-16">
        <RailGrid rail={{ word: 'Your key' }} cols="one">
          <div>
            <PixelIcon name="key" className="mb-5" />
            <h2 className="mb-5 font-display text-h2-sm font-semibold text-ink type:text-h2-minor">
              Pro+ runs on your Claude. That’s the point.
            </h2>
            <p className="mb-9 max-w-answer text-body-sm">
              Claude Review and AI Fix spend real model tokens on your code. On your own
              key that spend is yours at API list price, metered in-app — {SITE_NAME}{' '}
              never marks it up, never caps a heavy week, and never has your code
              transiting anyone’s account but yours. Claude Sonnet 5 by default; Opus 4.8
              for the hardest runs; Haiku 4.5 for quick passes.
            </p>
            <MonoLink to="/pro#claude-review">How the agentic loop works →</MonoLink>
          </div>
        </RailGrid>
      </Section>

      {/* ---------- why $15 ---------- */}
      <Section pad="none" className="py-16">
        <RailGrid rail={{ word: 'Why $15' }} cols="one">
          <div>
            <PixelIcon name="coin" className="mb-5" />
            <h2 className="mb-5 max-w-[32ch] font-display text-h2-sm font-semibold text-ink type:text-h2-minor">
              Review bots run $24–30 a seat and add comments. {SITE_NAME} adds{' '}
              <span className="text-signal-text">signal</span>.
            </h2>
            <p className="max-w-[58ch] text-lede">
              We’re not selling another reviewer. Pro is half the price of the bot seat it
              audits — and the receipt tends to pay for itself the first time you tune, or
              cancel, a noisy bot.
            </p>
          </div>
        </RailGrid>
      </Section>

      {/* ---------- FAQ ---------- */}
      <Section pad="none" className="py-16">
        <RailGrid rail={{ word: 'FAQ' }} cols="one">
          <div>
            <PixelIcon name="question" className="mb-5" />
            <h2 className="mb-[30px] font-display text-h2-sm font-semibold text-ink type:text-h2-minor">
              The questions worth asking before paying anyone.
            </h2>
            <div className="flex flex-col border-t border-ink">
              {FAQ.map((item, i) => (
                <FaqRow key={item.q} q={item.q} a={item.a} open={i === 0} />
              ))}
            </div>
          </div>
        </RailGrid>
      </Section>

      {/* ---------- final CTA ---------- */}
      <Section divider="ink" pad="lg">
        <div className="flex flex-col gap-10 rail:flex-row rail:items-end rail:justify-between rail:gap-14">
          <div>
            <h2 className="mb-5 font-display text-h2-sm font-semibold text-ink type:text-cta">
              Fifteen dollars a seat. Every repo. Nothing missed.
            </h2>
            <p className="max-w-[56ch]">
              Start free and read this month’s receipt — upgrade when you want the board
              read, and the loop closed, for you.
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-3.5">
            <SignalButton to="/api/billing/checkout">Get Pro</SignalButton>
            <OutlineButton to="/api/auth/login">Start free with GitHub</OutlineButton>
          </div>
        </div>
      </Section>
    </>
  );
}
