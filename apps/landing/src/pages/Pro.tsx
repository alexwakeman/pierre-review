import type { ReactNode } from 'react';
import { useSeo } from '../lib/seo';
import { seoFor } from '../lib/routes';
import { SITE_NAME } from '../lib/site';
import {
  InkButton,
  MonoLabel,
  RailGrid,
  RuledItem,
  Section,
} from '../components/feint/primitives';
import { ShotFrame } from '../components/feint/ShotFrame';

// ---------------------------------------------------------------------------
// The Pro page — the intelligence layer, then the agentic tier.
//
// Twelve sections: a numbered run (01–07) covering everything included in the
// subscription, an ink-ruled hinge into "Pro · BYO key", then the three
// bring-your-own-key sections under bare word rails, and the closing CTA. It is
// also served at the legacy /insights and /reviews aliases, so every anchor id
// below is load-bearing: #digests #sprint #insights #metrics #my-turn #slack
// #tickets #claude-review #ai-fix #control.
//
// GONE in the port, and deliberately: the four locally-owned SVG icons (send,
// ticket, wrench, shielded-hand) and every imported one — this direction has no
// icons at all, so a section is introduced by its rail label instead of by an
// icon + coloured eyebrow. The `Pro` / `Pro · BYO key` pills are now mono
// labels, the five severity chips are a mono row, and the four tinted callout
// boxes ("Mirrors, not scorecards", both "could you do this in your CLI?"
// asides, "Privacy") are a ruled label-and-paragraph — the rule does the work
// the tinted background used to.
//
// All copy is verbatim from the live site, with the product name read from
// SITE_NAME and the price moved to $15. The closing line used to be "Five
// dollars. Fewer tabs than that." — its joke is that the price is a smaller
// number than your open tab count, which stops landing once the price is
// fifteen, so it is reworked against the tabs the product closes rather than
// against the digit.
// ---------------------------------------------------------------------------

const METRICS: [string, string][] = [
  ['Deploy frequency', 'how often work actually lands'],
  ['Lead time', 'from first commit to merged'],
  ['Review latency', 'how long PRs wait for a first review'],
  ['Merge vs CI health', 'how much of the pipeline is green when it counts'],
  ['CI recovery time', 'real red→green MTTR, from a transition log — not a proxy'],
];

/** The five severities Claude tags a finding with. Words, not coloured chips. */
const SEVERITIES = ['blocker', 'warning', 'nit', 'question', 'praise'];

const SHOT = `${SITE_NAME.toLowerCase()} · `;

/**
 * One step of a teaching walkthrough: a mono step number in its own sub-rail,
 * a title, the explanation, and the screenshot of that exact moment.
 *
 * NOT a card — the old one was a numbered circle on a gradient spine over a
 * rounded, shadowed, ring-lit image well. It is now a rule-separated row, and
 * the shot is an ordinary ShotFrame (which carries the Enlarge affordance the
 * hover chip used to). The crops are captured at a narrow viewport
 * (scripts/capture-shots.mjs) so the UI text stays legible at column width; the
 * per-step `height` is chosen from each crop's own aspect ratio, so `contain`
 * costs only a few px of gutter rather than a band of empty paper.
 */
function WalkStep({
  n,
  title,
  shot,
  alt,
  caption,
  height,
  fit = 'contain',
  last = false,
  children,
}: {
  n: string;
  title: string;
  shot: string;
  alt: string;
  caption: string;
  height: number;
  fit?: 'cover' | 'contain';
  last?: boolean;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className={last ? '' : 'border-b border-rule-hair pb-11'}>
      <RailGrid rail={{ word: n }} cols="one">
        <div>
          <h4 className="mb-3.5 font-display text-h4 font-semibold text-ink">{title}</h4>
          <div className="mb-6 flex max-w-answer flex-col gap-3.5 text-body-sm">
            {children}
          </div>
          <ShotFrame src={shot} alt={alt} caption={caption} height={height} fit={fit} />
        </div>
      </RailGrid>
    </div>
  );
}

