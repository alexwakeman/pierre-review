import { and, desc, eq, gte, inArray, lt } from 'drizzle-orm';
import type { CostModel } from '@pierre-review/shared';
import type { BotScopeWire, ProContext } from '../../contract.js';
import type { FoldComment, FoldPull, FoldRepoInput, FoldThread } from './fold.js';
import { ACTIVITY_WINDOW_MS, walkBudgetFor } from './place.js';

// THE HOST ADAPTER — the tenant's own tables → the neutral rows the contract fold reads.
//
// Everything here is a TRANSLATION of `packages/ml/docs/METRIC-CONTRACT.md` §2 and §3.0 onto
// `ctx.schema`. The fold itself (`fold.ts`) knows nothing about the host; this module knows nothing
// about the corpus's populations. That split is what lets the golden fixture test the definitions
// without a database and lets this module be reviewed against the schema without re-arguing them.
//
// ⚠ `ctx.schema` IS `Record<string, any>` — every column below is a GREPPED FACT, not a compiler
// guarantee (the `ctx.schema.teams` precedent: a leftover name type-checks perfectly and throws
// only when the query runs).
//
// ── WHY THIS IS NOT A HOST CONTRACT MEMBER ──────────────────────────────────────────────────────
// `apiVersion` is 21 and four literals across two repositories must agree; a half-applied bump
// degrades the ENTIRE plugin to OSS mode with nothing thrown. A premium fold that core has no use
// for does not earn that risk, and the plugin already reaches core tables this way in
// `insights/pr-refs.ts`.

/* eslint-disable @typescript-eslint/no-explicit-any */

/** SQLite `inArray` binds one parameter per element and the driver has a variable ceiling. */
const ID_CHUNK = 400;

/**
 * The app's `AutomatedReviewerKind` → the corpus's vendor string.
 *
 * ⚠ EXPLICIT, NEVER `String(kind)`. The seven fitted spellings happen to be identical on both
 * sides; that is a coincidence of naming and not a guarantee, and a bare cast would key a cell on
 * whatever the host invents next. The vocabularies also DIVERGE IN BOTH DIRECTIONS and each
 * direction is a different sentence:
 *
 *  * absent below and therefore `vendor_not_in_corpus_vocabulary` — `deepsource`,
 *    `github_code_quality`, `github_advanced_security`, `codex`, `pierre`, `vendor`, and every
 *    unbranded reviewer whose stored `kind` is null. DeepSource is the live example: a real,
 *    popular product the corpus has never seen and plausibly a customer's biggest bot.
 *  * present but UNSTRATIFIABLE in the shipped corpus — `baz`, `bito`, `codeant`, `ellipsis`,
 *    `entelligence`, `graphite`, `korbit`. Mapped deliberately, so the refusal that fires is "we
 *    have too little of this bot" (with the artifact's own shortfall numbers) rather than "we have
 *    never measured it".
 *  * `in_house` is a real corpus vendor STRING that names no product — 959 repositories and
 *    117,339 review-bot comments in the shipped corpus, blending three unrelated reviewers plus
 *    everything fronted by `github-actions[bot]`. Mapped so the refusal is `vendor_unfittable`.
 *
 * ⚠ THE STORED `kind` BEATS THE LOGIN SEED. This map is keyed on the value `workspace_reviewers`
 * holds, which is the same resolution `hiddenBotUserIds` and `InsightPrRef.authorIsBot` use. A
 * second login-based classifier here would eventually disagree with the Timeline about who the bot
 * is, which is unexplainable on screen.
 */
const CORPUS_VENDOR_BY_KIND: Readonly<Record<string, string>> = {
  coderabbit: 'coderabbit',
  copilot: 'copilot',
  cursor: 'cursor',
  greptile: 'greptile',
  sourcery: 'sourcery',
  qodo: 'qodo',
  devin: 'devin',
  baz: 'baz',
  bito: 'bito',
  codeant: 'codeant',
  ellipsis: 'ellipsis',
  entelligence: 'entelligence',
  graphite: 'graphite',
  korbit: 'korbit',
  in_house: 'in_house',
};

export function corpusVendorForKind(kind: string | null | undefined): string | null {
  if (kind == null) return null;
  return Object.prototype.hasOwnProperty.call(CORPUS_VENDOR_BY_KIND, kind)
    ? (CORPUS_VENDOR_BY_KIND[kind] as string)
    : null;
}

