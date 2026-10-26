// THE DEMO'S AGENTIC RUNS — finished Claude Reviews, a review chat, a Check threads run, a CI review,
// AI Fix (a finished fix with its change report, and a plan waiting for approval), ticket reviews with
// their contribution cards, design diagrams, the reference library with a docs chat, and a story's
// "Check against docs" — every one stored by the PRODUCT's own pipeline.
//
// HOW, WITHOUT A MODEL. Each feature's model call sits behind a seam: Claude Review calls
// `ctx.review.runReview`, AI Fix `ctx.coding.generateFix` / `generatePlan`, the CI review reads
// checks through `ctx.ci`, the docs check takes `runAgent` / `complete`. Where a seam exists, this
// file hands the real manager a context whose seam answers with the written result below, and the
// manager does everything else — routing, reconciling, hashing, storing. Where the agent is imported
// directly (Check threads, the CI review's agent, design diagrams, the ticket review, the docs build),
// this file walks the manager's own steps with its exported pieces (plan, reconcile, validate,
// persist), in the same order. Nothing leaves the process: no GitHub, no model.
//
// The code the runs talk about is scripts/lib/demo-diffs.mjs, shared with the recorder.
//
// TWO PROVIDERS. The reader switched Settings → AI to Codex for a while and back, so the stored runs
// are a mix, each labelled by what ran: #105 holds a Claude Opus review AND a Codex GPT-6 Astra review
// of the SAME head (the in-situ comparison), with a chat on each. Codex also ran the Check threads pass,
// the CI review, the AI Fix plan, two ticket reviews, #105's design, a library document, a docs-chat
// answer and the story's docs check. A Codex run records what ran through the product's own stamp
// (`ranOn` from the fake agent, or the persist module's `mark…RanOn`), and costs US$ 0 (a ChatGPT
// sign-in has no per-run price).
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
// @ts-expect-error — a plain ESM module shared with the recorder (scripts/lib), no types.
import { DEMO_DIFFS, TERRAFORM_PLAN_JOB_ID, TERRAFORM_PLAN_LOG, addedLines, fileStats, unifiedDiff } from '../../../scripts/lib/demo-diffs.mjs';
import { ticketIdent } from './seed-demo-tracker.js';

const HOUR = 3_600_000;

/** What a Codex run ran on (the deep and standard models; packages/shared AI_MODEL_FOR_ROLE). */
const CODEX_DEEP = { provider: 'codex' as const, model: 'gpt-6-astra' };
const CODEX_STANDARD = { provider: 'codex' as const, model: 'gpt-6.1-sol' };

interface DiffFile {
  path: string;
  status: string;
  hunks: Array<{ oldStart: number; newStart: number; header: string; lines: string[] }>;
}
const DIFFS = DEMO_DIFFS as Record<number, DiffFile[]>;

export interface AgenticSeedCtx {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schema: any;
  now: Date;
  platformWs: number;
}

const quiet = {
  info: () => {},
  debug: () => {},
  trace: () => {},
  fatal: (...a: unknown[]) => console.warn('  ✗', ...a.map((x) => String(x).slice(0, 300))),
  error: (...a: unknown[]) => console.warn('  ✗', ...a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x)).slice(0, 300))),
  warn: (...a: unknown[]) => console.warn('  ⚠', ...a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x)).slice(0, 300))),
  child() {
    return quiet;
  },
  level: 'info',
  silent: () => {},
};

