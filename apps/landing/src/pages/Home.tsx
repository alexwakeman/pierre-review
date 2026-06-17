import HeroWordmark from '../components/HeroWordmark';
import { Link } from '../router';
import { useSeo } from '../lib/seo';
import { Section, SectionHeading, Shot, Eyebrow, Pill, Glow } from '../components/ui';
import {
  GitHubMark,
  ArrowRightIcon,
  TimelineIcon,
  MyTurnIcon,
  SparkleIcon,
  InsightsIcon,
  FeedIcon,
  FocusIcon,
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

const PILLARS = [
  {
    icon: TimelineIcon,
    accent: 'text-brand-sky',
    chip: 'bg-brand-sky/10 ring-brand-sky/30',
    title: 'See everything, in one place',
    body: 'Every repo, every contributor, every PR and review on one interactive timeline. No tab-hopping, no 200-email digest — just the shape of the work.',
    to: '/features',
  },
  {
    icon: MyTurnIcon,
    accent: 'text-brand-amber',
    chip: 'bg-brand-amber/10 ring-brand-amber/30',
    title: 'Know what is actually yours',
    body: '“My Turn” cuts the noise to the handful of things waiting on you — reviews requested, your PRs with new activity, threads sitting in your court.',
    to: '/features#my-turn',
  },
  {
    icon: SparkleIcon,
    accent: 'text-brand-purpleSoft',
    chip: 'bg-brand-purple/10 ring-brand-purple/30',
    title: 'Reviews that don’t disappear',
    body: 'Claude reviews a PR into structured, line-anchored findings that are saved per commit — always there to refer back to, never buried in a chat tab you closed.',
    to: '/reviews',
  },
];

const SECONDARY = [
  {
    icon: InsightsIcon,
    title: 'Insights',
    body: 'Throughput, review latency, cycle-time and PR-size analytics per repo.',
    to: '/insights',
  },
  {
    icon: FeedIcon,
    title: 'Feed',
    body: 'A quiet, chronological stream of what changed across your watched repos.',
    to: '/features#feed',
  },
  {
    icon: FocusIcon,
    title: 'Focus mode',
    body: 'Isolate a single PR and everyone touching it — the rest of the board falls away.',
    to: '/features#focus',
  },
];

export default function Home(): JSX.Element {
  useSeo({
    path: '/',
    title: 'Pierre — see your team’s GitHub activity at a glance',
    description:
      'Pierre turns GitHub’s firehose of emails, pings and pulls into one calm, timeline-first dashboard — who’s doing what, what’s stalled, and what needs your review.',
  });

  return (
    <>
      {/* ---------- hero ---------- */}
      <header className="relative overflow-hidden">
        <Glow className="absolute -top-32 left-1/2 h-[36rem] w-[36rem] -translate-x-1/2 rounded-full bg-brand-blueDeep/20 blur-[140px]" />
        <Glow className="absolute -top-10 right-[6%] h-72 w-72 rounded-full bg-brand-sky/20 blur-[120px]" />
        <Glow className="absolute top-44 left-[4%] h-72 w-72 rounded-full bg-brand-purple/20 blur-[120px]" />

        <Section width="default" className="pb-14 pt-14 text-center sm:pt-20">
          <HeroWordmark />

          <h1 className="mx-auto max-w-3xl text-balance text-4xl font-bold leading-[1.08] tracking-tight text-gray-50 sm:text-6xl">
            See the whole team’s GitHub{' '}
            <span className="bg-gradient-to-r from-brand-sky via-brand-blue to-brand-purpleSoft bg-clip-text text-transparent">
              at a glance.
            </span>
          </h1>

          <p className="mx-auto mt-6 max-w-2xl text-pretty text-lg leading-relaxed text-gray-400">
            GitHub tells you everything, all the time, in a hundred places. Pierre turns
            that firehose into one timeline-first dashboard: who’s doing what, which PRs
            are stalled, which threads are stuck, and what needs <em>you</em> right now.
          </p>

          <div className="mt-9 flex flex-col items-center justify-center gap-4 sm:flex-row">
            <PrimaryCta />
            <Link
              to="/features"
              className="group inline-flex items-center gap-1.5 text-sm font-medium text-gray-300 transition hover:text-white"
            >
              Take the tour
              <ArrowRightIcon className="h-4 w-4 transition group-hover:translate-x-0.5" />
            </Link>
          </div>

          <p className="mt-6 text-sm text-gray-500">
            Sign in with GitHub, or run it entirely on your machine — local mode keeps
            no stored credentials.
          </p>
        </Section>

        {/* signature screenshot */}
        <Section width="wide" className="pb-6 pt-8">
          <Glow className="absolute -top-16 left-1/2 h-72 w-[44rem] max-w-full -translate-x-1/2 rounded-full bg-brand-blue/20 blur-[130px]" />
          <Shot
            src="/shots/timeline.png"
            alt="The Pierre timeline: pull-request activity grouped repo → contributor, with shaped review markers, an open-PR strip and a My Turn triage panel."
            eager
            priority
            width={3200}
            height={2000}
          />
          <p className="mx-auto mt-4 max-w-2xl text-center text-sm text-gray-500">
            One board. Repos down the side, time across the top, every PR and review in
            between.
          </p>
        </Section>
      </header>

      {/* ---------- the problem ---------- */}
      <Section width="narrow" className="py-20 sm:py-28">
        <Eyebrow className="text-brand-amber">The problem</Eyebrow>
        <h2 className="mt-3 text-pretty text-3xl font-bold tracking-tight text-gray-50 sm:text-4xl">
          GitHub doesn’t have a visibility problem. It has a{' '}
          <span className="text-brand-amber">too-much-visibility</span> problem.
        </h2>
        <div className="mt-6 space-y-4 text-pretty text-base leading-relaxed text-gray-400 sm:text-lg">
          <p>
            A fast team throws off a relentless stream of signal: review-requested emails,
            Slack webhooks, merge notifications, “can you take a look?” DMs, and the daily
            ritual of <code className="font-mono text-gray-300">git pull</code> to find out
            what actually moved. Each one is individually reasonable. Together they bury the
            two or three things that genuinely need you.
          </p>
          <p>
            And GitHub’s own tools don’t close the gap. The notifications inbox is
            per-event, not per-state — it tells you a review was <em>requested</em>, never
            that a PR has been green and ignored for four days. There’s no cross-repo view,
            no “what’s stalled,” no sense of shape. <code className="font-mono text-gray-300">git pull</code>{' '}
            is a content-sync tool wearing a status-update costume.
          </p>
        </div>
      </Section>

      {/* ---------- why now: AI-speed delivery ---------- */}
      <section className="relative border-y border-white/5 bg-white/[0.02] py-20 sm:py-28">
        <Glow className="absolute left-1/2 top-0 h-64 w-[40rem] max-w-full -translate-x-1/2 rounded-full bg-brand-purple/12 blur-[130px]" />
        <Section width="narrow">
          <Eyebrow className="text-brand-purpleSoft">Why a lead needs this now</Eyebrow>
          <h2 className="mt-3 text-pretty text-3xl font-bold tracking-tight text-gray-50 sm:text-4xl">
            When generation gets cheap, knowing what’s happening gets expensive.
          </h2>
          <div className="mt-6 space-y-4 text-pretty text-base leading-relaxed text-gray-400 sm:text-lg">
            <p>
              AI-assisted development inverted the ratio. Writing a change is no longer the
              bottleneck; understanding it, reviewing it, and being willing to put your name
              on it is — and a team now opens more PRs in a day than any one person can hold
              in their head. The coordination that used to live in someone’s memory (who’s
              blocked, what’s stalled, which review is holding the release) simply doesn’t
              scale with the throughput.
            </p>
            <p>
              Skip it and the failure mode is <span className="font-medium text-gray-200">quiet</span>:
              the approved PR nobody merged, the review thread dropped on the floor, the one
              reviewer everything routes through, quietly burning out. None of it pages you.
              For a lead running an AI-enabled team at pace, a board that makes the state of
              the work legible isn’t a nice-to-have — it’s the difference between steering
              and finding out later.
            </p>
          </div>
        </Section>
      </section>

      {/* ---------- three pillars ---------- */}
      <Section width="wide" className="py-8">
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

      {/* ---------- My Turn spotlight ---------- */}
      <Section width="wide" className="py-20 sm:py-28">
        <div className="grid items-center gap-8 lg:grid-cols-2 lg:gap-12">
          <div>
            <Eyebrow className="text-brand-amber">My Turn</Eyebrow>
            <h2 className="mt-3 text-pretty text-3xl font-bold tracking-tight text-gray-50 sm:text-4xl">
              Most inboxes add. This one subtracts.
            </h2>
            <p className="mt-4 text-pretty leading-relaxed text-gray-400">
              Pierre reads your team’s activity and computes — on every load, never stored
              stale — the short list that’s genuinely on you: reviews you’ve been requested
              for, your own PRs with new commits or comments, and review threads you started
              that someone else has since replied to. Clear one and it’s gone, until real
              new activity brings it back.
            </p>
            <p className="mt-4 text-pretty leading-relaxed text-gray-400">
              Enter <span className="font-medium text-gray-200">My Turn Focus</span> and the
              whole timeline collapses to just those PRs — even the ones older than your date
              filter, fetched automatically so nothing in your court hides off-screen.
            </p>
            <Link
              to="/features#my-turn"
              className="group mt-6 inline-flex items-center gap-1.5 text-sm font-medium text-brand-sky transition hover:text-brand-skySoft"
            >
              How triage is computed
              <ArrowRightIcon className="h-4 w-4 transition group-hover:translate-x-0.5" />
            </Link>
          </div>
          <Shot
            src="/shots/my-turn.png"
            alt="The My Turn panel: reviews awaiting you, your PRs with new activity, and review threads awaiting your response, each with a one-click dismiss."
            title="pierre · My Turn"
          />
        </div>
      </Section>

      {/* ---------- Claude Review spotlight ---------- */}
      <section className="relative border-y border-white/5 bg-white/[0.02] py-20 sm:py-28">
        <Glow className="absolute right-[8%] top-10 h-64 w-64 rounded-full bg-brand-purple/15 blur-[120px]" />
        <Section width="wide">
          <div className="grid items-center gap-8 lg:grid-cols-2 lg:gap-12">
            <Shot
              src="/shots/claude-review.png"
              alt="The Claude Review tab: an agentic review returning severity-tagged, line-anchored findings you can reword, tick to include, and post as a single GitHub review."
              title="pierre · Claude Review"
              className="lg:order-2"
            />
            <div className="lg:order-1">
              <Pill className="bg-brand-purple/15 text-brand-purpleSoft ring-brand-purple/30">
                Local-only · opt-in
              </Pill>
              <h2 className="mt-3 text-pretty text-3xl font-bold tracking-tight text-gray-50 sm:text-4xl">
                The AI reads. You decide what ships.
              </h2>
              <p className="mt-4 text-pretty leading-relaxed text-gray-400">
                Run the Claude Agent SDK against a PR and get structured findings —
                blockers, warnings, nits, questions — each anchored to a line. A
                deterministic router decides whether a small diff gets a fast,
                clone-free pass or a large one earns a full worktree checkout to explore.
              </p>
              <p className="mt-4 text-pretty leading-relaxed text-gray-400">
                Every run is persisted per head SHA, so the review you got on Tuesday is
                still here on Friday. You write your own review, tick the findings worth
                keeping, and post <span className="font-medium text-gray-200">one</span>{' '}
                GitHub review. Claude’s words are reference; yours are what ship.
              </p>
              <Link
                to="/reviews"
                className="group mt-6 inline-flex items-center gap-1.5 text-sm font-medium text-brand-purpleSoft transition hover:text-white"
              >
                Deep vs quick reviews, explained
                <ArrowRightIcon className="h-4 w-4 transition group-hover:translate-x-0.5" />
              </Link>
            </div>
          </div>
        </Section>
      </section>

      {/* ---------- secondary feature trio ---------- */}
      <Section width="wide" className="py-20 sm:py-28">
        <SectionHeading
          eyebrow="More"
          title="The rest of the board"
          lead="Everything composes — and most of it lives in the URL, so any view you build is one paste away from a teammate."
        />
        <div className="mt-12 grid gap-6 sm:grid-cols-3">
          {SECONDARY.map((s) => (
            <Link
              key={s.title}
              to={s.to}
              className="group flex flex-col rounded-2xl border border-white/10 bg-white/5 p-6 transition hover:border-white/20 hover:bg-white/[0.07]"
            >
              <s.icon className="h-6 w-6 text-brand-sky" />
              <h3 className="mt-4 text-base font-semibold text-gray-100">{s.title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-gray-400">{s.body}</p>
            </Link>
          ))}
        </div>
      </Section>

      {/* ---------- run locally ---------- */}
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
            syncs to a local SQLite file, and opens straight to the timeline.
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

      {/* ---------- final CTA ---------- */}
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
