import { useSeo } from '../lib/seo';
import { seoFor } from '../lib/routes';
import { SITE_NAME } from '../lib/site';
import {
  Evidence,
  InkButton,
  InlineLink,
  MonoLabel,
  MonoLink,
  RailGrid,
  Section,
  Story,
  UnderlineLink,
} from '../components/feint/primitives';
import { ShotFrame } from '../components/feint/ShotFrame';
import { PixelIcon } from '../components/feint/PixelIcon';

// ---------------------------------------------------------------------------
// The receipt — the bot-monitoring page, and the differentiator's deep page.
//
// This page exists for two readers: the rung-3 homepage visitor who stopped at
// "wait, nobody else does that", and the organic searcher asking "is the review
// bot worth it / why is it so noisy". The framing is COMPLEMENTARY throughout —
// Limn makes your bots better value; it never competes with them. The honesty
// block in 01 and the caveats in 02 are mandatory copy: advisory labels,
// bucketed severity, confidence shown. This audience is HN-grade sceptical, and
// the honesty is the brand.
//
// It mounts the five bot shots (`bot-roi`, `bot-dedup`, `bot-only-review`,
// `bot-inhouse`, `bot-settings`) that capture-shots.mjs produced on every run
// while no page referenced them.
//
// EVIDENCE SOURCES (verbatim, verified 2026-08-04):
//   03 Mix   — greptile.com/blog/make-llms-shut-up ("~19% were good, 2% were
//              flat-out incorrect, and 79% were nits", Dec 2024)
//   04 Value — getdx.com/blog/how-are-engineering-leaders-approaching-2026-ai-
//              tooling-budget/ (86% of 50 budget holders uncertain; small n,
//              hence attributed as "a DX survey of 50…" in body copy, not
//              rendered as a quotation)
//   02 Test  — docs/ML-SEVERITY.md § Accuracy (the gold-300 adjudication,
//              scored with the served int8 ONNX artifact, split-half
//              calibration). Every numeral in 02 is copied from that table —
//              0.700 / 0.303 shipped, 0.474 / 0.697 vendor badge (n = 228),
//              0.700 / 0.320 human↔referee ceiling, macro-F1 ≈ 0.66,
//              76 declared-critical vs 2 adjudicated, 0.700 → 0.610 with
//              calibration off. Do not round, "improve" or re-derive them.
// ---------------------------------------------------------------------------

const SHOT = `${SITE_NAME.toLowerCase()} · `;

// The gold-300 scorecard. Higher exact agreement is better; lower ordinal
// error (mean absolute error in severity steps) is better.
const GOLD300: { rater: string; exact: string; mae: string; own?: boolean }[] = [
  { rater: `${SITE_NAME}’s model, as shipped`, exact: '0.700', mae: '0.303', own: true },
  { rater: 'Human vs. referee — the agreement ceiling', exact: '0.700', mae: '0.320' },
  { rater: 'The vendor’s own severity badge', exact: '0.474', mae: '0.697' },
];

