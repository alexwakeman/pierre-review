// Query layer for ML severity/category labels on BOT-authored text (CORE, free tier).
//
// Three jobs, and nothing else:
//   1. CANDIDATES  — which bot-authored targets in a workspace have no label yet
//                    (the background worker's worklist; see sync/ml-enrichment.ts)
//   2. WRITE       — upsert a batch of labels
//   3. READS       — the per-PR badge index, and the Bots severity rollup
//
// WHO COUNTS AS A BOT is not decided here: it is `automatedReviewerUserIds(accountId,
// workspaceId, 'all')` from queries.ts, the one workspace-grain answer. `'all'` rather than
// `'review'` on purpose — a quality check (SonarQube, Codecov, Hound) posts exactly the kind
// of finding a severity label is FOR, and the role split exists to stop a linter's volume
// distorting a REVIEWER's ROI numbers, which is a different question from "how bad is this
// comment". The role is still reported per row, so a consumer can narrow.
//
// TIMING: `workspace_reviewers` rows are written LAZILY (listDetectedReviewers, on a read of
// the Bots tab), never by sync. Known vendor logins are automated with zero stored rows, so
// CodeRabbit et al. are candidates from the first sync; a purely in-house bot becomes a
// candidate only once it has been classified. That is fine BECAUSE this is a pull-based
// worker: it re-derives the bot set every tick, so a newly-classified or newly-marked bot's
// whole backlog is picked up on the next pass with no backfill trigger of its own.
import { and, desc, eq, gte, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import type { AnyColumn } from 'drizzle-orm';
import type {
  AutomatedReviewerKind,
  BotAnalyticsMlTotals,
  BotFlaggingComment,
  BotFlaggingCommentsResponse,
  BotFlaggingRefine,
  BotFlaggingSelector,
  BotSeverityResponse,
  BotVendorComment,
  BotVendorCommentsResponse,
  BotWindowKind,
  DerivedState,
  MlBotSeverityRow,
  MlCategory,
  MlLabel,
  MlLabelTargetKind,
  MlSeverity,
  MlSeverityCounts,
  MlVendorConfidence,
  SeverityAgreementMatrix,
  VendorSeverityAxis,
} from '@pierre-review/shared';
import { db, schema } from './client.js';
import { botWindowMs } from './bot-window.js';
import { labelFor as labelForKind } from '../sync/reviewer-classify.js';
import {
  automatedReviewerUserIds,
  classificationKindForUser,
  classificationLabelMap,
  listWorkspaces,
  type BotScope,
} from './queries.js';

const {
  mlCommentLabels,
  pullRequests,
  repos,
  reviewComments,
  reviewThreads,
  prComments,
  reviews,
  users,
} = schema;

const ML_CATEGORY_VALUES = new Set<string>([
  'correctness_bug',
  'security',
  'performance',
  'style_readability',
  'maintainability_refactor',
  'testing',
  'documentation',
  'nitpick',
  'praise', // v2 non-finding class — excluded from severity-weighted rollups below
]);

const SEVERITY_KEYS: MlSeverity[] = ['nit', 'minor', 'major', 'critical'];

/**
 * "This row has text worth classifying."
 *
 * ⚠ `IS NOT NULL` IS NOT ENOUGH, and getting this wrong is silent. An approval with no comment
 * is a `reviews` row with an EMPTY-STRING body — there are 5.4k of them in this repo's own dev
 * database. They are not candidates (there is nothing to classify), but a NOT NULL test counts
 * them, so the candidate query and the pending COUNT would disagree forever: the worker would
 * skip them every tick while the Bots panel reported them as "still being processed" and
 * coverage never reached 100%.
 *
 * `trim(x) <> ''` is portable — both SQLite and Postgres have `trim` — so the two callers below
 * share ONE predicate rather than two that could drift.
 */
const hasText = (col: AnyColumn) => sql`trim(${col}) <> ''`;

function emptySeverityCounts(): MlSeverityCounts {
  return { nit: 0, minor: 0, major: 0, critical: 0 };
}

/** Anything the service invents beyond its nine documented values is dropped, not stored. */
function coerceCategories(raw: unknown): MlCategory[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((c): c is MlCategory => typeof c === 'string' && ML_CATEGORY_VALUES.has(c));
}

function coerceSeverity(raw: unknown): MlSeverity | null {
  return typeof raw === 'string' && (SEVERITY_KEYS as string[]).includes(raw)
    ? (raw as MlSeverity)
    : null;
}

const VENDOR_CONFIDENCE_KEYS: MlVendorConfidence[] = ['high', 'medium', 'low'];

function coerceVendorConfidence(raw: unknown): MlVendorConfidence | null {
  return typeof raw === 'string' && (VENDOR_CONFIDENCE_KEYS as string[]).includes(raw)
    ? (raw as MlVendorConfidence)
    : null;
}

/**
 * Deep re-sync support: drop every ML label in one repo so the enrichment worker re-scores
 * it against the CURRENTLY served model. Labels carry the model_version that produced them;
 * a deep sync is the user's explicit "re-fetch and re-derive everything" gesture, so stale
 * versions are purged rather than left to mix with fresh ones in the same charts.
 */
export async function deleteMlLabelsForRepo(accountId: number, repoId: number): Promise<void> {
  await db
    .delete(mlCommentLabels)
    .where(and(eq(mlCommentLabels.accountId, accountId), eq(mlCommentLabels.repoId, repoId)))
    .execute();
}

// ── 1. Candidates ────────────────────────────────────────────────────────────────────────

export interface MlCandidate {
  targetKind: MlLabelTargetKind;
  targetId: number;
  prId: number;
  repoId: number;
  authorUserId: number;
  body: string;
  targetCreatedAt: Date;
  /** Inline review comments only (and only when PERSIST_BODIES stores hunks); null elsewhere. */
  diffHunk: string | null;
  /** The reviewed file's path (review threads carry it); null for PR comments / review bodies. */
  path: string | null;
}

/**
 * Bot-authored targets in this workspace that carry no label yet, NEWEST FIRST.
 *
 * Newest-first is a product decision, not an implementation detail: the enrichment is a
 * background sweep that can take an hour over a large history, and the labels a user is about
 * to look at are the ones on today's PRs. History fills in behind them.
 *
 * `limit` is a POOL size, not a batch size — the caller re-sorts the pool by body length before
 * batching, because the model pads a batch to its longest member (see config.mlBatchMaxChars).
 */
export async function listMlCandidates(
  accountId: number,
  scope: BotScope,
  limit: number,
): Promise<MlCandidate[]> {
  if (scope.repoIds.length === 0) return [];
  const automatedIds = await automatedReviewerUserIds(accountId, scope.workspaceId, 'all');
  if (automatedIds.length === 0) return [];

  // The join predicate is identical for all three kinds bar the discriminator and which id
  // space `target_id` is compared against — hence the AnyColumn parameter rather than three
  // copies that could drift.
  const unlabelled = (kind: MlLabelTargetKind, targetId: AnyColumn) =>
    and(
      eq(mlCommentLabels.accountId, accountId),
      eq(mlCommentLabels.targetKind, kind),
      eq(mlCommentLabels.targetId, targetId),
    );

  const [rc, pc, rv] = await Promise.all([
    db
      .select({
        targetId: reviewComments.id,
        prId: reviewComments.prId,
        repoId: pullRequests.repoId,
        authorUserId: reviewComments.authorId,
        body: reviewComments.body,
        targetCreatedAt: reviewComments.createdAt,
        diffHunk: reviewComments.diffHunk,
        path: reviewThreads.path,
      })
      .from(reviewComments)
      .innerJoin(pullRequests, eq(pullRequests.id, reviewComments.prId))
      // LEFT, not inner: `path` is only a HINT to the model, so a review comment whose thread
      // row is missing (an orphan cannot arise under this schema's FKs, but nothing here should
      // depend on that) must still be selectable — `countUnlabelledBotText` does not join
      // threads at all, and an inner join here would count such a row as pending forever while
      // never offering it to the worker (the exact phantom-pending drift `hasText` exists to
      // prevent on the body predicate).
      .leftJoin(reviewThreads, eq(reviewThreads.id, reviewComments.threadId))
      .leftJoin(mlCommentLabels, unlabelled('review_comment', reviewComments.id))
      .where(
        and(
          eq(pullRequests.accountId, accountId),
          inArray(pullRequests.repoId, scope.repoIds),
          isNotNull(reviewComments.authorId),
          inArray(reviewComments.authorId, automatedIds),
          isNotNull(reviewComments.body),
          hasText(reviewComments.body),
          isNull(mlCommentLabels.id),
        ),
      )
      .orderBy(desc(reviewComments.createdAt))
      .limit(limit)
      .execute(),
    db
      .select({
        targetId: prComments.id,
        prId: prComments.prId,
        repoId: pullRequests.repoId,
        authorUserId: prComments.authorId,
        body: prComments.body,
        targetCreatedAt: prComments.createdAt,
      })
      .from(prComments)
      .innerJoin(pullRequests, eq(pullRequests.id, prComments.prId))
      .leftJoin(mlCommentLabels, unlabelled('pr_comment', prComments.id))
      .where(
        and(
          eq(pullRequests.accountId, accountId),
          inArray(pullRequests.repoId, scope.repoIds),
          isNotNull(prComments.authorId),
          inArray(prComments.authorId, automatedIds),
          isNotNull(prComments.body),
          hasText(prComments.body),
          isNull(mlCommentLabels.id),
        ),
      )
      .orderBy(desc(prComments.createdAt))
      .limit(limit)
      .execute(),
    db
      .select({
        targetId: reviews.id,
        prId: reviews.prId,
        repoId: pullRequests.repoId,
        authorUserId: reviews.authorId,
        body: reviews.body,
        targetCreatedAt: reviews.submittedAt,
      })
      .from(reviews)
      .innerJoin(pullRequests, eq(pullRequests.id, reviews.prId))
      .leftJoin(mlCommentLabels, unlabelled('review', reviews.id))
      .where(
        and(
          eq(pullRequests.accountId, accountId),
          inArray(pullRequests.repoId, scope.repoIds),
          isNotNull(reviews.authorId),
          inArray(reviews.authorId, automatedIds),
          isNotNull(reviews.body),
          hasText(reviews.body),
          isNull(mlCommentLabels.id),
        ),
      )
      .orderBy(desc(reviews.submittedAt))
      .limit(limit)
      .execute(),
  ]);

  const out: MlCandidate[] = [];
  type CandidateRow = (typeof pc)[number] & { diffHunk?: string | null; path?: string | null };
  const push = (kind: MlLabelTargetKind, rows: CandidateRow[]) => {
    for (const r of rows) {
      const raw = r.body ?? '';
      // ⚠ THE SQL PREDICATES ARE THE SOLE AUTHORITY ON CANDIDACY — nothing is dropped here.
      // This loop used to skip `raw.trim() === ''`, which sounds harmless and is not: SQL's
      // `trim()` strips SPACES ONLY in both dialects, JavaScript's strips all whitespace, so a
      // body of "  \n  " passed the SQL filter and was then discarded in JS. The row is then
      // pending forever — re-selected on every tick, never labelled, and counted by
      // `countUnlabelledBotText` as work outstanding. Whatever SQL offers, we classify; the
      // trim below only normalises the text we SEND (falling back to the raw string, so the
      // service is never handed an empty body).
      if (r.authorUserId == null) continue; // unreachable — `isNotNull(authorId)` above; narrows the type
      out.push({
        targetKind: kind,
        targetId: r.targetId,
        prId: r.prId,
        repoId: r.repoId,
        authorUserId: r.authorUserId,
        body: raw.trim() || raw,
        targetCreatedAt: r.targetCreatedAt,
        diffHunk: r.diffHunk ?? null,
        path: r.path ?? null,
      });
    }
  };
  push('review_comment', rc);
  push('pr_comment', pc);
  push('review', rv);

  out.sort((a, b) => b.targetCreatedAt.getTime() - a.targetCreatedAt.getTime());
  return out.slice(0, limit);
}

// ── 2. Write ─────────────────────────────────────────────────────────────────────────────

export interface MlLabelWrite {
  accountId: number;
  repoId: number;
  prId: number;
  targetKind: MlLabelTargetKind;
  targetId: number;
  authorUserId: number;
  severity: MlSeverity;
  severityOrd: number;
  severityProb: number;
  /** The BOT'S OWN declared severity, stored beside ours to be shown next to it — never used
   * to derive, correct or fall back `severity`. Null when the vendor declared none, and when
   * the deployed severity-api is an older build that omits the field. */
  vendorSeverity: MlSeverity | null;
  vendorSeverityConfidence: MlVendorConfidence | null;
  categories: MlCategory[];
  categoryProbs: Record<string, number>;
  isSummary: boolean;
  backend: string;
  modelVersion: string;
  bodyHash: string;
  targetCreatedAt: Date;
}

/**
 * Upsert labels.
 *
 * ⚠ THE CONFLICT TARGET IS THE TABLE'S DECLARED UNIQUE — `(account_id, target_kind,
 * target_id)`, index `mcl_account_target`. A stale target type-checks perfectly and only fails
 * at RUNTIME, in both dialects, when a row is actually written.
 *
 * Rows are written one statement per row rather than one multi-VALUES insert: a batch mixes
 * three target kinds and drizzle's `onConflictDoUpdate` set-clause would have to reference
 * `excluded.*` uniformly, which is the kind of thing that reads fine and silently writes the
 * wrong row when the shapes diverge. Batches are ≤128 and this is a background worker.
 */
export async function upsertMlLabels(rows: MlLabelWrite[]): Promise<number> {
  let written = 0;
  for (const r of rows) {
    const values = {
      accountId: r.accountId,
      repoId: r.repoId,
      prId: r.prId,
      targetKind: r.targetKind,
      targetId: r.targetId,
      authorUserId: r.authorUserId,
      severity: r.severity,
      severityOrd: r.severityOrd,
      severityProb: r.severityProb,
      // `?? null` rather than a straight read: drizzle DROPS an `undefined` key from both the
      // INSERT column list and the SET list, so an accidental undefined would insert fine and
      // then silently refuse to clear a stale vendor claim on the update path. An explicit null
      // means the same thing on both.
      vendorSeverity: r.vendorSeverity ?? null,
      vendorSeverityConfidence: r.vendorSeverityConfidence ?? null,
      categories: r.categories,
      categoryProbs: r.categoryProbs,
      isSummary: r.isSummary,
      backend: r.backend,
      modelVersion: r.modelVersion,
      bodyHash: r.bodyHash,
      targetCreatedAt: r.targetCreatedAt,
      updatedAt: new Date(),
    };
    const res = await db
      .insert(mlCommentLabels)
      .values(values)
      .onConflictDoUpdate({
        target: [
          mlCommentLabels.accountId,
          mlCommentLabels.targetKind,
          mlCommentLabels.targetId,
        ],
        set: {
          severity: values.severity,
          severityOrd: values.severityOrd,
          severityProb: values.severityProb,
          // ⚠ IN BOTH HALVES. A re-score must be able to CLEAR a vendor claim as well as set
          // one (a vendor drops its badge, or the service that read it is rolled back), so
          // these are written on the update path too — an omitted key here would freeze the
          // first value ever stored while the insert path looked perfectly correct.
          vendorSeverity: values.vendorSeverity,
          vendorSeverityConfidence: values.vendorSeverityConfidence,
          categories: values.categories,
          categoryProbs: values.categoryProbs,
          isSummary: values.isSummary,
          backend: values.backend,
          modelVersion: values.modelVersion,
          bodyHash: values.bodyHash,
          targetCreatedAt: values.targetCreatedAt,
          updatedAt: values.updatedAt,
        },
      })
      .returning({ id: mlCommentLabels.id })
      .execute();
    written += res.length;
  }
  return written;
}

// ── 3. Reads ─────────────────────────────────────────────────────────────────────────────

function toWireLabel(row: typeof mlCommentLabels.$inferSelect): MlLabel | null {
  const severity = coerceSeverity(row.severity);
  if (!severity) return null;
  return {
    targetKind: row.targetKind as MlLabelTargetKind,
    targetId: row.targetId,
    severity,
    severityOrd: row.severityOrd,
    severityProb: row.severityProb,
    // Coerced on the way OUT as well as in. The column is plain text in both dialects (the
    // drizzle `enum` is a compile-time nicety, not a CHECK constraint), and unlike `severity`
    // above a bad value here must NOT drop the whole label — the row's real severity is the
    // useful one, so an unreadable vendor claim degrades to "no vendor claim".
    vendorSeverity: coerceSeverity(row.vendorSeverity),
    vendorSeverityConfidence: coerceVendorConfidence(row.vendorSeverityConfidence),
    categories: coerceCategories(row.categories),
    isSummary: row.isSummary,
    backend: row.backend,
    modelVersion: row.modelVersion,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Every label on one PR — the ONE query each badge reads, so N cards on a PR cost one request.
 *
 * Returns null for a PR this account does not own (the handler 404s on that), which is the
 * standard id-addressed ownership rule: ownership is checked HERE, not in the handler.
 */
export async function getPrMlLabels(
  prId: number,
  accountId: number,
): Promise<MlLabel[] | null> {
  const owned = await db
    .select({ id: pullRequests.id })
    .from(pullRequests)
    .where(and(eq(pullRequests.id, prId), eq(pullRequests.accountId, accountId)))
    .limit(1)
    .execute();
  if (owned.length === 0) return null;

  const rows = await db
    .select()
    .from(mlCommentLabels)
    .where(and(eq(mlCommentLabels.accountId, accountId), eq(mlCommentLabels.prId, prId)))
    .execute();
  return rows.map(toWireLabel).filter((l): l is MlLabel => l !== null);
}

// A workspace's whole labelled corpus is read into memory for the rollup. It is bounded by
// retention (180 days by default) and each row is a handful of small columns, but a cap keeps a
// pathological account from turning one request into a huge allocation.
//
// TWO THINGS THE CAP NEEDS TO BE HONEST. It must have an ORDER BY — without one the rows a
// truncated scan returns are whatever the storage engine hands back first, which differs between
// SQLite and Postgres and CHANGES on Postgres after an UPDATE, so the same workspace would
// report different totals run to run. And the response must SAY it truncated (`truncated`),
// because a capped scan silently presented as a total is exactly the failure `pending` exists
// to avoid at the other end.
const ROLLUP_SCAN_CAP = 50_000;

/**
 * The Bots-interface severity rollup: how the bots in this workspace are distributed across
 * severities and categories, plus how much of their corpus has been labelled so far.
 *
 * Deliberately UNWINDOWED in this first cut — it covers every label in scope. The Bots panels
 * around it are windowed, so the block states its own coverage rather than borrowing theirs.
 */
export async function getBotSeverityRollup(
  accountId: number,
  scope: BotScope,
  enabled: boolean,
): Promise<BotSeverityResponse> {
  const generatedAt = new Date().toISOString();
  const empty: BotSeverityResponse = {
    workspaceId: scope.workspaceId,
    repoIds: scope.repoIds,
    enabled,
    labelled: 0,
    pending: 0,
    unscorable: 0,
    totals: {
      bySeverity: emptySeverityCounts(),
      byCategory: [],
      summaries: 0,
      praise: 0,
      findings: 0,
    },
    rows: [],
    backends: [],
    truncated: false,
    generatedAt,
  };
  if (scope.repoIds.length === 0) return empty;

  const automatedIds = await automatedReviewerUserIds(accountId, scope.workspaceId, 'all');
  if (automatedIds.length === 0) return empty;

  const [labelRows, kindMap, labelMap, userRows, pending, unscorable] = await Promise.all([
    db
      .select({
        authorUserId: mlCommentLabels.authorUserId,
        severity: mlCommentLabels.severity,
        isSummary: mlCommentLabels.isSummary,
        categories: mlCommentLabels.categories,
        backend: mlCommentLabels.backend,
      })
      .from(mlCommentLabels)
      .where(
        and(
          eq(mlCommentLabels.accountId, accountId),
          inArray(mlCommentLabels.repoId, scope.repoIds),
          inArray(mlCommentLabels.authorUserId, automatedIds),
        ),
      )
      .orderBy(desc(mlCommentLabels.targetCreatedAt), desc(mlCommentLabels.id))
      .limit(ROLLUP_SCAN_CAP)
      .execute(),
    classificationKindForUser(accountId, scope.workspaceId),
    classificationLabelMap(accountId, scope.workspaceId),
    db
      .select({ id: users.id, login: users.githubLogin, name: users.displayName })
      .from(users)
      .where(inArray(users.id, automatedIds))
      .execute(),
    countUnlabelledBotText(accountId, scope, automatedIds),
    countUnscorableBotText(accountId, scope, automatedIds),
  ]);

  const loginById = new Map<number, string>();
  for (const u of userRows) loginById.set(u.id, u.login || u.name?.trim() || `#${u.id}`);

  const totalsBySeverity = emptySeverityCounts();
  const totalsByCategory = new Map<MlCategory, number>();
  const backends = new Set<string>();
  let summaries = 0;
  let praise = 0;
  let findings = 0;

  interface Acc {
    labelled: number;
    bySeverity: MlSeverityCounts;
    summaries: number;
    praise: number;
    findings: number;
    high: number;
    categories: Map<MlCategory, number>;
  }
  const byBot = new Map<number, Acc>();

  for (const row of labelRows) {
    const severity = coerceSeverity(row.severity);
    if (!severity) continue;
    if (row.backend) backends.add(row.backend);
    const acc: Acc = byBot.get(row.authorUserId) ?? {
      labelled: 0,
      bySeverity: emptySeverityCounts(),
      summaries: 0,
      praise: 0,
      findings: 0,
      high: 0,
      categories: new Map(),
    };
    acc.labelled += 1;
    const categories = coerceCategories(row.categories);
    const isPraise = categories.includes('praise');
    if (row.isSummary) {
      acc.summaries += 1;
      summaries += 1;
    } else if (isPraise) {
      // v2 non-finding class: the bot acknowledging a fix / withdrawing a concern. Counted
      // like summaries — visible as labelled work, excluded from every severity-weighted
      // number for the same reason walkthroughs are (it is not a finding).
      acc.praise += 1;
      praise += 1;
    } else {
      acc.findings += 1;
      findings += 1;
      // ⚠ SEVERITY COUNTS ARE FINDINGS-ONLY, and it has to be inside this branch. Counting a
      // walkthrough's severity here while every RATE below divides by `findings` would let
      // "nits as a share of findings" exceed 100% — a vendor that posts one summary per PR would
      // reliably push it over. Summaries have their own counter; nothing divides by `labelled`.
      acc.bySeverity[severity] += 1;
      totalsBySeverity[severity] += 1;
      if (severity === 'major' || severity === 'critical') acc.high += 1;
      // Categories describe a FINDING. A walkthrough comment's category is an artefact of the
      // marker parser reading a summary table, so counting it would make "what do the bots
      // talk about" a chart of each vendor's summary template.
      for (const c of categories) {
        acc.categories.set(c, (acc.categories.get(c) ?? 0) + 1);
        totalsByCategory.set(c, (totalsByCategory.get(c) ?? 0) + 1);
      }
    }
    byBot.set(row.authorUserId, acc);
  }

  const rows: MlBotSeverityRow[] = [...byBot.entries()]
    .map(([userId, acc]) => {
      const login = loginById.get(userId) ?? `#${userId}`;
      const kind = (kindMap.get(userId) ?? null) as AutomatedReviewerKind | null;
      return {
        reviewerKey: `u${userId}`,
        userId,
        login,
        // Custom label → vendor brand → login: the same precedence the ROI panel uses, so one
        // bot reads with one name across the whole Bots interface.
        label: labelMap.get(userId) ?? (kind ? vendorBrand(kind, login) : login),
        kind,
        labelled: acc.labelled,
        bySeverity: acc.bySeverity,
        highShare: acc.findings > 0 ? acc.high / acc.findings : 0,
        summaries: acc.summaries,
        praise: acc.praise,
        topCategories: [...acc.categories.entries()]
          .map(([category, count]) => ({ category, count }))
          .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category))
          .slice(0, 5),
      };
    })
    .sort((a, b) => b.labelled - a.labelled || a.label.localeCompare(b.label));

  return {
    workspaceId: scope.workspaceId,
    repoIds: scope.repoIds,
    enabled,
    labelled: labelRows.length,
    pending,
    unscorable,
    totals: {
      bySeverity: totalsBySeverity,
      byCategory: [...totalsByCategory.entries()]
        .map(([category, count]) => ({ category, count }))
        .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category)),
      summaries,
      praise,
      findings,
    },
    rows,
    backends: [...backends].sort(),
    truncated: labelRows.length >= ROLLUP_SCAN_CAP,
    generatedAt,
  };
}

