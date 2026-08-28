// ── The work plan's CODE-DERIVED EVIDENCE (CORE, deterministic, no AI) ───────────────────────
//
// "What should I work on today", for ONE workspace, as a ranked worklist. The Pro plugin narrates
// it; NOTHING here is model-touched. Every figure, id, link and rank in `WorkPlanEvidence` is
// computed by this file, and the model may only foreground, order and annotate what it is handed.
//
// ── WHY THIS FILE CALLS `getWorkspaceInsights` INSTEAD OF DERIVING ANYTHING ──────────────────
// THE BRIEF SAYS HOW MUCH. THE PLAN SAYS IN WHAT ORDER. THEY ARE ONE POPULATION.
//
// The daily-brief strip sits directly above this panel and counts the cards of ONE fold —
// `getWorkspaceInsights(accountId, undefined, scope)`, which is also what `GET /api/attention`
// serves. So ALL SEVEN of this plan's signals are read off THOSE CARDS, never re-derived:
// re-deriving "an untouched thread" here would be a second predicate, and the day it disagreed
// with the strip the user would be looking at two numbers for one population. `counts` below
// travels on the wire precisely so that agreement is ASSERTABLE (work-plan.test.ts asserts it
// field-by-field against `computeBriefCounts`) rather than hoped for.
//
// ⚠ THE COUNT LOOP AT THE BOTTOM OF `foldCounts` IS A SECOND SPELLING OF db/daily-brief.ts's.
// It is deliberately IDENTICAL, predicate for predicate — `personal` for the personal subset, NOT
// `relevance`, exactly as the brief does it. If you change one, change the other, and the
// alignment test is what makes forgetting fail rather than ship.
//
// ── ALL SEVEN SIGNALS ARE NOW CARD-DERIVED ──────────────────────────────────────────────────
// "This can land right now" and "GitHub is refusing until you update the branch" USED to come from
// a standalone open-PR query in this file — which made the ranked list a SECOND POPULATION beside
// the board it sits on. They are now `merge` / `update_branch` INSIGHT CARDS emitted by
// `getWorkspaceInsights` (see the emitter there for the predicates and the no-author-filter rule),
// so this file re-orders one population and derives none of it.
//
// ⚠ INHERITED NARROWINGS, BOTH DELIBERATE AND BOTH REAL. The card fold applies an ULTRA-STALE
// GATE (no activity event in `INSIGHT_MAX_STALE_DAYS` = 90 ⇒ no card) and a 15-PER-KIND CAP that
// the old standalone query did not. A long-dormant-but-mergeable PR therefore no longer appears
// here — and that is the point: a ranked row with no card behind it would break the board's
// `head ∪ tail === cards` partition, which every cap disclosure on that screen depends on.
//
// ── THE RANK IS THE CODE'S, NOT THE MODEL'S ─────────────────────────────────────────────────
// `score = 0.50·proximity + 0.30·stallRisk + 0.20·relevanceWeight`, sorted descending with a
// TOTAL tie-break chain, so two ticks over unchanged data produce byte-identical order. A sort
// that could flip under the reader between polls is a defect in a panel people read top-down.
//
// ⚠ `ageHours`, `stallRisk` and `score` are DERIVED FROM `now`. They must never enter the
// plugin's payload hash, or a dormant workspace re-bills on a timer. Everything else on an item —
// id, kind, ids, url, relevance, `reason`, `proximity` — is stable across ticks for unchanged
// data, and `reason` is deliberately written WITHOUT relative-time phrasing ("3d ago") so that it
// stays hashable.
import { and, count, eq, inArray } from 'drizzle-orm';
import type {
  CiFailingCard,
  InsightCard,
  MergeStateStatus,
  MyTurnCard,
  MyTurnCardReason,
  MyTurnRelevance,
  ReviewerRoutingCard,
  StalledReviewCard,
  UntouchedThreadCard,
  WorkPlanEvidence,
  WorkPlanFacts,
  WorkPlanItem,
  WorkPlanKind,
} from '@pierre-review/shared';
import { db, schema } from './client.js';
import { getWorkspaceInsights, mergeCardDetail, type BotScope } from './queries.js';
import { computeApprovalInfoByPr } from './triage.js';

const { pullRequests, reviewThreads } = schema;

/** How many rows the panel paints. `totals` carries the UNCAPPED population per kind, so a capped
 *  list can always disclose what it left out — a truncation nobody is told about is a lie about
 *  the size of the day. */
export const WORK_PLAN_ITEM_CAP = 12;

/**
 * THE ONE SPELLING OF THE "DO NEXT" HEAD — the ranked evidence as `InsightCard` ids, for
 * `GET /api/attention` to hand the board.
 *
 * ⚠ IT IS AN ORDERING, NOT A FILTER. The board renders every card either side of the divider;
 * these ids only say which come first and in what order. See `AttentionCardsResponse.doNextIds`.
 */
export function doNextCardIds(evidence: WorkPlanEvidence): string[] {
  return evidence.items.map((i) => i.cardId).filter((id): id is string => id != null);
}

const HOUR_MS = 3_600_000;

