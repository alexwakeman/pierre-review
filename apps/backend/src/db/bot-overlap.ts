// ── "Same-line overlap" drill-down — the CLUSTER half of the bot-flagging drill-down ────────
//
// The Bots rail's ML strip ends with a "Same-line overlap" tile: how many line areas more than
// one bot flagged. This file is what happens when it is clicked. Everything else the strip
// drills into is an ML LABEL population (db/ml-labels.ts, `getBotFlaggingComments`); this tile
// alone is DETERMINISTIC — no model, no severity — so it lives here and answers a different
// item shape (`BotFlaggingClustersResponse`).
//
// ⚠ THE ONE HARD REQUIREMENT: `total` must equal the tile. The tile is
// `getBotAnalytics().totals.overlapClusters`, computed in queries.ts by scanning the window's
// automated-reviewer threads, dropping three populations IN A FIXED ORDER, clustering them with
// the shared ±3-line arbiter and counting the groups with ≥2 DISTINCT bots. Every one of those
// steps is reproduced below, in that order, from the same tables — the ONLY intended difference
// is that the scan reads `gte(createdAt, from)` directly instead of walking the wider 84-day
// trend span and re-filtering in JS (`from` is the same instant either way, so the two select
// the same rows). Get any one of the exclusions wrong and the tile says 34 while the list
// says 41; that is the whole failure mode this comment exists to prevent.
//
// ⚑ A SEPARATE FILE, not an addition to ml-labels.ts: this needs `reviewerRoleForUser`, which
// ml-labels.ts does not import, and adding it there would deepen the deliberate
// queries ⇄ ml-labels module cycle. Nothing imports this file back, so no new cycle.
import { and, eq, gte, inArray } from 'drizzle-orm';
import type {
  AddressedConfidence,
  AutomatedReviewerKind,
  BotFlaggingCluster,
  BotFlaggingClusterMember,
  BotFlaggingClustersResponse,
  BotFlaggingComment,
  BotFlaggingRefine,
  BotWindowKind,
  DerivedState,
  MlCategory,
  MlLabel,
  MlSeverity,
  MlVendorConfidence,
  SeverityAgreementMatrix,
  VendorSeverityAxis,
} from '@pierre-review/shared';
import { db, schema } from './client.js';
import { botWindowMs } from './bot-window.js';
import { clusterThreadsByLine } from './line-overlap.js';
import { labelFor as labelForKind } from '../sync/reviewer-classify.js';
import {
  automatedReviewerUserIds,
  classificationKindForUser,
  classificationLabelMap,
  reviewerRoleForUser,
  type BotScope,
} from './queries.js';

const { mlCommentLabels, pullRequests, repos, reviewComments, reviewThreads, users } = schema;

// Hydration bound. Clustering itself is free (the Bots panel already runs the strictly WIDER
// 84-day version of this scan on every load), so `total` is exact and uncapped; this caps only
// how many clusters get comment bodies + labels attached, and sets `truncated` when it bites.
const OVERLAP_CLUSTER_CAP = 2000;

// SQLite's bound-parameter ceiling is per statement, so every `inArray` over an unbounded id
// list is chunked (the db/retention.ts precedent).
const MAX_IN_PARAMS = 900;

// ⚠ LOCAL COPIES OF `ML_SEVERITY_ORD` / `ML_SEVERITIES` ON PURPOSE. Both exist as value exports
// in @pierre-review/shared, but the backend may import that package with `import type` ONLY —
// it is types-only and is NOT a shipped dependency, and `build-release.mjs` greps the emitted
// `release/dist` and FAILS the build on a surviving runtime import. ml-labels.ts's own
// `SEVERITY_KEYS` is the same accommodation. Keep these in step with the shared exports.
const SEVERITY_ORD: Record<MlSeverity, number> = { nit: 0, minor: 1, major: 2, critical: 3 };
const SEVERITY_AXIS: MlSeverity[] = ['critical', 'major', 'minor', 'nit']; // worst-first
const VENDOR_AXIS: VendorSeverityAxis[] = [...SEVERITY_AXIS, 'none'];

const SEVERITY_KEYS: MlSeverity[] = ['nit', 'minor', 'major', 'critical'];
const VENDOR_CONFIDENCE_KEYS: MlVendorConfidence[] = ['high', 'medium', 'low'];
const ML_CATEGORY_VALUES = new Set<string>([
  'correctness_bug',
  'security',
  'performance',
  'style_readability',
  'maintainability_refactor',
  'testing',
  'documentation',
  'nitpick',
  'praise',
]);