// Vendor brand names for the row label. Kept local and minimal on purpose: the frontend owns
// BOT_VENDOR_META (colours + display names), and duplicating that whole map server-side would
// give two answers to "what is this bot called".
function vendorBrand(kind: AutomatedReviewerKind, login: string): string {
  if (kind === 'in_house' || kind === 'vendor' || kind === 'pierre') return login;
  return kind
    .split('_')
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ');
}

// ── THE ONE BUCKET FOLD — the tile↔list consistency mechanism ───────────────────────────────
// The strip's tile numbers are NOT SQL counts and cannot be. `categories` is a JSON column in
// both dialects, so "is this praise?" has no portable SQL predicate, and neither does "did this
// row's severity coerce?". The only way a drill-down's `total` can BE a tile's number rather
// than merely agree with it is for both to run the identical scan and then the identical fold,
// so the fold lives here, once, and every caller goes through it. A new bucket rule goes in this
// function or nowhere.
//
// THE ORDER IS LOAD-BEARING and must never be re-spelled: severity coercion FIRST — a row whose
// severity is unreadable belongs to NO bucket, counting in `labelled` (the raw scan length) and
// in nothing else, exactly as the `continue` at the top of every fold loop did — then `isSummary`,
// then praise.
// ⚠ isSummary BEFORE praise means a praise-flavoured walkthrough is a SUMMARY, which is the
// OPPOSITE of the frontend's `pillOf` display helper. That is deliberate, and it is why no count
// on these screens may be re-derived client-side: the numbers are the server's.
export type MlFoldBucket = 'summary' | 'praise' | 'finding';