/** Wait for a stored run to leave queued/running. */
async function settle(read: () => Promise<string | null | undefined>, label: string): Promise<string> {
  const t0 = Date.now();
  for (;;) {
    const s = await read();
    if (s != null && s !== 'queued' && s !== 'running' && !['converting', 'sectioning', 'indexing', 'shortlisting', 'reading'].includes(s)) return s;
    if (Date.now() - t0 > 30_000) throw new Error(`${label}: still ${s} after 30s`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

// ── 1. THE DIFFS: file lists, descriptions, threads anchored on real lines ─────────────────────

const DESCRIPTIONS: Record<number, string> = {
  113: `Closes PLAT-292.

Writes a pull request, its review threads and its events in **one transaction**, so a crash part-way through leaves the previous copy of the PR untouched instead of half its threads.

- \`upsertPullRequest\` now runs inside \`runTransaction\` and uses \`onConflictDoUpdate\` instead of read-then-write.
- Thread counts for the open-PR list come from one query (\`threadCountsFor\`) instead of one per PR.
- Derived thread state now follows renamed files (\`previousPaths\`).

**Testing:** the fixture suite in \`src/sync/__fixtures__/threads\` passes; a 400-PR repository synced in 41s before and 38s after.`,
  114: `Part of INFRA-231.

Sets the worker node group's autoscaling bounds so it can scale down at night. Adds a \`workload\` label so the sync workers can be scheduled onto it.`,
  116: `Closes INFRA-244.

Two CloudWatch alarms on the sync queue, routed to the on-call SNS topic:
- queue depth above 500 for ten minutes
- oldest dead-letter message older than an hour`,
  105: `Closes PLAT-301.

Handles GitHub's \`review_requested\` and \`review_request_removed\` webhooks so requested reviewers update within seconds instead of on the next poll.

Depends on #113 (the handler writes through the new upsert).`,
  111: `Closes PLAT-305.

Streams sync progress to the browser over server-sent events: the phase (pull requests, threads, checks) and a count, every page.`,
};

async function applyDiffs(c: AgenticSeedCtx): Promise<void> {
  const { db, schema } = c;
  const { eq, inArray } = await import('drizzle-orm');
  // #116's two bot comments were about the EKS node group, which is #114's change; they are about
  // the alarms this PR adds now.
  const REWRITE: Record<number, string> = {
    30: '⚠️ Potential issue — the dead-letter alarm uses `ApproximateAgeOfOldestMessage` on the DLQ, but `treat_missing_data` is unset, so an empty DLQ reads as INSUFFICIENT_DATA and the alarm never resets to OK.',
    31: '🛠️ Refactor — both alarms repeat the SQS namespace, period and statistic; a small `locals` block would keep the two in step.',
  };
  for (const [id, body] of Object.entries(REWRITE)) {
    await db.update(schema.reviewThreads).set({ path: 'modules/monitoring/alarms.tf' }).where(eq(schema.reviewThreads.id, Number(id))).execute();
    const first = (await db.select({ id: schema.reviewComments.id }).from(schema.reviewComments).where(eq(schema.reviewComments.threadId, Number(id))).orderBy(schema.reviewComments.id).limit(1).execute()) as Array<{ id: number }>;
    if (first[0]) await db.update(schema.reviewComments).set({ body }).where(eq(schema.reviewComments.id, first[0].id)).execute();
  }
  for (const [prIdRaw, files] of Object.entries(DIFFS)) {
    const prId = Number(prIdRaw);
    let additions = 0;
    let deletions = 0;
    const list = files.map((f) => {
      const s = fileStats(f);
      additions += s.additions;
      deletions += s.deletions;
      return { path: f.path, additions: s.additions, deletions: s.deletions };
    });
    await db
      .update(schema.pullRequests)
      .set({ files: list, additions, deletions, changedFiles: files.length, ...(DESCRIPTIONS[prId] ? { body: DESCRIPTIONS[prId] } : {}) })
      .where(eq(schema.pullRequests.id, prId))
      .execute();
    // Every thread on a file of this diff moves to the nearest line the diff ADDS, so the Changes
    // tab shows it on the code and Claude Review can judge it against that code.
    const threads = (await db
      .select({ id: schema.reviewThreads.id, path: schema.reviewThreads.path, line: schema.reviewThreads.line })
      .from(schema.reviewThreads)
      .where(inArray(schema.reviewThreads.prId, [prId]))
      .execute()) as Array<{ id: number; path: string; line: number | null }>;
    const used = new Map<string, Set<number>>();
    for (const t of threads.sort((a, b) => (a.line ?? 0) - (b.line ?? 0))) {
      const f = files.find((x) => x.path === t.path) ?? files[0]!;
      const lines = addedLines(f) as number[];
      const taken = used.get(f.path) ?? new Set<number>();
      used.set(f.path, taken);
      const want = t.line ?? lines[0]!;
      const pick =
        [...lines].sort((a, b) => Math.abs(a - want) - Math.abs(b - want)).find((n) => !taken.has(n)) ??
        lines.reduce((best, n) => (Math.abs(n - want) < Math.abs(best - want) ? n : best), lines[0]!);
      taken.add(pick);
      await db.update(schema.reviewThreads).set({ path: f.path, line: pick }).where(eq(schema.reviewThreads.id, t.id)).execute();
    }
  }
}

// ── the fake context ─────────────────────────────────────────────────────────────────────────

function agentCtx(base: Record<string, unknown>, overrides: Record<string, unknown>): never {
  return {
    ...base,
    log: quiet,
    llm: { detectAuth: () => ({ status: 'ok' as const }) },
    recordAiUsage: async () => {},
    ...overrides,
  } as never;
}

function prepFor(prId: number): Record<string, unknown> {
  const files = DIFFS[prId] ?? [];
  const diff = unifiedDiff(files) as string;
  return { diff, files };
}

// ── 2. CLAUDE REVIEW ─────────────────────────────────────────────────────────────────────────

interface Judgement {
  match: string;
  validity: 'valid' | 'partly_valid' | 'not_valid' | 'unclear';
  addressed: 'addressed' | 'partly_addressed' | 'not_addressed' | 'unclear';
  explanation: string;
  reason: string;
}

/** How Claude judged each OTHER reviewer's thread, keyed by the start of its first comment. */
const THREAD_JUDGEMENTS: Judgement[] = [
  { match: 'Can we batch these inserts', validity: 'valid', addressed: 'not_addressed', explanation: 'The loop in `upsertThreads` still issues one INSERT per comment; it now runs inside the transaction, which keeps it correct but not faster.', reason: 'Still one INSERT per comment inside the loop.' },
  { match: 'Should this run inside the same transaction', validity: 'valid', addressed: 'addressed', explanation: 'Threads and events are now written with `tx` inside `runTransaction`, so they commit or roll back with the pull request.', reason: 'Threads and events now write through the same transaction.' },
  { match: 'nit: pull this 5-minute interval', validity: 'valid', addressed: 'addressed', explanation: 'The cron expression is now the named constant `SYNC_INTERVAL_CRON`.', reason: 'Now the named constant SYNC_INTERVAL_CRON.' },
  { match: 'Is the EXISTS subquery indexed', validity: 'valid', addressed: 'not_addressed', explanation: 'No index covers `events(pr_id, kind)`; the new EXISTS clause runs once per pull request in the list.', reason: 'No index covers events(pr_id, kind) yet.' },
  { match: 'Consider batching these per-PR lookups', validity: 'valid', addressed: 'addressed', explanation: '`threadCountsFor` reads every listed pull request in one query.', reason: 'threadCountsFor reads every PR in one query.' },
  { match: '_⚠️ Potential issue_ — `botUserIds()`', validity: 'valid', addressed: 'partly_addressed', explanation: '`getFeed` now calls `botUserIds()` once per page instead of once per item, but each call still scans the users table.', reason: 'Called once per page now, but still a full scan.' },
  { match: '_🛠️ Refactor suggestion_ — the `case when`', validity: 'partly_valid', addressed: 'not_addressed', explanation: 'The override check is repeated, but the two copies read different columns; merging them needs a schema change first.', reason: 'Fair point, but the two checks read different columns.' },
  { match: '_🧹 Nitpick_ — `emptyCounts()`', validity: 'not_valid', addressed: 'unclear', explanation: 'A four-field object per pull request is negligible next to the query that produced the list.', reason: 'One small object per PR is negligible here.' },
  { match: '_⚠️ Potential issue_ — a renamed file', validity: 'valid', addressed: 'addressed', explanation: '`deriveThreadState` now matches commits against the thread path and its `previousPaths`.', reason: 'Renamed files now count through previousPaths.' },
  { match: '_🛠️ Refactor suggestion_ — prefer `onConflictDoUpdate`', validity: 'valid', addressed: 'addressed', explanation: 'The read-modify-write is gone; the upsert uses `onConflictDoUpdate` on the account and node id.', reason: 'The upsert now uses onConflictDoUpdate.' },
  { match: '_🧹 Nitpick_ — `is_bot_overridden`', validity: 'not_valid', addressed: 'unclear', explanation: 'The upsert filters on the primary key; `is_bot_overridden` is only read, never filtered on.', reason: 'The column is read, never filtered on.' },
  { match: '**Potential issue** — `botUserIds()`', validity: 'valid', addressed: 'partly_addressed', explanation: 'Same point as the CodeRabbit thread: one scan per page now, not per item.', reason: 'Same as CodeRabbit’s thread: once per page now.' },
  { match: '🧹 Nitpick — this cast is redundant', validity: 'not_valid', addressed: 'unclear', explanation: 'The value is typed `unknown` at that point; without the cast the next line does not compile.', reason: 'The value is unknown there; the cast is needed.' },
  { match: '**Suggestion** — the `from`/`to` bounds', validity: 'valid', addressed: 'partly_addressed', explanation: 'The bounds are parsed once for the query but parsed again for the response.', reason: 'Hoisted for the query, still parsed again below.' },
  { match: '🛠️ Refactor — this import block', validity: 'valid', addressed: 'addressed', explanation: 'The import now brings in `runTransaction` and the `Tx` type, and `sql` is used again.', reason: 'The import block was rewritten.' },
  // #105
  { match: '_⚠️ Potential issue_ — the signature check', validity: 'valid', addressed: 'not_addressed', explanation: 'The signature is computed over `JSON.stringify(body)`, not the raw bytes GitHub signed; key order or whitespace differences will reject valid deliveries.', reason: 'Signature still checked on re-serialised JSON.' },
  { match: '_⚠️ Potential issue_ — webhook secrets', validity: 'valid', addressed: 'not_addressed', explanation: 'The untracked-repo log line still includes `process.env.WEBHOOK_SECRET`.', reason: 'The secret is still in the log line.' },
  { match: '_🛠️ Refactor suggestion_ — the delivery-id dedupe', validity: 'valid', addressed: 'not_addressed', explanation: '`seenDeliveries` is never pruned, so it grows for the life of the process.', reason: 'seenDeliveries is never pruned.' },
  { match: '_⚠️ Potential issue_ — a replayed delivery', validity: 'valid', addressed: 'not_addressed', explanation: 'The dedupe map is in memory, so a restart forgets every delivery id.', reason: 'The dedupe map does not survive a restart.' },
  // #116
  { match: '⚠️ Potential issue — the dead-letter alarm', validity: 'valid', addressed: 'not_addressed', explanation: 'Neither alarm sets `treat_missing_data`; an empty dead-letter queue publishes no datapoints.', reason: 'treat_missing_data is still unset.' },
  { match: '🛠️ Refactor — both alarms repeat', validity: 'partly_valid', addressed: 'not_addressed', explanation: 'Two alarms is a small amount of repetition; a locals block would help once a third arrives.', reason: 'Reasonable, but only two alarms share it.' },
  { match: '🧹 Nitpick — align the alarm-threshold', validity: 'valid', addressed: 'unclear', explanation: 'Cosmetic; the values are correct either way.', reason: 'Cosmetic only.' },
];

function judgeThreadsFromPrompt(prompt: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const re = /---BEGIN REVIEW THREAD (R\d+) \S+---\n([\s\S]*?)\n---END REVIEW THREAD \1 /g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(prompt)) != null) {
    const block = m[2]!;
    const j = THREAD_JUDGEMENTS.find((x) => block.includes(x.match));
    out.push(
      j
        ? { ref: m[1], validity: j.validity, addressed: j.addressed, explanation: j.explanation, reason: j.reason }
        : { ref: m[1], validity: 'valid', addressed: 'unclear', explanation: 'The comment is reasonable; the change does not touch the code it is about.', reason: 'Reasonable; the code it is about did not change.' },
    );
  }
  return out;
}

interface ReviewScript {
  prId: number;
  summary: string;
  verdict: 'COMMENT' | 'REQUEST_CHANGES' | 'APPROVE';
  findings: Array<Record<string, unknown>>;
  followUp?: Array<Record<string, unknown>>;
  docReferences?: Array<Record<string, unknown>>;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  numTurns: number;
  /** What ran, when not Claude Opus (the model asked for). */
  ranOn?: { provider: 'claude' | 'codex'; model: string };
}

async function runClaudeReview(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  base: any,
  c: AgenticSeedCtx,
  s: ReviewScript,
): Promise<number> {
  const { mapSubmittedReview } = await import('../src/review/submit-map.js');
  const { analyzeDiff } = await import('../src/review/prepare.js');
  const { startReview } = await import('../src/review/claude-review/manager.js');
  const { diff } = prepFor(s.prId) as { diff: string };
  const fileMetrics = analyzeDiff(diff);
  const ctx = agentCtx(base, {
    review: {
      ...base.review,
      prepareReview: async () => ({
        strippedDiff: diff,
        promptDiff: diff,
        changedFiles: fileMetrics.map((f) => f.path),
        excludedFiles: ['pnpm-lock.yaml'],
        omittedFiles: [],
        fileMetrics,
        diffBytes: diff.length,
        diffCapped: false,
      }),
      runReview: async (args: { prompt: string; strippedDiff: string; mode: string }) => {
        const mapped = mapSubmittedReview(
          {
            scopeUsed: args.mode === 'worktree' ? 'worktree' : 'diff_only',
            summary: s.summary,
            verdict: s.verdict,
            findings: s.findings,
            ...(s.followUp ? { followUp: s.followUp } : {}),
            threads: judgeThreadsFromPrompt(args.prompt),
            ...(s.docReferences ? { docReferences: s.docReferences } : {}),
          } as never,
          args.strippedDiff,
        );
        return {
          submitted: true,
          ...mapped,
          ranOn: s.ranOn ?? { provider: 'claude', model: 'claude-opus-5-5' },
          costUsd: s.costUsd,
          inputTokens: s.inputTokens,
          outputTokens: s.outputTokens,
          cacheReadTokens: Math.round(s.inputTokens * 3.2),
          cacheCreationTokens: Math.round(s.inputTokens * 0.4),
          numTurns: s.numTurns,
          aborted: false,
        };
      },
    },
    github: {
      ...base.github,
      fetchCompareDiff: async () => ({ ok: false, reason: 'not_found' }),
    },
  });
  // The run's provider, as a reader's model pick would name it (the per-run choice).
  const res = await startReview(ctx, 1, s.prId, 'claude-opus-5-5' as never, s.ranOn?.provider ?? 'claude');
  if (!res.ok) throw new Error(`claude review #${s.prId}: ${res.reason}`);
  const { eq } = await import('drizzle-orm');
  const status = await settle(async () => {
    const r = (await c.db.select({ status: c.schema.claudeReviews.status }).from(c.schema.claudeReviews).where(eq(c.schema.claudeReviews.id, res.reviewId)).execute()) as Array<{ status: string }>;
    return r[0]?.status;
  }, `claude review #${s.prId}`);
  if (status !== 'succeeded') {
    const r = await c.db.select().from(c.schema.claudeReviews).where(eq(c.schema.claudeReviews.id, res.reviewId)).execute();
    throw new Error(`claude review #${s.prId} ${status}: ${r[0]?.error}`);
  }
  // Let the run's fire-and-forget tails (diagram trigger, stream) finish before the next one.
  await new Promise((r) => setTimeout(r, 200));
  return res.reviewId;
}

export async function seedDemoAgentic(c: AgenticSeedCtx): Promise<Record<string, unknown>> {
  const { db, schema, now } = c;
  const nowMs = now.getTime();
  const { eq, and, inArray } = await import('drizzle-orm');
  // A succeeded review queues its design diagram, a real agent run. The designs here are written
  // below instead, so the trigger's daily cap is zero for this process (read when it first loads).
  const { config } = await import('../src/config.js');
  (config as { sequenceDiagramDailyCap: number }).sequenceDiagramDailyCap = 0;
  const { buildAgentContext } = await import('../src/review/agent-context.js');
  const base = buildAgentContext(quiet as never) as unknown as Record<string, unknown>;
  const at = (hoursAgo: number) => new Date(nowMs - hoursAgo * HOUR);
  const out: Record<string, unknown> = {};

  await applyDiffs(c);

  // The hand-written review the seeder used to ship is replaced by real runs.
  await db.delete(schema.claudeReviewFindings).where(eq(schema.claudeReviewFindings.reviewId, 1)).execute();
  await db.delete(schema.claudeReviews).where(eq(schema.claudeReviews.id, 1)).execute();

  // ---- the reference library first: the reviews below read it ----
  const docs = await seedReferenceDocs(c);
  out.docs = docs;

  // ---- SonarCloud: the workspace's organization + a read of #113 and #105 at their heads ----
  out.sonar = await seedSonar(c);

  // ---- #113: an earlier review at the previous head, posted; then the latest, automatic one ----
  const head113 = ((await db.select({ h: schema.pullRequests.headSha }).from(schema.pullRequests).where(eq(schema.pullRequests.id, 113)).execute()) as Array<{ h: string }>)[0]!.h;
  const prevHead = createHash('sha1').update('acme-demo:113prev').digest('hex');
  await db.update(schema.pullRequests).set({ headSha: prevHead }).where(eq(schema.pullRequests.id, 113)).execute();
  const runA = await runClaudeReview(base, c, {
    prId: 113,
    summary:
      'The move to one transaction per pull request is the right shape. Two things hold it back: events are still written with the outer `db`, so they escape the transaction, and the comment loop issues one INSERT per comment. The rest is small.',
    verdict: 'REQUEST_CHANGES',
    findings: [
      { path: 'src/sync/upsert.ts', line: 60, side: 'RIGHT', severity: 'blocker', title: 'Events are written outside the transaction', body: '`upsertEvents` is called with the module-level `db`, not `tx`, so a crash after the pull request commits leaves its events missing. Pass `tx` through.', suggestion: '    await upsertEvents(tx, accountId, row.id, pr.timeline);' },
      { path: 'src/sync/upsert.ts', line: 93, side: 'RIGHT', severity: 'warning', title: 'One INSERT per comment', body: 'Each comment is its own round trip inside the loop. A pull request with 200 comments makes 200 statements; one multi-row insert per thread would do.' },
      { path: 'src/sync/scheduler.ts', line: 37, side: 'RIGHT', severity: 'nit', title: 'Name the cron interval', body: 'The literal `"*/5 * * * *"` is repeated in the docs. A named constant makes the two easy to keep in step.' },
      { path: 'src/db/queries.ts', line: 214, side: 'RIGHT', severity: 'question', title: 'Is events(pr_id, kind) indexed?', body: 'The new EXISTS runs per pull request in the list. Is there an index on `events(pr_id, kind)`, or does this scan?' },
    ],
    costUsd: 0.91,
    inputTokens: 52_400,
    outputTokens: 3_900,
    numTurns: 9,
  });
  // Morgan posted it, verbatim, yesterday (the reviews row PRR_demo113 is that post).
  const postedAt = at(26);
  await db
    .update(schema.claudeReviews)
    .set({ createdAt: at(27), finishedAt: at(26.8), postedReviewId: 'PRR_demo113', postedAt, userVerdict: 'REQUEST_CHANGES' })
    .where(eq(schema.claudeReviews.id, runA))
    .execute();
  const aFindings = (await db.select({ id: schema.claudeReviewFindings.id, severity: schema.claudeReviewFindings.severity }).from(schema.claudeReviewFindings).where(eq(schema.claudeReviewFindings.reviewId, runA)).execute()) as Array<{ id: number; severity: string }>;
  for (const f of aFindings) {
    await db
      .update(schema.claudeReviewFindings)
      .set({ included: true, postedAt, githubCommentId: String(880_000 + f.id), postedCommentKind: 'inline' })
      .where(eq(schema.claudeReviewFindings.id, f.id))
      .execute();
  }
  await db.update(schema.pullRequests).set({ headSha: head113 }).where(eq(schema.pullRequests.id, 113)).execute();

  const runB = await runClaudeReview(base, c, {
    prId: 113,
    summary:
      'Events now commit with the pull request, and the named cron constant is in. One blocker remains: the schema gains `is_bot` and `is_bot_overridden` but no migration adds them, so the first sync after deploy fails. The comment loop still issues one INSERT per comment.',
    verdict: 'REQUEST_CHANGES',
    followUp: [
      { ref: 'P1', status: 'addressed', explanation: '`upsertEvents` now receives `tx`, so events commit or roll back with the pull request.' },
      { ref: 'P2', status: 'not_addressed', explanation: 'The loop still runs one INSERT per comment; only the handle changed to `tx`.' },
      { ref: 'P3', status: 'addressed', explanation: 'The interval is the named constant `SYNC_INTERVAL_CRON`.' },
      { ref: 'P4', status: 'not_addressed', explanation: 'No migration in this change adds an index on `events(pr_id, kind)`.' },
    ],
    findings: [
      { path: 'src/db/schema.sqlite.ts', line: 125, side: 'RIGHT', severity: 'blocker', lens: 'impact', title: 'New columns have no migration', body: '`is_bot` and `is_bot_overridden` are added to `review_threads` in the schema, but no migration in this change creates them. The boot-time migrator will not add them, and the first write to `isBot` fails with "no such column".', docRefs: [{ path: 'sync-runbook/sections/03-schema-changes.md', quote: 'Every column added to the schema needs a migration in the same pull request' }] },
      { path: 'src/sync/upsert.ts', line: 93, side: 'RIGHT', severity: 'warning', priorRef: 'P2', title: 'One INSERT per comment', body: 'Still one statement per comment. Inside the transaction this also holds the SQLite write lock for the whole loop; batching per thread shortens that window.' },
      { path: 'src/sync/derive-thread-state.ts', line: 49, side: 'RIGHT', severity: 'warning', lens: 'tests', title: 'previousPaths is never filled in', body: '`deriveThreadState` reads `thread.previousPaths`, but nothing in the sync sets it, so renamed files still read as untouched. Either populate it from the files listing or add a fixture that shows it working.' },
      { path: 'src/sync/upsert.ts', line: 138, side: 'RIGHT', severity: 'nit', title: 'Say that derived state runs after commit', body: 'The function comment says everything is one transaction, but `deriveThreadStates` runs after it commits. Worth one line so nobody moves it inside by accident.' },
      { path: 'src/db/queries.ts', line: 215, side: 'RIGHT', severity: 'question', title: 'Is this filter meant to hide draft-only PRs?', body: 'The EXISTS keeps only pull requests with a pushed commit event. Is that to hide PRs opened with no commits, or a leftover from debugging?' },
    ],
    docReferences: [
      { path: 'sync-runbook/sections/03-schema-changes.md', quote: 'Every column added to the schema needs a migration in the same pull request' },
      { path: 'sync-runbook/sections/02-transactions.md', quote: 'Derived state is computed after the transaction commits' },
    ],
    costUsd: 1.37,
    inputTokens: 71_800,
    outputTokens: 5_200,
    numTurns: 14,
  });
  // Auto-posting is on for Platform (seed-demo-platform.ts): the run posted its blocker, warnings and
  // question as one review under Morgan's account; nits stay unposted (the workspace leaves them out).
  const bRows = (await db.select({ id: schema.claudeReviewFindings.id, severity: schema.claudeReviewFindings.severity }).from(schema.claudeReviewFindings).where(eq(schema.claudeReviewFindings.reviewId, runB)).execute()) as Array<{ id: number; severity: string }>;
  const posted = bRows.filter((f) => f.severity !== 'nit').map((f) => f.id);
  for (const id of posted) {
    await db
      .update(schema.claudeReviewFindings)
      .set({ included: true, postedAt: at(1.95), postedAuto: true, githubCommentId: String(881_000 + id), postedCommentKind: 'inline' })
      .where(eq(schema.claudeReviewFindings.id, id))
      .execute();
  }
  await db
    .update(schema.claudeReviews)
    .set({
      trigger: 'auto',
      createdAt: at(2.2),
      finishedAt: at(2),
      postedReviewId: 'PRR_demo113b',
      postedAt: at(1.95),
      autoPost: { status: 'posted', at: at(1.95).toISOString(), reason: null, error: null, findingIds: posted, postedFindingIds: posted, githubReviewId: 'PRR_demo113b' },
    })
    .where(eq(schema.claudeReviews.id, runB))
    .execute();
  out.claude113 = [runA, runB];

  // ---- Related repos (Settings → Workspace → Related repos): acme/api and acme/infrastructure are
  // reviewed together. #113's latest run read infrastructure's branch of the same name (no PR there),
  // which the review shows as "Also read". Stored both ways, like the server writes it.
  for (const [repoId, relatedRepoId] of [
    [2, 3],
    [3, 2],
  ] as const) {
    await db
      .insert(schema.repoRelations)
      .values({ accountId: 1, workspaceId: c.platformWs, repoId, relatedRepoId })
      .onConflictDoNothing()
      .execute();
  }
  await db
    .update(schema.claudeReviews)
    .set({
      peersRead: [
        { repoFullName: 'acme/infrastructure', kind: 'branch', source: 'related_repo', number: null, branch: 'PLAT-292-upsert-transaction-boundaries' },
      ],
    })
    .where(eq(schema.claudeReviews.id, runB))
    .execute();

  // ---- #114 (failing CI), #116 and #105: one review each ----
  const run114 = await runClaudeReview(base, c, {
    prId: 114,
    summary: 'The node group cannot be created as written: `min_size` is 6 and `max_size` is 4, which is the error `terraform plan` reports. Swap the bounds to the 2 and 8 the ticket asks for.',
    verdict: 'REQUEST_CHANGES',
    findings: [
      { path: 'terraform/eks/node-groups.tf', line: 20, side: 'RIGHT', severity: 'blocker', title: 'max_size is below min_size', body: 'EKS rejects a scaling config whose `max_size` (4) is below `min_size` (6). INFRA-231 asks for 2 to 8.', suggestion: '    min_size     = 2\n    max_size     = 8' },
      { path: 'terraform/eks/variables.tf', line: 33, side: 'RIGHT', severity: 'nit', title: 'worker_max_nodes is not used', body: 'The new variable is declared but `node-groups.tf` still hard-codes the bound.' },
    ],
    costUsd: 0.44,
    inputTokens: 21_300,
    outputTokens: 1_700,
    numTurns: 5,
  });
  await db.update(schema.claudeReviews).set({ createdAt: at(5.2), finishedAt: at(5) }).where(eq(schema.claudeReviews.id, run114)).execute();

  const run116 = await runClaudeReview(base, c, {
    prId: 116,
    summary: 'Both alarms match INFRA-244. One gap: neither sets `treat_missing_data`, so the dead-letter alarm never returns to OK once the queue empties.',
    verdict: 'COMMENT',
    findings: [
      { path: 'modules/monitoring/alarms.tf', line: 16, side: 'RIGHT', severity: 'warning', title: 'Set treat_missing_data on the DLQ alarm', body: 'An empty queue publishes no datapoints for `ApproximateAgeOfOldestMessage`. With the default (`missing`) the alarm sits in INSUFFICIENT_DATA instead of OK.', suggestion: '  treat_missing_data  = "notBreaching"' },
    ],
    costUsd: 0.29,
    inputTokens: 14_100,
    outputTokens: 1_100,
    numTurns: 4,
  });
  await db.update(schema.claudeReviews).set({ trigger: 'auto', createdAt: at(30), finishedAt: at(29.8) }).where(eq(schema.claudeReviews.id, run116)).execute();

  const run105 = await runClaudeReview(base, c, {
    prId: 105,
    summary: 'The handler does what PLAT-301 asks, but it should not merge yet: the signature is checked against re-serialised JSON rather than the raw body, and the webhook secret is written to the log.',
    verdict: 'REQUEST_CHANGES',
    findings: [
      { path: 'src/api/routes/webhooks.ts', line: 13, side: 'RIGHT', severity: 'blocker', lens: 'security', title: 'Verify the signature on the raw body', body: 'GitHub signs the exact bytes it sent. `JSON.stringify(req.body)` can differ in key order and whitespace, so valid deliveries fail, and the check proves nothing about what was parsed. Use the raw body Fastify kept.', suggestion: "    if (!verifySignature(req.rawBody, req.headers['x-hub-signature-256'])) {" },
      { path: 'src/api/routes/webhooks.ts', line: 25, side: 'RIGHT', severity: 'blocker', lens: 'security', title: 'The webhook secret is logged', body: 'The untracked-repo log line includes `process.env.WEBHOOK_SECRET`. Anyone with log access can forge deliveries.' },
    ],
    costUsd: 0.63,
    inputTokens: 30_200,
    outputTokens: 2_300,
    numTurns: 7,
  });
  await db.update(schema.claudeReviews).set({ createdAt: at(20), finishedAt: at(19.8) }).where(eq(schema.claudeReviews.id, run105)).execute();

  // ---- #105 again, SAME head, on Codex GPT-6 Astra: the in-situ comparison with the Opus run ----
  // Both keep their own labels in the run history. Astra agrees on the two blockers and adds the
  // delivery-id map and a question; Opus's run is the one above.
  const run105Codex = await runClaudeReview(base, c, {
    prId: 105,
    summary:
      'Not ready to merge. The signature is checked against re-serialised JSON instead of the raw body GitHub signed, the webhook secret is logged, and the delivery-id map is never pruned and is lost on restart, so a delivery replayed after a deploy is accepted.',
    verdict: 'REQUEST_CHANGES',
    findings: [
      { path: 'src/api/routes/webhooks.ts', line: 13, side: 'RIGHT', severity: 'blocker', lens: 'security', title: 'Signature checked on re-serialised JSON', body: '`JSON.stringify(body)` is not the byte sequence GitHub signed, so key order or whitespace differences reject valid deliveries. Verify against the raw body (`rawBody: true` is already set on the route).', suggestion: "    if (!verifySignature(req.rawBody, req.headers['x-hub-signature-256'])) {" },
      { path: 'src/api/routes/webhooks.ts', line: 25, side: 'RIGHT', severity: 'blocker', lens: 'security', title: 'Secret written to the log', body: 'The log line for an untracked repository includes `process.env.WEBHOOK_SECRET`. Log the delivery id instead.' },
      { path: 'src/api/routes/webhooks.ts', line: 6, side: 'RIGHT', severity: 'warning', title: 'Delivery ids live only in memory', body: '`seenDeliveries` grows for the life of the process and is empty after a restart, so a replayed delivery is accepted after every deploy. Store delivery ids in the database with an expiry.' },
      { path: 'src/api/routes/webhooks.ts', line: 20, side: 'RIGHT', severity: 'question', title: 'Does a removed request delete the row?', body: '`review_request_removed` goes through the same upsert as `review_requested`. Does the upsert remove the reviewer, or does the old request stay?' },
    ],
    costUsd: 0,
    inputTokens: 33_900,
    outputTokens: 2_900,
    numTurns: 8,
    ranOn: CODEX_DEEP,
  });
  await db.update(schema.claudeReviews).set({ createdAt: at(18), finishedAt: at(17.7) }).where(eq(schema.claudeReviews.id, run105Codex)).execute();
  out.reviews = { run114, run116, run105, run105Codex };

  // ---- the review chat on #113's latest run ----
  const bFindings = (await db.select({ id: schema.claudeReviewFindings.id, title: schema.claudeReviewFindings.title }).from(schema.claudeReviewFindings).where(eq(schema.claudeReviewFindings.reviewId, runB)).execute()) as Array<{ id: number; title: string }>;
  const migration = bFindings.find((f) => f.title.startsWith('New columns'))!;
  const chat = [
    { findingId: null, role: 'user', content: 'Which of these should block the merge?', at: 1.6 },
    { findingId: null, role: 'assistant', content: 'Only **New columns have no migration**. Without it the first sync after deploy writes to `is_bot` and fails, on every repository.\n\nThe INSERT loop is a performance point, not a correctness one, and the other two are small. If Priya adds the migration, the rest can land in a follow-up.', at: 1.58 },
    { findingId: migration.id, role: 'user', content: 'What would the migration look like?', at: 1.4 },
    { findingId: migration.id, role: 'assistant', content: 'Two additive columns with defaults, so existing rows are valid at once:\n\n```sql\nALTER TABLE review_threads ADD COLUMN is_bot integer NOT NULL DEFAULT 0;\nALTER TABLE review_threads ADD COLUMN is_bot_overridden integer NOT NULL DEFAULT 0;\n```\n\nRegister it in `migrations/meta/_journal.json`, or the boot skips it.', at: 1.38 },
  ];
  for (const m of chat) {
    await db
      .insert(schema.claudeReviewChatMessages)
      .values({
        accountId: 1,
        reviewId: runB,
        findingId: m.findingId,
        role: m.role,
        content: m.content,
        ...(m.role === 'assistant' ? { provider: 'claude', model: 'claude-sonnet-5', costUsd: 0.012, inputTokens: 9_100, outputTokens: 240 } : {}),
        createdAt: at(m.at),
      })
      .execute();
  }

  // ---- a chat on #105's Codex run, answered by Codex ----
  const codexChat = [
    { role: 'user', content: 'Is the delivery-id map a blocker on its own?', at: 17.5 },
    { role: 'assistant', content: 'Not on its own. A replay is only accepted after a restart, and GitHub does not resend deliveries by itself. It matters more once the signature check is fixed, because then a captured delivery is the easiest way in. Keep it here if the database change is small; otherwise open a ticket and land the two blockers first.', at: 17.48 },
  ];
  for (const m of codexChat) {
    await db
      .insert(schema.claudeReviewChatMessages)
      .values({
        accountId: 1,
        reviewId: run105Codex,
        findingId: null,
        role: m.role,
        content: m.content,
        ...(m.role === 'assistant' ? { ...CODEX_STANDARD, costUsd: 0, inputTokens: 8_700, outputTokens: 260 } : {}),
        createdAt: at(m.at),
      })
      .execute();
  }

  // ---- Check threads on #113: a reply after the review, judged by the light pass ----
  out.threadCheck = await seedThreadCheck(base, c, runB);

  // ---- the CI review of #114's failing plan ----
  out.ciReview = await seedCiReview(base, c);

  // ---- AI Fix: a finished fix on #114 and a plan waiting on #113 ----
  out.aiFix = await seedAiFix(base, c, { run114, runB });

  // ---- ticket reviews, contribution cards, designs, the docs check ----
  out.tickets = await seedTicketReviews(base, c);
  out.designs = await seedDesigns(base, c);
  out.storyDocs = await seedStoryDocs(base, c);
  void and;
  void inArray;
  return out;
}

// ── SONARCLOUD ───────────────────────────────────────────────────────────────────────────────

async function seedSonar(c: AgenticSeedCtx): Promise<number> {
  const { db, schema, now } = c;
  const { eq } = await import('drizzle-orm');
  const { writeWorkspaceSonar } = await import('../src/sonar/settings.js');
  const { upsertSonarSnapshot } = await import('../src/sonar/store.js');
  const sc = { db, schema };
  const w = await writeWorkspaceSonar(sc, 1, c.platformWs, { organization: 'acme', token: 'demo-sonar-token-not-real' });
  if (!w.ok) throw new Error(`sonar settings: ${w.message}`);
  const code = (lines: Array<[number, string, boolean]>) => lines.map(([line, text, flagged]) => ({ line, code: text, flagged }));
  const issue = (o: Record<string, unknown>): Record<string, unknown> => ({
    ruleName: null,
    type: 'CODE_SMELL',
    endLine: null,
    effort: '5min',
    tags: [],
    securityCategory: null,
    whyIsThisAnIssue: null,
    howToFix: null,
    code: [],
    ...o,
    url: `https://sonarcloud.io/project/issues?id=${String(o.project)}&pullRequest=${String(o.pr)}&open=${String(o.key)}`,
  });
  const SNAPSHOTS: Array<{ prId: number; project: string; pr: number; gate: Record<string, unknown>; issues: Array<Record<string, unknown>>; hotspots: number }> = [
    {
      prId: 113,
      project: 'acme_api',
      pr: 113,
      gate: {
        status: 'ERROR',
        conditions: [
          { metric: 'new_coverage', status: 'ERROR', actual: '61.4', threshold: '80', comparator: 'LT', files: [{ path: 'src/sync/upsert.ts', lines: 11 }, { path: 'src/db/queries.ts', lines: 6 }] },
          { metric: 'new_duplicated_lines_density', status: 'OK', actual: '0.0', threshold: '3', comparator: 'GT' },
          { metric: 'new_reliability_rating', status: 'OK', actual: '1', threshold: '1', comparator: 'GT' },
        ],
        measures: [
          { metric: 'new_coverage', value: '61.4' },
          { metric: 'new_duplicated_lines_density', value: '0.0' },
          { metric: 'new_lines', value: '51' },
        ],
      },
      issues: [
        { key: 'AZ-acme-113-1', kind: 'issue', rule: 'typescript:S3776', ruleName: 'Cognitive Complexity of functions should not be too high', severity: 'critical', type: 'CODE_SMELL', message: 'Refactor this function to reduce its Cognitive Complexity from 17 to the 15 allowed.', path: 'src/sync/upsert.ts', line: 52, effort: '7min', tags: ['brain-overload'], whyIsThisAnIssue: 'Code that is hard to follow is hard to change safely.', howToFix: 'Split the function into smaller ones with one job each.', code: code([[52, 'export async function upsertPullRequest(accountId: number, pr: GithubPr): Promise<number> {', true], [53, '  return runTransaction(async (tx) => {', false]]) },
        { key: 'AZ-acme-113-2', kind: 'issue', rule: 'typescript:S4325', ruleName: 'Redundant casts and non-null assertions should be avoided', severity: 'minor', type: 'CODE_SMELL', message: 'This assertion is unnecessary since it does not change the type of the expression.', path: 'src/sync/upsert.ts', line: 97, tags: ['redundant'] },
        { key: 'AZ-acme-113-3', kind: 'issue', rule: 'typescript:S1854', ruleName: 'Unused assignments should be removed', severity: 'major', type: 'CODE_SMELL', message: 'Remove this useless assignment to variable "from".', path: 'src/api/routes/timeline.ts', line: 41, tags: ['unused'] },
      ],
      hotspots: 0,
    },
    {
      prId: 105,
      project: 'acme_api',
      pr: 105,
      gate: {
        status: 'ERROR',
        conditions: [
          { metric: 'new_security_hotspots_reviewed', status: 'ERROR', actual: '0.0', threshold: '100', comparator: 'LT' },
          { metric: 'new_coverage', status: 'ERROR', actual: '0.0', threshold: '80', comparator: 'LT', files: [{ path: 'src/api/routes/webhooks.ts', lines: 31 }] },
        ],
        measures: [{ metric: 'new_coverage', value: '0.0' }, { metric: 'new_lines', value: '34' }],
      },
      issues: [
        { key: 'AZ-acme-105-1', kind: 'hotspot', rule: 'typescript:S5332', ruleName: 'Logging should not expose secrets', severity: 'major', type: 'SECURITY_HOTSPOT', message: 'Make sure this log line does not write a secret.', path: 'src/api/routes/webhooks.ts', line: 25, securityCategory: 'insecure-conf', whyIsThisAnIssue: 'Logs are read by more people and kept longer than the systems they describe.', howToFix: 'Log the delivery id and the event name, never a secret or a token.' },
        { key: 'AZ-acme-105-2', kind: 'issue', rule: 'typescript:S6544', ruleName: 'Promises should not be misused', severity: 'major', type: 'BUG', message: 'Promise returned in function argument where a void return was expected.', path: 'src/api/routes/webhooks.ts', line: 28 },
      ],
      hotspots: 1,
    },
  ];
  for (const sn of SNAPSHOTS) {
    const head = ((await db.select({ h: schema.pullRequests.headSha }).from(schema.pullRequests).where(eq(schema.pullRequests.id, sn.prId)).execute()) as Array<{ h: string }>)[0]!.h;
    const issues = sn.issues.map((i) => issue({ ...i, project: sn.project, pr: sn.pr }));
    await upsertSonarSnapshot(
      sc,
      1,
      sn.prId,
      head,
      sn.project,
      { state: 'ok', message: null, qualityGate: sn.gate as never, issues: issues as never, totalIssues: issues.filter((i) => i.kind === 'issue').length, totalHotspots: sn.hotspots },
      new Date(now.getTime() - 2.5 * HOUR),
    );
  }
  return SNAPSHOTS.length;
}

// ── 3. CHECK THREADS ─────────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function seedThreadCheck(base: any, c: AgenticSeedCtx, _reviewId: number): Promise<number> {
  const { db, schema, now } = c;
  const { eq } = await import('drizzle-orm');
  // Priya answers Morgan's batching thread after the review.
  const thread = ((await db.select({ id: schema.reviewThreads.id }).from(schema.reviewThreads).where(eq(schema.reviewThreads.prId, 113)).execute()) as Array<{ id: number }>).map((t) => t.id);
  const firsts = (await db.select({ threadId: schema.reviewComments.threadId, body: schema.reviewComments.body }).from(schema.reviewComments).execute()) as Array<{ threadId: number; body: string }>;
  const batching = thread.find((id) => firsts.some((f) => f.threadId === id && f.body.startsWith('Can we batch these inserts')))!;
  const replyAt = new Date(now.getTime() - 50 * 60_000);
  await db
    .insert(schema.reviewComments)
    .values({ githubNodeId: 'PRRC_demo_reply_batch', threadId: batching, prId: 113, authorId: 2, body: 'Fair. I’ll batch per thread in a follow-up; PLAT-319 is open for it so this one can land.', excerpt: 'Fair. I’ll batch per thread in a follow-up', databaseId: 990_001, createdAt: replyAt })
    .execute();

  const ctx = agentCtx(base, {});
  const { planThreadCheck, THREAD_CHECK_MODEL } = await import('../src/review/claude-review/thread-check.js');
  const { insertQueuedThreadCheck, markThreadCheckRunning, saveThreadCheckSuccess } = await import('../src/review/claude-review/thread-check-persist.js');
  const { reconcileThreads } = await import('../src/review/claude-review/threads.js');
  const head = ((await db.select({ h: schema.pullRequests.headSha }).from(schema.pullRequests).where(eq(schema.pullRequests.id, 113)).execute()) as Array<{ h: string }>)[0]!.h;
  const planned = await planThreadCheck(ctx, 1, 113, head);
  if (!planned) throw new Error('thread check: nothing to plan');
  const id = await insertQueuedThreadCheck(ctx, { accountId: 1, workspaceId: c.platformWs, prId: 113, repoId: 2, headSha: head, trigger: 'manual', model: THREAD_CHECK_MODEL, commentsThrough: null } as never);
  await markThreadCheckRunning(ctx, 1, id, { headSha: head, threadsSent: planned.plan.sent.length, commentsThrough: planned.newestCommentAt, startedAt: new Date(now.getTime() - 40 * 60_000) });
  const reports = planned.plan.sent.map((s) => {
    const first = s.thread.comments[0]?.body ?? '';
    if (first.startsWith('Can we batch these inserts')) {
      return { ref: s.ref, validity: 'valid', addressed: 'not_addressed', explanation: 'Still one INSERT per comment; Priya has agreed to batch it in a follow-up ticket.', reason: 'Deferred to a follow-up ticket by the author.' };
    }
    const j = THREAD_JUDGEMENTS.find((x) => first.startsWith(x.match) || first.includes(x.match));
    return { ref: s.ref, validity: j?.validity ?? 'valid', addressed: j?.addressed ?? 'unclear', explanation: j?.explanation ?? 'No change since the last judgement.', reason: j?.reason ?? 'No change since the last judgement.' };
  });
  // Run on Codex (its standard model): this thread's pill names Codex, the review's pills Claude.
  const { markThreadCheckRanOn } = await import('../src/review/claude-review/thread-check-persist.js');
  await markThreadCheckRanOn(ctx, 1, id, CODEX_STANDARD);
  await saveThreadCheckSuccess(ctx, 1, id, { costUsd: 0, inputTokens: 8_400, outputTokens: 520, numTurns: 2, assessments: reconcileThreads(planned.plan, reports as never) });
  await db.update(schema.claudeThreadChecks).set({ createdAt: new Date(now.getTime() - 41 * 60_000), completedAt: new Date(now.getTime() - 39 * 60_000) }).where(eq(schema.claudeThreadChecks.id, id)).execute();
  return id;
}