export interface WorkspaceReviewer {
  userId: number;
  login: string;
  label: string | null;
  kind: string | null;
  /** `null` ⇒ the corpus has no vendor string for this reviewer at all. */
  vendor: string | null;
  /** The fold's unit key. The corpus vendor when there is one; otherwise a synthetic `#<userId>`
   *  that cannot collide with any corpus vendor string, so an unbranded bot still gets its own
   *  unit, its own counters and its own honest refusal. */
  key: string;
  /** ⚠ THE STORED PRICE, IN DOLLARS, EXACTLY AS RECORDED — `null` is NO PRICE SET and `0` is a
   *  real "we pay nothing for this". Nothing here coalesces one into the other, and under
   *  `costModel: 'per_seat'` this is the per-developer UNIT, never the monthly figure (that is
   *  unit × the workspace's seat count, multiplied ON READ in `cost.ts`). Per WORKSPACE: it comes
   *  off the same single-workspace-predicate read as the judgement beside it. */
  unitMonthlyUsd: number | null;
  costModel: CostModel;
}

interface ReviewerRow {
  authorUserId: number;
  automated: boolean;
  role: string;
  kind: string | null;
  label: string | null;
  source: string;
  monthlyCents: number | null;
  costModel: string | null;
}

interface UserRow {
  id: number;
  githubLogin: string;
  isBot: boolean;
  githubType: string | null;
}

/**
 * The workspace's automation, resolved once: who is a MACHINE (any role) and who is a review
 * VENDOR (role `'review'` only).
 *
 * ⚠ "MACHINE" IS ANY AUTOMATION, NOT "A REVIEW VENDOR" — `dependency`, `quality_check`,
 * `code_agent`, `release`, `housekeeping` AND `review`, i.e. the actor-lane resolver's UNION, never
 * `automatedReviewerUserIds` alone, PLUS `users.githubType === 'Bot'` as an independent disjunct
 * (a null derived column must not read as "human", and the raw type misses vendor accounts posting
 * via a PAT). Reading the narrow column instead divides four findings by a hundred merges instead
 * of ten and reports every vendor as four times quieter than it is.
 *
 * ⚠ A MANUAL WORKSPACE JUDGEMENT WINS IN BOTH DIRECTIONS, which is the app's existing resolution
 * and deliberately not a second classifier — a benchmark that disagreed with the Timeline about who
 * the bot is would be unexplainable on screen.
 */
export interface WorkspaceAutomation {
  machineUserIds: Set<number>;
  reviewers: WorkspaceReviewer[];
  /** Keyed by fold unit key. */
  byKey: Map<string, WorkspaceReviewer[]>;
  /** userId → the fold unit key its comments attribute to. */
  vendorKeyByUserId: Map<number, string>;
}

async function reviewerRows(
  ctx: ProContext,
  accountId: number,
  workspaceId: number,
): Promise<ReviewerRow[]> {
  const t = ctx.schema.workspaceReviewers;
  // ⚠ AN EXPLICIT WORKSPACE PREDICATE. Every read of this table needs one — the table is
  // one row per (account, workspace, author) and a helper that collapsed it one-row-per-author
  // would read rows in heap order, which flips after any UPDATE on Postgres.
  return (await ctx.db
    .select({
      authorUserId: t.authorUserId,
      automated: t.automated,
      role: t.role,
      kind: t.kind,
      label: t.label,
      source: t.source,
      // ⚠ THE PRICE RIDES THE ROW IT LIVES ON. Judgement, identity and price are three
      // independently-owned facts on ONE `workspace_reviewers` row, so reading the price is two
      // more columns on this select rather than a second query — and, more importantly, it cannot
      // be read at a different grain from the judgement it is rendered beside. There is no `??`
      // chain behind either column: nothing inherits.
      monthlyCents: t.monthlyCents,
      costModel: t.costModel,
    })
    .from(t)
    .where(and(eq(t.accountId, accountId), eq(t.workspaceId, workspaceId)))
    .execute()) as ReviewerRow[];
}

async function usersByIds(ctx: ProContext, ids: number[]): Promise<Map<number, UserRow>> {
  const out = new Map<number, UserRow>();
  const t = ctx.schema.users;
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK);
    if (chunk.length === 0) continue;
    const rows = (await ctx.db
      .select({
        id: t.id,
        githubLogin: t.githubLogin,
        isBot: t.isBot,
        githubType: t.githubType,
      })
      .from(t)
      .where(inArray(t.id, chunk))
      .execute()) as UserRow[];
    for (const row of rows) out.set(row.id, row);
  }
  return out;
}