// ── PROXIMITY: how few steps from landing, 0..1 ─────────────────────────────────────────────
// Base by kind. A merge is one click; a nudge is a message to someone else, whose reply is then
// the actual step. Everything in between is ordered by how much work stands between the item and
// a merged PR.
const BASE_PROXIMITY: Record<WorkPlanKind, number> = {
  // ⚠ NOT the merge base — see MERGE_APPROVED_PROXIMITY below, which overrides it. This entry
  // exists only to keep the record total over WorkPlanKind.
  merge: 0.95,
  update_branch: 0.7,
  unblock_ci: 0.6,
  review: 0.55,
  reply: 0.5,
  thread: 0.4,
  nudge: 0.25,
};

/** A red TRUNK is not a normal `unblock_ci`: it invalidates every open PR in the repo at once, so
 *  it sits above the per-PR arm rather than beside it. */
const TRUNK_CI_PROXIMITY = 0.65;

// ── MERGE PROXIMITY IS APPROVAL-CONDITIONAL, AND THE ORDERING IS THE POINT ──────────────────
// A `clean` PR that NOBODY HAS REVIEWED is ready for GitHub, not ready for a human. Scoring it
// like an approved one had two visible consequences, both measured on real data:
//   1. the ranked head's top instruction became "merge this" for unreviewed code — and on this
//      account, most merge-ready PRs are bot-authored (9 of 11 and 7 of 8 on two workspaces), so
//      the head filled with unreviewed Dependabot;
//   2. because the per-PR dedup survivor is chosen by PROXIMITY, the merge row also BEAT that same
//      PR's own `review` row — so the head said "nothing is blocking this" while the board below
//      said "your turn" about one pull request.
// Dropping the unapproved case BELOW `review` (0.55) and `reply` (0.5) fixes both at once: the
// review claim wins the dedup, and the merge row only leads once someone has actually approved.
// ⚠ On repos WITH required-review protection this changes almost nothing — those PRs are
// `blocked`, not `clean`. It bites exactly the unprotected repos, which is where it should.
/** Approved: there is nothing left to wait for, only the click. */
const MERGE_APPROVED_PROXIMITY = 0.95;
/** Ready for GitHub, not ready for a human. Deliberately below `review` and `reply`. */
const MERGE_UNAPPROVED_PROXIMITY = 0.45;
/** Conflicts — further out than the merge state alone makes it look. */
const DIRTY_PENALTY = -0.15;
/** A wall of unanswered feedback is not one step from landing. */
const THREAD_WALL_PENALTY = -0.1;
const THREAD_WALL_MIN = 3;
/** A small change lands fast. */
const SMALL_DIFF_BONUS = 0.05;
const SMALL_DIFF_MAX_FILES = 3;

// ── STALL RISK: how likely this sits untouched, 0..1 ────────────────────────────────────────
// ⚠ MEASURED AGAINST THE ITEM'S OWN CLOCK (`facts.clock`), never a blanket "since opened". The
// seven signals age against different instants and saying WHICH is the difference between a fact
// and a plausible number.
const STALL_BUCKETS: readonly { minHours: number; risk: number }[] = [
  { minHours: 96, risk: 1.0 },
  { minHours: 48, risk: 0.7 },
  { minHours: 24, risk: 0.4 },
];
/** Fresh, or no clock at all. An unknown age is NOT treated as urgent. */
const STALL_BASE = 0.15;

// ── RELEVANCE: the same three tiers My Turn and the attention board use ─────────────────────
const RELEVANCE_WEIGHT: Record<MyTurnRelevance, number> = {
  direct: 1.0,
  maintained: 0.6,
  none: 0.25,
};

const W_PROXIMITY = 0.5;
const W_STALL = 0.3;
const W_RELEVANCE = 0.2;

/** Trim float noise so the wire (and any hash over it) is byte-stable for unchanged inputs. */
function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/** THE ONE PROXIMITY RESOLVER. `base` overrides the per-kind default (the trunk CI arm). */
function proximityFor(kind: WorkPlanKind, facts: WorkPlanFacts, base?: number): number {
  let p = base ?? BASE_PROXIMITY[kind];
  // The merge base is CONDITIONAL, not a bonus on top of a high base — see the constants.
  if (kind === 'merge') {
    p = (facts.approvals ?? 0) > 0 ? MERGE_APPROVED_PROXIMITY : MERGE_UNAPPROVED_PROXIMITY;
  }
  // Each adjustment is applied ONCE, then the sum is clamped — not clamped between steps, which
  // would make the order of the four matter.
  if (facts.mergeStateStatus === 'dirty') p += DIRTY_PENALTY;
  if ((facts.untouchedThreads ?? 0) >= THREAD_WALL_MIN) p += THREAD_WALL_PENALTY;
  if (facts.changedFiles != null && facts.changedFiles <= SMALL_DIFF_MAX_FILES) p += SMALL_DIFF_BONUS;
  return round4(clamp01(p));
}

/** THE ONE STALL RESOLVER. A null/absent age is the base risk, never the top bucket. */
function stallRiskFor(ageHours: number | null | undefined): number {
  if (ageHours == null || !Number.isFinite(ageHours)) return STALL_BASE;
  for (const b of STALL_BUCKETS) if (ageHours >= b.minHours) return b.risk;
  return STALL_BASE;
}