// ── 4. CI REVIEW ─────────────────────────────────────────────────────────────────────────────


// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function seedCiReview(base: any, c: AgenticSeedCtx): Promise<number> {
  const { db, schema, now } = c;
  const { eq } = await import('drizzle-orm');
  const pr = ((await db.select().from(schema.pullRequests).where(eq(schema.pullRequests.id, 114)).execute()) as Array<Record<string, unknown>>)[0]!;
  const head = pr.headSha as string;
  // The PR's stored check runs gain Actions job ids, so the pane offers "View log".
  const runs = [
    { name: 'terraform plan', state: 'failure', url: `https://github.com/acme/infrastructure/actions/runs/1187220031/job/${TERRAFORM_PLAN_JOB_ID}`, runId: 1_187_220_031, jobId: TERRAFORM_PLAN_JOB_ID },
    { name: 'tflint', state: 'success', url: 'https://github.com/acme/infrastructure/actions/runs/1187220031/job/28711000043', runId: 1_187_220_031, jobId: 28_711_000_043 },
    { name: 'checkov', state: 'success', url: 'https://github.com/acme/infrastructure/actions/runs/1187220031/job/28711000044', runId: 1_187_220_031, jobId: 28_711_000_044 },
  ];
  await db.update(schema.pullRequests).set({ checkRuns: runs }).where(eq(schema.pullRequests.id, 114)).execute();

  const checks = runs;
  const ctx = agentCtx(base, {
    ci: {
      readCommitChecks: async () => ({ ok: true, checks, rollupState: 'FAILURE' }),
      readJobLog: async () => ({ available: true, text: TERRAFORM_PLAN_LOG, totalLines: TERRAFORM_PLAN_LOG.split('\n').length, returnedLines: TERRAFORM_PLAN_LOG.split('\n').length, totalBytes: TERRAFORM_PLAN_LOG.length, startByte: 0, endByte: TERRAFORM_PLAN_LOG.length, hasMore: false, truncated: false }),
      readFailedStep: async () => 'terraform plan',
    },
  });
  const { readCiInputs } = await import('../src/review/ci-review/prepare.js');
  const { insertQueuedCiReview, markCiReviewRunning, saveCiReviewSuccess } = await import('../src/review/ci-review/persist.js');
  const { reconcileCiReview } = await import('../src/review/ci-review/reconcile.js');
  const inputs = await readCiInputs(ctx, { accountId: 1, prId: 114, owner: 'acme', name: 'infrastructure', headSha: head, prior: null });
  if (!inputs.ok) throw new Error(`ci review inputs refused: ${inputs.reason}`);
  const id = await insertQueuedCiReview(ctx, { accountId: 1, workspaceId: c.platformWs, prId: 114, repoId: 3, headSha: head, triggerKey: inputs.failingChecks.slice().sort().join('\u0000'), trigger: 'auto', model: 'claude-opus-5-5' } as never);
  await markCiReviewRunning(ctx, 1, id, { headSha: head, failingChecks: inputs.failingChecks, ciState: inputs.ciState, clearTrigger: false });
  const payload = {
    summary: '`terraform plan` fails because the worker node group’s `max_size` (4) is below its `min_size` (6). The fix is in this pull request.',
    failures: inputs.plan.sent.map((s: { ref: string }) => ({
      ref: s.ref,
      cause: 'max_size is below min_size',
      explanation: 'The log fails at "expected scaling_config.0.max_size to be at least (6), got 4". `terraform/eks/node-groups.tf` sets `min_size = 6` and `max_size = 4` on `module.workers`.',
      category: 'config',
      fixableInPr: true,
      confidence: 95,
      path: 'terraform/eks/node-groups.tf',
      line: 20,
      suggestion: 'Set `min_size = 2` and `max_size = 8`, as INFRA-231 asks; `desired_size = 4` then sits inside the range.',
      relatedFiles: [{ path: 'modules/node-group/main.tf', line: 21 }],
    })),
  };
  const { summary, items } = reconcileCiReview(inputs.plan, payload as never, inputs.carriedExtras);
  // Run on Codex GPT-6 Astra.
  const { markCiReviewRanOn } = await import('../src/review/ci-review/persist.js');
  await markCiReviewRanOn(ctx, 1, id, CODEX_DEEP);
  await saveCiReviewSuccess(ctx, 1, id, { summary, costUsd: 0, inputTokens: 16_900, outputTokens: 900, numTurns: 4, items });
  await db.update(schema.ciReviews).set({ createdAt: new Date(now.getTime() - 4.4 * HOUR), completedAt: new Date(now.getTime() - 4.3 * HOUR) }).where(eq(schema.ciReviews.id, id)).execute();
  return id;
}