/** Resolve the workspace's automation over the actor ids that actually appear in the data. */
export async function resolveAutomation(
  ctx: ProContext,
  accountId: number,
  workspaceId: number,
  actorIds: Iterable<number>,
): Promise<WorkspaceAutomation> {
  const rows = await reviewerRows(ctx, accountId, workspaceId);
  const byUser = new Map<number, ReviewerRow>();
  for (const row of rows) byUser.set(row.authorUserId, row);

  const wanted = new Set<number>(actorIds);
  for (const row of rows) wanted.add(row.authorUserId);
  const users = await usersByIds(ctx, [...wanted]);

  const machineUserIds = new Set<number>();
  for (const id of wanted) {
    const judged = byUser.get(id);
    // A HUMAN judgement a person typed wins over every signal, in both directions.
    if (judged != null && judged.source === 'manual') {
      if (judged.automated) machineUserIds.add(id);
      continue;
    }
    const user = users.get(id);
    if ((judged != null && judged.automated) || user?.isBot === true || user?.githubType === 'Bot') {
      machineUserIds.add(id);
    }
  }

  const reviewers: WorkspaceReviewer[] = [];
  for (const row of rows) {
    // ⚠ EXACTLY `=== 'review'`, NEVER `!== 'quality_check'`. Six roles exist and only one is the
    // reviewer cohort; the negated spelling re-admits `dependency`, `code_agent`, `release` and
    // `housekeeping` the day they were added, which is how a linter's volume ends up in a
    // review-bot cohort.
    if (!row.automated || row.role !== 'review') continue;
    const user = users.get(row.authorUserId);
    const vendor = corpusVendorForKind(row.kind);
    reviewers.push({
      userId: row.authorUserId,
      login: user?.githubLogin ?? `user:${row.authorUserId}`,
      label: row.label,
      kind: row.kind,
      vendor,
      key: vendor ?? `#${row.authorUserId}`,
      // ⚠ CENTS → DOLLARS, AND `null` SURVIVES AS `null`. Storage is integer cents (money is never
      // a float); the wire unit is dollars. `row.monthlyCents == null` is NO PRICE SET and must not
      // become 0 — a `?? 0` here would tell every reader that every unpriced bot is free.
      unitMonthlyUsd: row.monthlyCents == null ? null : row.monthlyCents / 100,
      // A row with no price is always 'flat' (the cost route resets the model in the same
      // statement that clears the price), so an unexpected string degrades to it rather than
      // widening the union.
      costModel: row.costModel === 'per_seat' ? 'per_seat' : 'flat',
    });
  }
  reviewers.sort((a, b) => (a.key === b.key ? a.userId - b.userId : a.key < b.key ? -1 : 1));

  const byKey = new Map<string, WorkspaceReviewer[]>();
  const vendorKeyByUserId = new Map<number, string>();
  for (const reviewer of reviewers) {
    const list = byKey.get(reviewer.key);
    if (list == null) byKey.set(reviewer.key, [reviewer]);
    else list.push(reviewer);
    vendorKeyByUserId.set(reviewer.userId, reviewer.key);
  }
  return { machineUserIds, reviewers, byKey, vendorKeyByUserId };
}

// ── Per-repository collection ───────────────────────────────────────────────────────────────────

/**
 * THE STRETCH OF TIME ONE REVIEWER'S OWN OUTPUT COVERS, on the pull requests actually read.
 *
 * ⚠ IT MEASURES THE WORK AND NEVER THE MONEY. No price enters this type, and none may: an earlier
 * cut carried a `usd` field prorating today's monthly price across this stretch, which asserted a
 * historical spend the app cannot evidence (the price may have changed; the subscription may be
 * younger than the span). See `BotBenchmarkCostSpan` — "Do not put a price back on this interface."
 *
 * What it IS for: annualising the reviewer's own throughput, so a per-month RATE can be stated at
 * today's price. It is per (repository, VENDOR) rather than per repository because that is the
 * grain the rate is computed at. The walked slice is `ORDER BY updated_at DESC LIMIT walkBudget`
 * with NO time predicate — it can reach back months — so counting its work against a fixed
 * fortnight would divide a 90-day count by a 14-day window. The honest denominator is the
 * reviewer's OWN observed working period: earliest to latest comment it left on the slice.
 *
 * ⚠ AND IT IS THE COMMENTS, NOT THE MERGES. Merge timestamps are the obvious candidate and they
 * are wrong here: the thread-outcome population is every HUMAN-AUTHORED pull request in the slice,
 * merged or not, and a bot's threads are written while a pull request is OPEN. A span read off
 * merge times would be narrower than the population it prices, which is the same population-vs-time
 * mismatch this replaced, one step smaller.
 *
 * `null` when fewer than two of the reviewer's comments carried a readable timestamp, or when they
 * all landed in the same instant — the unit then REFUSES rather than falling back to a projection.
 */
