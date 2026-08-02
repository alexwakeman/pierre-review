import type { ReactNode } from 'react';
import { useSeo } from '../lib/seo';
import { seoFor } from '../lib/routes';
import { SITE_NAME } from '../lib/site';
import {
  InkButton,
  MonoLabel,
  RailGrid,
  Section,
} from '../components/feint/primitives';
import { ShotFrame } from '../components/feint/ShotFrame';

// ---------------------------------------------------------------------------
// The Open Core page — everything in the free tier, section by section.
//
// The argument is that the free dashboard IS the product, so the page is laid
// out as a numbered sequence (01–07) rather than as a feature grid: each part of
// the board gets a rail number, a screenshot where one exists, and the "why it
// matters" note that used to sit in a tinted box.
//
// GONE from the previous version, deliberately:
//   · the seven per-section icons (a locally-owned ConsoleIcon, plus FeedIcon /
//     TimelineIcon / ThreadIcon / StripIcon / BoltIcon / ShieldIcon) — this
//     direction has no icon layer at all, and the inline shield glyph inside the
//     timeline copy is now just the phrase it labelled.
//   · the four coloured status dots on the derived-thread-state cards. Exactly
//     one colour exists here and it means "a human is still needed", so a
//     green/blue/amber/red legend cannot be expressed — the four states are
//     rule-topped blocks and the words carry the distinction.
//   · every card, tinted panel and <kbd> chrome (rounded, filled, ringed).
//
// All copy is verbatim from the live site, with "Pierre" → {SITE_NAME}. The
// eyebrows became rail labels, per the section pattern.
// ---------------------------------------------------------------------------

const DERIVED_STATES = [
  {
    label: 'Resolved',
    body: 'Marked resolved on GitHub. Done — no action needed.',
  },
  {
    label: 'Likely addressed',
    body: 'A commit touched the thread’s file after the last comment. A heuristic — and the UI says so, because renames and unrelated edits can fool it.',
  },
  {
    label: 'Replied · unresolved',
    body: 'Someone replied, but it’s still open and no later commit touched the file. A live conversation with no fix yet.',
  },
  {
    label: 'Untouched',
    body: 'No reply, no follow-up commit. Feedback left and, so far, ignored.',
  },
];

const SHORTCUTS = [
  { keys: ['/'], label: 'Jump to the repo search' },
  { keys: ['j', 'k'], label: 'Cycle through PRs' },
  { keys: ['i'], label: 'Open the Activity console' },
  { keys: ['Esc'], label: 'Step back out — tab, then selection' },
];

/**
 * The recurring "why it matters" note.
 *
 * Was a rounded, sky-tinted panel with an inline coloured lead-in. Here it is
 * what it always was in substance — a footnote to the section — so it reads as
 * one: a hairline, a mono label, and the sentence at reading size.
 */
function WhyNote({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="mt-7 border-t border-rule pt-4">
      <MonoLabel className="mb-2.5 text-secondary">Why it matters</MonoLabel>
      <p className="max-w-answer text-list text-muted">{children}</p>
    </div>
  );
}

