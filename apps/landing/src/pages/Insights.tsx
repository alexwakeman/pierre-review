import { Link } from '../router';
import { useSeo } from '../lib/seo';
import { Section, SectionHeading, Shot, Eyebrow, Glow } from '../components/ui';
import { InsightsIcon, ArrowRightIcon } from '../components/icons';

const PANEL_STATS = [
  ['Open / Draft', 'currently-open and draft PRs, per repo'],
  ['Merged (7d)', 'PRs that landed in the recent window'],
  ['Stalled', 'open PRs with unresolved threads and no recent commits'],
  ['1st review', 'median hours from open to first review'],
  ['Oldest unreviewed', 'the longest-waiting PR with zero reviews'],
  ['Pending by reviewer', 'who has the most outstanding review requests'],
];

type Chart = { title: string; what: string; why: string };
const SECTIONS: { heading: string; accent: string; charts: Chart[] }[] = [
  {
    heading: 'Flow & throughput',
    accent: 'text-brand-sky',
    charts: [
      {
        title: 'PR throughput',
        what: 'Grouped weekly bars of opened, merged and closed PRs.',
        why: 'Is the team keeping pace? When merged stops tracking opened, a backlog is forming — and a rising closed-not-merged bar is churn worth a conversation.',
      },
      {
        title: 'Open backlog & stalled',
        what: 'A weekly snapshot of how many PRs were open at each week’s end, and how many were stalled.',
        why: 'Watch the backlog grow or shrink over the quarter — and see what share of it is genuinely stuck versus simply in flight.',
      },
    ],
  },
  {
    heading: 'Speed & latency',
    accent: 'text-brand-blue',
    charts: [
      {
        title: 'Time to first review',
        what: 'The weekly median hours from a PR opening to its first review.',
        why: 'The single best proxy for review responsiveness. Trending up is an early warning — before anyone files it as a complaint.',
      },
      {
        title: 'Cycle-time breakdown',
        what: 'Stacked hours per close-week: open → first review, then first review → close.',
        why: 'Shows where the time actually goes. A bottleneck in getting the first review and one in iterating after it call for completely different fixes.',
      },
      {
        title: 'Review-latency distribution',
        what: 'A histogram of PRs by first-review wait: <1h, 1–4h, 4–24h, 1–3d, >3d.',
        why: 'The shape, not just the average. A bimodal split — some reviewed instantly, some left for days — hides behind a healthy-looking median.',
      },
    ],
  },
  {
    heading: 'Review health',
    accent: 'text-brand-green',
    charts: [
      {
        title: 'Thread-resolution mix',
        what: 'A stacked area, by thread-created week, of untouched / replied / likely-addressed / resolved.',
        why: 'A rising “untouched” band means review feedback is being dropped on the floor. This is the chart that catches it early.',
      },
      {
        title: 'Review verdicts',
        what: 'Weekly stacked bars of approved, changes-requested, commented and dismissed reviews.',
        why: 'A lot of changes-requested can mean unclear specs or PRs opened too early — rework you can design out of the process.',
      },
      {
        title: 'Reviews by reviewer',
        what: 'A weekly stacked area of who submitted reviews — the top reviewers plus an “Others” roll-up.',
        why: 'Surfaces the one or two people every PR quietly routes through — your bus factor, and an early read on who’s carrying too much.',
      },
    ],
  },
  {
    heading: 'Size & risk',
    accent: 'text-brand-purpleSoft',
    charts: [
      {
        title: 'PR size distribution',
        what: 'Counts of PRs by lines-changed bucket: XS (<10), S (<50), M (<200), L (<500), XL (500+).',
        why: 'Large PRs review slower and hide more bugs. Watch the XL bucket creep — it’s a leading indicator of slowing reviews.',
      },
      {
        title: 'Median time open by size',
        what: 'The median hours-open for each size bucket.',
        why: 'Quantifies the real cost of big PRs in your repo — concrete ammunition for “let’s split this one up.”',
      },
      {
        title: 'Size vs. time open',
        what: 'A log–log scatter of every closed PR (lines changed vs hours open) with a power-law fit line.',
        why: 'Points well above the fit are PRs that took surprisingly long for their size — process friction worth a post-mortem.',
      },
    ],
  },
  {
    heading: 'Cadence',
    accent: 'text-brand-amber',
    charts: [
      {
        title: 'Activity heatmap',
        what: 'A weekday × hour (UTC) grid coloured by event volume.',
        why: 'When does the team actually work? Reveals timezone spread, working rhythm, and always-on patterns — the kind worth a conversation.',
      },
    ],
  },
];

