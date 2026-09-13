import { useSeo } from '../lib/seo';
import { seoFor } from '../lib/routes';
import { INSTALL_COMMAND, SITE_NAME } from '../lib/site';
import {
  DashItem,
  InkButton,
  MonoLabel,
  RailGrid,
  Section,
  Story,
  UnderlineLink,
} from '../components/feint/primitives';
import { FeatureShot } from '../components/feint/FeatureShot';
import { ShotFrame } from '../components/feint/ShotFrame';
import { TierTable } from '../components/feint/TierTable';

// ---------------------------------------------------------------------------
// For engineering managers — one of the site's two role pages.
//
// SAME SHAPE AS /for-developers: the free tier in full first, then what Pro
// adds, then the comparison table and the sign-up. The order is the argument —
// this product's free tier is genuinely used every day, and a page that leads
// with the paid one asks for a decision the reader has no basis for yet.
//
// ⚠ WITHIN EACH HALF, THE HUMAN WORK COMES FIRST AND AUTOMATION IS A PEER.
// An earlier cut ran flow metrics → repositories → bots → bot ROI → benchmark →
// period report → chronology, which put three bot sections at the centre of the
// page and left the reporting — the thing most managers actually arrive
// wanting — reading like an afterthought at the end. The running order is now:
//
//   FREE  02 flow metrics · 03 per repository · 04 reach · 05 your bots
//   PRO   06 period report · 07 chronology · 08 bot ROI · 09 benchmark
//
// Three human sections then one on automation, twice. If a future edit floats a
// bot section back above the human ones, it is re-making a decision that was
// taken deliberately: the bots are half the product, not the pitch.
//
// ⚠ THE REFUSALS ARE ALSO THE POSITIONING, not a disclaimer bolted on the end.
// The argument against this category is that its tools assert things they cannot
// back — a directory called a bottleneck, a percentile with no cohort, a
// developer scorecard. So several sections name what the product REFUSES to say,
// and those sentences must not be cut for being downbeat. They are the reason a
// manager would believe the rest of it.
// ---------------------------------------------------------------------------

const ASKS = [
  'Where is the work actually happening across the repositories I own?',
  'What is stuck right now, and is it stuck on a reviewer or on the author?',
  'How much of the review load is people, and how much is automation?',
  'Which of the bots we pay for is earning its seat?',
  'What do I put in front of a director on Friday without writing it by hand?',
];

