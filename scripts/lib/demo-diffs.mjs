// The demo's PULL REQUEST DIFFS — the code behind the Acme sample pull requests.
//
// GitHub is not reachable from the demo stack, so the Changes tab's file list (`GET
// /api/prs/:id/files`, a live GitHub read in the product) has nothing to show. This module is the
// ONE place those diffs live, read by both halves of the demo:
//   • the seeder (apps/backend/scripts/seed-demo-agentic.ts) stores each PR's file list and sizes,
//     re-anchors the seeded review threads and Claude findings onto lines these hunks really add,
//     and hands the diff to the Claude Review run it fakes;
//   • the recorder (scripts/record-demo.mjs) answers the Changes tab's request with these files.
// Everything is fictional code for a fictional team.

/** One file: its path, status and hunks. A hunk is { oldStart, newStart, header, lines } where every
 *  line starts with ' ', '+' or '-'. */
function file(path, status, hunks) {
  return { path, status, hunks };
}

const PR113 = [
  file('src/sync/upsert.ts', 'modified', [
    {
      oldStart: 48,
      newStart: 48,
      header: 'import { columnsOf } from "./columns.js";',
      lines: [
        ' /**',
        '  * Write one pull request and everything under it. ONE transaction: a crash part-way leaves',
        '  * the previous copy of the PR untouched, never half its threads.',
        '  */',
        '-export async function upsertPullRequest(accountId: number, pr: GithubPr): Promise<number> {',
        '-  const existing = await db.select().from(pullRequests).where(eq(pullRequests.githubNodeId, pr.id)).execute();',
        '-  if (existing.length > 0) {',
        '-    await db.update(pullRequests).set(columnsOf(pr)).where(eq(pullRequests.id, existing[0].id)).execute();',
        '-    return existing[0].id;',
        '-  }',
        '-  const [row] = await db.insert(pullRequests).values({ accountId, ...columnsOf(pr) }).returning({ id: pullRequests.id }).execute();',
        '-  return row.id;',
        '+export async function upsertPullRequest(accountId: number, pr: GithubPr): Promise<number> {',
        '+  return runTransaction(async (tx) => {',
        '+    const [row] = await tx',
        '+      .insert(pullRequests)',
        '+      .values({ accountId, githubNodeId: pr.id, ...columnsOf(pr) })',
        '+      .onConflictDoUpdate({',
        '+        target: [pullRequests.accountId, pullRequests.githubNodeId],',
        '+        set: columnsOf(pr),',
        '+      })',
        '+      .returning({ id: pullRequests.id })',
        '+      .execute();',
        '+    await upsertThreads(tx, row.id, pr.reviewThreads);',
        '+    await upsertEvents(tx, accountId, row.id, pr.timeline);',
        '+    return row.id;',
        '+  });',
        ' }',
      ],
    },
    {
      oldStart: 84,
      newStart: 88,
      header: 'async function upsertThreads(tx: Tx, prId: number, threads: GithubThread[]) {',
      lines: [
        '   for (const t of threads) {',
        '-    const id = await upsertThread(db, prId, t);',
        '-    for (const c of t.comments) {',
        '-      await db.insert(reviewComments).values(commentRow(id, c)).onConflictDoNothing().execute();',
        '-    }',
        '+    const id = await upsertThread(tx, prId, t);',
        '+    for (const c of t.comments) {',
        '+      await tx.insert(reviewComments).values(commentRow(id, c)).onConflictDoNothing().execute();',
        '+    }',
        '+    const isBot = t.comments[0]?.author?.isBot ?? false;',
        '+    await tx.update(reviewThreads).set({ isBot }).where(eq(reviewThreads.id, id)).execute();',
        '   }',
        ' }',
      ],
    },
    {
      oldStart: 128,
      newStart: 136,
      header: 'export async function syncPullRequest(accountId: number, pr: GithubPr) {',
      lines: [
        '   const prId = await upsertPullRequest(accountId, pr);',
        '-  await deriveThreadStates(db, prId);',
        '-  await refreshSearchIndex(db, prId);',
        '+  // Derived state reads the threads just written; it runs after the transaction commits.',
        '+  await deriveThreadStates(db, prId);',
        '+  await refreshSearchIndex(db, prId);',
        '+  await markPrChanged(accountId, prId);',
        '   return prId;',
        ' }',
      ],
    },
  ]),
  file('src/db/queries.ts', 'modified', [
    {
      oldStart: 8,
      newStart: 8,
      header: '',
      lines: [
        " import { and, eq, inArray, sql } from 'drizzle-orm';",
        "-import { db, schema } from './client.js';",
        "+import { db, schema, runTransaction } from './client.js';",
        "+import type { Tx } from './client.js';",
        " import { botUserIds } from './bots.js';",
      ],
    },
    {
      oldStart: 204,
      newStart: 205,
      header: 'export async function getOpenPrRows(accountId: number, repoIds: number[]) {',
      lines: [
        '   const rows = await db',
        '     .select()',
        '     .from(pullRequests)',
        '-    .where(and(eq(pullRequests.accountId, accountId), inArray(pullRequests.repoId, repoIds)))',
        '+    .where(',
        '+      and(',
        '+        eq(pullRequests.accountId, accountId),',
        '+        inArray(pullRequests.repoId, repoIds),',
        "+        sql`exists (select 1 from events e where e.pr_id = ${pullRequests.id} and e.kind = 'commit_pushed')`,",
        '+      ),',
        '+    )',
        '     .execute();',
        '-  for (const r of rows) r.counts = await threadCounts(r.id);',
        '+  const counts = await threadCountsFor(rows.map((r) => r.id));',
        '+  for (const r of rows) r.counts = counts.get(r.id) ?? emptyCounts();',
        '   return rows;',
        ' }',
      ],
    },
    {
      oldStart: 309,
      newStart: 318,
      header: 'export async function getFeed(accountId: number, opts: FeedOptions) {',
      lines: [
        '   const page = await feedPage(accountId, opts);',
        '+  const bots = await botUserIds();',
        '+  const visible = page.items.filter((i) => opts.includeBots || !bots.has(i.actorId));',
        '-  return page;',
        '+  return { ...page, items: visible };',
        ' }',
        ' ',
        '+function emptyCounts(): ThreadCounts {',
        '+  return { open: 0, resolved: 0, likelyAddressed: 0, untouched: 0 };',
        '+}',
      ],
    },
  ]),
  file('src/sync/scheduler.ts', 'modified', [
    {
      oldStart: 36,
      newStart: 36,
      header: 'export function startScheduler() {',
      lines: [
        '-  cron.schedule("*/5 * * * *", tick);',
        '+  const SYNC_INTERVAL_CRON = "*/5 * * * *";',
        '+  cron.schedule(SYNC_INTERVAL_CRON, tick);',
        ' }',
      ],
    },
  ]),
  file('src/sync/derive-thread-state.ts', 'modified', [
    {
      oldStart: 46,
      newStart: 46,
      header: 'export function deriveThreadState(thread: ThreadFacts, commits: CommitFacts[]) {',
      lines: [
        '   if (thread.isResolved) return "resolved";',
        '   const last = thread.lastCommentAt;',
        '-  const touched = commits.some((c) => c.at > last && c.files.includes(thread.path));',
        '+  const paths = new Set([thread.path, ...(thread.previousPaths ?? [])]);',
        '+  const touched = commits.some((c) => c.at > last && c.files.some((f) => paths.has(f)));',
        '   if (touched) return "likely_addressed";',
      ],
    },
  ]),
  file('src/api/routes/timeline.ts', 'modified', [
    {
      oldStart: 40,
      newStart: 40,
      header: "app.get('/api/timeline', async (req) => {",
      lines: [
        '   const q = req.query as TimelineQuery;',
        '+  const from = parseBound(q.from);',
        '+  const to = parseBound(q.to);',
        '-  const rows = await getTimeline(accountIdOf(req), parseBound(q.from), parseBound(q.to));',
        '+  const rows = await getTimeline(accountIdOf(req), from, to);',
        '   return { rows, from: parseBound(q.from), to: parseBound(q.to) };',
      ],
    },
  ]),
  file('src/db/schema.sqlite.ts', 'modified', [
    {
      oldStart: 124,
      newStart: 124,
      header: "export const reviewThreads = sqliteTable('review_threads', {",
      lines: [
        "   derivedState: text('derived_state'),",
        "+  isBot: integer('is_bot', { mode: 'boolean' }).notNull().default(false),",
        "+  isBotOverridden: integer('is_bot_overridden', { mode: 'boolean' }).notNull().default(false),",
        ' });',
      ],
    },
  ]),
];

