// Demo data seeder — populates a THROWAWAY sqlite DB with a small, fictional
// team's activity (acme/web-app + acme/api + acme/infrastructure) for the
// README / landing-page screenshots. No real GitHub data, no PII. Dates are
// relative to "now": the recent curated PRs (101–116) fill the last ~8 days,
// a MID-RANGE band (120–134) spans 9–29 days ago, and three STALE open PRs
// (140–142) sit 20–28 days back — so the timeline shot at the 30-day preset
// shows a full month of activity with no empty horizontal gaps AND the
// open-PR strip reports a non-zero "stalled" count.
//
// The local account (id 1) is pinned to "Morgan Diaz" so the My Turn triage
// panel resolves: PRs awaiting Morgan's review and two #113 threads Morgan
// opened that someone else replied to. PR #113 also carries review threads (for
// the PR-detail shot) and a finished Claude Review run (for the Claude shot);
// PR #114 (acme/infrastructure) has failing CI plus a seeded AI CI-analysis and
// a succeeded AI Fix run (for the AI Analysis & Fix shot).
//
// When the PRIVATE @pierre/pro submodule is checked out (packages/pro), the
// seeder also applies the plugin's own migrations (with pro_migrations
// bookkeeping, so the backend's boot-time plugin migration is a no-op) and
// seeds the Pro tables: repo_digests (per-repo AI digest), sprint_reports,
// pro_settings, ai_pr_analyses + ai_fixes. Without the submodule those steps
// are skipped cleanly.
//
// Run against a throwaway DB (NEVER the real one):
//   pnpm --filter @pierre-review/backend seed:demo
//   (≡ DATABASE_URL=/tmp/pierre-demo.sqlite DISABLE_SCHEDULER=true tsx scripts/seed-demo.ts)
//
// ONE-COMMAND FLOWS (scripts/demo-stack.mjs, from the repo root) — these wrap
// everything below, gh-free PATH included:
//   pnpm demo    seed + boot the isolated demo stack (:4100/:5273), keep running
//   pnpm shots   seed → Pro shots → restart OSS → free shots → teardown
//
// Manual recipe: to (re)capture the landing screenshots from this data, run an
// ISOLATED stack against the demo DB so your real :4000/:5173 dev server is
// untouched, then drive scripts/capture-shots.mjs. NOTE: start the backend with
// `gh` OFF its PATH so ensureLocalAccount() can't overwrite the seeded "Morgan
// Diaz" identity with your real GitHub user (which empties the My Turn triage).
// Full recipe + the shot list in apps/landing/README.md ("Product screenshots"):
//   1. backend  : (gh off PATH, pro submodule checked out) \
//                 DATABASE_URL=/tmp/pierre-demo.sqlite PORT=4100 DISABLE_SCHEDULER=true \
//                 PRO_DIGEST_ENABLED=true PRO_ADVANCED_AI_ENABLED=true ANTHROPIC_API_KEY=dummy \
//                 node_modules/.bin/tsx src/index.ts   (from apps/backend)
//   2. frontend : BACKEND_PORT=4100 node_modules/.bin/vite --port 5273  (from apps/frontend)
//   3. capture  : node scripts/capture-shots.mjs       (all shots → apps/landing/public/shots/)
import { existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { config } from '../src/config.js';

if (!config.dbPath || config.dbPath.includes('pierre-review.sqlite')) {
  console.error(
    'Refusing to run: set DATABASE_URL to a throwaway path (not the real DB).',
  );
  process.exit(1);
}
// Delete any stale DB BEFORE importing client.ts (it opens the connection at
// module load, so importing first would leave us deleting an open file).
for (const suffix of ['', '-shm', '-wal']) {
  rmSync(config.dbPath + suffix, { force: true });
}

const { runMigrations } = await import('../src/db/run-migrations.js');
const { closeDb, db, schema } = await import('../src/db/client.js');
const { eq } = await import('drizzle-orm');

await runMigrations();

const now = new Date();
const day = (n: number): Date => new Date(now.getTime() - n * 86_400_000);
const min = (n: number): Date => new Date(now.getTime() - n * 60_000);

// ---- account (id 1 = "me" = Morgan Diaz) -----------------------------------
const ME = 1; // users.id for Morgan Diaz
await db
  .update(schema.accounts)
  .set({
    githubUserId: 'U_demo_morgan',
    githubLogin: 'morgan-diaz',
    // displayName must be set (and lastLoginAt fresh) so ensureLocalAccount() treats
    // the row as "fresh" and SKIPS the `gh api user` refresh — otherwise a server
    // started against this demo DB overwrites Morgan with the host's real GitHub
    // identity and the My Turn triage (which targets users.id 1 = Morgan) goes empty.
    displayName: 'Morgan Diaz',
    avatarUrl: null,
    isLocal: true,
    lastLoginAt: now,
  })
  .where(eq(schema.accounts.id, 1))
  .execute();

// ---- users (global) --------------------------------------------------------
await db
  .insert(schema.users)
  .values([
    { id: 1, githubLogin: 'morgan-diaz', githubNodeId: 'U_morgan', displayName: 'Morgan Diaz', isBot: false },
    { id: 2, githubLogin: 'priya-nair', githubNodeId: 'U_priya', displayName: 'Priya Nair', isBot: false },
    { id: 3, githubLogin: 'lena-fischer', githubNodeId: 'U_lena', displayName: 'Lena Fischer', isBot: false },
    { id: 4, githubLogin: 'tom-becker', githubNodeId: 'U_tom', displayName: 'Tom Becker', isBot: false },
    { id: 5, githubLogin: 'sam-carter', githubNodeId: 'U_sam', displayName: 'Sam Carter', isBot: false },
    { id: 6, githubLogin: 'wei-zhang', githubNodeId: 'U_wei', displayName: 'Wei Zhang', isBot: false },
    { id: 7, githubLogin: 'dependabot', githubNodeId: 'U_dep', displayName: 'dependabot', isBot: true },
    // A third-party AI review bot (login classified by reviewBotKind → vendor 'coderabbit'),
    // so the demo shows "the calm layer above your review bot": the PrDetail bot chip, the
    // feed bot lens + vendor tag, and the Insights bot signal-to-noise card.
    { id: 8, githubLogin: 'coderabbitai', githubNodeId: 'U_coderabbit', displayName: 'CodeRabbit', isBot: true },
  ])
  .execute();

const CODERABBIT = 8;

// ---- repos -----------------------------------------------------------------
const WEB = 1;
const API = 2;
const INFRA = 3;
await db
  .insert(schema.repos)
  .values([
    // inboxWatch=true so the watched-repo activity Feed populates (and new open PRs
    // by others surface in the My Turn inbox). inboxWatchStartedAt well in the past
    // so all the recent curated activity falls inside the Feed's 14-day window.
    // viewerPermission=ADMIN so write-gated UI (approve, AI Fix push controls) renders.
    { id: WEB, accountId: 1, owner: 'acme', name: 'web-app', githubNodeId: 'R_web', defaultBranch: 'main', createdAt: day(40), inboxWatch: true, inboxWatchStartedAt: day(40), viewerPermission: 'ADMIN' },
    { id: API, accountId: 1, owner: 'acme', name: 'api', githubNodeId: 'R_api', defaultBranch: 'main', createdAt: day(40), inboxWatch: true, inboxWatchStartedAt: day(40), viewerPermission: 'ADMIN' },
    { id: INFRA, accountId: 1, owner: 'acme', name: 'infrastructure', githubNodeId: 'R_infra', defaultBranch: 'main', createdAt: day(40), inboxWatch: true, inboxWatchStartedAt: day(40), viewerPermission: 'ADMIN' },
  ])
  .execute();
await db
  .insert(schema.syncState)
  .values([
    { repoId: WEB, lastFullSyncAt: day(7), lastIncrementalSyncAt: min(8), lastSyncStatus: 'ok' },
    { repoId: API, lastFullSyncAt: day(7), lastIncrementalSyncAt: min(8), lastSyncStatus: 'ok' },
    { repoId: INFRA, lastFullSyncAt: day(7), lastIncrementalSyncAt: min(8), lastSyncStatus: 'ok' },
  ])
  .execute();

// ---- pull requests ---------------------------------------------------------
// id == number for clarity (?pr=<id> opens the PR).
interface PrSeed {
  id: number;
  repoId: number;
  authorId: number;
  title: string;
  state: 'open' | 'merged' | 'closed';
  openedDaysAgo: number;
  closedDaysAgo?: number;
  mergedById?: number;
  ci?: 'success' | 'failure' | 'pending' | 'error';
  mergeable?: 'mergeable' | 'conflicting' | 'unknown';
  mss?: 'clean' | 'dirty' | 'blocked' | 'unstable';
  labels?: { name: string; color: string }[];
  checks?: { name: string; state: 'success' | 'failure' | 'pending' | 'neutral' | 'skipped' | 'error' | 'unknown'; url: string | null }[];
  // Source branch (headRefName). Ticket-key-shaped names (PLAT-292-…, INFRA-231-…)
  // light up the Pro Jira/Linear ticket-link detection in PR detail.
  head?: string;
  // Diff size [additions, deletions, changedFiles] — drives the PR-detail header
  // and the Claude Review router hint. Story PRs pin values consistent with their
  // seeded runs (#113 is small enough to route diff_only); everything else gets a
  // deterministic id-derived fallback so nothing reads "0 files · 0 lines".
  size?: [number, number, number];
}

const PRS: PrSeed[] = [
  { id: 101, repoId: WEB, authorId: 4, title: 'Fix layout shift on the open-PR strip', state: 'open', openedDaysAgo: 6, ci: 'success', mergeable: 'mergeable', mss: 'clean', labels: [{ name: 'ui', color: '1f6feb' }], checks: [{ name: 'build', state: 'success', url: null }, { name: 'lint', state: 'success', url: null }, { name: 'e2e', state: 'success', url: null }] },
  { id: 102, repoId: WEB, authorId: 1, title: 'Extract the timeline lane packer', state: 'merged', openedDaysAgo: 8, closedDaysAgo: 3, mergedById: 4, labels: [{ name: 'refactor', color: 'a371f7' }] },
  { id: 110, repoId: WEB, authorId: 2, title: 'Persist detail-pane height to localStorage', state: 'merged', openedDaysAgo: 7, closedDaysAgo: 5, mergedById: 1 },
  { id: 112, repoId: WEB, authorId: 3, title: 'Keyboard nav for the open-PR strip', state: 'open', openedDaysAgo: 5, ci: 'pending', mergeable: 'mergeable', mss: 'blocked', labels: [{ name: 'a11y', color: '0e8a16' }], checks: [{ name: 'build', state: 'success', url: null }, { name: 'e2e', state: 'pending', url: null }] },
  { id: 103, repoId: WEB, authorId: 7, title: 'Bump vite from 5.4.2 to 5.4.8', state: 'merged', openedDaysAgo: 2, closedDaysAgo: 2, mergedById: 1, labels: [{ name: 'dependencies', color: '0366d6' }] },
  { id: 104, repoId: API, authorId: 6, title: 'Cache changed-file paths per commit', state: 'merged', openedDaysAgo: 6, closedDaysAgo: 4, mergedById: 1, labels: [{ name: 'perf', color: 'd93f0b' }] },
  { id: 105, repoId: API, authorId: 5, title: 'Add review-request webhook handler', state: 'open', openedDaysAgo: 4, ci: 'success', mergeable: 'conflicting', mss: 'dirty', checks: [{ name: 'build', state: 'success', url: null }, { name: 'test', state: 'success', url: null }] },
  { id: 106, repoId: API, authorId: 1, title: 'Backfill mergedBy on historical PRs', state: 'merged', openedDaysAgo: 5, closedDaysAgo: 2, mergedById: 5 },
  { id: 111, repoId: API, authorId: 5, title: 'Stream sync progress over SSE', state: 'open', openedDaysAgo: 5, ci: 'success', mergeable: 'mergeable', mss: 'clean', labels: [{ name: 'enhancement', color: 'a2eeef' }], checks: [{ name: 'build', state: 'success', url: null }, { name: 'test', state: 'success', url: null }, { name: 'typecheck', state: 'success', url: null }] },
  { id: 113, repoId: API, authorId: 2, title: 'Refactor the upsert transaction boundaries', state: 'open', openedDaysAgo: 3, ci: 'success', mergeable: 'mergeable', mss: 'clean', head: 'PLAT-292-upsert-transaction-boundaries', size: [54, 18, 2], labels: [{ name: 'sync', color: 'fbca04' }, { name: 'needs-review', color: 'b60205' }], checks: [{ name: 'build', state: 'success', url: null }, { name: 'test', state: 'success', url: null }, { name: 'typecheck', state: 'success', url: null }] },
  // acme/infrastructure — #114 is the AI-fix story: an open PR with a failing
  // `terraform plan` check (+ a seeded CI analysis and a succeeded AI Fix run when
  // the pro submodule is present).
  { id: 114, repoId: INFRA, authorId: 6, title: 'Terraform: right-size the EKS node-group autoscaling', state: 'open', openedDaysAgo: 2, ci: 'failure', mergeable: 'mergeable', mss: 'blocked', head: 'INFRA-231-eks-autoscaling-limits', size: [21, 9, 1], labels: [{ name: 'terraform', color: '5319e7' }, { name: 'infra', color: '0e8a16' }], checks: [{ name: 'terraform plan', state: 'failure', url: null }, { name: 'tflint', state: 'success', url: null }, { name: 'checkov', state: 'success', url: null }] },
  { id: 115, repoId: INFRA, authorId: 3, title: 'Helm: split ingress values per environment', state: 'merged', openedDaysAgo: 7, closedDaysAgo: 4, mergedById: 1, labels: [{ name: 'helm', color: '1d76db' }] },
  { id: 116, repoId: INFRA, authorId: 5, title: 'Add CloudWatch alarms for queue depth and DLQ age', state: 'open', openedDaysAgo: 4, ci: 'success', mergeable: 'mergeable', mss: 'clean', head: 'INFRA-244-cloudwatch-queue-alarms', labels: [{ name: 'monitoring', color: 'd93f0b' }], checks: [{ name: 'terraform plan', state: 'success', url: null }, { name: 'tflint', state: 'success', url: null }] },

  // ---- MID-RANGE curated band (ids 120–134) ------------------------------
  // Fills the 9–29-day span so the 30-day board reads as a full month of work
  // with no empty horizontal gaps. Mostly merged, a few closed-unmerged, one
  // dependabot PR (#133). Wired exactly like the entries above: the commit +
  // event loops below pick these up from `prRows` automatically, and their
  // reviews are appended to REVIEWS (ids 8–22). Child-entity ids stay clear of
  // the curated (≤116 / reviews 1–7 / threads 1–5) and history (≥200 / ≥5000)
  // ranges. lastCommitAt for merged PRs = close instant (see prRows mapping).
  // acme/web-app
  { id: 120, repoId: WEB, authorId: 2, title: 'Virtualize the open-PR strip cards', state: 'merged', openedDaysAgo: 12, closedDaysAgo: 10, mergedById: 4, labels: [{ name: 'perf', color: 'd93f0b' }] },
  { id: 121, repoId: WEB, authorId: 3, title: 'Lazy-load the Insights charts', state: 'merged', openedDaysAgo: 16, closedDaysAgo: 14, mergedById: 1 },
  { id: 122, repoId: WEB, authorId: 4, title: 'Add a custom date-range preset', state: 'merged', openedDaysAgo: 22, closedDaysAgo: 20, mergedById: 2, labels: [{ name: 'ui', color: '1f6feb' }] },
  { id: 123, repoId: WEB, authorId: 5, title: 'Improve dark-mode contrast on markers', state: 'closed', openedDaysAgo: 26, closedDaysAgo: 24 },
  { id: 124, repoId: WEB, authorId: 1, title: 'Cache PR detail in IndexedDB', state: 'merged', openedDaysAgo: 28, closedDaysAgo: 26, mergedById: 3, labels: [{ name: 'perf', color: 'd93f0b' }] },
  // acme/api
  { id: 125, repoId: API, authorId: 6, title: 'Add an index on events(repo_id, occurred_at)', state: 'merged', openedDaysAgo: 10, closedDaysAgo: 9, mergedById: 1, labels: [{ name: 'perf', color: 'd93f0b' }] },
  { id: 126, repoId: API, authorId: 5, title: 'Cancel in-flight syncs cleanly', state: 'merged', openedDaysAgo: 14, closedDaysAgo: 12, mergedById: 6 },
  { id: 127, repoId: API, authorId: 2, title: 'Two-phase backfill for new repos', state: 'merged', openedDaysAgo: 19, closedDaysAgo: 17, mergedById: 4, labels: [{ name: 'sync', color: 'fbca04' }] },
  { id: 128, repoId: API, authorId: 4, title: 'Add overlap window to incremental sync', state: 'closed', openedDaysAgo: 23, closedDaysAgo: 21 },
  { id: 129, repoId: API, authorId: 1, title: 'Scope every getter to accountId', state: 'merged', openedDaysAgo: 27, closedDaysAgo: 25, mergedById: 5, labels: [{ name: 'security', color: 'b60205' }] },
  // acme/infrastructure
  { id: 130, repoId: INFRA, authorId: 3, title: 'Pin the K8s node AMI and roll the node groups', state: 'merged', openedDaysAgo: 11, closedDaysAgo: 9, mergedById: 6, labels: [{ name: 'infra', color: '0e8a16' }] },
  { id: 131, repoId: INFRA, authorId: 6, title: 'Terraform: move state locking to DynamoDB', state: 'merged', openedDaysAgo: 15, closedDaysAgo: 13, mergedById: 3, labels: [{ name: 'terraform', color: '5319e7' }] },
  { id: 132, repoId: INFRA, authorId: 5, title: 'Add Grafana dashboards for API latency', state: 'merged', openedDaysAgo: 21, closedDaysAgo: 19, mergedById: 1, labels: [{ name: 'monitoring', color: 'd93f0b' }] },
  { id: 133, repoId: INFRA, authorId: 7, title: 'Bump aws-sdk from 3.540.0 to 3.556.0', state: 'merged', openedDaysAgo: 24, closedDaysAgo: 23, mergedById: 1, labels: [{ name: 'dependencies', color: '0366d6' }] },
  { id: 134, repoId: INFRA, authorId: 3, title: 'Enable VPC flow logs for the private subnets', state: 'closed', openedDaysAgo: 29, closedDaysAgo: 27 },

  // ---- STALE open PRs (ids 140–142, one per repo) ------------------------
  // Opened 20–28d ago, still open, last commit far in the past (the prRows
  // mapping sets lastCommitAt = openedDaysAgo − 3 for open PRs → 17–25d ago,
  // well past config.stallThresholdDays = 3). Each carries ≥1 untouched /
  // replied_unresolved thread (STALE_THREADS below) so isStalled() trips. NO
  // review request from Morgan, CI green, no conflicts, non-Morgan author → the
  // triage cascade lands on reasonTag 'stalled' (OpenPrsStrip "N stalled" > 0).
  { id: 140, repoId: WEB, authorId: 4, title: 'Rework the timeline clustering thresholds', state: 'open', openedDaysAgo: 20, ci: 'success', mergeable: 'mergeable', mss: 'clean', labels: [{ name: 'ui', color: '1f6feb' }], checks: [{ name: 'build', state: 'success', url: null }, { name: 'e2e', state: 'success', url: null }] },
  { id: 141, repoId: API, authorId: 5, title: 'Migrate the sync scheduler to a job queue', state: 'open', openedDaysAgo: 25, ci: 'success', mergeable: 'mergeable', mss: 'clean', labels: [{ name: 'sync', color: 'fbca04' }], checks: [{ name: 'build', state: 'success', url: null }, { name: 'test', state: 'success', url: null }] },
  { id: 142, repoId: INFRA, authorId: 6, title: 'Terraform: migrate remote state to S3 + DynamoDB', state: 'open', openedDaysAgo: 28, ci: 'success', mergeable: 'mergeable', mss: 'clean', head: 'INFRA-260-remote-state-migration', labels: [{ name: 'terraform', color: '5319e7' }], checks: [{ name: 'terraform plan', state: 'success', url: null }, { name: 'tflint', state: 'success', url: null }] },
];

const prRows = PRS.map((p) => {
  const opened = day(p.openedDaysAgo);
  const closed = p.closedDaysAgo != null ? day(p.closedDaysAgo) : null;
  const lastCommit = p.state === 'merged' ? closed : day(Math.max(1, p.openedDaysAgo - 3));
  const [additions, deletions, changedFiles] = p.size ?? [
    20 + ((p.id * 37) % 220),
    4 + ((p.id * 13) % 60),
    1 + ((p.id * 7) % 9),
  ];
  return {
    additions,
    deletions,
    changedFiles,
    id: p.id,
    githubNodeId: `PR_${p.id}`,
    accountId: 1,
    repoId: p.repoId,
    number: p.id,
    title: p.title,
    body: `Demo PR — ${p.title}.`,
    authorId: p.authorId,
    mergedById: p.state === 'merged' ? (p.mergedById ?? p.authorId) : null,
    baseRefName: 'main',
    headRefName: p.head ?? null,
    state: p.state,
    isDraft: false,
    openedAt: opened,
    firstReviewAt: p.state === 'open' ? day(Math.max(1, p.openedDaysAgo - 1)) : closed,
    lastCommitAt: lastCommit,
    mergedAt: p.state === 'merged' ? closed : null,
    closedAt: p.state === 'merged' ? closed : null,
    updatedAt: lastCommit ?? opened,
    headSha: `sha${p.id}headcommit`,
    // A merged PR passed CI to land — default it to green (unless the seed pins a status).
    // Drives the Flow-metrics "Merge CI success %" tile, which counts merged-in-sprint PRs
    // by ciStatus; without this the recent merges (which set no `ci`) read as 0% success.
    ciStatus: p.ci ?? (p.state === 'merged' ? 'success' : null),
    mergeable: p.mergeable ?? null,
    mergeStateStatus: p.mss ?? null,
    labels: p.labels ?? null,
    // runId/jobId are only set for real GitHub Actions checks (parsed from the
    // detailsUrl during sync); the demo's synthetic checks aren't loggable.
    checkRuns: p.checks
      ? p.checks.map((c) => ({ ...c, runId: null, jobId: null }))
      : null,
  };
});
await db.insert(schema.pullRequests).values(prRows).execute();

// ---- review requests (drive "awaiting your review") ------------------------
await db
  .insert(schema.reviewRequests)
  .values([
    { prId: 111, userId: ME }, // Sam's PR — awaiting Morgan
    { prId: 111, userId: 6 }, //  also Wei → "also requested 1"
    { prId: 112, userId: ME }, // Lena's PR — awaiting Morgan
    { prId: 112, userId: 4 }, //  also Tom → "also requested 1"
    { prId: 113, teamName: 'platform' }, // a team request, shown in detail
    { prId: 116, userId: ME }, // Sam's infra PR — awaiting Morgan
  ])
  .execute();

// ---- review threads + comments on #113 -------------------------------------
interface ThreadSeed {
  id: number;
  path: string;
  line: number;
  resolved: boolean;
  derived: 'resolved' | 'likely_addressed' | 'replied_unresolved' | 'untouched';
  opener: number;
  createdDaysAgo: number;
  comments: { author: number; body: string; daysAgo: number }[];
}

// daysAgo values are fractional so the files sort the way the shot wants:
// upsert.ts (the threads Morgan opened, surfaced in My Turn) newest → first.
const THREADS: ThreadSeed[] = [
  {
    id: 1, path: 'src/sync/upsert.ts', line: 88, resolved: false, derived: 'replied_unresolved', opener: ME, createdDaysAgo: 1.6,
    comments: [
      { author: ME, body: 'Can we batch these inserts? We do one INSERT per row inside the loop.', daysAgo: 1.6 },
      { author: 2, body: 'Batched in the latest push — now a single multi-row upsert.', daysAgo: 0.7 },
    ],
  },
  {
    id: 2, path: 'src/sync/upsert.ts', line: 142, resolved: false, derived: 'replied_unresolved', opener: ME, createdDaysAgo: 1.7,
    comments: [
      { author: ME, body: 'Should this run inside the same transaction as the PR upsert?', daysAgo: 1.7 },
      { author: 2, body: 'Good catch — moved it under runTransaction.', daysAgo: 0.6 },
    ],
  },
  {
    id: 4, path: 'src/db/queries.ts', line: 210, resolved: false, derived: 'untouched', opener: 5, createdDaysAgo: 2.4,
    comments: [
      { author: 5, body: 'Is the EXISTS subquery indexed? Could be slow on large event tables.', daysAgo: 2.4 },
    ],
  },
  {
    id: 5, path: 'src/db/queries.ts', line: 224, resolved: false, derived: 'likely_addressed', opener: 6, createdDaysAgo: 2.5,
    comments: [
      { author: 6, body: 'Consider batching these per-PR lookups into one query.', daysAgo: 2.5 },
    ],
  },
  {
    id: 3, path: 'src/sync/scheduler.ts', line: 40, resolved: true, derived: 'resolved', opener: 3, createdDaysAgo: 2.6,
    comments: [
      { author: 3, body: 'nit: pull this 5-minute interval into a named constant.', daysAgo: 2.6 },
      { author: 2, body: 'Done — extracted SYNC_INTERVAL_MS.', daysAgo: 2.1 },
    ],
  },
  // CodeRabbit (a third-party AI review bot) left 6 inline comments on this PR — the exact
  // firehose Pierre triages. Mix of states so the demo shows the chip ("CodeRabbit · 6 · 3
  // unresolved"), the acted-on rate (50%), and the bulk-resolve of the 2 likely-addressed.
  {
    id: 6, path: 'src/db/queries.ts', line: 318, resolved: false, derived: 'untouched', opener: CODERABBIT, createdDaysAgo: 2.3,
    comments: [
      { author: CODERABBIT, body: '_⚠️ Potential issue_ — `botUserIds()` runs a full-table scan on every feed request. Consider caching the id set or gating it behind `excludeBots`.', daysAgo: 2.3 },
    ],
  },
  {
    id: 7, path: 'src/sync/upsert.ts', line: 91, resolved: false, derived: 'untouched', opener: CODERABBIT, createdDaysAgo: 2.3,
    comments: [
      { author: CODERABBIT, body: '_🛠️ Refactor suggestion_ — the `case when` for `is_bot` duplicates the override logic already in `setUserBot`. Extract a shared helper to avoid drift.', daysAgo: 2.3 },
    ],
  },
  {
    id: 8, path: 'src/db/queries.ts', line: 341, resolved: false, derived: 'replied_unresolved', opener: CODERABBIT, createdDaysAgo: 2.3,
    comments: [
      { author: CODERABBIT, body: '_🧹 Nitpick_ — `emptyCounts()` allocates a new object per PR in the loop; hoist a frozen zero-count and clone only when writing.', daysAgo: 2.3 },
      { author: ME, body: 'Micro-opt — leaving as-is for readability; the loop is bounded by open PRs.', daysAgo: 1.9 },
    ],
  },
  {
    id: 9, path: 'src/sync/derive-thread-state.ts', line: 52, resolved: false, derived: 'likely_addressed', opener: CODERABBIT, createdDaysAgo: 2.4,
    comments: [
      { author: CODERABBIT, body: '_⚠️ Potential issue_ — a renamed file will read as `untouched` because the commit-file match is path-exact. Worth a comment noting the known false-negative.', daysAgo: 2.4 },
    ],
  },
  {
    id: 10, path: 'src/sync/upsert.ts', line: 60, resolved: false, derived: 'likely_addressed', opener: CODERABBIT, createdDaysAgo: 2.4,
    comments: [
      { author: CODERABBIT, body: '_🛠️ Refactor suggestion_ — prefer `onConflictDoUpdate` here over the read-modify-write; it removes a round-trip and the race window.', daysAgo: 2.4 },
    ],
  },
  {
    id: 11, path: 'src/db/schema.sqlite.ts', line: 127, resolved: true, derived: 'resolved', opener: CODERABBIT, createdDaysAgo: 2.5,
    comments: [
      { author: CODERABBIT, body: '_🧹 Nitpick_ — `is_bot_overridden` has no index but is filtered in the upsert. Negligible at this scale; flagging for completeness.', daysAgo: 2.5 },
      { author: 2, body: 'Acknowledged — not worth an index here.', daysAgo: 2.2 },
    ],
  },
];

await db
  .insert(schema.reviewThreads)
  .values(
    THREADS.map((t) => ({
      id: t.id,
      githubNodeId: `RT_${t.id}`,
      prId: 113,
      path: t.path,
      line: t.line,
      isResolved: t.resolved,
      isOutdated: false,
      derivedState: t.derived,
      originalCommenterId: t.opener,
      createdAt: day(t.createdDaysAgo),
    })),
  )
  .execute();

let commentId = 1;
const reviewCommentRows = THREADS.flatMap((t) =>
  t.comments.map((c) => {
    const body = c.body;
    return {
      id: commentId,
      githubNodeId: `RC_${commentId++}`,
      threadId: t.id,
      prId: 113,
      authorId: c.author,
      body,
      excerpt: body.length > 160 ? `${body.slice(0, 159)}…` : body,
      diffHunk: `@@ -${t.line},3 +${t.line},4 @@`,
      databaseId: `${1_000_000 + t.id * 10 + 0}`,
      createdAt: day(c.daysAgo),
    };
  }),
);
await db.insert(schema.reviewComments).values(reviewCommentRows).execute();

// ---- stale-PR review threads (ids 300+) ------------------------------------
// Each stale open PR (140–142) needs ≥1 untouched / replied_unresolved thread
// so buildThreadCounts → isStalled() fires. Dedicated id band (threads 300+,
// comments 300+) clear of the curated (1–5 / 1–10) and history (≥5000) ranges.
// Comments (and thread creation) are dated to each PR's early life (≥17d ago),
// so there is no recent activity — the PR reads as genuinely stale.
interface StaleThreadSeed {
  id: number;
  prId: number;
  path: string;
  line: number;
  derived: 'untouched' | 'replied_unresolved';
  opener: number;
  createdDaysAgo: number;
  comments: { author: number; body: string; daysAgo: number }[];
}
const STALE_THREADS: StaleThreadSeed[] = [
  {
    id: 300, prId: 140, path: 'src/components/Timeline/clustering.ts', line: 64, derived: 'untouched', opener: 2, createdDaysAgo: 18,
    comments: [{ author: 2, body: 'These thresholds feel arbitrary — can we derive them from the visible span?', daysAgo: 18 }],
  },
  {
    id: 301, prId: 140, path: 'src/components/Timeline/clustering.ts', line: 128, derived: 'replied_unresolved', opener: 3, createdDaysAgo: 18.2,
    comments: [
      { author: 3, body: 'Does this still cluster correctly at the 90-day preset?', daysAgo: 18.2 },
      { author: 4, body: 'Need to double-check that case before this is ready.', daysAgo: 17.5 },
    ],
  },
  {
    id: 302, prId: 141, path: 'src/sync/scheduler.ts', line: 52, derived: 'untouched', opener: 1, createdDaysAgo: 23,
    comments: [{ author: 1, body: 'How does the job queue handle a worker dying mid-sync? Needs a retry story.', daysAgo: 23 }],
  },
  {
    id: 303, prId: 142, path: 'terraform/backend.tf', line: 12, derived: 'untouched', opener: 3, createdDaysAgo: 26,
    comments: [{ author: 3, body: 'We should migrate the existing state before flipping the backend, or applies will fail.', daysAgo: 26 }],
  },
];
await db
  .insert(schema.reviewThreads)
  .values(
    STALE_THREADS.map((t) => ({
      id: t.id,
      githubNodeId: `RT_${t.id}`,
      prId: t.prId,
      path: t.path,
      line: t.line,
      isResolved: false,
      isOutdated: false,
      derivedState: t.derived,
      originalCommenterId: t.opener,
      createdAt: day(t.createdDaysAgo),
    })),
  )
  .execute();

let staleCommentId = 300;
const staleCommentRows = STALE_THREADS.flatMap((t) =>
  t.comments.map((c) => ({
    id: staleCommentId,
    githubNodeId: `RC_${staleCommentId++}`,
    threadId: t.id,
    prId: t.prId,
    authorId: c.author,
    body: c.body,
    excerpt: c.body.length > 160 ? `${c.body.slice(0, 159)}…` : c.body,
    diffHunk: `@@ -${t.line},3 +${t.line},4 @@`,
    databaseId: `${1_200_000 + t.id * 10}`,
    createdAt: day(c.daysAgo),
  })),
);
await db.insert(schema.reviewComments).values(staleCommentRows).execute();

// ---- reviews (approvers + review markers) ----------------------------------
interface ReviewSeed { id: number; prId: number; author: number; state: 'approved' | 'changes_requested' | 'commented'; daysAgo: number; body?: string }
const REVIEWS: ReviewSeed[] = [
  { id: 1, prId: 102, author: 4, state: 'approved', daysAgo: 3, body: 'LGTM — clean extraction.' },
  { id: 2, prId: 104, author: 1, state: 'approved', daysAgo: 4, body: 'Nice, the cache is a big win.' },
  { id: 3, prId: 106, author: 5, state: 'approved', daysAgo: 2, body: 'Approved.' },
  { id: 4, prId: 113, author: 5, state: 'commented', daysAgo: 1, body: 'A few questions inline.' },
  { id: 5, prId: 111, author: 6, state: 'commented', daysAgo: 2, body: 'Left some notes.' },
  { id: 6, prId: 115, author: 1, state: 'approved', daysAgo: 4.2, body: 'Per-env values layout is much cleaner — nice.' },
  { id: 7, prId: 114, author: 4, state: 'commented', daysAgo: 1.2, body: 'The min_size bump looks unintentional — see the failing plan diff.' },
  // MID-RANGE band reviews (ids 8–22): an approving review just before each
  // merge, and a commented / changes_requested review on the closed-unmerged
  // ones. daysAgo sits between each PR's open and close so review_submitted
  // events (emitted from REVIEWS below) land inside the PR's lifetime.
  { id: 8, prId: 120, author: 4, state: 'approved', daysAgo: 10.5, body: 'Nice — the strip is smooth now even with hundreds of PRs.' },
  { id: 9, prId: 121, author: 1, state: 'approved', daysAgo: 14.5, body: 'Charts only load when the panel opens now. LGTM.' },
  { id: 10, prId: 122, author: 2, state: 'approved', daysAgo: 20.5, body: 'Custom range works well.' },
  { id: 11, prId: 123, author: 4, state: 'commented', daysAgo: 25, body: 'Superseded by the theme-token work — closing.' },
  { id: 12, prId: 124, author: 3, state: 'approved', daysAgo: 26.5, body: 'IndexedDB cache is a solid win for detail loads.' },
  { id: 13, prId: 125, author: 1, state: 'approved', daysAgo: 9.5, body: 'Index makes the feed query much snappier.' },
  { id: 14, prId: 126, author: 6, state: 'approved', daysAgo: 12.5, body: 'Cancellation is clean now.' },
  { id: 15, prId: 127, author: 4, state: 'approved', daysAgo: 17.5, body: 'Two-phase backfill fills the board fast — great.' },
  { id: 16, prId: 128, author: 1, state: 'changes_requested', daysAgo: 22.5, body: 'The overlap window double-counts events near the boundary — let’s revisit.' },
  { id: 17, prId: 129, author: 5, state: 'approved', daysAgo: 25.5, body: 'Every getter is account-scoped now. Approved.' },
  { id: 18, prId: 130, author: 6, state: 'approved', daysAgo: 9.5, body: 'AMI pin + rolling update looks right.' },
  { id: 19, prId: 131, author: 3, state: 'approved', daysAgo: 13.5, body: 'DynamoDB state locking is the right call.' },
  { id: 20, prId: 132, author: 1, state: 'approved', daysAgo: 19.5, body: 'Dashboards are useful. Merging.' },
  { id: 21, prId: 133, author: 1, state: 'approved', daysAgo: 23.5, body: 'Routine SDK bump, CI green.' },
  { id: 22, prId: 134, author: 5, state: 'commented', daysAgo: 28, body: 'Flow logs got folded into the VPC module rewrite — closing this one.' },
  // CodeRabbit's top-level review on #113 (it posts a COMMENTED review + inline threads) —
  // gives the feed a "CodeRabbit reviewed" row with the vendor tag.
  { id: 23, prId: 113, author: CODERABBIT, state: 'commented', daysAgo: 2.3, body: '**CodeRabbit summary** — 6 comments across 4 files. 2 potential issues, 2 refactor suggestions, 2 nitpicks. See the inline threads.' },
];
await db
  .insert(schema.reviews)
  .values(
    REVIEWS.map((r) => ({
      id: r.id,
      githubNodeId: `RV_${r.id}`,
      prId: r.prId,
      authorId: r.author,
      state: r.state,
      body: r.body ?? null,
      databaseId: `${2_000_000 + r.id}`,
      submittedAt: day(r.daysAgo),
    })),
  )
  .execute();

// ---- PR (issue-level) comments ---------------------------------------------
await db
  .insert(schema.prComments)
  .values([
    { id: 1, githubNodeId: 'PC_1', prId: 113, authorId: 4, body: 'Left a couple of thoughts on the transaction boundaries — otherwise looks great.', databaseId: '3000001', createdAt: day(1) },
    { id: 2, githubNodeId: 'PC_2', prId: 105, authorId: 1, body: 'Heads up: this conflicts with main after #106 landed.', databaseId: '3000002', createdAt: day(1) },
    { id: 3, githubNodeId: 'PC_3', prId: 114, authorId: 1, body: '`terraform plan` is red on the staging workspace — looks like the autoscaling bounds got inverted in the last push.', databaseId: '3000003', createdAt: day(0.9) },
  ])
  .execute();

// ---- commits ---------------------------------------------------------------
let commitDbId = 1;
const commitRows: { id: number; sha: string; prId: number; authorId: number; committerId: number; message: string; committedAt: Date }[] = [];
for (const p of prRows) {
  const first = p.openedAt;
  const second = p.lastCommitAt ?? p.openedAt;
  commitRows.push({ id: commitDbId++, sha: `${p.headSha}-1`, prId: p.id, authorId: p.authorId!, committerId: p.authorId!, message: `${p.title}`, committedAt: first });
  if (second.getTime() !== first.getTime()) {
    commitRows.push({ id: commitDbId++, sha: `${p.headSha}-2`, prId: p.id, authorId: p.authorId!, committerId: p.authorId!, message: `Address review feedback`, committedAt: second });
  }
}
await db.insert(schema.commits).values(commitRows).execute();

// ---- events (the timeline feed) --------------------------------------------
let evId = 1;
const events: {
  id: number; accountId: number; repoId: number; actorId: number | null; prId: number | null;
  type: 'pr_opened' | 'pr_merged' | 'pr_closed' | 'review_submitted' | 'review_comment' | 'pr_comment' | 'commit_pushed';
  occurredAt: Date; refTable: string | null; refId: number | null; dedupeKey: string;
}[] = [];
const ev = (
  repoId: number, actorId: number | null, prId: number | null, type: typeof events[number]['type'],
  occurredAt: Date, refTable: string | null = null, refId: number | null = null,
): void => {
  const id = evId++;
  events.push({ id, accountId: 1, repoId, actorId, prId, type, occurredAt, refTable, refId, dedupeKey: `${type}:${prId}:${id}` });
};

for (const p of prRows) {
  ev(p.repoId, p.authorId, p.id, 'pr_opened', p.openedAt);
  if (p.state === 'merged' && p.mergedAt) ev(p.repoId, p.mergedById ?? p.authorId, p.id, 'pr_merged', p.mergedAt);
}
for (const c of commitRows) {
  const pr = prRows.find((p) => p.id === c.prId)!;
  ev(pr.repoId, c.authorId, c.prId, 'commit_pushed', c.committedAt, 'commits', c.id);
}
for (const r of REVIEWS) {
  const pr = prRows.find((p) => p.id === r.prId)!;
  ev(pr.repoId, r.author, r.prId, 'review_submitted', day(r.daysAgo), 'reviews', r.id);
}
for (const rc of reviewCommentRows) {
  ev(API, rc.authorId, 113, 'review_comment', rc.createdAt, 'review_threads', rc.threadId);
}
for (const rc of staleCommentRows) {
  const pr = prRows.find((p) => p.id === rc.prId)!;
  ev(pr.repoId, rc.authorId, rc.prId, 'review_comment', rc.createdAt, 'review_threads', rc.threadId);
}
ev(API, 4, 113, 'pr_comment', day(1), 'pr_comments', 1);
ev(API, 1, 105, 'pr_comment', day(1), 'pr_comments', 2);
ev(INFRA, 1, 114, 'pr_comment', day(0.9), 'pr_comments', 3);
await db.insert(schema.events).values(events).execute();

// ---- Claude Review run + findings on #113 ----------------------------------
await db
  .insert(schema.claudeReviews)
  .values({
    id: 1,
    accountId: 1,
    prId: 113,
    headSha: 'sha113headcommit',
    status: 'succeeded',
    model: 'claude-sonnet-5',
    scope: 'diff_only',
    summary:
      'The transaction refactor is mostly solid. Two issues worth addressing before merge: the per-row inserts in `upsert.ts` should be batched, and a follow-up write escapes the transaction so a mid-run crash can half-persist a PR. The rest are nits and a question about indexing.',
    verdict: 'COMMENT',
    costUsd: 0.0842,
    inputTokens: 48213,
    outputTokens: 3104,
    numTurns: 6,
    excludedFiles: ['pnpm-lock.yaml'],
    createdAt: min(20),
    finishedAt: min(18),
  })
  .execute();

await db
  .insert(schema.claudeReviewFindings)
  .values([
    { id: 1, reviewId: 1, path: 'src/sync/upsert.ts', line: 88, side: 'RIGHT', severity: 'warning', title: 'Batch the per-row inserts', body: 'Each row triggers its own `INSERT` inside the loop, so a PR touching many files becomes N round-trips. Collapse into a single multi-row upsert.', diffHunk: '@@ -84,6 +84,9 @@ async function persistRows(rows) {\n   for (const row of rows) {\n+    await tx.insert(table).values(row)\n+      .onConflictDoUpdate({ target: table.nodeId, set: row })\n+      .execute();\n   }', anchored: true, included: true },
    { id: 2, reviewId: 1, path: 'src/sync/upsert.ts', line: 142, side: 'RIGHT', severity: 'blocker', title: 'Follow-up write escapes the transaction', body: '`saveReviewState()` runs *after* `runTransaction` returns, so a crash between the two leaves the PR persisted without its reviews. Move it inside the `tx` callback.', diffHunk: '@@ -138,7 +138,7 @@ await runTransaction(async (tx) => {\n   await persistPr(tx, pr);\n });\n-await saveReviewState(pr);\n+// should be inside the tx above', suggestion: 'await runTransaction(async (tx) => {\n  await persistPr(tx, pr);\n  await saveReviewState(tx, pr);\n});', anchored: true, included: true },
    { id: 3, reviewId: 1, path: 'src/db/queries.ts', line: 210, side: 'RIGHT', severity: 'nit', title: 'Name the magic interval', body: 'The literal `5 * 60 * 1000` appears here and in `scheduler.ts`. Extract a shared `SYNC_INTERVAL_MS` constant.', anchored: true, included: false },
    { id: 4, reviewId: 1, path: 'src/db/queries.ts', line: 224, side: 'RIGHT', severity: 'question', title: 'Is the correlated EXISTS indexed?', body: 'On large `events` tables this `EXISTS` could scan. Is `events(pr_id, actor_id)` covered by an index?', anchored: true, included: false },
    { id: 5, reviewId: 1, path: 'README.md', line: null, side: 'RIGHT', severity: 'praise', title: 'Good fixture coverage', body: 'Nice fixture-based tests for the new transaction path — they make the behaviour change easy to verify.', anchored: false, included: false },
  ])
  .execute();

// ===========================================================================
// HISTORICAL ACTIVITY (weeks 3–12) — purely to populate the Insights/analytics
// charts (getRepoAnalytics, window = 84 days / 12 weeks). NONE of this touches
// the curated board: every PR below is MERGED/CLOSED with both openedAt AND its
// close instant strictly OLDER than 16 days ago, so the default 14-day timeline
// and the hero screenshots are unaffected. All ids are in a high, non-colliding
// range (PRs ≥ 200; reviews/threads/comments/commits/events ≥ 5000).
//
// Determinism: a fixed-seed mulberry32 PRNG (NO Math.random) so re-running the
// seeder produces byte-identical screenshots.
// ===========================================================================

// --- seeded PRNG (xmur3 seed → mulberry32) ---------------------------------
function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}
function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const seedFn = xmur3('pierre-review-demo-history-v1');
const rng = mulberry32(seedFn());
const rand = (): number => rng();
const randInt = (lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1));
const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]!;
// Right-skewed weighted choice over [value, weight] pairs.
const weighted = <T>(pairs: readonly (readonly [T, number])[]): T => {
  const total = pairs.reduce((s, [, w]) => s + w, 0);
  let r = rand() * total;
  for (const [v, w] of pairs) {
    r -= w;
    if (r <= 0) return v;
  }
  return pairs[pairs.length - 1]![0];
};
const HOUR = 3_600_000;
const DAY_MS = 86_400_000;