export interface VendorSpan {
  fromMs: number;
  toMs: number;
  comments: number;
}

export interface CollectedRepo {
  repoId: number;
  owner: string;
  name: string;
  /** Days since the host first held this repository — the window-completeness gate. */
  heldDays: number;
  /** ⚠ MERGED PULL REQUESTS IN THE LAST 14 DAYS, ANY AUTHOR. See `place.ts` and the wire type. */
  mergedPrsLast14d: number;
  walkBudget: number;
  prsConsidered: number;
  /** Keyed by the SAME vendor key `foldRepo` emits units under, so a unit joins its own span. */
  vendorSpans: Map<string, VendorSpan>;
  input: FoldRepoInput;
}

interface RepoRow {
  id: number;
  owner: string;
  name: string;
  createdAt: Date | number | null;
}

interface PrRow {
  id: number;
  number: number;
  state: string;
  authorId: number | null;
}

function toMs(value: Date | number | null | undefined): number | null {
  if (value == null) return null;
  if (value instanceof Date) return value.getTime();
  // sqlite unix-epoch seconds arrive as a number through the timestamp mode in some paths.
  return typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : null;
}

/** Body length, three-valued. ⚠ `null` is UNKNOWN, not empty: `body` is nullable on legacy rows
 *  from the 2026-06 lean window, a NON-EMPTY `excerpt` proves a non-empty body, and when neither
 *  decides the unit must refuse the two body-reading volume metrics rather than count the row as a
 *  finding or as a silent approval. */
function bodyChars(body: string | null | undefined, excerpt?: string | null): number | null {
  if (typeof body === 'string') return body.length;
  if (typeof excerpt === 'string' && excerpt.length > 0) return excerpt.length;
  return null;
}

/** One repository's RAW rows, before any judgement about who is a machine. ⚠ FETCH AND FOLD ARE
 *  TWO PHASES on purpose: the automation resolver has to see every actor in the request before it
 *  can judge any of them, so the users table is read ONCE per request rather than once per
 *  repository — and a per-repository resolver would let the same login read as a bot in one repo
 *  and a person in the next. */
export interface RawRepoData {
  repo: RepoRow;
  mergedPrsLast14d: number;
  walkBudget: number;
  prRows: PrRow[];
  threads: ThreadRow[];
  reviewComments: ThreadCommentRow[];
  prComments: SimpleCommentRow[];
  reviews: SimpleCommentRow[];
}

/**
 * PHASE 1 — one repository's rows, over the corpus's own pull-request set.
 *
 * ⚠ THE PULL-REQUEST SET IS CAPPED BEFORE EITHER POPULATION. The corpus walked the `walkBudget`
 * MOST-RECENTLY-UPDATED pull requests and stopped, and that cap actually bound in 85.5 % of live
 * repositories in the median cell. A customer folding over their whole synced history is measuring
 * an older, wider population than any cell describes — older threads, higher overdue rates, lower
 * reply rates. `ORDER BY updatedAt DESC LIMIT walkBudget` is the same rule, applied here.
 */