// ── Wire coercions, mirroring ml-labels.ts's `toWireLabel` ──────────────────────────────────
// Restated here because ml-labels.ts keeps its copies module-private. The drizzle `enum` on
// these columns is a COMPILE-TIME nicety, not a CHECK constraint, so an off-union stored value
// is representable: an unreadable severity drops the whole LABEL (the comment still renders,
// unbadged), while an unreadable vendor claim degrades to "no vendor claim" — the row's own
// severity is the useful one.
function coerceSeverity(raw: unknown): MlSeverity | null {
  return typeof raw === 'string' && (SEVERITY_KEYS as string[]).includes(raw)
    ? (raw as MlSeverity)
    : null;
}
function coerceVendorConfidence(raw: unknown): MlVendorConfidence | null {
  return typeof raw === 'string' && (VENDOR_CONFIDENCE_KEYS as string[]).includes(raw)
    ? (raw as MlVendorConfidence)
    : null;
}
function coerceCategories(raw: unknown): MlCategory[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((c): c is MlCategory => typeof c === 'string' && ML_CATEGORY_VALUES.has(c));
}

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/** Run one `inArray` query per parameter-safe batch and concatenate. Empty in ⇒ no query. */
async function inChunks<R>(
  ids: number[],
  run: (batch: number[]) => Promise<R[]>,
): Promise<R[]> {
  const out: R[] = [];
  for (const batch of chunk(ids, MAX_IN_PARAMS)) out.push(...(await run(batch)));
  return out;
}

// ── The ours-vs-vendor confusion matrix ─────────────────────────────────────────────────────
// ⚠ A DISPLAY OF TWO CLAIMS, NEVER A RECONCILIATION. `vendorSeverity` is materially LESS
// accurate than ours on the adjudicated gold-300 (0.474 exact vs 0.700), so it is shown beside
// ours and read by nothing else: it is not in the cluster predicate, not in `total`, and it
// never moves a badge. Direction is ordinal on BOTH sides — never "confidence", never
// `severityProb`.
function emptyMatrix(): SeverityAgreementMatrix {
  const cells: SeverityAgreementMatrix['cells'] = [];
  for (const vendor of VENDOR_AXIS)
    for (const ours of SEVERITY_AXIS) cells.push({ vendor, ours, count: 0 });
  return { cells, declared: 0, undeclared: 0, agree: 0, overCall: 0, underCall: 0, total: 0 };
}

function buildMatrix(labels: MlLabel[]): SeverityAgreementMatrix {
  const m = emptyMatrix();
  const index = new Map<string, { count: number }>();
  for (const c of m.cells) index.set(`${c.vendor}|${c.ours}`, c);
  for (const l of labels) {
    m.total += 1;
    const vendor: VendorSeverityAxis = l.vendorSeverity ?? 'none';
    const cell = index.get(`${vendor}|${l.severity}`);
    if (cell) cell.count += 1;
    if (l.vendorSeverity == null) {
      m.undeclared += 1;
      continue;
    }
    m.declared += 1;
    const theirs = SEVERITY_ORD[l.vendorSeverity];
    const ours = SEVERITY_ORD[l.severity];
    if (theirs === ours) m.agree += 1;
    else if (theirs > ours) m.overCall += 1;
    else m.underCall += 1;
  }
  return m;
}

/** Does one label satisfy `refine`? A target with NO label never matches a refinement. */
function labelMatchesRefine(label: MlLabel | undefined, refine: BotFlaggingRefine): boolean {
  if (!label) return false;
  if (refine.cell) {
    const vendor: VendorSeverityAxis = label.vendorSeverity ?? 'none';
    if (vendor !== refine.cell.vendor || label.severity !== refine.cell.ours) return false;
  }
  if (refine.disagree) {
    // An UNDECLARED vendor claim is not a disagreement — it is silence (the `undeclared`
    // column exists to say so).
    if (label.vendorSeverity == null || label.vendorSeverity === label.severity) return false;
    const theirs = SEVERITY_ORD[label.vendorSeverity];
    const ours = SEVERITY_ORD[label.severity];
    if (refine.disagree === 'over' && theirs <= ours) return false;
    if (refine.disagree === 'under' && theirs >= ours) return false;
  }
  return true;
}