// --- distributions ---------------------------------------------------------
// LOC size buckets, right-skewed: mostly S/M, some L, few XL, few XS. We pick a
// bucket, then a (additions, deletions, changedFiles) inside it.
type SizeBucket = 'XS' | 'S' | 'M' | 'L' | 'XL';
const SIZE_WEIGHTS: readonly (readonly [SizeBucket, number])[] = [
  ['XS', 6],
  ['S', 34],
  ['M', 38],
  ['L', 16],
  ['XL', 6],
];
const sizeFor = (b: SizeBucket): { additions: number; deletions: number; changedFiles: number } => {
  // loc = additions + deletions, kept inside the bucket's [lo, hi).
  const ranges: Record<SizeBucket, [number, number, number, number]> = {
    // [locLo, locHi, filesLo, filesHi]
    XS: [2, 9, 1, 2],
    S: [12, 49, 1, 5],
    M: [60, 199, 2, 12],
    L: [220, 499, 5, 22],
    XL: [520, 1400, 14, 60],
  };
  const [lo, hi, fLo, fHi] = ranges[b];
  const loc = randInt(lo, hi);
  // Skew toward additions but keep some deletions.
  const delFrac = 0.15 + rand() * 0.45;
  const deletions = Math.max(0, Math.min(loc - 1, Math.round(loc * delFrac)));
  const additions = loc - deletions;
  return { additions, deletions, changedFiles: randInt(fLo, fHi) };
};

