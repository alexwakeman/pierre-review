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

// ---------------------------------------------------------------------------
// The pricing page.
//
// The entire visual promotion of the paid tier is ONE HAIRLINE: Free sits under
// a 1px ink rule, Pro under a 1px vermilion rule. No card, no fill, no badge, no
// shadow, no "most popular" ribbon. Feature lists are rule-separated rows — no
// ticks, no icons.
//
// PRICE: Pro is $15/month. When editing, note that the price is spelled out in
// three places ("fifteen dollars", the rail label, the closing CTA) and appears
// numerically in a fourth, and that the JSON-LD AggregateOffer in index.html is
// a fifth copy that ships on EVERY prerendered page — not just this one.
// ---------------------------------------------------------------------------

const FREE_FEATURES = [
  'Unlimited repos & contributors',
  `Activity console + cross-repo feed — the view ${SITE_NAME} opens on`,
  'The timeline board — repos down the side, time across the top',
  'PR detail with inline diffs',
  `Reply, resolve, comment, approve & request reviewers from ${SITE_NAME}`,
  'Review-thread states — resolved / likely addressed / replied / untouched',
  'Open-PR triage strip',
  `Runs 100% local — ${INSTALL_COMMAND}, your data never leaves your machine`,
];

const PRO_FEATURES = [
  'AI summaries — per-repo digests + sprint reports (included in the sub, no key needed)',
  'Team Insights: stalled reviews, unanswered-thread alerts, reviewer load',
  'Reviewer suggestions from commit history on the changed files — requested in one click',
  'DORA-style flow metrics with drill-downs',
  '“My Turn” feed intelligence — every event on PRs you’re part of, flagged',
  'Slack digests on your cadence (daily / twice daily)',
  'Jira & Linear ticket links on every PR',
  'Claude Review memory — each run learns from what you kept, cut and reworded',
  'Sprint-window & cadence configuration',
];

const BYO = [
  {
    title: 'Claude Review',
    body: 'Deep or quick, routed automatically — structured findings you curate and post as one review, with memory across runs.',
  },
  {
    title: 'AI Analysis',
    body: 'PR summary + CI-failure diagnosis, straight from the failing job log.',
  },
  {
    title: 'AI Fix',
    body: 'Patch → review the diff → push to the PR branch or a new one. Merge-conflict resolution included.',
  },
];

const BYO_NOTES = [
  {
    label: 'Models',
    body: 'Claude Sonnet 5 by default — the latest Claude, near-Opus coding quality at lower cost — with Opus 4.8 for the hardest reviews and Haiku 4.5 for quick passes.',
  },
  { label: 'Today', body: 'Your own Anthropic API key; usage metered transparently in credits.' },
  {
    label: 'Coming',
    body: 'Metered pay-as-you-go at API list price, and OpenAI-compatible BYO endpoints (Bedrock, self-hosted, open models) for cost and privacy control.',
  },
];

