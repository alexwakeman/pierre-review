import type { ReactNode } from 'react';
import { useSeo } from '../lib/seo';
import { Section, SectionHeading, Eyebrow, Pill, Glow } from '../components/ui';
import {
  SyncIcon,
  LockIcon,
  BoltIcon,
  ClockIcon,
  RouteIcon,
  ShieldIcon,
  MapIcon,
  GitHubMark,
} from '../components/icons';

const PIPELINE = [
  { label: 'gh CLI / OAuth', sub: 'token source', accent: 'text-gray-300' },
  { label: 'GitHub API', sub: 'GraphQL + REST', accent: 'text-brand-sky' },
  { label: 'Sync', sub: 'every 5 min · idempotent', accent: 'text-brand-blue' },
  { label: 'SQLite | Postgres', sub: 'local | cloud', accent: 'text-brand-green' },
  { label: 'Fastify API', sub: 'lean read layer', accent: 'text-brand-amber' },
  { label: 'React SPA', sub: 'vis-timeline', accent: 'text-brand-purpleSoft' },
];

const SYNC_CARDS: { icon: (p: { className?: string }) => ReactNode; accent: string; title: string; body: ReactNode }[] = [
  {
    icon: ClockIcon,
    accent: 'text-brand-sky',
    title: 'Triggers',
    body: (
      <>
        A <code className="font-mono text-gray-300">node-cron</code> job runs every five
        minutes, plus on repo-add and on a manual deep sync. In the cloud, the periodic pass
        follows the user: a tenant with no open tab for 15 minutes stops being re-synced, so
        idle accounts don’t burn API quota. Local is always on.
      </>
    ),
  },
  {
    icon: BoltIcon,
    accent: 'text-brand-green',
    title: 'Two-phase backfill',
    body: (
      <>
        A never-synced repo fills in <span className="text-gray-200">seconds</span>: a fast
        ~14-day foreground pass paints the recent board, then the deep backfill walks back to
        90 days in the background, continuing the same cursor so no page is fetched twice.
      </>
    ),
  },
  {
    icon: SyncIcon,
    accent: 'text-brand-blue',
    title: 'Incremental + overlap',
    body: (
      <>
        After that, each run re-walks from the last sync minus a 20-minute overlap. GitHub
        doesn’t bump a PR’s <code className="font-mono text-gray-300">updatedAt</code> for
        everything that matters — a CI run finishing, a thread resolving — so the overlap
        deliberately re-checks the trailing window and reconciles.
      </>
    ),
  },
  {
    icon: RouteIcon,
    accent: 'text-brand-amber',
    title: 'One fat query',
    body: (
      <>
        Each repo is one paginated GraphQL query — 25 PRs a page, newest-first — walked until
        a PR predates the window. Per-commit changed-file paths come from REST and are cached{' '}
        <span className="text-gray-200">permanently</span>, since a commit SHA is immutable.
      </>
    ),
  },
  {
    icon: ShieldIcon,
    accent: 'text-brand-purpleSoft',
    title: 'Idempotent by structure',
    body: (
      <>
        Every entity upserts on its GitHub node id; timeline events upsert on a deterministic
        dedupe key. Re-running — after a crash, a cancel, or an overlapping window — is always
        safe, because conflict targets reconcile instead of duplicating.
      </>
    ),
  },
  {
    icon: LockIcon,
    accent: 'text-brand-sky',
    title: 'Lean storage',
    body: (
      <>
        By default Pierre skips the bulky, regenerable text — comment and PR bodies, diff
        hunks, commit messages — keeping the DB small. It’s hydrated on demand when you open a
        PR and cached in your browser’s IndexedDB, so an unchanged PR never re-downloads. Flip
        one flag to store everything for fully-offline detail.
      </>
    ),
  },
];

const SECURITY = [
  'Per-account isolation is load-bearing: every list query filters by account, every id-addressed read scopes ownership, and a cross-account IDOR check (verify:isolation) guards the query layer.',
  'Cloud OAuth tokens are sealed with AES-256-GCM and decrypted per request — never held in a module-level cache.',
  'Local mode stores no credentials at all: it borrows your authenticated gh CLI and talks to a SQLite file on your disk.',
];

