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
// block in 01 is mandatory copy: advisory labels, bucketed severity, confidence
// shown. This audience is HN-grade sceptical, and the honesty is the brand.
//
// It mounts the five bot shots (`bot-roi`, `bot-dedup`, `bot-only-review`,
// `bot-inhouse`, `bot-settings`) that capture-shots.mjs produced on every run
// while no page referenced them.
//
// EVIDENCE SOURCES (verbatim, verified 2026-08-04):
//   02 Mix   — greptile.com/blog/make-llms-shut-up ("~19% were good, 2% were
//              flat-out incorrect, and 79% were nits", Dec 2024)
//   03 Value — getdx.com/blog/how-are-engineering-leaders-approaching-2026-ai-
//              tooling-budget/ (86% of 50 budget holders uncertain; small n,
//              hence attributed as "a DX survey of 50…" in body copy, not
//              rendered as a quotation)
// ---------------------------------------------------------------------------

const SHOT = `${SITE_NAME.toLowerCase()} · `;

export default function Bots(): JSX.Element {
  useSeo(seoFor('/bots'));

  return (
    <>
      {/* ---------- hero ---------- */}
      <Section divider="none" pad="none" className="pb-12 pt-20">
        <MonoLabel wide className="mb-[26px] text-secondary">
          Bot monitoring — free
        </MonoLabel>
        <h1 className="mb-6 max-w-[24ch] text-pretty font-display text-hero-sm font-semibold text-ink type:text-page-title">
          Your AI reviewer has an invoice. This is the receipt.
        </h1>
        <p className="max-w-[58ch] text-pretty text-lede text-ink-soft">
          Every bot comment on your repos, graded by an independent model — severity,
          category, cost and overlap. Whether the bot seat earns its keep stops being a
          feeling and becomes a number you can act on.
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

      {/* ---------- 02 · the mix ---------- */}
      <Section id="mix" tone="alt">
        <RailGrid rail={{ n: '02', word: 'The mix' }}>
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
              On the PR itself, every bot comment wears its grade — take the
              high-severity flags first, sweep the nits in one pass.
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

      {/* ---------- 03 · value for money ---------- */}
      <Section id="value">
        <RailGrid rail={{ n: '03', word: 'Value' }}>
          <div>
            <PixelIcon name="coin" className="mb-5" />
            <h2 className="mb-6 max-w-[24ch] text-pretty font-display text-h2-sm font-semibold text-ink type:text-h2">
              Cost per useful comment.
            </h2>
            <p className="mb-[18px]">
              Type each bot’s monthly price into its row and the receipt fills itself:
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

      {/* ---------- 04 · noise, located ---------- */}
      <Section id="noise" tone="alt">
        <RailGrid rail={{ n: '04', word: 'Noise' }} cols="one">
          <div>
            <PixelIcon name="noise" className="mb-5" />
            <h2 className="mb-6 max-w-[26ch] text-pretty font-display text-h2-sm font-semibold text-ink type:text-h2">
              Where the noise comes from — and where nobody’s listening.
            </h2>
            <p className="mb-9 max-w-answer">
              Noise concentrates: in a repo, in a bot, in a category. {SITE_NAME} locates
              it — including the <span className="text-ink">overlap</span> between bots
              (two vendors raising the same issue on the same code is paying twice to be
              told the same thing), the{' '}
              <span className="text-ink">bot-only reviews</span> no human ever handled —
              the clearest sign a bot needs tuning, not a bigger audience — and your{' '}
              <span className="text-ink">in-house bots</span>, which get counted like any
              vendor. Lint-wrapper or $30 seat, same receipt.
            </p>

            <div className="grid gap-grid-gutter rail:grid-cols-2">
              <ShotFrame
                src="/shots/bot-dedup.png"
                alt="Cross-bot overlap: the same issue raised by two bots on the same code."
                caption={`${SHOT}overlap`}
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

            <Story moment="Tuning day">
              The mix names the worst offender and its loudest category. You tune one
              rule, and next sprint’s chart shows whether it worked.
            </Story>
          </div>
        </RailGrid>
      </Section>

      {/* ---------- 05 · tune, don't churn ---------- */}
      <Section id="tune">
        <RailGrid rail={{ n: '05', word: 'The verdict' }}>
          <div>
            <PixelIcon name="verdict" className="mb-5" />
            <h2 className="mb-6 max-w-[24ch] text-pretty font-display text-h2-sm font-semibold text-ink type:text-h2">
              Keep, tune, or kill — calmly.
            </h2>
            <p className="mb-[18px]">
              Every bot carries a working verdict, computed from what your team actually
              did with its output — and it’s patient by design: a comment only counts
              against a bot after a 36-hour grace window, so “unhandled” means ignored,
              not merely recent. Disagree? Reclassify any bot in a click; your judgement
              wins over the detection, per workspace.
            </p>
            <p className="mb-6 text-muted">
              Coming: the opt-in, anonymised cross-org benchmark — your bots’ acted-on
              rate against teams like yours. The receipt gets a reference column.
            </p>
            <MonoLink to="/pro">Themes &amp; per-severity reports live in Pro →</MonoLink>
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