export async function fetchRepoData(
  ctx: ProContext,
  accountId: number,
  repo: RepoRow,
  nowMs: number,
): Promise<RawRepoData> {
  const prT = ctx.schema.pullRequests;

  // -- the banding axis: merged PRs in the trailing 14 days, NO AUTHOR PREDICATE. --------------
  const windowFrom = new Date(nowMs - ACTIVITY_WINDOW_MS);
  const windowTo = new Date(nowMs);
  const mergedRows = (await ctx.db
    .select({ id: prT.id })
    .from(prT)
    .where(
      and(
        eq(prT.accountId, accountId),
        eq(prT.repoId, repo.id),
        // Half-open, the app's window-purity rule.
        gte(prT.mergedAt, windowFrom),
        lt(prT.mergedAt, windowTo),
      ),
    )
    .execute()) as Array<{ id: number }>;
  const mergedPrsLast14d = mergedRows.length;
  const walkBudget = walkBudgetFor(mergedPrsLast14d);

  const prRows =
    walkBudget === 0
      ? []
      : ((await ctx.db
          .select({
            id: prT.id,
            number: prT.number,
            state: prT.state,
            authorId: prT.authorId,
          })
          .from(prT)
          .where(and(eq(prT.accountId, accountId), eq(prT.repoId, repo.id)))
          .orderBy(desc(prT.updatedAt))
          .limit(walkBudget)
          .execute()) as PrRow[]);

  const prIds = prRows.map((p) => p.id);
  return {
    repo,
    mergedPrsLast14d,
    walkBudget,
    prRows,
    threads: await fetchThreads(ctx, prIds),
    reviewComments: await fetchReviewComments(ctx, prIds),
    prComments: await fetchPrComments(ctx, prIds),
    reviews: await fetchReviews(ctx, prIds),
  };
}

/** Every actor id this repository's rows mention — pull-request authors AND every comment author,
 *  because "human" is the complement of MACHINE and that verdict is needed for comment authors the
 *  workspace has never classified. */
export function actorIdsOf(data: RawRepoData): number[] {
  const ids = new Set<number>();
  for (const pr of data.prRows) if (pr.authorId != null) ids.add(pr.authorId);
  for (const c of data.reviewComments) if (c.authorId != null) ids.add(c.authorId);
  for (const c of data.prComments) if (c.authorId != null) ids.add(c.authorId);
  for (const r of data.reviews) if (r.authorId != null) ids.add(r.authorId);
  return [...ids];
}

/** PHASE 2 — the raw rows plus a resolved automation set → the fold's neutral input. */
export function buildRepoInput(
  data: RawRepoData,
  automation: WorkspaceAutomation,
  declaredKeys: readonly string[],
  nowMs: number,
): CollectedRepo {
  const { repo, prRows, threads, reviewComments, prComments, reviews } = data;
  const numberByPrId = new Map<number, number>();
  for (const pr of prRows) numberByPrId.set(pr.id, pr.number);

  const pulls: FoldPull[] = prRows.map((pr) => ({
    number: pr.number,
    merged: pr.state === 'merged',
    authorIsMachine: pr.authorId != null && automation.machineUserIds.has(pr.authorId),
    // ⚠ ALWAYS TRUE, and hard-coded on purpose: the host syncs detail for every pull request it
    // holds, so the corpus's "enumerated but never read" state cannot arise here. The corpus-side
    // gate stays pinned by the golden fixture; this is the one place the asymmetry is stated.
    detailObserved: true,
  }));

  const commentsByThread = new Map<number, ThreadCommentRow[]>();
  for (const c of reviewComments) {
    const list = commentsByThread.get(c.threadId);
    if (list == null) commentsByThread.set(c.threadId, [c]);
    else list.push(c);
  }

  const foldThreads: FoldThread[] = [];
  for (const thread of threads) {
    const prNumber = numberByPrId.get(thread.prId);
    if (prNumber == null) continue;
    const ordered = (commentsByThread.get(thread.id) ?? []).slice().sort((a, b) => {
      const am = toMs(a.createdAt) ?? 0;
      const bm = toMs(b.createdAt) ?? 0;
      return am - bm || a.id - b.id;
    });
    foldThreads.push(threadFacts(thread, prNumber, ordered, automation, nowMs));
  }

  const foldComments: FoldComment[] = [];
  // ⚠ THE SPAN ACCUMULATES OVER THE SAME ROWS THE FOLD READS, in the same loop, so the stretch the
  // throughput is annualised over and the work counted in it can never come from two populations.
  const spans = new Map<string, VendorSpan>();
  for (const c of reviewComments) {
    const prNumber = numberByPrId.get(c.prId);
    if (prNumber == null) continue;
    pushVendorComment(
      foldComments,
      spans,
      prNumber,
      c.authorId,
      bodyChars(c.body, c.excerpt),
      toMs(c.createdAt),
      automation,
    );
  }
  for (const c of prComments) {
    const prNumber = numberByPrId.get(c.prId);
    if (prNumber == null) continue;
    pushVendorComment(
      foldComments,
      spans,
      prNumber,
      c.authorId,
      bodyChars(c.body),
      toMs(c.createdAt),
      automation,
    );
  }
  for (const r of reviews) {
    const prNumber = numberByPrId.get(r.prId);
    if (prNumber == null) continue;
    // ⚠ A REVIEW WITH AN EMPTY BODY IS A SILENT APPROVAL: it proves the vendor ran (so it counts
    // toward the live gate) and is NEVER a finding. Counting it would score a bot that approves
    // without words above one that writes.
    pushVendorComment(
      foldComments,
      spans,
      prNumber,
      r.authorId,
      bodyChars(r.body),
      toMs(r.createdAt),
      automation,
    );
  }

  const heldMs = toMs(repo.createdAt);
  return {
    repoId: repo.id,
    owner: repo.owner,
    name: repo.name,
    heldDays: heldMs == null ? 0 : Math.max(0, (nowMs - heldMs) / 86_400_000),
    mergedPrsLast14d: data.mergedPrsLast14d,
    walkBudget: data.walkBudget,
    prsConsidered: prRows.length,
    vendorSpans: spans,
    input: {
      repo: `${repo.owner}/${repo.name}`,
      // ⚠ ALWAYS `'ok'`. A repository the host cannot read has no rows at all, so
      // `repo_not_walked` is corpus-side only and unreachable here. The guard ships in the fold
      // anyway, because its ORDER is what the fixture pins.
      walkStatus: 'ok',
      declaredVendors: declaredKeys,
      pulls,
      threads: foldThreads,
      comments: foldComments,
    },
  };
}

