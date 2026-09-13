// The ESTATE expansion — the second half of the demo dataset.
//
// seed-demo.ts builds a small, hand-curated fixture: three repositories and the
// specific pull requests the story screenshots need (#113's threads, #114's red
// build, the CodeRabbit spike week). It is deliberately hand-written, because
// every one of those rows is addressed by id from a screenshot script.
//
// This file adds the thing a hand-written fixture cannot give you: SCALE, and
// the two shapes the product exists to make legible —
//
//   1. MULTI-REPO. Five more repositories (eight in total) split across the two
//      workspaces, so every workspace-scoped surface has something to roll up:
//      the repo-activity rows, reach per repository, the by-workspace axis, the
//      benchmark's per-repo units and its workspace rollup.
//
//   2. THE AI VOLUME, on both sides of it. Code agents (Devin, Sweep) AUTHOR a
//      third of the pull requests, and five review vendors (CodeRabbit, Greptile,
//      Cursor Bugbot, Qodo, Copilot) plus an in-house agent and a quality gate
//      REVIEW them — several hundred bot threads a fortnight. That is the load
//      the product is the calm layer above, and at three repositories and forty
//      threads it simply was not on screen.
//
// EVERYTHING HERE IS DETERMINISTIC. A fixed-seed mulberry32 PRNG, never
// Math.random, so re-running the seeder produces a byte-identical database and
// therefore byte-identical screenshots. A shot that moves between runs is a shot
// nobody can review.
//
// ID BANDS. seed-demo.ts owns: PRs <= 142 and 200-999, reviews/threads/comments
// 1-999 and 5000-9999, events 1-9999. This file takes a band clear of both and
// never renumbers anything above.
import { createHash } from 'node:crypto';

// ---------------------------------------------------------------- ids --------
const PR_BASE = 2000;
const CHILD_BASE = 30_000; // commits / reviews / threads / review comments / pr comments
const EVENT_BASE = 60_000;

// ---------------------------------------------------------------- prng -------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface EstateCtx {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schema: any;
  now: Date;
  /** n days before `now`. */
  day: (n: number) => Date;
  /** The workspace ids seed-demo.ts created. */
  platformWs: number;
  webWs: number;
  /** The existing bot user ids, so the new repos reuse the same actors. */
  coderabbit: number;
  copilot: number;
  acmeCi: number;
  dependabot: number;
}

export interface EstateResult {
  repoIds: number[];
  prIds: number[];
  /** Every review-bot user id that ends up with a footprint, for the ROI panel. */
  reviewBotIds: number[];
}

// ------------------------------------------------------------- the cast ------
// New humans. Six more, so the estate reads like a team of a dozen rather than a
// squad of five, and so the People report's picker has enough names to be worth
// opening.
const HUMANS = [
  { id: 11, login: 'aisha-rahman', name: 'Aisha Rahman' },
  { id: 12, login: 'diego-santos', name: 'Diego Santos' },
  { id: 13, login: 'noor-haddad', name: 'Noor Haddad' },
  { id: 14, login: 'kai-andersen', name: 'Kai Andersen' },
  { id: 15, login: 'ravi-menon', name: 'Ravi Menon' },
  { id: 16, login: 'jules-moreau', name: 'Jules Moreau' },
] as const;

// New automation. The logins are the REAL vendor slugs, because that is what the
// product's own classifier matches on (shared/types.ts AUTOMATION_VENDORS +
// REVIEW_BOTS) — a made-up login would be detected as a human and the whole Bots
// surface would be empty. `githubType: 'Bot'` where GitHub really reports one.
const GREPTILE = 20;
const CURSOR = 21;
const QODO = 22;
const DEVIN = 23;
const SWEEP = 24;
const RENOVATE = 25;
const SONAR = 26;

const BOTS = [
  { id: GREPTILE, login: 'greptile-apps', name: 'Greptile', type: 'Bot' },
  { id: CURSOR, login: 'cursor', name: 'Cursor Bugbot', type: 'Bot' },
  { id: QODO, login: 'qodo-ai', name: 'Qodo Merge', type: 'Bot' },
  { id: DEVIN, login: 'devin-ai-integration', name: 'Devin', type: 'Bot' },
  { id: SWEEP, login: 'sweep-ai', name: 'Sweep', type: 'Bot' },
  { id: RENOVATE, login: 'renovate', name: 'Renovate', type: 'Bot' },
  { id: SONAR, login: 'sonarqubecloud', name: 'SonarQube Cloud', type: 'Bot' },
] as const;

// ------------------------------------------------------------ the repos ------
// `createdAt` is load-bearing twice over: it is My Turn's per-repo "New PRs"
// cutoff, and it is the period-coverage clock (a period only counts a repo it
// can see the whole of). The two newest repositories are onboarded PART WAY
// through the reporting history ON PURPOSE — that is what puts a real
// "repositories onboarded mid-window" disclosure on the Reports page instead of
// a claim the data cannot back.
interface RepoSeed {
  id: number;
  name: string;
  description: string;
  ws: 'platform' | 'web';
  createdDaysAgo: number;
  /** Weekly pull-request volume at the START of the 90-day history. */
  baseRate: number;
  /** Weekly volume NOW — the ramp is the AI-adoption story. */
  peakRate: number;
  /** Which review vendors are installed here. */
  vendors: number[];
  /** Ordinary code a pull request in this repo touches. */
  paths: string[];
  /** The CONTRACT surfaces — migrations, schemas, IDL, IaC, auth. A pull request reaches one
   *  of these about a sixth of the time, which is what keeps "high reach" a minority verdict
   *  instead of the default. Uniform choice over one combined list made almost every pull
   *  request touch a migration, and a chip that says High about everything says nothing. */
  hot: string[];
  /** Paths that co-change enough to be hubs. Empty = this repo publishes no index. */
  hubs: [string, number][];
  trunk: 'green' | 'red';
}

