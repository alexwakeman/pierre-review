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
import { FeatureShot } from '../components/feint/FeatureShot';
import { VideoFrame, type VideoCue } from '../components/feint/VideoFrame';
// The clip's chapters, imported from the capture pipeline's own output rather than
// retyped here — the file beside the .mp4 IS the source, so the words on the page
// cannot drift out of step with the frames they describe. It is ~1.2 kB.
import walkthroughCues from '../../public/demo/limn-walkthrough.cues.json';
import { Sprite } from '../components/feint/Sprite';
import { Rain } from '../components/feint/Rain';
import { TierTable } from '../components/feint/TierTable';

// ---------------------------------------------------------------------------
// The home page.
//
// ITS ONE JOB IS THE SPLIT. The site is three pages: this one, and one for each
// of the two readers. So the home page makes the general argument once, shows
// three screens that prove it, and hands the reader to their own page. It is not
// a feature tour; that is what it used to be, across five pages, and the result
// was that neither reader found the half addressed to them.
//
// ⚠ THE BALANCE IS THE POSITIONING, AND IT WAS WRONG. Every version of this site
// so far led with review bots — the old tagline was literally "the calm layer
// above your review bot". That is one half of the product described as if it
// were the whole, and it narrows the audience to teams who already feel they
// have a bot problem. The larger, plainer truth is that a team working across
// eight repositories cannot see any of it, bots or no bots.
//
// So the running order is: the MULTI-REPO problem, the board that answers it,
// the week's numbers, and THEN the bots as a peer section — not as the climax.
// Two general sections to one on automation, in that order, on every page. If a
// future edit floats a bot section back above the human ones, it is re-making a
// decision that was taken deliberately.
// ---------------------------------------------------------------------------

const WORKS_WITH = ['CodeRabbit', 'Greptile', 'Copilot', 'Cursor', 'Qodo', 'Devin'];

const CUES: readonly VideoCue[] = walkthroughCues;

// Measured, sourced, and ordered so the HUMAN cost leads: more pull requests,
// waiting longer. The bot numbers follow rather than open. Everything here traces
// to the sources line under it; the unverifiable numbers were culled.
const STATS: { n: string; d: string }[] = [
  { n: '98%', d: 'more PRs merged since AI-assisted coding took hold' },
  { n: '+91%', d: 'longer those PRs now spend waiting in review' },
  { n: '6.9/10', d: 'the measured relevance of the average bot review comment' },
  { n: '5', d: 'vendors claiming #1 on the same code-review benchmark' },
];

const DEV_POINTS = [
  'One ranked queue across every repository — a red build, an unanswered review, a stale thread, a conflict.',
  'Ordered by how close each job is to finished, how long it has sat, and how directly it is tied to you.',
  'And the top of it is finishable in place — reply, approve, merge, clear the conflict, without a tab.',
];

const EM_POINTS = [
  'Throughput, lead time and reach per repository, with people counted apart from automation. Free.',
  'A forwardable report per sprint, and an hour-by-hour account of who was holding each pull request.',
  'And a keep / tune / noisy verdict on every review bot you pay for, priced per comment your team used.',
];