const PR114 = [
  file('terraform/eks/node-groups.tf', 'modified', [
    {
      oldStart: 12,
      newStart: 12,
      header: 'module "workers" {',
      lines: [
        '   source          = "../modules/node-group"',
        '   name            = "workers"',
        '   instance_types  = ["m6i.xlarge"]',
        '   capacity_type   = "ON_DEMAND"',
        ' ',
        '   scaling_config {',
        '-    min_size     = 6',
        '-    max_size     = 6',
        '-    desired_size = 6',
        '+    min_size     = 6',
        '+    max_size     = 4',
        '+    desired_size = 4',
        '   }',
        ' ',
        '+  labels = {',
        '+    workload = "sync-workers"',
        '+  }',
        '+',
        '   update_config {',
        '     max_unavailable = 1',
        '   }',
      ],
    },
  ]),
  file('terraform/eks/variables.tf', 'modified', [
    {
      oldStart: 30,
      newStart: 30,
      header: 'variable "worker_instance_type" {',
      lines: [
        '   default     = "m6i.xlarge"',
        ' }',
        '+',
        '+variable "worker_max_nodes" {',
        '+  description = "Upper bound for the worker node group autoscaler."',
        '+  type        = number',
        '+  default     = 8',
        '+}',
      ],
    },
  ]),
];