function pushVendorComment(
  out: FoldComment[],
  spans: Map<string, VendorSpan>,
  prNumber: number,
  authorId: number | null,
  chars: number | null,
  atMs: number | null,
  automation: WorkspaceAutomation,
): void {
  if (authorId == null) return;
  const key = automation.vendorKeyByUserId.get(authorId);
  if (key == null) return;
  out.push({ pr: prNumber, vendor: key, isVendorComment: true, bodyChars: chars });
  // ⚠ A COMMENT WITH NO TIMESTAMP NARROWS THE SPAN AND ENTERS NO METRIC. It is skipped here and
  // counted nowhere — the alternative, treating an unknown time as `now`, would stretch the span to
  // the request clock, which lowers `actedPerMonth` and therefore INFLATES `monthlyUsd ÷
  // actedPerMonth`. (This comment said "understate" while the money was prorated across the span;
  // the direction reversed when the span stopped carrying a price and started dividing a rate.)
  if (atMs == null || !Number.isFinite(atMs)) return;
  const span = spans.get(key);
  if (span == null) {
    spans.set(key, { fromMs: atMs, toMs: atMs, comments: 1 });
    return;
  }
  if (atMs < span.fromMs) span.fromMs = atMs;
  if (atMs > span.toMs) span.toMs = atMs;
  span.comments += 1;
}

// ── Thread facts ────────────────────────────────────────────────────────────────────────────────

/** ⚠ THE HOST FETCHES THREAD COMMENTS AT `comments(first: 50)` WITH NO `pageInfo` ON THAT INNER
 *  CONNECTION (verified in `apps/backend/src/github/queries.ts`), so it has the corpus's truncation
 *  failure mode and no `comment_total` column to detect it with. The rule is therefore an
 *  APPROXIMATION and is spelled as one. A thread with exactly 50 comments and no more is FALSELY
 *  excluded — the CONSERVATIVE direction, the same one the corpus takes, and it must never be
 *  flipped to "assume complete", which manufactures an overdue-untouched rate out of paging. */
const THREAD_COMMENT_PAGE = 50;

interface ThreadRow {
  id: number;
  prId: number;
  path: string | null;
  line: number | null;
  isResolved: boolean;
  isOutdated: boolean;
  createdAt: Date | number | null;
}

interface ThreadCommentRow {
  id: number;
  threadId: number;
  prId: number;
  authorId: number | null;
  body: string | null;
  excerpt: string | null;
  createdAt: Date | number | null;
}