export default function Features(): JSX.Element {
  useSeo(seoFor('/features'));

  return (
    <>
      {/* ---------- hero ---------- */}
      <Section divider="none" pad="none" className="pb-12 pt-20">
        <MonoLabel wide className="mb-[26px] text-secondary">
          Open core — free forever
        </MonoLabel>
        <h1 className="mb-6 max-w-[24ch] text-pretty font-display text-hero-sm font-semibold text-ink type:text-page-title">
          Every part of the board, and why it’s there.
        </h1>
        <p className="max-w-[58ch] text-pretty text-lede text-ink-soft">
          {SITE_NAME} is opinionated about one thing: the fastest way to understand a team
          is to <em>see</em> it. Everything on this page is free and open-core — not a
          trial, not a taster. The core is the product.
        </p>
      </Section>

      {/* ---------- 01 · activity feed ---------- */}
      <Section id="activity">
        <RailGrid rail={{ n: '01', word: 'Feed' }}>
          <div>
            <h2 className="mb-6 max-w-[24ch] text-pretty font-display text-h2-sm font-semibold text-ink type:text-h2">
              A feed that reads like a changelog, not a firehose.
            </h2>
            <p className="mb-[18px]">
              The view {SITE_NAME} opens on: one consolidated, cross-repo stream of what
              actually happened — opens, merges, reviews, comments — and the commits that{' '}
              <span className="text-ink">addressed a review thread</span>, coalesced into
              runs per author so “pushed 4 commits · addressed 2 threads” is one line, not
              four. Chronological, bot-filterable, full markdown bodies inline.
            </p>
            <p>
              Click any card and the full PR detail opens in its own tab; browser{' '}
              <span className="text-ink">Back</span> returns you to the exact feed item you
              left, scrolled into place. Reply to and resolve threads without leaving the
              feed.
            </p>
            <WhyNote>
              It’s the “what did I miss overnight?” view — answerable in ten seconds,
              instead of by reconstructing the day from Slack, GitHub, email and Jira.
            </WhyNote>
          </div>

          <ShotFrame
            src="/shots/activity-feed.png"
            alt="The Activity feed: one chronological cross-repo stream of PR opens, merges, reviews, comments and thread-addressing pushes."
            caption={`${SITE_NAME.toLowerCase()} · activity feed`}
            height={300}
            fit="contain"
          />
        </RailGrid>
      </Section>

      {/* ---------- 02 · timeline ---------- */}
      <Section id="timeline">
        <RailGrid rail={{ n: '02', word: 'Timeline' }}>
          <div className="rail:col-span-2">
            <h2 className="mb-7 max-w-[30ch] text-pretty font-display text-h2-sm font-semibold text-ink type:text-h2">
              Repos down the side. Time across the top. Everything in between.
            </h2>

            <ShotFrame
              src="/shots/timeline.png"
              alt={`The ${SITE_NAME} timeline grouped repo → contributor, with PR bars packed into lanes and shaped event markers.`}
              caption={`${SITE_NAME.toLowerCase()} · timeline`}
              height={420}
              fit="cover"
              className="mb-10"
            />

            <div className="grid gap-grid-gutter rail:grid-cols-2">
              <div>
                <p className="mb-[18px]">
                  When the feed answers “what happened?” and you want “what’s the shape of
                  it?”, switch to the board. It’s nested two levels deep: each repo holds a
                  row per contributor. PR bars pack into lanes so nothing overlaps; opens,
                  reviews, comments and commits render as distinct{' '}
                  <span className="text-ink">shaped markers</span> that cluster into counts
                  as you zoom out and expand again as you zoom in.
                </p>
                <p>
                  Contributors with merge rights wear a{' '}
                  <span className="text-ink">maintainer shield</span>, every name links to
                  its GitHub profile, and a noisy contributor collapses to a single line —
                  remembered across reloads. Click a marker to read the actual review or
                  comment in a popover; click a bar to load the PR into the detail pane.
                </p>
              </div>
              <div>
                <p>
                  And it’s fast in a way GitHub structurally isn’t. GitHub makes you click
                  through repo → pull requests → files → back, once per repo, per PR.{' '}
                  {SITE_NAME} renders your whole org’s activity in one scan — and because
                  everything is <span className="text-ink">synced locally first</span>,
                  navigation is instant. No spinners between you and the answer.
                </p>
                <WhyNote>
                  A list tells you a PR exists. A timeline tells you it’s been open eleven
                  days, reviewed once on day two, silent since — and that’s the part that
                  changes what you do next.
                </WhyNote>
              </div>
            </div>

            {/* The argument for the board itself — under an ink rule, because it
                is a change of register: everything above describes the feature,
                this defends the choice. */}
            <div className="mt-12 border-t border-ink pt-6">
              <h3 className="mb-4 font-display text-h3 font-semibold text-ink">
                Why a timeline, not a list
              </h3>
              <p className="max-w-answer text-body-sm">
                Lists make you read; a board lets you{' '}
                <span className="text-ink">scan</span>. Putting time on an axis surfaces
                the two things a list structurally can’t —{' '}
                <span className="text-ink">duration</span> and{' '}
                <span className="text-ink">staleness</span> — at a glance: a long bar is a
                long-lived PR, a gap after the last marker is a stall. Grouping spatially
                (repo → contributor) turns “who’s working on what” into a shape you
                recognise rather than rows you parse, and clustering keeps it legible as
                volume grows. A list of 200 open PRs is unreadable; a timeline of 200 has a
                shape — and the outliers jump out.
              </p>
            </div>
          </div>
        </RailGrid>
      </Section>

      {/* ---------- 03 · repo consoles ---------- */}
      <Section id="repo-console">
        <RailGrid rail={{ n: '03', word: 'Consoles' }}>
          <div>
            <h2 className="mb-6 max-w-[24ch] text-pretty font-display text-h2-sm font-semibold text-ink type:text-h2">
              Each repo gets a console. State of play at a glance.
            </h2>
            <p className="mb-[18px]">
              Pick a repo in the Activity rail and you get its state of play: a compact
              stats header, a <span className="text-ink">thread-state bar</span> showing how
              much review feedback is resolved versus sitting, and every open PR with its CI
              status, approval standing and thread counts — then that repo’s own feed
              underneath.
            </p>
            <p>
              The whole console re-scopes live with your repo and member filters, so “how’s
              the payments repo doing this sprint?” is one click, not a query.
            </p>
            <WhyNote>
              Standups ask the same question per repo every day. The console is that answer,
              pre-assembled, before anyone shares a screen.
            </WhyNote>
          </div>

          <ShotFrame
            src="/shots/repo-console-free.png"
            alt="A per-repo console: stats header, thread-state bar, and the repo’s open PRs with CI and approval standing."
            caption={`${SITE_NAME.toLowerCase()} · repo console`}
            height={320}
            fit="contain"
          />
        </RailGrid>
      </Section>

      {/* ---------- 04 · derived thread state ---------- */}
      <Section id="threads" tone="alt">
        <RailGrid rail={{ n: '04', word: 'Threads' }} cols="one">
          <div>
            <h2 className="mb-6 font-display text-h2-sm font-semibold text-ink type:text-h2">
              Every review thread, in one of four states.
            </h2>
            <p className="mb-9 max-w-answer">
              During sync, {SITE_NAME} classifies each review thread by cross-referencing
              replies and resolution against the commits that landed afterward. One of these
              states is a heuristic — and the product never pretends otherwise.
            </p>

            <div className="grid gap-x-grid-gutter gap-y-8 rail:grid-cols-2">
              {DERIVED_STATES.map((s) => (
                <div key={s.label} className="border-t border-rule-strong pt-[18px]">
                  <h3 className="mb-2.5 font-display text-h4-sm font-semibold text-ink">
                    {s.label}
                  </h3>
                  <p className="text-list">{s.body}</p>
                </div>
              ))}
            </div>

            <WhyNote>
              A tool that hides its uncertainty earns distrust the first time it’s wrong.
              “Likely” is doing honest work — it surfaces threads worth a glance without
              claiming they’re settled.
            </WhyNote>
          </div>
        </RailGrid>
      </Section>

      {/* ---------- 05 · PR detail ---------- */}
      <Section id="pr-detail">
        <RailGrid rail={{ n: '05', word: 'PR detail' }}>
          <div>
            <h2 className="mb-6 max-w-[24ch] text-pretty font-display text-h2-sm font-semibold text-ink type:text-h2">
              Drill in without leaving the dashboard.
            </h2>
            <p className="mb-[18px]">
              Select a PR and the full detail opens in place:{' '}
              <span className="text-ink">Overview</span> (CI checks with failing-job logs,
              reviewers vs approvers vs merged-by, requested reviewers, labels, summary and
              comments), <span className="text-ink">Threads</span> (grouped by file, newest
              first, with code anchors), inline file{' '}
              <span className="text-ink">diffs</span> with unresolved threads pinned to
              their lines, and a per-PR activity feed — each entry with a “Show on timeline”
              deep-link.
            </p>
            <p>
              It’s not read-only. Reply to and resolve threads, leave PR comments with{' '}
              <span className="font-mono text-[16px] text-ink">@mention</span> autocomplete,
              request reviewers, and approve — real GitHub writes, and the approve control
              is gated on your real{' '}
              <code className="font-mono text-[16px] text-ink">viewer_permission</code>, so
              it only appears when you genuinely can.
            </p>
            <WhyNote>
              Every context switch back to github.com is a chance to get lost in the tabs.
              If the answer <em>and</em> the action live in the dashboard, the loop stays
              closed.
            </WhyNote>
          </div>

          <ShotFrame
            src="/shots/pr-detail.png"
            alt="The PR detail pane: Overview with checks, reviewers and approvers; Threads grouped by file; inline diffs; and an Activity feed."
            caption={`${SITE_NAME.toLowerCase()} · pr detail`}
            height={290}
            fit="contain"
          />
        </RailGrid>
      </Section>

      {/* ---------- 06 · open-PR strip ---------- */}
      <Section id="open-prs">
        <RailGrid rail={{ n: '06', word: 'Open PRs' }} cols="one">
          <div>
            <h2 className="mb-6 font-display text-h2-sm font-semibold text-ink type:text-h2">
              Every open PR, with a reason it’s on the list.
            </h2>
            <p className="mb-9 max-w-answer">
              A collapsible strip across the top holds every open PR in your repos.
              Filter to <span className="font-mono text-[16px] text-ink">all</span>,{' '}
              <span className="font-mono text-[16px] text-ink">my&nbsp;turn</span>, or{' '}
              <span className="font-mono text-[16px] text-ink">needs&nbsp;attention</span>,
              and each card carries a reason tag — awaiting your review, CI failing, merge
              conflicts, approved &amp; ready, stalled — computed from the PR’s real state.
              The strip even keeps a running{' '}
              <span className="text-ink">stalled count</span>, so a growing backlog of quiet
              PRs is a number you can’t miss.
            </p>

            {/* The strip is a 9:1 sliver of UI, so it gets the full content column
                and `contain` — cropping it would remove the thing being shown. */}
            <ShotFrame
              src="/shots/open-pr-strip.png"
              alt="The open-PR strip: a collapsible row of every open PR with all / my-turn / needs-attention filters and reason tags."
              caption={`${SITE_NAME.toLowerCase()} · open PRs`}
              height={140}
              fit="contain"
            />

            <WhyNote>
              Stale PRs are where work silently dies. {SITE_NAME} flags any open PR that’s
              gone quiet — unresolved threads, no commits for days — so it never slips past
              a sprint boundary unnoticed. And on the timeline they’re impossible to miss: a
              long bar with no recent markers <em>is</em> a stall, at a glance.
            </WhyNote>
          </div>
        </RailGrid>
      </Section>

      {/* ---------- 07 · speed ---------- */}
      <Section id="fast" tone="alt">
        <RailGrid rail={{ n: '07', word: 'Speed' }}>
          <div>
            <h2 className="mb-6 font-display text-h2-sm font-semibold text-ink type:text-h2">
              Fast is a feature.
            </h2>
            <p className="mb-[18px]">
              Everything is synced into a local database and served through a deliberately
              lean read layer — the board never waits on GitHub to render. Filters compose
              instantly: repos, members, date presets, event categories, thread states,
              review verdicts. The whole thing feels like a native app because,
              architecturally, it nearly is one.
            </p>
            <p>
              And <span className="text-ink">every view is a URL</span>. The filter state
              mirrors into the query string both ways, diffed against defaults — so the
              common view stays a clean link and a custom one is shareable, reloadable and
              bookmarkable.
            </p>
            <WhyNote>
              A dashboard you wait for is a dashboard you stop opening. Speed isn’t polish
              here — it’s the difference between a habit and a bookmark you feel guilty
              about.
            </WhyNote>
          </div>

          <div className="border-t border-ink pt-6">
            <MonoLabel className="mb-3.5 text-secondary">Keyboard</MonoLabel>
            <h3 className="mb-6 font-display text-h3 font-semibold text-ink">
              Hands on the keys.
            </h3>
            <ul className="flex flex-col">
              {SHORTCUTS.map((s, i) => (
                <li
                  key={s.label}
                  className={`flex items-baseline gap-6 border-t border-rule-strong py-3 ${
                    i === SHORTCUTS.length - 1 ? 'border-b' : ''
                  }`}
                >
                  <span className="flex w-[64px] shrink-0 gap-2 font-mono text-mono-row text-ink">
                    {s.keys.map((k) => (
                      <kbd key={k}>{k}</kbd>
                    ))}
                  </span>
                  <span className="text-list">{s.label}</span>
                </li>
              ))}
            </ul>
            <p className="mt-6 text-list text-muted">
              Deep links work everywhere too — a PR, a thread, a filtered view are all
              addresses you can paste into a standup note.
            </p>
          </div>
        </RailGrid>
      </Section>

      {/* ---------- next ---------- */}
      <Section divider="ink" pad="lg">
        <div className="flex flex-col gap-10 rail:flex-row rail:items-end rail:justify-between rail:gap-14">
          <div>
            <MonoLabel className="mb-5 text-secondary">Keep going</MonoLabel>
            <h2 className="mb-5 max-w-[22ch] font-display text-h2-sm font-semibold text-ink type:text-cta">
              The intelligence layer lives in Pro.
            </h2>
            <p className="max-w-[56ch]">
              AI summaries, Workspace Insights, flow metrics, My-Turn triage, Slack digests,
              and agentic review &amp; fix — everything that turns activity into decisions.
            </p>
          </div>
          <div className="shrink-0">
            <InkButton to="/pro">Explore Pro</InkButton>
          </div>
        </div>
      </Section>
    </>
  );
}