// First-review latency buckets (hours), spread so the latency dist + cycle-time
// breakdown + TTFR trend all populate. ~15% never reviewed (handled below).
const LATENCY_WEIGHTS: readonly (readonly [[number, number], number])[] = [
  [[0.2, 1], 10], // <1h
  [[1, 4], 22], // 1–4h
  [[4, 24], 30], // 4–24h
  [[24, 72], 24], // 1–3d
  [[72, 200], 14], // >3d
];

const reviewTitlesByRepo: Record<number, readonly string[]> = {
  [WEB]: [
    'Memoize the timeline lane packer',
    'Fix focus-mode scroll jitter on rebuild',
    'Debounce the repo-search picker',
    'Persist per-row collapse to localStorage',
    'Virtualize the open-PR strip',
    'Tidy the zebra-tint repo ranking',
    'Add keyboard shortcuts to the detail pane',
    'Cache PR detail in IndexedDB',
    'Show maintainer shield in PR context',
    'Cluster event markers at coarse zoom',
    'Improve dark-mode contrast on markers',
    'Handle empty timeline gracefully',
    'Reduce forced reflows in the sync modal',
    'Flatten the thread-list grouping',
    'Wire the Now action to recenter',
    'Trim the focus popover to one PR',
    'Fix off-by-one in lane assignment',
    'Add a custom date-range preset',
    'Round avatar fallbacks consistently',
    'Lazy-load the Insights charts',
  ],
  [API]: [
    'Batch per-row upserts in the sync loop',
    'Add an index on events(repo_id, occurred_at)',
    'Tighten the maintainer-merge inference',
    'Backfill baseRefName on old PRs',
    'Cancel in-flight syncs cleanly',
    'Add overlap window to incremental sync',
    'Cache commit changed-files permanently',
    'Hydrate detail on demand under lean mode',
    'Dedupe events on a composite key',
    'Skip idle accounts in the periodic sync',
    'Two-phase backfill for new repos',
    'Stream sync progress over SSE',
    'Guard against octokit query var clash',
    'Make body columns nullable for lean storage',
    'Add a health endpoint',
    'Fix rate-limit backoff jitter',
    'Scope every getter to accountId',
    'Persist diff size on the PR row',
    'Compute triage fields on read',
    'Add the substantive-review event filter',
  ],
  [INFRA]: [
    'Terraform: extract a reusable VPC module',
    'Pin the K8s node AMI and roll the node groups',
    'Helm: bump ingress-nginx and tidy the values',
    'Split the CI pipeline into build and deploy stages',
    'Add PagerDuty routing for high-severity alerts',
    'Tighten IAM roles for the deploy runner',
    'S3 lifecycle rules for stale build artifacts',
    'Autoscale the worker pool on queue depth',
    'Rotate the RDS credentials via secrets manager',
    'Terraform: move state locking to DynamoDB',
    'Add Grafana dashboards for API latency',
    'Cache Docker layers in the CI pipeline',
    'K8s: set resource requests on the sync jobs',
    'Alert on certificate expiry 30 days out',
    'Migrate cron jobs to EventBridge schedules',
    'Add a canary deploy step to the release workflow',
    'Terraform: tag every resource with cost-center',
    'Enable VPC flow logs for the private subnets',
    'Right-size the staging RDS instance',
    'Add OIDC auth for the GitHub Actions deploys',
  ],
};

