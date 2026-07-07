import type { ReactNode } from 'react';
import HeroWordmark from '../components/HeroWordmark';
import Carousel, { type CarouselSlide } from '../components/Carousel';
import { Link } from '../router';
import { useSeo } from '../lib/seo';
import { Section, SectionHeading, Shot, Eyebrow, Pill, Glow } from '../components/ui';
import {
  GitHubMark,
  ArrowRightIcon,
  TimelineIcon,
  SparkleIcon,
  InsightsIcon,
  FeedIcon,
  BoltIcon,
} from '../components/icons';

function PrimaryCta({ className = '' }: { className?: string }): JSX.Element {
  return (
    <a
      href="/api/auth/login"
      className={`group inline-flex items-center justify-center gap-2.5 rounded-xl bg-gradient-to-r from-brand-blueDeep to-brand-blue px-6 py-3.5 text-base font-semibold text-white shadow-sky-glow transition hover:from-brand-blue hover:to-brand-sky focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-skySoft focus-visible:ring-offset-2 focus-visible:ring-offset-gray-950 ${className}`}
    >
      <GitHubMark className="h-5 w-5" />
      Sign in with GitHub
    </a>
  );
}

// Hero carousel — Pro capabilities up front (the reasons to pay), then the free
// core surfaces (the reasons to trust). Ordering is deliberate: report → metrics
// → digests → fix → review → feed → board.
const TOUR: CarouselSlide[] = [
  {
    src: '/shots/sprint-report.png',
    alt: 'The Pierre sprint report: an AI-written summary of the sprint window, leading with flow metrics and naming blockers with PR links.',
    label: 'Sprint reports',
    tier: 'Pro',
    fit: 'contain',
    caption:
      'Monday status, written for you — flow metrics up top, blockers named, every PR linked. In-app and in Slack.',
  },
  {
    src: '/shots/flow-metrics.png',
    alt: 'DORA-style flow metric charts: deploy frequency, lead time, review latency, merge-vs-CI health and CI recovery time.',
    label: 'Flow metrics',
    tier: 'Pro',
    fit: 'contain',
    caption:
      'DORA-style metrics from the PR history you already synced — every tile clicks through to the PRs behind the number.',
  },
  {
    src: '/shots/repo-console.png',
    alt: 'A repo console with its AI digest: a bulleted change report with clickable PR references above the open-PR list.',
    label: 'Repo summaries',
    tier: 'Pro',
    caption:
      'Per-repo AI change reports, chained from the previous one — what changed since you last looked, with clickable PR refs.',
  },
  {
    src: '/shots/ai-fix.png',
    alt: 'The AI Analysis & Fix tab: a CI-failure diagnosis, a generated patch shown as a reviewable file diff, and push controls.',
    label: 'CI auto-fix',
    tier: 'Pro · BYO key',
    fit: 'contain',
    caption:
      'Red CI → diagnosis → reviewable patch → pushed to the branch. One click per step, nothing moves without you.',
  },
  {
    src: '/shots/claude-review.png',
    alt: 'The Claude Review tab: severity-tagged, line-anchored findings and a separate “your review” composer that posts to GitHub.',
    label: 'Claude Review',
    tier: 'Pro · BYO key',
    fit: 'contain',
    caption:
      'Structured, line-anchored findings you curate and post as one GitHub review — saved per commit, feeding the next run.',
  },
  {
    src: '/shots/activity-feed-pro.png',
    alt: 'The Activity feed: one chronological cross-repo stream, with yellow-bordered My Turn cards flagging events on PRs you participate in.',
    label: 'Activity feed',
    tier: 'Pro',
    caption:
      'The cross-repo feed is free core. Pro makes it participation-aware: every event that needs you arrives flagged “My Turn”.',
  },
  {
    src: '/shots/timeline.png',
    alt: 'The Pierre timeline: pull-request activity grouped repo → contributor, with shaped review markers and an open-PR strip.',
    label: 'Timeline',
    tier: 'Free',
    caption:
      'Every repo, contributor and PR on one board — a stalled PR is a long bar with no fresh markers, obvious at a glance.',
  },
];

