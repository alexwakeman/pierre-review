import type { ReactNode } from 'react';
import { Link } from '../router';
import { useSeo } from '../lib/seo';
import { Section, SectionHeading, Shot, Eyebrow, Pill, Glow } from '../components/ui';
import { SparkleIcon, RouteIcon, BoltIcon, LockIcon, ArrowRightIcon } from '../components/icons';

const SEVERITIES = [
  { label: 'blocker', cls: 'bg-brand-red/15 text-red-300 ring-brand-red/30' },
  { label: 'warning', cls: 'bg-brand-amber/15 text-amber-200 ring-brand-amber/30' },
  { label: 'nit', cls: 'bg-brand-blue/15 text-blue-200 ring-brand-blue/30' },
  { label: 'question', cls: 'bg-brand-purple/15 text-brand-purpleSoft ring-brand-purple/30' },
  { label: 'praise', cls: 'bg-brand-green/15 text-green-200 ring-brand-green/30' },
];

const FLOW = [
  {
    n: '01',
    title: 'Route',
    body: 'Before a token is spent, a pure diff-metrics gate picks the mode: skip a no-op diff, send a small one down the fast path, or earn a full checkout for a big one. The decision and its inputs are recorded on the run.',
  },
  {
    n: '02',
    title: 'Review',
    body: 'A deep run gets read-only Read/Grep/Glob/Bash (never Write or push); a quick run is tool-less. Either way the Claude Agent SDK returns structured findings through an in-process tool — each with a path, line, severity and an optional suggested fix.',
  },
  {
    n: '03',
    title: 'Curate',
    body: 'Claude’s output is reference-only. You write your own review in your own words, tick exactly which findings to include, and reword any that need it.',
  },
  {
    n: '04',
    title: 'Post once',
    body: 'Pierre assembles a single GitHub review — your body, your verdict, your chosen findings as inline comments — pinned to the head SHA so it can’t land on stale code.',
  },
];

function Card({
  icon: Icon,
  accent,
  badge,
  badgeCls,
  title,
  children,
}: {
  icon: (p: { className?: string }) => ReactNode;
  accent: string;
  badge: string;
  badgeCls: string;
  title: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="flex flex-col rounded-3xl border border-white/10 bg-white/[0.03] p-7">
      <div className="flex items-center justify-between">
        <Icon className={`h-7 w-7 ${accent}`} />
        <Pill className={badgeCls}>{badge}</Pill>
      </div>
      <h3 className="mt-4 text-xl font-bold tracking-tight text-gray-50">{title}</h3>
      <div className="mt-3 space-y-3 text-sm leading-relaxed text-gray-400">{children}</div>
    </div>
  );
}