function scoreFor(proximity: number, stallRisk: number, relevance: MyTurnRelevance): number {
  return round4(
    W_PROXIMITY * proximity + W_STALL * stallRisk + W_RELEVANCE * RELEVANCE_WEIGHT[relevance],
  );
}

/** A my_turn card's `reason` → the plan's kind. A requested review is review work; a thread
 *  waiting on you is a reply. Everything else lands on the PR itself, which is review work too. */
function kindForMyTurn(reason: MyTurnCardReason): 'review' | 'reply' {
  return reason === 'thread' ? 'reply' : 'review';
}

/** DEDUP PRIORITY, and it is deliberately TIME-FREE. Several my_turn reasons collapse onto one
 *  `wp:review:<prId>` id (a PR can be both "review requested" and "approved, waiting on you"), and
 *  the id is the model's join key so it must be unique. Picking the winner by SCORE would make the
 *  choice depend on `ageHours`, which would in turn make `reason` — a hashed field — drift on a
 *  timer and re-bill a dormant workspace. So the winner is fixed by severity, then by this rank. */
const REASON_RANK: Record<MyTurnCardReason, number> = {
  review_request: 0,
  thread: 1,
  claude_review: 2,
  pr_approved: 3,
  your_pr: 4,
  watched_repo_pr: 5,
};

const SEVERITY_RANK: Record<'high' | 'warn' | 'info', number> = { high: 0, warn: 1, info: 2 };

/** One candidate row, before dedup + ranking. `tieRank` is the time-free dedup key (see
 *  REASON_RANK); `sortAgeHours` is the ranking tie-break and IS time-derived. */
interface Candidate {
  item: WorkPlanItem;
  tieRank: number;
  /** True when this row IS an action on its PR, so at most one of them may survive per PR. False
   *  for a repo-grained row (a red trunk, whose `prId` is only the landing PR of the current head)
   *  and for a thread-grained one (two threads on a PR are two jobs). Derived from the id — see
   *  `push` — so the flag and the id can never disagree. */
  prGrained: boolean;
}

function hoursSince(iso: string | null | undefined, now: number): number | undefined {
  if (iso == null) return undefined;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return undefined;
  return Math.max(0, (now - t) / HOUR_MS);
}

const plural = (n: number, one: string, many = `${one}s`): string => (n === 1 ? one : many);

/** The counts half of the evidence — a SECOND SPELLING of db/daily-brief.ts's `computeBriefCounts`
 *  loop, restricted to the six fields `WorkPlanEvidence.counts` carries.
 *
 *  ⚠ PREDICATE FOR PREDICATE IDENTICAL, and `myTurnPersonal` uses `c.personal` for exactly the
 *  reason the brief does: `personal` is the boolean the notification surfaces count, and re-reading
 *  it off `relevance` here would be a third derivation of the same fact. (The ITEM's `relevance`
 *  below deliberately treats an ABSENT field as 'none' instead — a missing field may never invent
 *  an ownership claim in card copy. The two rules answer different questions and both are right.) */
function foldCounts(cards: InsightCard[]): WorkPlanEvidence['counts'] {
  let myTurn = 0;
  let myTurnPersonal = 0;
  let ciFailing = 0;
  let stalled = 0;
  let untouchedThreads = 0;
  let needsReviewer = 0;
  for (const c of cards) {
    if (c.kind === 'ci_failing') ciFailing += 1;
    else if (c.kind === 'my_turn') {
      myTurn += 1;
      if (c.personal) myTurnPersonal += 1;
    } else if (c.kind === 'stalled_review') stalled += 1;
    else if (c.kind === 'untouched_thread') untouchedThreads += 1;
    else if (c.kind === 'reviewer_routing') needsReviewer += 1;
  }
  return { myTurn, myTurnPersonal, ciFailing, stalled, untouchedThreads, needsReviewer };
}

function emptyEvidence(workspaceId: number, generatedAt: Date): WorkPlanEvidence {
  return {
    workspaceId,
    generatedAt: generatedAt.toISOString(),
    items: [],
    totals: {},
    counts: {
      myTurn: 0,
      myTurnPersonal: 0,
      ciFailing: 0,
      stalled: 0,
      untouchedThreads: 0,
      needsReviewer: 0,
    },
  };
}

/**
 * THE WORK PLAN'S EVIDENCE — ranked, capped, and entirely code-derived.
 *
 * Takes an ALREADY-RESOLVED `BotScope` (the caller owns `resolveWorkspaceScope`, exactly like
 * every other scoped reader).
 *
 * ⚠ `scope.repoIds.length === 0` IS A REAL ANSWER — "this workspace is empty" — not a licence to
 * widen to the account. It short-circuits to empty evidence (which also dodges the
 * `inArray(col, [])` pitfall), and its all-zero `counts` still agree with the brief, whose fold
 * returns the same zeros for the same workspace.
 */