const PILLARS = [
  {
    icon: FeedIcon,
    accent: 'text-brand-amber',
    chip: 'bg-brand-amber/10 ring-brand-amber/30',
    title: 'A feed that knows what’s yours',
    body: 'A cross-repo activity feed that reads like a changelog, not a firehose — the view Pierre opens on — and with Pro, every event on a PR you’re part of arrives flagged as your turn.',
    to: '/features#activity',
  },
  {
    icon: TimelineIcon,
    accent: 'text-brand-sky',
    chip: 'bg-brand-sky/10 ring-brand-sky/30',
    title: 'A board for the whole picture',
    body: 'Every repo, every contributor, every PR, review and CI run on one interactive timeline. Repos down the side, time across the top — the shape of the work, at a glance.',
    to: '/features#timeline',
  },
  {
    icon: SparkleIcon,
    accent: 'text-brand-purpleSoft',
    chip: 'bg-brand-purple/10 ring-brand-purple/30',
    title: 'AI that answers to you',
    body: 'Digests, sprint reports, one-click fixes, and agentic review that learns how you review — every run remembers what you kept, cut and reworded. Nothing merges, posts or pushes without your click.',
    to: '/pro',
  },
];

const AUDIENCES = [
  {
    icon: InsightsIcon,
    accent: 'text-brand-sky',
    chip: 'bg-brand-sky/10 ring-brand-sky/30',
    title: 'For engineering managers',
    points: [
      'Sprint-oriented reports on blockers, what needs attention, and where throughput is improving.',
      'DORA-style flow metrics you can drill into — mirrors, not scorecards.',
      'Reviewer suggestions drawn from who actually touched the changed files — requested in one click.',
      'A reliable state of play, in-app and in Slack, prioritised by what’s actually waiting.',
    ],
  },
  {
    icon: BoltIcon,
    accent: 'text-brand-amber',
    chip: 'bg-brand-amber/10 ring-brand-amber/30',
    title: 'For engineers',
    points: [
      'Track your PRs — and every PR you participate in — across all your team’s repos.',
      'Know instantly when it’s your turn, without keeping forty tabs warm.',
      'One-click AI review that remembers how you review, CI-failure analysis, and fixes pushed straight to the branch. When you say so.',
      'The morning “what needs me?” reconstruction — gone. It’s one feed, already sorted.',
    ],
  },
];

/** A single step chip in the one-click resolution flows. */
function FlowStep({ n, children }: { n: number; children: ReactNode }): JSX.Element {
  return (
    <div className="flex flex-1 items-start gap-3 rounded-2xl border border-white/10 bg-white/5 p-4">
      <span className="mt-0.5 inline-flex h-6 w-6 flex-none items-center justify-center rounded-full bg-brand-purple/15 text-xs font-semibold text-brand-purpleSoft ring-1 ring-brand-purple/30">
        {n}
      </span>
      <p className="text-sm leading-relaxed text-gray-300">{children}</p>
    </div>
  );
}

function FlowArrow(): JSX.Element {
  return (
    <ArrowRightIcon className="hidden h-5 w-5 flex-none self-center text-gray-600 sm:block" />
  );
}

