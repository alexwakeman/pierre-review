import type { ReactNode } from 'react';
import { useSeo } from '../lib/seo';
import { seoFor } from '../lib/routes';
import { INSTALL_COMMAND, REPO_URL, SITE_NAME } from '../lib/site';
import {
  DashItem,
  InkButton,
  MonoLabel,
  RailGrid,
  RuledItem,
  Section,
  Story,
} from '../components/feint/primitives';
import { TerminalPanel } from '../components/feint/Terminal';
import { PixelIcon } from '../components/feint/PixelIcon';

// ---------------------------------------------------------------------------
// The engineering page — five numbered sections plus the closing CTA.
//
// This is the most sceptical audience on the site, so it is laid out as a
// technical note rather than a product page: a spec table for the pipeline, two
// ruled feature columns for the deployment split, and running prose everywhere
// else. Nothing here sells; it explains.
//
// WHAT IS GONE, and why:
//   · the six-box pipeline diagram with rotating arrow SVGs between the boxes —
//     boxes and icons are both out of the system, and a printed spec table says
//     the same thing in one column of hairlines.
//   · the eighteen glass cards (six sync, two deployment, six roadmap, one
//     security) — each is now a block under a rule.
//   · the coloured eyebrows above every heading. Sections are introduced by the
//     rail label instead, which is where the eyebrow copy went ("The sync
//     pipeline" → the 02 rail, "Security model" → its own folded rail).
//   · the roadmap's coloured <Pill> tags — the tag is now a mono label.
//   · the hero <Glow>.
//
// NO VERMILION IN THE HEADINGS on this page, deliberately. The colour means "a
// human is still needed" and no claim on this page is that claim, so its only
// appearances are the security list's dashes and the link hairlines.
//
// All copy is verbatim from the live page, with "Pierre" → SITE_NAME. The
// `pierre` / `pierre-review` COMMANDS are not renamed — see lib/site.ts.
// ---------------------------------------------------------------------------

/** An inline identifier in running copy — what a <code> element used to be. */
function Term({ children }: { children: string }): JSX.Element {
  return <span className="font-mono text-[16px]">{children}</span>;
}

const PIPELINE: { label: string; sub: string }[] = [
  { label: 'gh CLI / OAuth', sub: 'token source' },
  { label: 'GitHub API', sub: 'GraphQL + REST' },
  { label: 'Sync', sub: 'every 5 min · idempotent' },
  { label: 'SQLite | Postgres', sub: 'local | cloud' },
  { label: 'Fastify API', sub: 'lean read layer' },
  { label: 'React SPA', sub: 'vis-timeline' },
];

const SYNC: { title: string; body: ReactNode }[] = [
  {
    title: 'Triggers',
    body: (
      <>
        A <Term>node-cron</Term> job runs every five minutes, plus on repo-add and on a
        manual deep sync. In the cloud, the periodic pass follows the user: a tenant with no
        open tab for 15 minutes stops being re-synced, so idle accounts don’t burn API
        quota. Local is always on.
      </>
    ),
  },
  {
    title: 'Two-phase backfill',
    body: (
      <>
        A never-synced repo fills in <em>seconds</em>: a fast ~14-day foreground pass paints
        the recent board, then the deep backfill walks back to 90 days in the background,
        continuing the same cursor so no page is fetched twice.
      </>
    ),
  },
  {
    title: 'Incremental + overlap',
    body: (
      <>
        After that, each run re-walks from the last sync minus a 20-minute overlap. GitHub
        doesn’t bump a PR’s <Term>updatedAt</Term> for everything that matters — a CI run
        finishing, a thread resolving — so the overlap deliberately re-checks the trailing
        window and reconciles.
      </>
    ),
  },
  {
    title: 'One fat query',
    body: (
      <>
        Each repo is one paginated GraphQL query — 25 PRs a page, newest-first — walked
        until a PR predates the window. Per-commit changed-file paths come from REST and are
        cached <em>permanently</em>, since a commit SHA is immutable.
      </>
    ),
  },
  {
    title: 'Idempotent by structure',
    body: (
      <>
        Every entity upserts on its GitHub node id; timeline events upsert on a
        deterministic dedupe key. Re-running — after a crash, a cancel, or an overlapping
        window — is always safe, because conflict targets reconcile instead of duplicating.
      </>
    ),
  },
  {
    title: 'Lean storage',
    body: (
      <>
        By default {SITE_NAME} skips the bulky, regenerable text — PR descriptions, diff
        hunks, commit messages — keeping the DB small. It’s hydrated on demand when you open
        a PR and cached in your browser’s IndexedDB, so an unchanged PR never re-downloads.
        Flip one flag to store everything for fully-offline detail.
      </>
    ),
  },
];