// ── 5. AI FIX ────────────────────────────────────────────────────────────────────────────────

const FIX_114_PATCH = [
  'diff --git a/terraform/eks/node-groups.tf b/terraform/eks/node-groups.tf',
  'index 3f1c2ab..9d4e7c1 100644',
  '--- a/terraform/eks/node-groups.tf',
  '+++ b/terraform/eks/node-groups.tf',
  '@@ -17,9 +17,9 @@ module "workers" {',
  ' ',
  '   scaling_config {',
  '-    min_size     = 6',
  '-    max_size     = 4',
  '+    min_size     = 2',
  '+    max_size     = var.worker_max_nodes',
  '     desired_size = 4',
  '   }',
  ' ',
].join('\n');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function seedAiFix(base: any, c: AgenticSeedCtx, runs: { run114: number; runB: number }): Promise<Record<string, number>> {
  const { db, schema, now } = c;
  const { eq } = await import('drizzle-orm');
  // The old seeded fix (seed 'ci_analysis', a retired seed) goes; the runs below replace it.
  await db.delete(schema.aiFixes).execute();
  const heads = (await db.select({ id: schema.pullRequests.id, h: schema.pullRequests.headSha, ref: schema.pullRequests.headRefName }).from(schema.pullRequests).execute()) as Array<{ id: number; h: string; ref: string | null }>;
  const headOf = (id: number) => heads.find((x) => x.id === id)!;
  let shownRefs: readonly string[] = [];
  const ctx = agentCtx(base, {
    github: {
      ...base.github,
      fetchPrHeadInfo: async (_a: number, owner: string, name: string, n: number) => {
        const h = headOf(n);
        return { headSha: h.h, headRef: h.ref ?? 'main', headRepoFullName: `${owner}/${name}`, isFork: false, maintainerCanModify: true, baseRef: 'main' };
      },
      fetchPrDiff: async (_a: number, _o: string, _n: string, number: number) => unifiedDiff(DIFFS[number] ?? []),
    },
    coding: {
      ...base.coding,
      generateFix: async (args: { prompt: string; baseSha: string }) => {
        const refs = [...new Set(args.prompt.match(/\b[FTCQS]\d+\b/g) ?? [])];
        return {
          summary: 'Set the worker node group to scale between 2 and 8 nodes, reading the upper bound from the new `worker_max_nodes` variable so the variable is no longer unused. `desired_size = 4` sits inside the range.',
          commitMessage: 'fix(eks): scale the worker node group between 2 and 8 nodes',
          report: {
            changes: [
              { path: 'terraform/eks/node-groups.tf', summary: 'min_size 6 → 2; max_size reads var.worker_max_nodes (8).', refs: refs.filter((r) => r.startsWith('F') || r.startsWith('C')).slice(0, 3) },
            ],
            unaddressed: refs.filter((r) => r.startsWith('T')).slice(0, 1).map((ref) => ({ ref, reason: 'A naming preference with no effect on the plan; left as it is.' })),
          },
          patch: FIX_114_PATCH,
          filesChanged: ['terraform/eks/node-groups.tf'],
          baseSha: args.baseSha,
          usage: { inputTokens: 18_400, outputTokens: 1_250, cacheReadTokens: 61_000, cacheCreationTokens: 7_400 },
          costUsd: 0.36,
          numTurns: 7,
          aborted: false,
        };
      },
      generatePlan: async (args: { shownRefs: readonly string[] }) => {
        shownRefs = args.shownRefs;
        const r = (prefix: string) => args.shownRefs.filter((x) => x.startsWith(prefix));
        return {
          plan: {
            summary: [
              'Add the migration for the two new review_threads columns.',
              'Batch each thread’s comments into one INSERT.',
              'Fill previousPaths from the files listing so renames count.',
            ],
            steps: [
              { title: 'Add the missing migration', change: 'Create `0126_review_threads_is_bot.sql` with two `ALTER TABLE … ADD COLUMN … DEFAULT 0` statements and register it in the journal.', files: ['src/db/migrations/0126_review_threads_is_bot.sql', 'src/db/migrations/meta/_journal.json'], refs: r('F').slice(0, 1) },
              { title: 'Batch comment inserts per thread', change: 'Build the rows for a thread first and write them with one multi-row `insert().values(rows).onConflictDoNothing()`.', files: ['src/sync/upsert.ts'], refs: r('F').slice(1, 2) },
              { title: 'Populate previousPaths', change: 'Read `previous_filename` from the files listing during the walk and pass it into the thread facts.', files: ['src/sync/walk.ts', 'src/sync/derive-thread-state.ts'], refs: r('F').slice(2, 3) },
            ],
            notAddressed: r('T').slice(0, 1).map((ref) => ({ ref, reason: 'The author deferred it to PLAT-319; doing it here would collide with that work.' })),
          },
          usage: { inputTokens: 24_100, outputTokens: 1_480, cacheReadTokens: 40_200, cacheCreationTokens: 6_100 },
          costUsd: 0, // ran on Codex (a ChatGPT sign-in has no per-run price)
          numTurns: 6,
          aborted: false,
        };
      },
    },
  });
  const { startReviewFix, startPlan } = await import('../src/coding/ai-fix/manager.js');
  const readStatus = async (id: number) =>
    ((await db.select({ s: schema.aiFixes.status }).from(schema.aiFixes).where(eq(schema.aiFixes.id, id)).execute()) as Array<{ s: string }>)[0]?.s;

  const fix = await startReviewFix(ctx, { accountId: 1, prId: 114, reviewId: runs.run114, model: 'claude-opus-5-5', trigger: 'manual' });
  if (fix.status !== 'queued') throw new Error(`ai fix: ${JSON.stringify(fix)}`);
  const fixId = fix.fixId;
  const s1 = await settle(() => readStatus(fixId), 'ai fix');
  if (s1 !== 'succeeded') throw new Error(`ai fix ${s1}`);
  await db.update(schema.aiFixes).set({ createdAt: new Date(now.getTime() - 3.9 * HOUR), finishedAt: new Date(now.getTime() - 3.8 * HOUR) }).where(eq(schema.aiFixes.id, fixId)).execute();

  const plan = await startPlan(ctx, { accountId: 1, prId: 113, model: 'claude-opus-5-5', seed: 'review', sourceReviewId: runs.runB });
  if (plan.status !== 'queued') throw new Error(`ai plan: ${JSON.stringify(plan)}`);
  const planId = plan.fixId;
  await settle(async () => {
    const r = ((await db.select().from(schema.aiFixes).where(eq(schema.aiFixes.id, planId)).execute()) as Array<Record<string, unknown>>)[0];
    // 'planned' with a plan stored (planStatus leaves 'planning').
    return r && r.status === 'planned' && r.planStatus === 'plan_ready' ? 'done' : 'running';
  }, 'ai plan');
  // The plan ran on Codex GPT-6 Astra (the fix on #114 above is Claude Opus's); its build, once
  // approved, is labelled Codex from the start.
  const { markPlanRanOn, markFixRanOn } = await import('../src/coding/ai-fix/persist.js');
  await markPlanRanOn(ctx, planId, CODEX_DEEP);
  await markFixRanOn(ctx, planId, CODEX_DEEP);
  void shownRefs;
  return { fixId, planId };
}