const PR116 = [
  file('modules/monitoring/alarms.tf', 'added', [
    {
      oldStart: 0,
      newStart: 1,
      header: '',
      lines: [
        '+resource "aws_cloudwatch_metric_alarm" "sync_queue_depth" {',
        '+  alarm_name          = "${var.env}-sync-queue-depth"',
        '+  comparison_operator = "GreaterThanThreshold"',
        '+  evaluation_periods  = 2',
        '+  metric_name         = "ApproximateNumberOfMessagesVisible"',
        '+  namespace           = "AWS/SQS"',
        '+  period              = 300',
        '+  statistic           = "Maximum"',
        '+  threshold           = 500',
        '+  dimensions = {',
        '+    QueueName = var.sync_queue_name',
        '+  }',
        '+  alarm_actions = [var.oncall_topic_arn]',
        '+}',
        '+',
        '+resource "aws_cloudwatch_metric_alarm" "sync_dlq_age" {',
        '+  alarm_name          = "${var.env}-sync-dlq-oldest-message"',
        '+  comparison_operator = "GreaterThanThreshold"',
        '+  evaluation_periods  = 1',
        '+  metric_name         = "ApproximateAgeOfOldestMessage"',
        '+  namespace           = "AWS/SQS"',
        '+  period              = 300',
        '+  statistic           = "Maximum"',
        '+  threshold           = 3600',
        '+  dimensions = {',
        '+    QueueName = var.sync_dlq_name',
        '+  }',
        '+  alarm_actions = [var.oncall_topic_arn]',
        '+}',
      ],
    },
  ]),
  file('modules/monitoring/variables.tf', 'added', [
    {
      oldStart: 0,
      newStart: 1,
      header: '',
      lines: [
        '+variable "env" {',
        '+  type = string',
        '+}',
        '+',
        '+variable "sync_queue_name" {',
        '+  type = string',
        '+}',
        '+',
        '+variable "sync_dlq_name" {',
        '+  type = string',
        '+}',
        '+',
        '+variable "oncall_topic_arn" {',
        '+  type        = string',
        '+  description = "SNS topic that posts to the on-call channel."',
        '+}',
      ],
    },
  ]),
];