export interface FoldedMlRow {
  bucket: MlFoldBucket;
  severity: MlSeverity;
  categories: MlCategory[];
}

/** null = this row's severity could not be coerced, so it belongs to none of the three buckets. */
export function foldMlLabelRow(row: {
  severity: string | null;
  isSummary: boolean;
  categories: unknown;
}): FoldedMlRow | null {
  const severity = coerceSeverity(row.severity);
  if (!severity) return null;
  const categories = coerceCategories(row.categories);
  if (row.isSummary) return { bucket: 'summary', severity, categories };
  // v2 non-finding class: the bot acknowledging a fix / withdrawing a concern. Bucketed like
  // summaries — visible as labelled work, excluded from every severity-weighted number, because
  // it is not a finding.
  if (categories.includes('praise')) return { bucket: 'praise', severity, categories };
  return { bucket: 'finding', severity, categories };
}

// ── The WINDOWED per-bot label fold for getBotAnalytics ─────────────────────────────────────
// The merged Bots table shows ROI columns and severity columns on ONE row over ONE window, so
// this aggregates `ml_comment_labels` per author over the SAME [from, now] window the ROI math
// uses — `target_created_at` was stored precisely so this read needs no union back to the three
// polymorphic parents (and the (account, repo, author) index carries the scan). Exclusion
// semantics are getBotSeverityRollup's, VERBATIM: summaries and praise are labelled work but not
// findings, every rate divides by findings, and the vendor's own declared severity is never
// read. Same cap honesty too — newest-first ORDER BY plus a `truncated` flag.
//
// `pending` is the windowed twin of the rollup's: the same hasText/no-label predicate the
// candidate query uses, additionally bounded to the window, so the merged strip's "X of Y
// scored" is a statement about the window it sits over.
export interface MlVendorWindowAgg {
  labelled: number;
  findings: number;
  summaries: number;
  praise: number;
  high: number; // major + critical findings
  bySeverity: MlSeverityCounts; // findings-only
}

export interface MlWindowAggregates {
  byBot: Map<number, MlVendorWindowAgg>;
  totals: BotAnalyticsMlTotals;
}

export async function getMlWindowAggregates(
  accountId: number,
  scope: BotScope,
  automatedIds: number[],
  from: Date,
): Promise<MlWindowAggregates> {
  const emptyTotals: BotAnalyticsMlTotals = {
    labelled: 0,
    findings: 0,
    summaries: 0,
    praise: 0,
    pending: 0,
    unscorable: 0,
    bySeverity: emptySeverityCounts(),
    byCategory: [],
    backends: [],
    truncated: false,
  };
  if (scope.repoIds.length === 0 || automatedIds.length === 0) {
    return { byBot: new Map(), totals: emptyTotals };
  }

  const [labelRows, pending, unscorable] = await Promise.all([
    db
      .select({
        authorUserId: mlCommentLabels.authorUserId,
        severity: mlCommentLabels.severity,
        isSummary: mlCommentLabels.isSummary,
        categories: mlCommentLabels.categories,
        backend: mlCommentLabels.backend,
      })
      .from(mlCommentLabels)
      .where(
        and(
          eq(mlCommentLabels.accountId, accountId),
          inArray(mlCommentLabels.repoId, scope.repoIds),
          inArray(mlCommentLabels.authorUserId, automatedIds),
          gte(mlCommentLabels.targetCreatedAt, from),
        ),
      )
      .orderBy(desc(mlCommentLabels.targetCreatedAt), desc(mlCommentLabels.id))
      .limit(ROLLUP_SCAN_CAP)
      .execute(),
    countUnlabelledBotText(accountId, scope, automatedIds, from),
    // NOT window-bounded on purpose: the NULL-body population is legacy by nature (the
    // 2026-06 lean-storage window) and mostly sits OUTSIDE every rolling window — a windowed
    // count would read 0 while badges are visibly missing from the very lists this strip
    // sits above. This is the honesty channel getBotSeverityRollup carries; when the merged
    // table retired that response's panel, the count has to live HERE or the Bots screen
    // claims "N of N scored" over comments it can never score.
    countUnscorableBotText(accountId, scope, automatedIds),
  ]);

  const byBot = new Map<number, MlVendorWindowAgg>();
  const totalsBySeverity = emptySeverityCounts();
  const totalsByCategory = new Map<MlCategory, number>();
  const backends = new Set<string>();
  let findings = 0;
  let summaries = 0;
  let praise = 0;

  for (const row of labelRows) {
    // ⚠ Through `foldMlLabelRow`, NEVER a local re-spelling of the three branches: the flagging
    // drill-down slices this same scan with this same fold, and a second copy of the order here
    // is exactly how the tile and the list it opens would drift apart.
    const folded = foldMlLabelRow(row);
    if (!folded) continue;
    if (row.backend) backends.add(row.backend);
    let acc = byBot.get(row.authorUserId);
    if (!acc) {
      acc = {
        labelled: 0,
        findings: 0,
        summaries: 0,
        praise: 0,
        high: 0,
        bySeverity: emptySeverityCounts(),
      };
      byBot.set(row.authorUserId, acc);
    }
    acc.labelled += 1;
    if (folded.bucket === 'summary') {
      acc.summaries += 1;
      summaries += 1;
    } else if (folded.bucket === 'praise') {
      acc.praise += 1;
      praise += 1;
    } else {
      // ⚠ FINDINGS-ONLY, inside this branch — the same phantom-gap rule as the rollup: counting
      // a walkthrough's severity while every rate divides by `findings` lets a share top 100%.
      acc.findings += 1;
      findings += 1;
      acc.bySeverity[folded.severity] += 1;
      totalsBySeverity[folded.severity] += 1;
      if (folded.severity === 'major' || folded.severity === 'critical') acc.high += 1;
      for (const c of folded.categories) {
        totalsByCategory.set(c, (totalsByCategory.get(c) ?? 0) + 1);
      }
    }
  }

  return {
    byBot,
    totals: {
      labelled: labelRows.length,
      findings,
      summaries,
      praise,
      pending,
      unscorable,
      bySeverity: totalsBySeverity,
      byCategory: [...totalsByCategory.entries()]
        .map(([category, count]) => ({ category, count }))
        .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category)),
      backends: [...backends].sort(),
      truncated: labelRows.length >= ROLLUP_SCAN_CAP,
    },
  };
}