export async function seedEstate(ctx: EstateCtx): Promise<EstateResult> {
  const { db, schema, now, day, platformWs, webWs, coderabbit, copilot, acmeCi } = ctx;
  const rnd = mulberry32(0x5eed_e57a);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const between = (lo: number, hi: number): number => lo + Math.floor(rnd() * (hi - lo + 1));
  const chance = (p: number): boolean => rnd() < p;
  const at = (daysAgo: number): Date => day(Math.max(0.02, daysAgo));

  const REPOS: RepoSeed[] = [
    {
      id: 4, name: 'design-system', description: 'Shared React components and design tokens',
      ws: 'web', createdDaysAgo: 112, baseRate: 3, peakRate: 7,
      vendors: [coderabbit, copilot],
      paths: [
        'src/components/Button.tsx', 'src/components/Dialog.tsx', 'src/components/Table.tsx',
        'src/tokens/color.ts', 'src/tokens/space.ts', 'src/hooks/useTheme.ts',
        'src/components/Menu.tsx', 'src/components/Toast.tsx', 'src/lib/focus.ts',
        'stories/Table.stories.tsx', 'src/components/__tests__/Dialog.test.tsx',
        'docs/theming.md',
      ],
      hot: ['src/index.d.ts', 'package.json'],
      hubs: [['src/tokens/color.ts', 31], ['src/components/Table.tsx', 19]],
      trunk: 'green',
    },
    {
      id: 5, name: 'mobile', description: 'React Native client for iOS and Android',
      ws: 'web', createdDaysAgo: 100, baseRate: 2, peakRate: 6,
      vendors: [coderabbit, CURSOR],
      paths: [
        'src/screens/Feed.tsx', 'src/screens/Settings.tsx', 'src/nav/RootStack.tsx',
        'src/api/client.ts', 'src/lib/push.ts', 'src/lib/format.ts',
        'src/screens/Profile.tsx', 'src/components/PrRow.tsx',
        'src/screens/__tests__/Feed.test.tsx',
      ],
      hot: ['src/api/schema/pr.ts', 'ios/Podfile', 'android/build.gradle'],
      hubs: [],
      trunk: 'green',
    },
    {
      id: 6, name: 'data-pipeline', description: 'Batch and streaming ETL for review analytics',
      ws: 'platform', createdDaysAgo: 112, baseRate: 4, peakRate: 11,
      vendors: [coderabbit, GREPTILE, QODO, SONAR],
      paths: [
        'dags/nightly_rollup.py', 'dags/stream_ingest.py', 'jobs/normalise_comments.py',
        'lib/warehouse.py', 'lib/dedupe.py', 'lib/retry.py', 'jobs/backfill_vendor.py',
        'dags/hourly_metrics.py', 'lib/clock.py', 'tests/test_normalise.py',
        'tests/test_dedupe.py',
      ],
      hot: [
        'migrations/0042_add_severity_index.sql', 'migrations/0043_backfill_vendor.sql',
        'schema/events.sql', 'openapi/ingest.yaml',
      ],
      hubs: [['lib/warehouse.py', 44], ['schema/events.sql', 27], ['lib/dedupe.py', 21]],
      trunk: 'green',
    },
    {
      id: 7, name: 'billing-service', description: 'Subscriptions, metering and invoices',
      ws: 'platform', createdDaysAgo: 112, baseRate: 3, peakRate: 9,
      vendors: [coderabbit, GREPTILE, CURSOR, copilot],
      paths: [
        'internal/billing/invoice.go', 'internal/billing/meter.go', 'internal/billing/plan.go',
        'internal/billing/proration.go', 'internal/http/handlers.go', 'cmd/server/main.go',
        'internal/store/invoice_repo.go', 'internal/billing/meter_test.go',
        'internal/billing/invoice_test.go',
      ],
      hot: [
        'internal/auth/token.go', 'internal/auth/permissions.go',
        'migrations/0018_invoice_lines.sql', 'api/billing.proto', 'charts/billing/values.yaml',
      ],
      hubs: [['internal/billing/meter.go', 38], ['internal/auth/token.go', 24]],
      trunk: 'red',
    },
    {
      id: 8, name: 'search-service', description: 'Cross-repo full-text and vector search',
      ws: 'platform', createdDaysAgo: 86, baseRate: 2, peakRate: 8,
      vendors: [GREPTILE, QODO, acmeCi],
      paths: [
        'src/index/writer.rs', 'src/index/reader.rs', 'src/query/parser.rs',
        'src/query/rank.rs', 'src/api/handlers.rs', 'src/index/segment.rs',
        'src/query/tokenise.rs', 'src/query/tests/parser.rs', 'src/index/tests/writer.rs',
      ],
      hot: ['migrations/0007_add_vectors.sql', 'Cargo.toml', 'k8s/search-deployment.yaml'],
      hubs: [],
      trunk: 'green',
    },
  ];

  // -------------------------------------------------------- users ------------
  await db
    .insert(schema.users)
    .values([
      ...HUMANS.map((h) => ({
        id: h.id, githubLogin: h.login, githubNodeId: `U_${h.login}`,
        displayName: h.name, isBot: false,
      })),
      ...BOTS.map((b) => ({
        id: b.id, githubLogin: b.login, githubNodeId: `U_${b.login}`,
        displayName: b.name, isBot: true, githubType: b.type,
      })),
    ])
    .execute();

  // -------------------------------------------------------- repos -----------
  await db
    .insert(schema.repos)
    .values(
      REPOS.map((r) => ({
        id: r.id, accountId: 1, owner: 'acme', name: r.name, githubNodeId: `R_${r.name}`,
        description: r.description, defaultBranch: 'main', defaultBranchName: 'main',
        createdAt: at(r.createdDaysAgo), viewerPermission: 'ADMIN',
        defaultBranchHeadSha: `trunk${r.id}${'0'.repeat(32)}`.slice(0, 40),
        defaultBranchCiStatus: r.trunk === 'red' ? 'failure' : 'success',
        defaultBranchUpdatedAt: at(r.trunk === 'red' ? 0.3 : 0.8),
      })),
    )
    .execute();
  await db
    .insert(schema.syncState)
    .values(
      REPOS.map((r) => ({
        repoId: r.id, lastFullSyncAt: at(7),
        lastIncrementalSyncAt: new Date(now.getTime() - 8 * 60_000),
        lastSyncStatus: 'ok',
      })),
    )
    .execute();

  const { assignReposToWorkspace } = await import('../src/db/queries.js');
  await assignReposToWorkspace(
    platformWs, 1, REPOS.filter((r) => r.ws === 'platform').map((r) => r.id),
  );
  await assignReposToWorkspace(webWs, 1, REPOS.filter((r) => r.ws === 'web').map((r) => r.id));

  // -------------------------------------------------- pull requests ----------
  // Titles read like real work. A code agent's pull request says so in its title
  // the way a real one does, because the point of the Feed's automation split is
  // that you can SEE which third of the board a machine opened.
  const HUMAN_WORK = [
    'Handle partial failures in the nightly rollup', 'Split the writer lock per shard',
    'Add a retry budget to the ingest client', 'Cache tokenised queries for 60s',
    'Emit structured logs from the meter', 'Drop the legacy invoice_lines index',
    'Paginate the comment normaliser', 'Tighten the permissions check on refunds',
    'Move rank tuning behind a feature flag', 'Backfill vendor ids on old rows',
    'Reduce cold-start time on the query path', 'Fix the off-by-one in bucket boundaries',
    'Make the dedupe pass idempotent', 'Add a dead-letter queue for failed batches',
    'Use a prepared statement for the hot read', 'Expose invoice totals on the API',
    'Guard the writer against clock skew', 'Normalise currency at the boundary',
    'Stop double-counting retried jobs', 'Add a health probe for the index reader',
    'Rework the theme token scale', 'Make Dialog focus-trap keyboard complete',
    'Virtualise the long table body', 'Ship the dark-mode token pass',
    'Fix Android keyboard inset on the feed', 'Add deep links for pull-request detail',
  ];
  const AGENT_WORK = [
    'Add missing null checks flagged by static analysis', 'Migrate remaining callbacks to async/await',
    'Add unit tests for the dedupe path', 'Replace deprecated crypto calls',
    'Extract the retry helper into lib/', 'Add types to the untyped API client',
    'Fix 14 lint errors in the ingest job', 'Convert class components to hooks',
    'Add error boundaries to the feed screens', 'Backfill docstrings on public helpers',
    'Remove unreachable branches in the parser', 'Harden input validation on handlers',
    'Add context propagation to the meter', 'Split the god-object in warehouse.py',
  ];
  const DEP_WORK = [
    'Update react to v18.3.1', 'Bump go.mod dependencies (7 updates)',
    'Update pytest to 8.3.2', 'Bump serde from 1.0.203 to 1.0.210',
    'Update the AWS SDK to 3.632.0', 'Bump @types/node to 22.5.0',
  ];

  interface Gen {
    id: number; repoId: number; authorId: number; title: string;
    state: 'open' | 'merged' | 'closed';
    openedDaysAgo: number; closedDaysAgo: number | null;
    files: { path: string; additions: number; deletions: number }[];
    additions: number; deletions: number;
    vendors: number[]; humanReviewers: number[];
    ci: 'success' | 'failure' | 'pending';
    mergeable: 'mergeable' | 'conflicting'; mss: 'clean' | 'dirty' | 'blocked' | 'unstable';
  }

  const gens: Gen[] = [];
  let prId = PR_BASE;

  for (const repo of REPOS) {
    // 13 weekly cohorts, oldest first, volume ramping from baseRate to peakRate.
    for (let w = 12; w >= 0; w--) {
      const t = (12 - w) / 12;
      const rate = Math.round(repo.baseRate + (repo.peakRate - repo.baseRate) * t);
      const liveWeeks = (repo.createdDaysAgo - w * 7) / 7;
      if (liveWeeks < 0) continue; // the repo did not exist yet
      for (let k = 0; k < rate; k++) {
        const openedDaysAgo = w * 7 + rnd() * 7;
        if (openedDaysAgo > repo.createdDaysAgo) continue;

        // Author mix — the AI-generation half of the thesis. Agents write a third
        // of everything in the busiest repos and the share GROWS with the ramp.
        const agentShare = 0.16 + 0.22 * t;
        const roll = rnd();
        let authorId: number;
        let title: string;
        if (roll < agentShare) {
          authorId = chance(0.62) ? DEVIN : SWEEP;
          title = pick(AGENT_WORK);
        } else if (roll < agentShare + 0.11) {
          authorId = chance(0.5) ? RENOVATE : ctx.dependabot;
          title = pick(DEP_WORK);
        } else {
          authorId = pick(HUMANS).id;
          title = pick(HUMAN_WORK);
        }
        const isDep = authorId === RENOVATE || authorId === ctx.dependabot;

        // State. Only the newest fortnight leaves pull requests open.
        let state: Gen['state'] = 'merged';
        let closedDaysAgo: number | null = null;
        if (openedDaysAgo < 13 && chance(0.42)) {
          state = 'open';
        } else if (chance(0.07)) {
          state = 'closed';
          closedDaysAgo = Math.max(0.1, openedDaysAgo - 1 - rnd() * 4);
        } else {
          const life = isDep ? 0.2 + rnd() * 1.2 : 0.6 + rnd() * 5.5;
          closedDaysAgo = openedDaysAgo - life;
          if (closedDaysAgo <= 0.1) state = 'open';
          else state = 'merged';
        }
        if (state === 'open') closedDaysAgo = null;

        // Files — the blast-radius input. A dependency bump touches one manifest;
        // an agent PR is wide and shallow; a human PR is narrow and deep.
        const nFiles = isDep ? 1 : authorId === DEVIN || authorId === SWEEP ? between(3, 9) : between(1, 5);
        const chosen = new Set<string>();
        if (isDep) {
          const manifest = repo.paths.find((p) =>
            /package\.json|go\.mod|requirements\.txt|Cargo\.toml|Podfile|build\.gradle/.test(p),
          );
          chosen.add(manifest ?? repo.paths[0]!);
        } else {
          // ~1 file in 7 comes from the contract surfaces, so a HIGH reading means
          // something. Guarded against a vocabulary that cannot fill the quota.
          let guard = 0;
          while (chosen.size < nFiles && guard++ < 60) {
            chosen.add(chance(0.14) && repo.hot.length ? pick(repo.hot) : pick(repo.paths));
          }
        }
        const files = [...chosen].map((p) => ({
          path: p,
          additions: isDep ? between(1, 6) : between(4, 90),
          deletions: isDep ? between(1, 6) : between(0, 40),
        }));
        const additions = files.reduce((a, f) => a + f.additions, 0);
        const deletions = files.reduce((a, f) => a + f.deletions, 0);

        // Reviewers. Every vendor installed in the repo reviews most pull requests
        // — that IS the volume problem. Humans review about two thirds of merges,
        // which is what leaves a real never-human-touched population for Chronology
        // to report separately instead of silently folding in.
        const vendors = repo.vendors.filter(() => chance(isDep ? 0.45 : 0.82));
        const humanReviewers: number[] = [];
        if (!isDep && chance(0.68)) {
          const n = chance(0.25) ? 2 : 1;
          const pool = HUMANS.map((h) => h.id).filter((h) => h !== authorId);
          while (humanReviewers.length < n) {
            const r = pick(pool);
            if (!humanReviewers.includes(r)) humanReviewers.push(r);
          }
        }

        const ci: Gen['ci'] =
          state === 'open' && chance(0.12) ? 'failure' : state === 'open' && chance(0.08) ? 'pending' : 'success';
        const conflicting = state === 'open' && chance(0.09);

        gens.push({
          id: prId++, repoId: repo.id, authorId, title, state,
          openedDaysAgo, closedDaysAgo, files, additions, deletions,
          vendors, humanReviewers, ci,
          mergeable: conflicting ? 'conflicting' : 'mergeable',
          mss: conflicting ? 'dirty' : ci === 'failure' ? 'blocked' : ci === 'pending' ? 'unstable' : 'clean',
        });
      }
    }
  }

  const CHECK_SETS: Record<number, string[]> = {
    4: ['build', 'lint', 'chromatic'],
    5: ['build', 'detox', 'lint'],
    6: ['pytest', 'ruff', 'dbt build'],
    7: ['go test', 'golangci-lint', 'buf breaking'],
    8: ['cargo test', 'clippy', 'fmt'],
  };

  await db
    .insert(schema.pullRequests)
    .values(
      gens.map((g) => {
        const opened = at(g.openedDaysAgo);
        const closed = g.closedDaysAgo != null ? at(g.closedDaysAgo) : null;
        const checks = CHECK_SETS[g.repoId]!;
        return {
          id: g.id, githubNodeId: `PR_est_${g.id}`, accountId: 1, repoId: g.repoId,
          number: g.id - PR_BASE + 300, title: g.title,
          body: null, authorId: g.authorId,
          mergedById: g.state === 'merged' ? (g.humanReviewers[0] ?? g.authorId) : null,
          baseRefName: 'main', headRefName: null, state: g.state, isDraft: g.state === 'open' && chance(0.07),
          openedAt: opened,
          firstReviewAt:
            g.vendors.length || g.humanReviewers.length
              ? at(Math.max(0.05, g.openedDaysAgo - 0.15))
              : null,
          lastCommitAt: closed ?? at(Math.max(0.05, g.openedDaysAgo - 0.4)),
          mergedAt: g.state === 'merged' ? closed : null,
          closedAt: g.state === 'merged' || g.state === 'closed' ? closed : null,
          updatedAt: closed ?? at(Math.max(0.05, g.openedDaysAgo - 0.4)),
          headSha: createHash('sha1').update(`est${g.id}`).digest('hex'),
          // A handful of merges land on a build that was not green — 'merge CI success'
          // reading a flat 100% is a number nobody believes.
          ciStatus: g.state === 'merged' ? (g.id % 17 === 0 ? 'failure' : 'success') : g.ci,
          mergeable: g.state === 'open' ? g.mergeable : null,
          mergeStateStatus: g.state === 'open' ? g.mss : null,
          reviewDecision:
            g.state === 'open' && g.humanReviewers.length
              ? (chance(0.45) ? 'approved' : 'review_required')
              : null,
          labels: null,
          checkRuns:
            g.state === 'open'
              ? checks.map((name, i) => ({
                  name,
                  state: g.ci === 'failure' && i === 0 ? 'failure' : g.ci === 'pending' && i === 1 ? 'pending' : 'success',
                  url: null, runId: null, jobId: null,
                }))
              : null,
          additions: g.additions, deletions: g.deletions, changedFiles: g.files.length,
          files: g.files,
        };
      }),
    )
    .execute();

  // ------------------------------------------- commits / reviews / threads ---
  let childId = CHILD_BASE;
  const nextId = (): number => childId++;

  const commitRows: Record<string, unknown>[] = [];
  const reviewRows: Record<string, unknown>[] = [];
  const threadRows: Record<string, unknown>[] = [];
  const commentRows: Record<string, unknown>[] = [];
  const labelSeeds: {
    repoId: number; prId: number; targetId: number; authorUserId: number;
    sev: 'nit' | 'minor' | 'major' | 'critical'; vendor: string | null;
    cats: string[]; body: string; createdAt: Date; isSummary: boolean;
  }[] = [];
  const eventRows: Record<string, unknown>[] = [];
  let eventId = EVENT_BASE;
  const ev = (
    repoId: number, actorId: number | null, prIdIn: number, type: string,
    occurredAt: Date, refTable: string | null = null, refId: number | null = null,
  ): void => {
    const id = eventId++;
    eventRows.push({
      id, accountId: 1, repoId, actorId, prId: prIdIn, type, occurredAt,
      refTable, refId, dedupeKey: `est:${type}:${prIdIn}:${id}`,
    });
  };

  // The bot findings. Written as real review comments would be: a claim about a
  // specific line, in the vendor's own register. The severity the ML model gives
  // it is the `sev` field; `vendor` is what the vendor's OWN badge said, which is
  // stored to be SHOWN and never believed — and where the two disagree is exactly
  // what the Inflation column measures.
  const FINDINGS: {
    text: string; sev: 'nit' | 'minor' | 'major' | 'critical'; cats: string[];
  }[] = [
    { text: 'This `await` inside the loop serialises every batch — hoist the promises and `Promise.all` them.', sev: 'major', cats: ['performance'] },
    { text: 'The error from `parse()` is swallowed here; a malformed payload will look like an empty result.', sev: 'major', cats: ['correctness_bug'] },
    { text: 'Consider renaming `d` to `deadline` — single letters read poorly at this depth.', sev: 'nit', cats: ['style_readability'] },
    { text: 'This index is not covered by the migration; the query plan will fall back to a sequential scan.', sev: 'major', cats: ['performance'] },
    { text: 'Missing null check: `user.profile` is optional in the type but dereferenced unconditionally.', sev: 'major', cats: ['correctness_bug'] },
    { text: 'Prefer a const assertion here so the literal union survives inference.', sev: 'nit', cats: ['style_readability'] },
    { text: 'The token is logged at info level — that lands in the shipped log stream.', sev: 'critical', cats: ['security'] },
    { text: 'This retry has no backoff, so a failing dependency gets hammered at full rate.', sev: 'major', cats: ['correctness_bug'] },
    { text: 'Docstring says the function returns cents; it returns a decimal amount.', sev: 'minor', cats: ['documentation'] },
    { text: 'Duplicate of the helper in `lib/dedupe.py` — worth extracting rather than a third copy.', sev: 'minor', cats: ['maintainability_refactor'] },
    { text: 'Trailing whitespace.', sev: 'nit', cats: ['nitpick'] },
    { text: 'This test asserts on the mock rather than the behaviour, so it passes if the call is removed.', sev: 'minor', cats: ['test_coverage'] },
    { text: 'The lock is held across an I/O call; under load this will serialise the whole shard.', sev: 'critical', cats: ['performance'] },
    { text: 'Consider extracting these three branches into a lookup table.', sev: 'nit', cats: ['maintainability_refactor'] },
    { text: 'Unbounded `limit` from the querystring reaches the database directly.', sev: 'critical', cats: ['security'] },
    { text: 'Off-by-one: the upper bound should be exclusive to match the half-open window elsewhere.', sev: 'major', cats: ['correctness_bug'] },
    { text: 'Add a unit test for the empty-input path — it is the one the caller hits first.', sev: 'minor', cats: ['test_coverage'] },
    { text: 'Import ordering differs from the rest of the package.', sev: 'nit', cats: ['nitpick'] },
  ];

  // Which vendors over-badge. CodeRabbit and Qodo lean high (their badge says
  // major where the model says minor); Greptile is calibrated; Cursor badges
  // nothing at all, which renders as "badges nothing" rather than a zero.
  const VENDOR_BADGE: Record<number, 'inflate' | 'calibrated' | 'none'> = {
    [coderabbit]: 'inflate', [QODO]: 'inflate', [GREPTILE]: 'calibrated',
    [copilot]: 'calibrated', [CURSOR]: 'none', [acmeCi]: 'none', [SONAR]: 'none',
  };
  const UP: Record<string, string> = { nit: 'minor', minor: 'major', major: 'critical', critical: 'critical' };

  for (const g of gens) {
    const opened = at(g.openedDaysAgo);
    const closed = g.closedDaysAgo != null ? at(g.closedDaysAgo) : null;
    ev(g.repoId, g.authorId, g.id, 'pr_opened', opened);
    if (g.state === 'merged' && closed) {
      ev(g.repoId, g.humanReviewers[0] ?? g.authorId, g.id, 'pr_merged', closed);
    }

    // commits
    const nCommits = between(1, 4);
    for (let c = 0; c < nCommits; c++) {
      const id = nextId();
      const when = at(Math.max(0.05, g.openedDaysAgo - c * 0.4));
      commitRows.push({
        id, sha: createHash('sha1').update(`c${g.id}:${c}`).digest('hex'),
        prId: g.id, authorId: g.authorId, committerId: g.authorId,
        message: null, committedAt: when,
      });
      ev(g.repoId, g.authorId, g.id, 'commit_pushed', when, 'commits', id);
    }

    // human reviews
    for (const h of g.humanReviewers) {
      const id = nextId();
      const when = at(Math.max(0.05, g.openedDaysAgo - 0.3 - rnd() * 2));
      reviewRows.push({
        id, githubNodeId: `RV_est_${id}`, prId: g.id, authorId: h,
        state: chance(0.8) ? 'approved' : 'changes_requested', body: null,
        databaseId: id, submittedAt: when,
      });
      ev(g.repoId, h, g.id, 'review_submitted', when, 'reviews', id);
    }

    // vendor reviews + their findings — the volume half of the thesis
    for (const v of g.vendors) {
      const rid = nextId();
      const when = at(Math.max(0.04, g.openedDaysAgo - 0.05 - rnd() * 0.3));
      reviewRows.push({
        id: rid, githubNodeId: `RV_est_${rid}`, prId: g.id, authorId: v,
        state: 'commented', body: null, databaseId: rid, submittedAt: when,
      });
      ev(g.repoId, v, g.id, 'review_submitted', when, 'reviews', rid);

      const nFindings = v === SONAR ? 1 : between(1, 6);
      for (let f = 0; f < nFindings; f++) {
        const finding = pick(FINDINGS);
        const file = pick(g.files).path;
        const tid = nextId();
        const cid = nextId();
        const created = at(Math.max(0.03, g.openedDaysAgo - 0.05 - rnd() * 0.4));

        // The derived state. A merged pull request's threads mostly got dealt
        // with; an open one's mostly did not — which is what makes the backlog
        // on the Bots page a real number rather than a decoration.
        const r = rnd();
        const derived =
          g.state === 'merged'
            ? r < 0.46 ? 'resolved' : r < 0.7 ? 'likely_addressed' : r < 0.82 ? 'replied_unresolved' : 'untouched'
            : r < 0.18 ? 'resolved' : r < 0.34 ? 'likely_addressed' : r < 0.46 ? 'replied_unresolved' : 'untouched';

        threadRows.push({
          id: tid, githubNodeId: `RT_est_${tid}`, prId: g.id, path: file,
          line: between(8, 240), isResolved: derived === 'resolved',
          isOutdated: false, derivedState: derived,
          addressedConfidence: derived === 'likely_addressed' ? 'medium' : 'none',
          addressedReason: derived === 'likely_addressed' ? 'commit-after' : null,
          resolvedByLogin: derived === 'resolved' ? pick(HUMANS).login : null,
          resolvedAt: derived === 'resolved' ? at(Math.max(0.02, g.openedDaysAgo - 1)) : null,
          originalCommenterId: v, createdAt: created,
        });
        commentRows.push({
          id: cid, githubNodeId: `RC_est_${cid}`, threadId: tid, prId: g.id,
          authorId: v, body: finding.text, excerpt: finding.text.slice(0, 120),
          diffHunk: null, databaseId: cid, createdAt: created,
        });
        ev(g.repoId, v, g.id, 'review_comment', created, 'review_threads', tid);

        const mode = VENDOR_BADGE[v] ?? 'none';
        const vendorSev =
          mode === 'none' ? null
          : mode === 'calibrated' ? finding.sev
          : chance(0.46) ? UP[finding.sev]! : finding.sev;
        labelSeeds.push({
          repoId: g.repoId, prId: g.id, targetId: cid, authorUserId: v,
          sev: finding.sev, vendor: vendorSev, cats: finding.cats,
          body: finding.text, createdAt: created, isSummary: false,
        });

        // A human replying is what returns the ball, and it is the only thing
        // that makes `replied_unresolved` honest.
        if (derived === 'replied_unresolved' || (derived === 'resolved' && chance(0.4))) {
          const rcid = nextId();
          const replyAt = at(Math.max(0.02, g.openedDaysAgo - 0.6 - rnd()));
          const replier = g.humanReviewers[0] ?? pick(HUMANS).id;
          commentRows.push({
            id: rcid, githubNodeId: `RC_est_${rcid}`, threadId: tid, prId: g.id,
            authorId: replier,
            body: pick([
              'Good catch — fixed in the follow-up commit.',
              'Deliberate: the caller already holds the lock.',
              'Agreed, done.',
              'This one is a false positive — the value is validated upstream.',
              'Split into its own issue so this can land.',
            ]),
            excerpt: null, diffHunk: null, databaseId: rcid, createdAt: replyAt,
          });
          ev(g.repoId, replier, g.id, 'review_comment', replyAt, 'review_threads', tid);
        }
      }
    }
  }

  const chunk = <T>(xs: T[], n: number): T[][] => {
    const out: T[][] = [];
    for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
    return out;
  };
  for (const c of chunk(commitRows, 400)) await db.insert(schema.commits).values(c).execute();
  for (const c of chunk(reviewRows, 400)) await db.insert(schema.reviews).values(c).execute();
  for (const c of chunk(threadRows, 400)) await db.insert(schema.reviewThreads).values(c).execute();
  for (const c of chunk(commentRows, 400)) await db.insert(schema.reviewComments).values(c).execute();
  for (const c of chunk(eventRows, 400)) await db.insert(schema.events).values(c).execute();

  const SEV_ORD = { nit: 0, minor: 1, major: 2, critical: 3 } as const;
  for (const c of chunk(labelSeeds, 400)) {
    await db
      .insert(schema.mlCommentLabels)
      .values(
        c.map((l) => ({
          accountId: 1, repoId: l.repoId, prId: l.prId, targetKind: 'review_comment',
          targetId: l.targetId, authorUserId: l.authorUserId,
          severity: l.sev, severityOrd: SEV_ORD[l.sev],
          severityProb: 0.61 + ((l.targetId * 7) % 32) / 100,
          vendorSeverity: l.vendor,
          vendorSeverityConfidence: l.vendor == null ? null : 'high',
          categories: l.cats, categoryProbs: {}, isSummary: l.isSummary,
          backend: 'modernbert-onnx', modelVersion: 'sev-2026-08-01',
          bodyHash: createHash('sha256').update(l.body).digest('hex'),
          targetCreatedAt: l.createdAt,
        })),
      )
      .execute();
  }

  // ------------------------------------------------- the bot objects ---------
  // One row per (workspace, actor) — the judgement, the identity and the price
  // in one place. Prices are the real published list prices, so the ROI panel's
  // "$ per acted-on thread" divides by something a reader can check.
  const price = (id: number): number | null =>
    id === GREPTILE ? 3000 : id === CURSOR ? 4000 : id === QODO ? 1900 : null;
  const label = (id: number): string =>
    BOTS.find((b) => b.id === id)?.name ?? 'Bot';
  const kindOf: Record<number, string> = {
    [GREPTILE]: 'greptile', [CURSOR]: 'cursor', [QODO]: 'qodo',
    [DEVIN]: 'devin', [SWEEP]: 'sweep', [RENOVATE]: 'renovate', [SONAR]: 'sonarqube',
  };
  const reviewerRows: Record<string, unknown>[] = [];
  const addReviewer = (ws: number, id: number, role: string): void => {
    reviewerRows.push({
      accountId: 1, workspaceId: ws, authorUserId: id, automated: true, role,
      confidence: 'high', source: 'vendor_login',
      reasonsJson: [`login "${BOTS.find((b) => b.id === id)?.login}" is a known ${label(id)} account`],
      kind: kindOf[id], label: label(id), identitySource: 'auto',
      monthlyCents: role === 'review' ? price(id) : null,
      updatedAt: now,
    });
  };
  // Platform: every vendor with a footprint in repos 6/7/8 (+ the existing two
  // from seed-demo.ts, which already have rows there).
  addReviewer(platformWs, GREPTILE, 'review');
  addReviewer(platformWs, CURSOR, 'review');
  addReviewer(platformWs, QODO, 'review');
  addReviewer(platformWs, SONAR, 'quality_check');
  addReviewer(platformWs, DEVIN, 'code_agent');
  addReviewer(platformWs, SWEEP, 'code_agent');
  addReviewer(platformWs, RENOVATE, 'dependency');
  // Web: CodeRabbit, Copilot and Cursor review there; the agents author there too.
  addReviewer(webWs, CURSOR, 'review');
  addReviewer(webWs, DEVIN, 'code_agent');
  addReviewer(webWs, SWEEP, 'code_agent');
  reviewerRows.push(
    {
      accountId: 1, workspaceId: webWs, authorUserId: coderabbit, automated: true,
      role: 'review', confidence: 'high', source: 'vendor_login',
      reasonsJson: ['login "coderabbitai" is a known CodeRabbit review bot'],
      kind: 'coderabbit', label: 'CodeRabbit', identitySource: 'auto',
      monthlyCents: 3000, updatedAt: now,
    },
    {
      accountId: 1, workspaceId: webWs, authorUserId: copilot, automated: true,
      role: 'review', confidence: 'high', source: 'vendor_login',
      reasonsJson: ['login "copilot-pull-request-reviewer" is a known Copilot review bot'],
      kind: 'copilot', label: 'Copilot', identitySource: 'auto',
      monthlyCents: 1900, updatedAt: now,
    },
  );
  await db.insert(schema.workspaceReviewers).values(reviewerRows).execute();

  // --------------------------------------------- the co-change index ---------
  // Only three of the eight repositories publish one, and that is the honest
  // answer rather than a gap: a repository whose files do not co-change has no
  // hubs to report, and a `?? 0` there would turn silence into a clean bill of
  // health on every pull request in it.
  await db
    .insert(schema.repoFileCoupling)
    .values(
      REPOS.filter((r) => r.hubs.length > 0).map((r) => ({
        accountId: 1, repoId: r.id,
        hubBar: Math.min(...r.hubs.map(([, d]) => d)),
        prCount: gens.filter((g) => g.repoId === r.id && g.state === 'merged').length,
        hubs: Object.fromEntries(r.hubs),
        builtAt: at(1.5),
      })),
    )
    .execute();

  // ------------------------------------------------- the trunk -------------
  // One repository's default branch is red right now (billing-service), and the
  // commit that broke it names the pull request that landed it.
  const branchRows: Record<string, unknown>[] = [];
  for (const r of REPOS) {
    for (let i = 0; i < 6; i++) {
      const landed = gens.filter((g) => g.repoId === r.id && g.state === 'merged');
      const src = landed[(i * 7) % Math.max(1, landed.length)];
      const red = r.trunk === 'red' && i === 0;
      branchRows.push({
        accountId: 1, repoId: r.id,
        sha: createHash('sha1').update(`trunk${r.id}:${i}`).digest('hex'),
        messageHeadline: src ? src.title : 'Merge pull request',
        authorUserId: src?.authorId ?? null,
        authorName: null, authorAvatarUrl: null,
        committedAt: at(0.3 + i * 0.8),
        ciStatus: red ? 'failure' : 'success',
        failingChecks: red ? [{ name: 'go test', state: 'failure', url: null }] : null,
        prNumber: src ? src.id - PR_BASE + 300 : null,
        createdAt: at(0.3 + i * 0.8),
      });
    }
  }
  await db.insert(schema.branchCommits).values(branchRows).execute();

  // ---- the curated repositories' file lists --------------------------------
  // seed-demo.ts's hand-written pull requests carry sizes but no per-file breakdown, and
  // without one `codeLocFor` returns null — which is honest ("we never measured this") but
  // left acme/api and acme/infrastructure reading "no reading" on a card whose whole job is
  // to compare repositories. Give them a breakdown consistent with the size they already
  // claim, so the two halves of the same pull request agree.
  const CURATED_PATHS: Record<number, string[]> = {
    1: ['src/Timeline.tsx', 'src/lib/lanes.ts', 'src/hooks/usePrs.ts', 'src/App.tsx', 'src/lib/format.ts'],
    2: ['src/sync/upsert.ts', 'src/db/queries.ts', 'src/api/routes/prs.ts', 'src/github/client.ts', 'src/sync/walk.ts'],
    3: ['terraform/eks.tf', 'terraform/vpc.tf', 'helm/api/values.yaml', 'terraform/iam.tf', 'scripts/deploy.sh'],
  };
  const curated = await db
    .select({
      id: schema.pullRequests.id, repoId: schema.pullRequests.repoId,
      additions: schema.pullRequests.additions, deletions: schema.pullRequests.deletions,
      changedFiles: schema.pullRequests.changedFiles, files: schema.pullRequests.files,
    })
    .from(schema.pullRequests)
    .execute();
  const { eq } = await import('drizzle-orm');
  for (const pr of curated) {
    if (pr.files != null || pr.repoId > 3) continue;
    const vocab = CURATED_PATHS[pr.repoId] ?? CURATED_PATHS[2]!;
    const n = Math.max(1, Math.min(vocab.length, pr.changedFiles ?? 1));
    const paths: string[] = [];
    for (let k = 0; k < n; k++) paths.push(vocab[(pr.id + k) % vocab.length]!);
    const add = pr.additions ?? 0;
    const del = pr.deletions ?? 0;
    const files = [...new Set(paths)].map((path, k, all) => ({
      path,
      additions: Math.max(1, Math.round(add / all.length)),
      deletions: Math.round(del / all.length),
    }));
    await db
      .update(schema.pullRequests)
      .set({ files })
      .where(eq(schema.pullRequests.id, pr.id))
      .execute();
  }

  return {
    repoIds: REPOS.map((r) => r.id),
    prIds: gens.map((g) => g.id),
    reviewBotIds: [coderabbit, copilot, GREPTILE, CURSOR, QODO, acmeCi],
  };
}
