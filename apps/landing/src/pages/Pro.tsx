import type { ReactNode } from 'react';
import { useSeo } from '../lib/seo';
import { seoFor } from '../lib/routes';
import { SITE_NAME } from '../lib/site';
import {
  Evidence,
  InkButton,
  MonoLabel,
  RailGrid,
  RuledItem,
  Section,
  Story,
} from '../components/feint/primitives';
import { ShotFrame } from '../components/feint/ShotFrame';
import { PixelIcon } from '../components/feint/PixelIcon';

// ---------------------------------------------------------------------------
// The Pro page — the intelligence layer (Pro), then the full loop (Pro+).
//
// Eight sections, down from twelve: a numbered run (01–05) covering Pro —
// re-anchored on judgement (digests with teeth, validity, themes, chat, CI
// diagnosis) rather than generic AI summaries — an "Also in Pro" ruled list,
// an ink-ruled hinge into Pro+, then Claude Review and AI Fix with their
// walkthroughs, Control, and the CTA.
//
// This page is also served at the legacy /insights and /reviews aliases, so
// the historical anchor ids all still resolve: #digests #sprint #insights
// #metrics #my-turn #slack #tickets #claude-review #ai-fix #control. Where a
// section was folded, its id moved onto the block that inherited the content
// (#sprint → the reports block, #my-turn/#slack/#tickets → "Also in Pro").
//
// RETIRED: the sprint-report section and sprint-report.png (the component it
// photographed has zero call sites; the shot failed on every capture run).
// PRICES: Pro $15/seat/mo, Pro+ $29/seat/mo (annual) — the copy inventory is
// in Pricing.tsx's header comment.
//
// EVIDENCE SOURCES (verbatim, verified 2026-08-04):
//   02 Judgement — survey.stackoverflow.co/2025/ai (66%, top frustration)
//   03 Themes    — dora.dev/research/2025/dora-report/ (amplifier line)
//   04 Ask       — atlassian.com/blog/state-of-teams-2025 (25% of time lost
//                  searching for answers; stated in body copy, not quoted)
//   05 Red CI    — circleci.com/blog/five-takeaways-2026-software-delivery-
//                  report/ (72 minutes back-to-green, 28.7M workflows)
// ---------------------------------------------------------------------------

const METRICS: [string, string][] = [
  ['Deploy frequency', 'how often work actually lands'],
  ['Lead time', 'from first commit to merged'],
  ['Review latency', 'how long PRs wait for a first review'],
  ['Merge vs CI health', 'how much of the pipeline is green when it counts'],
  ['CI recovery time', 'real red→green MTTR, from a transition log — not a proxy'],
];

const ALSO_IN_PRO: { id: string; body: ReactNode }[] = [
  {
    id: 'my-turn',
    body: (
      <>
        <span className="text-ink">My Turn intelligence</span> — the feed is
        participation-aware: events on PRs you authored, review or weighed in on are
        flagged as yours, never buried under a volume cap.
      </>
    ),
  },
  {
    id: 'slack',
    body: (
      <>
        <span className="text-ink">Slack digests</span> on your cadence — daily or twice
        daily, timezone-aware. If nothing happened, nothing posts. (Email is on the
        roadmap.)
      </>
    ),
  },
  {
    id: 'tickets',
    body: (
      <>
        <span className="text-ink">Jira &amp; Linear links</span> — ticket keys detected
        from titles and branch names, rendered as deep links. Zero convention changes.
      </>
    ),
  },
  {
    id: 'suggestions',
    body: (
      <>
        <span className="text-ink">Reviewer suggestions</span> drawn from who actually
        touched the changed paths — requested in one click, rationale shown.
      </>
    ),
  },
];

/** The five severities Claude tags a finding with. Words, not coloured chips. */
const SEVERITIES = ['blocker', 'warning', 'nit', 'question', 'praise'];

const SHOT = `${SITE_NAME.toLowerCase()} · `;