// One windowed automated-reviewer thread. The first four fields ARE `LineOverlapItem` (the
// shared clustering contract); everything after them rides along so assembly needs no second
// read of the same rows.
interface OverlapThread {
  prId: number;
  path: string;
  line: number | null;
  userId: number;
  threadId: number;
  kind: AutomatedReviewerKind;
  derivedState: DerivedState;
  addressedConfidence: AddressedConfidence;
  prNumber: number;
  prTitle: string;
  prAuthorId: number | null;
  repoId: number;
  repoFullName: string;
}

// A cluster that passed the ≥2-distinct-bots gate, flattened so the total order below sorts on
// plain numbers (and so `lineStart` is a `number`, not the arbiter's `number | null`).
interface QualifyingCluster {
  prId: number;
  path: string;
  lineStart: number;
  lineEnd: number;
  bots: number;
  threadCount: number;
  items: OverlapThread[];
}

/**
 * The "Same-line overlap" tile's drill-down: the line areas more than one bot flagged, in the
 * SAME window and scope the tile was measured at, one card per cluster.
 *
 * `total` ≡ `getBotAnalytics(...).totals.overlapClusters` BY CONSTRUCTION — same thread
 * population, same three exclusions in the same order, same `clusterThreadsByLine` arbiter,
 * same `userIds.size >= 2` gate. Paging is a JS `slice` over that ordered list behind an opaque
 * cursor, so the count can never be a differently-derived number that happens to agree.
 */