interface HistPr {
  id: number;
  repoId: number;
  authorId: number;
  title: string;
  state: 'merged' | 'closed';
  openedAt: Date;
  closeAt: Date; // mergedAt or closedAt
  firstReviewAt: Date | null;
  lastCommitAt: Date;
  mergedById: number | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  longLived: boolean;
}

const HUMAN_AUTHORS = [1, 2, 3, 4, 5, 6] as const; // exclude dependabot from "normal" weighting
const REVIEWERS = [1, 2, 3, 4, 5, 6] as const;

// Place commit/review/event timestamps on a realistic work-hours pattern:
// busier Tue–Thu, 9–18 UTC, lighter weekends/nights. We nudge a base instant
// toward a "work moment" within a day or two of it.
const WORKDAY_WEIGHTS: readonly (readonly [number, number])[] = [
  [0, 2], // Sun
  [1, 7], // Mon
  [2, 10], // Tue
  [3, 11], // Wed
  [4, 9], // Thu
  [5, 6], // Fri
  [6, 2], // Sat
];
const WORKHOUR_WEIGHTS: readonly (readonly [number, number])[] = [
  [9, 8],
  [10, 12],
  [11, 11],
  [12, 7],
  [13, 9],
  [14, 12],
  [15, 11],
  [16, 9],
  [17, 6],
  [18, 4],
  [8, 3],
  [19, 2],
  [20, 1],
  [22, 1],
];
// Snap a Date to a nearby work-hours moment, staying within [floor, base].
const workMoment = (base: Date, floor: Date): Date => {
  const targetDow = weighted(WORKDAY_WEIGHTS);
  const targetHour = weighted(WORKHOUR_WEIGHTS);
  // Walk back up to 3 days from `base` to land on the chosen weekday.
  const b = new Date(base.getTime());
  for (let i = 0; i < 4; i++) {
    if (b.getUTCDay() === targetDow) break;
    b.setUTCDate(b.getUTCDate() - 1);
  }
  b.setUTCHours(targetHour, randInt(0, 59), randInt(0, 59), 0);
  let ms = b.getTime();
  if (ms > base.getTime()) {
    // Overshot: step back a whole day and re-snap the hour into the work band so
    // the fallback doesn't inherit `base`'s (uniform-random) clock hour.
    b.setUTCDate(b.getUTCDate() - 1);
    b.setUTCHours(weighted(WORKHOUR_WEIGHTS), randInt(0, 59), randInt(0, 59), 0);
    ms = b.getTime();
  }
  if (ms > base.getTime()) ms = base.getTime() - randInt(1, 6) * HOUR;
  if (ms < floor.getTime()) ms = floor.getTime() + randInt(1, 4) * HOUR;
  return new Date(ms);
};