export async function getWorkPlan(
  accountId: number,
  scope: BotScope,
): Promise<WorkPlanEvidence> {
  // ⚠ THE SAME CALL THE DAILY BRIEF MAKES — same fold, same scope, same DEFAULT window
  // (`undefined`). A different window here would silently give the plan a different population
  // from the strip and the board.
  //
  // ⚠ THIS SIGNATURE IS LOAD-BEARING ACROSS TWO REPOSITORIES. It is `ProHostQueries.getWorkPlan`,
  // and changing its shape is the one thing here that would force an `apiVersion` bump in four
  // literals spanning the host and the plugin submodule. The split below moves the BODY out; the
  // signature does not move.
  const insights = await getWorkspaceInsights(accountId, undefined, scope);
  return rankWorkPlan(accountId, scope, insights);
}

/**
 * THE RANK ITSELF, over an ALREADY-FOLDED `getWorkspaceInsights` result.
 *
 * Split out of `getWorkPlan` so that `GET /api/attention` — which has just run that exact fold to
 * build the board — can rank the same cards without folding them a second time. Two folds in one
 * request would be two populations one refresh apart, which is the whole class of bug the Pending
 * consolidation exists to remove.
 *
 * ⚠ THE EMPTY-SCOPE SHORT-CIRCUIT LIVES HERE, not in the wrapper, so BOTH callers inherit it.
 */
