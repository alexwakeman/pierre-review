import { useSeo } from '../lib/seo';
import { seoFor } from '../lib/routes';
import { HERO_VARIANT, INSTALL_COMMAND, SITE_NAME } from '../lib/site';
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
import { SignalFigure, Sprite } from '../components/feint/Sprite';
import { Rain } from '../components/feint/Rain';
import { GameBar } from '../components/feint/GameBar';

// ---------------------------------------------------------------------------
// The home page — one morning, told in eight timestamps.
//
// The IA is a progressive reveal anchored to a single recurring scenario
// ("One morning, three repos"): each section opens with a <Beat> — a mono
// timestamp line that advances the same morning by one step — and the final
// CTA closes it at 09:31. The beats are strictly chronological down the page.
//
// Section order is the discovery ladder, deliberately: problem → the receipt
// (the differentiator, early) → the queue → acting in place → Pro → Pro+ →
// local → price. The agentic Claude loop is the LATE reveal by design — the
// positioning research is emphatic that "AI reviews your PRs" must never lead.
//
// The hero H1 has two variants behind HERO_VARIANT in lib/site.ts ('calm'
// live, 'signal' the proven fallback). Flip the flag, rebuild, ship.
//
// The TOP of the page is copy-only by design: hero → the stats band (the
// surprise) → why Limn exists (the idea) → the game bar. The old full-width
// hero screenshot is out for now; screenshots start at §02 and will return to
// the top once the new close-crops exist.
// ---------------------------------------------------------------------------

const WORKS_WITH = ['CodeRabbit', 'Greptile', 'Copilot', 'Qodo', 'Sourcery'];

// The stats band — measured, sourced, and led by the one fact that reframes
// the category. Keep every number here traceable to the sources line below it;
// the unverifiable ones were culled deliberately.
const STATS: { n: string; d: string }[] = [
  { n: '98%', d: 'more PRs merged since AI-assisted coding took hold' },
  { n: '+91%', d: 'longer those PRs now spend waiting in review' },
  { n: '6.9/10', d: 'the measured relevance of the average bot review comment' },
  { n: '5', d: 'vendors claiming #1 on the same code-review benchmark' },
];

const FOR_MANAGERS = [
  'Which of the bots you pay for earns its keep — cost, noise mix and overlap, per workspace.',
  'A reliable state of play — stalled PRs, waiting reviews, quiet threads — without asking anyone.',
  'Flow metrics you can drill into. Mirrors, not scorecards.',
];

const FOR_ENGINEERS = [
  'Know instantly when it’s your turn, without keeping forty tabs warm.',
  'Every review thread triaged: what a commit already addressed, what still needs you.',
  'Reply, resolve, rebase, merge — without leaving the board.',
];

/**
 * One beat of the scenario — a mono marginalia line above a section heading.
 * The vermilion em-dash is the same list-marker use DashItem establishes; the
 * timestamp is ink, the beat itself stays secondary. Quiet, like everything.
 */