export default function Pro(): JSX.Element {
  useSeo(seoFor('/pro'));

  return (
    <>
      {/* ---------- hero ---------- */}
      <Section divider="none" pad="none" className="pb-12 pt-20">
        <RailGrid rail={{ word: 'Pro' }} cols="one">
          <div>
            <MonoLabel className="mb-[26px] text-secondary">{SITE_NAME} Pro</MonoLabel>

            <h1 className="mb-6 font-display text-hero-sm font-semibold text-ink type:text-page-title">
              The intelligence layer.
            </h1>
            <p className="max-w-[58ch] text-pretty text-lede">
              The free board shows you everything. Pro turns that activity into decisions —
              summaries that write themselves, metrics that answer retro questions, a feed
              that knows what’s yours, and agentic review &amp; fix with a{' '}
              <span className="text-ink">human hand on the wheel</span> at every step.
            </p>

            {/* The two tier pills, demoted to what they always were: labels. */}
            <div className="mt-9 flex flex-wrap gap-x-10 gap-y-2 border-t border-rule pt-4">
              <MonoLabel className="text-secondary">Pro · $15/mo</MonoLabel>
              <MonoLabel className="text-secondary">Advanced AI · BYO key</MonoLabel>
            </div>
          </div>
        </RailGrid>
      </Section>

      {/* ---------- 01 · digests ---------- */}
      <Section id="digests">
        <RailGrid rail={{ n: '01', word: 'Digests' }}>
          <div>
            <h2 className="mb-6 text-pretty font-display text-h2-sm font-semibold text-ink type:text-h2">
              AI summaries as your team ships.
            </h2>
            <p className="mb-[18px]">
              Every repo gets a bulleted change report,{' '}
              <span className="text-ink">chained from the previous one</span> — what changed
              since last time, not a re-summary of everything — with every PR referenced as
              a clickable <span className="font-mono text-[16px] text-ink">#N</span> that
              opens the real thing.
            </p>
            <p>
              Refresh manually, on an interval, or on-change — your choice, in Settings. And
              an unchanged repo costs <span className="text-ink">$0, by design</span>:{' '}
              {SITE_NAME} hashes the underlying activity and skips the model call when
              nothing moved.
            </p>
          </div>

          <ShotFrame
            src="/shots/repo-console.png"
            alt="A repo console with its AI digest banner: a bulleted change report with clickable PR references above the open-PR list."
            caption={`${SHOT}repo digest`}
            height={300}
            fit="contain"
          />
        </RailGrid>
      </Section>

      {/* ---------- 02 · sprint ---------- */}
      <Section id="sprint" tone="alt">
        <RailGrid rail={{ n: '02', word: 'Sprint' }}>
          <div>
            <h2 className="mb-6 font-display text-h2-sm font-semibold text-ink type:text-h2">
              The sprint report writes itself.
            </h2>
            <p className="mb-[18px]">
              Sprint-window aware — you set the cadence and start date, {SITE_NAME} rolls
              the window forward — the report leads with the flow metrics, then names the
              blockers, with PR links you can act on. Prioritised by repo importance, change
              size, and how long a PR has been waiting.
            </p>
            <p>
              Delivered in-app and to Slack on your schedule: a reliable, consistent state
              of play, instead of a reconstruction you assemble at 9:57 for the 10:00.
            </p>
          </div>

          <ShotFrame
            src="/shots/sprint-report.png"
            alt="The sprint report: headline flow metrics followed by prioritised, PR-linked blockers and what needs attention."
            caption={`${SHOT}sprint report`}
            height={280}
            fit="contain"
            strong
          />
        </RailGrid>
      </Section>

      {/* ---------- 03 · insights ---------- */}
      <Section id="insights">
        <RailGrid rail={{ n: '03', word: 'Insights' }} cols="one">
          <div>
            <h2 className="mb-7 font-display text-h2-sm font-semibold text-ink type:text-h2">
              The questions retros are supposed to answer.
            </h2>

            <ShotFrame
              src="/shots/insights.png"
              alt="The Insights rail: cards for stalled reviews, untouched threads, reviewer load and reviewer routing with rationale."
              caption={`${SHOT}insights`}
              height={430}
              fit="cover"
              className="mb-9"
            />

            <div className="grid gap-grid-gutter rail:grid-cols-2">
              <p>
                No instrumentation, no extra pipeline — {SITE_NAME} already synced your PR
                history. Insights turns it into the cards a lead actually needs:{' '}
                <span className="text-ink">stalled reviews</span> that have quietly stopped
                moving, <span className="text-ink">untouched threads</span> — surfaced
                team-wide, so no review feedback goes unanswered — and{' '}
                <span className="text-ink">reviewer load</span>, the early read on who’s
                carrying too much.
              </p>
              <p>
                <span className="text-ink">Reviewer routing</span> goes a step further: for
                each unreviewed PR it suggests reviewers with a rationale drawn from who
                actually touched those paths — and a one-click{' '}
                <span className="text-ink">“request reviewers”</span> that does it, right
                there. From noticing to acting, without leaving the card.
              </p>
            </div>
          </div>
        </RailGrid>
      </Section>

      {/* ---------- 04 · metrics ---------- */}
      <Section id="metrics">
        <RailGrid rail={{ n: '04', word: 'Metrics' }}>
          <div>
            <h2 className="mb-6 font-display text-h2-sm font-semibold text-ink type:text-h2">
              DORA-style metrics, minus the vendor deck.
            </h2>

            <ul className="mb-6 flex flex-col">
              {METRICS.map(([name, sub], i) => (
                <RuledItem key={name} last={i === METRICS.length - 1}>
                  <span className="text-ink">{name}</span> — {sub}
                </RuledItem>
              ))}
            </ul>

            <p>
              Every tile clicks through to the PRs behind the number — no black-box
              aggregates. And nothing is sampled or projected; it’s all derived from the
              same synced data that draws the board.
            </p>

            <div className="mt-7 border-t border-rule pt-5">
              <MonoLabel className="mb-2.5 text-secondary">Mirrors, not scorecards</MonoLabel>
              <p className="text-body-sm">
                The point is to start better conversations, not to rank people.
              </p>
            </div>
          </div>

          <ShotFrame
            src="/shots/flow-metrics.png"
            alt="DORA-style flow metric charts: deploy frequency, lead time, review latency, merge-vs-CI health and CI recovery time."
            caption={`${SHOT}flow metrics`}
            height={230}
            fit="contain"
          />
        </RailGrid>
      </Section>

      {/* ---------- 05 · my turn ---------- */}
      <Section id="my-turn" tone="alt">
        <RailGrid rail={{ n: '05', word: 'My Turn' }}>
          <div>
            <h2 className="mb-6 text-pretty font-display text-h2-sm font-semibold text-ink type:text-h2">
              Know it’s your turn without being told twice.
            </h2>
            <p className="mb-[18px]">
              Pro makes the feed <span className="text-ink">participation-aware</span>: any
              event on a PR you authored, were asked to review, or previously weighed in on
              gets flagged as yours — a yellow-bordered card with the full context inline,
              never buried under a volume cap, with a{' '}
              <span className="text-ink">“My Turn only”</span> toggle when you want just the
              queue.
            </p>
            <p>
              Pull-based by design: you check one place, nothing pings you. Notifications
              optimise for <em>completeness</em>; My Turn optimises for{' '}
              <em>your next action</em>.
            </p>
          </div>

          <ShotFrame
            src="/shots/activity-feed-pro.png"
            alt="The Activity feed with yellow-bordered My Turn cards flagging events on PRs you participate in, and a My-Turn-only toggle."
            caption={`${SHOT}my turn`}
            height={320}
            fit="contain"
            strong
          />
        </RailGrid>
      </Section>

      {/* ---------- 06 · slack ---------- */}
      <Section id="slack">
        <RailGrid rail={{ n: '06', word: 'Slack' }}>
          <div>
            <h2 className="mb-6 font-display text-h2-sm font-semibold text-ink type:text-h2">
              Slack digests on your cadence.
            </h2>
            <p className="mb-[18px]">
              Point {SITE_NAME} at a Slack webhook and the sprint report plus per-repo
              digests arrive on your schedule —{' '}
              <span className="text-ink">daily or twice daily</span>, timezone-aware, with a
              send-test button so you know it works before the team relies on it.
            </p>
            <p>
              It’s the anti-notification: choose your cadence and get{' '}
              <span className="text-ink">one high-quality report instead of forty pings</span>
              . If nothing happened, nothing is posted. (Email delivery is on the roadmap.)
            </p>
          </div>

          {/* The only portrait capture on the site — a tall plate, gutters and
              all, rather than a crop that would cut the cadence controls. */}
          <ShotFrame
            src="/shots/settings.png"
            alt="The Settings modal: sprint window, Slack digest cadence with timezone and send-test, AI update policy, and Jira/Linear configuration."
            caption={`${SHOT}settings`}
            height={400}
            fit="contain"
          />
        </RailGrid>
      </Section>

      {/* ---------- 07 · tickets ---------- */}
      <Section id="tickets">
        <RailGrid rail={{ n: '07', word: 'Tickets' }} cols="one">
          <div>
            <h2 className="mb-7 font-display text-h2-sm font-semibold text-ink type:text-h2">
              Jira and Linear links, automatically.
            </h2>
            <div className="grid gap-grid-gutter rail:grid-cols-2">
              <p>
                Ticket keys like{' '}
                <span className="font-mono text-[16px] text-ink">PROJ-123</span> are
                detected from PR titles and branch names and rendered as deep links in PR
                detail — so the jump from “this PR” to “the ticket it closes” is one click,
                with zero convention changes on your side.
              </p>
              <p>
                Configure your provider and base URL once in Settings, and every PR that
                follows your existing naming carries its links. Deeper Jira/Linear
                integration is coming.
              </p>
            </div>
          </div>
        </RailGrid>
      </Section>

      {/* ---------- the hinge: everything below needs your own key ----------
          An ink rule, not a ribbon. This is the register change the old page
          drew with a full-width tinted band and a purple pill. */}
      <Section tone="alt" divider="ink">
        <RailGrid rail={{ word: 'BYO key' }} cols="one">
          <div>
            <MonoLabel className="mb-5 text-secondary">Pro · BYO key</MonoLabel>
            <h2 className="mb-6 font-display text-h2-sm font-semibold text-ink type:text-h2-major">
              The agentic tier.
            </h2>
            <p className="max-w-[62ch] text-pretty text-lede">
              Everything below runs a real agent against your code — reviews, diagnoses,
              fixes. Bring your own Anthropic API key, watch usage in credits, and keep one
              rule in view:{' '}
              <span className="text-ink">
                nothing posts, pushes or merges without a human click.
              </span>
            </p>
          </div>
        </RailGrid>
      </Section>

      {/* ---------- claude review ---------- */}
      <Section id="claude-review">
        <RailGrid rail={{ word: 'Claude Review' }} cols="one">
          <div>
            <h2 className="mb-6 font-display text-h2-sm font-semibold text-ink type:text-h2">
              Reviews that are still there next week.
            </h2>
            <p className="mb-[18px] max-w-answer">
              Most AI code review happens in a chat tab — useful in the moment, gone the
              moment you close it. {SITE_NAME} runs the review against the PR, structures
              the output, and <span className="text-ink">saves it per commit</span> — no
              digging through agent-session histories in your CLI tool of choice. Re-review
              after a push and the old run stays in history, tied to the code it reviewed.
            </p>
            <p className="mb-9 max-w-answer">
              Runs on <span className="text-ink">Claude Sonnet 5</span> by default — the
              latest Claude, near-Opus coding quality at a fraction of the cost — with{' '}
              <span className="text-ink">Claude Opus 4.8</span> a click away for the
              gnarliest diffs and <span className="text-ink">Haiku 4.5</span> for a quick
              pass.
            </p>

            <ShotFrame
              src="/shots/claude-review.png"
              alt="The Claude Review tab: a structured review with severity-tagged, line-anchored findings, a routing badge, and a separate “your review” composer that posts to GitHub."
              caption={`${SHOT}claude review`}
              height={430}
              fit="cover"
            />

            {/* deep vs quick — two ink-ruled columns, not two rounded panels */}
            <div className="mt-12 grid gap-grid-gutter rail:grid-cols-2">
              <div className="border-t border-ink pt-[18px]">
                <MonoLabel className="mb-3.5 text-secondary">quick · diff-only</MonoLabel>
                <h3 className="mb-3.5 font-display text-h4 font-semibold text-ink">
                  Fast path, no clone
                </h3>
                <p className="mb-3 text-list">
                  For small, contained changes touching no exported contract, the full diff
                  is inlined into the prompt. No checkout, a tight turn cap, seconds to
                  finish.
                </p>
                <p className="text-list">
                  Ideal for the localised fix, the style pass, the small refactor where the
                  diff <em>is</em> the context.
                </p>
              </div>
              <div className="border-t border-ink pt-[18px]">
                <MonoLabel className="mb-3.5 text-secondary">deep · worktree</MonoLabel>
                <h3 className="mb-3.5 font-display text-h4 font-semibold text-ink">
                  Full checkout to explore
                </h3>
                <p className="mb-3 text-list">
                  Touch anything bigger — too many files or lines, more than one subsystem,
                  or any exported API, schema or migration — and the run earns a{' '}
                  <span className="text-ink">partial clone and an ephemeral worktree</span>.
                  The agent gets read-only tools to trace callers and check assumptions
                  against the real tree.
                </p>
                <p className="text-list">
                  Built for cross-cutting changes, where the blast radius lives outside the
                  diff. Ambiguous? It rounds up to deep.
                </p>
              </div>
            </div>

            <p className="mt-7 max-w-answer text-body-sm text-muted">
              A deterministic router picks the depth before a token is spent, so cost tracks
              complexity. You can force a mode per run; every run is capped by turns and by
              dollars, and cancelable mid-flight.
            </p>

            {/* the walkthrough */}
            <div className="mt-14 border-t border-rule pt-10">
              <MonoLabel className="mb-4 text-secondary">Walk through it</MonoLabel>
              <h3 className="mb-4 font-display text-h3 font-semibold text-ink">
                A real review, step by step.
              </h3>
              <p className="mb-11 max-w-answer text-lede text-ink-soft">
                These are the actual screens, in order. Four steps, a few seconds of your
                attention each — and one human decision at the end.
              </p>

              <div className="flex flex-col gap-11">
                <WalkStep
                  n="01"
                  title="Open the PR, pick a depth — or let the router."
                  shot="/shots/flow-review-1-run.png"
                  alt="The Claude Review run controls: a model picker defaulting to Claude Sonnet 5, a depth picker on Auto, a Re-review button, and the router’s hint line reading “2 files · 72 lines changed — Auto picks Quick”."
                  caption={`${SHOT}review · 01`}
                  height={165}
                >
                  <p>
                    From any PR’s detail pane, open the Claude Review tab. Pick a model —{' '}
                    <span className="text-ink">Claude Sonnet 5</span> by default, Opus 4.8
                    for the gnarly ones — and a depth, or leave it on Auto: a deterministic
                    router reads the diff before a token is spent. This 2-file, 72-line
                    change earns the fast, no-clone path; touch an exported API and it
                    rounds up to a full worktree.
                  </p>
                </WalkStep>

                <WalkStep
                  n="02"
                  title="It already knows how you review."
                  shot="/shots/flow-review-2-memory.png"
                  alt="The review-memory panel, expanded: signals from past reviews in this repo — a reworded finding shown as Claude’s wording versus yours, and “You dismissed 3 of 3 findings here” for style nits — marked as given to Claude as context."
                  caption={`${SHOT}review · 02`}
                  height={330}
                >
                  <p>
                    Before the run, {SITE_NAME} surfaces what your past reviews in this repo
                    taught it — the finding you reworded (and how), the style nits you keep
                    dismissing — and hands those signals to Claude as context.{' '}
                    <span className="text-ink">Every review feeds the next one</span>: run
                    two stops flagging what you didn’t care about in run one. A chat-tab
                    review starts from zero, every time.
                  </p>
                </WalkStep>

                <WalkStep
                  n="03"
                  title="Read findings, not a wall of prose."
                  shot="/shots/flow-review-3-findings.png"
                  alt="Claude’s structured output: a short summary, then severity-tagged findings — a blocker and a warning with file:line anchors, diff hunks and suggested code — each with Post as comment, Reword in my words, Copy and Ignore actions; nits and questions already ignored."
                  caption={`${SHOT}review · 03`}
                  height={440}
                  fit="cover"
                >
                  <p>
                    The output is structured: each finding carries a severity, a{' '}
                    <span className="font-mono text-[16px] text-ink">file:line</span> anchor,
                    the diff hunk it’s about, and an optional code suggestion. Per finding
                    you choose — post Claude’s wording, reword it in yours, or ignore it.
                    Here the blocker and warning stay; the nits are already cut.
                  </p>
                  {/* The five severity chips, as the five words they always were. */}
                  <p className="border-t border-rule-hair pt-3 font-mono text-mono-caption text-secondary">
                    {SEVERITIES.join(' · ')}
                  </p>
                </WalkStep>

                <WalkStep
                  n="04"
                  title="Post one GitHub review. Yours."
                  shot="/shots/flow-review-4-post.png"
                  alt="The overall-review composer with a short human-written summary, a verdict picker set to Request changes, and the Preview payload / Post to GitHub controls."
                  caption={`${SHOT}review · 04`}
                  height={440}
                  last
                >
                  <p>
                    Write the top-level comment in your own words, pick the verdict, and
                    post —{' '}
                    <span className="text-ink">
                      one GitHub review: your body, your verdict, your chosen findings
                      inline
                    </span>
                    , pinned to the head SHA so it can never land on stale code. Your
                    teammates see a review from you, not a bot flood. And the run is saved
                    per commit — re-review after a push and the old one stays in history.
                  </p>
                  <p>
                    Accepted a finding that needs code? The{' '}
                    <span className="text-ink">“Generate fix from this review”</span> button
                    hands your curated findings straight to the agentic fixer below.
                  </p>
                </WalkStep>
              </div>
            </div>

            <div className="mt-12 border-t border-ink pt-6">
              <h3 className="mb-3.5 font-display text-h4 font-semibold text-ink">
                Why not just ask the CLI?
              </h3>
              <p className="max-w-answer text-body-sm">
                You can — and the review evaporates when the session ends. No line-anchored
                posting, no per-commit history, no memory of what you kept last time, and
                the copy-paste back into GitHub is on you. {SITE_NAME} keeps the same agent,
                and removes the same twenty minutes — per PR, per day.
              </p>
            </div>
          </div>
        </RailGrid>
      </Section>

      {/* ---------- ai fix ---------- */}
      <Section id="ai-fix">
        <RailGrid rail={{ word: 'AI Fix' }} cols="one">
          <div>
            <h2 className="mb-7 text-pretty font-display text-h2-sm font-semibold text-ink type:text-h2">
              From red CI to pushed fix, one click at a time.
            </h2>

            <ShotFrame
              src="/shots/ai-fix.png"
              alt="The AI Analysis & Fix tab: a CI-failure diagnosis, a generated patch shown as a reviewable file diff, and push controls."
              caption={`${SHOT}ai fix`}
              height={430}
              fit="cover"
              className="mb-7"
            />

            <p className="max-w-answer">
              Like Claude Review, it runs on <span className="text-ink">Claude Sonnet 5</span>{' '}
              by default — the latest Claude — with{' '}
              <span className="text-ink">Opus 4.8</span> selectable for the hardest fixes.
            </p>

            {/* the walkthrough */}
            <div className="mt-14 border-t border-rule pt-10">
              <MonoLabel className="mb-4 text-secondary">Walk through it</MonoLabel>
              <h3 className="mb-4 font-display text-h3 font-semibold text-ink">
                Red CI to pushed fix, step by step.
              </h3>
              <p className="mb-11 max-w-answer text-lede text-ink-soft">
                A real failing check on a real PR — these are the screens, in order. Total
                human effort: reading a diagnosis and approving a diff.
              </p>

              <div className="flex flex-col gap-11">
                <WalkStep
                  n="01"
                  title="CI goes red. You don’t go log-spelunking."
                  shot="/shots/flow-fix-1-ci.png"
                  alt="The CI status block on the PR: terraform plan failed, tflint and checkov passed."
                  caption={`${SHOT}fix · 01`}
                  height={135}
                >
                  <p>
                    <span className="font-mono text-[16px] text-ink">terraform plan</span>{' '}
                    fails on an infrastructure PR. Normally that’s a tab into GitHub
                    Actions, a scroll through a thousand log lines, and a guess. In{' '}
                    {SITE_NAME} the failing check is already on the PR’s pane — and the next
                    step reads the log for you.
                  </p>
                </WalkStep>

                <WalkStep
                  n="02"
                  title="One click for a diagnosis, with its confidence shown."
                  shot="/shots/flow-fix-2-analysis.png"
                  alt="The CI failure analysis: confidence chips reading root cause high / fixability high, a root-cause explanation naming the inverted min/max autoscaling bounds, the failing check identified, a suggested fix, and Re-analyze / Fix it buttons."
                  caption={`${SHOT}fix · 02`}
                  height={280}
                >
                  <p>
                    {SITE_NAME} pulls the failing job log and produces a diagnosis: the root
                    cause (an inverted{' '}
                    <span className="font-mono text-[16px] text-ink">min/max</span> bound —
                    raised the minimum, forgot the maximum), which check failed and why the
                    others passing narrows it, and a suggested fix —{' '}
                    <span className="text-ink">with its confidence stated up front</span>,
                    so you know how much to trust it before you act. Agree? Click{' '}
                    <span className="text-ink">Fix it →</span>.
                  </p>
                </WalkStep>

                <WalkStep
                  n="03"
                  title="The agent patches in a sandbox. You review a diff."
                  shot="/shots/flow-fix-3-diff.png"
                  alt="The AI Fix result: a one-file diff on terraform/eks/node-groups.tf correcting min_size to 2 and max_size to 8, rendered as a reviewable file diff with a summary above it."
                  caption={`${SHOT}fix · 03`}
                  height={395}
                >
                  <p>
                    The fix runs in an <span className="text-ink">ephemeral worktree</span>{' '}
                    — never your checkout, never the live branch — and comes back as a
                    reviewable, file-by-file diff with a summary of what it did and why. Two
                    lines changed here; you read it in ten seconds. Nothing has touched
                    GitHub yet.
                  </p>
                </WalkStep>

                <WalkStep
                  n="04"
                  title="Push it — conflicts included, force-push excluded."
                  shot="/shots/flow-fix-4-push.png"
                  alt="The push panel: a generated commit message, a choice between pushing to the PR branch or a new branch with a fresh PR, a “Let Claude resolve conflicts” toggle, and Rebase onto trunk / Merge trunk in / Push + open PR buttons."
                  caption={`${SHOT}fix · 04`}
                  height={295}
                  last
                >
                  <p>
                    Approve the commit message and pick the target: the PR’s own branch
                    (when you have push rights) or a new branch with a fresh PR. Trunk moved
                    under the PR while you were at it? {SITE_NAME} checks, and can{' '}
                    <span className="text-ink">
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

            <div className="mt-12 border-t border-ink pt-6">
              <h3 className="mb-3.5 font-display text-h4 font-semibold text-ink">
                Could you do this in your CLI?
              </h3>
              <p className="max-w-answer text-body-sm">
                Absolutely: clone, checkout, tail the log, paste it at the agent, apply the
                patch, resolve the rebase, push — call it fifteen minutes when nothing
                surprises you. Times every red build, every day. {SITE_NAME} makes the whole
                loop four clicks, and the git plumbing — worktrees, conflict resolution,
                branch hygiene — is the part it never gets wrong.
              </p>
            </div>
          </div>
        </RailGrid>
      </Section>

      {/* ---------- control ---------- */}
      <Section id="control" tone="alt">
        <RailGrid rail={{ word: 'Control' }} cols="one">
          <div>
            <h2 className="mb-8 font-display text-h2-sm font-semibold text-ink type:text-h2">
              Your models, your data.
            </h2>

            <div className="grid gap-8 rail:grid-cols-3">
              <div className="border-t border-ink pt-[18px]">
                <h3 className="mb-3 font-display text-h4-sm font-semibold text-ink">
                  Auth, today
                </h3>
                <p className="text-list">
                  Agentic features run on your own Anthropic API key. Usage is tracked
                  transparently in credits, in-app — no surprise bills, no background spend.
                </p>
              </div>
              <div className="border-t border-ink pt-[18px]">
                <h3 className="mb-3 font-display text-h4-sm font-semibold text-ink">
                  Coming
                </h3>
                <p className="text-list">
                  Metered pay-as-you-go at API list price, and OpenAI-compatible BYO
                  endpoints — Bedrock, self-hosted, open models — for cost and privacy
                  control.
                </p>
              </div>
              <div className="border-t border-ink pt-[18px]">
                <h3 className="mb-3 font-display text-h4-sm font-semibold text-ink">
                  The rule
                </h3>
                <p className="text-list">
                  AI never merges, posts, or pushes without a human click. Every review is
                  yours to author; every fix is a diff you approved. That’s not a limitation
                  — it’s the feature.
                </p>
              </div>
            </div>

            <div className="mt-10 border-t border-rule-strong pt-6">
              <MonoLabel className="mb-2.5 text-secondary">Privacy</MonoLabel>
              <p className="max-w-answer text-body-sm">
                Your data is yours — private and confidential, forever. {SITE_NAME} never
                trains on it, never shares it, and in local mode it never even leaves your
                machine.
              </p>
            </div>
          </div>
        </RailGrid>
      </Section>

      {/* ---------- final CTA ---------- */}
      <Section divider="ink" pad="lg">
        <div className="flex flex-col gap-10 rail:flex-row rail:items-end rail:justify-between rail:gap-14">
          <div>
            <MonoLabel className="mb-5 text-secondary">Pro · $15/mo</MonoLabel>
            <h2 className="mb-5 max-w-[24ch] font-display text-h2-sm font-semibold text-ink type:text-cta">
              <span className="text-signal-text">Fifteen dollars.</span> Fewer than the tabs
              it closes.
            </h2>
            <p className="max-w-[56ch]">
              The board is free forever. Pro is the layer that reads it for you.
            </p>
          </div>
          <div className="shrink-0">
            <InkButton to="/pricing">See pricing</InkButton>
          </div>
        </div>
      </Section>
    </>
  );
}