export default function Bots(): JSX.Element {
  useSeo(seoFor('/bots'));

  return (
    <>
      {/* ---------- hero ---------- */}
      <Section divider="none" pad="none" className="pb-12 pt-20">
        <MonoLabel wide className="mb-[26px] text-secondary">
          The bot receipt — free
        </MonoLabel>
        <h1 className="mb-6 max-w-[24ch] text-pretty font-display text-hero-sm font-semibold text-ink type:text-page-title">
          Your AI reviewer has an invoice. This is the receipt.
        </h1>
        <p className="max-w-[58ch] text-pretty text-lede text-ink-soft">
          Every bot comment on your repos, graded by an independent model — severity,
          category, and whether your team acted on it. Whether the bot seat earns its
          keep stops being a feeling and becomes a number you can act on.
        </p>
      </Section>

      {/* ---------- 01 · the model ---------- */}
      <Section id="model">
        <RailGrid rail={{ n: '01', word: 'The model' }} cols="one">
          <div>
            <PixelIcon name="chip" className="mb-5" />
            <h2 className="mb-6 max-w-[26ch] text-pretty font-display text-h2-sm font-semibold text-ink type:text-h2">
              Graded by a model with no seat to sell.
            </h2>
            <div className="grid gap-grid-gutter rail:grid-cols-2">
              <p>
                Bot vendors grade their own homework — five of them currently claim #1 on
                the same public benchmark, citing different versions and metrics. And a
                public leaderboard, however honest, can’t tell you what happened on{' '}
                <em>your</em> repos with <em>your</em> team. {SITE_NAME}’s classifier is
                its own: fine-tuned on a multi-year corpus of GitHub bot reviews, running
                on plain CPU in the hosted service — not the bot’s self-assessment, and
                not an LLM invoice. Every bot-authored comment gets a severity and up to
                eight categories, seconds after sync.
              </p>
              <div>
                <p className="mb-[26px]">
                  It never competes with your bots. {SITE_NAME} doesn’t review code — it
                  measures the reviewers, which is exactly why the measurement can be
                  trusted. The meta-layer above every bot, including anything{' '}
                  {SITE_NAME} itself runs.
                </p>
                <div className="border-t border-rule pt-5">
                  <MonoLabel className="mb-3 text-secondary">Honestly, though</MonoLabel>
                  <p className="text-list text-muted">
                    Labels are advisory. Severity buckets the top of the scale (major +
                    critical read as “high”), the nit/minor boundary is genuinely fuzzy,
                    and confidence is shown — nothing auto-acts on a label. A grader that
                    hid its uncertainty would be one more bot to distrust.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </RailGrid>
      </Section>

      {/* ---------- 02 · the test — the ruler, measured ---------- */}
      <Section id="agreement" tone="alt">
        <RailGrid rail={{ n: '02', word: 'The test' }} cols="one">
          <div>
            <PixelIcon name="scales" className="mb-5" />
            <h2 className="mb-6 max-w-[26ch] text-pretty font-display text-h2-sm font-semibold text-ink type:text-h2">
              We measured the ruler. And the bot’s badge.
            </h2>

            <div className="grid gap-grid-gutter rail:grid-cols-2">
              <div>
                <p className="mb-[18px]">
                  Three hundred real bot comments, adjudicated fresh with every existing
                  label hidden — and deliberately stratified so the vendor’s own severity
                  verdicts were evenly represented, since that badge is the rater we’re
                  checking. Against that gold set we scored three raters: {SITE_NAME}’s
                  shipped model (calibration fit split-half, so the prior never grades its
                  own homework), the vendor’s self-declared severity badge on the same
                  comments, and a second human against a referee — the ceiling any grader
                  can reach.
                </p>
                <p className="mb-[18px]">
                  <span className="text-ink">
                    {SITE_NAME} agreed with the adjudication on 0.700 of comments — at the
                    human ceiling. The vendor’s own badge managed 0.474.
                  </span>{' '}
                  On the same three hundred comments the vendor declared{' '}
                  <span className="text-ink">76 critical</span>; the adjudication found{' '}
                  <span className="text-ink">2</span>.
                </p>
                <p className="mb-2">
                  One more number, because it settles the incentive question: turning our
                  calibration off makes the model agree with the vendor <em>more</em> —
                  and with the ground truth <em>less</em> (0.700 → 0.610 exact). Agreement
                  with the badge is an anti-metric. The contradictions are the feature,
                  which is why the vendor’s badge is shown beside our grade but never read
                  by the scoring path.
                </p>
              </div>

              <div>
                {/* The scorecard — ruled rows, mono numerals, no chart. */}
                <div className="border-t border-ink">
                  <div className="grid grid-cols-[1fr_auto_auto] items-baseline gap-x-6 py-3">
                    <MonoLabel className="text-secondary">Gold-300 scorecard</MonoLabel>
                    <span className="font-mono text-mono-caption uppercase text-secondary">
                      exact
                    </span>
                    <span className="text-right font-mono text-mono-caption uppercase text-secondary">
                      ordinal err.
                    </span>
                  </div>
                  {GOLD300.map((r) => (
                    <div
                      key={r.rater}
                      className="grid grid-cols-[1fr_auto_auto] items-baseline gap-x-6 border-t border-rule-hair py-3"
                    >
                      <span className={`text-list ${r.own ? 'text-ink' : 'text-ink-body'}`}>
                        {r.rater}
                      </span>
                      <span
                        className={`font-mono text-mono-data ${
                          r.own ? 'text-signal-text' : 'text-ink'
                        }`}
                      >
                        {r.exact}
                      </span>
                      <span className="text-right font-mono text-mono-data text-ink">
                        {r.mae}
                      </span>
                    </div>
                  ))}
                  <p className="border-t border-rule-hair pt-3 font-mono text-mono-caption text-secondary">
                    Exact severity agreement (higher is better) · mean error in severity
                    steps (lower is better). Vendor badge scored on the 228 comments that
                    carried one.
                  </p>
                </div>

                <div className="mt-7 border-t border-rule pt-5">
                  <MonoLabel className="mb-3 text-secondary">Honestly, though</MonoLabel>
                  <p className="text-list text-muted">
                    The model is advisory — macro-F1 ≈ 0.66 across classes, and CRITICAL
                    is the class it under-recalls, which is exactly why the product
                    buckets major + critical together as “high” everywhere and never lets
                    a label act on its own: no gate, no auto-resolve, no blocking. And
                    being at the ceiling on this gold set means a better number now
                    requires a better gold set, not a bolder claim.
                  </p>
                </div>
              </div>
            </div>

            <Story moment="Procurement review">
              “How do we know your grades are right?” has a scorecard for an answer — with
              the ceiling printed on it.
            </Story>
          </div>
        </RailGrid>
      </Section>

      {/* ---------- 03 · the mix ---------- */}
      <Section id="mix">
        <RailGrid rail={{ n: '03', word: 'The mix' }}>
          <div>
            <PixelIcon name="bars" className="mb-5" />
            <h2 className="mb-6 max-w-[24ch] text-pretty font-display text-h2-sm font-semibold text-ink type:text-h2">
              What your bots actually said.
            </h2>
            <p className="mb-2">
              The rollup answers the noise question per bot, per sprint: what share was
              nitpick, style, correctness, security, tests. A bot that’s 61% nits isn’t
              necessarily a bad bot — but it’s a fact worth knowing before renewal, and a
              tuning target you can point at.
            </p>
            <Evidence
              quote="~19% were good, 2% were flat-out incorrect, and 79% were nits"
              source="Greptile, measuring its own review bot’s comments — vendor blog, December 2024"
            />
            <p className="mb-2">
              On the PR itself, every bot comment wears its grade, and the PR carries a
              one-line triage — how many bot comments, how many real, how many a commit
              already addressed, how many nits to sweep in one pass.
            </p>
            <Story moment="Sprint review">
              “The bot feels noisy” arrives at the meeting as a chart, not an argument.
            </Story>
          </div>

          <ShotFrame
            src="/shots/bot-review.png"
            alt="A pull request's bot review threads with severity grades, triaged by what a commit already addressed."
            caption={`${SHOT}graded threads`}
            height={300}
            fit="cover"
            strong
          />
        </RailGrid>
      </Section>

      {/* ---------- 04 · value for money ---------- */}
      <Section id="value" tone="alt">
        <RailGrid rail={{ n: '04', word: 'Value' }}>
          <div>
            <PixelIcon name="coin" className="mb-5" />
            <h2 className="mb-6 max-w-[24ch] text-pretty font-display text-h2-sm font-semibold text-ink type:text-h2">
              Cost per useful comment.
            </h2>
            <p className="mb-[18px]">
              In Pro, type each bot’s monthly price into its row and the receipt prices
              itself:
              volume, severity mix, the share of comments a human actually acted on, and
              what every acted-on comment cost you. Review bots run $24–30 a seat —
              whether that’s a bargain or a subsidy for noise is now arithmetic. In a DX
              survey of 50 engineering budget holders, 86% were uncertain which of their
              AI tools actually provided benefit; this row is that answer, for review
              bots.
            </p>
            <p className="mb-2">
              Priced per workspace, so the platform team’s verdict on a bot doesn’t
              overwrite the web team’s.
            </p>
            <Story moment="Budget season">
              The renewal email arrives. The answer is already a number on the board.
            </Story>
          </div>

          <ShotFrame
            src="/shots/bot-roi.png"
            alt="The value-for-money view: per-bot monthly cost, comment volume, noise mix and acted-on share."
            caption={`${SHOT}value for money`}
            height={300}
            fit="contain"
          />
        </RailGrid>
      </Section>

      {/* ---------- 05 · noise, located ---------- */}
      <Section id="noise">
        <RailGrid rail={{ n: '05', word: 'Noise' }} cols="one">
          <div>
            <PixelIcon name="noise" className="mb-5" />
            <h2 className="mb-6 max-w-[26ch] text-pretty font-display text-h2-sm font-semibold text-ink type:text-h2">
              Where the noise comes from — and where nobody’s listening.
            </h2>
            <p className="mb-9 max-w-answer">
              Noise concentrates: in a repo, in a bot, in a category. The free receipt
              flags the <span className="text-ink">bot-only reviews</span> no human ever
              handled — the clearest sign a bot needs tuning, not a bigger audience — and
              counts your <span className="text-ink">in-house bots</span> like any vendor:
              lint-wrapper or $30 seat, same receipt. Pro’s depth layer then locates the
              rest per bot — the <span className="text-ink">overlap</span> between bots
              (two vendors raising the same issue on the same code is paying twice to be
              told the same thing), where each bot works, its trends and its anomalies.
            </p>

            <div className="grid gap-grid-gutter rail:grid-cols-2">
              <ShotFrame
                src="/shots/bot-dedup.png"
                alt="Cross-bot overlap in Pro: the same issue raised by two bots on the same code."
                caption={`${SHOT}overlap · pro`}
                height={240}
                fit="contain"
                strong
              />
              <ShotFrame
                src="/shots/bot-only-review.png"
                alt="Open PRs where the only review activity is bot-authored — reviews no human has handled."
                caption={`${SHOT}bot-only reviews`}
                height={240}
                fit="contain"
                strong
              />
            </div>
            <ShotFrame
              src="/shots/bot-inhouse.png"
              alt="An in-house bot counted alongside the vendors: volume, mix and acted-on share for a bot your own team runs."
              caption={`${SHOT}in-house bots`}
              height={200}
              fit="contain"
              strong
              className="mt-6 max-w-[560px]"
            />

            <MonoLink to="/pro" className="mb-2">
              Per-bot depth, overlap &amp; trends live in Pro →
            </MonoLink>
            <Story moment="Tuning day">
              The mix names the worst offender and its loudest category. You tune one
              rule, and next sprint’s chart shows whether it worked.
            </Story>
          </div>
        </RailGrid>
      </Section>

      {/* ---------- 06 · tune, don't churn ---------- */}
      <Section id="tune" tone="alt">
        <RailGrid rail={{ n: '06', word: 'The verdict' }}>
          <div>
            <PixelIcon name="verdict" className="mb-5" />
            <h2 className="mb-6 max-w-[24ch] text-pretty font-display text-h2-sm font-semibold text-ink type:text-h2">
              Keep, tune, or kill — calmly.
            </h2>
            <p className="mb-[18px]">
              Every bot carries a working verdict — <span className="text-ink">keep</span>
              , <span className="text-ink">tune</span> or{' '}
              <span className="text-ink">noisy</span> — computed from what your team
              actually did with its output. And it’s patient by design: a comment only
              counts against a bot after a 36-hour grace window, so “unhandled” means
              ignored, not merely recent. Disagree? Reclassify any bot in a click; your
              judgement wins over the detection, per workspace.
            </p>
            <p className="mb-6 text-muted">
              Coming: the opt-in, anonymised cross-org benchmark — your bots’ acted-on
              rate against teams like yours. The receipt gets a reference column.
            </p>
            <MonoLink to="/pro">Per-bot depth &amp; period reports live in Pro →</MonoLink>
            <Story moment="Quarter end">
              Keep two, tune one, cancel one — decided in a minute, receipt attached.
            </Story>
          </div>

          <ShotFrame
            src="/shots/bot-settings.png"
            alt="Bot settings: per-workspace classification, identity and monthly cost — the user's override always wins."
            caption={`${SHOT}bot settings`}
            height={300}
            fit="contain"
          />
        </RailGrid>
      </Section>

      {/* ---------- final CTA ---------- */}
      <Section divider="ink" pad="lg">
        <div className="flex flex-col gap-10 rail:flex-row rail:items-end rail:justify-between rail:gap-14">
          <div>
            <h2 className="mb-5 max-w-[24ch] font-display text-h2-sm font-semibold text-ink type:text-cta">
              Free. Because you’d doubt a ruler you rented.
            </h2>
            <p className="max-w-[56ch]">
              The receipt is in the free tier — sign in with GitHub, point it at your
              repos, and read this month’s number. Grading runs in the hosted service
              today; bringing the model to the local install is on the{' '}
              <InlineLink to="/how-it-works#roadmap">roadmap</InlineLink>.
            </p>
          </div>
          <div className="flex shrink-0 flex-col items-start gap-3.5">
            <InkButton to="/api/auth/login">Sign in with GitHub</InkButton>
            <UnderlineLink to="/features">Everything else that’s free</UnderlineLink>
          </div>
        </div>
      </Section>
    </>
  );
}