// ── The label rows behind the Behaviour tab's severity/category charts ──────────────────────
// A DELIBERATELY RAW read, unlike every fold above it: the Behaviour tab needs the same rows
// bucketed two ways at once (flat over the selected window, weekly over the 84-day trend span),
// and those week boundaries are computed in getBotBehaviourAnalytics from ITS trendFrom. Folding
// here would mean either re-deriving that arithmetic in a second place — the one thing that would
// make the new charts' x-axis silently disagree with the density chart's — or passing the bucket
// function in, which is a worse seam than handing back rows.
//
// Coercion is NOT skipped, though: severity/categories go through the same coercions the wire
// reads use, so an unreadable severity drops the row (there is nothing to count) and an
// unreadable vendor claim degrades to "no claim", never to ours.
export interface MlBehaviourLabelRow {
  authorUserId: number;
  severity: MlSeverity;
  /** The bot's OWN declared badge. Display-only, by hard invariant — see MlLabel.vendorSeverity. */
  vendorSeverity: MlSeverity | null;
  categories: MlCategory[];
  isSummary: boolean;
  targetCreatedAtMs: number;
}

export async function listMlLabelsForBehaviour(
  accountId: number,
  scope: BotScope,
  automatedIds: number[],
  from: Date,
  to: Date,
): Promise<{ rows: MlBehaviourLabelRow[]; truncated: boolean }> {
  if (scope.repoIds.length === 0 || automatedIds.length === 0) {
    return { rows: [], truncated: false };
  }
  // Newest-first + a cap, then `truncated` — the ROLLUP_SCAN_CAP contract: a capped scan needs an
  // ORDER BY or the sample differs run to run (heap order flips on Postgres after an UPDATE), and
  // it has to SAY it was capped rather than present a sample as a total.
  const raw = await db
    .select({
      authorUserId: mlCommentLabels.authorUserId,
      severity: mlCommentLabels.severity,
      vendorSeverity: mlCommentLabels.vendorSeverity,
      categories: mlCommentLabels.categories,
      isSummary: mlCommentLabels.isSummary,
      targetCreatedAt: mlCommentLabels.targetCreatedAt,
    })
    .from(mlCommentLabels)
    .where(
      and(
        eq(mlCommentLabels.accountId, accountId),
        inArray(mlCommentLabels.repoId, scope.repoIds),
        inArray(mlCommentLabels.authorUserId, automatedIds),
        gte(mlCommentLabels.targetCreatedAt, from),
        lte(mlCommentLabels.targetCreatedAt, to),
      ),
    )
    .orderBy(desc(mlCommentLabels.targetCreatedAt), desc(mlCommentLabels.id))
    .limit(ROLLUP_SCAN_CAP)
    .execute();

  const rows: MlBehaviourLabelRow[] = [];
  for (const r of raw) {
    const severity = coerceSeverity(r.severity);
    if (!severity) continue;
    rows.push({
      authorUserId: r.authorUserId,
      severity,
      vendorSeverity: coerceSeverity(r.vendorSeverity),
      categories: coerceCategories(r.categories),
      isSummary: r.isSummary,
      targetCreatedAtMs: r.targetCreatedAt.getTime(),
    });
  }
  return { rows, truncated: raw.length >= ROLLUP_SCAN_CAP };
}

// ── The per-REVIEWER comments drill-down (GET /api/bot-analytics/vendor/:key/comments) ──────
// Everything one automated reviewer SAID in the window — inline review comments (path + thread
// state), issue-level PR comments, and non-empty review bodies — each row carrying its stored
// ML label INLINE via a LEFT JOIN on (account_id, target_kind, target_id). One response serves
// the whole list: a cross-PR list must never mount the per-PR label index per row.
//
// Deliberately a NEW query rather than a re-export of getBotReviewComments: that row shape is
// re-declared verbatim in packages/pro/src/bot-themes/build.ts (open-core lockstep) and it is
// role:'review' by design, while this drill-down must also serve quality_check-roled rows —
// mirroring getBotVendorPrs, whose quality-check section offers the same drill-down.
//
// The 'pierre' sentinel answers EMPTY: its verbatim reviews are posted with the human's token
// (per-review provenance), so there are no attributable per-comment rows to list — the same
// reasoning as its getBotVendorPrs special case, minus the review-join it uses for PR rows.
const BOT_VENDOR_COMMENT_CAP = 3000; // most-recent rows per source (the themes-funnel precedent)

interface JoinedLabelCols {
  mlSeverity: string | null;
  mlSeverityOrd: number | null;
  mlSeverityProb: number | null;
  mlVendorSeverity: string | null;
  mlVendorSeverityConfidence: string | null;
  mlCategories: string[] | null;
  mlIsSummary: boolean | null;
  mlBackend: string | null;
  mlModelVersion: string | null;
  mlCreatedAt: Date | null;
}

// The left-joined label columns → a wire MlLabel, or null when the target has no label row.
// Coercions mirror toWireLabel: an unreadable severity drops the LABEL (not the comment row),
// an unreadable vendor claim degrades to "no vendor claim".
function inlineLabel(
  targetKind: MlLabelTargetKind,
  targetId: number,
  r: JoinedLabelCols,
): MlLabel | null {
  const severity = coerceSeverity(r.mlSeverity);
  if (!severity || r.mlSeverityOrd == null || r.mlSeverityProb == null) return null;
  return {
    targetKind,
    targetId,
    severity,
    severityOrd: r.mlSeverityOrd,
    severityProb: r.mlSeverityProb,
    vendorSeverity: coerceSeverity(r.mlVendorSeverity),
    vendorSeverityConfidence: coerceVendorConfidence(r.mlVendorSeverityConfidence),
    categories: coerceCategories(r.mlCategories),
    isSummary: r.mlIsSummary ?? false,
    backend: r.mlBackend ?? '',
    modelVersion: r.mlModelVersion ?? '',
    createdAt: (r.mlCreatedAt ?? new Date(0)).toISOString(),
  };
}