export default function Reviews(): JSX.Element {
  useSeo({
    path: '/reviews',
    title: 'Claude Review — persistent, agentic PR reviews',
    description:
      'Persistent, agentic PR reviews from the Claude Agent SDK — structured, line-anchored findings saved per commit. A router picks a fast or deep pass; you post one review.',
  });

  return (
    <>
      {/* hero */}
      <header className="relative overflow-hidden">
        <Glow className="absolute -top-24 left-1/2 h-96 w-[40rem] max-w-full -translate-x-1/2 rounded-full bg-brand-purple/20 blur-[130px]" />
        <Section width="default" className="pb-12 pt-16 text-center sm:pt-20">
          <div className="flex items-center justify-center gap-2">
            <SparkleIcon className="h-6 w-6 text-brand-purpleSoft" />
            <Eyebrow className="text-brand-purpleSoft">Claude Review</Eyebrow>
          </div>
          <h1 className="mx-auto mt-3 max-w-3xl text-balance text-4xl font-bold leading-tight tracking-tight text-gray-50 sm:text-5xl">
            The AI review that’s still there next week.
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-pretty text-lg leading-relaxed text-gray-400">
            Most AI code review happens in a chat tab — useful in the moment, gone the moment
            you close it. Pierre runs the review against the PR, structures the output, and{' '}
            <span className="font-medium text-gray-200">saves it per commit</span>, so it’s a
            durable artifact attached to the work — not a conversation you have to remember to
            screenshot.
          </p>
          <div className="mt-7 flex flex-wrap items-center justify-center gap-2">
            <Pill className="bg-brand-purple/15 text-brand-purpleSoft ring-brand-purple/30">
              Local-only
            </Pill>
            <Pill className="bg-white/5 text-gray-300 ring-white/10">Opt-in · off by default</Pill>
            <Pill className="bg-white/5 text-gray-300 ring-white/10">You post the review, not the bot</Pill>
          </div>
        </Section>

        <Section width="wide" className="pb-6 pt-6">
          <Shot
            src="/shots/claude-review.png"
            alt="The Claude Review tab: a structured review with severity-tagged, line-anchored findings, a routing badge, and a separate “your review” composer that posts to GitHub."
            title="pierre · Claude Review"
            eager
            priority
            width={3200}
            height={1840}
          />
        </Section>
      </header>

      {/* why it matters for AI teams */}
      <Section width="narrow" className="py-20 sm:py-24">
        <Eyebrow className="text-brand-purpleSoft">The shift</Eyebrow>
        <h2 className="mt-3 text-pretty text-3xl font-bold tracking-tight text-gray-50 sm:text-4xl">
          When AI writes more of the code, review becomes the job.
        </h2>
        <div className="mt-6 space-y-4 text-pretty text-base leading-relaxed text-gray-400 sm:text-lg">
          <p>
            High-throughput AI-assisted teams have quietly inverted the old ratio. Generating
            a change is cheap; <span className="font-medium text-gray-200">understanding and
            vouching for it</span> is the expensive part — and it lands squarely on human
            reviewers who are now seeing more PRs, more often, than ever.
          </p>
          <p>
            A second model in the loop is the obvious lever, but most AI review lives in
            ephemeral chats: ungoverned, unattributable, and gone the moment the tab closes.
            Pierre treats a review as what it is — a record. Each run is persisted, anchored
            to lines, tied to a specific commit, and kept in history when you re-review — so
            you can pull up the review you got on any past commit, not just the latest. The
            judgement that ships is still a human’s; the AI is a fast second pass that catches
            the obvious things before a human spends attention on them.
          </p>
        </div>
      </Section>

      {/* deep vs quick */}
      <section className="relative border-y border-white/5 bg-white/[0.02] py-20 sm:py-24">
        <Section width="wide">
          <SectionHeading
            eyebrow="Deep vs quick"
            eyebrowClass="text-brand-purpleSoft"
            title="A router decides how hard to look."
            lead="Not every diff deserves a full repository checkout — and a one-line lockfile bump deserves none. A deterministic gate reads the diff’s shape and routes the run before the agent starts, so cost tracks complexity."
          />
          <div className="mt-12 grid gap-6 lg:grid-cols-2">
            <Card
              icon={BoltIcon}
              accent="text-brand-sky"
              badge="quick · diff-only"
              badgeCls="bg-brand-sky/10 text-brand-skySoft ring-brand-sky/30"
              title="Fast path, no clone"
            >
              <p>
                For small, contained changes — within{' '}
                <span className="font-mono text-gray-300">≤5 files</span>,{' '}
                <span className="font-mono text-gray-300">≤150 lines</span>,{' '}
                <span className="font-mono text-gray-300">≤2 directories</span>, a single
                subsystem, and touching no exported contract — the full diff is inlined into
                the prompt. No checkout, a tight turn cap, seconds to finish.
              </p>
              <p>
                Ideal for the localised fix, the style pass, the small refactor where the diff{' '}
                <em>is</em> the context.
              </p>
            </Card>
            <Card
              icon={RouteIcon}
              accent="text-brand-purpleSoft"
              badge="deep · worktree"
              badgeCls="bg-brand-purple/15 text-brand-purpleSoft ring-brand-purple/30"
              title="Full checkout to explore"
            >
              <p>
                Touch anything bigger — too many files or lines, more than one subsystem, or
                any exported API, type declaration, schema or migration — and the run earns a{' '}
                <span className="font-medium text-gray-200">partial clone and an ephemeral
                worktree</span>. The agent gets Read, Grep, Glob and a sandboxed Bash to trace
                callers and check assumptions against the real tree.
              </p>
              <p>
                Built for cross-cutting changes and API reworks, where the blast radius lives
                outside the diff. Ambiguous? It rounds up to deep.
              </p>
            </Card>
          </div>
          <p className="mx-auto mt-8 max-w-2xl text-center text-sm text-gray-500">
            You can force a mode per run, and every decision is stored with the metrics that
            drove it, so the thresholds are tunable. A run is hard-capped by turns
            and by dollars; it can be cancelled mid-flight.
          </p>
        </Section>
      </section>

      {/* the flow */}
      <Section width="wide" className="py-20 sm:py-24">
        <SectionHeading
          eyebrow="The flow"
          eyebrowClass="text-brand-purpleSoft"
          title="Four steps, one human decision."
        />
        <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {FLOW.map((s) => (
            <div key={s.n} className="rounded-2xl border border-white/10 bg-white/5 p-6">
              <span className="font-mono text-sm text-brand-purpleSoft">{s.n}</span>
              <h3 className="mt-2 text-base font-semibold text-gray-100">{s.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-gray-400">{s.body}</p>
            </div>
          ))}
        </div>

        <div className="mt-10 rounded-3xl border border-white/10 bg-white/[0.03] p-7 sm:p-9">
          <h3 className="text-lg font-bold tracking-tight text-gray-50">
            Findings are structured, not prose.
          </h3>
          <p className="mt-3 max-w-3xl text-pretty leading-relaxed text-gray-400">
            Every finding carries a severity, a file and line, a body, and an optional code
            suggestion — so they sort, filter, and post as real inline comments. If a
            finding’s line isn’t an addable position in the diff, Pierre re-anchors it to the
            file’s first change rather than dropping it; truly unplaceable notes fall back to
            the review body.
          </p>
          <div className="mt-5 flex flex-wrap gap-2">
            {SEVERITIES.map((s) => (
              <span
                key={s.label}
                className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium ring-1 ${s.cls}`}
              >
                {s.label}
              </span>
            ))}
          </div>
        </div>
      </Section>

      {/* control / trust */}
      <Section width="wide" className="py-10 sm:py-14">
        <div className="grid gap-6 md:grid-cols-3">
          <div className="rounded-2xl border border-white/10 bg-white/5 p-6">
            <LockIcon className="h-6 w-6 text-brand-green" />
            <h3 className="mt-4 text-base font-semibold text-gray-100">Your words ship</h3>
            <p className="mt-2 text-sm leading-relaxed text-gray-400">
              Claude’s output is read-only, with copy buttons. The review GitHub receives is
              the one you wrote and the findings you chose — never an auto-post.
            </p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/5 p-6">
            <LockIcon className="h-6 w-6 text-brand-sky" />
            <h3 className="mt-4 text-base font-semibold text-gray-100">Local-only, by design</h3>
            <p className="mt-2 text-sm leading-relaxed text-gray-400">
              It runs on your machine against your own key or Claude session, and is{' '}
              force-disabled in the hosted cloud — the routes aren’t even registered there.
            </p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/5 p-6">
            <BoltIcon className="h-6 w-6 text-brand-amber" />
            <h3 className="mt-4 text-base font-semibold text-gray-100">It costs real money</h3>
            <p className="mt-2 text-sm leading-relaxed text-gray-400">
              Each run spends model credits, so it’s opt-in and off by default — with a
              per-run dollar cap. No surprise bills, no background spend.
            </p>
          </div>
        </div>
      </Section>

      {/* next */}
      <Section width="narrow" className="py-16 text-center">
        <h2 className="text-pretty text-2xl font-bold tracking-tight text-gray-50 sm:text-3xl">
          More review automation is coming.
        </h2>
        <p className="mx-auto mt-3 max-w-xl text-gray-400">
          Automated reviews on open, an OpenAI option, and status reports that summarise what
          shipped are on the roadmap.
        </p>
        <Link
          to="/how-it-works#roadmap"
          className="group mt-7 inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-5 py-3 text-sm font-semibold text-gray-100 transition hover:bg-white/10"
        >
          See the roadmap
          <ArrowRightIcon className="h-4 w-4 transition group-hover:translate-x-0.5" />
        </Link>
      </Section>
    </>
  );
}