export default function Insights(): JSX.Element {
  useSeo({
    path: '/insights',
    title: 'Insights — engineering analytics from your real PR data',
    description:
      'Per-repo engineering analytics from your synced PR data: throughput, review latency, cycle time, reviewer load and PR size — a dozen charts, and why each helps a team lead.',
  });

  // Counts derived from the data so the copy can never drift from what renders.
  const chartCount = SECTIONS.reduce((n, s) => n + s.charts.length, 0);
  const themeCount = SECTIONS.length;

  return (
    <>
      {/* hero */}
      <header className="relative overflow-hidden">
        <Glow className="absolute -top-24 left-1/2 h-96 w-[40rem] max-w-full -translate-x-1/2 rounded-full bg-brand-sky/15 blur-[130px]" />
        <Section width="default" className="pb-12 pt-16 text-center sm:pt-20">
          <div className="flex items-center justify-center gap-2">
            <InsightsIcon className="h-6 w-6 text-brand-sky" />
            <Eyebrow>Insights</Eyebrow>
          </div>
          <h1 className="mx-auto mt-3 max-w-3xl text-balance text-4xl font-bold leading-tight tracking-tight text-gray-50 sm:text-5xl">
            The questions retros are supposed to answer.
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-pretty text-lg leading-relaxed text-gray-400">
            No instrumentation, no extra pipeline — Pierre already synced your PR history. So
            where’s the time going, who’s carrying the reviews, and is it getting better or
            worse? Answer it from data you already have.
          </p>
        </Section>
      </header>

      {/* the panel */}
      <Section width="wide" className="py-10 sm:py-14">
        <div className="grid items-center gap-8 lg:grid-cols-2 lg:gap-12">
          <Shot
            src="/shots/insights-panel.png"
            alt="The Insights panel: per-repo snapshot of open, draft, merged, stalled counts, median first-review time, oldest unreviewed PR and pending reviews by reviewer."
            title="pierre · Insights"
            eager
            priority
            width={1408}
            height={1384}
          />
          <div>
            <h2 className="text-pretty text-2xl font-bold tracking-tight text-gray-50 sm:text-3xl">
              Start with the snapshot.
            </h2>
            <p className="mt-4 text-pretty leading-relaxed text-gray-400">
              Press <kbd className="rounded border border-white/15 bg-white/10 px-1.5 py-0.5 font-mono text-xs">i</kbd>{' '}
              and the Insights panel gives each repo an at-a-glance health line — the numbers
              that tell you whether to dig deeper:
            </p>
            <dl className="mt-5 grid gap-x-6 gap-y-3 sm:grid-cols-2">
              {PANEL_STATS.map(([term, def]) => (
                <div key={term}>
                  <dt className="text-sm font-semibold text-gray-200">{term}</dt>
                  <dd className="text-sm leading-snug text-gray-400">{def}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      </Section>

      {/* the deep dive */}
      <Section width="wide" className="py-10 sm:py-14">
        <SectionHeading
          eyebrow="Charts over the last 12 weeks"
          title="Then open the charts."
          lead={`A zero-dependency SVG chart toolkit renders a per-repo analytics drill-down in weekly buckets — ${chartCount} views across ${themeCount} themes, each with the decision it’s built to inform.`}
        />
        <div className="mt-10">
          <Shot
            src="/shots/analytics.png"
            alt="The repo analytics modal: throughput, backlog, review-latency, cycle-time, thread-resolution, reviewer-load, PR-size and activity-heatmap charts in weekly buckets."
            title="pierre · Analytics"
          />
        </div>

        <div className="mt-14 space-y-12">
          {SECTIONS.map((section) => (
            <div key={section.heading}>
              <h3 className={`text-sm font-semibold uppercase tracking-[0.18em] ${section.accent}`}>
                {section.heading}
              </h3>
              <div className="mt-5 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
                {section.charts.map((c) => (
                  <div
                    key={c.title}
                    className="flex flex-col rounded-2xl border border-white/10 bg-white/5 p-5"
                  >
                    <h4 className="text-base font-semibold text-gray-100">{c.title}</h4>
                    <p className="mt-2 text-sm leading-relaxed text-gray-400">{c.what}</p>
                    <p className="mt-3 border-t border-white/5 pt-3 text-sm leading-relaxed text-gray-300">
                      <span className="font-medium text-brand-skySoft">Why · </span>
                      {c.why}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </Section>

      {/* methodology */}
      <Section width="narrow" className="py-14">
        <div className="rounded-3xl border border-white/10 bg-white/[0.03] p-7 sm:p-9">
          <Eyebrow className="text-brand-green">On the numbers</Eyebrow>
          <h2 className="mt-3 text-xl font-bold tracking-tight text-gray-50 sm:text-2xl">
            No sampling, no projections.
          </h2>
          <p className="mt-4 text-pretty leading-relaxed text-gray-400">
            Every figure is derived from the same synced PR data that drives the board —
            nothing is sampled, projected or massaged. Charts bucket by ISO week over a
            rolling 12-week window. Where a metric leans on a heuristic — the “likely
            addressed” thread state, for instance — it’s labelled as one, so you can read the
            trend without mistaking it for ground truth.
          </p>
          <p className="mt-3 text-sm text-gray-500">
            These are mirrors, not scorecards. The point is to start better conversations,
            not to rank people.
          </p>
        </div>
      </Section>

      {/* next */}
      <Section width="narrow" className="py-16 text-center">
        <h2 className="text-pretty text-2xl font-bold tracking-tight text-gray-50 sm:text-3xl">
          Reviews are where the time goes. Make them count.
        </h2>
        <Link
          to="/reviews"
          className="group mt-7 inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-5 py-3 text-sm font-semibold text-gray-100 transition hover:bg-white/10"
        >
          See Claude Review
          <ArrowRightIcon className="h-4 w-4 transition group-hover:translate-x-0.5" />
        </Link>
      </Section>
    </>
  );
}