/**
 * One thread's comments → the corpus's thread columns.
 *
 * ⚠ THREE COHORTS, AND "HUMAN" IS THE COMPLEMENT OF **MACHINE**, NOT OF REVIEW-BOT. A CI bot
 * answering a vendor finding is not a human reply — 645 of 3,292 comments sat in exactly that gap
 * in the walk's own v1 schema and every one was folded into a human reply count.
 *
 * ⚠ THE CLOCK STARTS AT THE FIRST REVIEW-BOT COMMENT ON THE THREAD, NEVER THE THREAD ROOT. A thread
 * a human opened and a bot joined has a root that is not a bot finding at all. (The corpus computes
 * `first_review_bot_comment_at` over the review-bot UNION on the thread, not per vendor, and this
 * mirrors it exactly — a per-vendor clock would be a different column with the same name.)
 */
function threadFacts(
  thread: ThreadRow,
  prNumber: number,
  ordered: ThreadCommentRow[],
  automation: WorkspaceAutomation,
  nowMs: number,
): FoldThread {
  const vendors = new Set<string>();
  let firstBotAt: number | null = null;
  let lastBotAt: number | null = null;
  const humanTimes: number[] = [];
  for (const c of ordered) {
    const at = toMs(c.createdAt);
    if (c.authorId == null) {
      if (at != null) humanTimes.push(at);
      continue;
    }
    const key = automation.vendorKeyByUserId.get(c.authorId);
    if (key != null) {
      vendors.add(key);
      if (at != null) {
        if (firstBotAt == null || at < firstBotAt) firstBotAt = at;
        if (lastBotAt == null || at > lastBotAt) lastBotAt = at;
      }
      continue;
    }
    if (automation.machineUserIds.has(c.authorId)) continue;
    if (at != null) humanTimes.push(at);
  }

  const tailComplete = ordered.length < THREAD_COMMENT_PAGE;
  const createdMs = toMs(thread.createdAt);

  // ⚠ EVERY HUMAN-SIDE FACT IS NULL UNDER TRUNCATION. "Nobody answered" and "we did not read far
  // enough to know" are the same shape and different claims; the corpus nulls the fact rather than
  // defaulting it to false, and so does this.
  let humanReplied: boolean | null = null;
  let humanFollowedLastBot: boolean | null = null;
  let secondsToFirstHumanReply: number | null = null;
  if (tailComplete) {
    if (firstBotAt != null) {
      const later = humanTimes.filter((t) => t > (firstBotAt as number));
      humanReplied = later.length > 0;
      if (later.length > 0) {
        secondsToFirstHumanReply = Math.floor((Math.min(...later) - firstBotAt) / 1000);
      }
    } else {
      humanReplied = false;
    }
    humanFollowedLastBot =
      lastBotAt == null ? false : humanTimes.some((t) => t > (lastBotAt as number));
  }

  return {
    id: String(thread.id),
    pr: prNumber,
    vendors: [...vendors].sort(),
    path: thread.path,
    // ⚠ `line === null` ⇒ NO ANCHOR. A thread whose line GitHub no longer reports cannot be matched
    // against another vendor's, and bucketing every such thread under a null line would make two
    // unrelated outdated threads on one file look like a cross-bot overlap.
    line: thread.line,
    resolved: thread.isResolved === true,
    // ⚠ `isOutdated`, NOT `derivedState === 'likely_addressed'`. GitHub's flag says the anchored
    // lines changed after the comment; `likely_addressed` asks whether a commit touched the
    // thread's FILE after its last comment. Two different questions, deliberately different names,
    // and they differ by percentage points.
    outdated: thread.isOutdated === true,
    tailComplete,
    humanReplied,
    humanFollowedLastBot,
    // The corpus freezes age at observation; the customer's is live against the request clock.
    ageSeconds: createdMs == null ? null : Math.floor((nowMs - createdMs) / 1000),
    secondsToFirstHumanReply,
    // ⚠ THE ABSOLUTE INSTANT, FOR THE COST WINDOW ALONE. `ageSeconds` above is FLOORED to whole
    // seconds against the request clock, which is the corpus's shape and the right one for every
    // metric; a calendar window needs the timestamp itself, so it travels separately rather than
    // being reconstructed from `nowMs - ageSeconds * 1000` at the far end. No metric reads it.
    createdAtMs: createdMs,
  };
}

// ── Row fetchers ────────────────────────────────────────────────────────────────────────────────