// --- generate the historical PRs across weeks 3–12 (16d → 84d ago) ---------
const histPrs: HistPr[] = [];
let histPrId = 200;
const titleCursor: Record<number, number> = { [WEB]: 0, [API]: 0, [INFRA]: 0 };

// 10 weekly cohorts ending at ~16d ago and reaching back to ~86d ago. A gentle
// upward trend (older weeks slightly quieter) reads well on the throughput chart.
const COHORTS = 10;
for (let w = 0; w < COHORTS; w++) {
  // w=0 is the OLDEST cohort (~week 12), w=COHORTS-1 the most recent (~week 3).
  const weekEndDaysAgo = 16 + w * 7; // newest cohort opens ~16–23d ago (>16d close, see below)
  const weekStartDaysAgo = weekEndDaysAgo + 7;
  // Opened per week ramps from ~5 (oldest) to ~8 (most recent).
  const opensThisWeek = 5 + Math.round((w / (COHORTS - 1)) * 3) + (rand() < 0.4 ? 1 : 0);
  for (let k = 0; k < opensThisWeek; k++) {
    // Weighted three-way split across the repos (web-heavy, infra lightest).
    const repoId = weighted([
      [WEB, 45],
      [API, 35],
      [INFRA, 20],
    ] as const);
    // ~12% dependabot PRs (bots), else a weighted human author.
    const isDep = rand() < 0.12;
    const authorId = isDep ? 7 : pick(HUMAN_AUTHORS);

    // openedAt somewhere inside this cohort's week.
    const openedDaysAgo = weekStartDaysAgo - rand() * 7;
    const openedAt = day(openedDaysAgo);

    // Lifetime: most close within a few days; a few long-lived (2–4 weeks) to
    // keep the backlog/stalled lines non-zero. Clamp so closeAt is STILL >16d ago.
    const longLived = rand() < 0.16;
    const lifeDays = longLived ? 14 + rand() * 14 : 0.4 + rand() * 6;
    let closeDaysAgo = openedDaysAgo - lifeDays;
    if (closeDaysAgo < 16.5) closeDaysAgo = 16.5 + rand() * 1.5; // never inside 16d
    const closeAt = day(closeDaysAgo);

    // ~85% merged, ~15% closed-unmerged.
    const merged = rand() < 0.85;
    const state: 'merged' | 'closed' = merged ? 'merged' : 'closed';
    const mergedById = merged ? pick(REVIEWERS.filter((u) => u !== authorId)) ?? 1 : null;

    // size
    const sz = sizeFor(weighted(SIZE_WEIGHTS));

    // first review: ~85% reviewed (dependabot less often). Latency from the dist,
    // but never after the close instant.
    const reviewed = (isDep ? rand() < 0.55 : rand() < 0.85);
    let firstReviewAt: Date | null = null;
    if (reviewed) {
      const [loH, hiH] = weighted(LATENCY_WEIGHTS);
      const lat = (loH + rand() * (hiH - loH)) * HOUR;
      let frMs = openedAt.getTime() + lat;
      // keep strictly before close (and at least a little before)
      const ceiling = closeAt.getTime() - HOUR;
      if (frMs > ceiling) frMs = openedAt.getTime() + Math.max(HOUR, (ceiling - openedAt.getTime()) * (0.3 + rand() * 0.5));
      if (frMs <= openedAt.getTime()) frMs = openedAt.getTime() + HOUR;
      firstReviewAt = new Date(frMs);
    }

    // lastCommitAt: long-lived PRs go stale (old last commit) to drive "stalled";
    // others commit up to near their close.
    let lastCommitAt: Date;
    if (longLived) {
      // last commit shortly after open → stale by week's end.
      lastCommitAt = new Date(openedAt.getTime() + (1 + rand() * 3) * DAY_MS);
    } else {
      lastCommitAt = new Date(
        openedAt.getTime() + Math.max(HOUR, (closeAt.getTime() - openedAt.getTime()) * (0.5 + rand() * 0.4)),
      );
    }

    histPrs.push({
      id: histPrId++,
      repoId,
      authorId,
      title:
        reviewTitlesByRepo[repoId]![titleCursor[repoId]!++ % reviewTitlesByRepo[repoId]!.length]!,
      state,
      openedAt,
      closeAt,
      firstReviewAt,
      lastCommitAt,
      mergedById,
      additions: sz.additions,
      deletions: sz.deletions,
      changedFiles: sz.changedFiles,
      longLived,
    });
  }
}