export default function ForManagers(): JSX.Element {
  useSeo(seoFor('/for-managers'));

  return (
    <>
      {/* ---------- hero ---------- */}
      <header className="px-gutter pt-hero-y">
        <MonoLabel wide className="mb-[26px] text-secondary">
          For engineering managers
        </MonoLabel>
        <h1 className="mb-7 max-w-[20ch] text-pretty font-display text-hero-sm font-semibold text-ink type:text-hero">
          Six repositories, one answer.
        </h1>
        <p className="mb-[34px] max-w-lede text-pretty text-lede text-ink-soft">
          {SITE_NAME} lights up what a fortnight of work across every repository you own
          actually came to — where it happened, how long it waited, and who was holding it —
          and then what the review bots layered on top cost and returned. It shows what the
          data can carry and refuses the rest, which is most of what this category sells.
        </p>
        <div className="mb-4 flex flex-wrap items-center gap-3.5">
          <InkButton to="/api/auth/login">Sign in with GitHub</InkButton>
          <UnderlineLink to="/for-developers">If you write the code →</UnderlineLink>
        </div>
        <p className="mb-11 max-w-reassure font-mono text-mono-nav text-secondary">
          Sections 02 to 05 are free on every tier. Run the whole free product on your own
          machine with <span className="text-ink">{INSTALL_COMMAND}</span>.
        </p>
      </header>

      {/* ---------- 01 · the questions ---------- */}
      <Section divider="ink">
        <RailGrid rail={{ n: '01', word: 'The questions' }}>
          <div className="rail:col-span-2">
            <h2 className="mb-[30px] max-w-[30ch] text-pretty font-display text-h2-sm font-semibold text-ink type:text-h2-major">
              Five questions, and one place that answers them.
            </h2>
            <div className="grid gap-grid-gutter rail:grid-cols-2">
              <div>
                <p className="mb-6">
                  Where is the effort going, what is stuck, how long are people waiting.
                  Answering those across a set of repositories means counting the same things
                  the same way in each of them — and then separating what people did from what
                  automation did, because agents now author a real share of the pull requests
                  and several vendors comment on every one.
                </p>
                <p>
                  The questions beside this are the ones actually asked in a staff meeting.{' '}
                  {SITE_NAME} answers each with a stated population and a stated window, or
                  says why it cannot.
                </p>
              </div>
              <div>
                <ul className="flex flex-col gap-3.5">
                  {ASKS.map((a) => (
                    <DashItem key={a}>{a}</DashItem>
                  ))}
                </ul>
                <Story moment="Never">
                  a developer leaderboard. There is no such screen in the product.
                </Story>
              </div>
            </div>
          </div>
        </RailGrid>
      </Section>

      {/* ---------- 02 · free metrics ---------- */}
      <FeatureShot
        rail={{ n: '02', word: 'Free' }}
        tone="alt"
        heading="The state of play, at no charge."
        src="/shots/flow-metrics.png"
        alt="Workspace flow metrics — throughput, lead time, time to a first human review and merge-time build health — with people counted apart from automation, above per-repository activity rows"
        caption="limn · flow metrics"
        height={640}
      >
        <p className="mb-6">
          Throughput, lead time, time to a first human review and merge-time build health for
          the whole workspace — with people counted apart from automation, because a blended
          median describes no pull request anyone wrote.
        </p>
        <p className="mb-6">
          Time to a first human review is the number most worth holding. It is the part of
          the wait that is entirely yours to spend, it sits ahead of everything else in the
          queue, and no bot approval is allowed to count towards it.
        </p>
        <p>
          A repository added part-way through a window is marked rather than pro-rated, and
          where a pull request&rsquo;s size was never observed it says &ldquo;size
          unknown&rdquo; rather than counting it as zero.
        </p>
        <Story moment="Free, on every tier">
          this whole section, and the two that follow it.
        </Story>
      </FeatureShot>

      {/* ---------- 03 · repo rows ---------- */}
      <FeatureShot
        rail={{ n: '03', word: 'Per repository' }}
        heading="Which repository is carrying the fortnight."
        src="/shots/repo-rows.png"
        alt="Where the work is happening: pull requests opened per repository with people stacked separately from automation, beside lines changed per repository"
        caption="limn · repository activity"
        height={560}
        fit="contain"
      >
        <p className="mb-6">
          Two columns, two scales, two origins. A bar&rsquo;s length is a ratio within its own
          column and never a number you can read across — the two measures are counted in
          different units, and putting them on one axis would invent a comparison.
        </p>
        <p className="mb-6">
          Pull requests opened splits people from automation in the bar itself, so you can see
          which repositories the agents are working in without doing arithmetic.
        </p>
        <p>
          The repository name is written out in full and wraps. The rotated, truncated axis
          label it replaced rendered six of seven real repositories as
          &ldquo;&hellip;tric-backend&rdquo;.
        </p>
      </FeatureShot>

      {/* ---------- 04 · reach ----------
          A narrow crop, so this one keeps the two-column rail rather than going
          full width — the frame would be mostly gutter otherwise. */}
      <Section tone="alt">
        <RailGrid rail={{ n: '04', word: 'Reach' }}>
          <div>
            <h2 className="mb-6 max-w-[26ch] text-pretty font-display text-h2-sm font-semibold text-ink type:text-h2">
              And how much of it could break something.
            </h2>
            <p className="mb-6 max-w-[58ch] text-pretty">
              The open pull requests in each repository, split by how far a change could reach
              — worked out from what the diff touches: migrations, schemas, interface
              definitions, infrastructure, and whether files that usually move together are
              missing from it.
            </p>
            <p className="max-w-[58ch] text-pretty">
              It is a snapshot of right now rather than a window, and it says so. Drafts are
              included, and the draft count is disclosed, because the tile above it excludes
              them and two numbers that disagree need to explain themselves.
            </p>
          </div>
          <ShotFrame
            src="/shots/reach.png"
            alt="Reach by repository: open pull requests per repository split into low, medium and high reach, with two repositories reporting no reading rather than a zero"
            caption="limn · reach"
            height={420}
            fit="contain"
            strong
            note="Two repositories report no reading rather than a zero. The co-change index only exists where the history supports one, and a zero there would read as a clean bill of health."
          />
        </RailGrid>
      </Section>

      {/* ---------- 05 · bots, the free half ---------- */}
      <FeatureShot
        rail={{ n: '05', word: 'Your bots' }}
        heading="Find every bot. Name it. Price it. Free."
        src="/shots/bot-settings.png"
        alt="The bot settings table: every detected automated account with its vendor, its role, the confidence behind the call and the monthly price you typed in"
        caption="limn · bot settings"
        height={600}
      >
        <p className="mb-6">
          {SITE_NAME} detects every automated account touching your repositories and separates
          the review vendors from the dependency bumps, the quality gates, the release
          automation and the agents that write code — and lets you correct any of it by hand,
          with your judgement winning in both directions.
        </p>
        <p className="mb-6">
          That split is what makes the human numbers above trustworthy. A merged dependency
          bump and a merged feature are both &ldquo;a merge&rdquo; until something tells them
          apart, and on real data the bumps alone dragged a reported median pull-request size
          from 142 lines to 68.
        </p>
        <p>
          Type in what each one costs a month and the figure is stored per workspace. The
          grade on every bot comment is free too — a purpose-trained ModernBERT classifier,
          served as int8 ONNX on ordinary CPU, which — graded blind against a human expert —
          picked the same severity seven times in ten, where the vendor&rsquo;s own badge
          managed fewer than five. The ruler is never the paid part.
        </p>
      </FeatureShot>

      {/* ---------- 06 · Pro: the period report ---------- */}
      <FeatureShot
        rail={{ n: '06', word: 'Pro' }}
        tone="alt"
        divider="ink"
        label="Pro · $25 per user"
        heading="A report per sprint, that you can forward."
        src="/shots/period-report.png"
        alt="A stored sprint report: the effort-versus-automation split, the biggest movers, and fifteen metrics each with this period, the prior period, the change and a forecast column"
        caption="limn · period report"
        height={680}
      >
        <p className="mb-6">
          A stored artifact for each completed sprint or calendar month — fifteen metrics, a
          like-for-like comparison against the previous period, the biggest movers, and a
          short written summary. Every event in it is timestamped inside the window at both
          ends, so the document stays reproducible after you send it.
        </p>
        <p className="mb-6">
          The comparison is recomputed over the repositories tracked in <em>both</em> periods
          and says so on the row. Otherwise the delta would be measuring which repositories
          you onboarded rather than what the team did — and the headline figure and the change
          would be two different populations wearing one number.
        </p>
        <p>
          The forecast refuses at calendar-month grain outright, because months run 28 to 31
          days and a trend line fitted through them reads February as a dip every year.
        </p>
      </FeatureShot>

      {/* ---------- 07 · Pro: chronology ---------- */}
      <FeatureShot
        rail={{ n: '07', word: 'Pro' }}
        heading="Where the waiting happens — without naming anyone."
        src="/shots/chronology.png"
        alt="The Chronology panel: reviewer, author and landing courts with their share and their magnitude, plus the per-repository rows underneath"
        caption="limn · chronology"
        height={620}
        note="Sixty-six merged pull requests a person actually worked on. The never-human-touched population is reported on its own, never blended in."
      >
        <p className="mb-6">
          Every hour a pull request was open belongs to somebody: a reviewer who has not
          looked, an author who owes a response, or nobody — approved and waiting to land.
          Chronology attributes all of them and reports the split per repository.
        </p>
        <p className="mb-6">
          A bot action never moves the ball, and pull requests no person ever touched are
          excluded and reported separately — on real data that is 46% of merges, and folding
          them in would report a reviewer problem that is an automation fact. It speaks up
          only when a court is both lopsided <em>and</em> slow, because a share without a
          magnitude invents a crisis in a healthy repository.
        </p>
        <p>
          No person is named anywhere in it, and the server sends no actor ids at all — that
          is structural, not a setting. The People report, for one-to-ones, is the opposite by
          design: you pick who, the sections are alphabetical, and there is no ranking and no
          comparison table in it.
        </p>
      </FeatureShot>

      {/* ---------- 08 · Pro: the bot scoreboard ---------- */}
      <FeatureShot
        rail={{ n: '08', word: 'Pro' }}
        tone="alt"
        heading="What the bots cost, and what they returned."
        src="/shots/bot-roi.png"
        alt="The bot ROI panel: six review vendors with thread volume, acted-on rate, overdue counts, time to address and keep or tune verdicts, above charts of weekly volume, effectiveness and severity inflation"
        caption="limn · bot roi"
        height={660}
      >
        <p className="mb-6">
          A keep, tune or noisy verdict per vendor, built from how much of what it said your
          team acted on — and dollars per acted-on comment, divided by one stated calendar
          month at both ends, with both halves of the division printed on the card.
        </p>
        <p className="mb-6">
          Beside it, over-calling as a weekly line: how often a vendor badged something major
          that our model read as minor. A bot that badges nothing is named and omitted rather
          than drawn as a zero.
        </p>
        <p>
          It refuses where it should. A repository younger than the window, a reviewer with
          nothing acted on, or fewer than ten acted-on comments each withhold the per-comment
          figure on their own, while the honest counts still render.
        </p>
        <Story moment="The receipt">
          488 bot threads in a fortnight, 62% acted on, six vendors, one of them worth
          dropping.
        </Story>
      </FeatureShot>

      {/* ---------- 09 · Pro: the benchmark ---------- */}
      <FeatureShot
        rail={{ n: '09', word: 'Pro' }}
        heading="And how that compares to everyone else."
        src="/shots/benchmark.png"
        alt="The peer benchmark panel placing each vendor against a cohort of repositories, with per-metric percentiles carrying their cohort size and written refusals where the cohort is too thin"
        caption="limn · benchmark"
        height={620}
      >
        <p className="mb-6">
          Your vendors placed against a cohort of 2,204 repositories, banded by how busy a
          repository is, so a quiet service is not compared against a monorepo. Every
          percentile carries the number of repositories behind it and which band it sat in.
        </p>
        <p>
          Where the cohort is too thin to answer, it says so in words — there are fourteen
          distinct refusal sentences in this panel, and they are the feature. A percentile
          drawn from four repositories is a number that will move on its own next month.
        </p>
      </FeatureShot>

      <TierTable />
    </>
  );
}