export default function Home(): JSX.Element {
  useSeo({
    path: '/',
    title: 'Pierre — your team’s GitHub on one fast timeline',
    description:
      'A single pane of glass for all your team’s GitHub activity — every PR, review thread and CI run across every repo. See what’s stalled, what’s yours, and what the AI slipped past everyone.',
  });

  return (
    <>
      {/* ---------- 1 · hero ---------- */}
      <header className="relative overflow-hidden">
        <Glow className="absolute -top-32 left-1/2 h-[36rem] w-[36rem] -translate-x-1/2 rounded-full bg-brand-blueDeep/20 blur-[140px]" />
        <Glow className="absolute -top-10 right-[6%] h-72 w-72 rounded-full bg-brand-sky/20 blur-[120px]" />
        <Glow className="absolute top-44 left-[4%] h-72 w-72 rounded-full bg-brand-purple/20 blur-[120px]" />

        <Section width="default" className="pb-14 pt-14 text-center sm:pt-20">
          <HeroWordmark />

          <h1 className="mx-auto max-w-3xl text-balance text-4xl font-bold leading-[1.08] tracking-tight text-gray-50 sm:text-6xl">
            Your team ships from ten repos.{' '}
            <span className="bg-gradient-to-r from-brand-sky via-brand-blue to-brand-purpleSoft bg-clip-text text-transparent">
              You have two eyes.
            </span>
          </h1>

          <p className="mx-auto mt-6 max-w-2xl text-pretty text-lg leading-relaxed text-gray-400">
            Pierre is a single pane of glass for all your team’s GitHub activity — every
            PR, review thread, and CI run across every repo, in one fast place. See
            what’s stalled, what’s yours, and what the AI slipped past everyone.
          </p>

          <div className="mt-9 flex flex-col items-center justify-center gap-4 sm:flex-row">
            <PrimaryCta />
            <Link
              to="/features"
              className="group inline-flex items-center gap-1.5 text-sm font-medium text-gray-300 transition hover:text-white"
            >
              See what’s free
              <ArrowRightIcon className="h-4 w-4 transition group-hover:translate-x-0.5" />
            </Link>
          </div>

          <p className="mt-6 text-sm text-gray-500">
            Sign in with GitHub, or run it entirely on your machine — local mode keeps
            no stored credentials.
          </p>
        </Section>

        {/* ---------- 2 · the product tour carousel (Pro-first) ---------- */}
        <Section width="wide" className="pb-6 pt-8">
          <Glow className="absolute -top-16 left-1/2 h-72 w-[44rem] max-w-full -translate-x-1/2 rounded-full bg-brand-blue/20 blur-[130px]" />
          <Carousel slides={TOUR} />
        </Section>
      </header>

      {/* ---------- 3 · the AI-era problem ---------- */}
      <Section width="narrow" className="py-20 sm:py-28">
        <Eyebrow className="text-brand-amber">The problem</Eyebrow>
        <h2 className="mt-3 text-pretty text-3xl font-bold tracking-tight text-gray-50 sm:text-4xl">
          Everyone says AI makes engineers 10× faster.{' '}
          <span className="text-brand-amber">Nobody says how to keep up with the reviewing.</span>
        </h2>
        <div className="mt-6 space-y-4 text-pretty text-base leading-relaxed text-gray-400 sm:text-lg">
          <p>
            AI multiplied the code, not the attention. More PRs, more bot comments, more
            CI runs, more notifications — across more repos than any one person can keep
            in their head. The bottleneck quietly moved from writing the change to
            noticing it.
          </p>
          <p>
            And nobody tells you how to review AI-written code, how to measure its
            impact, or how to stop AI slop creeping into production. Engineering leaders
            are figuring this out right now — mostly by drowning.
          </p>
          <p>
            Pierre is built for exactly this:{' '}
            <span className="font-medium text-gray-200">
              human-in-the-loop triage for the high-throughput era.
            </span>
          </p>
        </div>
      </Section>

      {/* ---------- 4 · the duel ---------- */}
      <section className="relative border-y border-white/5 bg-white/[0.02] py-20 sm:py-24">
        <Glow className="absolute left-1/2 top-6 h-64 w-[38rem] max-w-full -translate-x-1/2 rounded-full bg-brand-sky/10 blur-[130px]" />
        <Section width="default" className="text-center">
          <img
            src="/duel.svg"
            alt="A hand-drawn sketch of a small knight — Pierre — squaring up to a many-tentacled notification kraken."
            loading="lazy"
            decoding="async"
            className="mx-auto block h-auto w-full max-w-2xl"
          />
          <p className="mx-auto mt-5 max-w-xl font-serif text-base italic leading-relaxed text-gray-500">
            Pierre v. the notification kraken. (Artist’s impression. The kraken is
            winning at your current tab count.)
          </p>
          <p className="mx-auto mt-8 max-w-2xl text-pretty text-base leading-relaxed text-gray-400 sm:text-lg">
            GitHub is a firehose wearing a UI — slow to navigate, endless tabs,
            notifications from humans and bots alike. Pierre pulls it all into one place
            and gets out of your way. And it’s fast. Genuinely, annoyingly fast.
          </p>
        </Section>
      </section>

      {/* ---------- 5 · two audiences ---------- */}
      <Section width="wide" className="py-20 sm:py-28">
        <SectionHeading
          eyebrow="Who it’s for"
          title="Built for the two people drowning in the same firehose."
        />
        <div className="mt-12 grid gap-6 md:grid-cols-2">
          {AUDIENCES.map((a) => (
            <div
              key={a.title}
              className="rounded-2xl border border-white/10 bg-white/5 p-7 backdrop-blur"
            >
              <span
                className={`inline-flex h-11 w-11 items-center justify-center rounded-xl ring-1 ${a.chip}`}
              >
                <a.icon className={`h-6 w-6 ${a.accent}`} />
              </span>
              <h3 className="mt-5 text-lg font-semibold text-gray-100">{a.title}</h3>
              <ul className="mt-4 space-y-3">
                {a.points.map((p) => (
                  <li key={p} className="flex gap-3 text-sm leading-relaxed text-gray-400">
                    <span
                      aria-hidden="true"
                      className={`mt-[7px] h-1.5 w-1.5 flex-none rounded-full ${a.accent.replace('text-', 'bg-')}`}
                    />
                    {p}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </Section>

      {/* ---------- 6 · three pillars ---------- */}
      <Section width="wide" className="pb-20 sm:pb-28">
        <div className="grid gap-6 md:grid-cols-3">
          {PILLARS.map((p) => (
            <Link
              key={p.title}
              to={p.to}
              className="group relative flex flex-col rounded-2xl border border-white/10 bg-white/5 p-6 backdrop-blur transition hover:border-white/20 hover:bg-white/[0.07]"
            >
              <span
                className={`inline-flex h-11 w-11 items-center justify-center rounded-xl ring-1 ${p.chip}`}
              >
                <p.icon className={`h-6 w-6 ${p.accent}`} />
              </span>
              <h3 className="mt-5 text-lg font-semibold text-gray-100">{p.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-gray-400">{p.body}</p>
              <span className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-gray-300 transition group-hover:text-white">
                Learn more
                <ArrowRightIcon className="h-4 w-4 transition group-hover:translate-x-0.5" />
              </span>
            </Link>
          ))}
        </div>
      </Section>

      {/* ---------- 7 · free spotlight: the board + repo consoles ---------- */}
      <section className="relative border-y border-white/5 bg-white/[0.02] py-20 sm:py-28">
        <Glow className="absolute left-[8%] top-10 h-64 w-64 rounded-full bg-brand-sky/15 blur-[120px]" />
        <Section width="wide">
          <div className="grid items-center gap-8 lg:grid-cols-2 lg:gap-12">
            <div>
              <Eyebrow className="text-brand-green">Free, open-core, forever</Eyebrow>
              <h2 className="mt-3 text-pretty text-3xl font-bold tracking-tight text-gray-50 sm:text-4xl">
                Most dashboards add tabs. This one closes them.
              </h2>
              <p className="mt-4 text-pretty leading-relaxed text-gray-400">
                Behind the feed sits the board — every repo, every contributor, every PR,
                review and CI run on one interactive timeline. Duration and staleness live
                in the shape: a long bar with no recent markers is a stalled PR, no query
                required.
              </p>
              <p className="mt-4 text-pretty leading-relaxed text-gray-400">
                Pick a repo and its console pulls the same picture into focus — stats, a
                thread-state bar, and every open PR with its CI and approval standing. The
                feed, the board, the consoles, the PR detail, the write actions — all of it
                free, open-core, forever.
              </p>
              <Link
                to="/features"
                className="group mt-6 inline-flex items-center gap-1.5 text-sm font-medium text-brand-sky transition hover:text-brand-skySoft"
              >
                Everything in the free tier
                <ArrowRightIcon className="h-4 w-4 transition group-hover:translate-x-0.5" />
              </Link>
            </div>
            <Shot
              src="/shots/repo-console-free.png"
              alt="A per-repo console: a stats header, a thread-state bar, and the repo’s open PRs with CI and approval standing."
              title="pierre · Repo console"
            />
          </div>
        </Section>
      </section>

      {/* ---------- 8 · Pro spotlight: the AI layer ---------- */}
      <Section width="wide" className="py-20 sm:py-28">
        <Glow className="absolute right-[8%] top-10 h-64 w-64 rounded-full bg-brand-purple/15 blur-[120px]" />
        <div className="grid items-center gap-8 lg:grid-cols-2 lg:gap-12">
          <Shot
            src="/shots/sprint-report.png"
            alt="A Pierre sprint report: an AI-written summary of the sprint window, leading with flow metrics and naming blockers with PR links."
            title="pierre · Sprint report"
          />
          <div>
            <Pill className="bg-brand-purple/15 text-brand-purpleSoft ring-brand-purple/30">
              Pro
            </Pill>
            <h2 className="mt-3 text-pretty text-3xl font-bold tracking-tight text-gray-50 sm:text-4xl">
              AI summaries that make sense of the week — not another bot shouting into
              your PRs.
            </h2>
            <p className="mt-4 text-pretty leading-relaxed text-gray-400">
              Per-repo digests and sprint reports, each one chained from the last — what
              changed since you last looked, with clickable PR refs. Delivered to Slack
              on your cadence, daily or twice daily.
            </p>
            <p className="mt-4 text-pretty leading-relaxed text-gray-400">
              It’s the antidote to notification fatigue:{' '}
              <span className="font-medium text-gray-200">pull, don’t push.</span> One
              high-quality report instead of forty pings.
            </p>
            <Link
              to="/pro"
              className="group mt-6 inline-flex items-center gap-1.5 text-sm font-medium text-brand-purpleSoft transition hover:text-white"
            >
              The whole intelligence layer
              <ArrowRightIcon className="h-4 w-4 transition group-hover:translate-x-0.5" />
            </Link>
          </div>
        </div>
      </Section>

      {/* ---------- 9 · one-click resolution strip ---------- */}
      <section className="relative border-y border-white/5 bg-white/[0.02] py-20 sm:py-28">
        <Glow className="absolute left-1/2 top-0 h-64 w-[40rem] max-w-full -translate-x-1/2 rounded-full bg-brand-purple/12 blur-[130px]" />
        <Section width="wide">
          <div className="mx-auto max-w-2xl text-center">
            <Pill className="bg-brand-purple/15 text-brand-purpleSoft ring-brand-purple/30">
              Pro · BYO key
            </Pill>
            <h2 className="mt-3 text-pretty text-3xl font-bold tracking-tight text-gray-50 sm:text-4xl">
              Yes, your CLI can do this. In eleven steps.
            </h2>
            <p className="mt-4 text-pretty text-base leading-relaxed text-gray-400 sm:text-lg">
              You could do all of this in your IDE or CLI — clone, checkout, analyse the
              log, prompt the agent, apply, push. Repeat for every PR, every day. Pierre
              makes each loop one click, including the git merge conflicts.
            </p>
          </div>

          <div className="mx-auto mt-12 max-w-4xl space-y-5">
            <div className="flex flex-col gap-3 sm:flex-row">
              <FlowStep n={1}>
                CI fails. Pierre pulls the failing job log and diagnoses it.
              </FlowStep>
              <FlowArrow />
              <FlowStep n={2}>
                You approve a fix run. The agent patches in an ephemeral worktree — you
                review the actual diff.
              </FlowStep>
              <FlowArrow />
              <FlowStep n={3}>
                The fix is pushed to the branch. PR green.
              </FlowStep>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row">
              <FlowStep n={1}>
                Claude reviews the PR into structured, line-anchored findings.
              </FlowStep>
              <FlowArrow />
              <FlowStep n={2}>
                You tick the findings worth keeping and write your verdict.
              </FlowStep>
              <FlowArrow />
              <FlowStep n={3}>
                One GitHub review is posted. Yours, not the bot’s.
              </FlowStep>
            </div>
          </div>

          <div className="mt-10 text-center">
            <Link
              to="/pro#claude-review"
              className="group inline-flex items-center gap-1.5 text-sm font-medium text-brand-purpleSoft transition hover:text-white"
            >
              Walk through both flows, screen by screen
              <ArrowRightIcon className="h-4 w-4 transition group-hover:translate-x-0.5" />
            </Link>
          </div>
        </Section>
      </section>

      {/* ---------- 10 · not another review bot ---------- */}
      <Section width="narrow" className="py-20 sm:py-28">
        <Eyebrow className="text-brand-sky">Not another review bot</Eyebrow>
        <h2 className="mt-3 text-pretty text-3xl font-bold tracking-tight text-gray-50 sm:text-4xl">
          The review-bot aisle is full. This is the shelf above it.
        </h2>
        <div className="mt-6 space-y-4 text-pretty text-base leading-relaxed text-gray-400 sm:text-lg">
          <p>
            Review bots comment on one PR at a time — and even the good ones still bury
            you: independent audits put roughly a third of bot comments as noise. Pierre
            isn’t competing to shout louder on your diffs.
          </p>
          <p>
            It’s cross-repo situational awareness: all high-value, pull-based
            information — who’s blocked, what’s stalled, which threads sit unanswered —
            with AI review as{' '}
            <span className="font-medium text-gray-200">
              one input you control, not the product.
            </span>
          </p>
          <p>
            And when the AI does review, it reviews <em>your</em> way: every run learns
            from what you kept, cut and reworded last time — so the noise goes down with
            use, not up.
          </p>
        </div>
      </Section>

      {/* ---------- 11 · run locally ---------- */}
      <Section width="narrow" className="py-8">
        <div className="relative overflow-hidden rounded-3xl border border-white/10 bg-white/[0.03] p-8 text-center sm:p-12">
          <Glow className="absolute bottom-0 left-1/2 h-48 w-[28rem] max-w-full -translate-x-1/2 rounded-full bg-brand-green/10 blur-[120px]" />
          <Eyebrow className="text-brand-green">Run it locally</Eyebrow>
          <h2 className="mt-3 text-pretty text-2xl font-bold tracking-tight text-gray-50 sm:text-3xl">
            Or keep it entirely on your machine.
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-pretty leading-relaxed text-gray-400">
            One command. No accounts, no hosted backend, no stored credentials — it
            authenticates with your <code className="font-mono text-gray-300">gh</code> CLI,
            syncs to a local SQLite file, and opens straight to the Activity console.
          </p>
          <div className="mx-auto mt-6 flex max-w-md items-center justify-center gap-3 rounded-xl border border-white/10 bg-gray-900/70 px-5 py-4 font-mono text-sm">
            <span className="select-none text-brand-green">$</span>
            <code className="text-gray-100">npx pierre-review</code>
          </div>
          <Link
            to="/how-it-works#run-locally"
            className="mt-5 inline-block text-sm font-medium text-brand-sky transition hover:text-brand-skySoft"
          >
            What happens when you run it →
          </Link>
        </div>
      </Section>

      {/* ---------- 12 · pricing teaser ---------- */}
      <Section width="default" className="py-20 sm:py-24">
        <SectionHeading
          eyebrow="Pricing"
          title={
            <>
              Free where it matters.{' '}
              <span className="bg-gradient-to-r from-brand-purpleSoft to-brand-sky bg-clip-text text-transparent">
                $5 where it counts.
              </span>
            </>
          }
        />
        <div className="mx-auto mt-10 grid max-w-3xl gap-4 sm:grid-cols-2">
          <div className="rounded-2xl border border-white/10 bg-white/5 p-6">
            <div className="flex items-baseline justify-between">
              <h3 className="text-base font-semibold text-gray-100">Free</h3>
              <span className="text-sm text-gray-500">$0, forever</span>
            </div>
            <p className="mt-2 text-sm leading-relaxed text-gray-400">
              The whole dashboard — Activity feed, timeline, PR detail, write actions.
              Unlimited repos, local-first.
            </p>
          </div>
          <div className="rounded-2xl border border-brand-purple/30 bg-brand-purple/[0.06] p-6">
            <div className="flex items-baseline justify-between">
              <h3 className="text-base font-semibold text-gray-100">Pro</h3>
              <span className="text-sm text-brand-purpleSoft">$5/month</span>
            </div>
            <p className="mt-2 text-sm leading-relaxed text-gray-400">
              The intelligence layer — AI summaries, team Insights, flow metrics, Slack
              digests, My Turn.
            </p>
          </div>
        </div>
        <div className="mt-8 text-center">
          <Link
            to="/pricing"
            className="group inline-flex items-center gap-1.5 text-sm font-medium text-brand-sky transition hover:text-brand-skySoft"
          >
            Compare the tiers
            <ArrowRightIcon className="h-4 w-4 transition group-hover:translate-x-0.5" />
          </Link>
        </div>
      </Section>

      {/* ---------- 13 · final CTA ---------- */}
      <Section width="narrow" className="py-24 text-center">
        <h2 className="text-pretty text-3xl font-bold tracking-tight text-gray-50 sm:text-4xl">
          Stop reconstructing the day from notifications.
        </h2>
        <p className="mx-auto mt-4 max-w-xl text-gray-400">
          Sign in with GitHub and the recent timeline fills in seconds, while the full
          history backfills behind it.
        </p>
        <div className="mt-8 flex justify-center">
          <PrimaryCta />
        </div>
        <p className="mt-5 text-sm text-gray-500">
          Pierre is a desktop experience today — a phone-friendly build is on the{' '}
          <Link to="/how-it-works#roadmap" className="text-gray-400 underline-offset-2 hover:underline">
            roadmap
          </Link>
          .
        </p>
      </Section>
    </>
  );
}