// --- rows: pull_requests ---------------------------------------------------
const histPrRows = histPrs.map((p) => ({
  id: p.id,
  githubNodeId: `PR_${p.id}`,
  accountId: 1,
  repoId: p.repoId,
  number: p.id,
  title: p.title,
  body: `Demo PR — ${p.title}.`,
  authorId: p.authorId,
  mergedById: p.mergedById,
  baseRefName: 'main',
  state: p.state,
  isDraft: false,
  openedAt: p.openedAt,
  firstReviewAt: p.firstReviewAt,
  lastCommitAt: p.lastCommitAt,
  mergedAt: p.state === 'merged' ? p.closeAt : null,
  closedAt: p.closeAt,
  updatedAt: p.closeAt,
  headSha: `sha${p.id}headcommit`,
  ciStatus: 'success' as const,
  mergeable: 'mergeable' as const,
  mergeStateStatus: 'clean' as const,
  labels: null,
  checkRuns: null,
  additions: p.additions,
  deletions: p.deletions,
  changedFiles: p.changedFiles,
}));
await db.insert(schema.pullRequests).values(histPrRows).execute();

// --- rows: reviews / threads / comments / commits / events -----------------
let hReviewId = 5000;
let hThreadId = 5000;
let hCommentId = 5000;
let hCommitId = 5000;
let hEventId = 5000;

const histReviewRows: {
  id: number; githubNodeId: string; prId: number; authorId: number;
  state: 'approved' | 'changes_requested' | 'commented' | 'dismissed' | 'pending';
  body: string | null; databaseId: string; submittedAt: Date;
}[] = [];
const histThreadRows: {
  id: number; githubNodeId: string; prId: number; path: string; line: number;
  isResolved: boolean; isOutdated: boolean;
  derivedState: 'resolved' | 'likely_addressed' | 'replied_unresolved' | 'untouched';
  originalCommenterId: number; createdAt: Date;
}[] = [];
const histCommentRows: {
  id: number; githubNodeId: string; threadId: number; prId: number; authorId: number;
  body: string; excerpt: string; diffHunk: string; databaseId: string; createdAt: Date;
}[] = [];
const histCommitRows: {
  id: number; sha: string; prId: number; authorId: number; committerId: number; message: string; committedAt: Date;
}[] = [];
const histEventRows: {
  id: number; accountId: number; repoId: number; actorId: number | null; prId: number | null;
  type:
    | 'pr_opened' | 'pr_merged' | 'pr_closed' | 'pr_reopened' | 'pr_ready_for_review'
    | 'review_submitted' | 'review_comment' | 'pr_comment' | 'commit_pushed';
  occurredAt: Date; refTable: string | null; refId: number | null; dedupeKey: string;
}[] = [];

let evCounter = 0;
const pushEvent = (
  repoId: number, actorId: number | null, prId: number, type: typeof histEventRows[number]['type'],
  occurredAt: Date, refTable: string | null = null, refId: number | null = null,
): void => {
  const id = hEventId++;
  histEventRows.push({
    id, accountId: 1, repoId, actorId, prId, type, occurredAt, refTable, refId,
    dedupeKey: `${type}:${prId}:${evCounter++}`,
  });
};

// Verdict mix: mostly approved, regular changes_requested, some commented, rare
// dismissed. (getRepoAnalytics counts approved/changes_requested/commented/dismissed.)
const VERDICTS: readonly (readonly ['approved' | 'changes_requested' | 'commented' | 'dismissed', number])[] = [
  ['approved', 58],
  ['changes_requested', 22],
  ['commented', 16],
  ['dismissed', 4],
];

// Thread derived-state mix: more resolved/likely than untouched.
const THREAD_STATE_WEIGHTS: readonly (readonly [
  'resolved' | 'likely_addressed' | 'replied_unresolved' | 'untouched', number,
])[] = [
  ['resolved', 40],
  ['likely_addressed', 28],
  ['replied_unresolved', 20],
  ['untouched', 12],
];

const THREAD_PATHS = [
  'src/index.ts', 'src/app.ts', 'src/db/queries.ts', 'src/sync/upsert.ts',
  'src/sync/sync-repo.ts', 'src/api/routes/timeline.ts', 'src/lib/ui.ts',
  'src/components/Timeline/lanes.ts', 'README.md', 'src/config.ts',
] as const;

for (const p of histPrs) {
  // ----- reviews: 1–3 per PR, by distinct reviewers (never the author) -----
  const reviewerPool = REVIEWERS.filter((u) => u !== p.authorId);
  const nReviews = p.firstReviewAt ? randInt(1, 3) : (rand() < 0.25 ? 1 : 0);
  const usedReviewers = new Set<number>();
  for (let i = 0; i < nReviews && usedReviewers.size < reviewerPool.length; i++) {
    let reviewer = pick(reviewerPool);
    let guard = 0;
    while (usedReviewers.has(reviewer) && guard++ < 8) reviewer = pick(reviewerPool);
    usedReviewers.add(reviewer);
    const verdict = weighted(VERDICTS);
    // submittedAt: from firstReviewAt onward, before close, inside the window.
    const base = (p.firstReviewAt ?? p.openedAt).getTime();
    const span = Math.max(HOUR, p.closeAt.getTime() - base);
    let subMs = base + (i === 0 ? 0 : rand() * span);
    if (subMs > p.closeAt.getTime()) subMs = p.closeAt.getTime() - randInt(1, 4) * HOUR;
    const submittedAt = workMoment(new Date(subMs), p.openedAt);
    const rid = hReviewId++;
    histReviewRows.push({
      id: rid, githubNodeId: `RV_${rid}`, prId: p.id, authorId: reviewer,
      state: verdict, body: null, databaseId: `${2_500_000 + rid}`, submittedAt,
    });
    pushEvent(p.repoId, reviewer, p.id, 'review_submitted', submittedAt, 'reviews', rid);
  }

  // ----- review threads: 0–4 per PR -----
  const nThreads = weighted([
    [0, 14],
    [1, 30],
    [2, 28],
    [3, 18],
    [4, 10],
  ] as const);
  for (let i = 0; i < nThreads; i++) {
    const tid = hThreadId++;
    const derivedState = weighted(THREAD_STATE_WEIGHTS);
    const opener = pick(reviewerPool);
    // createdAt within the open window (after open, before close), in the chart window.
    const span = Math.max(HOUR, p.closeAt.getTime() - p.openedAt.getTime());
    const createdAt = workMoment(
      new Date(p.openedAt.getTime() + (0.2 + rand() * 0.6) * span),
      p.openedAt,
    );
    histThreadRows.push({
      id: tid, githubNodeId: `RT_${tid}`, prId: p.id, path: pick(THREAD_PATHS),
      line: randInt(8, 320), isResolved: derivedState === 'resolved', isOutdated: rand() < 0.1,
      derivedState, originalCommenterId: opener, createdAt,
    });
    // one comment per thread (charts don't need more, but it keeps events richer)
    const body = pick([
      'Could we simplify this branch?',
      'Is this covered by a test?',
      'nit: rename for clarity.',
      'This allocates on the hot path — worth caching?',
      'Edge case: what if the array is empty?',
      'Consider extracting a helper here.',
    ] as const);
    const cid = hCommentId++;
    histCommentRows.push({
      id: cid, githubNodeId: `RC_${cid}`, threadId: tid, prId: p.id, authorId: opener,
      body, excerpt: body, diffHunk: `@@ -10,3 +10,4 @@`, databaseId: `${1_500_000 + cid}`,
      createdAt,
    });
    pushEvent(p.repoId, opener, p.id, 'review_comment', createdAt, 'review_threads', tid);
  }

  // ----- commits: 1–4, spread across work-hours weekdays for the heatmap -----
  const nCommits = weighted([
    [1, 26],
    [2, 36],
    [3, 24],
    [4, 14],
  ] as const);
  for (let i = 0; i < nCommits; i++) {
    const cid = hCommitId++;
    // spread commits between open and lastCommit, then snap to a work moment.
    const lo = p.openedAt.getTime();
    const hi = Math.max(lo + HOUR, p.lastCommitAt.getTime());
    const frac = nCommits === 1 ? rand() : i / (nCommits - 1);
    const committedAt = workMoment(new Date(lo + frac * (hi - lo)), p.openedAt);
    histCommitRows.push({
      id: cid, sha: `sha${p.id}c${i}`, prId: p.id, authorId: p.authorId, committerId: p.authorId,
      message: i === 0 ? p.title : pick(['Address review feedback', 'Fix lint', 'Add tests', 'Tidy up']),
      committedAt,
    });
    pushEvent(p.repoId, p.authorId, p.id, 'commit_pushed', committedAt, 'commits', cid);
  }

  // ----- lifecycle events -----
  // The PR ROW keeps its exact open/close instants (the size/cycle/backlog charts
  // depend on them); the EVENTS for the heatmap are snapped to nearby work moments
  // so weekday×hour reads as a real work-hours pattern rather than uniform noise.
  // (openedAt floors at openedAt − a few days so the snapped opener stays sane.)
  const openedEvAt = workMoment(p.openedAt, new Date(p.openedAt.getTime() - 3 * DAY_MS));
  pushEvent(p.repoId, p.authorId, p.id, 'pr_opened', openedEvAt);
  const closeEvAt = workMoment(p.closeAt, new Date(p.closeAt.getTime() - 3 * DAY_MS));
  if (p.state === 'merged') {
    pushEvent(p.repoId, p.mergedById ?? p.authorId, p.id, 'pr_merged', closeEvAt);
  } else {
    pushEvent(p.repoId, p.authorId, p.id, 'pr_closed', closeEvAt);
  }
}

if (histReviewRows.length) await db.insert(schema.reviews).values(histReviewRows).execute();
if (histThreadRows.length) await db.insert(schema.reviewThreads).values(histThreadRows).execute();
if (histCommentRows.length) await db.insert(schema.reviewComments).values(histCommentRows).execute();
if (histCommitRows.length) await db.insert(schema.commits).values(histCommitRows).execute();
if (histEventRows.length) await db.insert(schema.events).values(histEventRows).execute();