export async function getBotVendorComments(
  accountId: number,
  target: { userId: number } | { kind: 'pierre' },
  window: BotWindowKind,
  // The SAME BotScope the ROI row was computed at — this list reproduces one of that panel's
  // rows, so it takes the identical workspace + repo narrowing.
  scope: BotScope,
): Promise<BotVendorCommentsResponse> {
  const nowMs = Date.now();
  const to = new Date(nowMs);
  // The one shared window→duration mapping (db/bot-window.ts) — same window as the ROI row.
  const from = new Date(nowMs - botWindowMs(window));
  const win = { kind: window, from: from.toISOString(), to: to.toISOString() };
  const generatedAt = to.toISOString();

  if ('kind' in target) {
    return {
      enabled: true,
      key: 'pierre',
      kind: 'pierre',
      label: labelForKind('pierre'),
      login: null,
      window: win,
      comments: [],
      truncated: false,
      generatedAt,
    };
  }

  const userId = target.userId;
  const key = `u${userId}`;
  // NOT role-filtered — mirrors getBotVendorPrs: the quality-check section of the ROI panel
  // offers the same drill-down.
  const kindMap = await classificationKindForUser(accountId, scope.workspaceId);
  if (!kindMap.has(userId)) {
    // An id this workspace has NOT classified as automated identifies NOTHING. The users
    // table is GLOBAL — resolving login/displayName for an arbitrary numeric id here
    // would hand any tenant a cross-account login-enumeration oracle, exactly what the
    // /api/users/:id/stats precedent exists to prevent (counts only, no profile fields).
    // The key is the caller's own input; the label degrades to it; login stays null.
    return {
      enabled: true, key, kind: 'in_house', label: key, login: null, window: win,
      comments: [], truncated: false, generatedAt,
    };
  }
  const kindTyped: AutomatedReviewerKind = kindMap.get(userId) ?? 'in_house';
  // Identity mirrors getBotVendorPrs / getBotAnalytics.reviewerLabel exactly: the workspace's
  // custom label → the vendor's pretty name (known vendors) → login/display name. Safe to
  // read the global row HERE: the classification row above proves the account association.
  const classLabel = await classificationLabelMap(accountId, scope.workspaceId);
  const [userRow] = await db
    .select({ login: users.githubLogin, name: users.displayName })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
    .execute();
  const login = userRow?.login ?? null;
  const custom = classLabel.get(userId);
  let label: string;
  if (custom) label = custom;
  else if (kindTyped !== 'in_house' && kindTyped !== 'pierre' && kindTyped !== 'vendor')
    label = labelForKind(kindTyped);
  else label = userRow?.name?.trim() || login || key;

  const empty: BotVendorCommentsResponse = {
    enabled: true, key, kind: kindTyped, label, login, window: win,
    comments: [], truncated: false, generatedAt,
  };
  if (scope.repoIds.length === 0) return empty;

  const mlCols = {
    mlSeverity: mlCommentLabels.severity,
    mlSeverityOrd: mlCommentLabels.severityOrd,
    mlSeverityProb: mlCommentLabels.severityProb,
    mlVendorSeverity: mlCommentLabels.vendorSeverity,
    mlVendorSeverityConfidence: mlCommentLabels.vendorSeverityConfidence,
    mlCategories: mlCommentLabels.categories,
    mlIsSummary: mlCommentLabels.isSummary,
    mlBackend: mlCommentLabels.backend,
    mlModelVersion: mlCommentLabels.modelVersion,
    mlCreatedAt: mlCommentLabels.createdAt,
  };

  // Inline review-thread comments (carry the thread's path + derivedState).
  const rcRows = await db
    .select({
      targetId: reviewComments.id,
      prId: reviewComments.prId,
      prNumber: pullRequests.number,
      prTitle: pullRequests.title,
      prAuthorId: pullRequests.authorId,
      repoId: pullRequests.repoId,
      owner: repos.owner,
      name: repos.name,
      body: reviewComments.body,
      createdAt: reviewComments.createdAt,
      path: reviewThreads.path,
      derivedState: reviewThreads.derivedState,
      threadId: reviewComments.threadId,
      ...mlCols,
    })
    .from(reviewComments)
    .innerJoin(pullRequests, eq(pullRequests.id, reviewComments.prId))
    .innerJoin(repos, eq(repos.id, pullRequests.repoId))
    .leftJoin(reviewThreads, eq(reviewThreads.id, reviewComments.threadId))
    .leftJoin(
      mlCommentLabels,
      and(
        eq(mlCommentLabels.accountId, accountId),
        eq(mlCommentLabels.targetKind, 'review_comment'),
        eq(mlCommentLabels.targetId, reviewComments.id),
      ),
    )
    .where(
      and(
        eq(pullRequests.accountId, accountId),
        inArray(pullRequests.repoId, scope.repoIds),
        eq(reviewComments.authorId, userId),
        gte(reviewComments.createdAt, from),
        lte(reviewComments.createdAt, to),
      ),
    )
    .orderBy(desc(reviewComments.createdAt))
    .limit(BOT_VENDOR_COMMENT_CAP)
    .execute();

  // Issue-level PR comments (no path / thread state).
  const pcRows = await db
    .select({
      targetId: prComments.id,
      prId: prComments.prId,
      prNumber: pullRequests.number,
      prTitle: pullRequests.title,
      prAuthorId: pullRequests.authorId,
      repoId: pullRequests.repoId,
      owner: repos.owner,
      name: repos.name,
      body: prComments.body,
      createdAt: prComments.createdAt,
      ...mlCols,
    })
    .from(prComments)
    .innerJoin(pullRequests, eq(pullRequests.id, prComments.prId))
    .innerJoin(repos, eq(repos.id, pullRequests.repoId))
    .leftJoin(
      mlCommentLabels,
      and(
        eq(mlCommentLabels.accountId, accountId),
        eq(mlCommentLabels.targetKind, 'pr_comment'),
        eq(mlCommentLabels.targetId, prComments.id),
      ),
    )
    .where(
      and(
        eq(pullRequests.accountId, accountId),
        inArray(pullRequests.repoId, scope.repoIds),
        eq(prComments.authorId, userId),
        gte(prComments.createdAt, from),
        lte(prComments.createdAt, to),
      ),
    )
    .orderBy(desc(prComments.createdAt))
    .limit(BOT_VENDOR_COMMENT_CAP)
    .execute();

  // Review BODIES with real text only (`hasText` — an approval with no comment is an
  // empty-string body, and 5.4k empty rows are not things the bot "said"). Matches the label
  // corpus: the candidate query applies the same predicate, so every row here is labellable.
  const rvRows = await db
    .select({
      targetId: reviews.id,
      prId: reviews.prId,
      prNumber: pullRequests.number,
      prTitle: pullRequests.title,
      prAuthorId: pullRequests.authorId,
      repoId: pullRequests.repoId,
      owner: repos.owner,
      name: repos.name,
      body: reviews.body,
      createdAt: reviews.submittedAt,
      ...mlCols,
    })
    .from(reviews)
    .innerJoin(pullRequests, eq(pullRequests.id, reviews.prId))
    .innerJoin(repos, eq(repos.id, pullRequests.repoId))
    .leftJoin(
      mlCommentLabels,
      and(
        eq(mlCommentLabels.accountId, accountId),
        eq(mlCommentLabels.targetKind, 'review'),
        eq(mlCommentLabels.targetId, reviews.id),
      ),
    )
    .where(
      and(
        eq(pullRequests.accountId, accountId),
        inArray(pullRequests.repoId, scope.repoIds),
        eq(reviews.authorId, userId),
        isNotNull(reviews.body),
        hasText(reviews.body),
        gte(reviews.submittedAt, from),
        lte(reviews.submittedAt, to),
      ),
    )
    .orderBy(desc(reviews.submittedAt))
    .limit(BOT_VENDOR_COMMENT_CAP)
    .execute();

  const toIso = (d: Date | number | null): string => {
    if (d == null) return new Date(0).toISOString();
    if (d instanceof Date) return d.toISOString();
    const ms = Number(d) > 1e12 ? Number(d) : Number(d) * 1000;
    return new Date(ms).toISOString();
  };

  const out: BotVendorComment[] = [];
  for (const r of rcRows) {
    out.push({
      targetKind: 'review_comment',
      targetId: r.targetId,
      prId: r.prId,
      prNumber: r.prNumber,
      prTitle: r.prTitle,
      prAuthorId: r.prAuthorId ?? null,
      repoId: r.repoId,
      repoFullName: `${r.owner}/${r.name}`,
      path: r.path ?? null,
      threadId: r.threadId ?? null,
      derivedState: r.derivedState ?? null,
      body: r.body,
      createdAt: toIso(r.createdAt),
      mlLabel: inlineLabel('review_comment', r.targetId, r),
    });
  }
  for (const r of pcRows) {
    out.push({
      targetKind: 'pr_comment',
      targetId: r.targetId,
      prId: r.prId,
      prNumber: r.prNumber,
      prTitle: r.prTitle,
      prAuthorId: r.prAuthorId ?? null,
      repoId: r.repoId,
      repoFullName: `${r.owner}/${r.name}`,
      path: null,
      threadId: null,
      derivedState: null,
      body: r.body,
      createdAt: toIso(r.createdAt),
      mlLabel: inlineLabel('pr_comment', r.targetId, r),
    });
  }
  for (const r of rvRows) {
    out.push({
      targetKind: 'review',
      targetId: r.targetId,
      prId: r.prId,
      prNumber: r.prNumber,
      prTitle: r.prTitle,
      prAuthorId: r.prAuthorId ?? null,
      repoId: r.repoId,
      repoFullName: `${r.owner}/${r.name}`,
      path: null,
      threadId: null,
      derivedState: null,
      body: r.body,
      createdAt: toIso(r.createdAt),
      mlLabel: inlineLabel('review', r.targetId, r),
    });
  }
  // Newest-first, capped combined — `truncated` when either a source hit its own cap or the
  // combined stream overflowed (the getBotReviewComments rule).
  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  const truncated =
    rcRows.length >= BOT_VENDOR_COMMENT_CAP ||
    pcRows.length >= BOT_VENDOR_COMMENT_CAP ||
    rvRows.length >= BOT_VENDOR_COMMENT_CAP ||
    out.length > BOT_VENDOR_COMMENT_CAP;
  return {
    enabled: true, key, kind: kindTyped, label, login, window: win,
    comments: out.slice(0, BOT_VENDOR_COMMENT_CAP), truncated, generatedAt,
  };
}

/**
 * The two disjoint populations of unlabelled bot rows, split by ONE body predicate over one
 * shared query shape so their union and boundary cannot drift:
 *
 *   - `unlabelled` — text the worker WILL pick up next: the same `isNotNull` + `hasText` +
 *     no-label-row predicate the candidate query uses. This is `pending`.
 *   - `unscorable` — rows whose body was never STORED (`body IS NULL`): synced during the
 *     lean-storage window and never repaired, because incremental sync only re-walks PRs whose
 *     GitHub `updatedAt` moves. There is no text to classify, so the candidate query cannot see
 *     them — counting them as pending would spin the scoring indicator on work nothing will ever
 *     drain, and NOT counting them anywhere reported 100% coverage with badges missing. They are
 *     repairable (hydration write-back, `pnpm ml:backfill-bodies`), at which point they MOVE
 *     into `pending` — honest, even though the jump looks alarming.
 */
type UnlabelledBodyMode = 'unlabelled' | 'unscorable';

async function countBotText(
  accountId: number,
  scope: BotScope,
  automatedIds: number[],
  mode: UnlabelledBodyMode,
  // Optional window floor on the SOURCE row's own timestamp (createdAt / submittedAt) — the
  // windowed ROI fold's coverage statement must be about the window it sits over. Absent =
  // the whole corpus, exactly as before.
  from?: Date,
): Promise<number> {
  if (scope.repoIds.length === 0 || automatedIds.length === 0) return 0;
  const n = sql<number>`count(*)`;
  const bodyPredicate = (col: AnyColumn) =>
    mode === 'unlabelled' ? and(isNotNull(col), hasText(col)) : isNull(col);
  const windowed = (col: AnyColumn) => (from ? [gte(col, from)] : []);

  const [rc, pc, rv] = await Promise.all([
    db
      .select({ n })
      .from(reviewComments)
      .innerJoin(pullRequests, eq(pullRequests.id, reviewComments.prId))
      .leftJoin(
        mlCommentLabels,
        and(
          eq(mlCommentLabels.accountId, accountId),
          eq(mlCommentLabels.targetKind, 'review_comment'),
          eq(mlCommentLabels.targetId, reviewComments.id),
        ),
      )
      .where(
        and(
          eq(pullRequests.accountId, accountId),
          inArray(pullRequests.repoId, scope.repoIds),
          isNotNull(reviewComments.authorId),
          inArray(reviewComments.authorId, automatedIds),
          bodyPredicate(reviewComments.body),
          isNull(mlCommentLabels.id),
          ...windowed(reviewComments.createdAt),
        ),
      )
      .execute(),
    db
      .select({ n })
      .from(prComments)
      .innerJoin(pullRequests, eq(pullRequests.id, prComments.prId))
      .leftJoin(
        mlCommentLabels,
        and(
          eq(mlCommentLabels.accountId, accountId),
          eq(mlCommentLabels.targetKind, 'pr_comment'),
          eq(mlCommentLabels.targetId, prComments.id),
        ),
      )
      .where(
        and(
          eq(pullRequests.accountId, accountId),
          inArray(pullRequests.repoId, scope.repoIds),
          isNotNull(prComments.authorId),
          inArray(prComments.authorId, automatedIds),
          bodyPredicate(prComments.body),
          isNull(mlCommentLabels.id),
          ...windowed(prComments.createdAt),
        ),
      )
      .execute(),
    db
      .select({ n })
      .from(reviews)
      .innerJoin(pullRequests, eq(pullRequests.id, reviews.prId))
      .leftJoin(
        mlCommentLabels,
        and(
          eq(mlCommentLabels.accountId, accountId),
          eq(mlCommentLabels.targetKind, 'review'),
          eq(mlCommentLabels.targetId, reviews.id),
        ),
      )
      .where(
        and(
          eq(pullRequests.accountId, accountId),
          inArray(pullRequests.repoId, scope.repoIds),
          isNotNull(reviews.authorId),
          inArray(reviews.authorId, automatedIds),
          bodyPredicate(reviews.body),
          isNull(mlCommentLabels.id),
          ...windowed(reviews.submittedAt),
        ),
      )
      .execute(),
  ]);

  return Number(rc[0]?.n ?? 0) + Number(pc[0]?.n ?? 0) + Number(rv[0]?.n ?? 0);
}

