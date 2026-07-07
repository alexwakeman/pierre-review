import type { ReactNode } from 'react';
import { Link } from '../router';
import { useSeo } from '../lib/seo';
import { Section, SectionHeading, Shot, Eyebrow, Pill, Glow, FeatureRow } from '../components/ui';
import {
  SparkleIcon,
  InsightsIcon,
  MyTurnIcon,
  RouteIcon,
  BoltIcon,
  LockIcon,
  ClockIcon,
  DocIcon,
  ArrowRightIcon,
} from '../components/icons';

// ---------------------------------------------------------------------------
// Local helpers (shared ui.tsx / icons.tsx are owned elsewhere — keep additions here)
// ---------------------------------------------------------------------------

const PRO_PILL = 'bg-brand-purple/15 text-brand-purpleSoft ring-brand-purple/30';
const BYO_PILL = 'bg-brand-purple/20 text-purple-200 ring-brand-purple/40';

function ProPill(): JSX.Element {
  return <Pill className={PRO_PILL}>Pro</Pill>;
}

function ByoPill(): JSX.Element {
  return <Pill className={BYO_PILL}>Pro · BYO key</Pill>;
}

/** Section heading with an icon, an eyebrow, a tier pill and a title. */
function ProHeading({
  icon: Icon,
  accent,
  eyebrow,
  title,
  tier = 'pro',
}: {
  icon: (p: { className?: string }) => ReactNode;
  accent: string;
  eyebrow: string;
  title: string;
  tier?: 'pro' | 'byo';
}): JSX.Element {
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <Icon className={`h-5 w-5 ${accent}`} />
        <Eyebrow className={accent}>{eyebrow}</Eyebrow>
        {tier === 'pro' ? <ProPill /> : <ByoPill />}
      </div>
      <h2 className="mt-3 text-pretty text-2xl font-bold tracking-tight text-gray-50 sm:text-3xl">
        {title}
      </h2>
    </div>
  );
}

/** Locally-owned icon (Slack-ish paper plane / send). */
function SendIcon({ className }: { className?: string }): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d="M21 3 3 10.5l7 3.5M21 3l-6.5 18-4.5-7M21 3 10 14" />
    </svg>
  );
}

/** Locally-owned icon (ticket link). */
function TicketIcon({ className }: { className?: string }): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d="M4 8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4Z" />
      <path d="M13 6v2.5M13 11v2M13 15.5V18" strokeDasharray="0.1 3.4" />
    </svg>
  );
}

/** Locally-owned icon (wrench / fix). */
function WrenchIcon({ className }: { className?: string }): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d="M14.7 6.3a4.5 4.5 0 0 0-6 5.6L3 17.6V21h3.4l5.7-5.7a4.5 4.5 0 0 0 5.6-6l-3.2 3.2-2.8-2.8 3-3Z" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

const SEVERITIES = [
  { label: 'blocker', cls: 'bg-brand-red/15 text-red-300 ring-brand-red/30' },
  { label: 'warning', cls: 'bg-brand-amber/15 text-amber-200 ring-brand-amber/30' },
  { label: 'nit', cls: 'bg-brand-blue/15 text-blue-200 ring-brand-blue/30' },
  { label: 'question', cls: 'bg-brand-purple/15 text-brand-purpleSoft ring-brand-purple/30' },
  { label: 'praise', cls: 'bg-brand-green/15 text-green-200 ring-brand-green/30' },
];

/**
 * One step of a teaching walkthrough: a numbered rail, a title, explanation
 * copy, and the zoomed screenshot of that exact moment in the product. The
 * crops are captured at a narrow viewport (scripts/capture-shots.mjs) so the
 * UI text stays legible at column width — and on mobile, where they render
 * full-bleed inside the step.
 */