export async function rankWorkPlan(
  accountId: number,
  scope: BotScope,
  insights: Awaited<ReturnType<typeof getWorkspaceInsights>>,
): Promise<WorkPlanEvidence> {
  const now = Date.now();
  const generatedAt = new Date(now);
  if (scope.repoIds.length === 0) return emptyEvidence(scope.workspaceId, generatedAt);

  const counts = foldCounts(insights.cards);

  // ── the shared per-PR facts every PR-grained row wants ────────────────────────────────────
  // Batched over the UNION of PR ids the plan could name, so every row gets the same
  // merge/approval/thread facts for free.
  const cardPrIds = new Set<number>();
  for (const c of insights.cards) {
    if (
      c.kind === 'my_turn' ||
      c.kind === 'stalled_review' ||
      c.kind === 'untouched_thread' ||
      c.kind === 'reviewer_routing' ||
      c.kind === 'merge' ||
      c.kind === 'update_branch'
    ) {
      cardPrIds.add(c.prId);
    } else if (c.kind === 'ci_failing' && c.prId != null) cardPrIds.add(c.prId);
  }
  const factPrIds = [...cardPrIds];

  // ⚠ NARROW, AND GUARDED FOR EMPTY. Three fields, keyed on the ids the cards already named —
  // this replaced an account-wide open-PR select that is now the card emitter's job.
  //   • `changedFiles` MUST stay in this select. Two readers depend on it — `sharedFacts` and the
  //     ci_failing 'your_pr' arm, which has no other source — and it is HASHED (`cf:`) as well as
  //     driving SMALL_DIFF_BONUS, the time-free key the per-PR dedup survivor is chosen by.
  //     Dropping it would flip every stored plan on an affected workspace permanently `stale`.
  //   • `mergeStateStatus` MUST stay: `sharedFacts` feeds it to EVERY PR-grained row, and it is
  //     hashed as `ms:`.
  //   • THE EMPTY GUARD IS NOT OPTIONAL. `factPrIds` legitimately empties on a workspace with no
  //     PR-grained cards, and `inArray(col, [])` is the pitfall this file already names.
  const openRows =
    factPrIds.length > 0
      ? await db
          .select({
            id: pullRequests.id,
            mergeStateStatus: pullRequests.mergeStateStatus,
            changedFiles: pullRequests.changedFiles,
          })
          .from(pullRequests)
          .where(
            and(eq(pullRequests.accountId, accountId), inArray(pullRequests.id, factPrIds)),
          )
          .execute()
      : [];
  const openById = new Map(openRows.map((r) => [r.id, r]));

  const approvalByPr = await computeApprovalInfoByPr(factPrIds);
  const untouchedByPr = new Map<number, number>();
  if (factPrIds.length > 0) {
    const threadRows = await db
      .select({ prId: reviewThreads.prId, c: count() })
      .from(reviewThreads)
      .where(
        and(
          inArray(reviewThreads.prId, factPrIds),
          eq(reviewThreads.derivedState, 'untouched'),
        ),
      )
      .groupBy(reviewThreads.prId)
      .execute();
    for (const r of threadRows) untouchedByPr.set(r.prId, r.c);
  }

  /** The per-PR facts that do not depend on which SIGNAL produced the row. A PR outside the
   *  open/non-draft population (a my_turn thread on a draft, say) simply carries fewer facts —
   *  `undefined` means "not known here", never "zero". */
  const sharedFacts = (prId: number): WorkPlanFacts => {
    const row = openById.get(prId);
    const untouched = untouchedByPr.get(prId);
    return {
      approvals: approvalByPr.get(prId)?.approvals ?? 0,
      ...(row?.mergeStateStatus != null
        ? { mergeStateStatus: row.mergeStateStatus as MergeStateStatus }
        : {}),
      ...(untouched != null ? { untouchedThreads: untouched } : {}),
    };
  };

  const candidates: Candidate[] = [];
  const push = (
    kind: WorkPlanKind,
    id: string,
    tieRank: number,
    parts: {
      /** The `InsightCard.id` this row came from — the SPA's join key from a narration step to a
       *  board row. REQUIRED, and every arm can supply one now that all seven signals fold off
       *  cards; a row without one would be unreachable from the Pending board's head. */
      cardId: string;
      prId: number | null;
      repoId: number;
      repoFullName: string;
      prNumber: number | null;
      prTitle: string | null;
      threadId?: number | null;
      githubUrl: string;
      relevance: MyTurnRelevance;
      facts: WorkPlanFacts;
      reason: string;
      proximityBase?: number;
      /** ⚠ NOT derivable from `prGrained` below — see the field's comment on the wire type. A
       *  thread row is NOT the PR's one job (so it is not prGrained) but IS about a pull request.
       *  Defaults to 'pr'; only the red-trunk arm passes 'repo'. */
      subject?: 'pr' | 'repo';
    },
  ): void => {
    const proximity = proximityFor(kind, parts.facts, parts.proximityBase);
    const stallRisk = stallRiskFor(parts.facts.ageHours);
    // THE ID ENCODES THE GRAIN, so the flag is read back off it rather than passed: a PR-grained
    // row is ADDRESSED by its PR (`wp:merge:<prId>`), while a repo- or thread-grained one is
    // addressed by something else (`wp:unblock_ci:trunk:<repoId>`, `wp:thread:<threadId>`) and
    // merely happens to carry a prId for linking. Deriving it means a new row kind cannot get the
    // two out of step by forgetting an argument.
    const prGrained = parts.prId != null && id === `wp:${kind}:${parts.prId}`;
    candidates.push({
      tieRank,
      prGrained,
      item: {
        id,
        kind,
        subject: parts.subject ?? 'pr',
        prId: parts.prId,
        repoId: parts.repoId,
        repoFullName: parts.repoFullName,
        prNumber: parts.prNumber,
        prTitle: parts.prTitle,
        ...(parts.threadId !== undefined ? { threadId: parts.threadId } : {}),
        githubUrl: parts.githubUrl,
        relevance: parts.relevance,
        facts: parts.facts,
        proximity,
        stallRisk,
        score: scoreFor(proximity, stallRisk, parts.relevance),
        reason: parts.reason,
        cardId: parts.cardId,
      },
    });
  };

  // ── the seven card-derived signals ────────────────────────────────────────────────────────
  for (const card of insights.cards) {
    // ── merge + update_branch ───────────────────────────────────────────────────────────────
    // Folded off the cards like everything else. The card already carries relevance, the repo
    // name and the url; this arm adds only the facts the ranker scores on.
    if (card.kind === 'merge' || card.kind === 'update_branch') {
      const c = card;
      // The honest clock: the head commit is the code that is ready to land. `clock` says which
      // instant was actually used, so a row falling back to `openedAt` does not claim otherwise.
      const facts: WorkPlanFacts = {
        ...sharedFacts(c.prId),
        ciStatus: c.ciStatus,
        changedFiles: c.changedFiles,
        ageHours: hoursSince(c.lastCommitAt ?? c.openedAt, now),
        clock: c.lastCommitAt != null ? 'last_commit' : 'opened',
      };
      push(c.kind, `wp:${c.kind}:${c.prId}`, 0, {
        cardId: c.id,
        prId: c.prId,
        repoId: c.repoId,
        repoFullName: c.repoFullName,
        prNumber: c.prNumber,
        prTitle: c.prTitle,
        githubUrl: c.githubUrl,
        // ⚠ VERBATIM off the card, exactly like the my_turn arm below. The card's fold is the ONE
        // place "a repo you maintain" is decided.
        relevance: c.relevance,
        facts,
        // The SAME builder the card used — but with the real untouched-thread count, which only
        // this fold has. One function, so the card's `detail` and the row's `reason` cannot drift
        // into two different sentences about one PR.
        reason: mergeCardDetail(c.kind, c.mergeStateStatus, facts.untouchedThreads ?? 0),
      });
      continue;
    }

    if (card.kind === 'my_turn') {
      const c = card as MyTurnCard;
      const kind = kindForMyTurn(c.reason);
      const facts: WorkPlanFacts = {
        ...sharedFacts(c.prId),
        ciStatus: c.ciStatus,
        changedFiles: c.changedFiles,
        ageHours: hoursSince(c.since, now),
        // `since` is the instant the thing that needs you happened. Only the review-request
        // section's is one of the four NAMED clocks; the rest are activity events we observed,
        // and 'observed' is the honest label rather than a nearby-sounding lie.
        clock: c.reason === 'review_request' ? 'requested' : 'observed',
      };
      push(
        kind,
        kind === 'reply' && c.threadId != null
          ? `wp:reply:${c.prId}:${c.threadId}`
          : `wp:${kind}:${c.prId}`,
        SEVERITY_RANK[c.severity] * 10 + REASON_RANK[c.reason],
        {
          cardId: c.id,
          prId: c.prId,
          repoId: c.repoId,
          repoFullName: c.repoFullName,
          prNumber: c.prNumber,
          prTitle: c.prTitle,
          ...(c.threadId != null ? { threadId: c.threadId } : {}),
          githubUrl: c.githubUrl,
          // ⚠ CARRIED THROUGH VERBATIM, and an ABSENT field is 'none'. The card's copy rule
          // exactly: a missing field may never invent an ownership claim on screen.
          relevance: c.relevance ?? 'none',
          facts,
          reason: myTurnReason(c.reason),
        },
      );
      continue;
    }

    if (card.kind === 'ci_failing') {
      const c = card as CiFailingCard;
      const trunk = c.arm === 'trunk';
      // ⚠ THE TRUNK ARM TAKES NO PR-DERIVED FACTS, even though it resolves a `prId`. That prId is
      // the pull request that LANDED the branch's current head — a link target, nothing more — and
      // its approvals, diff size and merge state are facts about THAT PR, not about the branch.
      // Rendered on a row whose subject is "acme/api default branch", "one approval" is not merely
      // irrelevant, it is a claim about the wrong object; it shipped that way for one generation
      // and read as though the branch itself had been approved. The branch's own facts are its CI
      // status and when we last looked.
      const facts: WorkPlanFacts = trunk
        ? { ciStatus: c.ciStatus, ageHours: hoursSince(c.observedAt, now), clock: 'observed' }
        : {
            // The 'your_pr' arm is BUILT from the viewer's own open PR, so prId is never null here
            // — but the wire type permits it (the trunk arm above is why), so this degrades to the
            // CI status alone rather than asserting.
            ...(c.prId != null ? sharedFacts(c.prId) : {}),
            ciStatus: c.ciStatus,
            ...(c.prId != null && openById.get(c.prId) != null
              ? { changedFiles: openById.get(c.prId)!.changedFiles }
              : {}),
            ageHours: hoursSince(c.observedAt, now),
            // 'your_pr' dates off the HEAD COMMIT — the code the verdict is about. (The trunk arm
            // above dates off OUR branch-snapshot refresh instead: two different facts, and the
            // card already says which.)
            clock: 'last_commit',
          };
      push(
        'unblock_ci',
        // ⚠ A repo-grained row cannot share the PR-grained id space: `pull_requests.id` and
        // `repos.id` are separate sequences that both start at 1, so `wp:unblock_ci:3` would be
        // ambiguous. The trunk arm gets its own segment. (Documented deviation from the wire
        // comment's `wp:<kind>:<prId|repoId>` shorthand; the field is a free-form string and a
        // collision here would silently join a model step to the wrong row.)
        trunk ? `wp:unblock_ci:trunk:${c.repoId}` : `wp:unblock_ci:${c.prId}`,
        SEVERITY_RANK[c.severity],
        {
          cardId: c.id,
          prId: c.prId,
          repoId: c.repoId,
          repoFullName: c.repoFullName,
          prNumber: c.prNumber,
          prTitle: c.prTitle,
          // The COMMIT page on the trunk arm — a trunk run's checks live on the commit — which the
          // card already resolved. Passed through, never rebuilt.
          githubUrl: c.githubUrl,
          // THE ONLY 'repo' ROW IN THE PRODUCT. Everything else — including a thread, which is a
          // conversation ON a pull request — is about a PR.
          subject: trunk ? 'repo' : 'pr',
          relevance: trunk ? 'maintained' : 'direct',
          facts,
          reason: trunk
            ? 'Trunk is red in a repo you maintain — every open PR here builds on it'
            : 'Your open PR — its head commit is red',
          // A red trunk invalidates every open PR in the repo at once, so it outranks the per-PR
          // arm rather than sitting beside it.
          proximityBase: trunk ? TRUNK_CI_PROXIMITY : undefined,
        },
      );
      continue;
    }

    if (card.kind === 'stalled_review') {
      const c = card as StalledReviewCard;
      // Reviewers still on the hook: users AND GitHub TEAMS (a team request carries no user id,
      // and it is still somebody being waited on).
      const pending = c.requestedReviewerIds.length + c.requestedTeamNames.length;
      const facts: WorkPlanFacts = {
        ...sharedFacts(c.prId),
        ciStatus: c.ciStatus,
        changedFiles: c.changedFiles,
        pendingReviewers: pending,
        ageHours: c.ageHours,
        clock: 'opened',
      };
      push('nudge', `wp:nudge:${c.prId}`, 0, {
        cardId: c.id,
        prId: c.prId,
        repoId: c.repoId,
        repoFullName: c.repoFullName,
        prNumber: c.prNumber,
        prTitle: c.prTitle,
        githubUrl: c.githubUrl,
        relevance: 'none',
        facts,
        // ⚠ A DIFFERENT SENTENCE FROM reviewer_routing's. Someone WAS asked here and has not
        // moved; there, nobody has been asked at all. Two situations, two reasons.
        reason:
          pending > 0
            ? `Review requested from ${pending} ${plural(pending, 'reviewer')} — nobody has moved`
            : 'Requested review has gone unanswered',
      });
      continue;
    }

    if (card.kind === 'untouched_thread') {
      const c = card as UntouchedThreadCard;
      const facts: WorkPlanFacts = {
        ...sharedFacts(c.prId),
        ciStatus: c.ciStatus,
        changedFiles: c.changedFiles,
        ageHours: c.ageHours,
        clock: 'thread_created',
      };
      push('thread', `wp:thread:${c.prId}:${c.threadId}`, 0, {
        cardId: c.id,
        prId: c.prId,
        repoId: c.repoId,
        repoFullName: c.repoFullName,
        prNumber: c.prNumber,
        prTitle: c.prTitle,
        threadId: c.threadId,
        githubUrl: c.githubUrl,
        relevance: 'none',
        facts,
        reason: `Review thread on ${c.path} — no reply and no follow-up commit`,
      });
      continue;
    }

    if (card.kind === 'reviewer_routing') {
      const c = card as ReviewerRoutingCard;
      const facts: WorkPlanFacts = {
        ...sharedFacts(c.prId),
        ciStatus: c.ciStatus,
        changedFiles: c.changedFiles,
        // Nobody is on the hook — that is the whole card. Stated as 0, not omitted: here it is a
        // measured fact rather than "not known".
        pendingReviewers: 0,
        ageHours: hoursSince(c.openedAt, now),
        clock: 'opened',
      };
      push('nudge', `wp:nudge:${c.prId}`, 1, {
        cardId: c.id,
        prId: c.prId,
        repoId: c.repoId,
        repoFullName: c.repoFullName,
        prNumber: c.prNumber,
        prTitle: c.prTitle,
        githubUrl: c.githubUrl,
        relevance: 'none',
        facts,
        reason: 'Nobody has been asked to review this yet',
      });
      continue;
    }
    // reviewer_load / bot_signal / bot_only_review are SURVEYS of the workspace, not things one
    // person does today. They are deliberately not worklist rows.
  }

  // ── dedup, rank, cap ──────────────────────────────────────────────────────────────────────
  // ⚠ THE ID IS THE MODEL'S JOIN KEY, so it must be unique. Several signals collapse onto one id
  // (a PR that is both "review requested" and "approved, waiting on you"); the survivor is chosen
  // by the TIME-FREE `tieRank`, never by score — see REASON_RANK.
  const byId = new Map<string, Candidate>();
  for (const c of candidates) {
    const prev = byId.get(c.item.id);
    if (prev == null || c.tieRank < prev.tieRank) byId.set(c.item.id, c);
  }

  // ⚠ AND THEN AGAIN BY PR, BECAUSE ONE PR IS ONE JOB. Deduping on the id alone is not enough:
  // the my_turn fold and the merge fold reach the same PR under DIFFERENT ids, so an approved,
  // mergeable PR of yours arrived twice — `wp:merge:<id>` saying "Mergeable now · 1 approval ·
  // checks green" and `wp:review:<id>` saying "Your PR is approved and waiting on you". That is
  // one instruction printed twice, and on a real workspace it burned two of the twelve slots and
  // pushed genuine work off the bottom. Observed on live data, invisible to every unit test,
  // because each fold is individually correct.
  //
  // The survivor is the HIGHEST-PROXIMITY row: proximity is the "how few steps from landing"
  // axis, so the row that survives is the one naming the action furthest along — "merge it"
  // beats "it is approved", which is the same sentence with less information.
  //
  // ⚠ PROXIMITY, NOT SCORE. Score folds `stallRisk`, which is derived from `now`, so choosing by
  // score would let the survivor — and therefore its `reason`, a HASHED field — change on a
  // timer and re-bill a dormant workspace. Proximity is time-free. `tieRank` breaks a tie, also
  // time-free.
  //
  // ⚠ ONLY PR-GRAINED ROWS. Two untouched threads on one PR are two distinct jobs, and a red
  // TRUNK is repo-grained — its `prId` is merely the landing PR of the current head, which the
  // card claims nothing about. Collapsing either into a sibling would delete real work.
  const byPr = new Map<number, Candidate>();
  const kept: Candidate[] = [];
  for (const c of byId.values()) {
    if (!c.prGrained || c.item.prId == null) {
      kept.push(c);
      continue;
    }
    const prev = byPr.get(c.item.prId);
    if (
      prev == null ||
      c.item.proximity > prev.item.proximity ||
      (c.item.proximity === prev.item.proximity && c.tieRank < prev.tieRank)
    ) {
      byPr.set(c.item.prId, c);
    }
  }
  const ranked = [...kept, ...byPr.values()].map((c) => c.item);
  ranked.sort(
    (a, b) =>
      b.score - a.score ||
      // Tie-breaks, in order, and the chain is TOTAL: two ticks over unchanged data must produce
      // byte-identical order or rows flip under the reader between polls.
      (b.facts.ageHours ?? -1) - (a.facts.ageHours ?? -1) ||
      (a.prId ?? Number.MAX_SAFE_INTEGER) - (b.prId ?? Number.MAX_SAFE_INTEGER) ||
      // The last resort: ids are unique by construction above, so this can never tie.
      a.id.localeCompare(b.id),
  );

  // The UNCAPPED population per kind, folded off the pre-cap array — the disclosure that keeps
  // WORK_PLAN_ITEM_CAP from reading as "that is everything".
  //
  // ⚠ IT COUNTS ITEMS, NOT CARDS, and is therefore NOT comparable to `counts` above: `counts` is
  // the brief-aligned CARD population, `totals` is the post-dedup ROW population the capped list
  // is drawn from. Two different questions; conflating them would make one of the two wrong.
  const totals: Partial<Record<WorkPlanKind, number>> = {};
  for (const item of ranked) totals[item.kind] = (totals[item.kind] ?? 0) + 1;

  return {
    workspaceId: scope.workspaceId,
    generatedAt: generatedAt.toISOString(),
    items: capWithKindCoverage(ranked),
    totals,
    counts,
  };
}

