import type { ReactNode } from 'react';
import { Link } from '../router';
import { useSeo } from '../lib/seo';
import { Section, Shot, Eyebrow, Pill, Glow, FeatureRow } from '../components/ui';
import {
  TimelineIcon,
  FeedIcon,
  ThreadIcon,
  StripIcon,
  BoltIcon,
  ShieldIcon,
  ArrowRightIcon,
} from '../components/icons';

/** Locally-owned icon (repo console) — shared icons.tsx is owned elsewhere. */
function ConsoleIcon({ className }: { className?: string }): JSX.Element {
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
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18M7 13h4M7 16.5h7" />
    </svg>
  );
}

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
  { keys: ['i'], label: 'Open the Activity console' },
  { keys: ['Esc'], label: 'Step back out — tab, then selection' },
];

export default function Features(): JSX.Element {
  useSeo({
    path: '/features',
    title: 'Open Core — the free multi-repo GitHub dashboard',
    description:
      'The free, open-core tier in full: the cross-repo Activity feed, the repo→contributor timeline, per-repo consoles, derived thread states, PR detail with real write actions, and the open-PR strip. Free, forever.',
  });

  return (
    <>
      {/* hero */}
      <header className="relative overflow-hidden">
        <Glow className="absolute -top-24 left-1/2 h-96 w-[40rem] max-w-full -translate-x-1/2 rounded-full bg-brand-blue/15 blur-[130px]" />
        <Section width="default" className="pb-12 pt-16 text-center sm:pt-20">
          <Eyebrow>Open core — free forever</Eyebrow>
          <h1 className="mx-auto mt-3 max-w-3xl text-balance text-4xl font-bold leading-tight tracking-tight text-gray-50 sm:text-5xl">
            Every part of the board, and why it’s there.
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-pretty text-lg leading-relaxed text-gray-400">
            Pierre is opinionated about one thing: the fastest way to understand a team is
            to <em>see</em> it. Everything on this page is free and open-core — not a trial,
            not a taster. The core is the product.
          </p>
        </Section>
      </header>

      {/* activity feed */}
      <Section id="activity" width="wide" className="scroll-mt-24 py-12 sm:py-16">
        <FeatureRow
          flip
          shot={
            <Shot
              src="/shots/activity-feed.png"
              alt="The Activity feed: one chronological cross-repo stream of PR opens, merges, reviews, comments and thread-addressing pushes."
              title="pierre · Activity"
              eager
              priority
              width={3200}
              height={2000}
            />
          }
        >
          <FeatureHeading
            icon={FeedIcon}
            accent="text-brand-green"
            eyebrow="The Activity feed"
            title="A feed that reads like a changelog, not a firehose."
          />
          <p className="mt-5 text-pretty leading-relaxed text-gray-400">
            The view Pierre opens on: one consolidated, cross-repo stream of what actually
            happened — opens, merges, reviews, comments — and the commits that{' '}
            <span className="text-gray-200">addressed a review thread</span>, coalesced into
            runs per author so “pushed 4 commits · addressed 2 threads” is one line, not
            four. Chronological, bot-filterable, full markdown bodies inline.
          </p>
          <p className="mt-4 text-pretty leading-relaxed text-gray-400">
            Click any card and the full PR detail opens in its own tab; browser{' '}
            <span className="font-medium text-gray-200">Back</span> returns you to the exact
            feed item you left, scrolled into place. Reply to and resolve threads without
            leaving the feed.
          </p>
          <Why>
            It’s the “what did I miss overnight?” view — answerable in ten seconds, instead
            of by reconstructing the day from Slack, GitHub, email and Jira.
          </Why>
        </FeatureRow>
      </Section>

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
            title="pierre · Timeline"
            width={3200}
            height={2000}
          />
        </div>
        <div className="mt-8 grid gap-6 sm:grid-cols-2">
          <div className="space-y-4 text-pretty leading-relaxed text-gray-400">
            <p>
              When the feed answers “what happened?” and you want “what’s the shape of it?”,
              switch to the board. It’s nested two levels deep: each repo holds a row per
              contributor. PR bars pack into lanes so nothing overlaps; opens, reviews,
              comments and commits render as distinct{' '}
              <span className="text-gray-200">shaped markers</span> that cluster into counts
              as you zoom out and expand again as you zoom in.
            </p>
            <p>
              Contributors with merge rights wear a{' '}
              <span className="inline-flex items-center gap-1 text-gray-200">
                <ShieldIcon className="h-4 w-4 text-brand-green" />
                maintainer shield
              </span>
              , every name links to its GitHub profile, and a noisy contributor collapses to
              a single line — remembered across reloads. Click a marker to read the actual
              review or comment in a popover; click a bar to load the PR into the detail
              pane.
            </p>
          </div>
          <div className="space-y-4 text-pretty leading-relaxed text-gray-400">
            <p>
              And it’s fast in a way GitHub structurally isn’t. GitHub makes you click
              through repo → pull requests → files → back, once per repo, per PR. Pierre
              renders your whole org’s activity in one scan — and because everything is{' '}
              <span className="text-gray-200">synced locally first</span>, navigation is
              instant. No spinners between you and the answer.
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

      {/* repo console */}
      <Section id="repo-console" width="wide" className="scroll-mt-24 py-12 sm:py-16">
        <FeatureRow
          shot={
            <Shot
              src="/shots/repo-console-free.png"
              alt="A per-repo console: stats header, thread-state bar, and the repo’s open PRs with CI and approval standing."
              title="pierre · Repo console"
            />
          }
        >
          <FeatureHeading
            icon={ConsoleIcon}
            accent="text-brand-sky"
            eyebrow="Repo consoles"
            title="Each repo gets a console. State of play at a glance."
          />
          <p className="mt-5 text-pretty leading-relaxed text-gray-400">
            Pick a repo in the Activity rail and you get its state of play: a compact stats
            header, a <span className="text-gray-200">thread-state bar</span> showing how
            much review feedback is resolved versus sitting, and every open PR with its CI
            status, approval standing and thread counts — then that repo’s own feed
            underneath.
          </p>
          <p className="mt-4 text-pretty leading-relaxed text-gray-400">
            The whole console re-scopes live with your repo and member filters, so “how’s
            the payments repo doing this sprint?” is one click, not a query.
          </p>
          <Why>
            Standups ask the same question per repo every day. The console is that answer,
            pre-assembled, before anyone shares a screen.
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
              alt="The PR detail pane: Overview with checks, reviewers and approvers; Threads grouped by file; inline diffs; and an Activity feed."
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
            Select a PR and the full detail opens in place:{' '}
            <span className="text-gray-200">Overview</span> (CI checks with failing-job
            logs, reviewers vs approvers vs merged-by, requested reviewers, labels, summary
            and comments), <span className="text-gray-200">Threads</span> (grouped by file,
            newest first, with code anchors), inline file{' '}
            <span className="text-gray-200">diffs</span> with unresolved threads pinned to
            their lines, and a per-PR activity feed — each entry with a “Show on timeline”
            deep-link.
          </p>
          <p className="mt-4 text-pretty leading-relaxed text-gray-400">
            It’s not read-only. Reply to and resolve threads, leave PR comments with{' '}
            <span className="font-mono text-gray-300">@mention</span> autocomplete, request
            reviewers, and approve — real GitHub writes, and the approve control is gated on
            your real{' '}
            <code className="font-mono text-gray-300">viewer_permission</code>, so it only
            appears when you genuinely can.
          </p>
          <Why>
            Every context switch back to github.com is a chance to get lost in the tabs. If
            the answer <em>and</em> the action live in the dashboard, the loop stays closed.
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
            approved &amp; ready, stalled — computed from the PR’s real state. The strip even
            keeps a running <span className="text-gray-200">stalled count</span>, so a
            growing backlog of quiet PRs is a number you can’t miss.
          </p>
          <Why>
            Stale PRs are where work silently dies. Pierre flags any open PR that’s gone
            quiet — unresolved threads, no commits for days — so it never slips past a
            sprint boundary unnoticed. And on the timeline they’re impossible to miss: a
            long bar with no recent markers <em>is</em> a stall, at a glance.
          </Why>
        </FeatureRow>
      </Section>

      {/* fast */}
      <Section id="fast" width="wide" className="scroll-mt-24 py-12 sm:py-16">
        <div className="grid gap-8 lg:grid-cols-2 lg:gap-12">
          <div>
            <FeatureHeading
              icon={BoltIcon}
              accent="text-brand-amber"
              eyebrow="Speed"
              title="Fast is a feature."
            />
            <p className="mt-5 text-pretty leading-relaxed text-gray-400">
              Everything is synced into a local database and served through a deliberately
              lean read layer — the board never waits on GitHub to render. Filters compose
              instantly: repos, members, date presets, event categories, thread states,
              review verdicts. The whole thing feels like a native app because,
              architecturally, it nearly is one.
            </p>
            <p className="mt-4 text-pretty leading-relaxed text-gray-400">
              And <span className="text-gray-200">every view is a URL</span>. The filter
              state mirrors into the query string both ways, diffed against defaults — so
              the common view stays a clean link and a custom one is shareable, reloadable
              and bookmarkable.
            </p>
            <Why>
              A dashboard you wait for is a dashboard you stop opening. Speed isn’t polish
              here — it’s the difference between a habit and a bookmark you feel guilty
              about.
            </Why>
          </div>

          <div className="rounded-3xl border border-white/10 bg-white/[0.03] p-7">
            <Eyebrow>Keyboard</Eyebrow>
            <h3 className="mt-3 text-xl font-bold tracking-tight text-gray-50 sm:text-2xl">
              Hands on the keys.
            </h3>
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
            <p className="mt-6 border-t border-white/5 pt-4 text-sm text-gray-500">
              Deep links work everywhere too — a PR, a thread, a filtered view are all
              addresses you can paste into a standup note.
            </p>
          </div>
        </div>
      </Section>

      {/* next */}
      <Section width="narrow" className="py-20 text-center">
        <Pill className="bg-brand-purple/15 text-brand-purpleSoft ring-brand-purple/30">
          Keep going
        </Pill>
        <h2 className="mt-4 text-pretty text-2xl font-bold tracking-tight text-gray-50 sm:text-3xl">
          The intelligence layer lives in Pro.
        </h2>
        <p className="mx-auto mt-3 max-w-lg text-gray-400">
          AI summaries, team Insights, flow metrics, My-Turn triage, Slack digests, and
          agentic review &amp; fix — everything that turns activity into decisions.
        </p>
        <Link
          to="/pro"
          className="group mt-7 inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-5 py-3 text-sm font-semibold text-gray-100 transition hover:bg-white/10"
        >
          Explore Pro
          <ArrowRightIcon className="h-4 w-4 transition group-hover:translate-x-0.5" />
        </Link>
      </Section>
    </>
  );
}
