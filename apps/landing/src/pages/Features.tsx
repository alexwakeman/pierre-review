import { useSeo } from '../lib/seo';
import { seoFor } from '../lib/routes';
import { SITE_NAME } from '../lib/site';
import {
  Evidence,
  InkButton,
  MonoLabel,
  MonoLink,
  RailGrid,
  Section,
  Story,
} from '../components/feint/primitives';
import { ShotFrame } from '../components/feint/ShotFrame';
import { PixelIcon } from '../components/feint/PixelIcon';

// ---------------------------------------------------------------------------
// The Open Core page — everything in the free tier, section by section.
//
// Each section now follows the site-wide kit: an 8-bit icon (a whisper of
// vermilion each), a slogan-grade H2 in service of the one mission — calm over
// the chaos of running complex software projects — a short "idea" body, a
// documented outside voice (<Evidence>, REAL quotes only — sourced via
// research, never invented; if a section has no verifiable quote it simply has
// none), and one <Story> line landing it in a working day. Deliberately brief:
// the pattern replaces the old WhyNote footnotes rather than stacking on them.
//
// EVIDENCE SOURCES (verbatim, verified 2026-08-04 — keep this list in sync):
//   01 Feed     — github.com/orgs/community/discussions/5793 (@waterplea, 2021)
//   02 Threads  — arxiv.org/pdf/2304.08426 (Hasan et al., read from the PDF)
//   03 Timeline — same paper, same PDF
//   05 PR detail— ics.uci.edu/~gmark/CHI2005.pdf p.324 (developer quote)
//   06 Receipt  — greptile.com/blog/make-llms-shut-up (Dec 2024)
//   07 Search   — engineering.atspotify.com/2021/05/a-product-story-… (Backstage)
// Popular-but-unciteable figures deliberately NOT used: the "23 min 15 s"
// context-switch number (traces to an interview, not a study — the CHI 2005
// field figure is 25 min 26 s) and every Reddit CodeRabbit quote (only
// reachable via competitors' marketing pages, i.e. unverifiable).
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
          is to <em>see</em> it. Everything here is free and open-core — not a trial, not
          a taster. The core is the product.
        </p>
      </Section>

      {/* ---------- 01 · activity feed ---------- */}
      <Section id="activity">
        <RailGrid rail={{ n: '01', word: 'Feed' }}>
          <div>
            <PixelIcon name="feed" className="mb-5" />
            <h2 className="mb-6 max-w-[24ch] text-pretty font-display text-h2-sm font-semibold text-ink type:text-h2">
              Caught up in ten seconds.
            </h2>
            <p className="mb-2">
              One cross-repo stream of what actually happened — opens, merges, reviews,
              and the commits that <span className="text-ink">addressed a thread</span> —
              coalesced per author, bot-filterable, full markdown inline. Click through to
              the PR; Back returns you to the exact item you left.
            </p>
            <Evidence
              quote="Some bots are helpful but their automatic comments add noise to my notifications/emails and there seems to be no way to configure that."
              source="“Allow to mute bots” — GitHub community discussion, open and unanswered since 2021"
            />
            <Story moment="08:58">
              Coffee down, feed open: two merges overnight, one question addressed to
              you. That’s the whole catch-up.
            </Story>
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

      {/* ---------- 02 · derived thread state ---------- */}
      <Section id="threads" tone="alt">
        <RailGrid rail={{ n: '02', word: 'Threads' }} cols="one">
          <div>
            <PixelIcon name="threads" className="mb-5" />
            <h2 className="mb-6 font-display text-h2-sm font-semibold text-ink type:text-h2">
              No feedback left behind.
            </h2>
            <p className="mb-2 max-w-answer">
              During sync, {SITE_NAME} classifies every review thread by cross-referencing
              replies and resolution against the commits that landed afterward. One state
              is a heuristic — and the product never pretends otherwise.
            </p>
            <Evidence
              quote="In 37 (74%) PRs, the reviewer responded after one week but quickly merged the PR after reviewing it."
              source="Hasan et al., “Understanding the Time to First Response in GitHub Pull Requests” — 111,094 PRs, arXiv, 2023"
            />
            <p className="mb-9 max-w-answer text-body-sm text-muted">
              Most late reviews aren’t hard reviews — they’re unseen ones. A thread state
              you can scan is the difference.
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

            <Story moment="Day 3">
              The critical PR’s thread flips to untouched. Someone answers it today —
              because it was visible, not because anyone nagged.
            </Story>
          </div>
        </RailGrid>
      </Section>

      {/* ---------- 03 · timeline ---------- */}
      <Section id="timeline">
        <RailGrid rail={{ n: '03', word: 'Timeline' }}>
          <div className="rail:col-span-2">
            <PixelIcon name="timeline" className="mb-5" />
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
                <p>
                  Each repo holds a row per contributor; PR bars pack into lanes; events
                  render as <span className="text-ink">shaped markers</span> that cluster
                  as you zoom. A list tells you a PR exists — a timeline tells you it’s
                  been open eleven days, reviewed once on day two, silent since.{' '}
                  <span className="text-ink">Duration and staleness live in the shape.</span>
                </p>
              </div>
              <Evidence
                quote="…the authors had to grab the attention of the reviewer by mentioning their PRs in the comment of other PRs."
                source="How stalled PRs actually get unstuck today — Hasan et al., arXiv, 2023"
              />
            </div>

            <Story moment="Sprint day 9">
              The migration PR’s bar is long and quiet. You see it, you ping once, it
              ships — no nagging economy required.
            </Story>
          </div>
        </RailGrid>
      </Section>

      {/* ---------- 04 · repo consoles ---------- */}
      <Section id="repo-console">
        <RailGrid rail={{ n: '04', word: 'Consoles' }}>
          <div>
            <PixelIcon name="console" className="mb-5" />
            <h2 className="mb-6 max-w-[24ch] text-pretty font-display text-h2-sm font-semibold text-ink type:text-h2">
              Standup, pre-assembled.
            </h2>
            <p className="mb-2">
              Pick a repo: a stats header, a{' '}
              <span className="text-ink">thread-state bar</span> showing how much feedback
              is resolved versus sitting, every open PR with its CI and approval standing,
              that repo’s own feed underneath. Re-scopes live with your filters.
            </p>
            <Story moment="09:58">
              Two minutes before standup, “how’s the payments repo doing?” is already
              answered — before anyone shares a screen.
            </Story>
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

      {/* ---------- 05 · PR detail ---------- */}
      <Section id="pr-detail">
        <RailGrid rail={{ n: '05', word: 'PR detail' }}>
          <div>
            <PixelIcon name="pr" className="mb-5" />
            <h2 className="mb-6 max-w-[24ch] text-pretty font-display text-h2-sm font-semibold text-ink type:text-h2">
              The loop stays closed.
            </h2>
            <p className="mb-2">
              Overview (CI checks with failing-job logs, reviewers vs approvers), threads
              grouped by file, inline diffs with unresolved threads pinned to their lines.
              And it’s not read-only: reply, resolve,{' '}
              <span className="font-mono text-[16px] text-ink">@mention</span>, request
              reviewers, approve, rebase, merge — real GitHub writes, gated on your real
              permissions.
            </p>
            <Evidence
              quote="…you have your mind on something else and then you have to shift completely… by the time you come back to it your frame of mind is completely different…"
              source="A developer, in Mark et al.’s 700-hour field study of fragmented work — CHI 2005"
            />
            <Story moment="Mid-review">
              Read, reply, approve, merge. The tab count never moves; neither does your
              frame of mind.
            </Story>
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

      {/* ---------- 06 · the receipt ---------- */}
      <Section id="receipt" tone="alt">
        <RailGrid rail={{ n: '06', word: 'The receipt' }}>
          <div>
            <PixelIcon name="receipt" className="mb-5" />
            <h2 className="mb-6 max-w-[24ch] text-pretty font-display text-h2-sm font-semibold text-ink type:text-h2">
              Noise, measured.
            </h2>
            <p className="mb-2">
              Every bot comment graded by {SITE_NAME}’s own ML model — severity and
              category, no vendor self-assessment. Rolled up per bot: cost, noise mix,
              overlap, and the bot-only reviews no human ever handled. Grading runs in the
              hosted service today; the local install is on the roadmap.
            </p>
            <Evidence
              quote="When we first launched this product, the biggest complaint by far was that the bot left too many comments."
              source="Greptile — an AI review bot vendor, on its own bot. Vendor blog, December 2024"
            />
            <MonoLink to="/bots">The receipt, in depth →</MonoLink>
            <Story moment="Renewal week">
              “The bot feels noisy” becomes keep, tune, or kill — decided on evidence,
              calmly.
            </Story>
          </div>

          <ShotFrame
            src="/shots/bot-only-review.png"
            alt="Open PRs where the only review activity is bot-authored — reviews no human has handled."
            caption={`${SITE_NAME.toLowerCase()} · bot-only reviews`}
            height={280}
            fit="contain"
            strong
          />
        </RailGrid>
      </Section>

      {/* ---------- 07 · search & workspaces ---------- */}
      <Section id="search">
        <RailGrid rail={{ n: '07', word: 'Search' }} cols="one">
          <div>
            <PixelIcon name="search" className="mb-5" />
            <h2 className="mb-6 font-display text-h2-sm font-semibold text-ink type:text-h2">
              Found, not remembered.
            </h2>
            <div className="grid gap-grid-gutter rail:grid-cols-2">
              <p>
                Cross-repo search, instantly — PRs, threads, comments, people — against
                the locally-synced index, results as you type. It’s the{' '}
                <span className="font-mono text-[16px] text-ink">/</span> key.{' '}
                <span className="text-ink">Workspaces</span> group repos by team: every
                view scopes to one, bots are judged per workspace, and the compare board
                tracks metrics across all of them.
              </p>
              <Evidence
                quote="People couldn’t find things. It was simple as that. It took forever to just find the right service."
                source="Spotify Engineering, on why it built Backstage — engineering blog, 2021"
              />
            </div>
            <Story moment="Thursday">
              “Which repo was that thread in?” stops being a question anyone asks.
            </Story>
          </div>
        </RailGrid>
      </Section>

      {/* ---------- 08 · speed ---------- */}
      <Section id="fast" tone="alt">
        <RailGrid rail={{ n: '08', word: 'Speed' }}>
          <div>
            <PixelIcon name="speed" className="mb-5" />
            <h2 className="mb-6 font-display text-h2-sm font-semibold text-ink type:text-h2">
              Fast enough to be a habit.
            </h2>
            <p className="mb-2">
              Everything syncs into a local database behind a deliberately lean read layer
              — the board never waits on GitHub to render, and adaptive sync keeps hot
              repos seconds-fresh without burning quota on cold ones. Filters compose
              instantly, and <span className="text-ink">every view is a URL</span> —
              shareable, bookmarkable, pasteable into a standup note.
            </p>
            <Story moment="Every day">
              A dashboard you wait for is a dashboard you stop opening. This one opens
              fast enough that you actually do.
            </Story>
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
          </div>
        </RailGrid>
      </Section>

      {/* ---------- next ---------- */}
      <Section divider="ink" pad="lg">
        <div className="flex flex-col gap-10 rail:flex-row rail:items-end rail:justify-between rail:gap-14">
          <div>
            <MonoLabel className="mb-5 text-secondary">Keep going</MonoLabel>
            <h2 className="mb-5 max-w-[22ch] font-display text-h2-sm font-semibold text-ink type:text-cta">
              Pro reads the board. Pro+ acts on it.
            </h2>
            <p className="max-w-[56ch]">
              Digests with teeth, thread validity, themes and reports, chat with your
              repos — and in Pro+, the Claude loop: review, fix, push, one app.
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