// ── 6. TICKET REVIEWS ────────────────────────────────────────────────────────────────────────

interface TicketScript {
  key: string;
  /** Ran on Codex GPT-6 Astra (else Claude Opus). */
  codex?: boolean;
  alignment: 'aligned' | 'partly_aligned' | 'not_aligned' | 'unclear';
  summary: string;
  criteria: Array<{ status: 'met' | 'partly_met' | 'not_met' | 'unclear'; explanation: string; pr?: string; path?: string; line?: number }>;
  missing?: Array<{ title: string; explanation: string; pr?: string }>;
  notRequested?: Array<{ title: string; explanation: string; pr?: string }>;
  hoursAgo: number;
}

const TICKET_SCRIPTS: TicketScript[] = [
  {
    key: 'PLAT-292',
    alignment: 'partly_aligned',
    summary: 'PR1 writes each pull request in one transaction, so the first two criteria are met; nothing yet shows the sync is no slower.\n- No timing for the 400-PR repository is recorded in the change.',
    criteria: [
      { status: 'met', explanation: '`upsertPullRequest` wraps the PR, its threads and its events in `runTransaction`.', pr: 'PR1', path: 'src/sync/upsert.ts', line: 53 },
      { status: 'met', explanation: 'A throw inside the transaction rolls back every write; the previous rows stay as they were.', pr: 'PR1', path: 'src/sync/upsert.ts', line: 53 },
      { status: 'unclear', explanation: 'The description quotes 41s before and 38s after, but no benchmark or test in the change measures it.' },
    ],
    missing: [{ title: 'A migration for the two new review_threads columns', explanation: 'The schema adds `is_bot` and `is_bot_overridden`; without a migration the first sync after deploy fails.', pr: 'PR1' }],
    hoursAgo: 1.8,
  },
  {
    key: 'PLAT-301',
    codex: true,
    alignment: 'partly_aligned',
    summary: 'PR1 updates requested reviewers from the webhook, but removal and the untracked-repository case are not right yet.\n- A removed request is handled by the same upsert, which does not delete the old request.\n- The untracked-repository log line runs on every delivery, not once.',
    criteria: [
      { status: 'met', explanation: '`review_requested` deliveries go straight to `upsertPullRequest`, which updates the requested reviewers.', pr: 'PR1', path: 'src/api/routes/webhooks.ts', line: 28 },
      { status: 'not_met', explanation: '`review_request_removed` runs the same upsert, which adds reviewers but never removes one.', pr: 'PR1', path: 'src/api/routes/webhooks.ts', line: 20 },
      { status: 'partly_met', explanation: 'Untracked repositories are ignored, but logged on every delivery rather than once.', pr: 'PR1', path: 'src/api/routes/webhooks.ts', line: 25 },
    ],
    notRequested: [{ title: 'Delivery-id deduplication', explanation: 'An in-memory map of delivery ids was added; the ticket does not ask for it.', pr: 'PR1' }],
    hoursAgo: 19,
  },
  {
    key: 'INFRA-231',
    alignment: 'not_aligned',
    summary: 'PR1 sets the bounds the wrong way round, so the node group cannot be created.\n- `max_size` is 4 and `min_size` is 6; the ticket asks for 2 to 8.',
    criteria: [
      { status: 'not_met', explanation: 'The scaling config sets min 6 and max 4, not 2 and 8.', pr: 'PR1', path: 'terraform/eks/node-groups.tf', line: 20 },
      { status: 'unclear', explanation: 'The plan fails before it can show what else changes.' },
      { status: 'unclear', explanation: 'No pod disruption budgets are in this repository to check against.' },
    ],
    hoursAgo: 4.2,
  },
  {
    key: 'INFRA-244',
    codex: true,
    alignment: 'aligned',
    summary: 'PR1 adds both alarms with the thresholds the ticket names, routed to the on-call topic.',
    criteria: [
      { status: 'met', explanation: '`sync_queue_depth` fires above 500 messages over two five-minute periods.', pr: 'PR1', path: 'modules/monitoring/alarms.tf', line: 9 },
      { status: 'met', explanation: '`sync_dlq_age` fires when the oldest dead-letter message is over 3600 seconds.', pr: 'PR1', path: 'modules/monitoring/alarms.tf', line: 24 },
      { status: 'met', explanation: 'Both alarms send to `var.oncall_topic_arn`.', pr: 'PR1', path: 'modules/monitoring/alarms.tf', line: 13 },
    ],
    hoursAgo: 28,
  },
  {
    key: 'INFRA-260',
    alignment: 'partly_aligned',
    summary: 'PR1 added DynamoDB locking; PR2 moves state to S3 but has not archived the old files.\n- The old local state files are deleted by PR2 instead of archived.',
    criteria: [
      { status: 'partly_met', explanation: 'Three of the four stacks point at the versioned bucket; `stacks/legacy` still uses local state.', pr: 'PR2' },
      { status: 'met', explanation: 'The DynamoDB lock table from PR1 is configured on every migrated stack.', pr: 'PR1' },
      { status: 'not_met', explanation: 'PR2 deletes `terraform.tfstate.backup` files rather than moving them to the archive prefix.', pr: 'PR2' },
    ],
    hoursAgo: 49,
  },
  {
    key: 'PLAT-296',
    alignment: 'aligned',
    summary: 'PR1 backfills merged-by for the last 90 days and skips rows that already have it, so a second run changes nothing.',
    criteria: [
      { status: 'met', explanation: 'The backfill selects merged pull requests from the last 90 days with no merged-by.', pr: 'PR1' },
      { status: 'met', explanation: 'Rows that already have a merged-by are skipped.', pr: 'PR1' },
    ],
    hoursAgo: 52,
  },
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function seedTicketReviews(base: any, c: AgenticSeedCtx): Promise<number> {
  const { db, schema, now } = c;
  const { eq } = await import('drizzle-orm');
  const ctx = agentCtx(base, {});
  const { resolveTicketInputs, memberRepos } = await import('../src/review/ticket-review/prepare.js');
  const { fingerprint } = await import('../src/review/ticket-review/fingerprint.js');
  const { insertQueuedTicketReview, markTicketReviewRunning, setTicketMemberCheckouts, saveTicketReviewSuccess, markTicketReviewRanOn } = await import('../src/review/ticket-review/persist.js');
  const { reconcileTicketReview } = await import('../src/review/ticket-review/reconcile.js');
  let n = 0;
  for (const s of TICKET_SCRIPTS) {
    const ident = ticketIdent(s.key);
    const inputs = await resolveTicketInputs(ctx, 1, ident, { originPrId: null, manualTicket: null });
    if (!inputs.ok) throw new Error(`ticket review ${s.key}: ${inputs.reason}`);
    const { ticket, ticketHash, members } = inputs;
    const repos = await memberRepos(ctx, 1, members);
    const id = await insertQueuedTicketReview(ctx, {
      accountId: 1,
      workspaceId: c.platformWs,
      ident,
      ticketKey: s.key,
      ticketTitle: ticket.title ?? null,
      ticket: null,
      originPrId: members[0]?.prId ?? null,
      trigger: 'manual',
      model: 'claude-opus-5-5',
    } as never);
    await markTicketReviewRunning(ctx, 1, id, { ticket, ticketHash, fingerprint: fingerprint(ticketHash, members), prCount: members.length, members: members.map((m) => ({ ...m, checkedOut: false })) });
    await setTicketMemberCheckouts(ctx, 1, id, new Map(members.map((m) => [m.prId, true])));
    const promptMembers = members.map((m, i) => {
      const r = repos.get(m.prId)!;
      return { ref: `PR${i + 1}`, prId: m.prId, repoId: m.repoId, repo: `${r.owner}/${r.name}`, number: m.number, checkedOut: true };
    });
    const criteriaTexts = (ticket.acceptanceCriteria ?? '')
      .split('\n')
      .map((l) => l.replace(/^\s*[-*]\s*/, '').trim())
      .filter((l) => l !== '');
    const report = {
      alignment: s.alignment,
      summary: s.summary,
      criteria: s.criteria.map((cr, i) => ({
        text: criteriaTexts[i] ?? `Criterion ${i + 1}`,
        status: cr.status,
        explanation: cr.explanation,
        ...(cr.pr ? { deliveredBy: cr.status === 'met' || cr.status === 'partly_met' ? [cr.pr] : [], evidence: [{ pr: cr.pr, path: cr.path ?? null, line: cr.line ?? null }] } : {}),
        ...(cr.status === 'not_met' && cr.pr ? { expectedIn: { pr: cr.pr } } : {}),
        ...(cr.path ? { path: cr.path, line: cr.line ?? null } : {}),
      })),
      missing: (s.missing ?? []).map((m) => ({ title: m.title, explanation: m.explanation, ...(m.pr ? { expectedIn: { pr: m.pr } } : {}) })),
      notRequested: (s.notRequested ?? []).map((m) => ({ title: m.title, explanation: m.explanation, pr: m.pr ?? null })),
    };
    const { assessment, items } = reconcileTicketReview(ticket, promptMembers, report as never);
    if (s.codex) await markTicketReviewRanOn(ctx, 1, id, CODEX_DEEP);
    await saveTicketReviewSuccess(ctx, 1, id, {
      alignment: assessment.alignment,
      summary: assessment.summary,
      assessment,
      costUsd: s.codex ? 0 : 0.6 + members.length * 0.21,
      inputTokens: 38_000 + members.length * 9_000,
      outputTokens: 2_400,
      numTurns: 8,
      items,
    });
    await db
      .update(schema.ticketReviews)
      .set({ createdAt: new Date(now.getTime() - s.hoursAgo * HOUR), startedAt: new Date(now.getTime() - s.hoursAgo * HOUR), completedAt: new Date(now.getTime() - (s.hoursAgo - 0.1) * HOUR) })
      .where(eq(schema.ticketReviews.id, id))
      .execute();
    n++;
  }
  return n;
}

// ── 7. DESIGN DIAGRAMS ───────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function seedDesigns(base: any, c: AgenticSeedCtx): Promise<number> {
  const { db, schema, now } = c;
  const { eq } = await import('drizzle-orm');
  const ctx = agentCtx(base, {});
  const { insertQueuedDiagram, markDiagramRunning, saveDiagramSuccess, markDiagramRanOn } = await import('../src/review/diagrams/persist.js');
  const { validateDesign } = await import('../src/review/diagrams/validate.js');
  const { prDiagramFingerprint, storyDiagramFingerprint } = await import('../src/review/diagrams/fingerprint.js');
  const { liveStoryMembers, designContextFor } = await import('../src/review/diagrams/manager.js');
  let n = 0;

  // #105's design was drawn after its Codex review, on Codex.
  const prDesign = async (prId: number, title: string, caption: string, design: Record<string, unknown>, hoursAgo: number) => {
    const codex = prId === 105;
    const pr = ((await db.select().from(schema.pullRequests).where(eq(schema.pullRequests.id, prId)).execute()) as Array<Record<string, unknown>>)[0]!;
    const files = (DIFFS[prId] ?? []).map((f) => f.path);
    const v = validateDesign({ ...design, title, caption } as never, designContextFor('pr', [{ ref: 'PR1', changedFiles: files } as never]));
    if (!v.ok) throw new Error(`design #${prId}: ${JSON.stringify(v)}`);
    const id = await insertQueuedDiagram(ctx, { accountId: 1, kind: 'pr', subject: String(prId), prId, ticketKey: null, fingerprint: prDiagramFingerprint(prId, pr.headSha as string), trigger: 'review', headSha: pr.headSha, model: 'claude-sonnet-5' } as never);
    await markDiagramRunning(ctx, 1, id, { headSha: pr.headSha as string });
    if (codex) await markDiagramRanOn(ctx, 1, id, CODEX_STANDARD);
    await saveDiagramSuccess(ctx, 1, id, { title: v.value.title, caption: v.value.caption, design: v.value.design }, { costUsd: codex ? 0 : 0.14, inputTokens: 18_000, outputTokens: 1_300, numTurns: 4 });
    await db.update(schema.sequenceDiagrams).set({ createdAt: new Date(now.getTime() - hoursAgo * HOUR), completedAt: new Date(now.getTime() - (hoursAgo - 0.05) * HOUR) }).where(eq(schema.sequenceDiagrams.id, id)).execute();
    n++;
  };

  await prDesign(
    113,
    'Sync writes one pull request per transaction',
    'The upsert now owns the transaction and writes threads and events inside it. Derived state and the search index run after it commits.',
    {
      acts: [
        { id: 'fetch', title: 'Fetch' },
        { id: 'write', title: 'Write' },
        { id: 'derive', title: 'Derive' },
      ],
      layers: ['domain', 'data', 'tests'],
      cells: [
        { id: 'walk', act: 'fetch', layer: 'domain', label: 'Walk changed pull requests', pattern: 'Iterator', change: 'unchanged', pr: null, files: [] },
        { id: 'upsert', act: 'write', layer: 'domain', label: 'Upsert PR with its threads', pattern: 'Unit of work', change: 'changed', pr: null, files: ['src/sync/upsert.ts'] },
        { id: 'tx', act: 'write', layer: 'data', label: 'One transaction per PR', pattern: 'Transaction', change: 'new', pr: null, files: ['src/sync/upsert.ts', 'src/db/schema.sqlite.ts'] },
        { id: 'state', act: 'derive', layer: 'domain', label: 'Classify thread state', pattern: 'Pure function', change: 'changed', pr: null, files: ['src/sync/derive-thread-state.ts'] },
        { id: 'counts', act: 'derive', layer: 'data', label: 'Count threads for the list', pattern: 'Batch query', change: 'changed', pr: null, files: ['src/db/queries.ts'] },
        { id: 'fixtures', act: 'derive', layer: 'tests', label: 'Thread-state fixtures', pattern: null, change: 'unchanged', pr: null, files: [] },
      ],
      arrows: [
        { from: 'walk', to: 'upsert', label: 'each PR' },
        { from: 'upsert', to: 'tx', label: 'inside' },
        { from: 'tx', to: 'state', label: 'after commit' },
        { from: 'state', to: 'counts', label: null },
      ],
    },
    1.9,
  );

  await prDesign(
    105,
    'Review-request webhooks update reviewers',
    'GitHub posts a delivery; the route checks it, finds the repository and writes the pull request through the shared upsert.',
    {
      acts: [
        { id: 'receive', title: 'Receive' },
        { id: 'check', title: 'Check' },
        { id: 'save', title: 'Save' },
      ],
      layers: ['api', 'domain', 'external'],
      cells: [
        { id: 'gh', act: 'receive', layer: 'external', label: 'GitHub webhook delivery', pattern: null, change: 'unchanged', pr: null, files: [] },
        { id: 'route', act: 'receive', layer: 'api', label: 'Webhook route', pattern: 'Front controller', change: 'new', pr: null, files: ['src/api/routes/webhooks.ts'] },
        { id: 'sig', act: 'check', layer: 'api', label: 'Verify signature and dedupe', pattern: 'Guard clause', change: 'new', pr: null, files: ['src/api/routes/webhooks.ts'] },
        { id: 'upsert', act: 'save', layer: 'domain', label: 'Write through the PR upsert', pattern: 'Adapter', change: 'unchanged', pr: null, files: ['src/sync/sync-repo.ts'] },
      ],
      arrows: [
        { from: 'gh', to: 'route', label: 'POST' },
        { from: 'route', to: 'sig', label: null },
        { from: 'sig', to: 'upsert', label: 'accepted' },
      ],
    },
    19,
  );

  // A STORY design: INFRA-260 has two pull requests (one merged, one open).
  const ident = ticketIdent('INFRA-260');
  const members = await liveStoryMembers(ctx, 1, ident);
  if (members.length >= 2) {
    const fp = storyDiagramFingerprint(ident, members);
    const refs = members.map((m, i) => ({ ref: `PR${i + 1}`, changedFiles: [] as string[] }));
    const design = {
      acts: [
        { id: 'lock', title: 'Lock' },
        { id: 'move', title: 'Move state' },
      ],
      layers: ['data', 'external'],
      cells: [
        { id: 'ddb', act: 'lock', layer: 'external', label: 'DynamoDB lock table', pattern: 'Mutex', change: 'new', pr: 'PR1', files: [] },
        { id: 'backend', act: 'move', layer: 'data', label: 'S3 backend per stack', pattern: 'Remote state', change: 'new', pr: refs[1] ? 'PR2' : 'PR1', files: [] },
        { id: 'archive', act: 'move', layer: 'external', label: 'Versioned state bucket', pattern: null, change: 'new', pr: refs[1] ? 'PR2' : 'PR1', files: [] },
      ],
      arrows: [
        { from: 'ddb', to: 'backend', label: 'guards' },
        { from: 'backend', to: 'archive', label: 'writes' },
      ],
    };
    const v = validateDesign({ ...design, title: 'Terraform state moves to S3, guarded by a lock', caption: 'The first pull request adds the lock table; the second points each stack at the versioned bucket.' } as never, designContextFor('story', refs as never));
    if (!v.ok) throw new Error(`story design: ${JSON.stringify(v)}`);
    const { toDiagramMembers } = await import('../src/review/diagrams/trigger.js');
    const id = await insertQueuedDiagram(ctx, { accountId: 1, kind: 'story', subject: ident, prId: null, ticketKey: 'INFRA-260', fingerprint: fp, trigger: 'review', headSha: null, model: 'claude-sonnet-5' } as never);
    await markDiagramRunning(ctx, 1, id, { members: toDiagramMembers(members) });
    await saveDiagramSuccess(ctx, 1, id, { title: v.value.title, caption: v.value.caption, design: v.value.design }, { costUsd: 0.21, inputTokens: 24_000, outputTokens: 1_600, numTurns: 5 });
    n++;
  }
  return n;
}

