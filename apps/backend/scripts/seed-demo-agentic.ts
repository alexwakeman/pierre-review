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
// are a mix, each labelled by what ran: #105 holds a Claude Opus review AND a Codex GPT-6.1 Sol review
// of the SAME head (the in-situ comparison), with a chat on each. Codex also ran the Check threads pass,
// the CI review, the AI Fix plan, two ticket reviews, #105's design, a library document, a docs-chat
// answer and the story's docs check. A Codex run records what ran through the product's own stamp
// (`ranOn` from the fake agent, or the persist module's `mark…RanOn`), and costs US$ 0 (a ChatGPT
// sign-in has no per-run price).
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { WikiScope } from '@pierre-review/shared';
// @ts-expect-error — a plain ESM module shared with the recorder (scripts/lib), no types.
import { DEMO_DIFFS, TERRAFORM_PLAN_JOB_ID, TERRAFORM_PLAN_LOG, addedLines, fileStats, unifiedDiff } from '../../../scripts/lib/demo-diffs.mjs';
import { ticketIdent } from './seed-demo-tracker.js';

const HOUR = 3_600_000;

/** What a Codex run ran on (the deep and standard models; packages/shared AI_MODEL_FOR_ROLE). */
const CODEX_DEEP = { provider: 'codex' as const, model: 'gpt-6.1-sol' };
const CODEX_STANDARD = { provider: 'codex' as const, model: 'gpt-6.1-terra' };
/** The same, with the effort a review / AI Fix run stores (Settings → AI → Effort; Default = high on Astra). */
const CODEX_DEEP_HIGH = { ...CODEX_DEEP, effort: 'high' };

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
  /** What ran, when not Claude Opus at medium (the model asked for, at the Default effort). */
  ranOn?: { provider: 'claude' | 'codex'; model: string; effort?: string };
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
          ranOn: s.ranOn ?? { provider: 'claude', model: 'claude-opus-5-5', effort: 'medium' },
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
    // Run at Effort = High, beside Astra at high: the comparison the effort label names.
    ranOn: { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' },
  });
  await db.update(schema.claudeReviews).set({ createdAt: at(20), finishedAt: at(19.8) }).where(eq(schema.claudeReviews.id, run105)).execute();

  // ---- #105 again, SAME head, on Codex GPT-6.1 Sol: the in-situ comparison with the Opus run ----
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
    ranOn: CODEX_DEEP_HIGH,
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

  // ---- "Implement story": a ready two-repository build (one pushed as a draft) and a plan waiting for Accept ----
  out.storyBuilds = await seedStoryBuilds(c);
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
  // Run on Codex GPT-6.1 Sol.
  const { markCiReviewRanOn } = await import('../src/review/ci-review/persist.js');
  await markCiReviewRanOn(ctx, 1, id, CODEX_DEEP);
  await saveCiReviewSuccess(ctx, 1, id, { summary, costUsd: 0, inputTokens: 16_900, outputTokens: 900, numTurns: 4, items });
  await db.update(schema.ciReviews).set({ createdAt: new Date(now.getTime() - 4.4 * HOUR), completedAt: new Date(now.getTime() - 4.3 * HOUR) }).where(eq(schema.ciReviews.id, id)).execute();
  return id;
}

// ── 5. AI FIX ────────────────────────────────────────────────────────────────────────────────

/** What "Run tests" recorded for the seeded #114 fix (an AiFixChecks; fictional Acme output). */
const FIX_114_CHECKS = {
  requested: ['lint', 'test', 'pre-commit hook'],
  ran: true,
  note: null,
  sandbox: 'seatbelt',
  install: [],
  results: [
    { name: 'lint', kind: 'lint', command: 'make lint', status: 'passed', exitCode: 0, durationMs: 2_140, output: 'terraform fmt -check -recursive\ntflint --recursive\n0 issue(s) found', truncated: false, note: null },
    { name: 'test', kind: 'test', command: 'make test', status: 'passed', exitCode: 0, durationMs: 14_820, output: 'terraform init -backend=false -input=false\nterraform validate\nSuccess! The configuration is valid.\n\nterraform test\neks/tests/node_groups.tftest.hcl... in progress\n  run "scales_between_bounds"... pass\n  run "desired_inside_range"... pass\neks/tests/node_groups.tftest.hcl... tearing down\neks/tests/node_groups.tftest.hcl... pass\n\nSuccess! 2 passed, 0 failed.', truncated: false, note: null },
  ],
  hook: { name: 'pre-commit hook', kind: 'hook', command: 'git commit (.husky/pre-commit)', status: 'passed', exitCode: 0, durationMs: 1_960, output: 'terraform fmt: 1 file checked', truncated: false, note: null },
  hookAttempts: 1,
  agentRuns: 2,
};

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
  // "Run tests" (coding/checks/): this fix ran the project's own checks in the sandbox — the results,
  // the commit hook and the agent's own runs, as a real run stores them (AiFixChecks).
  await db.update(schema.aiFixes).set({ checks: JSON.stringify(FIX_114_CHECKS) }).where(eq(schema.aiFixes.id, fixId)).execute();

  const plan = await startPlan(ctx, { accountId: 1, prId: 113, model: 'claude-opus-5-5', seed: 'review', sourceReviewId: runs.runB });
  if (plan.status !== 'queued') throw new Error(`ai plan: ${JSON.stringify(plan)}`);
  const planId = plan.fixId;
  await settle(async () => {
    const r = ((await db.select().from(schema.aiFixes).where(eq(schema.aiFixes.id, planId)).execute()) as Array<Record<string, unknown>>)[0];
    // 'planned' with a plan stored (planStatus leaves 'planning').
    return r && r.status === 'planned' && r.planStatus === 'plan_ready' ? 'done' : 'running';
  }, 'ai plan');
  // The plan ran on Codex GPT-6.1 Sol (the fix on #114 above is Claude Opus's); its build, once
  // approved, is labelled Codex from the start.
  const { markPlanRanOn, markFixRanOn } = await import('../src/coding/ai-fix/persist.js');
  await markPlanRanOn(ctx, planId, CODEX_DEEP_HIGH);
  await markFixRanOn(ctx, planId, CODEX_DEEP_HIGH);
  void shownRefs;
  return { fixId, planId };
}

// ── 6. TICKET REVIEWS ────────────────────────────────────────────────────────────────────────