const PR105 = [
  file('src/api/routes/webhooks.ts', 'added', [
    {
      oldStart: 0,
      newStart: 1,
      header: '',
      lines: [
        "+import type { FastifyInstance } from 'fastify';",
        "+import { verifySignature } from '../../github/webhook-signature.js';",
        "+import { upsertPullRequest } from '../../sync/upsert.js';",
        "+import { findTrackedRepo } from '../../db/queries.js';",
        '+',
        '+const seenDeliveries = new Map<string, number>();',
        '+',
        '+export async function webhookRoutes(app: FastifyInstance) {',
        "+  app.post('/api/webhooks/github', { config: { rawBody: true } }, async (req, reply) => {",
        "+    const delivery = String(req.headers['x-github-delivery'] ?? '');",
        "+    const event = String(req.headers['x-github-event'] ?? '');",
        '+    const body = req.body as ReviewRequestPayload;',
        "+    if (!verifySignature(JSON.stringify(body), req.headers['x-hub-signature-256'])) {",
        '+      reply.status(401);',
        "+      return { error: 'BadSignature' };",
        '+    }',
        '+    if (seenDeliveries.has(delivery)) return { status: "duplicate" };',
        '+    seenDeliveries.set(delivery, Date.now());',
        "+    if (event !== 'pull_request') return { status: 'ignored' };",
        "+    if (body.action !== 'review_requested' && body.action !== 'review_request_removed') {",
        "+      return { status: 'ignored' };",
        '+    }',
        '+    const repo = await findTrackedRepo(body.repository.node_id);',
        '+    if (!repo) {',
        '+      app.log.info({ repo: body.repository.full_name, secret: process.env.WEBHOOK_SECRET }, "untracked repo");',
        "+      return { status: 'untracked' };",
        '+    }',
        '+    await upsertPullRequest(repo.accountId, toGithubPr(body.pull_request));',
        "+    return { status: 'ok' };",
        '+  });',
        '+}',
      ],
    },
  ]),
  file('src/sync/sync-repo.ts', 'modified', [
    {
      oldStart: 80,
      newStart: 80,
      header: 'export async function syncRepo(repo: RepoRow) {',
      lines: [
        '   const since = await lastSyncedAt(repo.id);',
        '+  const pageSize = config.syncPageSize;',
        '+  const maxPages = config.syncMaxPages;',
        '-  for await (const pr of walkPullRequests(repo, since)) {',
        '+  for await (const pr of walkPullRequests(repo, since, { pageSize, maxPages })) {',
        '     await syncPullRequest(repo.accountId, pr);',
        '   }',
      ],
    },
  ]),
];

const PR111 = [
  file('src/api/routes/sync-activity.ts', 'modified', [
    {
      oldStart: 40,
      newStart: 40,
      header: 'export async function syncActivityRoutes(app: FastifyInstance) {',
      lines: [
        "+  app.get('/api/sync-activity/stream', async (req, reply) => {",
        '+    reply.raw.writeHead(200, {',
        "+      'content-type': 'text/event-stream',",
        "+      'cache-control': 'no-cache',",
        '+    });',
        "+    reply.raw.write('retry: 100\\n\\n');",
        '+    const unsubscribe = subscribeSyncProgress(accountIdOf(req), (p) => {',
        '+      reply.raw.write(`data: ${JSON.stringify(p)}\\n\\n`);',
        '+    });',
        '+    const heartbeat = setInterval(() => reply.raw.write(": ping\\n\\n"), 30_000);',
        "+    reply.raw.on('close', () => {",
        '+      clearInterval(heartbeat);',
        '+      unsubscribe();',
        '+    });',
        '+  });',
        ' ',
        "   app.get('/api/sync-activity', async (req) => {",
      ],
    },
  ]),
  file('src/sync/sync-manager.ts', 'modified', [
    {
      oldStart: 198,
      newStart: 198,
      header: 'async function runSync(repo: RepoRow) {',
      lines: [
        '   for await (const page of walk(repo)) {',
        '     await persistPage(page);',
        '-    done += page.length;',
        '+    done += page.length;',
        '+    emitSyncProgress(repo.accountId, {',
        '+      repoId: repo.id,',
        "+      phase: page.kind,",
        '+      done,',
        '+      total: page.estimatedTotal,',
        '+    });',
        '   }',
      ],
    },
  ]),
];

