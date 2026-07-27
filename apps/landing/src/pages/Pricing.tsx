import { useEffect, useState } from 'react';
import { Link } from '../router';
import { useSeo } from '../lib/seo';
import { seoFor } from '../lib/routes';
import { Section, SectionHeading, Eyebrow, Pill, Glow } from '../components/ui';
import { CheckIcon, SparkleIcon, ArrowRightIcon } from '../components/icons';

const FREE_FEATURES = [
  'Unlimited repos & contributors',
  'Activity console + cross-repo feed — the view Pierre opens on',
  'The timeline board — repos down the side, time across the top',
  'PR detail with inline diffs',
  'Reply, resolve, comment, approve & request reviewers from Pierre',
  'Review-thread states — resolved / likely addressed / replied / untouched',
  'Open-PR triage strip',
  'Runs 100% local — npx pierre-review, your data never leaves your machine',
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

const FAQ: { q: string; a: string }[] = [
  {
    q: 'Is free really free?',
    a: 'Yes. Pierre is open-core: the free dashboard is the product, not a trial. The Activity feed, the timeline, PR detail with real GitHub write actions — all of it stays free, with no repo or seat limits. Pro adds the intelligence layer on top.',
  },
  {
    q: 'What happens if my payment fails?',
    a: 'You drop to Free, gracefully. Nothing is deleted, nothing locks you out of your data — you keep the whole dashboard and lose only the Pro intelligence features until billing is sorted.',
  },
  {
    q: 'Do you train on my code?',
    a: 'Never. Your data is yours — private and confidential, forever. Pierre never trains on it, never shares it, and in local mode it never even leaves your machine.',
  },
  {
    q: 'Do I need an Anthropic key?',
    a: 'Only for the agentic features — Claude Review, AI Analysis, and AI Fix — which run on your own Anthropic API key (metered pay-as-you-go is coming). The AI summaries (digests and sprint reports) are included in the Pro subscription, no key needed.',
  },
  {
    q: 'Can I self-host?',
    a: 'The Open Core tier, fully — npx pierre-review runs the whole free dashboard on your machine (no stored credentials, local SQLite), and the multi-tenant cloud deployment is self-hostable too. The Pro intelligence layer is a subscription — it is not part of the npm package and unlocks with a Pro account as the hosted rollout lands.',
  },
  {
    q: 'What’s coming?',
    a: 'Metered advanced AI (pay-as-you-go at API list price), OpenAI-compatible BYO endpoints (Bedrock, self-hosted, open models), deeper Jira/Linear integration, and email digests. Hosted cloud Pro is rolling out now.',
  },
];

function FeatureItem({
  children,
  accent = 'text-brand-sky',
}: {
  children: string;
  accent?: string;
}): JSX.Element {
  return (
    <li className="flex gap-3 text-sm leading-relaxed text-gray-300">
      <CheckIcon className={`mt-0.5 h-4 w-4 flex-none ${accent}`} />
      {children}
    </li>
  );
}

export default function Pricing(): JSX.Element {
  useSeo(seoFor('/pricing'));

  // The checkout endpoint bounces back here with ?checkout=unavailable while
  // hosted billing is still rolling out.
  const [checkoutUnavailable, setCheckoutUnavailable] = useState(false);
  useEffect(() => {
    setCheckoutUnavailable(
      new URLSearchParams(window.location.search).get('checkout') === 'unavailable'
    );
  }, []);

  return (
    <>
      {/* ---------- hero ---------- */}
      <header className="relative overflow-hidden">
        <Glow className="absolute -top-24 left-1/2 h-[30rem] w-[30rem] -translate-x-1/2 rounded-full bg-brand-purple/15 blur-[140px]" />
        <Glow className="absolute top-24 right-[8%] h-64 w-64 rounded-full bg-brand-sky/15 blur-[120px]" />

        <Section width="default" className="pb-10 pt-16 text-center sm:pt-24">
          <Eyebrow className="text-brand-purpleSoft">Pricing</Eyebrow>
          <h1 className="mx-auto mt-3 max-w-3xl text-balance text-4xl font-bold leading-[1.1] tracking-tight text-gray-50 sm:text-5xl">
            Open-core and free.{' '}
            <span className="bg-gradient-to-r from-brand-purpleSoft to-brand-sky bg-clip-text text-transparent">
              Pro is five dollars.
            </span>
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-pretty text-lg leading-relaxed text-gray-400">
            The dashboard is free, local-first, and yours forever. Pro adds the AI layer
            and the team intelligence — for less than the coffee you drink while
            triaging.
          </p>

          {checkoutUnavailable && (
            <div
              role="status"
              className="mx-auto mt-6 max-w-md rounded-xl border border-brand-amber/30 bg-brand-amber/10 px-4 py-3 text-sm text-brand-amberSoft"
            >
              Checkout isn’t live yet — Pro is rolling out; run it locally today.
            </div>
          )}
        </Section>
      </header>

      {/* ---------- tier cards ---------- */}
      <Section width="wide" className="pb-8 pt-6">
        <div className="mx-auto grid max-w-4xl gap-6 lg:grid-cols-2">
          {/* Free */}
          <div className="flex flex-col rounded-3xl border border-white/10 bg-white/[0.03] p-8">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-gray-100">Free</h2>
              <Pill className="bg-brand-green/10 text-brand-green ring-brand-green/30">
                Open-core
              </Pill>
            </div>
            <p className="mt-4 flex items-baseline gap-1.5">
              <span className="text-4xl font-bold tracking-tight text-gray-50">$0</span>
              <span className="text-sm text-gray-500">forever</span>
            </p>
            <p className="mt-3 text-sm leading-relaxed text-gray-400">
              Everything you need to see your team clearly.
            </p>
            <ul className="mt-6 flex-1 space-y-3">
              {FREE_FEATURES.map((f) => (
                <FeatureItem key={f} accent="text-brand-green">
                  {f}
                </FeatureItem>
              ))}
            </ul>
            <div className="mt-8">
              <div className="flex items-center justify-center gap-3 rounded-xl border border-white/10 bg-gray-900/70 px-5 py-3.5 font-mono text-sm">
                <span className="select-none text-brand-green">$</span>
                <code className="text-gray-100">npx pierre-review</code>
              </div>
              <p className="mt-3 text-center text-xs text-gray-500">
                Or{' '}
                <a href="/api/auth/login" className="text-gray-400 underline-offset-2 hover:underline">
                  sign in with GitHub
                </a>
                .
              </p>
            </div>
          </div>

          {/* Pro — highlighted */}
          <div className="relative flex flex-col overflow-hidden rounded-3xl border border-brand-purple/40 bg-brand-purple/[0.07] p-8 shadow-[0_0_0_1px_rgba(137,87,229,0.15),0_8px_40px_-8px_rgba(137,87,229,0.35)]">
            <Glow className="absolute -top-16 right-0 h-48 w-48 rounded-full bg-brand-purple/25 blur-[90px]" />
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-gray-100">Pro</h2>
              <Pill className="bg-brand-purple/15 text-brand-purpleSoft ring-brand-purple/30">
                The intelligence layer
              </Pill>
            </div>
            <p className="mt-4 flex items-baseline gap-1.5">
              <span className="text-4xl font-bold tracking-tight text-gray-50">$5</span>
              <span className="text-sm text-gray-500">/month</span>
            </p>
            <p className="mt-3 text-sm leading-relaxed text-gray-400">
              Everything in Free, plus the intelligence layer.
            </p>
            <ul className="mt-6 flex-1 space-y-3">
              {PRO_FEATURES.map((f) => (
                <FeatureItem key={f} accent="text-brand-purpleSoft">
                  {f}
                </FeatureItem>
              ))}
            </ul>
            <div className="mt-8">
              <a
                href="/api/billing/checkout"
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-brand-purple to-brand-blueDeep px-6 py-3.5 text-base font-semibold text-white transition hover:from-brand-purpleSoft hover:to-brand-blue focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-purpleSoft focus-visible:ring-offset-2 focus-visible:ring-offset-gray-950"
              >
                Get Pro
                <ArrowRightIcon className="h-4 w-4" />
              </a>
              <p className="mt-3 text-center text-xs leading-relaxed text-gray-500">
                Billing via Stripe · cancel any time · a declined card downgrades you
                gracefully to Free — nothing is deleted.
              </p>
            </div>
          </div>
        </div>
      </Section>

      {/* ---------- advanced AI strip ---------- */}
      <Section width="wide" className="py-10">
        <div className="relative mx-auto max-w-4xl overflow-hidden rounded-3xl border border-white/10 bg-white/[0.03] p-8 sm:p-10">
          <Glow className="absolute -bottom-20 left-1/2 h-56 w-[30rem] max-w-full -translate-x-1/2 rounded-full bg-brand-purple/12 blur-[110px]" />
          <div className="flex flex-wrap items-center gap-3">
            <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-brand-purple/10 ring-1 ring-brand-purple/30">
              <SparkleIcon className="h-5 w-5 text-brand-purpleSoft" />
            </span>
            <Pill className="bg-brand-purple/15 text-brand-purpleSoft ring-brand-purple/30">
              Pro · BYO key
            </Pill>
          </div>
          <h2 className="mt-5 text-pretty text-2xl font-bold tracking-tight text-gray-50 sm:text-3xl">
            Agentic review &amp; fix — bring your own Claude.
          </h2>
          <div className="mt-6 grid gap-5 sm:grid-cols-3">
            <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
              <h3 className="text-sm font-semibold text-gray-100">Claude Review</h3>
              <p className="mt-2 text-sm leading-relaxed text-gray-400">
                Deep or quick, routed automatically — structured findings you curate and
                post as one review, with memory across runs.
              </p>
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
              <h3 className="text-sm font-semibold text-gray-100">AI Analysis</h3>
              <p className="mt-2 text-sm leading-relaxed text-gray-400">
                PR summary + CI-failure diagnosis, straight from the failing job log.
              </p>
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
              <h3 className="text-sm font-semibold text-gray-100">AI Fix</h3>
              <p className="mt-2 text-sm leading-relaxed text-gray-400">
                Patch → review the diff → push to the PR branch or a new one.
                Merge-conflict resolution included.
              </p>
            </div>
          </div>
          <div className="mt-6 space-y-2 text-sm leading-relaxed text-gray-400">
            <p>
              <span className="font-medium text-gray-200">Models:</span> Claude Sonnet 5 by
              default — the latest Claude, near-Opus coding quality at lower cost — with
              Opus 4.8 for the hardest reviews and Haiku 4.5 for quick passes.
            </p>
            <p>
              <span className="font-medium text-gray-200">Today:</span> your own Anthropic
              API key; usage metered transparently in credits.
            </p>
            <p>
              <span className="font-medium text-gray-200">Coming:</span> metered
              pay-as-you-go at API list price, and OpenAI-compatible BYO endpoints
              (Bedrock, self-hosted, open models) for cost and privacy control.
            </p>
          </div>
          <Link
            to="/pro#claude-review"
            className="group mt-6 inline-flex items-center gap-1.5 text-sm font-medium text-brand-purpleSoft transition hover:text-white"
          >
            How agentic review works
            <ArrowRightIcon className="h-4 w-4 transition group-hover:translate-x-0.5" />
          </Link>
        </div>
      </Section>

      {/* ---------- why $5 beats $30 ---------- */}
      <section className="mt-12 border-y border-white/5 bg-white/[0.02] py-16 sm:py-20">
        <Section width="narrow" className="text-center">
          <Eyebrow className="text-brand-sky">Why $5 beats $30</Eyebrow>
          <h2 className="mt-3 text-pretty text-2xl font-bold tracking-tight text-gray-50 sm:text-3xl">
            Review bots run $24–30 a seat and add comments. Pierre adds signal.
          </h2>
          <p className="mx-auto mt-5 max-w-xl text-pretty text-base leading-relaxed text-gray-400 sm:text-lg">
            We’re not selling another reviewer. We’re selling never missing a beat —
            across every repo you own.
          </p>
        </Section>
      </section>

      {/* ---------- FAQ ---------- */}
      <Section width="narrow" className="py-20 sm:py-24">
        <SectionHeading eyebrow="FAQ" title="The questions worth asking before paying anyone." />
        <div className="mt-10 space-y-3">
          {FAQ.map((item) => (
            <details
              key={item.q}
              className="group rounded-2xl border border-white/10 bg-white/[0.03] open:bg-white/[0.05]"
            >
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-6 py-4 text-sm font-semibold text-gray-100 [&::-webkit-details-marker]:hidden">
                {item.q}
                <span
                  aria-hidden="true"
                  className="text-gray-500 transition-transform group-open:rotate-45"
                >
                  +
                </span>
              </summary>
              <p className="px-6 pb-5 text-sm leading-relaxed text-gray-400">{item.a}</p>
            </details>
          ))}
        </div>
      </Section>

      {/* ---------- final CTA ---------- */}
      <Section width="narrow" className="pb-24 text-center">
        <h2 className="text-pretty text-3xl font-bold tracking-tight text-gray-50 sm:text-4xl">
          Five dollars. Every repo. Nothing missed.
        </h2>
        <p className="mx-auto mt-4 max-w-xl text-gray-400">
          Start free and see the board fill in seconds — upgrade when you want the
          intelligence layer on top.
        </p>
        <div className="mt-8 flex flex-col items-center justify-center gap-4 sm:flex-row">
          <a
            href="/api/billing/checkout"
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-brand-purple to-brand-blueDeep px-6 py-3.5 text-base font-semibold text-white transition hover:from-brand-purpleSoft hover:to-brand-blue focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-purpleSoft focus-visible:ring-offset-2 focus-visible:ring-offset-gray-950"
          >
            Get Pro
            <ArrowRightIcon className="h-4 w-4" />
          </a>
          <a
            href="/api/auth/login"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-300 transition hover:text-white"
          >
            Start free with GitHub
            <ArrowRightIcon className="h-4 w-4" />
          </a>
        </div>
      </Section>
    </>
  );
}