interface TicketScript {
  key: string;
  /** Ran on Codex GPT-6.1 Sol (else Claude Opus). */
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
    // ⚠ The "Fill gaps" demo card (seedStoryBuilds): keep a criterion unmet here.
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
  const { resolveTicketInputs, memberRepos, ticketCommentsFor } = await import('../src/review/ticket-review/prepare.js');
  const { commentsSeenOf } = await import('../src/tracker/comments.js');
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
    // The comments the run saw: those written before it ran (a later one reads "1 new comment since
    // this check" — PLAT-292). docs/TRACKERS.md § Ticket comments.
    const ranAt = now.getTime() - s.hoursAgo * HOUR;
    const seen = (await ticketCommentsFor(1, ident)).filter((cm) => Date.parse(cm.createdAt) < ranAt);
    await markTicketReviewRunning(ctx, 1, id, {
      ticket,
      ticketHash,
      fingerprint: fingerprint(ticketHash, members),
      prCount: members.length,
      members: members.map((m) => ({ ...m, checkedOut: false })),
      commentsSeen: commentsSeenOf(seen),
    });
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
  const { insertQueuedDiagram, markDiagramRunning, markDiagramRefused, saveDiagramSuccess, markDiagramRanOn } = await import('../src/review/diagrams/persist.js');
  const { validateDesign } = await import('../src/review/diagrams/validate.js');
  const { prDiagramFingerprint, storyDiagramFingerprint } = await import('../src/review/diagrams/fingerprint.js');
  const { liveStoryMembers, designContextFor } = await import('../src/review/diagrams/manager.js');
  let n = 0;
  const backdate = async (id: number, hoursAgo: number) =>
    db.update(schema.sequenceDiagrams).set({ createdAt: new Date(now.getTime() - hoursAgo * HOUR), completedAt: new Date(now.getTime() - (hoursAgo - 0.05) * HOUR) }).where(eq(schema.sequenceDiagrams.id, id)).execute();
  const prRow = async (prId: number) => ((await db.select().from(schema.pullRequests).where(eq(schema.pullRequests.id, prId)).execute()) as Array<Record<string, unknown>>)[0]!;

  // #105's flow was drawn after its Codex review, on Codex. Every flow passes the real validator (the
  // chain rule, every changed code file on a step) before it is stored.
  const prFlow = async (prId: number, title: string, caption: string, flow: Record<string, unknown>, hoursAgo: number) => {
    const codex = prId === 105;
    const pr = await prRow(prId);
    const files = (DIFFS[prId] ?? []).map((f) => f.path);
    const v = validateDesign({ ...flow, title, caption } as never, designContextFor('pr', [{ ref: 'PR1', changedFiles: files } as never]));
    if (!v.ok || v.value.flow == null) throw new Error(`flow #${prId}: ${JSON.stringify(v)}`);
    const id = await insertQueuedDiagram(ctx, { accountId: 1, kind: 'pr', subject: String(prId), prId, ticketKey: null, fingerprint: prDiagramFingerprint(prId, pr.headSha as string), trigger: 'review', headSha: pr.headSha, model: 'claude-sonnet-5' } as never);
    await markDiagramRunning(ctx, 1, id, { headSha: pr.headSha as string });
    if (codex) await markDiagramRanOn(ctx, 1, id, CODEX_STANDARD);
    await saveDiagramSuccess(ctx, 1, id, { title: v.value.title, caption: v.value.caption, design: v.value.flow }, { costUsd: codex ? 0 : 0.14, inputTokens: 18_000, outputTokens: 1_300, numTurns: 4 });
    await backdate(id, hoursAgo);
    n++;
  };

  await prFlow(
    113,
    'Sync writes one pull request per transaction',
    'Each pull request is written with its threads and events in one transaction. Thread states are worked out after it commits.',
    {
      participants: [
        { id: 'sched', kind: 'service', label: 'Sync scheduler', change: 'changed' },
        { id: 'gh', kind: 'external', label: 'GitHub GraphQL', change: 'unchanged' },
        { id: 'upsert', kind: 'service', label: 'Pull request upsert', change: 'changed' },
        { id: 'db', kind: 'db', label: 'pull_requests, threads', change: 'changed' },
        { id: 'derive', kind: 'service', label: 'Thread-state classifier', change: 'changed' },
        { id: 'route', kind: 'api', label: 'Timeline route', change: 'changed' },
      ],
      steps: [
        { n: 1, from: 'sched', to: 'gh', kind: 'read', label: 'pull requests changed since the cursor', files: ['src/sync/scheduler.ts'] },
        { n: 2, from: 'gh', to: 'sched', kind: 'return', label: 'each PR with its threads and events', files: [] },
        { n: 3, from: 'sched', to: 'upsert', kind: 'call', label: 'one pull request at a time', files: ['src/sync/scheduler.ts'] },
        { n: 4, from: 'upsert', to: 'upsert', kind: 'validate', label: 'skip a PR whose head and updatedAt did not move', files: ['src/sync/upsert.ts'] },
        { n: 5, from: 'upsert', to: 'db', kind: 'write', label: 'PR, threads and events in one transaction', files: ['src/sync/upsert.ts', 'src/db/schema.sqlite.ts'] },
        { n: 6, from: 'upsert', to: 'derive', kind: 'call', label: 'thread ids, after the commit', files: ['src/sync/upsert.ts'] },
        { n: 7, from: 'derive', to: 'db', kind: 'read', label: 'last comment and later commits per thread', files: ['src/sync/derive-thread-state.ts'] },
        { n: 8, from: 'derive', to: 'db', kind: 'write', label: 'derived state per thread', files: ['src/sync/derive-thread-state.ts'] },
        { n: 9, from: 'db', to: 'route', kind: 'read', label: 'thread counts per PR, one batch query', files: ['src/db/queries.ts', 'src/api/routes/timeline.ts'] },
      ],
    },
    1.9,
  );

  await prFlow(
    105,
    'Review-request webhooks update reviewers',
    'GitHub posts a delivery; the route checks it and writes the requested reviewers through the shared upsert.',
    {
      participants: [
        { id: 'gh', kind: 'external', label: 'GitHub', change: 'unchanged' },
        { id: 'route', kind: 'api', label: 'Webhook route', change: 'new' },
        { id: 'upsert', kind: 'service', label: 'Pull request upsert', change: 'changed' },
        { id: 'db', kind: 'db', label: 'pull_requests', change: 'unchanged' },
      ],
      steps: [
        { n: 1, from: 'gh', to: 'route', kind: 'call', label: 'review_requested delivery', files: ['src/api/routes/webhooks.ts'] },
        { n: 2, from: 'route', to: 'route', kind: 'validate', label: 'signature and delivery id, once each', files: ['src/api/routes/webhooks.ts'] },
        { n: 3, from: 'route', to: 'upsert', kind: 'call', label: 'repository and pull request number', files: ['src/sync/sync-repo.ts'] },
        { n: 4, from: 'upsert', to: 'gh', kind: 'read', label: 'the pull request’s current reviewers', files: ['src/sync/sync-repo.ts'] },
        { n: 5, from: 'upsert', to: 'db', kind: 'write', label: 'requested reviewers', files: ['src/sync/sync-repo.ts'] },
        { n: 6, from: 'route', to: 'gh', kind: 'return', label: '202 Accepted', files: [] },
      ],
    },
    19,
  );

  // #114 only resizes autoscaling limits: the model DECLINED (refused `no_flow`, with its reason), the
  // one refused case the demo shows.
  {
    const pr = await prRow(114);
    const id = await insertQueuedDiagram(ctx, { accountId: 1, kind: 'pr', subject: '114', prId: 114, ticketKey: null, fingerprint: prDiagramFingerprint(114, pr.headSha as string), trigger: 'review', headSha: pr.headSha, model: 'claude-sonnet-5' } as never);
    await markDiagramRunning(ctx, 1, id, { headSha: pr.headSha as string });
    await markDiagramRefused(ctx, 1, id, 'no_flow', { costUsd: 0.03, inputTokens: 6_000, outputTokens: 120, numTurns: 2 }, 'this change only resizes the node-group limits');
    await backdate(id, 20);
    n++;
  }

