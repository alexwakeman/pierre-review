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
  BotSeverityResponse,
  BotVendorComment,
  BotVendorCommentsResponse,
  BotWindowKind,
  MlBotSeverityRow,
  MlCategory,
  MlLabel,
  MlLabelTargetKind,
  MlSeverity,
  MlSeverityCounts,
  MlVendorConfidence,
} from '@pierre-review/shared';
import { db, schema } from './client.js';
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
    bySeverity: emptySeverityCounts(),
    byCategory: [],
    backends: [],
    truncated: false,
  };
  if (scope.repoIds.length === 0 || automatedIds.length === 0) {
    return { byBot: new Map(), totals: emptyTotals };
  }

  const [labelRows, pending] = await Promise.all([
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
  ]);

  const byBot = new Map<number, MlVendorWindowAgg>();
  const totalsBySeverity = emptySeverityCounts();
  const totalsByCategory = new Map<MlCategory, number>();
  const backends = new Set<string>();
  let findings = 0;
  let summaries = 0;
  let praise = 0;

  for (const row of labelRows) {
    const severity = coerceSeverity(row.severity);
    if (!severity) continue;
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
    const categories = coerceCategories(row.categories);
    if (row.isSummary) {
      acc.summaries += 1;
      summaries += 1;
    } else if (categories.includes('praise')) {
      acc.praise += 1;
      praise += 1;
    } else {
      // ⚠ FINDINGS-ONLY, inside this branch — the same phantom-gap rule as the rollup: counting
      // a walkthrough's severity while every rate divides by `findings` lets a share top 100%.
      acc.findings += 1;
      findings += 1;
      acc.bySeverity[severity] += 1;
      totalsBySeverity[severity] += 1;
      if (severity === 'major' || severity === 'critical') acc.high += 1;
      for (const c of categories) {
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
      bySeverity: totalsBySeverity,
      byCategory: [...totalsByCategory.entries()]
        .map(([category, count]) => ({ category, count }))
        .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category)),
      backends: [...backends].sort(),
      truncated: labelRows.length >= ROLLUP_SCAN_CAP,
    },
  };
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
  // Same window→days mapping as getBotAnalytics (rolling_7=7, rolling_30=30, else — incl. sprint — 14).
  const windowDays = window === 'rolling_7' ? 7 : window === 'rolling_30' ? 30 : 14;
  const from = new Date(nowMs - windowDays * 86_400_000);
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
  // offers the same drill-down. Only a reviewer this account has CLASSIFIED as automated is a
  // valid target; an arbitrary userId echoes its identity but lists nothing.
  const kindMap = await classificationKindForUser(accountId, scope.workspaceId);
  const kindTyped: AutomatedReviewerKind = kindMap.get(userId) ?? 'in_house';
  // Identity mirrors getBotVendorPrs / getBotAnalytics.reviewerLabel exactly: the workspace's
  // custom label → the vendor's pretty name (known vendors) → login/display name.
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
  if (scope.repoIds.length === 0 || !kindMap.has(userId)) return empty;

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