// ===========================================================================
// CI STATUS EVENTS (the ci_status_events transition log — a CORE table). Written
// during real sync in persistPr whenever a PR's CI status flips; getTeamMetrics
// walks it per-PR in time order (a failure opens a red streak whose failingChecks
// tally into the by-stage breakdown; the next success closes it → a recovery
// duration bucketed weekly). Without any rows the Flow-metrics panel shows
// "No CI recoveries yet" / "No CI failures recorded yet".
//
// The panel bounds this log at windowStart = the sprint's fromMs (~11 days), so a
// recovery only registers when BOTH its failure AND its closing success land inside
// the sprint. We seed a dense RECENT cluster (last ~10 days, both weekly buckets,
// all three repos, durations 0.5h–36h) that feeds the panel, plus a sparser OLD
// history (weeks 3–10) for narrative realism. #114 keeps an OPEN failure (no
// closing success) — the live "CI red now" story. Deterministic (fixed offsets).
// ===========================================================================
const hAgo = (h: number): Date => new Date(now.getTime() - h * 3_600_000);
const repoOfPr = new Map<number, number>();
for (const p of prRows) repoOfPr.set(p.id, p.repoId);
for (const p of histPrRows) repoOfPr.set(p.id, p.repoId);

interface CiCycle {
  prId: number;
  stage: string; // the failing check name (tells a per-repo story)
  failHrsAgo: number;
  successHrsAgo: number | null; // null → still red (open failure)
}
// RECENT cluster — inside the sprint window. successHrsAgo < failHrsAgo; failures kept
// ≤ ~10d so both events sit inside the ~11-day window. Spread across both weekly buckets
// (bucket boundary ≈ 4.5d ago) and all three repos; durations 0.5h → 36h.
const RECENT_CYCLES: CiCycle[] = [
  // bucket 0 (older half of the sprint, ~4.5–11d ago)
  { prId: 130, stage: 'terraform plan', failHrsAgo: 240, successHrsAgo: 204 }, // 36h — the long one
  { prId: 120, stage: 'e2e (playwright)', failHrsAgo: 240, successHrsAgo: 228 }, // 12h
  { prId: 125, stage: 'unit tests', failHrsAgo: 228, successHrsAgo: 216 }, // 12h
  { prId: 102, stage: 'lint', failHrsAgo: 168, successHrsAgo: 156 }, // 12h
  { prId: 104, stage: 'integration tests', failHrsAgo: 156, successHrsAgo: 150 }, // 6h
  // bucket 1 (recent half, ~0–4.5d ago)
  { prId: 116, stage: 'checkov', failHrsAgo: 96, successHrsAgo: 84 }, // 12h
  { prId: 112, stage: 'typecheck', failHrsAgo: 72, successHrsAgo: 60 }, // 12h
  { prId: 113, stage: 'build', failHrsAgo: 60, successHrsAgo: 59.5 }, // 0.5h — the fast one
  { prId: 111, stage: 'integration tests', failHrsAgo: 48, successHrsAgo: 24 }, // 24h
  // #114 — still red: a failure with no closing success (drives the by-stage tally + the
  // "CI red now" chip's failing stage; the red-now COUNT comes from pullRequests.ciStatus).
  { prId: 114, stage: 'terraform plan', failHrsAgo: 48, successHrsAgo: null },
];
// OLD history — resolved cycles in weeks 3–10 (16–70d ago), on the historical PR cohort,
// so the transition log reads as a real multi-week record. Outside the sprint window, so
// they don't touch the panel; purely for realism / any wider-window read.
const OLD_CYCLES: CiCycle[] = [
  { prId: 200, stage: 'e2e (playwright)', failHrsAgo: 70 * 24, successHrsAgo: 70 * 24 - 8 },
  { prId: 205, stage: 'unit tests', failHrsAgo: 61 * 24, successHrsAgo: 61 * 24 - 3 },
  { prId: 214, stage: 'terraform plan', failHrsAgo: 52 * 24, successHrsAgo: 52 * 24 - 20 },
  { prId: 223, stage: 'build', failHrsAgo: 43 * 24, successHrsAgo: 43 * 24 - 5 },
  { prId: 234, stage: 'lint', failHrsAgo: 33 * 24, successHrsAgo: 33 * 24 - 2 },
  { prId: 247, stage: 'checkov', failHrsAgo: 24 * 24, successHrsAgo: 24 * 24 - 14 },
  { prId: 258, stage: 'typecheck', failHrsAgo: 19 * 24, successHrsAgo: 19 * 24 - 6 },
];

let cseId = 1;
const ciStatusEventRows: {
  id: number; accountId: number; repoId: number; prId: number; headSha: string;
  status: 'success' | 'failure'; failingChecks: string[] | null; observedAt: Date;
}[] = [];
for (const c of [...RECENT_CYCLES, ...OLD_CYCLES]) {
  const repoId = repoOfPr.get(c.prId);
  if (repoId == null) continue; // skip if a referenced PR isn't seeded
  const headSha = `sha${c.prId}headcommit`;
  ciStatusEventRows.push({
    id: cseId++, accountId: 1, repoId, prId: c.prId, headSha,
    status: 'failure', failingChecks: [c.stage], observedAt: hAgo(c.failHrsAgo),
  });
  if (c.successHrsAgo != null) {
    ciStatusEventRows.push({
      id: cseId++, accountId: 1, repoId, prId: c.prId, headSha,
      status: 'success', failingChecks: null, observedAt: hAgo(c.successHrsAgo),
    });
  }
}
await db.insert(schema.ciStatusEvents).values(ciStatusEventRows).execute();

// ===========================================================================
// PRO-TABLE SEEDING (only when the PRIVATE @pierre/pro submodule is checked out).
// Applies the plugin's own migrations EXACTLY the way the backend boot does
// (src/pro/migrate.ts, incl. the pro_migrations bookkeeping — so the boot-time
// plugin migration is a no-op), then seeds demo-quality rows into the plugin
// tables so the marketing shots show rich Pro state: repo_digests (per-repo AI
// digest), sprint_reports, pro_settings, ai_pr_analyses + ai_fixes (#114).
// ===========================================================================
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PRO_DIR = join(REPO_ROOT, 'packages', 'pro');
let proSeeded = false;