  // A STORY flow: INFRA-260 has two pull requests (one merged, one open).
  const ident = ticketIdent('INFRA-260');
  const members = await liveStoryMembers(ctx, 1, ident);
  if (members.length >= 2) {
    const fp = storyDiagramFingerprint(ident, members);
    const refs = members.map((m, i) => ({ ref: `PR${i + 1}`, changedFiles: [] as string[] }));
    const second = refs[1] ? 'PR2' : 'PR1';
    const flow = {
      participants: [
        { id: 'tf', kind: 'service', label: 'Terraform run', change: 'unchanged', pr: null },
        { id: 'lock', kind: 'db', label: 'DynamoDB lock table', change: 'new', pr: 'PR1' },
        { id: 'state', kind: 'store', label: 'Versioned state bucket', change: 'new', pr: second },
      ],
      steps: [
        { n: 1, from: 'tf', to: 'lock', kind: 'write', label: 'a lock for the stack', pr: 'PR1' },
        { n: 2, from: 'lock', to: 'tf', kind: 'return', label: 'lock granted, or the holder', pr: 'PR1' },
        { n: 3, from: 'tf', to: 'state', kind: 'read', label: 'the stack’s current state', pr: second },
        { n: 4, from: 'tf', to: 'tf', kind: 'transform', label: 'plan against that state', pr: null },
        { n: 5, from: 'tf', to: 'state', kind: 'write', label: 'a new state version', pr: second },
        { n: 6, from: 'tf', to: 'lock', kind: 'write', label: 'the lock released', pr: 'PR1' },
      ],
    };
    const v = validateDesign({ ...flow, title: 'Terraform state moves to S3, guarded by a lock', caption: 'Every run takes a lock first. State is read from and written to the versioned bucket.' } as never, designContextFor('story', refs as never));
    if (!v.ok || v.value.flow == null) throw new Error(`story flow: ${JSON.stringify(v)}`);
    const { toDiagramMembers } = await import('../src/review/diagrams/trigger.js');
    const id = await insertQueuedDiagram(ctx, { accountId: 1, kind: 'story', subject: ident, prId: null, ticketKey: 'INFRA-260', fingerprint: fp, trigger: 'review', headSha: null, model: 'claude-sonnet-5' } as never);
    await markDiagramRunning(ctx, 1, id, { members: toDiagramMembers(members) });
    await saveDiagramSuccess(ctx, 1, id, { title: v.value.title, caption: v.value.caption, design: v.value.flow }, { costUsd: 0.21, inputTokens: 24_000, outputTokens: 1_600, numTurns: 5 });
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

interface DemoWiki {
  /** Absent ⇒ Confluence. */
  provider?: 'confluence' | 'notion' | 'github';
  /** What the source covers (the add-documents wizard's sources); absent ⇒ a page + `depth` levels. */
  scope?: WikiScope;
  rootTitle?: string;
  rootPageId: string;
  depth: number;
  checkedHoursAgo: number;
  editedHoursAgo: number;
  /** Page ids, root first — one per section, in order. */
  pages: string[];
  /** Set: the page has answered 403 since then. */
  unreachableHoursAgo?: number;
  /** The build's figures line (docs/REFERENCE-DOCS.md § Figures). */
  figures?: { described: number; outlined: number; kept: number; pending: number; note: string | null };
}

const LIBRARY: Array<{ slug: string; title: string; source: string; summary: string; topics: string[]; sections: DemoSection[]; wiki?: DemoWiki }> = [
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
  // A CONFLUENCE page tree (docs/REFERENCE-DOCS.md § Wiki sources): the root page and two child pages,
  // one chapter each, on the same fictional site as the demo's Jira — so it reads with the Jira token.
  {
    slug: 'release-handbook',
    title: 'Release handbook',
    source: 'https://acme.atlassian.net/wiki/spaces/PLAT/pages/40001/Release+handbook',
    summary: 'How Acme platform changes ship: the release train, the freeze, and rolling back.',
    topics: ['releases', 'deploys', 'feature flags', 'rollback'],
    // Added from the wizard as the WHOLE Platform space (its home page): every page below it.
    wiki: {
      rootPageId: '40001',
      depth: 32,
      checkedHoursAgo: 2,
      editedHoursAgo: 30,
      pages: ['40001', '40002', '40003'],
      scope: { kind: 'space', name: 'Platform', key: 'PLAT', id: '65537' },
      rootTitle: 'Platform',
    },
    sections: [
      {
        title: 'Release handbook',
        summary: 'The weekly release train and who drives it.',
        body: 'Platform ships on a weekly train that leaves on Tuesday at 10:00 UTC. The release captain rotates weekly and owns the go / no-go call.\n\nA change rides the train only when it is merged by Monday 17:00 UTC and its migration, if any, has been run on staging.',
      },
      {
        title: 'Freeze and feature flags',
        summary: 'The freeze window, and why risky changes ship behind a flag.',
        body: 'The last week of each quarter is a freeze: only fixes for incidents ship.\n\nA change that alters sync behaviour ships behind a feature flag that defaults to off, and is turned on for one workspace before all of them.',
      },
      {
        title: 'Rolling back',
        summary: 'Roll back by redeploying the previous build; never revert a migration.',
        body: 'Roll back by redeploying the previous build. Never revert a migration that has run: write a new one that undoes it.\n\nA rollback is announced in #platform-releases with the build id and the reason.',
      },
    ],
  },
  // A NOTION page tree (docs/REFERENCE-DOCS.md § Wiki sources → Notion), with a FIGURE: the checkout
  // diagram was described by Claude at import (labelled as AI in the text), and its Mermaid source block
  // was kept as text. Read with the workspace's Notion token (fictional).
  {
    slug: 'checkout-design',
    title: 'Checkout design notes',
    source: 'https://www.notion.so/acme/Checkout-design-notes-7c1e2a40b9d84f0e9a3c5d6e7f801234',
    summary: 'How checkout talks to payments: the request flow, retries and what the customer sees.',
    topics: ['checkout', 'payments', 'retries'],
    wiki: {
      provider: 'notion',
      rootPageId: '7c1e2a40-b9d8-4f0e-9a3c-5d6e7f801234',
      depth: 1,
      checkedHoursAgo: 1,
      editedHoursAgo: 20,
      pages: ['7c1e2a40-b9d8-4f0e-9a3c-5d6e7f801234', '7c1e2a40-b9d8-4f0e-9a3c-5d6e7f805678'],
      figures: { described: 1, outlined: 1, kept: 0, pending: 0, note: null },
    },
    sections: [
      {
        title: 'Checkout design notes',
        summary: 'The checkout request flow, with its diagram described.',
        body: 'Checkout never charges a card itself. It asks the payments service for a payment intent and redirects the customer to confirm it.\n\n[Figure (described by AI): checkout-flow.png — A sequence diagram with three lanes, Browser, Checkout API and Payments. Browser → Checkout API: POST /orders. Checkout API → Payments: create intent. Payments → Checkout API: intent id. Checkout API → Browser: redirect to confirm.]\n\n```mermaid\nsequenceDiagram\n  Browser->>Checkout API: POST /orders\n  Checkout API->>Payments: create intent\n  Payments-->>Checkout API: intent id\n  Checkout API-->>Browser: redirect to confirm\n```',
      },
      {
        title: 'Retries',
        summary: 'Retry a payment call only with the same idempotency key.',
        body: 'A call to payments is retried at most three times, with the same idempotency key every time, so a retry never charges twice.\n\nThe customer sees one spinner for all of it, and a plain error after the last try.',
      },
    ],
  },
  // A Confluence SUBTREE from the wizard (docs/REFERENCE-DOCS.md § Wiki sources → Scopes): the
  // "On-call runbooks" page and every page below it, never its siblings — a second section of the OPS
  // space beside "Incident process", each its own source.
  {
    slug: 'on-call-runbooks',
    title: 'On-call runbooks',
    source: 'https://acme.atlassian.net/wiki/spaces/OPS/pages/52100/On-call+runbooks',
    summary: 'What the on-call engineer does for the three alerts that page most often.',
    topics: ['on-call', 'alerts', 'queues', 'databases'],
    wiki: {
      rootPageId: '52100',
      depth: 32,
      checkedHoursAgo: 3,
      editedHoursAgo: 52,
      pages: ['52100', '52101', '52102'],
      scope: { kind: 'tree' },
      rootTitle: 'On-call runbooks',
    },
    sections: [
      {
        title: 'On-call runbooks',
        summary: 'Start here: acknowledge, look at the dashboard, then open the runbook for the alert.',
        body: 'Acknowledge the page within five minutes. Open the service dashboard before you change anything, and write what you see in the incident channel.\n\nEach alert below has its own runbook. If none fits, declare an incident.',
      },
      {
        title: 'Sync queue backed up',
        summary: 'Check the dead-letter queue first; re-drive only after the cause is fixed.',
        body: 'When the sync queue is older than fifteen minutes, look at the dead-letter queue first. A message that failed three times will fail again until its cause is fixed.\n\nScale the workers only when the queue is long and nothing is failing.',
      },
      {
        title: 'Database connections exhausted',
        summary: 'Find the long transaction; never raise the pool size during an incident.',
        body: 'Find the longest-running transaction and the service that holds it. Do not raise the pool size during an incident: it moves the limit to the database.',
      },
    ],
  },
  // A GITHUB REPOSITORY folder from the wizard (docs/REFERENCE-DOCS.md § GitHub repositories): the
  // markdown under acme/web's docs/ — the folder's README is its own text, each document a chapter.
  {
    slug: 'acme-web-docs',
    title: 'web/docs',
    source: 'https://github.com/acme/web/tree/main/docs',
    summary: 'The web app’s own docs: how it is laid out, how to run it, and the decisions behind it.',
    topics: ['frontend', 'architecture', 'local setup', 'decisions'],
    wiki: {
      provider: 'github',
      rootPageId: 'gZG9jcw',
      depth: 32,
      checkedHoursAgo: 1,
      editedHoursAgo: 70,
      pages: ['gZG9jcw', 'gZG9jcy9kZXZlbG9wbWVudC5tZA', 'gZG9jcy9hZHI'],
      scope: { kind: 'repo', owner: 'acme', repo: 'web', path: 'docs', branch: 'main' },
      rootTitle: 'web/docs',
    },
    sections: [
      {
        title: 'web/docs',
        summary: 'How the web app is laid out: routes, the API client and shared state.',
        body: 'The web app is one React app. Each route lives in its own folder under `src/routes`, and every call to the platform API goes through `src/api/client.ts`.\n\nShared state is kept in small stores, one per concern. A component reads the store it needs and nothing else.',
      },
      {
        title: 'development.md',
        summary: 'Run the app locally against a seeded API.',
        body: 'Run `pnpm dev` from the repository root. The app starts on port 5173 and talks to a local API seeded with fictional data.\n\nTests run with `pnpm test`. A change to a shared type needs a test on both sides.',
      },
      {
        title: 'adr',
        summary: 'Architecture decisions: why the app polls instead of holding a socket.',
        body: 'Decision 7: the app polls for changes every few seconds instead of holding a socket open. Polling survives sleeping laptops and proxies, and the server answers an unchanged poll cheaply.',
      },
    ],
  },
  // A second Confluence page that has stopped answering: the last built version stays readable, and the
  // document line says since when it cannot be reached.
  {
    slug: 'incident-process',
    title: 'Incident process',
    source: 'https://acme.atlassian.net/wiki/spaces/OPS/pages/52001/Incident+process',
    summary: 'Who declares an incident, the roles, and the review afterwards.',
    topics: ['incidents', 'on-call', 'postmortems'],
    wiki: { rootPageId: '52001', depth: 0, checkedHoursAgo: 75, editedHoursAgo: 400, pages: ['52001'], unreachableHoursAgo: 72 },
    sections: [
      {
        title: 'Incident process',
        summary: 'Anyone may declare an incident; the on-call engineer leads it; a review follows within five days.',
        body: 'Anyone may declare an incident in #incidents. The on-call engineer is the incident lead until they hand it over.\n\nEvery incident gets a written review within five working days. The review names causes, never people.',
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
    const hoursAgoMs = (h: number) => now.getTime() - h * 3600_000;
    const row = await insertDocRow({
      accountId: 1,
      workspaceId: ws,
      slug: d.slug,
      title: d.title,
      sourceKind: d.wiki ? 'wiki' : d.source.startsWith('https://') ? 'url' : 'markdown',
      sourceName: d.source,
      sourceUrl: d.source.startsWith('https://') ? d.source : null,
      byteSize: Buffer.byteLength(md),
      pageCount: null,
      ...(d.wiki
        ? {
            wiki: {
              provider: d.wiki.provider ?? 'confluence',
              origin: d.wiki.provider === 'notion' ? 'https://www.notion.so' : d.wiki.provider === 'github' ? 'https://github.com' : 'https://acme.atlassian.net',
              rootPageId: d.wiki.rootPageId,
              rootUrl: d.source,
              depth: d.wiki.depth,
              pageCount: d.wiki.pages.length,
              pagesLeftOut: 0,
              lastCheckedAt: hoursAgoMs(d.wiki.checkedHoursAgo),
              lastListedAt: hoursAgoMs(d.wiki.checkedHoursAgo),
              lastChangedAt: hoursAgoMs(d.wiki.editedHoursAgo),
              unreachableSince: d.wiki.unreachableHoursAgo != null ? hoursAgoMs(d.wiki.unreachableHoursAgo) : null,
              unreachableReason: d.wiki.unreachableHoursAgo != null ? 'forbidden' : null,
              retryAfter: null,
              ...(d.wiki.scope ? { scope: d.wiki.scope, rootTitle: d.wiki.rootTitle ?? d.title } : {}),
            },
          }
        : {}),
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
    if (d.wiki) {
      // One row per page (a chapter each), as a build commits them.
      const { commitWikiPages } = await import('../src/reference-docs/wiki/pages.js');
      const { hashMarkdown } = await import('../src/reference-docs/wiki/sync.js');
      const w = d.wiki;
      await commitWikiPages(
        1,
        ws,
        d.slug,
        row.id,
        w.pages.map((pageId, i) => ({
          pageId,
          parentPageId: i === 0 ? null : w.rootPageId,
          depth: i === 0 ? 0 : 1,
          position: i,
          title: d.sections[i]!.title,
          version: 3 + i,
          lastEditedAt: new Date(now.getTime() - (w.editedHoursAgo + i * 20) * 3600_000),
          contentHash: hashMarkdown(d.sections[i]!.title, d.sections[i]!.body),
          lastFetchedAt: new Date(now.getTime() - w.checkedHoursAgo * 3600_000),
          lastError: w.unreachableHoursAgo != null && i === 0 ? 'forbidden' : null,
          markdown: d.sections[i]!.body,
        })),
      );
      // Built from the cache the next refresh would read.
      const { sectionHash } = await import('../src/reference-docs/manager.js');
      const sections = Object.fromEntries(drafts.map((dr) => [sectionHash(dr), dr.summary]));
      const { patchDoc } = await import('../src/reference-docs/store.js');
      await patchDoc(1, row.id, { summaryCache: { v: 1, sections, doc: { title: d.title, summary: d.summary, topics: d.topics } } });
      if (w.figures) await patchDoc(1, row.id, { figures: w.figures });
    }
  }
  // Settings → Confluence: the page site is the demo's Jira site, so the pages read with the Jira token
  // (seed-demo-tracker.ts); a separate Confluence token is saved too (fictional, sealed or plain).
  {
    const { writeWikiCredentials } = await import('../src/reference-docs/wiki/credentials.js');
    await writeWikiCredentials(1, ws, 'confluence', { siteUrl: 'https://acme.atlassian.net', email: 'morgan.diaz@acme.example', token: 'demo-not-a-real-token' });
    // Settings → Notion: a fictional integration token (the shape a real one has; it opens nothing).
    await writeWikiCredentials(1, ws, 'notion', { token: 'ntn_demo0000000000000000000000000000000000000' });
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

// ── "IMPLEMENT STORY" (docs/STORY-BUILD.md) ─────────────────────────────────────────────────────────
//
// Sessions on NOT-STARTED sprint tickets with no pull request (the only tickets the sprint card offers
// Implement on, owner decision 4), written through the session's own persist module
// (coding/story-build/persist.ts — the claim, then the row updates the manager makes):
//   PLAT-310  a READY two-repository build: acme/api PUSHED as a draft pull request (#143, its row seeded
//             below, by the reader), acme/web-app READY with tests (3 passed, 1 failed, and the hook).
//   PLAT-312  PLAN READY: a plan with a design, a two-turn chat, and the docs weighed (2 grounded,
//             1 superseded, 2 suggestions — the suggestions not in the plan yet).
//   PLAT-318  no session: its card shows the Implement button.
//   PLAT-301  no session, IN PROGRESS with a PR: its story check below (TICKET_SCRIPTS — current, one
//             criterion not met, one partly met) makes its card offer "Fill gaps", and the build tab lists
//             those gaps (the recorder opens it). Keep that check current and gapped.
// No model ran: these rows are the answers the passes would have stored. The pushed draft is not linked to
// the ticket (the tracker seed lists PLAT-310 with no PR), so the sprint card keeps its build mark.

const docRef = (ws: number, docSlug: string, docTitle: string, file: string, sectionTitle: string, quote: string) => ({
  path: `${docSlug}/sections/${file}`,
  workspaceId: ws,
  anchor: null,
  docSlug,
  docTitle,
  sectionTitle,
  quote,
});

const PATCH_API = [
  'diff --git a/src/sync/budget.ts b/src/sync/budget.ts',
  'index 3f1a2b4..9c0d7e1 100644',
  '--- a/src/sync/budget.ts',
  '+++ b/src/sync/budget.ts',
  '@@ -12,9 +12,22 @@ export interface Budget {',
  '   resetAt: number;',
  ' }',
  ' ',
  '-export function assertBudget(b: Budget): void {',
  "-  if (b.remaining <= 0) throw new Error('GitHub budget spent');",
  '+/** How long to wait before the next page: none while the budget lasts, else until it resets. */',
  '+export function waitFor(b: Budget, now: number, floor = PAGE_COST): number {',
  '+  if (b.remaining > floor) return 0;',
  '+  return Math.max(0, b.resetAt - now) + RESET_SLACK_MS;',
  ' }',
  '+',
  '+/** The repository is paused until `resetAt`; nothing is sent while it waits. */',
  '+export async function waitForBudget(b: Budget, signal: AbortSignal, now = Date.now()): Promise<void> {',
  '+  const ms = waitFor(b, now);',
  '+  if (ms === 0) return;',
  '+  await markPaused(b.repoId, new Date(now + ms));',
  '+  await sleep(ms, signal);',
  '+  await clearPaused(b.repoId);',
  '+}',
  'diff --git a/src/sync/walk.ts b/src/sync/walk.ts',
  'index 51e0c2a..a7b44f2 100644',
  '--- a/src/sync/walk.ts',
  '+++ b/src/sync/walk.ts',
  '@@ -40,7 +40,7 @@ export async function walkRepo(repo: Repo, signal: AbortSignal): Promise<void> {',
  '   for (let page = start; ; page++) {',
  '-    assertBudget(await readBudget(repo));',
  '+    await waitForBudget(await readBudget(repo), signal);',
  '     const res = await fetchPage(repo, page);',
  '     await writePage(repo, res);',
  '     if (res.nextCursor == null) break;',
  '',
].join('\n');


const PATCH_WEB = [
  'diff --git a/src/routes/sync/RepoStatus.tsx b/src/routes/sync/RepoStatus.tsx',
  'index 4c2e8a1..d91b3f7 100644',
  '--- a/src/routes/sync/RepoStatus.tsx',
  '+++ b/src/routes/sync/RepoStatus.tsx',
  '@@ -8,10 +8,19 @@ export function RepoStatus({ repo }: { repo: RepoSync }) {',
  "   if (repo.status === 'error') {",
  '     return <Badge tone="danger">Sync failed</Badge>;',
  '   }',
  "+  if (repo.status === 'paused' && repo.resumesAt != null) {",
  '+    return (',
  '+      <Badge tone="warn" title="Waiting for the GitHub budget to refill">',
  '+        Paused until {formatTime(repo.resumesAt)}',
  '+      </Badge>',
  '+    );',
  '+  }',
  "   if (repo.status === 'running') {",
  '     return <Badge tone="info">Syncing</Badge>;',
  '   }',
  '   return <Badge tone="neutral">Up to date</Badge>;',
  ' }',
  'diff --git a/src/api/types.ts b/src/api/types.ts',
  'index 7a0c3e2..1f6b9d4 100644',
  '--- a/src/api/types.ts',
  '+++ b/src/api/types.ts',
  '@@ -21,6 +21,8 @@ export interface RepoSync {',
  '   id: number;',
  '   name: string;',
  "-  status: 'running' | 'error' | 'idle';",
  "+  status: 'running' | 'paused' | 'error' | 'idle';",
  '+  /** ISO time the sync resumes, while paused on the GitHub budget. */',
  '+  resumesAt: string | null;',
  '   lastSyncedAt: string | null;',
  ' }',
  '',
].join('\n');

async function seedStoryBuilds(c: AgenticSeedCtx): Promise<Record<string, number>> {
  const { db, schema, now, platformWs: ws } = c;
  const persist = await import('../src/coding/story-build/persist.js');
  const ctx = { db, schema } as never;
  const at = (hoursAgo: number) => new Date(now.getTime() - hoursAgo * HOUR);
  const API_REPO = 2;
  const INFRA_REPO = 3;
  const WEB_REPO = 1;
  const SHA_API = 'a3c9e1f0b2d4c6e8a0b1c3d5e7f9a1b3c5d7e9f1';
  const SHA_INFRA = '7d1e5b9c3a0f2e4d6c8b0a1f3e5d7c9b1a3f5e7d';
  const SHA_WEB = 'c0ffee15b2d4c6e8a0b1c3d5e7f9a1b3c5d7e9f2';
  const out: Record<string, number> = {};

  // ---- PLAT-310: a ready build — acme/api pushed as a draft, acme/web-app ready to push ----
  {
    const ident = ticketIdent('PLAT-310');
    const claim = await persist.insertStoryBuild(ctx, {
      accountId: 1,
      workspaceId: ws,
      ident,
      ticketKey: 'PLAT-310',
      ticketTitle: 'Retry GitHub calls within the rate-limit budget',
      wantDiagram: false,
      wantDocs: false,
      provider: 'claude',
      model: 'claude-opus-5-5',
    });
    const id = claim.id;
    out.ready = id;
    await persist.updateStoryBuild(ctx, 1, id, {
      status: 'ready',
      phase: null,
      effort: null,
      criteriaSource: 'ticket',
      criteriaJson: [
        { n: 1, text: 'A sync that runs out of budget waits and resumes instead of failing.' },
        { n: 2, text: 'The repository shows "paused" with the time it will resume.' },
        { n: 3, text: 'No retry is sent while the budget is empty.' },
      ] as never,
      coverageJson: {
        state: 'none',
        ticketReviewId: null,
        checkedAt: null,
        criteria: [
          { ref: 'AC1', text: 'A sync that runs out of budget waits and resumes instead of failing.', verdict: 'not_checked', coveredByPrIds: [] },
          { ref: 'AC2', text: 'The repository shows "paused" with the time it will resume.', verdict: 'not_checked', coveredByPrIds: [] },
          { ref: 'AC3', text: 'No retry is sent while the budget is empty.', verdict: 'not_checked', coveredByPrIds: [] },
        ],
        missing: [{ ref: 'M1', text: 'Use the numbers from the PLAT-275 audit to pick the wait.' }],
        existingPrs: [],
        note: null,
      },
      candidatesJson: [
        { ref: 'R1', repoId: API_REPO, fullName: 'acme/api', source: 'picked', baseRef: 'main', baseSha: SHA_API, stackedOnPrId: null, stackedOnPrNumber: null, baseNote: null },
        { ref: 'R2', repoId: WEB_REPO, fullName: 'acme/web-app', source: 'picked', baseRef: 'main', baseSha: SHA_WEB, stackedOnPrId: null, stackedOnPrNumber: null, baseNote: null },
        { ref: 'R3', repoId: INFRA_REPO, fullName: 'acme/infrastructure', source: 'related', baseRef: 'main', baseSha: SHA_INFRA, stackedOnPrId: null, stackedOnPrNumber: null, baseNote: null },
      ],
      planJson: {
        revision: 1,
        summary:
          'The sync waits for the GitHub budget to refill instead of failing, and marks the repository paused until then. The web app shows the pause with the time it ends.',
        repos: [
          {
            ref: 'R1',
            repoId: API_REPO,
            why: 'The sync walk and the budget check live here.',
            branchSlug: 'wait-for-budget',
            steps: [
              { title: 'Wait for the budget instead of failing', files: ['src/sync/budget.ts', 'src/sync/walk.ts'], change: 'Replace the throwing check with a wait until the budget resets, cancellable by the sync signal.', refs: ['AC1', 'AC3'] },
              { title: 'Mark the repository paused', files: ['src/sync/budget.ts'], change: 'Store the resume time while the walk waits and clear it after; the status endpoint reads it.', refs: ['AC2'] },
              { title: 'Pick the wait from the audit', files: ['src/sync/budget.ts'], change: 'A page costs about 12 points (PLAT-275), so wait once fewer than that remain.', refs: ['M1'] },
            ],
            tests: ['A walk with an empty budget waits and resumes.', 'No request is sent while the budget is empty.'],
          },
          {
            ref: 'R2',
            repoId: WEB_REPO,
            why: 'The repository list shows each sync’s state.',
            branchSlug: 'show-paused-sync',
            steps: [
              { title: 'Show a paused sync with its resume time', files: ['src/routes/sync/RepoStatus.tsx', 'src/api/types.ts'], change: 'A "Paused until 14:05" badge from the new status and resume time.', refs: ['AC2'] },
            ],
            tests: ['A paused repository shows the time it resumes.'],
          },
        ],
        readOnlyRepos: [{ ref: 'R3', repoId: INFRA_REPO, why: 'The sync alarms read the same status; none needs to change.' }],
        criteria: [
          { ref: 'AC1', how: 'planned', repo: 'R1', reason: null },
          { ref: 'AC2', how: 'planned', repo: 'R1', reason: null },
          { ref: 'AC3', how: 'planned', repo: 'R1', reason: null },
          { ref: 'M1', how: 'planned', repo: 'R1', reason: null },
        ],
        risks: ['A sync that waits holds its worker; a long reset can back up the queue.'],
      },
      planRevision: 1,
      transcriptJson: [],
      acceptedRevision: 1,
      acceptedDocsJson: null,
      planCostUsd: 2.21,
      inputTokens: 174_000,
      outputTokens: 7_600,
      numTurns: 27,
      createdAt: at(5.6),
      startedAt: at(5.6),
      completedAt: at(4.2),
    } as never);

    // The draft pull request the push opened, as the sync stored it (by the reader, Morgan).
    const PR_NUMBER = 143;
    const pushedSha = 'e4b1c9d2a7f3e5c1b9d7a3f1c5e9b7d3a1f5c9e7';
    await db
      .insert(schema.pullRequests)
      .values({
        id: PR_NUMBER,
        githubNodeId: `PR_${PR_NUMBER}`,
        accountId: 1,
        repoId: API_REPO,
        number: PR_NUMBER,
        title: 'PLAT-310: Retry GitHub calls within the rate-limit budget',
        body: 'The walk waits for the budget to reset and marks the repository paused until then.\n\nBuilt with Limn from PLAT-310.',
        authorId: 1,
        mergedById: null,
        baseRefName: 'main',
        headRefName: 'PLAT-310-wait-for-budget',
        state: 'open',
        isDraft: true,
        openedAt: at(3.9),
        firstReviewAt: null,
        lastCommitAt: at(3.9),
        mergedAt: null,
        closedAt: null,
        updatedAt: at(3.9),
        headSha: pushedSha,
        additions: 17,
        deletions: 3,
        changedFiles: 2,
        ciStatus: 'pending',
        mergeable: 'mergeable',
        mergeStateStatus: 'draft',
        labels: null,
        checkRuns: [
          { name: 'build', state: 'pending', url: null, runId: null, jobId: null },
          { name: 'test', state: 'pending', url: null, runId: null, jobId: null },
        ],
      })
      .execute();

    const apiRow = await persist.upsertStoryBuildRepo(ctx, { accountId: 1, buildId: id, repoId: API_REPO, ref: 'R1', buildOrder: 0, include: true, status: 'pushed', baseRef: 'main', baseSha: SHA_API, stackedOnPrId: null, branch: 'PLAT-310-wait-for-budget' });
    await persist.updateStoryBuildRepo(ctx, 1, apiRow, {
      patch: PATCH_API,
      filesChangedJson: ['src/sync/budget.ts', 'src/sync/walk.ts'],
      summary: 'The walk waits for the budget to reset and marks the repository paused until then.',
      commitMessage: 'PLAT-310: wait for the GitHub budget instead of failing',
      changeReportJson: {
        changes: [
          { path: 'src/sync/budget.ts', summary: 'waitForBudget waits until the reset, storing the resume time; the wait starts once fewer than one page of points remain.', refs: ['AC1', 'AC2', 'M1'] },
          { path: 'src/sync/walk.ts', summary: 'Each page waits for the budget instead of throwing, so nothing is sent while it is empty.', refs: ['AC3'] },
        ],
        unaddressed: [],
        notReported: [],
      },
      checksWantedJson: ['lint', 'test'],
      checksJson: {
        requested: ['lint', 'test'],
        ran: true,
        note: null,
        sandbox: 'seatbelt',
        install: [{ name: 'install', kind: 'check', command: 'pnpm install --frozen-lockfile --ignore-scripts', status: 'passed', exitCode: 0, durationMs: 21_400, output: '', truncated: false, note: null }],
        results: [
          { name: 'lint', kind: 'lint', command: 'pnpm lint', status: 'passed', exitCode: 0, durationMs: 6_100, output: '', truncated: false, note: null },
          { name: 'test', kind: 'test', command: 'pnpm test', status: 'passed', exitCode: 0, durationMs: 38_200, output: '✓ src/sync/budget.test.ts (6 tests)\n✓ src/sync/walk.test.ts (11 tests)', truncated: false, note: null },
        ],
        hook: null,
        hookAttempts: 0,
        agentRuns: 2,
      } as never,
      prTitle: 'PLAT-310: Retry GitHub calls within the rate-limit budget',
      pushedBranch: 'PLAT-310-wait-for-budget',
      pushedPrNumber: PR_NUMBER,
      pushedPrUrl: `https://github.com/acme/api/pull/${PR_NUMBER}`,
      pushedCommitSha: pushedSha,
      pushedAt: at(3.9),
      provider: 'claude',
      model: 'claude-opus-5-5',
      costUsd: 3.42,
      inputTokens: 388_000,
      outputTokens: 14_200,
      numTurns: 44,
      startedAt: at(5.0),
      completedAt: at(4.6),
    } as never);
    const webRow = await persist.upsertStoryBuildRepo(ctx, { accountId: 1, buildId: id, repoId: WEB_REPO, ref: 'R2', buildOrder: 1, include: true, status: 'ready', baseRef: 'main', baseSha: SHA_WEB, stackedOnPrId: null, branch: 'PLAT-310-show-paused-sync' });
    await persist.updateStoryBuildRepo(ctx, 1, webRow, {
      patch: PATCH_WEB,
      filesChangedJson: ['src/routes/sync/RepoStatus.tsx', 'src/api/types.ts'],
      summary: 'A paused repository shows "Paused until" with the time its sync resumes.',
      commitMessage: 'PLAT-310: show a paused sync with the time it resumes',
      changeReportJson: {
        changes: [
          { path: 'src/routes/sync/RepoStatus.tsx', summary: 'A warn badge "Paused until <time>" while the status is paused.', refs: ['AC2'] },
          { path: 'src/api/types.ts', summary: 'RepoSync gains the paused status and resumesAt.', refs: ['AC2'] },
        ],
        unaddressed: [],
        notReported: [],
      },
      checksWantedJson: ['lint', 'typecheck', 'test', 'e2e'],
      checksJson: {
        requested: ['lint', 'typecheck', 'test', 'e2e'],
        ran: true,
        note: null,
        sandbox: 'seatbelt',
        install: [{ name: 'install', kind: 'check', command: 'pnpm install --frozen-lockfile --ignore-scripts', status: 'passed', exitCode: 0, durationMs: 18_700, output: '', truncated: false, note: null }],
        results: [
          { name: 'lint', kind: 'lint', command: 'pnpm lint', status: 'passed', exitCode: 0, durationMs: 5_400, output: '', truncated: false, note: null },
          { name: 'typecheck', kind: 'typecheck', command: 'pnpm typecheck', status: 'passed', exitCode: 0, durationMs: 9_800, output: '', truncated: false, note: null },
          { name: 'test', kind: 'test', command: 'pnpm test', status: 'passed', exitCode: 0, durationMs: 14_100, output: '✓ src/routes/sync/RepoStatus.test.tsx (5 tests)', truncated: false, note: null },
          {
            name: 'e2e',
            kind: 'test',
            command: 'pnpm e2e',
            status: 'failed',
            exitCode: 1,
            durationMs: 41_300,
            output: '✘ sync.spec.ts › a paused repository shows its resume time\n  Expected "Paused until 14:05", received "Paused until 2:05 PM"\n  (the e2e browser runs with the en-US locale)',
            truncated: false,
            note: null,
          },
        ],
        hook: { name: 'pre-commit hook', kind: 'hook', command: 'git commit (.husky/pre-commit)', status: 'passed', exitCode: 0, durationMs: 4_200, output: 'lint-staged: 2 files formatted', truncated: false, note: null },
        hookAttempts: 1,
        agentRuns: 3,
      } as never,
      provider: 'claude',
      model: 'claude-opus-5-5',
      costUsd: 1.18,
      inputTokens: 141_000,
      outputTokens: 4_900,
      numTurns: 19,
      startedAt: at(4.6),
      completedAt: at(4.2),
    } as never);
  }

  // ---- PLAT-312: a plan waiting for Accept, with a design, a chat and the docs weighed ----
  {
    const ident = ticketIdent('PLAT-312');
    const claim = await persist.insertStoryBuild(ctx, {
      accountId: 1,
      workspaceId: ws,
      ident,
      ticketKey: 'PLAT-312',
      ticketTitle: 'Report sync health on the health endpoint',
      wantDiagram: true,
      wantDocs: true,
      provider: 'codex',
      model: 'gpt-6.1-sol',
    });
    const id = claim.id;
    out.planReady = id;
    const runbook = (file: string, title: string, quote: string) => docRef(ws, 'sync-runbook', 'Sync service runbook', file, title, quote);
    const conventions = (file: string, title: string, quote: string) => docRef(ws, 'api-conventions', 'Platform API conventions', file, title, quote);
    await persist.updateStoryBuild(ctx, 1, id, {
      status: 'plan_ready',
      phase: null,
      criteriaSource: 'ticket',
      coverageJson: {
        state: 'none',
        ticketReviewId: null,
        checkedAt: null,
        criteria: [
          { ref: 'AC1', text: '/api/health reports the age of the oldest running sync.', verdict: 'not_checked', coveredByPrIds: [] },
          { ref: 'AC2', text: 'It reports how many repositories are in error.', verdict: 'not_checked', coveredByPrIds: [] },
          { ref: 'AC3', text: 'It answers in under 50 ms.', verdict: 'not_checked', coveredByPrIds: [] },
        ],
        missing: [],
        existingPrs: [],
        note: null,
      },
      candidatesJson: [
        { ref: 'R1', repoId: API_REPO, fullName: 'acme/api', source: 'picked', baseRef: 'main', baseSha: SHA_API, stackedOnPrId: null, stackedOnPrNumber: null, baseNote: null },
        { ref: 'R2', repoId: INFRA_REPO, fullName: 'acme/infrastructure', source: 'picked', baseRef: 'main', baseSha: SHA_INFRA, stackedOnPrId: null, stackedOnPrNumber: null, baseNote: null },
      ],
      planJson: {
        revision: 2,
        summary: 'The health endpoint gains two fields read from the sync tables in one indexed query. The infrastructure health check is unchanged: it only reads the status code.',
        repos: [
          {
            ref: 'R1',
            repoId: API_REPO,
            why: 'The health endpoint and the sync tables live here.',
            branchSlug: 'health-sync-fields',
            steps: [
              { title: 'Read the oldest running sync and the error count', files: ['src/db/sync-health.ts'], change: 'One query over sync_state with the existing (status, started_at) index.', refs: ['AC1', 'AC2', 'AC3'] },
              { title: 'Add the two fields to /api/health', files: ['src/api/routes/health.ts'], change: 'oldestRunningSyncMs and reposInError, both whole numbers.', refs: ['AC1', 'AC2'] },
            ],
            tests: ['The health answer carries both fields.', 'An empty sync table reports zero and null.'],
          },
        ],
        readOnlyRepos: [{ ref: 'R2', repoId: INFRA_REPO, why: 'The load balancer reads /api/health; its check only needs a 200.' }],
        criteria: [
          { ref: 'AC1', how: 'planned', repo: 'R1', reason: null },
          { ref: 'AC2', how: 'planned', repo: 'R1', reason: null },
          { ref: 'AC3', how: 'planned', repo: 'R1', reason: null },
        ],
        risks: ['A slow health answer fails the load balancer check; the query must stay on its index.'],
      },
      planRevision: 2,
      transcriptJson: [
        { role: 'reader', text: 'Leave the load balancer check alone. Does it need anything new from the endpoint?', revision: 1, at: at(1.2).toISOString() },
        { role: 'claude', text: 'No. The check reads only the status code, so acme/infrastructure stays read-only and the two fields are additive.', revision: 2, at: at(1.1).toISOString() },
      ],
      // The planned data flow (participants and steps name repo refs, never PRs).
      designJson: {
        participants: [
          { id: 'lb', kind: 'external', label: 'Load balancer check', change: 'unchanged', pr: null },
          { id: 'route', kind: 'api', label: 'GET /api/health', change: 'changed', pr: 'R1' },
          { id: 'q', kind: 'service', label: 'Sync health query', change: 'new', pr: 'R1' },
          { id: 'db', kind: 'db', label: 'sync_state table', change: 'unchanged', pr: null },
        ],
        steps: [
          { n: 1, from: 'lb', to: 'route', kind: 'call', label: 'health request', pr: null, files: [] },
          { n: 2, from: 'route', to: 'q', kind: 'call', label: 'ask for the sync figures', pr: 'R1', files: ['src/api/routes/health.ts'] },
          { n: 3, from: 'q', to: 'db', kind: 'read', label: 'oldest running sync and error count, one query', pr: 'R1', files: ['src/db/sync-health.ts'] },
          { n: 4, from: 'q', to: 'route', kind: 'return', label: 'age in ms and repositories in error', pr: 'R1', files: ['src/db/sync-health.ts'] },
          { n: 5, from: 'route', to: 'lb', kind: 'return', label: 'two new fields on the answer', pr: 'R1', files: ['src/api/routes/health.ts'] },
        ],
      },
      docsStatus: 'ready',
      docsJson: {
        summary: 'The API conventions already fix how the new duration is named, and the error shape the route keeps. The runbook alarms on age rather than counts, which the story changes for errors; two points in the docs are not in the plan yet.',
        nothingGrounded: false,
        planRevision: 2,
        runId: 'demo-plat-312-docs',
        items: [
          { id: 'D1', kind: 'grounded', about: 'R1:step 2', note: 'A duration in whole milliseconds, named for its unit, is the conventions’ own rule.', suggestion: null, refs: [conventions('03-pagination-and-time.md', 'Pagination and time', 'Durations are whole milliseconds and say so in their name.')] },
          { id: 'D2', kind: 'grounded', about: 'R1:step 2', note: 'The route keeps the one error shape.', suggestion: null, refs: [conventions('01-errors.md', 'Errors', 'Every error answers `{ error, message }`.')] },
          { id: 'D3', kind: 'superseded', about: 'AC2', note: 'The runbook watches the age of the oldest failure, not a count. The story asks for the number of repositories in error.', suggestion: null, refs: [runbook('05-the-sync-queue.md', 'The sync queue', 'Alarm on the age of the oldest dead-letter message, not the count.')] },
          { id: 'D4', kind: 'suggestion', about: 'R1:step 1', note: 'The runbook keeps reads out of write transactions: SQLite allows one writer.', suggestion: 'Read the health figures outside any write transaction.', refs: [runbook('02-transactions.md', 'Transactions', 'SQLite allows one writer at a time')] },
          { id: 'D5', kind: 'suggestion', about: 'AC1', note: 'Times on the wire are ISO-8601 in UTC.', suggestion: 'Also report when the oldest sync started, as an ISO time.', refs: [conventions('03-pagination-and-time.md', 'Pagination and time', 'Timestamps on the wire are ISO-8601 in UTC.')] },
        ],
      } as never,
      docsDecisionsJson: null,
      docsCostUsd: 0.27,
      planCostUsd: 0,
      inputTokens: 141_000,
      outputTokens: 4_700,
      numTurns: 22,
      createdAt: at(1.4),
      startedAt: at(1.4),
    } as never);
    await persist.upsertStoryBuildRepo(ctx, { accountId: 1, buildId: id, repoId: API_REPO, ref: 'R1', buildOrder: 0, include: true, status: 'planned', baseRef: 'main', baseSha: SHA_API, stackedOnPrId: null, branch: 'PLAT-312-health-sync-fields' });
  }
  return out;
}