/**
 * How much bot text in scope is still waiting for a label. Three counts with the same
 * left-join-is-null predicate the candidate query uses, so "pending" and "what the worker will
 * pick up next" cannot drift apart. Optional `from` bounds the count to a window (the ROI fold).
 */
async function countUnlabelledBotText(
  accountId: number,
  scope: BotScope,
  automatedIds: number[],
  from?: Date,
): Promise<number> {
  return countBotText(accountId, scope, automatedIds, 'unlabelled', from);
}

/** How much bot text in scope can NEVER be labelled as stored — see `UnlabelledBodyMode`. */
async function countUnscorableBotText(
  accountId: number,
  scope: BotScope,
  automatedIds: number[],
): Promise<number> {
  return countBotText(accountId, scope, automatedIds, 'unscorable');
}

/**
 * The PRs in scope still carrying bot-authored NULL-body targets — the worklist for
 * `pnpm ml:backfill-bodies` (scripts/backfill-null-bodies.ts). Same bot set and the same
 * NULL-body predicate as `countUnscorableBotText`, so the script repairs exactly the
 * population that count reports.
 */
export async function listNullBodyBotPrIds(
  accountId: number,
  scope: BotScope,
  automatedIds: number[],
): Promise<number[]> {
  if (scope.repoIds.length === 0 || automatedIds.length === 0) return [];

  const prIdsFor = (
    kind: MlLabelTargetKind,
    table: typeof reviewComments | typeof prComments | typeof reviews,
  ) =>
    db
      .selectDistinct({ prId: table.prId })
      .from(table)
      .innerJoin(pullRequests, eq(pullRequests.id, table.prId))
      .leftJoin(
        mlCommentLabels,
        and(
          eq(mlCommentLabels.accountId, accountId),
          eq(mlCommentLabels.targetKind, kind),
          eq(mlCommentLabels.targetId, table.id),
        ),
      )
      .where(
        and(
          eq(pullRequests.accountId, accountId),
          inArray(pullRequests.repoId, scope.repoIds),
          isNotNull(table.authorId),
          inArray(table.authorId, automatedIds),
          isNull(table.body),
          isNull(mlCommentLabels.id),
        ),
      )
      .execute();

  const [rc, pc, rv] = await Promise.all([
    prIdsFor('review_comment', reviewComments),
    prIdsFor('pr_comment', prComments),
    prIdsFor('review', reviews),
  ]);
  return [...new Set([...rc, ...pc, ...rv].map((r) => r.prId))];
}

export interface MlBacklog {
  /** Bot text across EVERY workspace of the account that carries no label yet. */
  pending: number;
  /** Bot rows with NO stored body — never pending, never a candidate. See `UnlabelledBodyMode`. */
  unscorable: number;
  /** Labels already stored for the account. */
  labelled: number;
}

/**
 * The account's whole enrichment backlog — what `GET /api/ml-status` reports so a sync surface
 * can keep showing activity until the labels exist, instead of announcing "complete" the moment
 * the GitHub walk ends and leaving the model calls unrepresented.
 *
 * ACCOUNT-WIDE, NOT WORKSPACE-SCOPED, because that is the worker's own grain: a tick walks every
 * workspace of every active account. Scoping this to the selected workspace would under-report
 * exactly the work that is running and let the indicator go quiet while the CPU is busy.
 *
 * Cost: one bot-set resolve plus three indexed counts PER WORKSPACE, and they share the same
 * left-join-is-null predicate as `listMlCandidates`, so "pending" and "what the worker will pick
 * up next" cannot drift. That is not free, which is why the route in front of it caches — see
 * the TTL note there. Workspaces are walked serially rather than with `Promise.all` so a
 * many-workspace account cannot open 4×N connections at once on a poll.
 */
export async function getMlBacklogForAccount(accountId: number): Promise<MlBacklog> {
  const workspaces = await listWorkspaces(accountId);
  let pending = 0;
  let unscorable = 0;
  for (const ws of workspaces) {
    if (ws.repoIds.length === 0) continue;
    const scope: BotScope = { workspaceId: ws.id, repoIds: ws.repoIds };
    const automatedIds = await automatedReviewerUserIds(accountId, ws.id, 'all');
    if (automatedIds.length === 0) continue;
    pending += await countUnlabelledBotText(accountId, scope, automatedIds);
    unscorable += await countUnscorableBotText(accountId, scope, automatedIds);
  }

  const labelledRows = await db
    .select({ n: sql<number>`count(*)` })
    .from(mlCommentLabels)
    .where(eq(mlCommentLabels.accountId, accountId))
    .execute();

  return { pending, unscorable, labelled: Number(labelledRows[0]?.n ?? 0) };
}

// ── "What the bots are flagging" — the drill-down behind the ML totals strip ─────────────────
//
// Every tile and chip on the Bots rail's ML strip opens this ONE getter with a different
// selector, and the contract is that the list's `total` IS the tile's number — not a second,
// independently-derived count that happens to agree today.
//
// That rules out the obvious implementation. A `count(*) … WHERE severity = 'nit'` can never
// equal the "Nits" tile: it counts summaries and praise, it cannot express praise at all (a JSON
// column in both dialects), it ignores `coerceSeverity` failures, and it ignores ROLLUP_SCAN_CAP's
// newest-first truncation. So this getter re-runs the STRIP'S OWN scan — byte-identical WHERE /
// ORDER BY / LIMIT, only the select list widens — re-folds it through the shared
// `foldMlLabelRow`, and slices the result. Pagination is therefore an OFFSET INTO THE FOLDED
// IN-MEMORY POPULATION, behind an opaque `o:<n>` cursor so a later keyset switch is not a wire
// break; keyset pagination is the wrong tool here because it cannot reproduce a count only JS
// can compute.
//
// Cost is bounded the same way the strip's is: one capped label scan, then hydration of the
// PAGE ONLY (≤50 rows) — never of the population.
const FLAGGING_PAGE_MAX = 50;

// The matrix axes, worst-first, mirroring the shared `ML_SEVERITIES` order with `'none'` (the bot
// declared nothing) appended to the vendor axis. Local copies because `@pierre-review/shared` is
// a TYPES-ONLY dependency of the backend — the release build greps `release/dist` and fails on a
// real import — the same local-copy rule `REASON_PRIORITY` follows in queries.ts.
// ⚠ Two severity orders live in this codebase (`ML_SEVERITIES` worst-first, the Bots panel's
// `SEVERITY_COLUMNS` ascending). Flipping one axis silently transposes every cell, so the order
// is pinned here and the client looks cells up by (vendor, ours) rather than by position.
const MATRIX_VENDOR_AXIS: VendorSeverityAxis[] = ['critical', 'major', 'minor', 'nit', 'none'];
const MATRIX_OURS_AXIS: MlSeverity[] = ['critical', 'major', 'minor', 'nit'];

/**
 * OUR severity as a 0..3 ordinal — `SEVERITY_KEYS` is stored ascending, so its INDEX is the
 * ordinal, the same 0..3 the shared `ML_SEVERITY_ORD` map spells out for the frontend. Re-derived
 * here rather than imported for the types-only reason above.
 *
 * ⚠ Used ONLY to say which way a vendor's claim differs from ours. It never orders, seeds,
 * corrects or falls back OUR severity — see MlLabel.vendorSeverity.
 */
function severityOrdinal(s: MlSeverity): number {
  return SEVERITY_KEYS.indexOf(s);
}

/** Which way the bot's claim differs from ours. `'agree'` is not a disagreement direction. */
export type VendorAgreementDirection = 'agree' | 'over' | 'under';

/**
 * THE ours-vs-vendor direction rule, in ONE place.
 *
 * `null` = the bot declared nothing, which is SILENCE, not conflict — it lands in the matrix's
 * 'none' column and in neither `agree` nor either disagreement counter. That is what keeps
 * `agree + overCall + underCall === declared` true, and it is the property every caption on
 * these screens leans on.
 *
 * Exported because three surfaces now ask the same question — the confusion matrix, the
 * flagging drill-down's `disagree` refinement, and the Behaviour tab's per-bot inflation index
 * (`getBotBehaviourAnalytics`) — and a fourth hand-spelled `>` is exactly how two numbers that
 * must agree come to differ by one row with nothing failing.
 *
 * ⚠ Used ONLY to say which way the two differ. The vendor's badge never orders, seeds, corrects
 * or falls back OUR severity — see MlLabel.vendorSeverity (0.474 vs 0.700 exact).
 */
export function vendorAgreementOf(
  vendor: MlSeverity | null,
  ours: MlSeverity,
): VendorAgreementDirection | null {
  if (vendor == null) return null;
  if (vendor === ours) return 'agree';
  return severityOrdinal(vendor) > severityOrdinal(ours) ? 'over' : 'under';
}

function emptyAgreementMatrix(): SeverityAgreementMatrix {
  return {
    // Dense 5×4: a zero cell is PRESENT, not omitted — the grid renders every combination, and
    // an absent cell would read as "no data here" rather than "they never disagreed this way".
    cells: MATRIX_VENDOR_AXIS.flatMap((vendor) =>
      MATRIX_OURS_AXIS.map((ours) => ({ vendor, ours, count: 0 })),
    ),
    declared: 0,
    undeclared: 0,
    agree: 0,
    overCall: 0,
    underCall: 0,
    total: 0,
  };
}

/**
 * The ours-vs-vendor confusion matrix over a population.
 *
 * ⚠ A DISPLAY OF TWO CLAIMS, NEVER A RECONCILIATION. The vendor badge scores 0.474 exact against
 * our 0.700 on the adjudicated gold-300, so it is here to show WHERE the two differ and nothing
 * more: it does not enter a selector predicate, `total`, or the fold.
 */