const LOCAL: ReactNode[] = [
  'Runs entirely on your machine — SQLite, no hosted backend.',
  <>
    Authenticates with your logged-in <Term>gh</Term> CLI; stores no credentials.
  </>,
  'One synthesized account; opens straight to the Activity console.',
  // A plain string, not JSX text — so the ampersand is literal, not `&amp;`.
  'Runs Pro and Pro+ in full, including agentic review & fix (opt-in).',
  <>
    <Term>{INSTALL_COMMAND}</Term> and you’re in.
  </>,
];

const CLOUD: string[] = [
  'A public landing, GitHub-App OAuth, per-user accounts.',
  'Postgres, with every entity owned and isolated by account.',
  'Encrypted per-user tokens; sessions behind a sealed cookie.',
  'Self-hostable on Railway from the same image.',
  'Sync follows active users to keep quota lean.',
];

const SECURITY = [
  'Per-account isolation is load-bearing: every list query filters by account, every id-addressed read scopes ownership, and a cross-account IDOR check (verify:isolation) guards the query layer.',
  'Cloud OAuth tokens are sealed with AES-256-GCM and decrypted per request — never held in a module-level cache.',
  'Local mode stores no credentials at all: it borrows your authenticated gh CLI and talks to a SQLite file on your disk.',
  'The model that grades bot comments is Limn’s own — fine-tuned on public GitHub bot reviews, running on plain CPU in the hosted service. Comment text in, a label out; your code never trains anyone’s model.',
];

const RUN_STEPS: ReactNode[] = [
  <>
    It checks for an authenticated <Term>gh</Term> CLI and reads a short-lived token —
    nothing is written to disk.
  </>,
  'It opens a SQLite file under your home directory and runs migrations.',
  'A single Fastify process serves the API and the SPA, the scheduler starts, and your browser opens to the Activity console.',
];

const ROADMAP: { tag: string; title: string; body: string }[] = [
  {
    tag: 'AI',
    title: 'Metered advanced AI',
    body: 'Pay-as-you-go for Claude Review, AI Analysis and AI Fix at API list price — no key of your own required, usage tracked in the same in-app credits.',
  },
  {
    tag: 'AI',
    title: 'BYO AI endpoints',
    body: 'OpenAI-compatible endpoints — Bedrock, self-hosted, open models — so you choose the model and where your code goes, for cost and privacy control.',
  },
  {
    tag: 'Integrations',
    title: 'Deeper Jira/Linear integration',
    body: 'Ticket links on PRs ship today. Next: pulling ticket status and titles into the board, so a stalled PR is visibly a stalled ticket.',
  },
  {
    tag: 'Integrations',
    title: 'Email digests',
    body: 'The same sprint report and repo digests that reach Slack today, delivered to an inbox — for the teams whose “one place” isn’t Slack.',
  },
  {
    tag: 'Platform',
    title: 'Hosted cloud Pro rollout',
    body: 'Pro and Pro+ run in the local and self-hosted deployment today; the hosted cloud tiers are rolling out, same features, zero setup.',
  },
  {
    tag: 'Platform',
    title: 'The cross-org benchmark',
    body: 'Opt-in and anonymised: how your bots’ acted-on rate and noise mix compare with teams like yours. The receipt gets a reference column.',
  },
  {
    tag: 'AI',
    title: 'Bot grading in the local install',
    body: 'The severity model that powers the receipt runs in the hosted service today. Bringing it to the local install — the same grades, fully offline — is planned.',
  },
  {
    tag: 'Platform',
    title: 'A phone-friendly build',
    body: `${SITE_NAME} is a dense, desktop-first tool today. A responsive build for skimming the feed and triaging “My Turn” from your phone is planned.`,
  },
];

// The issue tracker is the one external link on the page. It is a raw <a> rather
// than <InlineLink> so it keeps target="_blank" — the same shape the footer's
// GitHub link uses.
const EXTERNAL_LINK =
  'border-b border-signal-fill text-ink transition-colors duration-hover ease-standard hover:text-signal-text focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink';