const FAQ: { q: string; a: string }[] = [
  {
    q: 'Is free really free?',
    a: `Yes. ${SITE_NAME} is open-core: the free dashboard is the product, not a trial. The Activity feed, the timeline, PR detail with real GitHub write actions — all of it stays free, with no repo or seat limits. Pro adds the intelligence layer on top.`,
  },
  {
    q: 'What happens if my payment fails?',
    a: 'You drop to Free, gracefully. Nothing is deleted, nothing locks you out of your data — you keep the whole dashboard and lose only the Pro intelligence features until billing is sorted.',
  },
  {
    q: 'Do you train on my code?',
    a: `Never. Your data is yours — private and confidential, forever. ${SITE_NAME} never trains on it, never shares it, and in local mode it never even leaves your machine.`,
  },
  {
    q: 'Do I need an Anthropic key?',
    a: 'Only for the agentic features — Claude Review, AI Analysis, and AI Fix — which run on your own Anthropic API key (metered pay-as-you-go is coming). The AI summaries (digests and sprint reports) are included in the Pro subscription, no key needed.',
  },
  {
    q: 'Can I self-host?',
    a: `The Open Core tier, fully — ${INSTALL_COMMAND} runs the whole free dashboard on your machine (no stored credentials, local SQLite), and the multi-tenant cloud deployment is self-hostable too. The Pro intelligence layer is a subscription — it is not part of the npm package and unlocks with a Pro account as the hosted rollout lands.`,
  },
  {
    q: 'What’s coming?',
    a: 'Metered advanced AI (pay-as-you-go at API list price), OpenAI-compatible BYO endpoints (Bedrock, self-hosted, open models), deeper Jira/Linear integration, and email digests. Hosted cloud Pro is rolling out now.',
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
              Open-core and free. Pro is{' '}
              <span className="text-signal-text">fifteen dollars</span>.
            </h1>
            <p className="max-w-[58ch] text-lede">
              The dashboard is free, local-first, and yours forever. Pro adds the AI layer
              and the team intelligence — for less than one seat of the review bot it sits
              above.
            </p>

            {checkoutUnavailable && (
              <p
                role="status"
                className="mt-8 border-y border-rule py-3.5 font-mono text-mono-nav text-ink-soft"
              >
                <span className="mr-3 text-mono-label uppercase text-signal-text">
                  Heads up
                </span>
                Checkout isn’t live yet — Pro is rolling out; run it locally today.
              </p>
            )}
          </div>
        </RailGrid>
      </Section>

      {/* ---------- tiers ----------
          Free under an ink hairline, Pro under a vermilion one. That single
          rule is the whole promotion of the paid tier. */}
      <Section divider="none" pad="none" className="pb-section-y">
        <RailGrid rail={{ word: 'Tiers' }}>
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
            <p className="mb-6 text-body-sm">Everything you need to see your team clearly.</p>

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
            <MonoLabel className="mb-6 text-secondary">per month</MonoLabel>
            <p className="mb-6 text-body-sm">Everything in Free, plus the intelligence layer.</p>

            <ul className="mb-7 flex flex-col">
              {PRO_FEATURES.map((f, i) => (
                <RuledItem key={f} last={i === PRO_FEATURES.length - 1}>
                  {f}
                </RuledItem>
              ))}
            </ul>

            <SignalButton to="/api/billing/checkout" className="mb-4 w-full py-4 text-center">
              Get Pro
            </SignalButton>
            <p className="font-mono text-mono-caption text-secondary">
              Billing via Stripe · cancel any time · a declined card downgrades you
              gracefully to Free — nothing is deleted.
            </p>
          </div>
        </RailGrid>
      </Section>

      {/* ---------- BYO key ---------- */}
      <Section tone="alt" pad="none" className="py-16">
        <RailGrid rail={{ word: 'BYO key' }} cols="one">
          <div>
            <h2 className="mb-[34px] font-display text-h2-sm font-semibold text-ink type:text-h2-minor">
              Agentic review &amp; fix — bring your own Claude.
            </h2>

            <div className="mb-9 grid gap-8 rail:grid-cols-3">
              {BYO.map((b) => (
                <div key={b.title} className="border-t border-ink pt-[18px]">
                  <h3 className="mb-3 font-display text-h4-sm font-semibold text-ink">
                    {b.title}
                  </h3>
                  <p className="text-list">{b.body}</p>
                </div>
              ))}
            </div>

            <div className="grid gap-8 border-t border-rule-strong pt-6 rail:grid-cols-3">
              {BYO_NOTES.map((n) => (
                <p key={n.label} className="text-[16px] leading-relaxed">
                  <MonoLabel className="mb-2.5 text-secondary">{n.label}</MonoLabel>
                  {n.body}
                </p>
              ))}
            </div>

            <MonoLink to="/pro#claude-review" className="mt-[26px]">
              How agentic review works →
            </MonoLink>
          </div>
        </RailGrid>
      </Section>

      {/* ---------- why $15 ---------- */}
      <Section pad="none" className="py-16">
        <RailGrid rail={{ word: 'Why $15' }} cols="one">
          <div>
            <h2 className="mb-5 max-w-[32ch] font-display text-h2-sm font-semibold text-ink type:text-h2-minor">
              Review bots run $24–30 a seat and add comments. {SITE_NAME} adds{' '}
              <span className="text-signal-text">signal</span>.
            </h2>
            <p className="max-w-[58ch] text-lede">
              We’re not selling another reviewer. We’re selling never missing a beat —
              across every repo you own. And it’s flat, not per seat: at five engineers
              that is already eight to ten times the price.
            </p>
          </div>
        </RailGrid>
      </Section>

      {/* ---------- FAQ ---------- */}
      <Section pad="none" className="py-16">
        <RailGrid rail={{ word: 'FAQ' }} cols="one">
          <div>
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
              Fifteen dollars. Every repo. Nothing missed.
            </h2>
            <p className="max-w-[56ch]">
              Start free and see the board fill in seconds — upgrade when you want the
              intelligence layer on top.
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