// ── 8. THE REFERENCE LIBRARY + DOCS CHAT ─────────────────────────────────────────────────────

interface DemoSection {
  title: string;
  summary: string;
  body: string;
}

const LIBRARY: Array<{ slug: string; title: string; source: string; summary: string; topics: string[]; sections: DemoSection[] }> = [
  {
    slug: 'sync-runbook',
    title: 'Sync service runbook',
    source: 'sync-runbook.md',
    summary: 'How the Acme sync service pulls GitHub activity, writes it safely, and what to do when it misbehaves.',
    topics: ['sync', 'transactions', 'migrations', 'rate limits', 'queues'],
    sections: [
      {
        title: 'How a sync runs',
        summary: 'The phases of one repository sync, from the walk to the derived state.',
        body: 'A sync walks every pull request that changed since the last successful sync of the repository. For each one it fetches the pull request, its review threads, its reviews and its timeline in one GraphQL query, then writes them.\n\nThe walk is idempotent: a pull request written twice ends up exactly as if it had been written once. Every row is keyed by its GitHub node id together with the account that owns it.\n\nA sync records where it got to after every page. A sync that stops part-way starts again from the last recorded page, not from the beginning.',
      },
      {
        title: 'Transactions',
        summary: 'What must be written together, and what runs after the commit.',
        body: 'Each pull request is written in one transaction: the pull request row, its review threads and comments, and its events. Either all of it lands or none of it does.\n\nDerived state is computed after the transaction commits. It reads the rows the transaction wrote, so running it inside the transaction would only lengthen the time the write lock is held.\n\nKeep transactions short. SQLite allows one writer at a time, and a long transaction stalls every other sync on the machine.',
      },
      {
        title: 'Schema changes',
        summary: 'The rule for changing a table, and how migrations are registered.',
        body: 'Every column added to the schema needs a migration in the same pull request. The schema file describes the shape the code expects; only a migration changes the database.\n\nWrite migrations by hand and keep them additive: add a column with a default, never rename or drop in the same release. Register each migration in the journal, or it is silently skipped at boot.\n\nA migration that needs a backfill does the backfill in a separate job, not in the migration itself.',
      },
      {
        title: 'Rate limits',
        summary: 'How the sync spends the GitHub budget and what it does when the budget runs low.',
        body: 'Each account has an hourly GitHub budget. A sync checks the remaining budget before every page and waits when it is low, rather than failing. A waiting repository shows as paused with the time it will resume.\n\nNever retry a request while the budget is empty. The retry spends the budget it is waiting for.',
      },
      {
        title: 'The sync queue',
        summary: 'How repository syncs are queued, retried and dead-lettered.',
        body: 'Each repository sync is one message on the sync queue. A worker takes one message at a time, so a slow repository holds one worker and nothing else.\n\nA job that fails three times moves to the dead-letter queue with its last error. Look at the dead-letter queue before re-driving it: the same error will fail again.\n\nAlarm on the age of the oldest dead-letter message, not the count. One stuck message an hour old matters more than ten that arrived a minute ago.',
      },
    ],
  },
  {
    slug: 'api-conventions',
    title: 'Platform API conventions',
    source: 'https://wiki.acme.example/platform/api-conventions',
    summary: 'The rules every Acme platform route follows: errors, pagination, webhooks and time.',
    topics: ['errors', 'pagination', 'webhooks', 'timestamps'],
    sections: [
      {
        title: 'Errors',
        summary: 'The one error shape and which status to use.',
        body: 'Every error answers `{ error, message }`. `error` is a short code a program can switch on; `message` is one plain sentence a person can read.\n\nA request the caller got wrong is a 4xx with the reason in the message. A failure on our side is a 5xx with a generic message; the detail goes to the log, never to the caller.',
      },
      {
        title: 'Webhooks',
        summary: 'How incoming webhooks are verified, deduplicated and logged.',
        body: 'Verify a webhook signature against the raw request body, exactly as received. Never re-serialise the parsed JSON to check it: key order and whitespace change, and the check stops meaning anything.\n\nDeduplicate deliveries by their delivery id in the database, so a restart does not accept a replay.\n\nNever log a secret, a token or a signature. Log the delivery id and the event name.',
      },
      {
        title: 'Pagination and time',
        summary: 'Cursor pagination, and timestamps on the wire.',
        body: 'Lists page with an opaque cursor, never an offset into a changing list. A page answers its items and the cursor of the next page, or null on the last.\n\nTimestamps on the wire are ISO-8601 in UTC. Durations are whole milliseconds and say so in their name.',
      },
    ],
  },
];