export default function HowItWorks(): JSX.Element {
  useSeo(seoFor('/how-it-works'));

  return (
    <>
      {/* ---------- hero ---------- */}
      <Section divider="none" pad="none" className="pb-12 pt-20">
        <RailGrid rail={{ word: 'Under the hood' }} cols="one">
          <div>
            <h1 className="mb-6 max-w-[26ch] text-pretty font-display text-hero-sm font-semibold text-ink type:text-page-title">
              One idempotent pipeline, from GitHub to a live board.
            </h1>
            <p className="max-w-[62ch] text-lede">
              No webhooks to babysit, no warehouse to feed. {SITE_NAME} pulls your PR
              activity on a schedule, stores it leanly, and serves a deliberately thin read
              layer to the timeline. Here’s the whole machine.
            </p>
          </div>
        </RailGrid>
      </Section>

      {/* ---------- 01 · pipeline ----------
          The old diagram's arrows carried no information the reading order does
          not — stage 01 feeds 02. So it is a numbered spec table. */}
      <Section>
        <RailGrid rail={{ n: '01', word: 'Pipeline' }} cols="one">
          <div>
            <PixelIcon name="arrow" className="mb-5" />
            <ol className="max-w-answer border-t border-ink">
            {PIPELINE.map((stage, i) => (
              <li
                key={stage.label}
                className="flex flex-wrap items-baseline justify-between gap-x-8 gap-y-1 border-b border-rule-hair py-3.5"
              >
                <span className="flex items-baseline gap-4">
                  <span className="font-mono text-mono-caption text-secondary">{`0${i + 1}`}</span>
                  <span className="font-mono text-mono-data text-ink">{stage.label}</span>
                </span>
                <span className="font-mono text-mono-caption text-secondary">{stage.sub}</span>
              </li>
            ))}
            </ol>
          </div>
        </RailGrid>
      </Section>

      {/* ---------- 02 · the sync pipeline ---------- */}
      <Section tone="alt">
        <RailGrid rail={{ n: '02', word: 'Sync pipeline' }} cols="one">
          <div>
            <PixelIcon name="sync" className="mb-5" />
            <h2 className="mb-5 font-display text-h2-sm font-semibold text-ink type:text-h2">
              Current, without ceremony.
            </h2>
            <p className="mb-11 max-w-[64ch] text-lede">
              The sync is the load-bearing part — and it’s built to be boring: safe to
              re-run, cheap to keep current, and quick to fill a fresh repo.
            </p>

            <div className="grid gap-x-grid-gutter gap-y-9 rail:grid-cols-3">
              {SYNC.map((c) => (
                // rule-strong, not rule: these sit on the `paper-alt` ground.
                <div key={c.title} className="border-t border-rule-strong pt-[18px]">
                  <h3 className="mb-3 font-display text-h4-sm font-semibold text-ink">
                    {c.title}
                  </h3>
                  <p className="text-list">{c.body}</p>
                </div>
              ))}
            </div>

            <Story moment="Overnight">
              CI went green at 02:11 and a thread resolved at 23:40 — the board had both
              before your first coffee. Nothing to run, nothing to refresh.
            </Story>
          </div>
        </RailGrid>
      </Section>

      {/* ---------- 03 · local vs cloud ---------- */}
      <Section>
        <RailGrid rail={{ n: '03', word: 'Two modes' }} cols="one">
          <div>
            <PixelIcon name="modes" className="mb-5" />
            <h2 className="mb-5 font-display text-h2-sm font-semibold text-ink type:text-h2">
              Local-first. Cloud when you need it.
            </h2>
            <p className="mb-11 max-w-[64ch] text-lede">
              A single environment variable selects the whole stack. The query layer is
              written once against a portable async surface, so the same code drives SQLite
              on your laptop and Postgres on a server.
            </p>

            {/* Two ruled columns under equal ink rules — the pricing-tier shape,
                but with no promotion: neither mode is the recommended one. */}
            <div className="grid gap-grid-gutter rail:grid-cols-2">
              <div className="border-t border-ink pt-[26px]">
                <div className="mb-5 flex items-baseline justify-between gap-4">
                  <h3 className="font-display text-h3 font-semibold text-ink">Local</h3>
                  <MonoLabel className="text-secondary">default</MonoLabel>
                </div>
                <ul className="flex flex-col">
                  {LOCAL.map((item, i) => (
                    <RuledItem key={i} last={i === LOCAL.length - 1}>
                      {item}
                    </RuledItem>
                  ))}
                </ul>
              </div>

              <div className="border-t border-ink pt-[26px]">
                <div className="mb-5 flex items-baseline justify-between gap-4">
                  <h3 className="font-display text-h3 font-semibold text-ink">Cloud</h3>
                  <MonoLabel className="text-secondary">multi-tenant</MonoLabel>
                </div>
                <ul className="flex flex-col">
                  {CLOUD.map((item, i) => (
                    <RuledItem key={item} last={i === CLOUD.length - 1}>
                      {item}
                    </RuledItem>
                  ))}
                </ul>
              </div>
            </div>

            <Story moment="Day one">
              <span className="font-mono">npx</span> on your laptop before lunch; the same
              board, hosted for the whole team, next sprint. One codebase, one habit.
            </Story>
          </div>
        </RailGrid>

        {/* the security model — folded under the same section, under a rule */}
        <RailGrid
          rail={{ word: 'Security model' }}
          cols="one"
          className="mt-14 border-t border-rule pt-10"
        >
          <ul className="flex max-w-answer flex-col gap-3.5">
            {SECURITY.map((s) => (
              <DashItem key={s}>{s}</DashItem>
            ))}
          </ul>
        </RailGrid>
      </Section>

      {/* ---------- 04 · run locally ---------- */}
      <Section id="run-locally">
        <RailGrid rail={{ n: '04', word: 'Run locally' }}>
          <div>
            <PixelIcon name="console" className="mb-5" />
            <h2 className="mb-7 font-display text-h2-sm font-semibold text-ink type:text-h2">
              What happens when you run the command.
            </h2>

            <div className="mb-6 flex flex-col gap-3.5">
              {RUN_STEPS.map((step, i) => (
                <div
                  key={i}
                  className={`flex items-baseline gap-4 ${
                    i === RUN_STEPS.length - 1 ? '' : 'border-b border-rule-hair pb-3'
                  }`}
                >
                  <span className="font-mono text-mono-caption text-secondary">{`0${i + 1}`}</span>
                  <span className="text-list">{step}</span>
                </div>
              ))}
            </div>

            <p className="max-w-caption text-list text-muted">
              Requires Node ≥ 20 and <Term>gh auth login</Term>. Installed globally? The
              short <Term>pierre</Term> command does the same.
            </p>
          </div>

          <TerminalPanel label="zsh · ~/work" command={INSTALL_COMMAND} cursor />
        </RailGrid>
      </Section>

      {/* ---------- 05 · roadmap ---------- */}
      <Section id="roadmap">
        <RailGrid rail={{ n: '05', word: 'Roadmap' }} cols="one">
          <div>
            <PixelIcon name="flag" className="mb-5" />
            <h2 className="mb-5 font-display text-h2-sm font-semibold text-ink type:text-h2">
              What’s next.
            </h2>
            <p className="mb-11 max-w-[64ch] text-lede">
              {SITE_NAME} is useful today, and deliberately scoped. Here’s where it’s
              heading — listed because it’s planned, not because it’s done.
            </p>

            {/* Two columns, so each tag's pair sits on one row. */}
            <div className="grid gap-x-grid-gutter gap-y-9 rail:grid-cols-2">
              {ROADMAP.map((r) => (
                <div key={r.title} className="border-t border-rule pt-[18px]">
                  <MonoLabel className="mb-3 text-secondary">{r.tag}</MonoLabel>
                  <h3 className="mb-3 font-display text-h4-sm font-semibold text-ink">
                    {r.title}
                  </h3>
                  <p className="text-list">{r.body}</p>
                </div>
              ))}
            </div>

            <p className="mt-10 max-w-answer text-body-sm">
              Want something {SITE_NAME} doesn’t do yet?{' '}
              <a
                href={`${REPO_URL}/issues`}
                target="_blank"
                rel="noreferrer noopener"
                className={EXTERNAL_LINK}
              >
                Open an issue
              </a>
              .
            </p>
          </div>
        </RailGrid>
      </Section>

      {/* ---------- final CTA ---------- */}
      <Section divider="ink" pad="lg">
        <div className="flex flex-col gap-10 rail:flex-row rail:items-end rail:justify-between rail:gap-14">
          <h2 className="max-w-[22ch] font-display text-h2-sm font-semibold text-ink type:text-cta">
            Ready to see your team on one board?
          </h2>
          <div className="shrink-0">
            <InkButton to="/api/auth/login">Sign in with GitHub</InkButton>
          </div>
        </div>
      </Section>
    </>
  );
}