/**
 * One step of a teaching walkthrough: a mono step number in its own sub-rail,
 * a title, the explanation, and the screenshot of that exact moment.
 *
 * NOT a card — a rule-separated row; the shot is an ordinary ShotFrame. The
 * crops are captured at a narrow viewport (scripts/capture-shots.mjs) so the
 * UI text stays legible at column width; the per-step `height` is chosen from
 * each crop's own aspect ratio.
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
            <MonoLabel className="mb-[26px] text-secondary">
              {SITE_NAME} Pro &amp; Pro+
            </MonoLabel>

            <h1 className="mb-6 font-display text-hero-sm font-semibold text-ink type:text-page-title">
              The intelligence layer — and the full loop.
            </h1>
            <p className="max-w-[58ch] text-pretty text-lede">
              The free board shows you everything and grades your bots. Pro adds
              judgement: digests with teeth, validity on threads, themes across reviews,
              answers on demand. Pro+ closes the loop — Claude reviews that learn, and
              fixes you approve — with a{' '}
              <span className="text-ink">human hand on the wheel</span> at every step.
            </p>

            {/* The two tier pills, demoted to what they always were: labels. */}
            <div className="mt-9 flex flex-wrap gap-x-10 gap-y-2 border-t border-rule pt-4">
              <MonoLabel className="text-secondary">Pro · $15/seat/mo</MonoLabel>
              <MonoLabel className="text-secondary">
                Pro+ · $29/seat/mo · BYO key
              </MonoLabel>
            </div>
          </div>
        </RailGrid>
      </Section>

      {/* ---------- 01 · digests ---------- */}
      <Section id="digests">
        <RailGrid rail={{ n: '01', word: 'Digests' }}>
          <div>
            <PixelIcon name="digest" className="mb-5" />
            <h2 className="mb-6 text-pretty font-display text-h2-sm font-semibold text-ink type:text-h2">
              A digest with teeth, as your team ships.
            </h2>
            {/* The proof-block: the digest speaking for itself, in ink. */}
            <p className="mb-6 max-w-answer font-serif text-pull-quote italic text-ink">
              “This sprint your bots posted 420 comments — 38% acted on. Three untouched
              security flags on auth PRs. Two bots agreed on twelve issues; you paid both.
              Five threads actually need a human.”
            </p>
            <p className="mb-[18px]">
              Not an activity recap — an attention-and-risk report, built on the free
              tier’s receipt and thread states, per repo,{' '}
              <span className="text-ink">chained from the previous one</span> so it says
              what changed, with every PR a clickable{' '}
              <span className="font-mono text-[16px] text-ink">#N</span>.
            </p>
            <p>
              Refresh manually, on an interval, or on-change. An unchanged repo costs{' '}
              <span className="text-ink">$0, by design</span> — {SITE_NAME} hashes the
              underlying activity and skips the model call when nothing moved.
            </p>
            <Story moment="Sprint’s end">
              The report you used to assemble at 9:57 for the 10:00 wrote itself — and it
              names the risks, not just the activity.
            </Story>
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

      {/* ---------- 02 · review intelligence ---------- */}
      <Section id="review-assess" tone="alt">
        <RailGrid rail={{ n: '02', word: 'Judgement' }}>
          <div>
            <PixelIcon name="scales" className="mb-5" />
            <h2 className="mb-6 text-pretty font-display text-h2-sm font-semibold text-ink type:text-h2">
              Is this comment worth your time? Asked and answered, inline.
            </h2>
            <Evidence
              quote="AI solutions that are almost right, but not quite"
              source="The #1 frustration with AI tools — 66% of developers, Stack Overflow Developer Survey 2025"
            />
            <p className="mb-[18px]">
              “Almost right” is exactly what costs review time. While you review, Pro
              assesses the thread you’re reading:{' '}
              <span className="text-ink">is the comment valid</span>, does the objection
              still hold, and — past the free tier’s file-touch heuristic —{' '}
              <span className="text-ink">
                was it actually addressed, with a confidence gauge
              </span>
              . Long bot chains get{' '}
              <span className="text-ink">distilled to their point</span>, so you decide
              from the substance, not the scroll.
            </p>
            <Story moment="Mid-review">
              The gauge reads “addressed · high confidence”. You spot-check one and move
              on with your morning.
            </Story>
          </div>

          <ShotFrame
            src="/shots/activity-feed-pro.png"
            alt="The Activity feed with My Turn cards and inline thread assessments — validity and addressed-confidence rendered on the thread."
            caption={`${SHOT}inline judgement`}
            height={320}
            fit="contain"
            strong
          />
        </RailGrid>
      </Section>

      {/* ---------- 03 · themes, reports & metrics ---------- */}
      <Section id="insights">
        <RailGrid rail={{ n: '03', word: 'Themes' }} cols="one">
          <div>
            <PixelIcon name="themes" className="mb-5" />
            <h2 className="mb-6 font-display text-h2-sm font-semibold text-ink type:text-h2">
              The questions retros are supposed to answer.
            </h2>
            <Evidence
              quote="AI’s primary role is as an amplifier, magnifying an organization’s existing strengths and weaknesses."
              source="DORA, State of AI-assisted Software Development, 2025"
            />

            <ShotFrame
              src="/shots/insights.png"
              alt="The Insights rail: cards for stalled reviews, untouched threads, reviewer load and recurring review themes."
              caption={`${SHOT}insights`}
              height={430}
              fit="cover"
              className="mb-9"
            />

            <div className="grid gap-grid-gutter rail:grid-cols-2">
              <p id="sprint">
                No instrumentation, no extra pipeline — {SITE_NAME} already synced your
                history. <span className="text-ink">Themes</span> surface what keeps
                recurring across human and bot reviews — the module every reviewer trips
                on, the category one bot floods — and{' '}
                <span className="text-ink">reports</span> cut the record by severity and
                theme, per sprint window, re-runnable from the archive. Where the free
                receipt says <em>how much</em>, this says <em>what about</em> — the
                thematic bottleneck behind the number.
              </p>
              <div id="metrics">
                <ul className="mb-4 flex flex-col">
                  {METRICS.map(([name, sub], i) => (
                    <RuledItem key={name} last={i === METRICS.length - 1}>
                      <span className="text-ink">{name}</span> — {sub}
                    </RuledItem>
                  ))}
                </ul>
                <p className="text-body-sm text-muted">
                  Every tile clicks through to the PRs behind the number — no black-box
                  aggregates. Mirrors, not scorecards: better conversations, never
                  rankings.
                </p>
              </div>
            </div>

            <Story moment="Retro">
              The recurring theme was named before the meeting started. The retro argues
              about the fix, not the facts.
            </Story>
          </div>
        </RailGrid>
      </Section>

      {/* ---------- 04 · chat & charts ---------- */}
      <Section id="chat" tone="alt">
        <RailGrid rail={{ n: '04', word: 'Ask' }} cols="one">
          <div>
            <PixelIcon name="chat" className="mb-5" />
            <h2 className="mb-6 font-display text-h2-sm font-semibold text-ink type:text-h2">
              Ask the repo. Keep the answer.
            </h2>
            <div className="grid gap-grid-gutter rail:grid-cols-2">
              <p>
                Atlassian’s State of Teams 2025 put a number on hunting for answers:
                teams lose a quarter of their time to it. So ask in plain language —
                “who reviewed payments this sprint?”, “which PRs waited longest?” —
                grounded in your synced data, never a hallucinated dashboard. Answers
                arrive as <span className="text-ink">charts</span>, built ad hoc.
              </p>
              <p>
                Useful ones come pre-built; the ones worth keeping you{' '}
                <span className="text-ink">pin</span>, and past reports stay viewable and
                re-generable — the chart that settled last retro’s argument is one click,
                not an archaeology dig.
              </p>
            </div>
            <Story moment="Wednesday">
              A question asked in English, answered as a chart, pinned for the next time
              someone asks it.
            </Story>
          </div>
        </RailGrid>
      </Section>

      {/* ---------- 05 · CI diagnosis ---------- */}
      <Section id="ci">
        <RailGrid rail={{ n: '05', word: 'Red CI' }}>
          <div>
            <PixelIcon name="warning" className="mb-5" />
            <h2 className="mb-6 font-display text-h2-sm font-semibold text-ink type:text-h2">
              Red CI, explained before you open the log.
            </h2>
            <Evidence
              quote="72 minutes to get back to green for the typical team, up 13% from last year"
              source="CircleCI State of Software Delivery 2026 — 28.7 million workflows"
            />
            <p className="mb-2">
              A failing check gets a one-click diagnosis: {SITE_NAME} pulls the failing
              job log and names the root cause —{' '}
              <span className="text-ink">with its confidence stated up front</span>, so
              you know how much to trust it before you act. And when you want the fix{' '}
              <em>made</em>, the same diagnosis hands off to Pro+ below.
            </p>
            <Story moment="Red build">
              The diagnosis beat you to the log. You read one sentence, not a thousand
              lines.
            </Story>
          </div>

          <ShotFrame
            src="/shots/flow-fix-2-analysis.png"
            alt="The CI failure analysis: confidence chips, a root-cause explanation, the failing check identified, and a suggested fix."
            caption={`${SHOT}ci diagnosis`}
            height={280}
            fit="contain"
          />
        </RailGrid>
      </Section>

      {/* ---------- also in Pro ---------- */}
      <Section>
        <RailGrid rail={{ word: 'Also in Pro' }} cols="one">
          <ul className="flex max-w-answer flex-col">
            {ALSO_IN_PRO.map((item, i) => (
              <RuledItem key={item.id} last={i === ALSO_IN_PRO.length - 1}>
                <span id={item.id}>{item.body}</span>
              </RuledItem>
            ))}
          </ul>
        </RailGrid>
      </Section>

      {/* ---------- the hinge: Pro+ ----------
          An ink rule, not a ribbon. Everything below runs a real agent on your
          own key. */}
      <Section tone="alt" divider="ink">
        <RailGrid rail={{ word: 'Pro+' }} cols="one">
          <div>
            <MonoLabel className="mb-5 text-secondary">
              Pro+ · $29/seat/mo · BYO key
            </MonoLabel>
            <h2 className="mb-6 font-display text-h2-sm font-semibold text-ink type:text-h2-major">
              The full loop.
            </h2>
            <p className="max-w-[62ch] text-pretty text-lede">
              Everything below runs a real agent against your code — reviews, fixes,
              conflict resolution — on your own Anthropic key, usage metered in-app, and
              one rule always in view:{' '}
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
            <PixelIcon name="robot" className="mb-5" />
            <h2 className="mb-6 font-display text-h2-sm font-semibold text-ink type:text-h2">
              Reviews that are still there next week.
            </h2>
            <p className="mb-9 max-w-answer">
              Most AI code review happens in a chat tab — useful in the moment, gone the
              moment you close it. {SITE_NAME} runs the review against the PR, structures
              the output, and <span className="text-ink">saves it per commit</span> — no
              digging through agent-session histories, and the old run stays in history
              when you re-review after a push. Claude Sonnet 5 by default; Opus 4.8 for
              the gnarliest diffs; Haiku 4.5 for a quick pass.
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
                <p className="text-list">
                  Small, contained change touching no exported contract? The diff is
                  inlined into the prompt — no checkout, a tight turn cap, seconds to
                  finish. For the fix, the style pass, the refactor where the diff{' '}
                  <em>is</em> the context.
                </p>
              </div>
              <div className="border-t border-ink pt-[18px]">
                <MonoLabel className="mb-3.5 text-secondary">deep · worktree</MonoLabel>
                <h3 className="mb-3.5 font-display text-h4 font-semibold text-ink">
                  Full checkout to explore
                </h3>
                <p className="text-list">
                  Too many files, more than one subsystem, or any exported API, schema or
                  migration — the run earns a{' '}
                  <span className="text-ink">partial clone and an ephemeral worktree</span>
                  , with read-only tools to trace callers against the real tree.
                  Ambiguous? It rounds up to deep.
                </p>
              </div>
            </div>

            <p className="mt-7 max-w-answer text-body-sm text-muted">
              A deterministic router picks the depth before a token is spent, so cost
              tracks complexity. Force a mode per run if you like; every run is capped by
              turns and by dollars, and cancelable mid-flight.
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
                    From any PR’s detail pane, open the Claude Review tab. Pick a model
                    and a depth, or leave both on Auto — this 2-file, 72-line change
                    earns the fast, no-clone path; touch an exported API and it rounds up
                    to a full worktree.
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
                    Before the run, {SITE_NAME} surfaces what your past reviews in this
                    repo taught it — the finding you reworded (and how), the style nits
                    you keep dismissing — and hands those to Claude as context.{' '}
                    <span className="text-ink">Every review feeds the next one</span>; a
                    chat-tab review starts from zero, every time.
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
                    Each finding carries a severity, a{' '}
                    <span className="font-mono text-[16px] text-ink">file:line</span>{' '}
                    anchor, its diff hunk, and an optional suggestion. Per finding you
                    choose — post Claude’s wording,{' '}
                    <span className="text-ink">reword it in yours</span>, simplify it to
                    its point, or ignore it. Here the blocker and warning stay; the nits
                    are already cut.
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
                    , pinned to the head SHA so it can never land on stale code. Accepted
                    a finding that needs code?{' '}
                    <span className="text-ink">“Generate fix from this review”</span>{' '}
                    hands your curated findings straight to the fixer below.
                  </p>
                </WalkStep>
              </div>
            </div>

            <div className="mt-12 border-t border-ink pt-6">
              <h3 className="mb-3.5 font-display text-h4 font-semibold text-ink">
                Why not just ask the CLI?
              </h3>
              <p className="max-w-answer text-body-sm">
                You can — and the review evaporates when the session ends. No
                line-anchored posting, no per-commit history, no memory of what you kept
                last time, and the copy-paste back into GitHub is on you. {SITE_NAME}{' '}
                keeps the same agent, and removes the same twenty minutes — per PR, per
                day.
              </p>
            </div>

            <Story moment="Thursday">
              Run two doesn’t re-flag what you cut in run one. The bot is learning your
              taste; the noise goes down with use, not up.
            </Story>
          </div>
        </RailGrid>
      </Section>

      {/* ---------- ai fix ---------- */}
      <Section id="ai-fix">
        <RailGrid rail={{ word: 'AI Fix' }} cols="one">
          <div>
            <PixelIcon name="wrench" className="mb-5" />
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

            {/* the walkthrough */}
            <div className="mt-7 border-t border-rule pt-10">
              <MonoLabel className="mb-4 text-secondary">Walk through it</MonoLabel>
              <h3 className="mb-4 font-display text-h3 font-semibold text-ink">
                Red CI to pushed fix, step by step.
              </h3>
              <p className="mb-11 max-w-answer text-lede text-ink-soft">
                A real failing check on a real PR. Total human effort: reading a
                diagnosis and approving a diff.
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
                    Actions and a scroll through a thousand log lines. Here the failing
                    check is already on the PR’s pane — and the next step reads the log
                    for you.
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
                    The diagnosis names the root cause — an inverted{' '}
                    <span className="font-mono text-[16px] text-ink">min/max</span> bound
                    — why the other checks passing narrows it, and a suggested fix, with
                    confidence stated up front. Agree? Click{' '}
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
                    The fix runs in an{' '}
                    <span className="text-ink">ephemeral worktree</span> — never your
                    checkout, never the live branch — and comes back as a reviewable
                    diff. Two lines changed here; you read it in ten seconds. Nothing has
                    touched GitHub yet.
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
                    Approve the commit message and pick the target: the PR’s branch or a
                    new one with a fresh PR. Trunk moved underneath? {SITE_NAME} can{' '}
                    <span className="text-ink">
                      rebase or merge with agentic conflict resolution
                    </span>{' '}
                    in the same worktree, showing you the result first. It never
                    force-pushes anywhere but the PR’s own branch, never without your
                    click — and a conflict the agent can’t cleanly resolve is never
                    pushed at all.
                  </p>
                </WalkStep>
              </div>
            </div>

            <div className="mt-12 border-t border-ink pt-6">
              <h3 className="mb-3.5 font-display text-h4 font-semibold text-ink">
                Could you do this in your CLI?
              </h3>
              <p className="max-w-answer text-body-sm">
                Absolutely: clone, checkout, tail the log, paste it at the agent, apply,
                resolve the rebase, push — fifteen minutes when nothing surprises you,
                times every red build. {SITE_NAME} makes the loop four clicks, and the git
                plumbing — worktrees, conflicts, branch hygiene — is the part it never
                gets wrong.
              </p>
            </div>
          </div>
        </RailGrid>
      </Section>

      {/* ---------- control ---------- */}
      <Section id="control" tone="alt">
        <RailGrid rail={{ word: 'Control' }} cols="one">
          <div>
            <PixelIcon name="shield" className="mb-5" />
            <h2 className="mb-8 font-display text-h2-sm font-semibold text-ink type:text-h2">
              Your models, your data.
            </h2>

            <div className="grid gap-8 rail:grid-cols-3">
              <div className="border-t border-ink pt-[18px]">
                <h3 className="mb-3 font-display text-h4-sm font-semibold text-ink">
                  Your key
                </h3>
                <p className="text-list">
                  Pro+ runs on your own Anthropic API key — the model spend is yours at
                  list price, metered transparently in credits, in-app. No markup, no
                  surprise bills, no background spend.
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
                  yours to author; every fix is a diff you approved. That’s not a
                  limitation — it’s the feature.
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
            <MonoLabel className="mb-5 text-secondary">Pro from $15 a seat</MonoLabel>
            <h2 className="mb-5 max-w-[24ch] font-display text-h2-sm font-semibold text-ink type:text-cta">
              <span className="text-signal-text">Fifteen dollars a seat.</span> Fewer than
              the tabs it closes.
            </h2>
            <p className="max-w-[56ch]">
              The board is free forever. Pro reads it for you; Pro+ acts on it.
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