const ROADMAP: { tag: string; tagCls: string; title: string; body: string }[] = [
  {
    tag: 'Integrations',
    tagCls: 'bg-brand-sky/10 text-brand-skySoft ring-brand-sky/30',
    title: 'Slack',
    body: 'Push “My Turn” and stalled-PR nudges to Slack, so what needs you reaches you where you already are — without another tab to keep open.',
  },
  {
    tag: 'Integrations',
    tagCls: 'bg-brand-sky/10 text-brand-skySoft ring-brand-sky/30',
    title: 'Jira',
    body: 'Tie PRs back to the Jira issues they close, so the board reflects the work — not just the code — and a stalled PR is visibly a stalled ticket.',
  },
  {
    tag: 'Reviews',
    tagCls: 'bg-brand-purple/15 text-brand-purpleSoft ring-brand-purple/30',
    title: 'Automated AI code reviews',
    body: 'Opt a repo into a review the moment a PR opens or updates, so a structured first pass is waiting before a human even looks.',
  },
  {
    tag: 'Reviews',
    tagCls: 'bg-brand-purple/15 text-brand-purpleSoft ring-brand-purple/30',
    title: 'OpenAI option for reviews',
    body: 'A provider choice alongside Claude — pick the model per run, with the same routing and curate-then-post flow. Bring your own key; no lock-in.',
  },
  {
    tag: 'Reporting',
    tagCls: 'bg-brand-green/10 text-green-200 ring-brand-green/30',
    title: 'Status reports',
    body: 'Daily, weekly and bi-weekly digests — what merged, what stalled, where review time went — generated from the same synced data, ready to paste into a standup or a stakeholder update.',
  },
  {
    tag: 'Platform',
    tagCls: 'bg-brand-amber/10 text-amber-200 ring-brand-amber/30',
    title: 'A phone-friendly build',
    body: 'Pierre is a dense, desktop-first tool today. A responsive build for triaging “My Turn” and skimming the Feed from your phone is planned.',
  },
];

function Arrow(): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="h-5 w-5 shrink-0 rotate-90 text-gray-600 md:rotate-0"
    >
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