function buildAgreementMatrix(
  rows: Array<{ vendor: MlSeverity | null; ours: MlSeverity }>,
): SeverityAgreementMatrix {
  const counts = new Map<string, number>();
  let declared = 0;
  let agree = 0;
  let overCall = 0;
  let underCall = 0;
  for (const r of rows) {
    const axis: VendorSeverityAxis = r.vendor ?? 'none';
    const key = `${axis}|${r.ours}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    // A null vendor claim is UNDECLARED — it lands in the 'none' column and in NEITHER agreement
    // nor disagreement. Silence is not a conflict, and `agree + over + under === declared` is the
    // property that keeps the caption honest. (`vendorAgreementOf` is the one direction rule.)
    const dir = vendorAgreementOf(r.vendor, r.ours);
    if (dir == null) continue;
    declared += 1;
    if (dir === 'agree') agree += 1;
    else if (dir === 'over') overCall += 1;
    else underCall += 1;
  }
  return {
    cells: MATRIX_VENDOR_AXIS.flatMap((vendor) =>
      MATRIX_OURS_AXIS.map((ours) => ({
        vendor,
        ours,
        count: counts.get(`${vendor}|${ours}`) ?? 0,
      })),
    ),
    declared,
    undeclared: rows.length - declared,
    agree,
    overCall,
    underCall,
    total: rows.length,
  };
}

/**
 * Does this folded row belong to the tile that was clicked?
 *
 * ⚠ `severity` and `category` gate on `bucket === 'finding'` because the strip increments
 * `bySeverity`/`byCategory` ONLY inside its finding branch (a walkthrough's severity is never
 * counted, and a walkthrough's categories are an artefact of the marker parser reading a summary
 * table). Dropping either gate makes the list overshoot the tile it opened from.
 *
 * ⚠ NOTHING HERE READS `vendorSeverity`. The bot's own badge is display-only; a selector that
 * consulted it would let the less accurate of the two labels decide which rows are "high
 * severity", which is precisely what MlLabel.vendorSeverity forbids.
 */
function matchesFlaggingSelector(
  selector: Exclude<BotFlaggingSelector, { kind: 'overlap' }>,
  fold: FoldedMlRow,
): boolean {
  switch (selector.kind) {
    case 'findings':
      return fold.bucket === 'finding';
    case 'summaries':
      return fold.bucket === 'summary';
    case 'severity':
      return fold.bucket === 'finding' && selector.severities.includes(fold.severity);
    case 'category':
      // ⚠ PRAISE IS ITS OWN BUCKET, NOT A FINDING CATEGORY — the one arm where the obvious
      // spelling is unsatisfiable. `foldMlLabelRow` tests `isSummary` then praise then finding,
      // so a praise row NEVER carries `bucket === 'finding'`; asking for `category:'praise'`
      // under the finding gate matches nothing, for every input, forever.
      //
      // It stayed invisible while the only source of category selectors was the strip's chips,
      // which come from `byCategory` — incremented solely inside the FINDING branch, so praise
      // can never appear there. The drill-down's severity picker offers Praise directly (it sits
      // beside the four severities, the `SEVERITY_PILLS` precedent), which made the dead arm
      // reachable: the option reads "Praise · 55" from the analytics fold while the list it opens
      // is empty — a control that looks broken, which is the exact failure this codebase has
      // already paid for once with the CI-failure lens.
      return selector.category === 'praise'
        ? fold.bucket === 'praise'
        : fold.bucket === 'finding' && fold.categories.includes(selector.category);
  }
}

/**
 * The refinement the matrix / direction toggle / per-bot bar applies AFTER the selector has
 * fixed `total`.
 *
 * ⚠ `authorUserIds` narrows the LIST, never the matrix — the matrix is built over the selector
 * population pre-refine (phase 3 below) so a cell cannot zero out the cell that was clicked, and
 * a bot narrowing is no different: drilling into one bot must not silently redraw the grid the
 * click came from. `filteredTotal` is what describes the narrowed list.
 *
 * ⚠ `[]` MEANS "NO BOTS", NOT "EVERY BOT" — the `repoIds` rule. The gate is on the list being
 * PRESENT (`!= null`), never on its length, so a caller that computed an empty bot set gets an
 * empty page rather than the whole workspace under a caption promising a subset.
 */
function matchesFlaggingRefine(
  refine: BotFlaggingRefine,
  vendor: MlSeverity | null,
  ours: MlSeverity,
  authorUserId: number,
): boolean {
  // `includes` over an array of at most one entry per automated reviewer in the workspace — a
  // per-call Set would allocate once per scanned row for a membership test of ~10 numbers.
  if (refine.authorUserIds != null && !refine.authorUserIds.includes(authorUserId)) return false;
  if (refine.cell) {
    if ((vendor ?? 'none') !== refine.cell.vendor) return false;
    if (ours !== refine.cell.ours) return false;
  }
  if (refine.disagree) {
    // Undeclared is not a disagreement (see buildAgreementMatrix); `'any'` takes either
    // direction. One shared classifier, so this predicate and the matrix cannot drift.
    const dir = vendorAgreementOf(vendor, ours);
    if (dir == null || dir === 'agree') return false;
    if (refine.disagree !== 'any' && dir !== refine.disagree) return false;
  }
  return true;
}

// The scan columns the page assembly needs, beyond what the fold consumes. Declared rather than
// inferred so the hydration helper below has a name to take.
interface FlaggingScanRow {
  targetKind: MlLabelTargetKind;
  targetId: number;
  authorUserId: number;
  severityOrd: number;
  severityProb: number;
  vendorSeverity: string | null;
  vendorSeverityConfidence: string | null;
  isSummary: boolean;
  backend: string;
  modelVersion: string;
  createdAt: Date;
}

type FlaggingPageRow = { row: FlaggingScanRow; fold: FoldedMlRow };

// One hydrated parent row, normalised across the three id spaces so the assembly loop has one
// shape to read. PR comments and review bodies carry no path/line/thread state at all.
interface FlaggingParentRow {
  prId: number;
  prNumber: number;
  prTitle: string;
  prAuthorId: number | null;
  repoId: number;
  repoFullName: string;
  path: string | null;
  line: number | null;
  threadId: number | null;
  derivedState: DerivedState | null;
  body: string | null;
  createdAt: Date;
}

/**
 * Hydrate ONE PAGE (≤50 rows) into wire cards: four small parent selects, one `users` select and
 * the two identity maps. Never called with the population.
 *
 * ⚠ Every parent WHERE carries `eq(pullRequests.accountId, accountId)` and
 * `inArray(pullRequests.repoId, scope.repoIds)` even though these ids came from an
 * already-scoped scan. The tenancy predicate is not optional because the input was trusted —
 * that is how an id list stops being an existence oracle in every code path, not just the ones
 * whose caller remembered.
 */
async function hydrateFlaggingPage(
  accountId: number,
  scope: BotScope,
  pageRows: FlaggingPageRow[],
): Promise<BotFlaggingComment[]> {
  if (pageRows.length === 0) return [];

  const idsFor = (kind: MlLabelTargetKind) =>
    pageRows.filter((p) => p.row.targetKind === kind).map((p) => p.row.targetId);
  const rcIds = idsFor('review_comment');
  const pcIds = idsFor('pr_comment');
  const rvIds = idsFor('review');
  const authorIds = [...new Set(pageRows.map((p) => p.row.authorUserId))];

  const [rcRows, pcRows, rvRows, userRows, kindMap, classLabel] = await Promise.all([
    rcIds.length > 0
      ? db
          .select({
            targetId: reviewComments.id,
            prId: reviewComments.prId,
            prNumber: pullRequests.number,
            prTitle: pullRequests.title,
            prAuthorId: pullRequests.authorId,
            repoId: pullRequests.repoId,
            owner: repos.owner,
            name: repos.name,
            body: reviewComments.body,
            createdAt: reviewComments.createdAt,
            threadId: reviewComments.threadId,
            path: reviewThreads.path,
            line: reviewThreads.line,
            derivedState: reviewThreads.derivedState,
          })
          .from(reviewComments)
          .innerJoin(pullRequests, eq(pullRequests.id, reviewComments.prId))
          .innerJoin(repos, eq(repos.id, pullRequests.repoId))
          // LEFT, as everywhere else: a comment whose thread row is missing still renders, just
          // without a path/line/state.
          .leftJoin(reviewThreads, eq(reviewThreads.id, reviewComments.threadId))
          .where(
            and(
              eq(pullRequests.accountId, accountId),
              inArray(pullRequests.repoId, scope.repoIds),
              inArray(reviewComments.id, rcIds),
            ),
          )
          .execute()
      : [],
    pcIds.length > 0
      ? db
          .select({
            targetId: prComments.id,
            prId: prComments.prId,
            prNumber: pullRequests.number,
            prTitle: pullRequests.title,
            prAuthorId: pullRequests.authorId,
            repoId: pullRequests.repoId,
            owner: repos.owner,
            name: repos.name,
            body: prComments.body,
            createdAt: prComments.createdAt,
          })
          .from(prComments)
          .innerJoin(pullRequests, eq(pullRequests.id, prComments.prId))
          .innerJoin(repos, eq(repos.id, pullRequests.repoId))
          .where(
            and(
              eq(pullRequests.accountId, accountId),
              inArray(pullRequests.repoId, scope.repoIds),
              inArray(prComments.id, pcIds),
            ),
          )
          .execute()
      : [],
    rvIds.length > 0
      ? db
          .select({
            targetId: reviews.id,
            prId: reviews.prId,
            prNumber: pullRequests.number,
            prTitle: pullRequests.title,
            prAuthorId: pullRequests.authorId,
            repoId: pullRequests.repoId,
            owner: repos.owner,
            name: repos.name,
            body: reviews.body,
            createdAt: reviews.submittedAt,
          })
          .from(reviews)
          .innerJoin(pullRequests, eq(pullRequests.id, reviews.prId))
          .innerJoin(repos, eq(repos.id, pullRequests.repoId))
          .where(
            and(
              eq(pullRequests.accountId, accountId),
              inArray(pullRequests.repoId, scope.repoIds),
              inArray(reviews.id, rvIds),
              // ⚠ NO TEXT PREDICATE HERE, and that is load-bearing rather than an omission.
              // It is tempting to mirror the candidate query's `isNotNull(body) + hasText(body)`
              // "so the two corpora are provably identical" — but they are NOT identical, because
              // the two halves move independently: comment/review bodies are RE-UPSERTED on every
              // sync walk, while a label is written once and never re-scored. A review whose body
              // GitHub later returns empty therefore keeps a label that was computed from real
              // text (its `body_hash` is not the hash of '').
              //
              // `total` comes from the label scan, which never joins a parent. So a text predicate
              // here silently subtracts rows the tile counted — measured on this repo's own dev DB:
              // workspace 8 / rolling_30 reported total 792 but could only ever hydrate 782, and
              // the FIRST page rendered 19 cards under a caption reading 20. That is exactly the
              // tile↔list drift `foldMlLabelRow` and the byte-identical scan exist to prevent,
              // arriving through hydration instead of through the count.
              //
              // The row is kept and rendered with a null body (the card says the text is gone),
              // which is honest and keeps the list able to reach its tile.
            ),
          )
          .execute()
      : [],
    authorIds.length > 0
      ? db
          .select({ id: users.id, login: users.githubLogin, name: users.displayName })
          .from(users)
          .where(inArray(users.id, authorIds))
          .execute()
      : [],
    classificationKindForUser(accountId, scope.workspaceId),
    classificationLabelMap(accountId, scope.workspaceId),
  ]);

  const parents = new Map<string, FlaggingParentRow>();
  for (const r of rcRows) {
    parents.set(`review_comment:${r.targetId}`, {
      prId: r.prId,
      prNumber: r.prNumber,
      prTitle: r.prTitle,
      prAuthorId: r.prAuthorId ?? null,
      repoId: r.repoId,
      repoFullName: `${r.owner}/${r.name}`,
      path: r.path ?? null,
      line: r.line ?? null,
      threadId: r.threadId ?? null,
      derivedState: r.derivedState ?? null,
      body: r.body,
      createdAt: r.createdAt,
    });
  }
  // PR comments and review bodies share one parent shape, so one loop serves both.
  interface FlatParentRow {
    targetId: number;
    prId: number;
    prNumber: number;
    prTitle: string;
    prAuthorId: number | null;
    repoId: number;
    owner: string;
    name: string;
    body: string | null;
    createdAt: Date;
  }
  const pushFlat = (kind: MlLabelTargetKind, rows: FlatParentRow[]) => {
    for (const r of rows) {
      parents.set(`${kind}:${r.targetId}`, {
        prId: r.prId,
        prNumber: r.prNumber,
        prTitle: r.prTitle,
        prAuthorId: r.prAuthorId ?? null,
        repoId: r.repoId,
        repoFullName: `${r.owner}/${r.name}`,
        path: null,
        line: null,
        threadId: null,
        derivedState: null,
        body: r.body,
        createdAt: r.createdAt,
      });
    }
  };
  pushFlat('pr_comment', pcRows);
  pushFlat('review', rvRows);

  // Identity: the workspace's custom label → the vendor's pretty name → display name/login —
  // getBotAnalytics' `reviewerLabel` precedence verbatim, so one bot reads with one name across
  // the whole Bots interface.
  const displayById = new Map<number, string>();
  const loginById = new Map<number, string | null>();
  for (const u of userRows) {
    displayById.set(u.id, u.name?.trim() || u.login || `#${u.id}`);
    loginById.set(u.id, u.login || null);
  }
  const reviewerLabel = (userId: number, kind: AutomatedReviewerKind): string => {
    const custom = classLabel.get(userId);
    if (custom) return custom;
    if (kind !== 'in_house' && kind !== 'pierre' && kind !== 'vendor') return labelForKind(kind);
    return displayById.get(userId) ?? labelForKind(kind);
  };

  const items: BotFlaggingComment[] = [];
  for (const { row, fold } of pageRows) {
    const parent = parents.get(`${row.targetKind}:${row.targetId}`);
    // A label whose parent row is gone is DROPPED from the page but stays counted in
    // `total`/`filteredTotal` — the same tolerance getBotVendorComments has, and the honest one:
    // re-deriving the count from what hydrated would put the list back out of step with the tile
    // it was opened from, which is the whole thing this getter exists to prevent.
    if (!parent) continue;
    const kind: AutomatedReviewerKind = kindMap.get(row.authorUserId) ?? 'in_house';
    items.push({
      targetKind: row.targetKind,
      targetId: row.targetId,
      prId: parent.prId,
      prNumber: parent.prNumber,
      prTitle: parent.prTitle,
      prAuthorId: parent.prAuthorId,
      repoId: parent.repoId,
      repoFullName: parent.repoFullName,
      path: parent.path,
      threadId: parent.threadId,
      derivedState: parent.derivedState,
      // Whitespace-only collapses to null so the card can tell "GitHub no longer returns this
      // text" apart from a body it simply hasn't been handed. Reachable because bodies are
      // re-upserted every walk while labels are never re-scored — see the hydration note above.
      body: parent.body && parent.body.trim() !== '' ? parent.body : null,
      createdAt: parent.createdAt.toISOString(),
      // Inline, never a per-card fetch: this list spans many PRs, so the per-PR
      // ['ml-labels', prId] index could not serve it (the ThreadAssessment
      // 60-requests-for-60-empty-boxes rule). Severity and categories come from the FOLD, so the
      // badge and the bucket that admitted the row can never disagree.
      mlLabel: {
        targetKind: row.targetKind,
        targetId: row.targetId,
        severity: fold.severity,
        severityOrd: row.severityOrd,
        severityProb: row.severityProb,
        vendorSeverity: coerceSeverity(row.vendorSeverity),
        vendorSeverityConfidence: coerceVendorConfidence(row.vendorSeverityConfidence),
        categories: fold.categories,
        isSummary: row.isSummary,
        backend: row.backend,
        modelVersion: row.modelVersion,
        createdAt: row.createdAt.toISOString(),
      },
      authorUserId: row.authorUserId,
      authorLogin: loginById.get(row.authorUserId) ?? null,
      authorLabel: reviewerLabel(row.authorUserId, kind),
      authorKind: kind,
      line: parent.line,
      // The PR, deliberately not a per-comment permalink: `review_threads` has no `url` column
      // and the numeric REST comment id is not stored, so a fabricated anchor would 404.
      prUrl: `https://github.com/${parent.repoFullName}/pull/${parent.prNumber}`,
    });
  }
  return items;
}

