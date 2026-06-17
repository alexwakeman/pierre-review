import type { ReactNode } from 'react';
import { Link } from '../router';
import { useSeo } from '../lib/seo';
import { Section, SectionHeading, Shot, Eyebrow, Pill, Glow, FeatureRow } from '../components/ui';
import {
  TimelineIcon,
  FocusIcon,
  MyTurnIcon,
  FeedIcon,
  ThreadIcon,
  StripIcon,
  FilterIcon,
  KeyboardIcon,
  ShieldIcon,
  ArrowRightIcon,
} from '../components/icons';

function Why({ children }: { children: ReactNode }): JSX.Element {
  return (
    <p className="mt-5 rounded-xl border border-brand-sky/20 bg-brand-sky/5 px-4 py-3 text-sm leading-relaxed text-gray-300">
      <span className="font-semibold text-brand-skySoft">Why it matters · </span>
      {children}
    </p>
  );
}

function FeatureHeading({
  icon: Icon,
  accent,
  eyebrow,
  title,
}: {
  icon: (p: { className?: string }) => ReactNode;
  accent: string;
  eyebrow: string;
  title: string;
}): JSX.Element {
  return (
    <div>
      <div className="flex items-center gap-2">
        <Icon className={`h-5 w-5 ${accent}`} />
        <Eyebrow className={accent}>{eyebrow}</Eyebrow>
      </div>
      <h2 className="mt-3 text-pretty text-2xl font-bold tracking-tight text-gray-50 sm:text-3xl">
        {title}
      </h2>
    </div>
  );
}

const DERIVED_STATES = [
  {
    label: 'Resolved',
    dot: 'bg-brand-green',
    body: 'Marked resolved on GitHub. Done — no action needed.',
  },
  {
    label: 'Likely addressed',
    dot: 'bg-brand-blue',
    body: 'A commit touched the thread’s file after the last comment. A heuristic — and the UI says so, because renames and unrelated edits can fool it.',
  },
  {
    label: 'Replied · unresolved',
    dot: 'bg-brand-amber',
    body: 'Someone replied, but it’s still open and no later commit touched the file. A live conversation with no fix yet.',
  },
  {
    label: 'Untouched',
    dot: 'bg-brand-red',
    body: 'No reply, no follow-up commit. Feedback left and, so far, ignored.',
  },
];

const SHORTCUTS = [
  { keys: ['/'], label: 'Jump to the repo search' },
  { keys: ['j', 'k'], label: 'Cycle through PRs' },
  { keys: ['m'], label: 'Enter My Turn Focus' },
  { keys: ['i'], label: 'Open Insights' },
  { keys: ['Esc'], label: 'Step back out — focus, then selection' },
];