export default function HowItWorks(): JSX.Element {
  useSeo({
    path: '/how-it-works',
    title: 'How it works — sync, architecture & roadmap',
    description:
      'The engineering behind Pierre: an idempotent five-minute sync pipeline with two-phase backfill and lean storage, a dual-dialect SQLite/Postgres data layer, the local-vs-cloud split, the security model — and what’s next (Slack, Jira, automated AI reviews, OpenAI, status reports).',
  });

  return (
    <>
      {/* hero */}
      <header className="relative overflow-hidden">
        <Glow className="absolute -top-24 left-1/2 h-96 w-[40rem] max-w-full -translate-x-1/2 rounded-full bg-brand-green/12 blur-[130px]" />
        <Section width="default" className="pb-10 pt-16 text-center sm:pt-20">
          <Eyebrow className="text-brand-green">Under the hood</Eyebrow>
          <h1 className="mx-auto mt-3 max-w-3xl text-balance text-4xl font-bold leading-tight tracking-tight text-gray-50 sm:text-5xl">
            One idempotent pipeline, from GitHub to a live board.
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-pretty text-lg leading-relaxed text-gray-400">
            No webhooks to babysit, no warehouse to feed. Pierre pulls your PR activity on a
            schedule, stores it leanly, and serves a deliberately thin read layer to the
            timeline. Here’s the whole machine.
          </p>
        </Section>
      </header>

      {/* pipeline diagram */}
      <Section width="wide" className="py-8">
        <ol className="flex flex-col items-stretch justify-center gap-3 md:flex-row md:items-center md:gap-2">
          {PIPELINE.map((step, i) => (
            <li key={step.label} className="flex flex-col items-center gap-3 md:flex-row md:gap-2">
              <div className="flex min-w-[8.5rem] flex-col items-center rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-center backdrop-blur">
                <span className={`text-sm font-semibold ${step.accent}`}>{step.label}</span>
                <span className="mt-0.5 text-[11px] text-gray-500">{step.sub}</span>
              </div>
              {i < PIPELINE.length - 1 && <Arrow />}
            </li>
          ))}
        </ol>
      </Section>

      {/* sync deep dive */}
      <Section width="wide" className="py-16 sm:py-20">
        <SectionHeading
          eyebrow="The sync pipeline"
          eyebrowClass="text-brand-sky"
          title="How the board stays current."
          lead="The sync is the load-bearing part — and it’s built to be boring: safe to re-run, cheap to keep current, and quick to fill a fresh repo."
        />
        <div className="mt-12 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
          {SYNC_CARDS.map((c) => (
            <div key={c.title} className="flex flex-col rounded-2xl border border-white/10 bg-white/5 p-6">
              <c.icon className={`h-6 w-6 ${c.accent}`} />
              <h3 className="mt-4 text-base font-semibold text-gray-100">{c.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-gray-400">{c.body}</p>
            </div>
          ))}
        </div>
      </Section>

      {/* local vs cloud */}
      <section className="relative border-y border-white/5 bg-white/[0.02] py-16 sm:py-20">
        <Section width="wide">
          <SectionHeading
            eyebrow="One codebase, two ways to run"
            eyebrowClass="text-brand-green"
            title="Local-first. Cloud when you need it."
            lead="A single environment variable selects the whole stack. The query layer is written once against a portable async surface, so the same code drives SQLite on your laptop and Postgres on a server."
          />
          <div className="mt-12 grid gap-6 lg:grid-cols-2">
            <div className="rounded-3xl border border-white/10 bg-white/[0.03] p-7">
              <div className="flex items-center gap-2">
                <BoltIcon className="h-5 w-5 text-brand-green" />
                <h3 className="text-lg font-bold tracking-tight text-gray-50">Local</h3>
                <Pill className="bg-brand-green/10 text-green-200 ring-brand-green/30">default</Pill>
              </div>
              <ul className="mt-5 space-y-3 text-sm leading-relaxed text-gray-400">
                <li>• Runs entirely on your machine — SQLite, no hosted backend.</li>
                <li>• Authenticates with your logged-in <code className="font-mono text-gray-300">gh</code> CLI; stores no credentials.</li>
                <li>• One synthesized account; opens straight to the timeline.</li>
                <li>• Claude Review available (opt-in).</li>
                <li>• <code className="font-mono text-gray-300">npx pierre-review</code> and you’re in.</li>
              </ul>
            </div>
            <div className="rounded-3xl border border-white/10 bg-white/[0.03] p-7">
              <div className="flex items-center gap-2">
                <LockIcon className="h-5 w-5 text-brand-sky" />
                <h3 className="text-lg font-bold tracking-tight text-gray-50">Cloud</h3>
                <Pill className="bg-brand-sky/10 text-brand-skySoft ring-brand-sky/30">multi-tenant</Pill>
              </div>
              <ul className="mt-5 space-y-3 text-sm leading-relaxed text-gray-400">
                <li>• A public landing, GitHub-App OAuth, per-user accounts.</li>
                <li>• Postgres, with every entity owned and isolated by account.</li>
                <li>• Encrypted per-user tokens; sessions behind a sealed cookie.</li>
                <li>• Self-hostable on Railway from the same image.</li>
                <li>• Sync follows active users to keep quota lean.</li>
              </ul>
            </div>
          </div>

          {/* security */}
          <div className="mt-8 rounded-3xl border border-white/10 bg-white/[0.03] p-7">
            <div className="flex items-center gap-2">
              <ShieldIcon className="h-5 w-5 text-brand-purpleSoft" />
              <Eyebrow className="text-brand-purpleSoft">Security model</Eyebrow>
            </div>
            <ul className="mt-4 space-y-3">
              {SECURITY.map((s) => (
                <li key={s} className="flex gap-3 text-sm leading-relaxed text-gray-400">
                  <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-purpleSoft" />
                  <span>{s}</span>
                </li>
              ))}
            </ul>
          </div>
        </Section>
      </section>

      {/* run locally */}
      <Section id="run-locally" width="narrow" className="scroll-mt-24 py-16 sm:py-20">
        <Eyebrow className="text-brand-green">Run it locally</Eyebrow>
        <h2 className="mt-3 text-pretty text-2xl font-bold tracking-tight text-gray-50 sm:text-3xl">
          What happens when you run the command.
        </h2>
        <div className="mt-6 flex items-center gap-3 rounded-xl border border-white/10 bg-gray-900/70 px-5 py-4 font-mono text-sm">
          <span className="select-none text-brand-green">$</span>
          <code className="text-gray-100">npx pierre-review</code>
        </div>
        <ol className="mt-6 space-y-3 text-pretty leading-relaxed text-gray-400">
          <li>
            <span className="font-medium text-gray-200">1.</span> It checks for an
            authenticated <code className="font-mono text-gray-300">gh</code> CLI and reads a
            short-lived token — nothing is written to disk.
          </li>
          <li>
            <span className="font-medium text-gray-200">2.</span> It opens a SQLite file under
            your home directory and runs migrations.
          </li>
          <li>
            <span className="font-medium text-gray-200">3.</span> A single Fastify process
            serves the API and the SPA, the scheduler starts, and your browser opens to the
            timeline.
          </li>
        </ol>
        <p className="mt-5 text-sm text-gray-500">
          Requires Node ≥ 20 and <code className="font-mono text-gray-400">gh auth login</code>.
          Installed globally? The short <code className="font-mono text-gray-400">pierre</code>{' '}
          command does the same.
        </p>
      </Section>

      {/* roadmap */}
      <Section id="roadmap" width="wide" className="scroll-mt-24 py-16 sm:py-20">
        <div className="flex items-center justify-center gap-2">
          <MapIcon className="h-6 w-6 text-brand-amber" />
          <Eyebrow className="text-brand-amber">Future work</Eyebrow>
        </div>
        <SectionHeading
          title="What’s next."
          lead="Pierre is useful today, and deliberately scoped. Here’s where it’s heading — listed because it’s planned, not because it’s done."
        />
        <div className="mt-12 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
          {ROADMAP.map((r) => (
            <div key={r.title} className="flex flex-col rounded-2xl border border-white/10 bg-white/5 p-6">
              <Pill className={r.tagCls}>{r.tag}</Pill>
              <h3 className="mt-4 text-base font-semibold text-gray-100">{r.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-gray-400">{r.body}</p>
            </div>
          ))}
        </div>
        <p className="mx-auto mt-8 max-w-2xl text-center text-sm text-gray-500">
          Want something Pierre doesn’t do yet?{' '}
          <a
            href="https://github.com/alexwakeman/pierre-review/issues"
            target="_blank"
            rel="noreferrer noopener"
            className="text-gray-400 underline-offset-2 hover:underline"
          >
            Open an issue
          </a>
          .
        </p>
      </Section>

      {/* final CTA */}
      <Section width="narrow" className="py-16 text-center">
        <h2 className="text-pretty text-2xl font-bold tracking-tight text-gray-50 sm:text-3xl">
          Ready to see your team on one board?
        </h2>
        <div className="mt-7 flex justify-center">
          <a
            href="/api/auth/login"
            className="inline-flex items-center gap-2.5 rounded-xl bg-gradient-to-r from-brand-blueDeep to-brand-blue px-6 py-3.5 text-base font-semibold text-white shadow-sky-glow transition hover:from-brand-blue hover:to-brand-sky"
          >
            <GitHubMark className="h-5 w-5" />
            Sign in with GitHub
          </a>
        </div>
      </Section>
    </>
  );
}