async function fetchThreads(ctx: ProContext, prIds: number[]): Promise<ThreadRow[]> {
  if (prIds.length === 0) return [];
  const t = ctx.schema.reviewThreads;
  const out: ThreadRow[] = [];
  for (let i = 0; i < prIds.length; i += ID_CHUNK) {
    const chunk = prIds.slice(i, i + ID_CHUNK);
    out.push(
      ...((await ctx.db
        .select({
          id: t.id,
          prId: t.prId,
          path: t.path,
          line: t.line,
          isResolved: t.isResolved,
          isOutdated: t.isOutdated,
          createdAt: t.createdAt,
        })
        .from(t)
        .where(inArray(t.prId, chunk))
        .execute()) as ThreadRow[]),
    );
  }
  return out;
}

async function fetchReviewComments(
  ctx: ProContext,
  prIds: number[],
): Promise<ThreadCommentRow[]> {
  if (prIds.length === 0) return [];
  const t = ctx.schema.reviewComments;
  const out: ThreadCommentRow[] = [];
  for (let i = 0; i < prIds.length; i += ID_CHUNK) {
    const chunk = prIds.slice(i, i + ID_CHUNK);
    out.push(
      ...((await ctx.db
        .select({
          id: t.id,
          threadId: t.threadId,
          prId: t.prId,
          authorId: t.authorId,
          body: t.body,
          excerpt: t.excerpt,
          createdAt: t.createdAt,
        })
        .from(t)
        .where(inArray(t.prId, chunk))
        .execute()) as ThreadCommentRow[]),
    );
  }
  return out;
}

interface SimpleCommentRow {
  prId: number;
  authorId: number | null;
  body: string | null;
  /** ⚠ READ ONLY FOR THE COST SPAN — never for a metric. No fold column depends on it, so a null
   *  here narrows the span and changes no rate. `reviews` spells it `submitted_at`. */
  createdAt: Date | number | null;
}

async function fetchPrComments(ctx: ProContext, prIds: number[]): Promise<SimpleCommentRow[]> {
  if (prIds.length === 0) return [];
  const t = ctx.schema.prComments;
  const out: SimpleCommentRow[] = [];
  for (let i = 0; i < prIds.length; i += ID_CHUNK) {
    const chunk = prIds.slice(i, i + ID_CHUNK);
    out.push(
      ...((await ctx.db
        .select({ prId: t.prId, authorId: t.authorId, body: t.body, createdAt: t.createdAt })
        .from(t)
        .where(inArray(t.prId, chunk))
        .execute()) as SimpleCommentRow[]),
    );
  }
  return out;
}

async function fetchReviews(ctx: ProContext, prIds: number[]): Promise<SimpleCommentRow[]> {
  if (prIds.length === 0) return [];
  const t = ctx.schema.reviews;
  const out: SimpleCommentRow[] = [];
  for (let i = 0; i < prIds.length; i += ID_CHUNK) {
    const chunk = prIds.slice(i, i + ID_CHUNK);
    out.push(
      ...((await ctx.db
        // ⚠ `submittedAt`, NOT `createdAt` — `reviews` is the one table of the three that spells it
        // differently, and `ctx.schema` is `Record<string, any>`, so the wrong name is `undefined`
        // at runtime rather than a compile error.
        .select({ prId: t.prId, authorId: t.authorId, body: t.body, createdAt: t.submittedAt })
        .from(t)
        .where(inArray(t.prId, chunk))
        .execute()) as SimpleCommentRow[]),
    );
  }
  return out;
}

/** The scope's repositories, in a deterministic order, account-scoped. */
export async function reposInScope(
  ctx: ProContext,
  accountId: number,
  scope: BotScopeWire,
): Promise<RepoRow[]> {
  if (scope.repoIds.length === 0) return [];
  const t = ctx.schema.repos;
  const out: RepoRow[] = [];
  for (let i = 0; i < scope.repoIds.length; i += ID_CHUNK) {
    const chunk = scope.repoIds.slice(i, i + ID_CHUNK);
    out.push(
      ...((await ctx.db
        .select({ id: t.id, owner: t.owner, name: t.name, createdAt: t.createdAt })
        .from(t)
        .where(and(eq(t.accountId, accountId), inArray(t.id, chunk)))
        .execute()) as RepoRow[]),
    );
  }
  return out.sort((a, b) =>
    a.owner === b.owner ? (a.name < b.name ? -1 : 1) : a.owner < b.owner ? -1 : 1,
  );
}