export default function Features(): JSX.Element {
  useSeo({
    path: '/features',
    title: 'Pierre features — GitHub timeline, PR triage & Focus mode',
    description:
      'A tour of Pierre: the repo→contributor timeline, Focus mode, My Turn triage, the watched-repo Feed, derived thread state, the PR detail pane, and URL-shareable filters.',
  });

  return (
    <>
      {/* hero */}
      <header className="relative overflow-hidden">
        <Glow className="absolute -top-24 left-1/2 h-96 w-[40rem] max-w-full -translate-x-1/2 rounded-full bg-brand-blue/15 blur-[130px]" />
        <Section width="default" className="pb-12 pt-16 text-center sm:pt-20">
          <Eyebrow>The product tour</Eyebrow>
          <h1 className="mx-auto mt-3 max-w-3xl text-balance text-4xl font-bold leading-tight tracking-tight text-gray-50 sm:text-5xl">
            Every part of the board, and why it’s there.
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-pretty text-lg leading-relaxed text-gray-400">
            Pierre is opinionated about one thing: the fastest way to understand a team is
            to <em>see</em> it. Here’s the whole surface — built so the answer to “what’s
            going on?” is a glance, not an investigation.
          </p>
        </Section>
      </header>

      {/* timeline */}
      <Section id="timeline" width="wide" className="scroll-mt-24 py-12 sm:py-16">
        <FeatureHeading
          icon={TimelineIcon}
          accent="text-brand-sky"
          eyebrow="The timeline"
          title="Repos down the side. Time across the top. Everything in between."
        />
        <div className="mt-6">
          <Shot
            src="/shots/timeline.png"
            alt="The Pierre timeline grouped repo → contributor, with PR bars packed into lanes and shaped event markers."
            eager
            priority
            width={3200}
            height={2000}
          />
        </div>
        <div className="mt-8 grid gap-6 sm:grid-cols-2">
          <div className="space-y-4 text-pretty leading-relaxed text-gray-400">
            <p>
              The board is a <code className="font-mono text-gray-300">vis-timeline</code>{' '}
              nested two levels deep: each repo holds a row per contributor. PR bars pack
              into lanes so nothing overlaps; opens, reviews, comments and commits render as
              distinct <span className="text-gray-200">shaped markers</span> that cluster
              into counts as you zoom out and expand again as you zoom in.
            </p>
            <p>
              Repos get alternating zebra tints by stable rank (not <code className="font-mono text-gray-300">id % 2</code>,
              so colours don’t reshuffle as you toggle repos), contributors with merge
              rights wear a <span className="inline-flex items-center gap-1 text-gray-200"><ShieldIcon className="h-4 w-4 text-brand-green" />maintainer shield</span>,
              and every name links to its GitHub profile. Collapse a noisy contributor to a
              single line; it’s remembered across reloads.
            </p>
          </div>
          <div className="space-y-4 text-pretty leading-relaxed text-gray-400">
            <p>
              Click a marker to read the actual review or comment in a popover, without
              leaving the board. Click a bar to load the PR into the detail pane below.
              Clicking empty canvas dismisses one layer at a time — popover, then selection
              — so you never lose your place by accident.
            </p>
            <Why>
              A list tells you a PR exists. A timeline tells you it’s been open eleven days,
              reviewed once on day two, silent since — and that’s the part that changes what
              you do next.
            </Why>
          </div>
        </div>

        {/* why visual */}
        <div className="mt-8 rounded-2xl border border-white/10 bg-white/[0.03] p-6 sm:p-7">
          <h3 className="text-base font-semibold text-gray-100">Why a timeline, not a list</h3>
          <p className="mt-2 text-pretty leading-relaxed text-gray-400">
            Lists make you read; a board lets you <span className="text-gray-200">scan</span>.
            Putting time on an axis surfaces the two things a list structurally can’t —{' '}
            <span className="text-gray-200">duration</span> and{' '}
            <span className="text-gray-200">staleness</span> — at a glance: a long bar is a
            long-lived PR, a gap after the last marker is a stall. Grouping spatially
            (repo → contributor) turns “who’s working on what” into a shape you recognise
            rather than rows you parse, and clustering keeps it legible as volume grows. A
            list of 200 open PRs is unreadable; a timeline of 200 has a shape — and the
            outliers jump out.
          </p>
        </div>
      </Section>

      {/* focus */}
      <Section id="focus" width="wide" className="scroll-mt-24 py-12 sm:py-16">
        <FeatureRow
          flip
          shot={
            <Shot
              src="/shots/focus-mode.png"
              alt="Focus mode: a single PR isolated on the timeline with every contributor who touched it, sibling work hidden and cross-person connectors drawn."
              title="pierre · Focus mode"
            />
          }
        >
          <FeatureHeading
            icon={FocusIcon}
            accent="text-brand-skySoft"
            eyebrow="Focus mode"
            title="One thread of work, the rest of the world muted."
          />
          <p className="mt-5 text-pretty leading-relaxed text-gray-400">
            Double-click a PR bar, click a cross-person marker, or hit “Focus” in the detail
            pane and the timeline collapses to a single PR and everyone touching it. Sibling
            bars and unrelated markers vanish; the window fits the PR’s full span; connector
            lines join each person’s contribution back to the bar.
          </p>
          <p className="mt-4 text-pretty leading-relaxed text-gray-400">
            It’s sticky — clicks explore rather than exit — and it exits the way it entered.{' '}
            <span className="font-medium text-gray-200">Esc</span>, the Focus mode pill, or
            the browser <span className="font-medium text-gray-200">Back</span> button all
            drop you out and restore the exact scroll position you left from, not a jarring
            jump to the top.
          </p>
          <Why>
            When a release is blocked on “that one PR,” you want the conversation, not the
            haystack around it. Focus is the difference between scrolling and reading.
          </Why>
        </FeatureRow>
      </Section>

      {/* open-pr strip */}
      <Section id="open-prs" width="wide" className="scroll-mt-24 py-12 sm:py-16">
        <FeatureRow
          shot={
            <Shot
              src="/shots/open-pr-strip.png"
              alt="The open-PR strip: a collapsible row of every open PR with all / my-turn / needs-attention filters and reason tags."
              title="pierre · Open PRs"
            />
          }
        >
          <FeatureHeading
            icon={StripIcon}
            accent="text-brand-blue"
            eyebrow="Open-PR strip"
            title="Every open PR, with a reason it’s on the list."
          />
          <p className="mt-5 text-pretty leading-relaxed text-gray-400">
            A collapsible strip across the top holds every open PR in your watched repos.
            Filter to <span className="font-mono text-gray-300">all</span>,{' '}
            <span className="font-mono text-gray-300">my&nbsp;turn</span>, or{' '}
            <span className="font-mono text-gray-300">needs&nbsp;attention</span>, and each
            card carries a reason tag — awaiting your review, CI failing, merge conflicts,
            approved &amp; ready, stalled — computed from the PR’s real state.
          </p>
          <Why>
            “Stalled” isn’t a guess — it’s an open PR with unresolved threads and no commits
            for days. Naming the reason is what turns a list into a worklist.
          </Why>
        </FeatureRow>
      </Section>

      {/* my turn */}
      <Section id="my-turn" width="wide" className="scroll-mt-24 py-12 sm:py-16">
        <FeatureRow
          flip
          shot={
            <Shot
              src="/shots/my-turn.png"
              alt="The My Turn panel grouping reviews awaiting you, your PRs with new activity, and threads awaiting your response."
              title="pierre · My Turn"
            />
          }
        >
          <FeatureHeading
            icon={MyTurnIcon}
            accent="text-brand-amber"
            eyebrow="My Turn"
            title="The queue of things actually waiting on you."
          />
          <p className="mt-5 text-pretty leading-relaxed text-gray-400">
            Triage is computed on read — never stored stale — from your real identity and
            the synced activity: PRs where you’re a requested reviewer, your own PRs with
            new commits/comments/reviews since you last looked, and review threads you
            started that someone else has since replied to. Dismiss one and it’s gone until
            genuinely new activity resurfaces it.
          </p>
          <p className="mt-4 text-pretty leading-relaxed text-gray-400">
            <span className="font-medium text-gray-200">My Turn Focus</span> is its own mode:
            the board isolates to just your inbox PRs, and — because something awaiting you
            might be older than your date filter — Pierre quietly widens the fetched range
            (up to 90 days) so nothing in your court hides off-screen. A two-level Back stack
            steps you out the way you came in.
          </p>
          <Why>
            Notifications optimise for <em>completeness</em>. My Turn optimises for{' '}
            <em>your next action</em>.
          </Why>
        </FeatureRow>
      </Section>

      {/* feed */}
      <Section id="feed" width="wide" className="scroll-mt-24 py-12 sm:py-16">
        <FeatureRow
          shot={
            <Shot
              src="/shots/feed.png"
              alt="The Feed panel: a chronological stream of opens, reviews, comments and merges across watched repos, with click-to-show-on-timeline."
              title="pierre · Feed"
            />
          }
        >
          <FeatureHeading
            icon={FeedIcon}
            accent="text-brand-green"
            eyebrow="Feed"
            title="A calm changelog of the repos you care about."
          />
          <p className="mt-5 text-pretty leading-relaxed text-gray-400">
            The Feed is a reverse-chronological stream of what happened across your watched
            repos — opens, ready-for-review, reviews, comments, merges and reopens.{' '}
            <span className="text-gray-200">Commits are deliberately excluded</span> so it
            stays signal, not log spam. Click any entry to light it up on the timeline.
          </p>
          <p className="mt-4 text-pretty leading-relaxed text-gray-400">
            It lives in your browser’s IndexedDB, deduped and pruned to a rolling window, so
            it survives reloads and tells you what’s new since you last looked — and the
            browser Back button always returns you straight to the Feed home.
          </p>
          <Why>
            It’s the “what did I miss overnight?” view — answerable in ten seconds, instead
            of by scrolling three Slack channels and your email.
          </Why>
        </FeatureRow>
      </Section>

      {/* derived thread state */}
      <Section id="threads" width="wide" className="scroll-mt-24 py-12 sm:py-16">
        <FeatureHeading
          icon={ThreadIcon}
          accent="text-brand-green"
          eyebrow="Derived thread state"
          title="Every review thread, in one of four states."
        />
        <p className="mt-5 max-w-3xl text-pretty leading-relaxed text-gray-400">
          During sync, Pierre classifies each review thread by cross-referencing replies and
          resolution against the commits that landed afterward. One of these states is a
          heuristic — and the product never pretends otherwise.
        </p>
        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          {DERIVED_STATES.map((s) => (
            <div
              key={s.label}
              className="flex gap-4 rounded-2xl border border-white/10 bg-white/5 p-5"
            >
              <span className={`mt-1.5 h-3 w-3 shrink-0 rounded-full ${s.dot}`} />
              <div>
                <h3 className="text-sm font-semibold text-gray-100">{s.label}</h3>
                <p className="mt-1 text-sm leading-relaxed text-gray-400">{s.body}</p>
              </div>
            </div>
          ))}
        </div>
        <Why>
          A tool that hides its uncertainty earns distrust the first time it’s wrong.
          “Likely” is doing honest work — it surfaces threads worth a glance without claiming
          they’re settled.
        </Why>
      </Section>

      {/* pr detail */}
      <Section id="pr-detail" width="wide" className="scroll-mt-24 py-12 sm:py-16">
        <FeatureRow
          flip
          shot={
            <Shot
              src="/shots/pr-detail.png"
              alt="The PR detail pane: Overview with checks, reviewers and approvers; Threads grouped by file; and an Activity feed."
              title="pierre · PR detail"
            />
          }
        >
          <FeatureHeading
            icon={ThreadIcon}
            accent="text-brand-purpleSoft"
            eyebrow="PR detail"
            title="Drill in without leaving the dashboard."
          />
          <p className="mt-5 text-pretty leading-relaxed text-gray-400">
            Select a PR and a resizable pane opens with three tabs:{' '}
            <span className="text-gray-200">Overview</span> (CI checks, reviewers vs
            approvers vs merged-by, requested reviewers, labels, summary and PR comments),{' '}
            <span className="text-gray-200">Threads</span> (grouped by file, newest first,
            with code anchors and new-comment highlights), and{' '}
            <span className="text-gray-200">Activity</span> (a chronological feed, each entry
            with a “Show on timeline” deep-link).
          </p>
          <p className="mt-4 text-pretty leading-relaxed text-gray-400">
            It’s not read-only. Reply to and resolve threads, leave a PR comment, and approve
            — the approve control is gated on your real{' '}
            <code className="font-mono text-gray-300">viewer_permission</code>, so it only
            appears when you can actually merge there.
          </p>
        </FeatureRow>
      </Section>

      {/* filters + keyboard */}
      <Section width="wide" className="py-12 sm:py-16">
        <div className="grid gap-8 lg:grid-cols-2 lg:gap-12">
          <div className="rounded-3xl border border-white/10 bg-white/[0.03] p-7">
            <div className="flex items-center gap-2">
              <FilterIcon className="h-5 w-5 text-brand-sky" />
              <Eyebrow>Filters &amp; URL state</Eyebrow>
            </div>
            <h2 className="mt-3 text-xl font-bold tracking-tight text-gray-50 sm:text-2xl">
              Every view is a link.
            </h2>
            <p className="mt-4 text-pretty leading-relaxed text-gray-400">
              Repos, members, date range, event categories, PR statuses, review verdicts and
              derived thread states all compose — and mirror into the query string both ways.
              The serializer diffs against defaults, so the common view stays a clean URL and
              a custom one is shareable and reloadable.
            </p>
            <p className="mt-3 text-sm text-gray-500">
              Auto-scoped members, an exclude-bots toggle, range presets (7/14/30/90d) and a
              “Now” jump are all one tap away.
            </p>
          </div>

          <div className="rounded-3xl border border-white/10 bg-white/[0.03] p-7">
            <div className="flex items-center gap-2">
              <KeyboardIcon className="h-5 w-5 text-brand-sky" />
              <Eyebrow>Keyboard</Eyebrow>
            </div>
            <h2 className="mt-3 text-xl font-bold tracking-tight text-gray-50 sm:text-2xl">
              Hands on the keys.
            </h2>
            <ul className="mt-5 space-y-3">
              {SHORTCUTS.map((s) => (
                <li key={s.label} className="flex items-center gap-3">
                  <span className="flex shrink-0 gap-1">
                    {s.keys.map((k) => (
                      <kbd
                        key={k}
                        className="min-w-[1.6rem] rounded-md border border-white/15 bg-white/10 px-2 py-1 text-center font-mono text-xs text-gray-200"
                      >
                        {k}
                      </kbd>
                    ))}
                  </span>
                  <span className="text-sm text-gray-400">{s.label}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Section>

      {/* next */}
      <Section width="narrow" className="py-20 text-center">
        <Pill className="bg-brand-sky/10 text-brand-skySoft ring-brand-sky/30">
          Keep going
        </Pill>
        <h2 className="mt-4 text-pretty text-2xl font-bold tracking-tight text-gray-50 sm:text-3xl">
          See the numbers behind the board.
        </h2>
        <p className="mx-auto mt-3 max-w-lg text-gray-400">
          Insights turns the same synced data into per-repo throughput, latency and
          cycle-time analytics.
        </p>
        <Link
          to="/insights"
          className="group mt-7 inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-5 py-3 text-sm font-semibold text-gray-100 transition hover:bg-white/10"
        >
          Explore Insights
          <ArrowRightIcon className="h-4 w-4 transition group-hover:translate-x-0.5" />
        </Link>
      </Section>
    </>
  );
}