function Beat({ t, children }: { t: string; children: string }): JSX.Element {
  return (
    <p className="mb-5 flex items-baseline gap-3.5 font-mono text-mono-nav text-secondary">
      <span aria-hidden="true" className="text-signal-text">
        —
      </span>
      <span>
        <span className="text-ink">{t}</span> · {children}
      </span>
    </p>
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
          {/* The mark, large — the same "group" sprite as the header wordmark
              and the game, at hero scale, accents in vermilion. */}
          <Sprite
            name="group"
            cell={4}
            fill="#16161A"
            accent="#C13A20"
            className="mb-7"
          />
          <MonoLabel wide className="mb-[26px] text-secondary">
            The cross-repo review layer
          </MonoLabel>

          {HERO_VARIANT === 'signal' ? (
            <h1 className="mb-7 max-w-[22ch] text-pretty font-display text-hero-sm font-semibold text-ink type:text-hero">
              Your review bot flags 40 things. {SITE_NAME} shows you the{' '}
              <span className="text-signal-text">3</span> that matter.
            </h1>
          ) : (
            <h1 className="mb-7 max-w-[22ch] text-pretty font-display text-hero-sm font-semibold text-ink type:text-hero">
              Calm above the noise.
            </h1>
          )}

          <p className="mb-[34px] max-w-lede text-pretty text-lede text-ink-soft">
            Every repo, every team, every review bot — one quiet board above the churn:
            what’s stalled, whose turn it is, and what the bots are actually worth. Free,
            open-core, and it runs on your machine.
          </p>

          <div className="mb-4 flex flex-wrap items-center gap-3.5">
            <InkButton to="/api/auth/login">Sign in with GitHub</InkButton>
            <UnderlineLink to="/features">See what’s free</UnderlineLink>
          </div>

          <p className="mb-11 max-w-reassure font-mono text-mono-nav text-secondary">
            Or run it entirely on your machine — local mode uses your gh login and keeps no
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

      {/* ---------- the numbers — the surprise, in the headlines ---------- */}
      <Section divider="ink" pad="none" className="py-14">
        <RailGrid rail={{ word: 'The numbers' }} cols="one">
          <div>
            <h2 className="mb-10 max-w-[30ch] text-pretty font-display text-h2-sm font-semibold text-ink type:text-h2">
              The bots got fast. Review got slower. And everyone claims first place.
            </h2>

            <div className="grid gap-x-grid-gutter gap-y-8 type:grid-cols-2 rail:grid-cols-4">
              {STATS.map((s) => (
                <div key={s.n} className="border-t border-rule-strong pt-[18px]">
                  <div className="mb-2.5 font-display text-price font-semibold tracking-[-0.03em] text-ink">
                    {s.n}
                  </div>
                  <p className="text-list text-ink-body">{s.d}</p>
                </div>
              ))}
            </div>

            <p className="mt-8 font-mono text-mono-caption text-secondary">
              Sources: Faros AI, 10,000+ developers · Fatima et al., arXiv, April 2026 ·
              the vendors’ own blogs, 2026.
            </p>
          </div>
        </RailGrid>
      </Section>

      {/* ---------- why — the idea the product came from ---------- */}
      <Section pad="none" className="py-14">
        <RailGrid rail={{ word: 'Why Limn' }} cols="one">
          <div>
            <h2 className="mb-6 max-w-[26ch] text-pretty font-display text-h2-sm font-semibold text-ink type:text-h2">
              Built for the engineers keeping up.
            </h2>
            <p className="mb-6 max-w-[62ch] text-pretty text-lede">
              AI multiplied what a team ships — and what a team has to read. Nobody is
              short of code any more; everyone is short of attention: more repos, more
              PRs, more commentary, arriving faster than anyone can triage by hand.
            </p>
            <p className="mb-6 max-w-answer font-serif text-pull-quote italic text-ink">
              The pace isn’t coming back down. So the tools have to come up.
            </p>
            <p className="max-w-[62ch] text-pretty">
              That’s the whole idea: complexity you can see is complexity you can manage.
              The churn stays out there — you get the calm layer above it.
            </p>
          </div>
        </RailGrid>
      </Section>

      {/* ---------- arcade entry (after the CTAs, never before them) ---------- */}
      <GameBar />

      {/* ---------- 01 · the morning ---------- */}
      <Section divider="none">
        <RailGrid rail={{ n: '01', word: 'The morning' }}>
          <div className="rail:col-span-2">
            <Beat t="09:04">
              One app, not eleven tabs. Three repos, forty-one open PRs, two review bots,
              standup at half past.
            </Beat>
            <Beat t="09:05">My Turn: of the forty-one, three need you.</Beat>

            <h2 className="mb-[30px] max-w-[30ch] text-pretty font-display text-h2-sm font-semibold text-ink type:text-h2-major">
              Three hundred signals a week. Three that need you.
            </h2>

            <div className="grid gap-grid-gutter rail:grid-cols-2">
              <div>
                <p>
                  Review bots never stop. A busy team fields hundreds of AI review comments
                  a week, across more repos than anyone can hold in their head — and the
                  firehose buries the handful that genuinely needed a human. The bottleneck
                  moved from writing the change to noticing what matters.
                </p>
              </div>

              <div>
                <p className="mb-[26px]">
                  {SITE_NAME} doesn’t add another bot. It sits <em>above</em> the ones you
                  already run and budgets the scarce resource — your attention. Every
                  thread, human or bot, becomes a triaged signal.
                </p>

                {/* The signal figure — the only figure on the page. */}
                <div className="border-t border-rule pt-5">
                  <MonoLabel className="mb-3.5 text-secondary">
                    300 signals · 3 need you
                  </MonoLabel>
                  <SignalFigure />
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

      {/* ---------- 02 · the receipt — the differentiator, early ---------- */}
      <Section tone="alt">
        <RailGrid rail={{ n: '02', word: 'The receipt' }}>
          <div>
            <Beat t="09:08">
              The receipt: 214 bot comments this month. 61% nits. Your two bots agreed 58%
              of the time.
            </Beat>

            <h2 className="mb-6 max-w-[24ch] text-pretty font-display text-h2-sm font-semibold text-ink type:text-h2">
              Every bot comment, independently graded.
            </h2>
            <p className="mb-[18px]">
              {SITE_NAME}’s own ML model — trained on years of GitHub bot reviews, no LLM
              calls — labels every bot comment by severity and category,
              independently of the bot that wrote it. The noise question stops being a
              feeling: what share is nitpick, what’s correctness, where two bots overlap,
              and what each vendor costs per comment a human actually acted on.
            </p>
            <p className="mb-6">
              Five vendors currently claim #1 on the same public benchmark.{' '}
              <span className="text-ink">{SITE_NAME}’s number is about your repos.</span>{' '}
              And it’s in the free tier — a measurement you’d have to pay for is a
              measurement you’d doubt.
            </p>
            <MonoLink to="/bots">The receipt, in depth →</MonoLink>
          </div>

          <div>
            <ShotFrame
              src="/shots/bot-roi.png"
              alt="The bot value-for-money view: per-bot monthly cost, comment volume, noise mix and the share of comments a human acted on."
              caption={`${SITE_NAME.toLowerCase()} · value for money`}
              height={260}
              fit="contain"
              strong
            />
            <ShotFrame
              src="/shots/bot-dedup.png"
              alt="Cross-bot overlap: where two review bots raised the same issue on the same code — paying twice to be told the same thing."
              caption={`${SITE_NAME.toLowerCase()} · overlap`}
              height={200}
              fit="contain"
              strong
              className="mt-6"
            />
          </div>
        </RailGrid>
      </Section>

      {/* ---------- 03 · the queue ---------- */}
      <Section>
        <RailGrid rail={{ n: '03', word: 'The queue' }}>
          <div>
            <Beat t="09:12">
              A thread nobody answered, on the PR that ships tomorrow. Untouched — three
              days now.
            </Beat>

            <h2 className="mb-6 max-w-[24ch] text-pretty font-display text-h2-sm font-semibold text-ink type:text-h2">
              Forty-one open PRs. Three need you.
            </h2>
            <p className="mb-[18px]">
              My Turn is pull-based, not another notification pile: anything on a PR you
              authored, review, or were asked into is flagged as yours, full context
              inline. Every review thread carries one of four states —{' '}
              <span className="text-ink">
                resolved · likely addressed · replied · untouched
              </span>{' '}
              — cross-referenced against the commits that landed after it. “Likely” is a
              heuristic, and the UI says so.
            </p>
            <p className="mb-6">
              Behind the feed sits the board: every repo, every contributor, one timeline.
              A long bar with no recent markers <em>is</em> a stalled PR — no query
              required. Adaptive sync keeps hot repos seconds fresh without burning your
              rate limit on cold ones.
            </p>
            <MonoLink to="/features">Everything in the free tier →</MonoLink>
          </div>

          <ShotFrame
            src="/shots/timeline.png"
            alt="The timeline board: repos down the side, time across the top, with PR bars and event markers."
            caption="repos down the side, time across the top"
            height={280}
            fit="contain"
          />
        </RailGrid>
      </Section>

      {/* ---------- 04 · in place ---------- */}
      <Section>
        <RailGrid rail={{ n: '04', word: 'In place' }}>
          <div>
            <Beat t="09:15">
              Two PRs were ready all along. Rebase, merge, merge. You never left.
            </Beat>

            <h2 className="mb-6 font-display text-h2-sm font-semibold text-ink type:text-h2">
              Act where you noticed.
            </h2>
            <p className="mb-6">
              Reply, resolve, approve, request reviewers, rebase from main, merge — real
              GitHub writes, gated on your real permissions. The merge control knows what
              GitHub knows: <span className="text-ink">unstable is mergeable</span>,
              behind isn’t. Failing CI? The job log is one click, in-pane. In a 700-hour
              field study, resuming interrupted work took twenty-five minutes on average;
              the point of one surface is never paying that.
            </p>
          </div>

          <ShotFrame
            src="/shots/pr-detail.png"
            alt="The PR detail pane: CI checks, reviewers and approvers, merge controls and inline threads — real GitHub write actions in place."
            caption={`${SITE_NAME.toLowerCase()} · pr detail`}
            height={240}
            fit="cover"
          />
        </RailGrid>
      </Section>

      {/* ---------- 05 · the intelligence layer (Pro) ---------- */}
      <Section tone="alt">
        <RailGrid rail={{ n: '05', word: 'Pro' }}>
          <div>
            <Beat t="09:20">
              The digest reads itself: three security flags untouched, five threads need a
              human.
            </Beat>

            <h2 className="mb-6 font-display text-h2-sm font-semibold text-ink type:text-h2">
              A digest with teeth.
            </h2>
            {/* The proof-block — a pull-quote in INK, not in the signal colour.
                It is the product proving the measurement, in its own words. */}
            <p className="mb-6 max-w-answer font-serif text-pull-quote italic text-ink">
              “This sprint your bots posted 420 comments — 38% acted on. Three untouched
              security flags on auth PRs. Two bots agreed on twelve issues; you paid both.
              Five threads actually need a human.”
            </p>
            <p className="mb-6">
              That’s Pro: attention-and-risk digests instead of activity recaps — plus
              validity checks on threads while you review, “was this addressed?” with a
              confidence gauge, themes and reports across human and bot reviews, chat with
              your repos with charts you can pin, and CI failures summarised to root
              cause.
            </p>
            <MonoLink to="/pro">The whole intelligence layer →</MonoLink>
          </div>

          <ShotFrame
            src="/shots/activity-feed-pro.png"
            alt="The Activity feed with My Turn cards flagged and a digest card summarising what the bots posted and what needs a human."
            caption={`${SITE_NAME.toLowerCase()} · my turn + digest`}
            height={320}
            fit="contain"
            strong
          />
        </RailGrid>
      </Section>

      {/* ---------- 06 · the full loop (Pro+) — the late reveal ---------- */}
      <Section>
        <RailGrid rail={{ n: '06', word: 'The full loop' }}>
          <div>
            <Beat t="09:24">
              The null-check Claude flagged Tuesday: pick the two comments that matter,
              fix, push.
            </Beat>

            <h2 className="mb-6 font-display text-h2-sm font-semibold text-ink type:text-h2">
              The whole loop, one app.
            </h2>
            <p className="mb-[18px]">
              Pro+ closes the loop. Context-aware Claude reviews that{' '}
              <span className="text-ink">learn</span> — what you kept, cut and reworded
              last run informs the next, so settled decisions stay settled. Reword any
              finding in your voice, or simplify it to its point.
            </p>
            <p className="mb-6">
              Then pick the comments that matter and generate the fix: patched in an
              ephemeral worktree, reviewed as a diff, pushed on your click. Every run
              stays on the PR’s history — no digging through agent session logs, no
              copy-paste between apps. Your key, your models;{' '}
              <span className="text-ink">
                nothing posts, pushes or merges without a human click.
              </span>
            </p>
            <MonoLink to="/pro#claude-review">
              Walk through it, screen by screen →
            </MonoLink>
          </div>

          <ShotFrame
            src="/shots/flow-review-3-findings.png"
            alt="Claude's structured review output: severity-tagged, line-anchored findings with diff hunks — each one keep, reword or ignore."
            caption={`${SITE_NAME.toLowerCase()} · claude review`}
            height={320}
            fit="cover"
          />
        </RailGrid>
      </Section>

      {/* ---------- 07 · local ---------- */}
      <Section>
        <RailGrid rail={{ n: '07', word: 'Local' }}>
          <div>
            <h2 className="mb-6 font-display text-h2-sm font-semibold text-ink type:text-h2">
              Or keep it entirely on your machine.
            </h2>
            <p className="mb-[26px] max-w-[52ch]">
              One command. No accounts, no hosted backend, no stored credentials — it
              authenticates with your <span className="font-mono text-[16px]">gh</span>{' '}
              CLI, syncs to a local SQLite file, and opens straight to the Activity
              console. Or self-host the same image inside your own infrastructure. Your
              code and AI spend stay under your control.
            </p>
            <MonoLink to="/how-it-works#run-locally">
              What happens when you run it →
            </MonoLink>
          </div>

          <TerminalPanel label="zsh · ~/work" command={INSTALL_COMMAND} cursor />
        </RailGrid>
      </Section>

      {/* ---------- 08 · price ---------- */}
      <Section>
        <RailGrid rail={{ n: '08', word: 'Price' }} cols="one">
          <div>
            <h2 className="mb-[34px] font-display text-h2-sm font-semibold text-ink type:text-h2">
              Free where it matters. Paid where it counts.
            </h2>
            <div className="grid gap-grid-gutter border-t border-ink pt-[26px] rail:grid-cols-3">
              <div>
                <div className="mb-3.5 flex items-baseline justify-between gap-4">
                  <h3 className="font-display text-h5 font-semibold text-ink">Free</h3>
                  <span className="font-mono text-mono-data text-ink">$0, forever</span>
                </div>
                <p className="text-body-sm">
                  The dashboard, the timeline, My Turn — and the bot receipt.
                </p>
              </div>
              <div>
                <div className="mb-3.5 flex items-baseline justify-between gap-4">
                  <h3 className="font-display text-h5 font-semibold text-ink">Pro</h3>
                  <span className="font-mono text-mono-data text-signal-text">
                    $15/seat/mo
                  </span>
                </div>
                <p className="text-body-sm">
                  The intelligence layer — digests with teeth, validity, themes, chat.
                </p>
              </div>
              <div>
                <div className="mb-3.5 flex items-baseline justify-between gap-4">
                  <h3 className="font-display text-h5 font-semibold text-ink">Pro+</h3>
                  <span className="font-mono text-mono-data text-ink">$29/seat/mo</span>
                </div>
                <p className="text-body-sm">
                  The full loop — Claude review and fix, on your own key.
                </p>
              </div>
            </div>
          </div>
        </RailGrid>
      </Section>

      {/* ---------- final CTA — the scenario closes ---------- */}
      <Section divider="ink" pad="lg">
        <div className="flex flex-col gap-10 rail:flex-row rail:items-end rail:justify-between rail:gap-14">
          <div>
            <Beat t="09:31">Standup. You already know.</Beat>
            <h2 className="mb-5 max-w-[22ch] font-display text-h2-sm font-semibold text-ink type:text-cta">
              Know by 9:31.
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