/**
 * Cap the ranked list at {@link WORK_PLAN_ITEM_CAP}, but SEAT THE BEST ROW OF EVERY KIND FIRST.
 *
 * ⚠ A PLAIN `.slice(0, CAP)` WOULD FILL THE WHOLE HEAD WITH ONE KIND. The old argument for this
 * pass — that a kind deleted by the cap reads as a fact about the workspace ("nothing is behind
 * trunk") — NO LONGER HOLDS: the head sits on top of the full board, and every displaced row is
 * still on screen, below the divider, in the tail. Keep the pass anyway, for the reason that
 * survives: the head PROMISES a spread of the day's work, and twelve rows of one kind above the
 * fold is the same failure moved one screen higher. The scoring weights `relevance`, so a
 * workspace with a dozen PRs naming the viewer directly out-scores every shared-work row.
 *
 * So: one slot per non-empty kind (highest-scoring member), then fill the remainder strictly by
 * score, then restore score order over the selection. `ranked` is already sorted by the total
 * tie-break chain above, so "first seen" IS "highest scoring", and the whole pass is stable.
 */
function capWithKindCoverage(ranked: WorkPlanItem[]): WorkPlanItem[] {
  if (ranked.length <= WORK_PLAN_ITEM_CAP) return ranked;

  const chosen = new Set<string>();
  const seenKind = new Set<WorkPlanKind>();
  for (const item of ranked) {
    if (seenKind.has(item.kind)) continue;
    seenKind.add(item.kind);
    chosen.add(item.id);
    // Defensive: WorkPlanKind has seven members and the cap is twelve, so this cannot fire today.
    // It is here so that shrinking the cap below the number of kinds degrades to "the top N kinds"
    // rather than silently dropping the fill pass altogether.
    if (chosen.size === WORK_PLAN_ITEM_CAP) break;
  }
  // ⚠ THE FILL PASS IS LEVELLED BY KIND *AND* BY REPO, and a plain "fill by score" is what it
  // replaced. Seating one row per kind stops a kind being ABSENT; it does nothing to stop one
  // kind DOMINATING, and on real data that is the failure that actually shipped:
  //
  //     0.725 update_branch none drizzle-team/drizzle-orm #5929
  //     0.725 update_branch none drizzle-team/drizzle-orm #5938
  //     …six more, byte-identical scores, same kind, same repo…
  //
  // EIGHT of twelve slots, one repo, one instruction — a "plan for the day" that is really one
  // sentence copied eight times. It happens because the score DEGENERATES on a backlog: every row
  // older than the top stall bucket carries `stallRisk === 1`, so that term is a constant, and
  // when a workspace has no `direct` work the relevance term is constant too. What is left is
  // `proximity`, which is per-KIND — so the ranking collapses into "sort by kind" and the fill
  // pass takes a run.
  //
  // The rule: fill in LEVELS. On level N take the highest-scoring remaining rows whose kind has
  // fewer than N seats AND whose repo has fewer than N seats. Both counters rise together, so the
  // head spreads across kinds and repos before it doubles up on either, and it degrades cleanly —
  // a workspace with one kind in one repo simply reaches its level and fills in score order.
  // Deterministic, because `ranked` is already totally ordered.
  const byKind = new Map<WorkPlanKind, number>();
  const byRepo = new Map<number, number>();
  for (const item of ranked) {
    if (!chosen.has(item.id)) continue;
    byKind.set(item.kind, (byKind.get(item.kind) ?? 0) + 1);
    byRepo.set(item.repoId, (byRepo.get(item.repoId) ?? 0) + 1);
  }
  for (let level = 2; chosen.size < WORK_PLAN_ITEM_CAP && level <= WORK_PLAN_ITEM_CAP + 1; level++) {
    for (const item of ranked) {
      if (chosen.size >= WORK_PLAN_ITEM_CAP) break;
      if (chosen.has(item.id)) continue;
      if ((byKind.get(item.kind) ?? 0) >= level) continue;
      if ((byRepo.get(item.repoId) ?? 0) >= level) continue;
      chosen.add(item.id);
      byKind.set(item.kind, (byKind.get(item.kind) ?? 0) + 1);
      byRepo.set(item.repoId, (byRepo.get(item.repoId) ?? 0) + 1);
    }
  }
  return ranked.filter((i) => chosen.has(i.id));
}

/** CODE-WRITTEN blockers for the my_turn reasons. ⚠ Deliberately free of relative-time phrasing
 *  (the card's own `detail` says "3d ago"): `reason` is a stable, hashable field and a clock
 *  inside it would re-bill a dormant workspace on a timer. */
function myTurnReason(reason: MyTurnCardReason): string {
  switch (reason) {
    case 'review_request':
      return 'Review requested from you';
    case 'thread':
      return 'A reply is waiting on you in this thread';
    case 'pr_approved':
      return 'Your PR is approved and waiting on you';
    case 'your_pr':
      return 'Your PR has new activity since you last opened it';
    case 'watched_repo_pr':
      return 'New PR in this workspace with no review yet';
    case 'claude_review':
      return 'A Claude review has finished and needs actioning';
  }
}