async function seedReferenceDocs(c: AgenticSeedCtx): Promise<number> {
  const { now } = c;
  const ws = c.platformWs;
  const { insertDocRow, saveDocBuilt, listDocRows, writeDocsInReview, insertChatTurn } = await import('../src/reference-docs/store.js');
  const { renderDocFolder } = await import('../src/reference-docs/assemble.js');
  const { validateDocFolder } = await import('../src/reference-docs/render.js');
  const { installDocFolder, writeIndex, saveSource, readLibraryFile } = await import('../src/reference-docs/library.js');
  const { stagingRoot } = await import('../src/reference-docs/paths.js');
  const { countWords } = await import('../src/reference-docs/split.js');
  const { extractCitations } = await import('../src/reference-docs/chat-quotes.js');
  const { parseLibraryPath } = await import('../src/reference-docs/paths.js');
  const { config } = await import('../src/config.js');
  rmSync(join(config.docsDir, '1'), { recursive: true, force: true });
  for (const [di, d] of LIBRARY.entries()) {
    const md = `# ${d.title}\n\n${d.sections.map((s) => `## ${s.title}\n\n${s.body}`).join('\n\n')}\n`;
    const row = await insertDocRow({
      accountId: 1,
      workspaceId: ws,
      slug: d.slug,
      title: d.title,
      sourceKind: d.source.startsWith('https://') ? 'url' : 'markdown',
      sourceName: d.source,
      sourceUrl: d.source.startsWith('https://') ? d.source : null,
      byteSize: Buffer.byteLength(md),
      pageCount: null,
    } as never);
    saveSource(1, ws, d.slug, Buffer.from(md, 'utf8'), 'md');
    const out = join(stagingRoot(1, ws), `${d.slug}-seed`, 'out', d.slug);
    mkdirSync(out, { recursive: true });
    const drafts = d.sections.map((s) => ({
      title: s.title,
      depth: 1,
      trail: [],
      body: s.body,
      words: countWords(s.body),
      chars: s.body.length,
      subheadings: [],
      summary: s.summary,
    }));
    const entries = renderDocFolder(out, { slug: d.slug, title: d.title, summary: d.summary, sourceLabel: d.source }, drafts);
    const v = validateDocFolder(out);
    if (!v.ok) throw new Error(`docs ${d.slug}: ${v.problems.join(' | ')}`);
    installDocFolder(1, ws, d.slug, out);
    // The first document was built on Claude, the second on Codex.
    const builtOn = di === 1 ? { ...CODEX_STANDARD, costUsd: 0 } : { provider: 'claude' as const, model: 'claude-sonnet-5', costUsd: 0.31 };
    await saveDocBuilt(1, row.id, { title: d.title, summary: d.summary, topics: d.topics, sections: entries }, { ...builtOn, inputTokens: 22_000, outputTokens: 2_800, numTurns: 6 } as never);
    rmSync(join(stagingRoot(1, ws), `${d.slug}-seed`), { recursive: true, force: true });
  }
  await writeIndex(1, ws);
  // Reviews read the library (Settings → Docs → "Use in reviews").
  await writeDocsInReview(1, ws, true);

  // One conversation, with a checked quote.
  const docs = await listDocRows(1, ws);
  const read = (path: string) => {
    const p = parseLibraryPath(path);
    return p != null ? readLibraryFile(1, ws, p.path) : null;
  };
  const turns = [
    {
      q: 'How should we verify GitHub webhook signatures?',
      a: 'Against the raw request body, never the parsed JSON. The conventions say: "Verify a webhook signature against the raw request body, exactly as received" ([Webhooks](api-conventions/sections/02-webhooks.md)).\n\nThey also ask for delivery ids to be deduplicated in the database so a restart cannot accept a replay, and for secrets never to be logged.',
    },
    {
      q: 'And what happens to a sync job that keeps failing?',
      a: 'After three failures it moves to the dead-letter queue: "A job that fails three times moves to the dead-letter queue with its last error" ([The sync queue](sync-runbook/sections/05-the-sync-queue.md)). The runbook suggests alarming on the age of the oldest dead-letter message rather than the count.',
    },
  ];
  const conversationId = createHash('sha1').update('acme-demo:docs-chat').digest('hex').slice(0, 24);
  for (const [ti, t] of turns.entries()) {
    const citations = extractCitations(t.a, docs, read);
    if (!citations.some((x) => x.quote)) throw new Error(`docs chat: no checked quote in "${t.a.slice(0, 40)}" — ${JSON.stringify(citations)}`);
    // The first answer came from Claude, the second from Codex.
    const answeredBy = ti === 1 ? { ...CODEX_STANDARD, costUsd: 0 } : { provider: 'claude' as const, model: 'claude-sonnet-5', costUsd: 0.05 };
    await insertChatTurn(1, ws, conversationId, t.q, { text: t.a, citations, ...answeredBy, inputTokens: 12_000, outputTokens: 310 } as never);
  }
  void now;
  return docs.length;
}