export async function getBotOverlapClusters(
  accountId: number,
  refine: BotFlaggingRefine,
  window: BotWindowKind,
  // The SAME BotScope the strip was computed at — `workspaceId` decides who counts as a bot,
  // `repoIds` narrows which data is measured. `repoIds: []` = an empty workspace, never "widen".
  scope: BotScope,
  page: { offset: number; limit: number },
): Promise<BotFlaggingClustersResponse> {
  const nowMs = Date.now();
  const to = new Date(nowMs);
  // The one shared window→duration mapping (db/bot-window.ts) — the tile's own `from`.
  const from = new Date(nowMs - botWindowMs(window));
  const win = { kind: window, from: from.toISOString(), to: to.toISOString() };
  const generatedAt = to.toISOString();
  const offset = Math.max(0, page.offset);
  const limit = Math.max(1, page.limit);

  const empty = (): BotFlaggingClustersResponse => ({
    kind: 'clusters',
    workspaceId: scope.workspaceId,
    window: win,
    selector: { kind: 'overlap' },
    refine,
    total: 0,
    filteredTotal: 0,
    matrix: emptyMatrix(),
    items: [],
    nextCursor: null,
    truncated: false,
    generatedAt,
  });

  // An empty workspace → nothing to analyze (mirrors getBotAnalytics' two early exits).
  if (scope.repoIds.length === 0) return empty();
  // `role: 'all'` — the same set the tile counted from. The quality-check EXCLUSION happens
  // below, at the same point in the pipeline it happens in getBotAnalytics; narrowing here
  // instead would also change `classificationKindForUser`'s reach and is not the same filter.
  const automatedIds = await automatedReviewerUserIds(accountId, scope.workspaceId, 'all');
  if (automatedIds.length === 0) return empty();
  const kindMap = await classificationKindForUser(accountId, scope.workspaceId);
  const roleMap = await reviewerRoleForUser(accountId, scope.workspaceId);
  const classLabel = await classificationLabelMap(accountId, scope.workspaceId);

  // ── 1. The thread scan ────────────────────────────────────────────────────────────────────
  // getBotAnalytics' `threadRows`, with `from` in place of `trendFrom` (it re-filters to the
  // window in JS anyway) plus the PR/repo columns the cards need — carried HERE so the page
  // hydration below fetches bodies and nothing else. `line` lives on `review_threads` and
  // nowhere else: `review_comments` has no line columns, so overlap never computes from
  // comments.
  const threadRows = await db
    .select({
      id: reviewThreads.id,
      prId: reviewThreads.prId,
      userId: reviewThreads.originalCommenterId,
      path: reviewThreads.path,
      line: reviewThreads.line,
      state: reviewThreads.derivedState,
      addressedConfidence: reviewThreads.addressedConfidence,
      prNumber: pullRequests.number,
      prTitle: pullRequests.title,
      prAuthorId: pullRequests.authorId,
      repoId: pullRequests.repoId,
      owner: repos.owner,
      name: repos.name,
    })
    .from(reviewThreads)
    .innerJoin(pullRequests, eq(pullRequests.id, reviewThreads.prId))
    .innerJoin(repos, eq(repos.id, pullRequests.repoId))
    .where(
      and(
        eq(pullRequests.accountId, accountId),
        inArray(reviewThreads.originalCommenterId, automatedIds),
        gte(reviewThreads.createdAt, from),
        inArray(pullRequests.repoId, scope.repoIds),
      ),
    )
    .execute();

  // ── 2. The three exclusions, IN THE TILE'S ORDER ──────────────────────────────────────────
  // (a) a thread with no original commenter identifies no bot; (b) an id this workspace has not
  // classified as automated is not a bot HERE (identity is per workspace); (c) quality checks
  // are excluded from overlap on both sides — "SonarQube and CodeRabbit both hit line 42" is a
  // rule firing next to a judgement, not two reviewers agreeing.
  const threads: OverlapThread[] = [];
  for (const t of threadRows) {
    if (t.userId == null) continue;
    const kind = kindMap.get(t.userId);
    if (!kind) continue;
    if (roleMap.get(t.userId) === 'quality_check') continue;
    threads.push({
      prId: t.prId,
      path: t.path,
      line: t.line,
      userId: t.userId,
      threadId: t.id,
      kind,
      derivedState: t.state,
      addressedConfidence: t.addressedConfidence,
      prNumber: t.prNumber,
      prTitle: t.prTitle,
      prAuthorId: t.prAuthorId ?? null,
      repoId: t.repoId,
      repoFullName: `${t.owner}/${t.name}`,
    });
  }

  // Deterministic input order. The arbiter sorts by line internally and anchors on line VALUES,
  // so pre-sorting cannot move a thread between clusters — but among threads sharing a line the
  // stable sort preserves input order, which out of a join is not a promise. Sorting here is
  // what makes "this bot's FIRST thread in the cluster" (the representative below) the same
  // thread on every run and in both dialects.
  threads.sort(
    (a, b) =>
      a.prId - b.prId ||
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) ||
      (a.line ?? Number.MAX_SAFE_INTEGER) - (b.line ?? Number.MAX_SAFE_INTEGER) ||
      a.threadId - b.threadId,
  );

  // ── 3. THE shared ±3-line clustering (db/line-overlap.ts) ─────────────────────────────────
  // `nullLineGroup: false` and `userIds.size >= 2` are the tile's settings, not a choice made
  // here: a thread LOSES its line when it outdates, and a per-file null lump manufactures
  // overlap out of any two chatty bots.
  const qualifying: QualifyingCluster[] = [];
  for (const c of clusterThreadsByLine(threads, { nullLineGroup: false })) {
    if (c.userIds.size < 2) continue;
    // Never null with `nullLineGroup: false`; the guard is what narrows the type honestly.
    if (c.line == null) continue;
    let lineEnd = c.line;
    for (const t of c.items) if (t.line != null && t.line > lineEnd) lineEnd = t.line;
    qualifying.push({
      prId: c.prId,
      path: c.path,
      lineStart: c.line,
      lineEnd,
      bots: c.userIds.size,
      threadCount: c.items.length,
      items: c.items,
    });
  }
  // THE tile's number. Counted before the hydration cap below, so a capped page still reports
  // the honest total (with `truncated` saying the LIST is a sample).
  const total = qualifying.length;

  // ── 4. A TOTAL order ──────────────────────────────────────────────────────────────────────
  // Biggest dedup hit first, like the per-PR rollup — but that one sorts on two keys only and
  // is scoped to a single PR, so it leaves ties in DB order. A PAGED cross-PR list cannot: two
  // requests for the same page must return the same clusters, so the comparator runs all the
  // way down to a unique key.
  qualifying.sort(
    (a, b) =>
      b.bots - a.bots ||
      b.threadCount - a.threadCount ||
      a.prId - b.prId ||
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) ||
      a.lineStart - b.lineStart,
  );

  const truncated = qualifying.length > OVERLAP_CLUSTER_CAP;
  const capped = truncated ? qualifying.slice(0, OVERLAP_CLUSTER_CAP) : qualifying;
  if (capped.length === 0) return { ...empty(), total, truncated };

  // ── 5. Origin comment per member thread ───────────────────────────────────────────────────
  // The thread's OWN bot's earliest comment, ties broken on the LOWER id. Both halves matter:
  // without the author filter a human's reply can become the "origin", and without the id
  // tiebreak two comments sharing a timestamp resolve differently per dialect. (This is
  // getBotAnalytics' rule, NOT the per-PR dedup's excerpt pick, which has neither.)
  //
  // Fetched for every CAPPED cluster's threads, not just the page's, because the matrix below
  // describes the whole population the page is a window into. No bodies here — ids only.
  const memberThreadIds = [...new Set(capped.flatMap((c) => c.items.map((t) => t.threadId)))];
  const commentRows = await inChunks(memberThreadIds, (batch) =>
    db
      .select({
        id: reviewComments.id,
        threadId: reviewComments.threadId,
        authorId: reviewComments.authorId,
        createdAt: reviewComments.createdAt,
      })
      .from(reviewComments)
      .innerJoin(pullRequests, eq(pullRequests.id, reviewComments.prId))
      // The ids came from an already-scoped scan; the tenancy predicate is still not optional —
      // "the input was trusted" is how an IDOR gets written.
      .where(
        and(
          eq(pullRequests.accountId, accountId),
          inArray(pullRequests.repoId, scope.repoIds),
          inArray(reviewComments.threadId, batch),
        ),
      )
      .execute(),
  );
  const commentsByThread = new Map<number, { id: number; authorId: number | null; at: number }[]>();
  for (const r of commentRows) {
    const arr = commentsByThread.get(r.threadId) ?? [];
    arr.push({ id: r.id, authorId: r.authorId, at: r.createdAt.getTime() });
    commentsByThread.set(r.threadId, arr);
  }
  const botByThread = new Map<number, number>();
  for (const c of capped) for (const t of c.items) botByThread.set(t.threadId, t.userId);
  const originByThread = new Map<number, { id: number; createdAt: Date }>();
  for (const [threadId, comments] of commentsByThread) {
    const botId = botByThread.get(threadId);
    if (botId == null) continue;
    let origin: { id: number; at: number } | null = null;
    for (const c of comments) {
      if (c.authorId !== botId) continue;
      if (origin == null || c.at < origin.at || (c.at === origin.at && c.id < origin.id))
        origin = { id: c.id, at: c.at };
    }
    // A thread with no comment by its own author keeps no origin — the member still renders,
    // unbodied (`comment: null`).
    if (origin) originByThread.set(threadId, { id: origin.id, createdAt: new Date(origin.at) });
  }

  // ── 6. ML labels for those origin comments ────────────────────────────────────────────────
  // Shipped INLINE on each card (a cross-PR list must never mount the per-PR `['ml-labels',
  // prId]` index per row — that is the ThreadAssessment 60-requests-for-60-empty-boxes
  // failure), and folded into the matrix below.
  const originIds = [...new Set([...originByThread.values()].map((o) => o.id))];
  const labelRows = await inChunks(originIds, (batch) =>
    db
      .select({
        targetId: mlCommentLabels.targetId,
        severity: mlCommentLabels.severity,
        severityOrd: mlCommentLabels.severityOrd,
        severityProb: mlCommentLabels.severityProb,
        vendorSeverity: mlCommentLabels.vendorSeverity,
        vendorSeverityConfidence: mlCommentLabels.vendorSeverityConfidence,
        categories: mlCommentLabels.categories,
        isSummary: mlCommentLabels.isSummary,
        backend: mlCommentLabels.backend,
        modelVersion: mlCommentLabels.modelVersion,
        createdAt: mlCommentLabels.createdAt,
      })
      .from(mlCommentLabels)
      .where(
        and(
          eq(mlCommentLabels.accountId, accountId),
          // `targetId` lives in THREE id spaces — the kind is never optional on a lookup.
          eq(mlCommentLabels.targetKind, 'review_comment'),
          inArray(mlCommentLabels.targetId, batch),
        ),
      )
      .execute(),
  );
  const labelByCommentId = new Map<number, MlLabel>();
  for (const r of labelRows) {
    const severity = coerceSeverity(r.severity);
    if (!severity) continue;
    labelByCommentId.set(r.targetId, {
      targetKind: 'review_comment',
      targetId: r.targetId,
      severity,
      severityOrd: r.severityOrd,
      severityProb: r.severityProb,
      vendorSeverity: coerceSeverity(r.vendorSeverity),
      vendorSeverityConfidence: coerceVendorConfidence(r.vendorSeverityConfidence),
      categories: coerceCategories(r.categories),
      isSummary: r.isSummary,
      backend: r.backend,
      modelVersion: r.modelVersion,
      createdAt: r.createdAt.toISOString(),
    });
  }
  const labelForThread = (threadId: number): MlLabel | undefined => {
    const origin = originByThread.get(threadId);
    return origin ? labelByCommentId.get(origin.id) : undefined;
  };

  // ── 7. The matrix, PRE-refine ─────────────────────────────────────────────────────────────
  // Over every member thread's origin label, so a cell never zeroes itself out once clicked
  // (the commentFacetCounts rule). ⚠ Its `total` is the count of LABELLED origin comments, NOT
  // the cluster `total` above: a cluster is not an ML row, and only a labelled comment can be
  // placed on either axis. `declared`/`undeclared` state the sparsity honestly.
  const matrix = buildMatrix(
    capped.flatMap((c) =>
      c.items
        .map((t) => labelForThread(t.threadId))
        .filter((l): l is MlLabel => l !== undefined),
    ),
  );

  // ── 8. Refine → slice ─────────────────────────────────────────────────────────────────────
  // A cluster survives when ≥1 of its threads matches. (The wire member shape carries no
  // per-member "matched" flag, so a surviving cluster renders whole — the matching member is
  // recognisable from its own badge.)
  //
  // ⚠ `authorUserIds` (the per-bot narrowing) is a fact about the THREAD's author, not about a
  // label, so it is checked on `t.userId` and — on its own — must NOT acquire the "has a label"
  // requirement `labelMatchesRefine` imposes. A cluster whose members are unlabelled is still a
  // cluster those bots are in. Narrowing a CLUSTER list by a bot set keeps every other member on
  // the card on purpose: the card's whole subject is who else flagged the same lines.
  //
  // ⚠ `[]` MEANS "NO BOTS", NOT "EVERY BOT" — the `repoIds` rule. Both the member predicate and
  // the "is there a narrowing at all" gate test PRESENCE (`!= null`), never length, so an empty
  // set answers with an empty page instead of widening to the whole workspace.
  const memberMatches = (t: OverlapThread): boolean => {
    if (refine.authorUserIds != null && !refine.authorUserIds.includes(t.userId)) return false;
    if (!refine.cell && !refine.disagree) return true;
    return labelMatchesRefine(labelForThread(t.threadId), refine);
  };
  const narrowed =
    refine.cell || refine.disagree || refine.authorUserIds != null
      ? capped.filter((c) => c.items.some(memberMatches))
      : capped;
  // Describes the LIST being paged, so it counts the capped population: with `truncated` set it
  // is deliberately below `total`, which stays the tile's honest, uncapped number.
  const filteredTotal = narrowed.length;
  const pageClusters = narrowed.slice(offset, offset + limit);
  // `items.length > 0` is load-bearing: an offset PAST the end yields an empty page, and
  // `offset + 0 < filteredTotal` would then hand back a cursor pointing at the start again.
  const nextOffset = offset + pageClusters.length;
  const nextCursor =
    pageClusters.length > 0 && nextOffset < filteredTotal ? `o:${nextOffset}` : null;

  // ── 9. Collapse members, then hydrate the PAGE only ───────────────────────────────────────
  // One member per BOT (the per-PR dedup's rule): a verbose bot's 23 threads render as one ×23
  // pill, not 23 identical cards. Representative = that bot's first thread in cluster (line)
  // order, which the pre-sort above made deterministic.
  const collapsed = pageClusters.map((c) => {
    const byUser = new Map<number, OverlapThread[]>();
    for (const t of c.items) {
      const arr = byUser.get(t.userId) ?? [];
      arr.push(t);
      byUser.set(t.userId, arr);
    }
    return { cluster: c, byUser };
  });
  // Only the representative's comment is rendered, so only its body is fetched.
  const pageOriginIds = [
    ...new Set(
      collapsed.flatMap(({ byUser }) =>
        [...byUser.values()].flatMap((ts) => {
          const origin = originByThread.get(ts[0]!.threadId);
          return origin ? [origin.id] : [];
        }),
      ),
    ),
  ];
  const bodyByCommentId = new Map<number, string | null>();
  if (pageOriginIds.length > 0) {
    for (const r of await inChunks(pageOriginIds, (batch) =>
      db
        .select({ id: reviewComments.id, body: reviewComments.body })
        .from(reviewComments)
        .innerJoin(pullRequests, eq(pullRequests.id, reviewComments.prId))
        .where(
          and(
            eq(pullRequests.accountId, accountId),
            inArray(pullRequests.repoId, scope.repoIds),
            inArray(reviewComments.id, batch),
          ),
        )
        .execute(),
    ))
      bodyByCommentId.set(r.id, r.body);
  }

  // Author identity for the page's bots. Label preference mirrors getBotAnalytics'
  // `reviewerLabel` exactly: the workspace's custom label → the vendor's pretty name (known
  // vendors) → login/display name. Safe to read the GLOBAL users row here — the classification
  // above proves the account association.
  const pageUserIds = [...new Set(collapsed.flatMap(({ byUser }) => [...byUser.keys()]))];
  const displayById = new Map<number, string>();
  const loginById = new Map<number, string>();
  for (const r of await inChunks(pageUserIds, (batch) =>
    db
      .select({ id: users.id, login: users.githubLogin, name: users.displayName })
      .from(users)
      .where(inArray(users.id, batch))
      .execute(),
  )) {
    displayById.set(r.id, r.name?.trim() || r.login || `#${r.id}`);
    if (r.login) loginById.set(r.id, r.login);
  }
  const reviewerLabel = (userId: number, kind: AutomatedReviewerKind): string => {
    const custom = classLabel.get(userId);
    if (custom) return custom;
    if (kind !== 'in_house' && kind !== 'pierre' && kind !== 'vendor') return labelForKind(kind);
    return displayById.get(userId) ?? labelForKind(kind);
  };

  const items: BotFlaggingCluster[] = collapsed.map(({ cluster, byUser }) => {
    const head = cluster.items[0]!;
    const prUrl = `https://github.com/${head.repoFullName}/pull/${head.prNumber}`;
    const members: BotFlaggingClusterMember[] = [...byUser.values()].map((ts) => {
      const rep = ts[0]!;
      const origin = originByThread.get(rep.threadId);
      const comment: BotFlaggingComment | null = origin
        ? {
            targetKind: 'review_comment',
            targetId: origin.id,
            prId: rep.prId,
            prNumber: rep.prNumber,
            prTitle: rep.prTitle,
            prAuthorId: rep.prAuthorId,
            repoId: rep.repoId,
            repoFullName: rep.repoFullName,
            path: rep.path,
            threadId: rep.threadId,
            derivedState: rep.derivedState,
            // A body row that vanished between the two reads leaves the card unbodied rather
            // than dropping the member — the thread's own metadata is still true.
            body: bodyByCommentId.get(origin.id) ?? null,
            createdAt: origin.createdAt.toISOString(),
            mlLabel: labelByCommentId.get(origin.id) ?? null,
            authorUserId: rep.userId,
            authorLogin: loginById.get(rep.userId) ?? null,
            authorLabel: reviewerLabel(rep.userId, rep.kind),
            authorKind: rep.kind,
            line: rep.line,
            prUrl,
          }
        : null;
      return {
        threadId: rep.threadId,
        threadIds: ts.map((t) => t.threadId),
        line: rep.line,
        derivedState: rep.derivedState,
        addressedConfidence: rep.addressedConfidence,
        comment,
      };
    });
    return {
      // Opaque, equality only — and keyed on `prId`, never a bare PR number (numbers are unique
      // per REPO, so a bare number cross-links one repo's #12 onto another's).
      clusterId: `${cluster.prId}:${cluster.lineStart}:${cluster.path}`,
      prId: cluster.prId,
      prNumber: head.prNumber,
      prTitle: head.prTitle,
      prAuthorId: head.prAuthorId,
      repoId: head.repoId,
      repoFullName: head.repoFullName,
      prUrl,
      path: cluster.path,
      lineStart: cluster.lineStart,
      lineEnd: cluster.lineEnd,
      members,
      threadCount: members.reduce((n, m) => n + m.threadIds.length, 0),
    };
  });

  return {
    kind: 'clusters',
    workspaceId: scope.workspaceId,
    window: win,
    selector: { kind: 'overlap' },
    refine,
    total,
    filteredTotal,
    matrix,
    items,
    nextCursor,
    truncated,
    generatedAt,
  };
}
