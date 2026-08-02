import { useSeo } from '../lib/seo';
import { seoFor } from '../lib/routes';
import { INSTALL_COMMAND, SITE_NAME } from '../lib/site';
import {
  DashItem,
  InkButton,
  MonoLabel,
  MonoLink,
  RailGrid,
  Section,
  UnderlineLink,
} from '../components/feint/primitives';
import { ShotFrame } from '../components/feint/ShotFrame';
import { TerminalPanel } from '../components/feint/Terminal';
import { SignalFigure } from '../components/feint/Sprite';
import { Rain } from '../components/feint/Rain';
import { GameBar } from '../components/feint/GameBar';

// ---------------------------------------------------------------------------
// The home page — six sections.
//
// The IA is tightened from the previous thirteen blocks. "Who it's for" folds
// into the problem section, "not another review bot" folds into Pro, and the
// eight-slide product carousel collapses to a single hero screenshot. What is
// gone entirely: the three-pillars grid, the knight-vs-kraken sketch (the brief
// removes it by name), and every icon and emoji.
//
// All copy is verbatim from the live site, with "Pierre" → "Limn". The
// typographic apostrophes and em-dashes are deliberate — straight quotes are
// not the same copy.
// ---------------------------------------------------------------------------

const WORKS_WITH = ['CodeRabbit', 'Greptile', 'Copilot', 'Qodo', 'Sourcery'];

const FOR_MANAGERS = [
  'Sprint-oriented reports on blockers, what needs attention, and where throughput is improving.',
  'DORA-style flow metrics you can drill into — mirrors, not scorecards.',
  'Reviewer suggestions drawn from who actually touched the changed files — requested in one click.',
  'A reliable state of play, in-app and in Slack, prioritised by what’s actually waiting.',
];

const FOR_ENGINEERS = [
  'Track your PRs — and every PR you participate in — across all your team’s repos.',
  'Know instantly when it’s your turn, without keeping forty tabs warm.',
  'One-click AI review that remembers how you review, CI-failure analysis, and fixes pushed straight to the branch. When you say so.',
  'The morning “what needs me?” reconstruction — gone. It’s one feed, already sorted.',
];

const FIX_FLOW = [
  'CI fails. Limn pulls the failing job log and diagnoses it.',
  'You approve a fix run. The agent patches in an ephemeral worktree — you review the actual diff.',
  'The fix is pushed to the branch. PR green.',
];

const REVIEW_FLOW = [
  'Claude reviews the PR into structured, line-anchored findings.',
  'You tick the findings worth keeping and write your verdict.',
  'One GitHub review is posted. Yours, not the bot’s.',
];

/** A numbered step in one of the two one-click flows. Rule-separated, no chips. */
function FlowStep({
  n,
  accent,
  last,
  children,
}: {
  n: string;
  accent: boolean;
  last: boolean;
  children: string;
}): JSX.Element {
  return (
    <div
      className={`flex items-baseline gap-4 ${last ? '' : 'border-b border-rule-hair pb-3'}`}
    >
      <span
        className={`font-mono text-mono-caption ${accent ? 'text-signal-text' : 'text-secondary'}`}
      >
        {n}
      </span>
      <span className="text-list">{children}</span>
    </div>
  );
}