if (existsSync(join(PRO_DIR, 'migrations'))) {
  // 1. The plugin's migrations, via the REAL core migrator (pro_migrations bookkeeping
  //    included). This is the one sanctioned raw-$client DDL path.
  const { runPluginMigrations } = await import('../src/pro/migrate.js');
  await runPluginMigrations(join(PRO_DIR, 'migrations'), join(PRO_DIR, 'migrations-pg'));

  // The plugin tables aren't in the core drizzle schema, so seed them through the raw
  // better-sqlite3 handle (script-only; the app itself always goes through drizzle).
  interface RawStmt { run(...args: unknown[]): unknown; get(...args: unknown[]): unknown }
  const raw = (db as unknown as { $client: { prepare(sql: string): RawStmt } }).$client;
  const sec = (d: Date): number => Math.floor(d.getTime() / 1000);
  const hoursAgo = (h: number): number => sec(new Date(now.getTime() - h * 3_600_000));

  // 2. pro_settings — a populated Settings modal: 14-day sprint, daily Slack digest at 9
  //    with a placeholder webhook, manual AI updates, Jira ticket links.
  //
  //    The sprint START is anchored 11 days ago (snapped to UTC midnight) so "now" always
  //    sits MID-SPRINT with history behind it. This matters for the Flow-metrics panel:
  //    getTeamMetrics bounds every current-sprint figure (merges / lead time / merge-CI% /
  //    CI recovery) at windowStart = the sprint's fromMs, so a barely-started sprint (the
  //    old "this week's Monday" anchor, ~1 day in) left them all empty. Eleven days in
  //    gives ~2 weekly buckets AND leaves ~2–3 days of head-room before the sprint
  //    auto-rolls to the next window (re-seed right before capturing shots per the recipe
  //    above). The 14-day cadence is unchanged.
  const sprintStart = new Date(now);
  sprintStart.setUTCHours(0, 0, 0, 0);
  sprintStart.setUTCDate(sprintStart.getUTCDate() - 11);
  raw
    .prepare(
      `INSERT INTO pro_settings (account_id, sprint_cadence_days, sprint_start_at,
         slack_webhook_url, slack_cadence, slack_hour1, slack_hour2, slack_timezone,
         ai_update_mode, ai_interval_minutes, issue_provider, issue_base_url,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      1, 14, sec(sprintStart),
      'https://hooks.slack.com/services/T0000000/B0000000/demoDemoDemoDemoDemoDemo',
      'daily', 9, 16, 'Europe/London',
      'manual', 30, 'jira', 'https://acme.atlassian.net',
      hoursAgo(48), hoursAgo(2),
    );

  // 3. repo_digests — one realistic bulleted change-report per repo, referencing
  //    seeded PRs as bare #N tokens (the app resolves + linkifies them). Format per
  //    packages/pro/src/activity-digest/prompt.ts: throughput bullet first (no refs),
  //    then multi-PR bullets, then one bullet per single PR. latest_event_at is set to
  //    the repo's real max event time so the digest is NOT flagged stale.
  const DIGESTS: Record<number, string> = {
    [WEB]: [
      '- Steady week: three PRs merged and two still open, with reviews keeping pace with new work.',
      '- The open-PR strip got a focused round of polish across #101 and #112 — the layout-shift fix is through review, keyboard navigation is still waiting on e2e.',
      '- #102 merged — the timeline lane packer now lives in its own module.',
      '- #110 merged — the detail-pane height persists across reloads.',
      '- #103 landed the routine vite bump within a day.',
    ].join('\n'),
    [API]: [
      '- Throughput is rising: two merges this week with three PRs open, all under active review.',
      '- The sync-performance track converged in #104 and #106 — commit-file caching and the mergedBy backfill both merged.',
      '- #113 drew the deepest review of the week: five inline threads on the transaction boundaries, two already addressed in follow-up pushes.',
      '- #105 is conflicting with main after recent merges — needs a rebase before it can land.',
      '- #111 has review notes and is awaiting a requested review.',
    ].join('\n'),
    [INFRA]: [
      '- A quieter but consequential week: one merge and two open PRs, both infrastructure-critical.',
      '- #114 is red — `terraform plan` fails on the staging workspace after the autoscaling bounds were inverted in the latest push.',
      '- #115 merged — the ingress Helm values are now split per environment.',
      '- #116 adds CloudWatch alarms for queue depth and DLQ age; awaiting review.',
    ].join('\n'),
  };
  const maxEventAt = (repoId: number): number => {
    const row = raw
      .prepare('SELECT MAX(occurred_at) AS m FROM events WHERE repo_id = ?')
      .get(repoId) as { m: number | null };
    return row.m ?? hoursAgo(2);
  };
  const insDigest = raw.prepare(
    `INSERT INTO repo_digests (account_id, repo_id, payload_hash, latest_event_at,
       model, summary, cost_usd, input_tokens, output_tokens, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const repoId of [WEB, API, INFRA]) {
    insDigest.run(
      1, repoId, `demo-digest-${repoId}`, maxEventAt(repoId),
      'claude-haiku-4-5', DIGESTS[repoId]!, 0.0031, 6214, 342, hoursAgo(2),
    );
  }

  // 4. sprint_reports — ONE cross-repo report. The stored insights_hash must match
  //    what the live GET recomputes (structural hash of the current Insight cards +
  //    the day-quantized sprint window — see packages/pro/src/insights/sprint-report.ts
  //    insightsHash/windowKey; replicated here so the report is NOT flagged stale).
  const { getTeamInsights } = await import('../src/db/queries.js');
  // Replicate packages/pro/src/settings/store.ts `currentSprintWindow` EXACTLY so the
  // stored insights_hash matches what the plugin recomputes live (else a stale chip):
  // the auto-rolling window [start + k·cadence, +cadence) that contains `now`.
  const cadenceMs = 14 * DAY_MS;
  const k = Math.max(0, Math.floor((now.getTime() - sprintStart.getTime()) / cadenceMs));
  const windowFromMs = sprintStart.getTime() + k * cadenceMs;
  const window = { fromMs: windowFromMs, toMs: windowFromMs + cadenceMs };
  const insights = await getTeamInsights(1, window);
  const cardHash = createHash('sha256')
    .update(
      insights.cards
        .map((c) => {
          switch (c.kind) {
            case 'stalled_review':
              return `stalled:${c.prId}:${[...c.requestedReviewerIds].sort((a, b) => a - b).join(',')}`;
            case 'untouched_thread':
              return `thread:${c.threadId}`;
            case 'reviewer_load':
              return `load:${c.reviewerId}:${c.pendingCount}`;
            case 'reviewer_routing':
              return `route:${c.prId}:${c.suggestedReviewers.map((s) => s.userId).sort((a, b) => a - b).join(',')}`;
            default:
              return '';
          }
        })
        .sort()
        .join('|'),
    )
    .digest('hex');
  const windowKey = `${insights.sprint.from.slice(0, 10)}..${insights.sprint.to.slice(0, 10)}`;
  const insightsHash = createHash('sha256').update(`${cardHash}|${windowKey}`).digest('hex');

  const SPRINT_SUMMARY = [
    '**Flow is healthy this sprint: merges are up and lead time is down, but first reviews are arriving later and one CI board is red.**',
    '',
    '- Merged PRs: 14 (up vs last sprint) — throughput trending up.',
    '- Lead time: 2.1d (down from 2.9d) — smaller PRs are landing faster.',
    '- Review latency: 18h (up from 11h) — first reviews are arriving later; watch the queue.',
    '- CI health: 1 PR red for ~2d — `terraform plan` on acme/infrastructure is the failing stage.',
    '',
    '**Action items**',
    '',
    'acme/api',
    '- acme/api#113 — Five review threads on the transaction boundaries; two still unresolved and awaiting replies.',
    '- acme/api#111 — Waiting 5 days on a requested review from @morgan-diaz.',
    '- acme/api#105 — Conflicting with main; needs a rebase before it can merge.',
    '',
    'acme/infrastructure',
    '- acme/infrastructure#114 — CI red for 2 days on `terraform plan`; the autoscaling bounds are inverted and the fix is one line.',
    '- acme/infrastructure#116 — Waiting 4 days on a requested review from @morgan-diaz.',
    '',
    'acme/web-app',
    '- acme/web-app#112 — Blocked on a pending e2e run; keyboard navigation is otherwise ready.',
  ].join('\n');
  raw
    .prepare(
      `INSERT INTO sprint_reports (account_id, insights_hash, model, summary,
         cost_usd, input_tokens, output_tokens, sprint_from, sprint_to, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      1, insightsHash, 'claude-haiku-4-5', SPRINT_SUMMARY,
      0.0044, 8931, 512, Math.floor(window.fromMs / 1000), Math.floor(window.toMs / 1000),
      hoursAgo(2),
    );

  // 5. ai_pr_analyses + ai_fixes — a rich "AI Analysis & Fix" tab on #114 (the failing
  //    infra PR): a PR summary, a succeeded CI-failure analysis (the CONFIDENCE first
  //    line is machine-parsed into the confidence chips), and one succeeded, not-yet-
  //    pushed fix run with a small readable patch.
  const insAnalysis = raw.prepare(
    `INSERT INTO ai_pr_analyses (account_id, repo_id, pr_id, kind, head_sha,
       payload_hash, summary, model, cost_usd, input_tokens, output_tokens, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insAnalysis.run(
    1, INFRA, 114, 'summary', 'sha114headcommit', 'demo-summary-114',
    [
      '**What this PR does** — Right-sizes the EKS node-group autoscaling for the worker pool: new min/max bounds in `terraform/eks/node-groups.tf` plus matching staging workspace variables, so queue-depth scaling stops thrashing at the old ceiling.',
      '',
      '**Risk** — Low blast radius (staging first, prod behind a separate apply), but the current revision inverts the min/max bounds — which is exactly why `terraform plan` fails validation.',
    ].join('\n'),
    'claude-haiku-4-5', 0.0018, 3120, 214, hoursAgo(3),
  );
  insAnalysis.run(
    1, INFRA, 114, 'ci_analysis', 'sha114headcommit', 'demo-ci-114',
    [
      'CONFIDENCE root=high fix=high',
      '**Root cause** — `terraform plan` fails validation on `module.workers`: `scaling_config.min_size = 6` is greater than `max_size = 4`. The last push raised the minimum while leaving the maximum at its old value, and Terraform rejects the inverted range before it even plans.',
      '',
      '**Failing check** — `terraform plan` (staging workspace). `tflint` and `checkov` pass, so this is a semantic bounds error, not a style or security finding.',
      '',
      '**Suggested fix** — restore `min_size = 2` and raise `max_size = 8` for the intended head-room; `desired_size = 4` stays valid inside the corrected range.',
    ].join('\n'),
    'claude-haiku-4-5', 0.0021, 4480, 296, hoursAgo(2),
  );
  raw
    .prepare(
      `INSERT INTO ai_fixes (account_id, repo_id, pr_id, base_sha, status, model, seed,
         summary, commit_message, patch, files_changed, cost_usd, input_tokens,
         output_tokens, num_turns, created_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      1, INFRA, 114, 'sha114headcommit', 'succeeded', 'claude-sonnet-5', 'ci_analysis',
      'Corrected the inverted autoscaling bounds on `module.workers`: `min_size` back to 2 and `max_size` up to 8, keeping `desired_size = 4` inside the valid range. `terraform plan` validates cleanly with this patch applied.',
      'fix(eks): correct worker node-group autoscaling bounds (min 2, max 8)',
      [
        'diff --git a/terraform/eks/node-groups.tf b/terraform/eks/node-groups.tf',
        'index 3f1c2ab..9d4e7c1 100644',
        '--- a/terraform/eks/node-groups.tf',
        '+++ b/terraform/eks/node-groups.tf',
        '@@ -18,8 +18,8 @@ module "workers" {',
        '   scaling_config {',
        '-    min_size     = 6',
        '-    max_size     = 4',
        '+    min_size     = 2',
        '+    max_size     = 8',
        '     desired_size = 4',
        '   }',
        ' }',
      ].join('\n'),
      JSON.stringify(['terraform/eks/node-groups.tf']),
      0.0317, 15204, 1088, 4, hoursAgo(2), hoursAgo(2),
    );

  // 6. review_learnings — "review memory": signals from PAST Claude reviews in
  //    acme/api that surface in the pre-run "From your past reviews in this repo"
  //    panel on #113 (and get injected into the next run's prompt). Retrieval
  //    matches on dirPath/ext against #113's finding paths (src/sync, src/db, .ts),
  //    aggregated per (glob, category): 3+ rows in a group = medium confidence.
  const insLearning = raw.prepare(
    `INSERT INTO review_learnings (account_id, repo_id, pr_id, source_review_id,
       finding_id, head_sha, kind, path, dir_path, ext, category, claude_verdict,
       user_verdict, claude_title, claude_text, user_text, posted_comment_kind,
       dedupe_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // src/sync/* — a reworded finding (carries the Claude-vs-you example) + two kept.
  insLearning.run(
    1, API, 104, 900, null, 'sha104headcommit', 'finding_reworded',
    'src/sync/commit-files.ts', 'src/sync', '.ts', 'performance', null, null,
    'Consider batching these lookups',
    'Consider batching these lookups to reduce round-trips.',
    'Batch the lookups — one query per commit is an N+1 on big PRs.',
    null, 'demo-learn-1', hoursAgo(96),
  );
  insLearning.run(
    1, API, 104, 900, null, 'sha104headcommit', 'finding_kept',
    'src/sync/upsert.ts', 'src/sync', '.ts', 'performance', null, null,
    'Missing conflict target on upsert', null, null, null, 'demo-learn-2', hoursAgo(96),
  );
  insLearning.run(
    1, API, 106, 901, null, 'sha106headcommit', 'finding_kept',
    'src/sync/sync-repo.ts', 'src/sync', '.ts', 'performance', null, null,
    'Unbounded page walk on backfill', null, null, null, 'demo-learn-3', hoursAgo(48),
  );
  // src/db/* — style nits mostly dismissed: teaches the agent to stop flagging them.
  insLearning.run(
    1, API, 106, 901, null, 'sha106headcommit', 'finding_dismissed',
    'src/db/queries.ts', 'src/db', '.ts', 'style', null, null,
    'Prefer early return here', null, null, null, 'demo-learn-4', hoursAgo(48),
  );
  insLearning.run(
    1, API, 106, 901, null, 'sha106headcommit', 'finding_dismissed',
    'src/db/triage.ts', 'src/db', '.ts', 'style', null, null,
    'Inline this single-use helper', null, null, null, 'demo-learn-5', hoursAgo(48),
  );
  insLearning.run(
    1, API, 111, 902, null, 'sha111headcommit', 'finding_dismissed',
    'src/db/queries.ts', 'src/db', '.ts', 'style', null, null,
    'Reorder imports alphabetically', null, null, null, 'demo-learn-6', hoursAgo(24),
  );
  proSeeded = true;
}

console.log('Seeded demo data into', config.dbPath);
console.log('  repos: acme/web-app (1), acme/api (2), acme/infrastructure (3)');
console.log('  me: Morgan Diaz (account 1 → users.id 1)');
console.log('  PR-detail / Claude shot: ?pr=113 · AI-fix shot: ?pr=114 (failing CI)');
console.log('  curated PRs:', PRS.length, `(ids 101–116 recent + 120–134 mid-range + 140–142 stale)`);
console.log('  open PRs:', prRows.filter((p) => p.state === 'open').map((p) => p.id).join(', '));
console.log('  stale open PRs (one per repo): 140 (web), 141 (api), 142 (infra)');
console.log(
  proSeeded
    ? '  pro tables: repo_digests (3), sprint_reports (1), pro_settings (1), ai analyses + fix on #114, review_learnings (6, panel on #113)'
    : '  pro tables: SKIPPED (packages/pro submodule not checked out)',
);
console.log(
  `  history: ${histPrs.length} PRs (ids ${histPrs[0]?.id}–${histPrs[histPrs.length - 1]?.id}),`,
  `${histReviewRows.length} reviews, ${histThreadRows.length} threads,`,
  `${histCommitRows.length} commits, ${histEventRows.length} events (weeks 3–12)`,
);

await closeDb();