export default function Home(): JSX.Element {
  useSeo(seoFor('/'));

  return (
    <>
      {/* ---------- hero ---------- */}
      {/* `relative overflow-hidden` confines <Rain/>: the drops are a child of
          this header and clipped by it. The grid children take `relative z-10`
          so the copy sits above the canvas. */}
      <header className="relative grid gap-16 overflow-hidden px-gutter pt-hero-y rail:grid-cols-hero">
        <Rain />

        <div className="relative z-10">
          <Sprite name="group" cell={4} fill="#16161A" accent="#C13A20" className="mb-7" />
          <MonoLabel wide className="mb-[26px] text-secondary">
            The multi-repo review layer
          </MonoLabel>

          <h1 className="mb-7 max-w-[22ch] text-pretty font-display text-hero-sm font-semibold text-ink type:text-hero">
            Every repository, one board.
          </h1>

          <p className="mb-[34px] max-w-lede text-pretty text-lede text-ink-soft">
            {/* ⚠ The space before {SITE_NAME} is explicit. JSX strips whitespace at the
                start and end of a line, so a bare newline between the full stop and the
                expression renders as "automation.Limn". */}
            Your work spans repositories, people and a growing stack of review automation.{' '}
            {SITE_NAME} lights all of it on one board — whose turn it is, what is stalled,
            what is ready to land — and measures what the AI review bots on top are actually
            worth. Free, open core, and it runs on your machine.
          </p>

          <div className="mb-4 flex flex-wrap items-center gap-3.5">
            <InkButton to="/api/auth/login">Sign in with GitHub</InkButton>
            <UnderlineLink to="/for-developers">See it for developers</UnderlineLink>
          </div>

          <p className="mb-11 max-w-reassure font-mono text-mono-nav text-secondary">
            Or run it entirely on your machine — local mode uses your gh login and keeps no
            stored credentials.
          </p>
        </div>

        {/* The vendor rail. Below the `rail` breakpoint it becomes a wrapped mono
            row under the reassurance line — no logos, no chips. It is a
            COMPATIBILITY statement, not the pitch: it says the bots you already run
            are understood, which is why it sits in the margin rather than in the
            headline it used to occupy. */}
        <div className="relative z-10 rail:border-l rail:border-rule rail:pl-6 rail:pt-2">
          <MonoLabel className="mb-4 text-secondary">Also reads</MonoLabel>
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

      {/* ---------- the walkthrough ---------- */}
      {/* ⚠ THE ONE PIECE OF THE SITE THAT PLAYS BY ITSELF, and the reason
          `VideoFrame` carries a reduced-motion check of its own: the CSS blanket
          in index.css reaches neither a canvas nor a <video>. Silent, once
          through, poster-backed, and it renders as the poster plus every chapter
          in words for anyone who has asked their system for less motion. Same
          obligation the hero rain carries.

          It LEADS, because it is the strongest thing on the page: six real
          screens in under half a minute, which no amount of copy replaces. It
          sits UNDER the headline rather than inside the header grid — the header
          is a two-column rail whose right column is the vendor list, and a clip
          in either column would render at half width, the same defect
          `FeatureShot` exists to fix for the stills. */}
      <Section pad="none" className="pb-14 pt-4">
        <VideoFrame
          src="/demo/limn-walkthrough.mp4"
          poster="/demo/limn-walkthrough-poster.jpg"
          alt="A screen recording moving through six screens: the activity feed, the timeline, one pull request, the addressed check on a bot thread, the bot ROI table, and the period report"
          caption={`${SITE_NAME.toLowerCase()} · the walkthrough`}
          meta="28 seconds · no sound"
          width={1770}
          height={996}
          cues={CUES}
        />
        <p className="mt-[18px] max-w-caption text-list text-muted">
          A seeded eight-repository workspace, so the names and the numbers are invented. The
          software is not.
        </p>
      </Section>

      {/* ---------- the numbers ---------- */}
      <Section divider="ink" pad="none" className="py-14">
        <RailGrid rail={{ word: 'The numbers' }} cols="one">
          <div>
            <h2 className="mb-10 max-w-[30ch] text-pretty font-display text-h2-sm font-semibold text-ink type:text-h2">
              More is shipping. It is waiting longer. And everyone claims first place.
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
              the vendors&rsquo; own blogs, 2026.
            </p>
          </div>
        </RailGrid>
      </Section>

      {/* ---------- why ---------- */}
      <Section pad="none" className="py-14">
        <RailGrid rail={{ word: `Why ${SITE_NAME}` }} cols="one">
          <div>
            <h2 className="mb-6 max-w-[26ch] text-pretty font-display text-h2-sm font-semibold text-ink type:text-h2">
              Built for the engineers keeping up.
            </h2>
            <p className="mb-6 max-w-[62ch] text-pretty text-lede">
              A review loop runs across whatever shape your code is in — one repository or
              twenty, a monorepo or a fleet of services. What changed is the volume moving
              through it. AI multiplied both halves at once: more pull requests, and far more
              commentary on each one.
            </p>
            <p className="mb-6 max-w-answer font-serif text-pull-quote italic text-ink">
              The pace isn&rsquo;t coming back down. So the tools have to come up.
            </p>
            <p className="mb-6 max-w-[62ch] text-pretty">
              To limn something is to bring it into enough light to see its shape — the word
              comes down from the Latin for <em>illuminate</em>. That is the whole idea:
              complexity you can see is complexity you can manage. The churn stays out there;
              you get the calm layer above it.
            </p>
            <p className="max-w-[62ch] text-pretty">
              Which cuts both ways, and that is the part worth holding onto. A light shows you
              what is actually there. It does not invent what is not — so where the data will
              not carry a claim, {SITE_NAME} says so in words instead of filling the gap with
              a number.
            </p>
          </div>
        </RailGrid>
      </Section>

      {/* ---------- the split — the page's actual job ---------- */}
      <Section divider="ink" tone="alt">
        <RailGrid rail={{ n: '01', word: 'For you' }}>
          <div>
            <h3 className="mb-[18px] font-display text-h3 font-semibold text-ink">
              If you write the code
            </h3>
            <p className="mb-6 max-w-[52ch] text-pretty">
              Your day arrives out of order: a build to fix here, a review to answer there,
              six bot comments on the one you thought was done, a conflict that appeared
              overnight. {SITE_NAME} ranks all of it across every repository and puts the
              next thing at the top.
            </p>
            <ul className="mb-8 flex flex-col gap-3.5">
              {DEV_POINTS.map((p) => (
                <DashItem key={p}>{p}</DashItem>
              ))}
            </ul>
            <MonoLink to="/for-developers">For developers →</MonoLink>
          </div>

          <div>
            <h3 className="mb-[18px] font-display text-h3 font-semibold text-ink">
              If you run the team
            </h3>
            <p className="mb-6 max-w-[52ch] text-pretty">
              Where the effort went, how long it waited, and what the review automation cost
              — counted the same way in every repository. {SITE_NAME} measures the whole loop
              on your own data, and refuses the questions that data will not support.
            </p>
            <ul className="mb-8 flex flex-col gap-3.5">
              {EM_POINTS.map((p) => (
                <DashItem key={p}>{p}</DashItem>
              ))}
            </ul>
            <MonoLink to="/for-managers">For engineering managers →</MonoLink>
          </div>
        </RailGrid>
      </Section>

      {/* ---------- 02 · the board (human work) ---------- */}
      {/* ⚠ THE RANKING RULES ARE THE COPY HERE, AND THAT IS DELIBERATE. Pending was
          cut from the walkthrough because a still board is an unremarkable list of
          rows; what makes it worth having is WHY the rows are in that order. So the
          arithmetic is stated here in words, and every figure in it is real — see
          `apps/backend/src/db/work-plan.ts`. If a future edit softens this into
          "intelligently ranked", it has thrown away the only part a reader can check. */}
      <FeatureShot
        rail={{ n: '02', word: 'The board' }}
        heading="Everything waiting, in one list."
        src="/shots/pending-board.png"
        alt="The Pending board across four repositories: ready-to-merge, your-turn and in-your-repos cards with their CI state, reach chips and merge actions"
        caption="limn · pending"
        height={640}
      >
        <p className="mb-6">
          Review requests, threads somebody answered, red builds, conflicts you can fix —
          across every repository in the workspace, ranked, with the actions on the same row.
          A card exists only while you still owe something; there is nothing to dismiss.
        </p>
        <p className="mb-6">
          The order is arithmetic, and you can check it. Three numbers are added up for every
          job: how few steps it is from landing (half the weight), how long it has sat (three
          tenths &mdash; four days scores that part in full, one day scores a fraction of it),
          and whether your name is on it, you maintain the repository, or neither (the last
          fifth). Conflicts and three or more unanswered threads push a job down; a
          change of three files or fewer pulls it up. Equal scores break on age, so the same data always
          comes back in the same order.
        </p>
        <p className="mb-6">
          An approved pull request that can land sits at the top. The same one with nobody&rsquo;s
          approval on it ranks <em>below</em> an ordinary review request &mdash; deliberately,
          and after measuring: ranked the other way round, the head of the board filled with
          unreviewed dependency bumps.
        </p>
        <p>
          No model decides any of that, nothing is learned, and nothing about how you work is
          stored. Free on every tier, the ranking included &mdash; only the written reason on
          each row is Pro.
        </p>
      </FeatureShot>

      {/* ---------- 03 · the week (human work, one grain up) ---------- */}
      <FeatureShot
        rail={{ n: '03', word: 'The week' }}
        tone="alt"
        heading="How the work actually moved."
        src="/shots/flow-metrics.png"
        alt="Workspace flow metrics: throughput, lead time, time to a first human review and merge-time build health, with people counted apart from automation, above per-repository activity rows"
        caption="limn · flow metrics"
        height={640}
      >
        <p className="mb-6">
          Throughput, lead time, and how long a pull request waited for its first human
          review — across every repository at once, with people counted apart from
          automation, because a blended median describes no pull request anyone wrote.
        </p>
        <p>
          Free on every tier. Pro turns the same numbers into a stored report per sprint you
          can forward, and an hour-by-hour account of whether the waiting sat with a reviewer
          or with the author — with nobody named.
        </p>
      </FeatureShot>

      {/* ---------- 04 · the bots (the peer section, not the climax) ---------- */}
      <FeatureShot
        rail={{ n: '04', word: 'The bots' }}
        heading="And the automation stacked on top of it."
        src="/shots/bot-roi.png"
        alt="The bot ROI panel: six review vendors with volume, acted-on rate, overdue threads and keep or tune verdicts, above charts of weekly volume, effectiveness and severity inflation"
        caption="limn · bot roi"
        height={660}
      >
        <p className="mb-6">
          A team can be running two to six review vendors at once, and none of them reports
          on itself. {SITE_NAME} grades every bot comment independently, with a
          purpose-trained classifier that, graded blind against a human expert, picked the
          same severity seven times in ten — where the vendors&rsquo; own badges managed fewer
          than five. Free, on every tier.
        </p>
        <p>
          Pro turns those grades into a scoreboard: how much of what each vendor said your
          team acted on, what that came to per comment, how often it called something major
          that was not — and where all of it sits against a cohort of 2,204 repositories.
        </p>
      </FeatureShot>

      {/* ---------- 05 · local ---------- */}
      <Section tone="alt">
        <RailGrid rail={{ n: '05', word: 'Local' }} cols="one">
          <div>
            <h2 className="mb-6 max-w-[28ch] text-pretty font-display text-h2-sm font-semibold text-ink type:text-h2">
              Or run the whole thing on your own machine.
            </h2>
            <p className="mb-6 max-w-[62ch] text-pretty">
              One command, your existing <span className="text-ink">gh</span> login, a SQLite
              file on your disk. No hosted backend, no stored credentials, nothing leaving the
              machine. The free tier is identical either way, and the conflict resolver only
              exists in this mode.
            </p>
            <p className="max-w-[62ch] font-mono text-mono-row text-ink">{INSTALL_COMMAND}</p>
          </div>
        </RailGrid>
      </Section>

      <TierTable />
    </>
  );
}