/** PR id → its files. */
export const DEMO_DIFFS = { 113: PR113, 114: PR114, 116: PR116, 105: PR105, 111: PR111 };

/** A hunk's unified text (with its @@ header). */
export function hunkText(h) {
  const oldLen = h.lines.filter((l) => l[0] !== '+').length;
  const newLen = h.lines.filter((l) => l[0] !== '-').length;
  const head = `@@ -${h.oldStart},${oldLen} +${h.newStart},${newLen} @@${h.header ? ` ${h.header}` : ''}`;
  return [head, ...h.lines].join('\n');
}

/** A file's patch, as GitHub's files listing gives it (no `diff --git` header). */
export function filePatch(f) {
  return f.hunks.map(hunkText).join('\n');
}

/** A file's additions / deletions. */
export function fileStats(f) {
  let additions = 0;
  let deletions = 0;
  for (const h of f.hunks) for (const l of h.lines) {
    if (l[0] === '+') additions++;
    else if (l[0] === '-') deletions++;
  }
  return { additions, deletions };
}

/** Every RIGHT-side line number a file's hunks ADD, in order. */
export function addedLines(f) {
  const out = [];
  for (const h of f.hunks) {
    let n = h.newStart;
    for (const l of h.lines) {
      if (l[0] === '+') out.push(n);
      if (l[0] !== '-') n++;
    }
  }
  return out;
}

/** The whole PR as one unified diff (what `gh pr diff` prints). */
export function unifiedDiff(files) {
  return files
    .map((f) => {
      const a = f.status === 'added' ? '/dev/null' : `a/${f.path}`;
      const b = `b/${f.path}`;
      return [`diff --git a/${f.path} b/${f.path}`, `--- ${a}`, `+++ ${b}`, filePatch(f)].join('\n');
    })
    .join('\n');
}

/** The failing `terraform plan` job's log on #114 (GitHub Actions' line format). */
export const TERRAFORM_PLAN_LOG = [
  '2026-10-21T09:14:02.1840000Z ##[group]Run hashicorp/setup-terraform@v3',
  '2026-10-21T09:14:04.9022000Z Terraform v1.9.5',
  '2026-10-21T09:14:05.0011000Z ##[endgroup]',
  '2026-10-21T09:14:05.2213000Z ##[group]Run terraform init -input=false',
  '2026-10-21T09:14:11.7710000Z Initializing the backend...',
  '2026-10-21T09:14:12.0418000Z Initializing modules...',
  '2026-10-21T09:14:12.0441000Z - workers in ../modules/node-group',
  '2026-10-21T09:14:16.3307000Z Terraform has been successfully initialized!',
  '2026-10-21T09:14:16.3390000Z ##[endgroup]',
  '2026-10-21T09:14:16.5102000Z ##[group]Run terraform plan -input=false -no-color',
  '2026-10-21T09:14:24.1150000Z module.workers.aws_iam_role.this: Refreshing state... [id=acme-prod-workers]',
  '2026-10-21T09:14:25.8801000Z module.workers.aws_eks_node_group.this: Refreshing state... [id=acme-prod:workers]',
  '2026-10-21T09:14:27.4401000Z ╷',
  '2026-10-21T09:14:27.4402000Z │ Error: expected scaling_config.0.max_size to be at least (6), got 4',
  '2026-10-21T09:14:27.4403000Z │ ',
  '2026-10-21T09:14:27.4404000Z │   with module.workers.aws_eks_node_group.this,',
  '2026-10-21T09:14:27.4405000Z │   on ../modules/node-group/main.tf line 21, in resource "aws_eks_node_group" "this":',
  '2026-10-21T09:14:27.4406000Z │   21:     max_size     = var.max_size',
  '2026-10-21T09:14:27.4407000Z ╵',
  '2026-10-21T09:14:27.5120000Z ##[error]Terraform exited with code 1.',
  '2026-10-21T09:14:27.6010000Z ##[error]Process completed with exit code 1.',
].join('\n');

/** Its Actions job id (the PR's stored check run carries it, so the pane offers "View log"). */
export const TERRAFORM_PLAN_JOB_ID = 28_711_000_042;