export async function getBotFlaggingComments(
  accountId: number,
  selector: Exclude<BotFlaggingSelector, { kind: 'overlap' }>,
  refine: BotFlaggingRefine,
  window: BotWindowKind,
  // ⚠ The SAME BotScope the strip was computed at — this list reproduces one of that strip's
  // tiles, so it takes the identical workspace + repo narrowing. `repoIds: []` is a real empty
  // workspace, never "widen to the account".
  scope: BotScope,
  page: { offset: number; limit: number },
): Promise<BotFlaggingCommentsResponse> {
  const nowMs = Date.now();
  const to = new Date(nowMs);
  // The one shared window→duration mapping (db/bot-window.ts) — the same `from` getBotAnalytics
  // hands getMlWindowAggregates, which is what makes the two scans the same scan.
  const from = new Date(nowMs - botWindowMs(window));
  const win = { kind: window, from: from.toISOString(), to: to.toISOString() };
  const generatedAt = to.toISOString();
  const offset = Math.max(0, Math.trunc(page.offset));
  const limit = Math.max(1, Math.min(Math.trunc(page.limit), FLAGGING_PAGE_MAX));

  const empty: BotFlaggingCommentsResponse = {
    kind: 'comments',
    workspaceId: scope.workspaceId,
    window: win,
    selector,
    refine,
    total: 0,
    filteredTotal: 0,
    matrix: emptyAgreementMatrix(),
    items: [],
    nextCursor: null,
    truncated: false,
    generatedAt,
  };
  if (scope.repoIds.length === 0) return empty;
  // `'all'`, not `'review'` — the strip counts quality checks too, and a drill-down that narrowed
  // the bot set would list fewer rows than the tile it opened from.
  const automatedIds = await automatedReviewerUserIds(accountId, scope.workspaceId, 'all');
  if (automatedIds.length === 0) return empty;

  // ── Phase 1: the population scan ─────────────────────────────────────────────────────────
  // ⚠ WHERE / ORDER BY / LIMIT are byte-identical to getMlWindowAggregates' scan; ONLY the select
  // list widens. That identity — same rows, same order, same cap — plus the shared fold below is
  // the entire reason `total` equals the tile rather than approximating it.
  const labelRows = await db
    .select({
      // What the fold consumes …
      authorUserId: mlCommentLabels.authorUserId,
      severity: mlCommentLabels.severity,
      isSummary: mlCommentLabels.isSummary,
      categories: mlCommentLabels.categories,
      backend: mlCommentLabels.backend,
      // … and what a CARD needs on top of it.
      id: mlCommentLabels.id,
      targetKind: mlCommentLabels.targetKind,
      targetId: mlCommentLabels.targetId,
      severityOrd: mlCommentLabels.severityOrd,
      severityProb: mlCommentLabels.severityProb,
      vendorSeverity: mlCommentLabels.vendorSeverity,
      vendorSeverityConfidence: mlCommentLabels.vendorSeverityConfidence,
      modelVersion: mlCommentLabels.modelVersion,
      createdAt: mlCommentLabels.createdAt,
    })
    .from(mlCommentLabels)
    .where(
      and(
        eq(mlCommentLabels.accountId, accountId),
        inArray(mlCommentLabels.repoId, scope.repoIds),
        inArray(mlCommentLabels.authorUserId, automatedIds),
        gte(mlCommentLabels.targetCreatedAt, from),
      ),
    )
    .orderBy(desc(mlCommentLabels.targetCreatedAt), desc(mlCommentLabels.id))
    .limit(ROLLUP_SCAN_CAP)
    .execute();

  // ── Phase 2: the shared fold, then the selector predicate ────────────────────────────────
  const selected: FlaggingPageRow[] = [];
  for (const row of labelRows) {
    const fold = foldMlLabelRow(row);
    if (!fold) continue;
    if (!matchesFlaggingSelector(selector, fold)) continue;
    selected.push({ row, fold });
  }

  // ── Phase 3: the matrix, over the SELECTOR population and PRE-refine ─────────────────────
  // Computed before the refinement so clicking a cell cannot zero out the cell that was clicked
  // — the commentFacetCounts / ConsolidatedFeedResponse.counts rule.
  const matrix = buildAgreementMatrix(
    selected.map(({ row, fold }) => ({
      vendor: coerceSeverity(row.vendorSeverity),
      ours: fold.severity,
    })),
  );

  // ── Phase 4: refine, then slice ──────────────────────────────────────────────────────────
  const narrowed = selected.filter(({ row, fold }) =>
    matchesFlaggingRefine(
      refine,
      coerceSeverity(row.vendorSeverity),
      fold.severity,
      row.authorUserId,
    ),
  );
  const pageRows = narrowed.slice(offset, offset + limit);
  const consumed = offset + pageRows.length;

  // ── Phase 5: hydrate the page only ───────────────────────────────────────────────────────
  const items = await hydrateFlaggingPage(accountId, scope, pageRows);

  return {
    kind: 'comments',
    workspaceId: scope.workspaceId,
    window: win,
    selector,
    refine,
    total: selected.length,
    filteredTotal: narrowed.length,
    matrix,
    items,
    // Opaque on the wire; `o:<n>` is today's encoding of "offset into the folded population".
    nextCursor: consumed < narrowed.length ? `o:${consumed}` : null,
    // The same honesty rule as ROLLUP_SCAN_CAP everywhere else: a capped scan says so rather than
    // presenting a most-recent sample as a total.
    truncated: labelRows.length >= ROLLUP_SCAN_CAP,
    generatedAt,
  };
}