function WalkStep({
  n,
  title,
  shot,
  alt,
  accent = 'purple',
  last = false,
  children,
}: {
  n: number;
  title: string;
  shot: string;
  alt: string;
  accent?: 'purple' | 'amber';
  last?: boolean;
  children: ReactNode;
}): JSX.Element {
  const chip =
    accent === 'amber'
      ? 'border-brand-amber/40 bg-brand-amber/10 text-amber-200'
      : 'border-brand-purple/40 bg-brand-purple/10 text-brand-purpleSoft';
  const rail =
    accent === 'amber' ? 'from-brand-amber/40' : 'from-brand-purple/40';
  return (
    <div className="relative flex gap-4 sm:gap-6">
      <div className="flex flex-col items-center">
        <span
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full border font-mono text-sm font-semibold ${chip}`}
        >
          {n}
        </span>
        {!last && (
          <span
            aria-hidden="true"
            className={`mt-2 w-px flex-1 bg-gradient-to-b ${rail} to-transparent`}
          />
        )}
      </div>
      <div className={`min-w-0 flex-1 ${last ? '' : 'pb-12'}`}>
        <h4 className="pt-1.5 text-lg font-semibold text-gray-100">{title}</h4>
        <div className="mt-2 max-w-3xl space-y-2 text-pretty text-sm leading-relaxed text-gray-400">
          {children}
        </div>
        {/* Tap/click opens the full-resolution capture — the crops are 2x, so
            small screens can zoom into every label. */}
        <a
          href={shot}
          target="_blank"
          rel="noopener"
          aria-label={`Open the full-size screenshot: ${alt}`}
          className="mt-4 block max-w-3xl overflow-hidden rounded-xl border border-white/10 bg-gray-950 shadow-xl shadow-black/40 ring-1 ring-white/5 transition hover:border-white/25"
        >
          <img
            src={shot}
            alt={alt}
            loading="lazy"
            decoding="async"
            className="block h-auto w-full"
          />
        </a>
      </div>
    </div>
  );
}

const METRICS = [
  ['Deploy frequency', 'how often work actually lands'],
  ['Lead time', 'from first commit to merged'],
  ['Review latency', 'how long PRs wait for a first review'],
  ['Merge vs CI health', 'how much of the pipeline is green when it counts'],
  ['CI recovery time', 'real red→green MTTR, from a transition log — not a proxy'],
];

// ---------------------------------------------------------------------------

export default function Pro(): JSX.Element {
  useSeo({
    path: '/pro',
    title: 'Pierre Pro — AI summaries, team insights & agentic review',
    description:
      'The intelligence layer: per-repo AI digests, sprint reports, team Insights, DORA-style flow metrics, My-Turn triage, Slack digests, Jira/Linear links — plus Claude Review and AI Fix with a human hand on the wheel.',
  });

  return (
    <>
      {/* hero */}
      <header className="relative overflow-hidden">
        <Glow className="absolute -top-24 left-1/2 h-96 w-[40rem] max-w-full -translate-x-1/2 rounded-full bg-brand-purple/20 blur-[130px]" />
        <Section width="default" className="pb-12 pt-16 text-center sm:pt-20">
          <div className="flex items-center justify-center gap-2">
            <SparkleIcon className="h-6 w-6 text-brand-purpleSoft" />
            <Eyebrow className="text-brand-purpleSoft">Pierre Pro</Eyebrow>
          </div>
          <h1 className="mx-auto mt-3 max-w-3xl text-balance text-4xl font-bold leading-tight tracking-tight text-gray-50 sm:text-5xl">
            The intelligence layer.
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-pretty text-lg leading-relaxed text-gray-400">
            The free board shows you everything. Pro turns that activity into decisions —
            summaries that write themselves, metrics that answer retro questions, a feed
            that knows what’s yours, and agentic review &amp; fix with a{' '}
            <span className="font-medium text-gray-200">human hand on the wheel</span> at
            every step.
          </p>
          <div className="mt-7 flex flex-wrap items-center justify-center gap-2">
            <Pill className={PRO_PILL}>Pro · $5/mo</Pill>
            <Pill className={BYO_PILL}>Advanced AI · BYO key</Pill>
          </div>
        </Section>
      </header>

      {/* digests */}
      <Section id="digests" width="wide" className="scroll-mt-24 py-12 sm:py-16">
        <FeatureRow
          shot={
            <Shot
              src="/shots/repo-console.png"
              alt="A repo console with its AI digest banner: a bulleted change report with clickable PR references above the open-PR list."
              title="pierre · Repo digest"
              eager
              priority
            />
          }
        >
          <ProHeading
            icon={SparkleIcon}
            accent="text-brand-purpleSoft"
            eyebrow="AI digests"
            title="AI summaries as your team ships."
          />
          <p className="mt-5 text-pretty leading-relaxed text-gray-400">
            Every repo gets a bulleted change report,{' '}
            <span className="text-gray-200">chained from the previous one</span> — what
            changed since last time, not a re-summary of everything — with every PR
            referenced as a clickable <span className="font-mono text-gray-300">#N</span>{' '}
            that opens the real thing.
          </p>
          <p className="mt-4 text-pretty leading-relaxed text-gray-400">
            Refresh manually, on an interval, or on-change — your choice, in Settings. And
            an unchanged repo costs <span className="font-medium text-gray-200">$0, by
            design</span>: Pierre hashes the underlying activity and skips the model call
            when nothing moved.
          </p>
        </FeatureRow>
      </Section>

      {/* sprint report */}
      <Section id="sprint" width="wide" className="scroll-mt-24 py-12 sm:py-16">
        <FeatureRow
          flip
          shot={
            <Shot
              src="/shots/sprint-report.png"
              alt="The sprint report: headline flow metrics followed by prioritised, PR-linked blockers and what needs attention."
              title="pierre · Sprint report"
            />
          }
        >
          <ProHeading
            icon={DocIcon}
            accent="text-brand-purpleSoft"
            eyebrow="Sprint report"
            title="The sprint report writes itself."
          />
          <p className="mt-5 text-pretty leading-relaxed text-gray-400">
            Sprint-window aware — you set the cadence and start date, Pierre rolls the
            window forward — the report leads with the flow metrics, then names the
            blockers, with PR links you can act on. Prioritised by repo importance, change
            size, and how long a PR has been waiting.
          </p>
          <p className="mt-4 text-pretty leading-relaxed text-gray-400">
            Delivered in-app and to Slack on your schedule: a reliable, consistent state of
            play, instead of a reconstruction you assemble at 9:57 for the 10:00.
          </p>
        </FeatureRow>
      </Section>

      {/* insights */}
      <Section id="insights" width="wide" className="scroll-mt-24 py-12 sm:py-16">
        <ProHeading
          icon={InsightsIcon}
          accent="text-brand-sky"
          eyebrow="Team Insights"
          title="The questions retros are supposed to answer."
        />
        <div className="mt-6">
          <Shot
            src="/shots/insights.png"
            alt="The Insights rail: cards for stalled reviews, untouched threads, reviewer load and reviewer routing with rationale."
            title="pierre · Insights"
          />
        </div>
        <div className="mt-8 grid gap-6 sm:grid-cols-2">
          <div className="space-y-4 text-pretty leading-relaxed text-gray-400">
            <p>
              No instrumentation, no extra pipeline — Pierre already synced your PR history.
              Insights turns it into the cards a lead actually needs:{' '}
              <span className="text-gray-200">stalled reviews</span> that have quietly
              stopped moving, <span className="text-gray-200">untouched threads</span> —
              surfaced team-wide, so no review feedback goes unanswered — and{' '}
              <span className="text-gray-200">reviewer load</span>, the early read on who’s
              carrying too much.
            </p>
          </div>
          <div className="space-y-4 text-pretty leading-relaxed text-gray-400">
            <p>
              <span className="text-gray-200">Reviewer routing</span> goes a step further:
              for each unreviewed PR it suggests reviewers with a rationale drawn from who
              actually touched those paths — and a one-click{' '}
              <span className="font-medium text-gray-200">“request reviewers”</span> that
              does it, right there. From noticing to acting, without leaving the card.
            </p>
          </div>
        </div>
      </Section>

      {/* metrics */}
      <Section id="metrics" width="wide" className="scroll-mt-24 py-12 sm:py-16">
        <FeatureRow
          flip
          shot={
            <Shot
              src="/shots/flow-metrics.png"
              alt="DORA-style flow metric charts: deploy frequency, lead time, review latency, merge-vs-CI health and CI recovery time."
              title="pierre · Flow metrics"
            />
          }
        >
          <ProHeading
            icon={InsightsIcon}
            accent="text-brand-sky"
            eyebrow="Flow metrics"
            title="DORA-style metrics, minus the vendor deck."
          />
          <ul className="mt-5 space-y-2.5">
            {METRICS.map(([name, sub]) => (
              <li key={name} className="flex gap-3 text-sm leading-relaxed">
                <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-sky" />
                <span className="text-gray-400">
                  <span className="font-medium text-gray-200">{name}</span> — {sub}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-pretty leading-relaxed text-gray-400">
            Every tile clicks through to the PRs behind the number — no black-box
            aggregates. And nothing is sampled or projected; it’s all derived from the same
            synced data that draws the board.
          </p>
          <p className="mt-4 rounded-xl border border-brand-sky/20 bg-brand-sky/5 px-4 py-3 text-sm leading-relaxed text-gray-300">
            <span className="font-semibold text-brand-skySoft">Mirrors, not scorecards · </span>
            The point is to start better conversations, not to rank people.
          </p>
        </FeatureRow>
      </Section>

      {/* my turn */}
      <Section id="my-turn" width="wide" className="scroll-mt-24 py-12 sm:py-16">
        <FeatureRow
          shot={
            <Shot
              src="/shots/activity-feed-pro.png"
              alt="The Activity feed with yellow-bordered My Turn cards flagging events on PRs you participate in, and a My-Turn-only toggle."
              title="pierre · My Turn"
            />
          }
        >
          <ProHeading
            icon={MyTurnIcon}
            accent="text-brand-amber"
            eyebrow="My Turn"
            title="Know it’s your turn without being told twice."
          />
          <p className="mt-5 text-pretty leading-relaxed text-gray-400">
            Pro makes the feed <span className="text-gray-200">participation-aware</span>:
            any event on a PR you authored, were asked to review, or previously weighed in
            on gets flagged as yours — a yellow-bordered card with the full context inline,
            never buried under a volume cap, with a{' '}
            <span className="font-medium text-gray-200">“My Turn only”</span> toggle when
            you want just the queue.
          </p>
          <p className="mt-4 text-pretty leading-relaxed text-gray-400">
            Pull-based by design: you check one place, nothing pings you. Notifications
            optimise for <em>completeness</em>; My Turn optimises for{' '}
            <em>your next action</em>.
          </p>
        </FeatureRow>
      </Section>

      {/* slack */}
      <Section id="slack" width="wide" className="scroll-mt-24 py-12 sm:py-16">
        <FeatureRow
          flip
          shot={
            <Shot
              src="/shots/settings.png"
              alt="The Settings modal: sprint window, Slack digest cadence with timezone and send-test, AI update policy, and Jira/Linear configuration."
              title="pierre · Settings"
            />
          }
        >
          <ProHeading
            icon={SendIcon}
            accent="text-brand-green"
            eyebrow="Slack digests"
            title="Slack digests on your cadence."
          />
          <p className="mt-5 text-pretty leading-relaxed text-gray-400">
            Point Pierre at a Slack webhook and the sprint report plus per-repo digests
            arrive on your schedule — <span className="text-gray-200">daily or twice
            daily</span>, timezone-aware, with a send-test button so you know it works
            before the team relies on it.
          </p>
          <p className="mt-4 text-pretty leading-relaxed text-gray-400">
            It’s the anti-notification: choose your cadence and get{' '}
            <span className="font-medium text-gray-200">one high-quality report instead of
            forty pings</span>. If nothing happened, nothing is posted. (Email delivery is
            on the roadmap.)
          </p>
        </FeatureRow>
      </Section>

      {/* tickets */}
      <Section id="tickets" width="wide" className="scroll-mt-24 py-12 sm:py-16">
        <div className="rounded-3xl border border-white/10 bg-white/[0.03] p-7 sm:p-9">
          <ProHeading
            icon={TicketIcon}
            accent="text-brand-blue"
            eyebrow="Jira & Linear"
            title="Jira and Linear links, automatically."
          />
          <div className="mt-5 grid gap-6 sm:grid-cols-2">
            <p className="text-pretty leading-relaxed text-gray-400">
              Ticket keys like <span className="font-mono text-gray-300">PROJ-123</span> are
              detected from PR titles and branch names and rendered as deep links in PR
              detail — so the jump from “this PR” to “the ticket it closes” is one click,
              with zero convention changes on your side.
            </p>
            <p className="text-pretty leading-relaxed text-gray-400">
              Configure your provider and base URL once in Settings, and every PR that
              follows your existing naming carries its links. Deeper Jira/Linear integration
              is coming.
            </p>
          </div>
        </div>
      </Section>

      {/* advanced AI divider */}
      <section className="relative border-y border-white/5 bg-white/[0.02]">
        <Section width="default" className="py-14 text-center sm:py-16">
          <ByoPill />
          <h2 className="mt-4 text-pretty text-3xl font-bold tracking-tight text-gray-50 sm:text-4xl">
            The agentic tier.
          </h2>
          <p className="mx-auto mt-4 max-w-2xl text-pretty text-base leading-relaxed text-gray-400 sm:text-lg">
            Everything below runs a real agent against your code — reviews, diagnoses,
            fixes. Bring your own Anthropic API key, watch usage
            in credits, and keep one rule in view: {' '}
            <span className="font-medium text-gray-200">
              nothing posts, pushes or merges without a human click.
            </span>
          </p>
        </Section>
      </section>

      {/* claude review */}
      <Section id="claude-review" width="wide" className="scroll-mt-24 py-16 sm:py-20">
        <ProHeading
          icon={SparkleIcon}
          accent="text-brand-purpleSoft"
          eyebrow="Claude Review"
          title="Reviews that are still there next week."
          tier="byo"
        />
        <p className="mt-5 max-w-3xl text-pretty leading-relaxed text-gray-400">
          Most AI code review happens in a chat tab — useful in the moment, gone the moment
          you close it. Pierre runs the review against the PR, structures the output, and{' '}
          <span className="font-medium text-gray-200">saves it per commit</span> — no
          digging through agent-session histories in your CLI tool of choice. Re-review
          after a push and the old run stays in history, tied to the code it reviewed.
        </p>
        <p className="mt-4 max-w-3xl text-pretty leading-relaxed text-gray-400">
          Runs on <span className="text-gray-200">Claude Sonnet 5</span> by default — the
          latest Claude, near-Opus coding quality at a fraction of the cost — with{' '}
          <span className="text-gray-200">Claude Opus 4.8</span> a click away for the
          gnarliest diffs and <span className="text-gray-200">Haiku 4.5</span> for a quick
          pass.
        </p>
        <div className="mt-8">
          <Shot
            src="/shots/claude-review.png"
            alt="The Claude Review tab: a structured review with severity-tagged, line-anchored findings, a routing badge, and a separate “your review” composer that posts to GitHub."
            title="pierre · Claude Review"
          />
        </div>

        {/* deep vs quick */}
        <div className="mt-12 grid gap-6 lg:grid-cols-2">
          <div className="flex flex-col rounded-3xl border border-white/10 bg-white/[0.03] p-7">
            <div className="flex items-center justify-between">
              <BoltIcon className="h-7 w-7 text-brand-sky" />
              <Pill className="bg-brand-sky/10 text-brand-skySoft ring-brand-sky/30">
                quick · diff-only
              </Pill>
            </div>
            <h3 className="mt-4 text-xl font-bold tracking-tight text-gray-50">
              Fast path, no clone
            </h3>
            <div className="mt-3 space-y-3 text-sm leading-relaxed text-gray-400">
              <p>
                For small, contained changes touching no exported contract, the full diff is
                inlined into the prompt. No checkout, a tight turn cap, seconds to finish.
              </p>
              <p>
                Ideal for the localised fix, the style pass, the small refactor where the
                diff <em>is</em> the context.
              </p>
            </div>
          </div>
          <div className="flex flex-col rounded-3xl border border-white/10 bg-white/[0.03] p-7">
            <div className="flex items-center justify-between">
              <RouteIcon className="h-7 w-7 text-brand-purpleSoft" />
              <Pill className={PRO_PILL}>deep · worktree</Pill>
            </div>
            <h3 className="mt-4 text-xl font-bold tracking-tight text-gray-50">
              Full checkout to explore
            </h3>
            <div className="mt-3 space-y-3 text-sm leading-relaxed text-gray-400">
              <p>
                Touch anything bigger — too many files or lines, more than one subsystem, or
                any exported API, schema or migration — and the run earns a{' '}
                <span className="font-medium text-gray-200">
                  partial clone and an ephemeral worktree
                </span>
                . The agent gets read-only tools to trace callers and check assumptions
                against the real tree.
              </p>
              <p>
                Built for cross-cutting changes, where the blast radius lives outside the
                diff. Ambiguous? It rounds up to deep.
              </p>
            </div>
          </div>
        </div>
        <p className="mx-auto mt-6 max-w-2xl text-center text-sm text-gray-500">
          A deterministic router picks the depth before a token is spent, so cost tracks
          complexity. You can force a mode per run; every run is capped by turns and by
          dollars, and cancelable mid-flight.
        </p>

        {/* the walkthrough */}
        <div className="mt-16">
          <SectionHeading
            eyebrow="Walk through it"
            eyebrowClass="text-brand-purpleSoft"
            title="A real review, step by step."
            lead="These are the actual screens, in order. Four steps, a few seconds of your attention each — and one human decision at the end."
          />
          <div className="mt-12">
            <WalkStep
              n={1}
              title="Open the PR, pick a depth — or let the router."
              shot="/shots/flow-review-1-run.png"
              alt="The Claude Review run controls: a model picker defaulting to Claude Sonnet 5, a depth picker on Auto, a Re-review button, and the router’s hint line reading “2 files · 72 lines changed — Auto picks Quick”."
            >
              <p>
                From any PR’s detail pane, open the Claude Review tab. Pick a model —{' '}
                <span className="text-gray-200">Claude Sonnet 5</span> by default, Opus 4.8
                for the gnarly ones — and a depth, or leave it on Auto: a deterministic
                router reads the diff before a token is spent. This 2-file, 72-line change
                earns the fast, no-clone path; touch an exported API and it rounds up to a
                full worktree.
              </p>
            </WalkStep>
            <WalkStep
              n={2}
              title="It already knows how you review."
              shot="/shots/flow-review-2-memory.png"
              alt="The review-memory panel, expanded: signals from past reviews in this repo — a reworded finding shown as Claude’s wording versus yours, and “You dismissed 3 of 3 findings here” for style nits — marked as given to Claude as context."
            >
              <p>
                Before the run, Pierre surfaces what your past reviews in this repo taught
                it — the finding you reworded (and how), the style nits you keep dismissing
                — and hands those signals to Claude as context.{' '}
                <span className="font-medium text-gray-200">
                  Every review feeds the next one
                </span>
                : run two stops flagging what you didn’t care about in run one. A chat-tab
                review starts from zero, every time.
              </p>
            </WalkStep>
            <WalkStep
              n={3}
              title="Read findings, not a wall of prose."
              shot="/shots/flow-review-3-findings.png"
              alt="Claude’s structured output: a short summary, then severity-tagged findings — a blocker and a warning with file:line anchors, diff hunks and suggested code — each with Post as comment, Reword in my words, Copy and Ignore actions; nits and questions already ignored."
            >
              <p>
                The output is structured: each finding carries a severity, a{' '}
                <span className="font-mono text-gray-300">file:line</span> anchor, the diff
                hunk it’s about, and an optional code suggestion. Per finding you choose —
                post Claude’s wording, reword it in yours, or ignore it. Here the blocker
                and warning stay; the nits are already cut.
              </p>
              <div className="flex flex-wrap gap-1.5 pt-1">
                {SEVERITIES.map((s) => (
                  <span
                    key={s.label}
                    className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-medium ring-1 ${s.cls}`}
                  >
                    {s.label}
                  </span>
                ))}
              </div>
            </WalkStep>
            <WalkStep
              n={4}
              title="Post one GitHub review. Yours."
              shot="/shots/flow-review-4-post.png"
              alt="The overall-review composer with a short human-written summary, a verdict picker set to Request changes, and the Preview payload / Post to GitHub controls."
              last
            >
              <p>
                Write the top-level comment in your own words, pick the verdict, and post —{' '}
                <span className="font-medium text-gray-200">
                  one GitHub review: your body, your verdict, your chosen findings inline
                </span>
                , pinned to the head SHA so it can never land on stale code. Your teammates
                see a review from you, not a bot flood. And the run is saved per commit —
                re-review after a push and the old one stays in history.
              </p>
              <p>
                Accepted a finding that needs code? The{' '}
                <span className="text-gray-200">“Generate fix from this review”</span>{' '}
                button hands your curated findings straight to the agentic fixer below.
              </p>
            </WalkStep>
          </div>
        </div>

        <p className="mt-8 rounded-xl border border-brand-purple/20 bg-brand-purple/5 px-4 py-3 text-sm leading-relaxed text-gray-300">
          <span className="font-semibold text-brand-purpleSoft">
            Why not just ask the CLI? ·{' '}
          </span>
          You can — and the review evaporates when the session ends. No line-anchored
          posting, no per-commit history, no memory of what you kept last time, and the
          copy-paste back into GitHub is on you. Pierre keeps the same agent, and removes
          the same twenty minutes — per PR, per day.
        </p>
      </Section>

      {/* ai fix */}
      <Section id="ai-fix" width="wide" className="scroll-mt-24 py-16 sm:py-20">
        <ProHeading
          icon={WrenchIcon}
          accent="text-brand-amber"
          eyebrow="AI Analysis & Fix"
          title="From red CI to pushed fix, one click at a time."
          tier="byo"
        />
        <div className="mt-6">
          <Shot
            src="/shots/ai-fix.png"
            alt="The AI Analysis & Fix tab: a CI-failure diagnosis, a generated patch shown as a reviewable file diff, and push controls."
            title="pierre · AI Fix"
          />
        </div>
        <p className="mt-6 max-w-3xl text-pretty leading-relaxed text-gray-400">
          Like Claude Review, it runs on <span className="text-gray-200">Claude Sonnet 5</span>{' '}
          by default — the latest Claude — with <span className="text-gray-200">Opus 4.8</span>{' '}
          selectable for the hardest fixes.
        </p>

        {/* the walkthrough */}
        <div className="mt-14">
          <SectionHeading
            eyebrow="Walk through it"
            eyebrowClass="text-amber-200"
            title="Red CI to pushed fix, step by step."
            lead="A real failing check on a real PR — these are the screens, in order. Total human effort: reading a diagnosis and approving a diff."
          />
          <div className="mt-12">
            <WalkStep
              n={1}
              accent="amber"
              title="CI goes red. You don’t go log-spelunking."
              shot="/shots/flow-fix-1-ci.png"
              alt="The CI status block on the PR: terraform plan failed, tflint and checkov passed."
            >
              <p>
                <span className="font-mono text-gray-300">terraform plan</span> fails on an
                infrastructure PR. Normally that’s a tab into GitHub Actions, a scroll
                through a thousand log lines, and a guess. In Pierre the failing check is
                already on the PR’s pane — and the next step reads the log for you.
              </p>
            </WalkStep>
            <WalkStep
              n={2}
              accent="amber"
              title="One click for a diagnosis, with its confidence shown."
              shot="/shots/flow-fix-2-analysis.png"
              alt="The CI failure analysis: confidence chips reading root cause high / fixability high, a root-cause explanation naming the inverted min/max autoscaling bounds, the failing check identified, a suggested fix, and Re-analyze / Fix it buttons."
            >
              <p>
                Pierre pulls the failing job log and produces a diagnosis: the root cause
                (an inverted <span className="font-mono text-gray-300">min/max</span> bound
                — raised the minimum, forgot the maximum), which check failed and why the
                others passing narrows it, and a suggested fix —{' '}
                <span className="text-gray-200">
                  with its confidence stated up front
                </span>
                , so you know how much to trust it before you act. Agree? Click{' '}
                <span className="text-gray-200">Fix it →</span>.
              </p>
            </WalkStep>
            <WalkStep
              n={3}
              accent="amber"
              title="The agent patches in a sandbox. You review a diff."
              shot="/shots/flow-fix-3-diff.png"
              alt="The AI Fix result: a one-file diff on terraform/eks/node-groups.tf correcting min_size to 2 and max_size to 8, rendered as a reviewable file diff with a summary above it."
            >
              <p>
                The fix runs in an{' '}
                <span className="text-gray-200">ephemeral worktree</span> — never your
                checkout, never the live branch — and comes back as a reviewable,
                file-by-file diff with a summary of what it did and why. Two lines changed
                here; you read it in ten seconds. Nothing has touched GitHub yet.
              </p>
            </WalkStep>
            <WalkStep
              n={4}
              accent="amber"
              title="Push it — conflicts included, force-push excluded."
              shot="/shots/flow-fix-4-push.png"
              alt="The push panel: a generated commit message, a choice between pushing to the PR branch or a new branch with a fresh PR, a “Let Claude resolve conflicts” toggle, and Rebase onto trunk / Merge trunk in / Push + open PR buttons."
              last
            >
              <p>
                Approve the commit message and pick the target: the PR’s own branch (when
                you have push rights) or a new branch with a fresh PR. Trunk moved under
                the PR while you were at it? Pierre checks, and can{' '}
                <span className="text-gray-200">
                  rebase or merge with agentic conflict resolution
                </span>{' '}
                in the same worktree — showing you the result before anything moves. It
                never force-pushes anywhere but the PR’s own branch, never without your
                click, and a conflict the agent can’t cleanly resolve is never pushed at
                all.
              </p>
            </WalkStep>
          </div>
        </div>

        <p className="mt-8 rounded-xl border border-brand-amber/20 bg-brand-amber/5 px-4 py-3 text-sm leading-relaxed text-gray-300">
          <span className="font-semibold text-amber-200">Could you do this in your CLI? · </span>
          Absolutely: clone, checkout, tail the log, paste it at the agent, apply the
          patch, resolve the rebase, push — call it fifteen minutes when nothing surprises
          you. Times every red build, every day. Pierre makes the whole loop four clicks,
          and the git plumbing — worktrees, conflict resolution, branch hygiene — is the
          part it never gets wrong.
        </p>
      </Section>

      {/* control */}
      <Section id="control" width="wide" className="scroll-mt-24 py-12 sm:py-16">
        <ProHeading
          icon={LockIcon}
          accent="text-brand-green"
          eyebrow="Control"
          title="Your models, your data."
          tier="byo"
        />
        <div className="mt-8 grid gap-6 md:grid-cols-3">
          <div className="rounded-2xl border border-white/10 bg-white/5 p-6">
            <LockIcon className="h-6 w-6 text-brand-green" />
            <h3 className="mt-4 text-base font-semibold text-gray-100">Auth, today</h3>
            <p className="mt-2 text-sm leading-relaxed text-gray-400">
              Agentic features run on your own Anthropic API key. Usage is tracked
              transparently in credits, in-app — no surprise bills, no background
              spend.
            </p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/5 p-6">
            <ClockIcon className="h-6 w-6 text-brand-sky" />
            <h3 className="mt-4 text-base font-semibold text-gray-100">Coming</h3>
            <p className="mt-2 text-sm leading-relaxed text-gray-400">
              Metered pay-as-you-go at API list price, and OpenAI-compatible BYO endpoints —
              Bedrock, self-hosted, open models — for cost and privacy control.
            </p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/5 p-6">
            <ShieldedHand className="h-6 w-6 text-brand-purpleSoft" />
            <h3 className="mt-4 text-base font-semibold text-gray-100">The rule</h3>
            <p className="mt-2 text-sm leading-relaxed text-gray-400">
              AI never merges, posts, or pushes without a human click. Every review is yours
              to author; every fix is a diff you approved. That’s not a limitation — it’s
              the feature.
            </p>
          </div>
        </div>
        <p className="mt-8 rounded-2xl border border-brand-green/20 bg-brand-green/5 px-5 py-4 text-pretty text-sm leading-relaxed text-gray-300 sm:text-base">
          <span className="font-semibold text-green-200">Privacy · </span>
          Your data is yours — private and confidential, forever. Pierre never trains on it,
          never shares it, and in local mode it never even leaves your machine.
        </p>
      </Section>

      {/* next */}
      <Section width="narrow" className="py-20 text-center">
        <Pill className={PRO_PILL}>Pro · $5/mo</Pill>
        <h2 className="mt-4 text-pretty text-2xl font-bold tracking-tight text-gray-50 sm:text-3xl">
          Five dollars. Fewer tabs than that.
        </h2>
        <p className="mx-auto mt-3 max-w-lg text-gray-400">
          The board is free forever. Pro is the layer that reads it for you.
        </p>
        <Link
          to="/pricing"
          className="group mt-7 inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-5 py-3 text-sm font-semibold text-gray-100 transition hover:bg-white/10"
        >
          See pricing
          <ArrowRightIcon className="h-4 w-4 transition group-hover:translate-x-0.5" />
        </Link>
      </Section>
    </>
  );
}

/** Locally-owned icon (hand + check — human approval). */
function ShieldedHand({ className }: { className?: string }): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d="M12 3l7 3v5c0 4.4-3 8.4-7 10-4-1.6-7-5.6-7-10V6l7-3Z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}