export default function Home(): JSX.Element {
  useSeo(seoFor('/'));

  return (
    <>
      {/* ---------- hero ---------- */}
      {/* `relative overflow-hidden` is what confines <Rain/>: the drops are a
          child of this header and are clipped by it, so they can never reach the
          arcade bar or the screenshot below. The two grid children take
          `relative z-10` so the copy sits above the canvas, not behind it. */}
      <header className="relative grid gap-16 overflow-hidden px-gutter pt-hero-y rail:grid-cols-hero">
        <Rain />

        <div className="relative z-10">
          <MonoLabel wide className="mb-[26px] text-secondary">
            The cross-repo review layer
          </MonoLabel>

          <h1 className="mb-7 max-w-[22ch] text-pretty font-display text-hero-sm font-semibold text-ink type:text-hero">
            Your review bot flags 40 things. {SITE_NAME} shows you the{' '}
            <span className="text-signal-text">3</span> that matter.
          </h1>

          <p className="mb-[34px] max-w-lede text-pretty text-lede text-ink-soft">
            Bring your own reviewer — CodeRabbit, Greptile, Copilot, whatever you run.{' '}
            {SITE_NAME} is the calm, cross-repo layer <em>above</em> it: what’s stalled,
            whose turn it is, and which of the bot’s comments a human still needs to read.
            One fast timeline across every repo — and the AI spend stays yours to control.
          </p>

          <div className="mb-4 flex flex-wrap items-center gap-3.5">
            <InkButton to="/api/auth/login">Sign in with GitHub</InkButton>
            <UnderlineLink to="/features">See what’s free</UnderlineLink>
          </div>

          <p className="mb-11 max-w-reassure font-mono text-mono-nav text-secondary">
            Sign in with GitHub, or run it entirely on your machine — local mode keeps no
            stored credentials.
          </p>
        </div>

        {/* The vendor rail. Below the `rail` breakpoint it becomes a wrapped mono
            row under the reassurance line, per the brief — no logos, no chips. */}
        <div className="relative z-10 rail:border-l rail:border-rule rail:pl-6 rail:pt-2">
          <MonoLabel className="mb-4 text-secondary">Works with</MonoLabel>
          <div className="flex flex-wrap gap-x-6 gap-y-2 font-mono text-mono-row text-ink-body rail:flex-col rail:gap-0">
            {WORKS_WITH.map((name, i) => (
              <div
                key={name}
                className={
                  i === WORKS_WITH.length - 1
                    ? ''
                    : 'rail:mb-2.5 rail:border-b rail:border-rule-hair rail:pb-[9px]'
                }
              >
                {name}
              </div>
            ))}
          </div>
        </div>
      </header>

      {/* ---------- arcade entry (after the CTAs, never before) ---------- */}
      <GameBar />

      {/* ---------- hero screenshot ---------- */}
      <div className="mx-gutter mb-20">
        <ShotFrame
          src="/shots/bot-review.png"
          alt="A pull request's review threads, triaged: which of the bot's comments a commit already addressed, and which still need a human."
          caption={`${SITE_NAME.toLowerCase()} · bot triage`}
          height={430}
          fit="cover"
          note="Your review bot’s output, triaged: what a commit already addressed vs what still needs a human — and clear the stale ones in one click."
        />
      </div>

      {/* ---------- 01 · problem ---------- */}
      <Section>
        <RailGrid rail={{ n: '01', word: 'Problem' }}>
          <div className="rail:col-span-2">
            <h2 className="mb-[30px] max-w-[30ch] text-pretty font-display text-h2-sm font-semibold text-ink type:text-h2-major">
              AI writes the code. A bot reviews the code. Who’s reading 300 bot comments a
              week?
            </h2>

            <div className="grid gap-grid-gutter rail:grid-cols-2">
              <div>
                <p className="mb-[18px]">
                  Review bots are genuinely useful — and they never stop. A busy team
                  fields hundreds of AI review comments a week, and most go unread. The
                  firehose buries the handful that actually needed a human, across more
                  repos than anyone can hold in their head. The bottleneck moved from
                  writing the change to noticing what matters.
                </p>
                <p>
                  {SITE_NAME} doesn’t add another bot. It sits <em>above</em> the ones you
                  already run: every review thread — human or bot — becomes a triaged
                  signal. See which of CodeRabbit’s comments a commit already addressed,
                  which still need a look, and clear the stale ones in a click.
                </p>
              </div>

              <div>
                <p className="mb-[18px]">
                  One calm, cross-repo layer for exactly this: human-in-the-loop triage for
                  the high-throughput era.
                </p>
                <p className="mb-[26px] text-muted">
                  GitHub is a firehose wearing a UI — slow to navigate, endless tabs,
                  notifications from humans and bots alike. {SITE_NAME} pulls it all into
                  one place and gets out of your way. And it’s fast. Genuinely, annoyingly
                  fast.
                </p>

                {/* The signal figure — the only figure on the page. */}
                <div className="border-t border-rule pt-5">
                  <MonoLabel className="mb-3.5 text-secondary">
                    300 signals · 3 need you
                  </MonoLabel>
                  <SignalFigure />
                  <p className="mt-3.5 font-mono text-mono-caption text-secondary">
                    Vermilion = a human is still required. The only figure on the page, and
                    the same sprite family the game uses.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </RailGrid>

        {/* who it's for — folded into the problem, under a rule */}
        <RailGrid
          rail={{ word: 'Who it’s for' }}
          className="mt-14 border-t border-rule pt-10"
        >
          <div>
            <h3 className="mb-[18px] font-display text-h4 font-semibold text-ink">
              For engineering managers
            </h3>
            <ul className="flex flex-col gap-3.5">
              {FOR_MANAGERS.map((p) => (
                <DashItem key={p}>{p}</DashItem>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="mb-[18px] font-display text-h4 font-semibold text-ink">
              For engineers
            </h3>
            <ul className="flex flex-col gap-3.5">
              {FOR_ENGINEERS.map((p) => (
                <DashItem key={p}>{p}</DashItem>
              ))}
            </ul>
          </div>
        </RailGrid>
      </Section>

      {/* ---------- 02 · free ---------- */}
      <Section tone="alt">
        <RailGrid rail={{ n: '02', word: 'Free' }}>
          <div>
            <h2 className="mb-6 max-w-[22ch] font-display text-h2-sm font-semibold text-ink type:text-h2">
              Most dashboards add tabs. This one closes them.
            </h2>
            <p className="mb-[18px]">
              Behind the feed sits the board — every repo, every contributor, every PR,
              review and CI run on one interactive timeline. Duration and staleness live in
              the shape: a long bar with no recent markers is a stalled PR, no query
              required.
            </p>
            <p className="mb-6">
              Pick a repo and its console pulls the same picture into focus — stats, a
              thread-state bar, and every open PR with its CI and approval standing. The
              feed, the board, the consoles, the PR detail, the write actions — all of it
              free, open-core, forever.
            </p>
            <MonoLink to="/features">Everything in the free tier →</MonoLink>
          </div>

          <ShotFrame
            src="/shots/timeline.png"
            alt="The timeline board: repos down the side, time across the top, with PR bars and event markers."
            caption="repos down the side, time across the top"
            height={280}
            fit="contain"
            strong
          />
        </RailGrid>
      </Section>

      {/* ---------- 03 · pro ---------- */}
      <Section>
        <RailGrid rail={{ n: '03', word: 'Pro' }}>
          <div>
            <h2 className="mb-6 text-pretty font-display text-h2-sm font-semibold text-ink type:text-h2">
              AI summaries that make sense of the week — not another bot shouting into your
              PRs.
            </h2>
            <p className="mb-[18px]">
              Per-repo digests and sprint reports, each one chained from the last — what
              changed since you last looked, with clickable PR refs. Delivered to Slack on
              your cadence, daily or twice daily.
            </p>
            {/* The antidote line — a pull-quote in INK, not in the signal colour.
                Vermilion means one thing and this is not it. */}
            <p className="mb-6 font-serif text-pull-quote italic text-ink">
              It’s the antidote to notification fatigue: pull, don’t push. One high-quality
              report instead of forty pings.
            </p>
            <MonoLink to="/pro">The whole intelligence layer →</MonoLink>

            <div className="mt-10 border-t border-rule pt-[30px]">
              <MonoLabel className="mb-4 text-secondary">Not another review bot</MonoLabel>
              <h3 className="mb-4 font-display text-h3 font-semibold text-ink">
                The review-bot aisle is full. This is the shelf above it.
              </h3>
              <p className="mb-3.5 text-body-sm">
                Review bots comment on one PR at a time — and even the good ones still bury
                you: independent audits put roughly a third of bot comments as noise.{' '}
                {SITE_NAME} isn’t competing to shout louder on your diffs.
              </p>
              <p className="mb-3.5 text-body-sm">
                It’s cross-repo situational awareness: all high-value, pull-based
                information — who’s blocked, what’s stalled, which threads sit unanswered —
                with AI review as one input you control, not the product.
              </p>
              <p className="text-body-sm">
                And when the AI does review, it reviews <em>your</em> way: every run learns
                from what you kept, cut and reworded last time — so the noise goes down
                with use, not up.
              </p>
            </div>
          </div>

          <div>
            <ShotFrame
              src="/shots/sprint-report.png"
              alt="A sprint report: an AI-written summary of the sprint window, leading with flow metrics and naming blockers with PR links."
              caption="AI-written sprint summary"
              height={230}
              fit="contain"
              strong
            />

            {/* BYO key — under an INK rule, because it is a change of register:
                everything above is included, everything below needs your own key. */}
            <div className="mt-[34px] border-t border-ink pt-6">
              <MonoLabel className="mb-3.5 text-secondary">Pro · BYO key</MonoLabel>
              <h3 className="mb-4 font-display text-h3 font-semibold text-ink">
                Yes, your CLI can do this. In eleven steps.
              </h3>
              <p className="mb-[26px] text-body-sm">
                You could do all of this in your IDE or CLI — clone, checkout, analyse the
                log, prompt the agent, apply, push. Repeat for every PR, every day.{' '}
                {SITE_NAME} makes each loop one click, including the git merge conflicts.
              </p>

              <div className="mb-[26px] flex flex-col gap-3.5">
                {FIX_FLOW.map((step, i) => (
                  <FlowStep key={step} n={`0${i + 1}`} accent last={false}>
                    {step}
                  </FlowStep>
                ))}
              </div>
              <div className="mb-6 flex flex-col gap-3.5">
                {REVIEW_FLOW.map((step, i) => (
                  <FlowStep
                    key={step}
                    n={`0${i + 1}`}
                    accent={false}
                    last={i === REVIEW_FLOW.length - 1}
                  >
                    {step}
                  </FlowStep>
                ))}
              </div>

              <MonoLink to="/pro#claude-review">
                Walk through both flows, screen by screen →
              </MonoLink>
            </div>
          </div>
        </RailGrid>
      </Section>

      {/* ---------- 04 · local ---------- */}
      <Section>
        <RailGrid rail={{ n: '04', word: 'Local' }}>
          <div>
            <h2 className="mb-6 font-display text-h2-sm font-semibold text-ink type:text-h2">
              Or keep it entirely on your machine.
            </h2>
            <p className="mb-[26px] max-w-[52ch]">
              One command. No accounts, no hosted backend, no stored credentials — it
              authenticates with your <span className="font-mono text-[16px]">gh</span>{' '}
              CLI, syncs to a local SQLite file, and opens straight to the Activity console.
            </p>
            <MonoLink to="/how-it-works#run-locally">
              What happens when you run it →
            </MonoLink>
          </div>

          <TerminalPanel label="zsh · ~/work" command={INSTALL_COMMAND} cursor />
        </RailGrid>
      </Section>

      {/* ---------- 05 · price ---------- */}
      <Section>
        <RailGrid rail={{ n: '05', word: 'Price' }} cols="one">
          <div>
            <h2 className="mb-[34px] font-display text-h2-sm font-semibold text-ink type:text-h2">
              Free where it matters. $15 where it counts.
            </h2>
            <div className="grid gap-grid-gutter border-t border-ink pt-[26px] rail:grid-cols-2">
              <div>
                <div className="mb-3.5 flex items-baseline justify-between gap-4">
                  <h3 className="font-display text-h5 font-semibold text-ink">Free</h3>
                  <span className="font-mono text-mono-data text-ink">$0, forever</span>
                </div>
                <p className="text-body-sm">
                  The whole dashboard — Activity feed, timeline, PR detail, write actions.
                  Unlimited repos, local-first.
                </p>
              </div>
              <div>
                <div className="mb-3.5 flex items-baseline justify-between gap-4">
                  <h3 className="font-display text-h5 font-semibold text-ink">Pro</h3>
                  <span className="font-mono text-mono-data text-signal-text">
                    $15/month
                  </span>
                </div>
                <p className="text-body-sm">
                  The intelligence layer — AI summaries, Workspace Insights, flow metrics,
                  Slack digests, My Turn.
                </p>
              </div>
            </div>
          </div>
        </RailGrid>
      </Section>

      {/* ---------- final CTA ---------- */}
      <Section divider="ink" pad="lg">
        <div className="flex flex-col gap-10 rail:flex-row rail:items-end rail:justify-between rail:gap-14">
          <div>
            <h2 className="mb-5 max-w-[22ch] font-display text-h2-sm font-semibold text-ink type:text-cta">
              Stop reconstructing the day from notifications.
            </h2>
            <p className="max-w-[56ch]">
              Sign in with GitHub and the recent timeline fills in seconds, while the full
              history backfills behind it.
            </p>
          </div>
          <div className="flex shrink-0 flex-col items-start gap-3.5">
            <InkButton to="/api/auth/login">Sign in with GitHub</InkButton>
            <MonoLink to="/pricing" className="border-b-0 text-secondary hover:text-ink">
              Compare the tiers →
            </MonoLink>
          </div>
        </div>
      </Section>
    </>
  );
}