// ── 9. CHECK AGAINST DOCS (a story) ──────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function seedStoryDocs(base: any, c: AgenticSeedCtx): Promise<string> {
  const { db, schema } = c;
  const { eq } = await import('drizzle-orm');
  const ctx = agentCtx(base, {});
  const mgr = await import('../src/review/story-docs/manager.js');
  const ident = ticketIdent('PLAT-301');
  mgr._setStoryDocsSeamsForTest({
    complete: async () => ({
      text: JSON.stringify({
        sections: [
          { link: 'api-conventions/sections/02-webhooks.md', reason: 'How webhooks are verified, deduplicated and logged.' },
          { link: 'sync-runbook/sections/02-transactions.md', reason: 'The handler writes through the per-PR transaction.' },
        ],
      }),
      usage: { inputTokens: 4_200, outputTokens: 120 },
    }),
    runAgent: async () => ({
      payload: {
        overall: {
          verdict: 'mixed',
          summary: 'The story matches the conventions on what the handler must do. It says nothing about checking the signature on the raw body or keeping delivery ids across a restart, which the conventions require.',
          actions: [
            { text: 'Add a criterion: the signature is verified against the raw request body.', refs: [{ link: 'api-conventions/sections/02-webhooks.md', quote: 'Verify a webhook signature against the raw request body, exactly as received' }] },
            { text: 'Add a criterion: a delivery replayed after a restart is rejected.', refs: [{ link: 'api-conventions/sections/02-webhooks.md', quote: 'Deduplicate deliveries by their delivery id in the database' }] },
          ],
        },
        criteria: [
          { n: 1, verdict: 'aligned', note: 'Updating requested reviewers writes through the per-PR transaction, as the runbook expects.', refs: [{ link: 'sync-runbook/sections/02-transactions.md', quote: 'Each pull request is written in one transaction' }] },
          { n: 3, verdict: 'partly', note: 'Logging an untracked repository is fine, but the conventions forbid logging secrets and ask for the delivery id instead.', refs: [{ link: 'api-conventions/sections/02-webhooks.md', quote: 'Never log a secret, a token or a signature' }] },
        ],
        storyParts: [
          { part: 'Signature check', verdict: 'diverges', note: 'The story does not say how the signature is checked; the conventions require the raw body.', refs: [{ link: 'api-conventions/sections/02-webhooks.md', quote: 'Never re-serialise the parsed JSON to check it' }] },
        ],
      },
      costUsd: 0.22,
      inputTokens: 19_000,
      outputTokens: 1_100,
      numTurns: 4,
      aborted: false,
    }),
  } as never);
  try {
    const live = await mgr.liveStoryDocs(ctx, 1, c.platformWs, ident);
    if (live.inputs == null) throw new Error('story docs: no inputs');
    const res = await mgr.startStoryDocs(ctx, { accountId: 1, workspaceId: c.platformWs, inputs: live.inputs, libraryHash: live.libraryHash });
    if (res.outcome !== 'queued') throw new Error(`story docs: ${res.outcome}`);
    const status = await settle(async () => {
      const r = (await db.select({ s: schema.storyDocsAlignments.status }).from(schema.storyDocsAlignments).where(eq(schema.storyDocsAlignments.id, res.runId)).execute()) as Array<{ s: string }>;
      return r[0]?.s;
    }, 'story docs');
    if (status !== 'succeeded') {
      const r = await db.select().from(schema.storyDocsAlignments).where(eq(schema.storyDocsAlignments.id, res.runId)).execute();
      throw new Error(`story docs ${status}: ${JSON.stringify(r[0]).slice(0, 600)}`);
    }
    // The check ran on Codex. The manager stamps the ACTIVE provider (Claude, in this process) as the
    // read starts; the seed writes what the demo's story says ran, as that stamp would have.
    await db.update(schema.storyDocsAlignments).set({ ...CODEX_STANDARD, costUsd: 0 }).where(eq(schema.storyDocsAlignments.id, res.runId)).execute();
    return ident;
  } finally {
    mgr._setStoryDocsSeamsForTest(null);
  }
}
