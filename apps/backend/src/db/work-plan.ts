// ── THE DO NEXT SCORER (CORE, deterministic, no AI) ─────────────────────────────────────────
//
// `scoreCards` gives every Pending card its Do next score; `db/pending-tabs.ts` ranks each tab by
// it. NOTHING here is model-touched. The cards come from ONE fold — `getWorkspaceInsights`, which
// is also what `GET /api/attention` serves — so the scorer re-orders one population and derives
// none of it.
//
// ── THE RANK IS THE CODE'S ──────────────────────────────────────────────────────────────────
// `score = w.proximity·proximity + w.stall·stallRisk + w.relevance·relevanceWeight`, with the
// FIXED weights `DO_NEXT_RULES.weights` (0.50 / 0.30 / 0.20; there is no setting). Two ticks over
// unchanged data produce the same scores.
//
// (The file keeps its old name: it once also built the "Plan my day" worklist, removed
// 2026-11-04. The `WorkPlan*` row types are the scorer's working rows.)
import { and, count, eq, inArray } from 'drizzle-orm';
import { DO_NEXT_RULES } from '@pierre-review/shared';
import type {
  CiFailingCard,
  ConflictsCard,
  DependencyBumpCard,
  DoNextAdjustment,
  DoNextProximityBase,
  DoNextWeights,
  InsightCard,
  MergeStateStatus,
  MyTurnCardReason,
  MyTurnRelevance,
  PendingCardScore,
  ReviewerRoutingCard,
  SecurityCard,
  StalledReviewCard,
  UntouchedThreadCard,
  WorkPlanFacts,
  WorkPlanItem,
  WorkPlanKind,
} from '@pierre-review/shared';
import { db, schema } from './client.js';
import { mergeCardDetail } from './queries.js';
import { dependencyProximityBase } from './dependency-cards.js';
import { approvalInfoFromStandings, computeReviewStandingsByPr } from './triage.js';

const { pullRequests, reviewThreads } = schema;

// ⚠ EVERY NUMBER BELOW IS READ FROM `DO_NEXT_RULES` (packages/shared/src/pending-rules.ts), which
// the Pending board's info popovers also print. Retune the ranker THERE, never with a local
// literal, or the app will explain an order it no longer produces.

const HOUR_MS = 3_600_000;

// ── PROXIMITY: how few steps from landing, 0..1 ─────────────────────────────────────────────
// Base by the row's next step (`DO_NEXT_RULES.proximity`). A merge is one click; a nudge is a
// message to someone else, whose reply is then the actual step. Everything in between is ordered by
// how much work stands between the item and a merged PR.
//
// A red TRUNK is not a normal `unblock_ci`: it invalidates every open PR in the repo at once, so
// its base (`red_trunk`) sits above the per-PR arm rather than beside it.
//
// ── MERGE PROXIMITY IS APPROVAL-CONDITIONAL, AND THE ORDERING IS THE POINT ──────────────────
// A `clean` PR that NOBODY HAS REVIEWED is ready for GitHub, not ready for a human. Scoring it
// like an approved one had two visible consequences, both measured on real data:
//   1. the ranked head's top instruction became "merge this" for unreviewed code — and on this
//      account, most merge-ready PRs are bot-authored (9 of 11 and 7 of 8 on two workspaces), so
//      the head filled with unreviewed Dependabot;
//   2. because the per-PR dedup survivor is chosen by PROXIMITY, the merge row also BEAT that same
//      PR's own `review` row — so the head said "nothing is blocking this" while the board below
//      said "your turn" about one pull request.
// Dropping the unapproved case (`merge_unapproved`) BELOW `review` and `reply` fixes both at once:
// the review claim wins the dedup, and the merge row only leads once someone has actually approved.
// ⚠ On repos WITH required-review protection this changes almost nothing — those PRs are
// `blocked`, not `clean`. It bites exactly the unprotected repos, which is where it should.
//
// The three ADJUSTMENTS: conflicts are further out than the merge state alone makes it look; a
// wall of unanswered feedback is not one step from landing; a small change lands fast.
//
// ── STALL RISK: how likely this sits untouched, 0..1 ────────────────────────────────────────
// ⚠ MEASURED AGAINST THE ITEM'S OWN CLOCK (`facts.clock`), never a blanket "since opened". The
// seven signals age against different instants and saying WHICH is the difference between a fact
// and a plausible number. Fresh, or no clock at all, is `stallBase`: an unknown age is NOT urgent.
//
// ── RELEVANCE: the same three tiers My Turn and the attention board use ─────────────────────

/** Trim float noise so the wire (and any hash over it) is byte-stable for unchanged inputs. */
function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/** How a row's proximity was reached — the base it started from and the adjustments applied. */
interface ProximityWorking {
  base: DoNextProximityBase;
  adjustments: DoNextAdjustment[];
  value: number;
}

/**
 * THE ONE PROXIMITY RESOLVER. `baseOverride` replaces the per-kind default (the trunk CI arm).
 *
 * It returns its WORKING, not just the number, because the Pending board explains each card's
 * score to the reader — and a second function re-deriving "which adjustments applied" for the
 * explanation would be a second answer to a question this one already answered.
 */
function proximityWorking(
  kind: WorkPlanKind,
  facts: WorkPlanFacts,
  baseOverride?: DoNextProximityBase,
): ProximityWorking {
  // The merge base is CONDITIONAL, not a bonus on top of a high base — see the note above.
  const base: DoNextProximityBase =
    baseOverride ??
    (kind === 'merge'
      ? (facts.approvals ?? 0) > 0
        ? 'merge_approved'
        : 'merge_unapproved'
      : kind);
  const adjustments: DoNextAdjustment[] = [];
  // The `conflicts` BASE already is the conflict; penalising it again would count it twice.
  if (facts.mergeStateStatus === 'dirty' && base !== 'conflicts') adjustments.push('conflicts');
  if ((facts.untouchedThreads ?? 0) >= DO_NEXT_RULES.manyUntouchedThreadsMin) {
    adjustments.push('many_untouched_threads');
  }
  if (facts.changedFiles != null && facts.changedFiles <= DO_NEXT_RULES.smallChangeMaxFiles) {
    adjustments.push('small_change');
  }
  // Each adjustment is applied ONCE, in this fixed order, then the sum is clamped — not clamped
  // between steps, which would make the order of the three matter.
  let p: number = DO_NEXT_RULES.proximity[base];
  for (const a of adjustments) p += DO_NEXT_RULES.adjustments[a];
  return { base, adjustments, value: round4(clamp01(p)) };
}

/** THE ONE STALL RESOLVER. A null/absent age is the base risk, never the top bucket. */
function stallRiskFor(ageHours: number | null | undefined): number {
  if (ageHours == null || !Number.isFinite(ageHours)) return DO_NEXT_RULES.stallBase;
  for (const b of DO_NEXT_RULES.stallBuckets) if (ageHours >= b.minHours) return b.risk;
  return DO_NEXT_RULES.stallBase;
}

/** THE SCORE. `w` is `DO_NEXT_RULES.weights` (fixed); a test may pass others. */
function scoreFor(
  proximity: number,
  stallRisk: number,
  relevance: MyTurnRelevance,
  w: DoNextWeights,
): number {
  return round4(
    w.proximity * proximity +
      w.stall * stallRisk +
      w.relevance * DO_NEXT_RULES.relevanceWeight[relevance],
  );
}

/** A classic my_turn card's `reason` → the plan's kind. Somebody answered, named or wrote after
 *  you — a reply is owed. Everything else lands on the PR itself, which is review work. (The four
 *  promotions never reach here: each scores as its HOME kind did — see the my_turn arm.) */
function kindForMyTurn(reason: ClassicMyTurnReason): 'review' | 'reply' {
  return reason === 'thread' ||
    reason === 'thread_reply' ||
    reason === 'comment_reply' ||
    reason === 'mention'
    ? 'reply'
    : 'review';
}

/** The my_turn reasons that are a summons rather than a promotion of your own work. */
type ClassicMyTurnReason = Exclude<
  MyTurnCardReason,
  'own_ci_red' | 'own_conflicts' | 'own_ready' | 'own_thread'
>;

/** DEDUP PRIORITY, and it is deliberately TIME-FREE. Several my_turn reasons collapse onto one
 *  `wp:review:<prId>` id (a PR can be both "review requested" and "approved, waiting on you"), and
 *  the id is the model's join key so it must be unique. Picking the winner by SCORE would make the
 *  choice depend on `ageHours`, which would in turn make `reason` — a hashed field — drift on a
 *  timer and re-bill a dormant workspace. So the winner is fixed by severity, then by this rank. */
///
/// Every reason, in the fixed type order (`MY_TURN_ORDER`). The four own-work types are never read
/// here (they rank as their home kinds do), but the `Record` forces an entry. ⚠ The tie rank is
/// `SEVERITY_RANK × 100 + REASON_RANK`: with twelve reasons a × 10 would let a reason bleed across
/// a severity band.
const REASON_RANK: Record<MyTurnCardReason, number> = {
  review_request: 0,
  mention: 1,
  thread: 2,
  thread_reply: 3,
  comment_reply: 4,
  pushed_since: 5,
  own_ci_red: 6,
  own_conflicts: 7,
  pr_approved: 8,
  own_ready: 9,
  own_thread: 10,
  watched_repo_pr: 11,
};

const SEVERITY_RANK: Record<'high' | 'warn' | 'info', number> = { high: 0, warn: 1, info: 2 };

/** One candidate row, before dedup + ranking. `tieRank` is the time-free dedup key (see
 *  REASON_RANK); `sortAgeHours` is the ranking tie-break and IS time-derived. */
export interface Candidate {
  item: WorkPlanItem;
  tieRank: number;
  /** True when this row IS an action on its PR, so at most one of them may survive per PR. False
   *  for a repo-grained row (a red trunk, whose `prId` is only the landing PR of the current head)
   *  and for a thread-grained one (two threads on a PR are two jobs). Derived from the id — see
   *  `push` — so the flag and the id can never disagree. */
  prGrained: boolean;
  /** How `item.proximity` was reached. Kept OFF the item on purpose: `WorkPlanItem` is the Pro
   *  seam's evidence and its hash allow-list, and this is explanation for the board, not evidence. */
  working: ProximityWorking;
}

function hoursSince(iso: string | null | undefined, now: number): number | undefined {
  if (iso == null) return undefined;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return undefined;
  return Math.max(0, (now - t) / HOUR_MS);
}

const plural = (n: number, one: string, many = `${one}s`): string => (n === 1 ? one : many);

/** One card's Do next score and its working, as the Pending board lists it. */
export interface ScoredCard extends PendingCardScore {
  cardId: string;
  prId: number | null;
}

/**
 * EVERY CARD'S DO NEXT SCORE — the one scorer behind the Pending board's tabs.
 *
 * Returns the scorer's working rows (`candidates`: the seven signals, with ids / reasons) and
 * `scored` — the same score for EVERY scorable card, plus the BOARD-ONLY kinds (`conflicts`,
 * `security`, `dependency_bump`), which have no working row. Review load and the bot cards get no
 * score.
 */
export async function scoreCards(
  accountId: number,
  cards: InsightCard[],
  now: number,
  // The weights — fixed in the product (`DO_NEXT_RULES.weights`); a parameter only for tests.
  weights: DoNextWeights = DO_NEXT_RULES.weights,
): Promise<{ candidates: Candidate[]; scored: ScoredCard[] }> {
  // Cards the Pending board ranks that have no working row — see the note at the loop's end.
  const boardOnly: ScoredCard[] = [];
  // ── the shared per-PR facts every PR-grained row wants ────────────────────────────────────
  // Batched over the UNION of PR ids the plan could name, so every row gets the same
  // merge/approval/thread facts for free.
  const cardPrIds = new Set<number>();
  for (const c of cards) {
    if (c.kind === 'my_turn') {
      cardPrIds.add(c.prId);
    } else if (
      c.kind === 'stalled_review' ||
      c.kind === 'untouched_thread' ||
      c.kind === 'reviewer_routing' ||
      c.kind === 'merge' ||
      c.kind === 'update_branch' ||
      c.kind === 'conflicts' ||
      c.kind === 'security' ||
      c.kind === 'dependency_bump'
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

  // ⚠ THE SAME FOLD THE PENDING CARD'S REVIEWER CHIPS COME FROM, so the plan's `approvals` and
  // the card's cannot disagree — the two used to be `computeApprovalInfoByPr` and nothing, and a
  // second fold over `reviews` is exactly how they would drift.
  //
  // `approvalInfoFromStandings` is the projection `computeApprovalInfoByPr` already was: the two
  // differ only in EMISSION — the old map had no entry for a PR whose reviews are all comments,
  // where this one does, with `approvals: 0`. `sharedFacts` reads `?.approvals ?? 0`, so the value
  // is identical either way. (The narration hash that once covered `approvals` went with Plan my day.)
  const approvalByPr = new Map(
    [...(await computeReviewStandingsByPr(factPrIds))].map(([prId, st]) => [
      prId,
      approvalInfoFromStandings(st),
    ]),
  );
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
      /** The `InsightCard.id` this row came from — `ScoredCard.cardId` is read off it. REQUIRED;
       *  a row without one would score nothing on the board. */
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
      /** Replaces the per-kind proximity base — only the red-trunk arm passes one. */
      proximityBase?: DoNextProximityBase;
      /** ⚠ NOT derivable from `prGrained` below — see the field's comment on the wire type. A
       *  thread row is NOT the PR's one job (so it is not prGrained) but IS about a pull request.
       *  Defaults to 'pr'; only the red-trunk arm passes 'repo'. */
      subject?: 'pr' | 'repo';
    },
  ): void => {
    const working = proximityWorking(kind, parts.facts, parts.proximityBase);
    const proximity = working.value;
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
      working,
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
        score: scoreFor(proximity, stallRisk, parts.relevance, weights),
        reason: parts.reason,
        cardId: parts.cardId,
      },
    });
  };

  // ── the seven card-derived signals ────────────────────────────────────────────────────────
  for (const card of cards) {
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
        reason: mergeCardDetail(
          c.kind,
          c.mergeStateStatus,
          facts.untouchedThreads ?? 0,
          c.inMergeQueue,
        ),
      });
      continue;
    }

    if (card.kind === 'my_turn') {
      const c = card;
      // THE FOUR PR-GRAINED PROMOTIONS score EXACTLY as their home cards did — the same
      // `WorkPlanKind`, the same id, the same facts, the same `reason` sentence — so the Pro plan's
      // evidence vocabulary and ids are identical whether or not the reader promoted anything.
      // Only `relevance` (read off the card) and `cardId` may differ.
      const own = c.own;
      if (c.reason === 'own_ci_red' && own?.kind === 'ci_red') {
        push('unblock_ci', `wp:unblock_ci:${c.prId}`, SEVERITY_RANK[c.severity], {
          cardId: c.id,
          prId: c.prId,
          repoId: c.repoId,
          repoFullName: c.repoFullName,
          prNumber: c.prNumber,
          prTitle: c.prTitle,
          githubUrl: c.githubUrl,
          relevance: c.relevance ?? 'none',
          facts: {
            ...sharedFacts(c.prId),
            ciStatus: c.ciStatus,
            changedFiles: c.changedFiles,
            ageHours: hoursSince(own.lastCommitAt ?? c.openedAt, now),
            clock: 'last_commit',
          },
          reason: 'Your open PR — its head commit is red',
        });
        continue;
      }
      if (c.reason === 'own_ready' && own?.kind === 'ready') {
        const facts: WorkPlanFacts = {
          ...sharedFacts(c.prId),
          ciStatus: c.ciStatus,
          changedFiles: c.changedFiles,
          ageHours: hoursSince(own.lastCommitAt ?? c.openedAt, now),
          clock: own.lastCommitAt != null ? 'last_commit' : 'opened',
        };
        push(own.forward, `wp:${own.forward}:${c.prId}`, 0, {
          cardId: c.id,
          prId: c.prId,
          repoId: c.repoId,
          repoFullName: c.repoFullName,
          prNumber: c.prNumber,
          prTitle: c.prTitle,
          githubUrl: c.githubUrl,
          relevance: c.relevance ?? 'none',
          facts,
          // The card's own `inMergeQueue` (prRef), so a queued PR's row says what its card says.
          reason: mergeCardDetail(
            own.forward,
            own.mergeStateStatus,
            facts.untouchedThreads ?? 0,
            c.inMergeQueue,
          ),
        });
        continue;
      }
      if (c.reason === 'own_conflicts') {
        // Board-only, like its home `conflicts` card (see the conflicts arm below for why).
        const facts: WorkPlanFacts = {
          ...sharedFacts(c.prId),
          ciStatus: c.ciStatus,
          changedFiles: c.changedFiles,
          ageHours: hoursSince(c.openedAt, now),
          clock: 'opened',
        };
        const working = proximityWorking('merge', facts, 'conflicts');
        const stallRisk = stallRiskFor(facts.ageHours);
        const relevance = c.relevance ?? 'none';
        boardOnly.push({
          cardId: c.id,
          prId: c.prId,
          score: scoreFor(working.value, stallRisk, relevance, weights),
          proximity: working.value,
          proximityBase: working.base,
          adjustments: working.adjustments,
          stallRisk,
          relevance,
          ageHours: roundAge(facts.ageHours),
          clock: facts.clock ?? null,
        });
        continue;
      }
      if (c.reason === 'own_thread' && own?.kind === 'thread' && c.threadId != null) {
        // The Unanswered threads card ages in WHOLE hours; so does this, so one thread scores the
        // same on either tab.
        const age = hoursSince(c.since, now);
        push('thread', `wp:thread:${c.prId}:${c.threadId}`, 0, {
          cardId: c.id,
          prId: c.prId,
          repoId: c.repoId,
          repoFullName: c.repoFullName,
          prNumber: c.prNumber,
          prTitle: c.prTitle,
          threadId: c.threadId,
          githubUrl: c.githubUrl,
          relevance: c.relevance ?? 'none',
          facts: {
            ...sharedFacts(c.prId),
            ciStatus: c.ciStatus,
            changedFiles: c.changedFiles,
            ageHours: age != null ? Math.round(age) : undefined,
            clock: 'thread_created',
          },
          reason: `Review thread on ${own.path} — no reply and no follow-up commit`,
        });
        continue;
      }
      if (c.reason === 'own_ci_red' || c.reason === 'own_ready' || c.reason === 'own_thread') {
        // A promotion whose home facts are missing (`own` absent on the wire) has nothing to score
        // as — never invent them.
        continue;
      }
      const reason = c.reason;
      const kind = kindForMyTurn(reason);
      const facts: WorkPlanFacts = {
        ...sharedFacts(c.prId),
        ciStatus: c.ciStatus,
        changedFiles: c.changedFiles,
        ageHours: hoursSince(c.since, now),
        // `since` is the instant the thing that needs you happened. Only the review-request
        // section's is one of the four NAMED clocks; the rest are activity events we observed,
        // and 'observed' is the honest label rather than a nearby-sounding lie.
        clock: reason === 'review_request' ? 'requested' : 'observed',
      };
      push(
        kind,
        // A thread-grained reply (`thread`, `thread_reply`) keys on its thread; `mention` and
        // `comment_reply` are PR-grained — at most one PR-grained summons exists per PR (the fixed
        // precedence inside `getMyTurn`).
        kind === 'reply' && c.threadId != null
          ? `wp:reply:${c.prId}:${c.threadId}`
          : `wp:${kind}:${c.prId}`,
        SEVERITY_RANK[c.severity] * 100 + REASON_RANK[reason],
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
          reason: myTurnReason(reason),
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
          proximityBase: trunk ? 'red_trunk' : undefined,
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
    // ── security + dependency_bump: SCORED FOR THE BOARD, NEVER A PLAN ROW (the conflicts precedent)
    // WorkPlanKind is a two-repository contract (the plugin's prompt enumerates seven kinds as a
    // string); these rank only inside the Dependencies tab, whose strict group already puts security
    // first — so no security bonus. A dependency PR starts from the base its STATE names (a ready
    // one splits on approval like a `merge` card); a person's PR a tool flagged, from
    // `security_alert`.
    if (card.kind === 'security' || card.kind === 'dependency_bump') {
      const c = card as SecurityCard | DependencyBumpCard;
      const facts: WorkPlanFacts = {
        ...sharedFacts(c.prId),
        ciStatus: c.ciStatus,
        changedFiles: c.changedFiles,
        // The head commit is the code that would land — the merge cards' clock.
        ageHours: hoursSince(c.lastCommitAt ?? c.openedAt, now),
        clock: c.lastCommitAt != null ? 'last_commit' : 'opened',
      };
      const working = proximityWorking(
        'merge',
        facts,
        dependencyProximityBase(c.depState, facts.approvals ?? 0),
      );
      const stallRisk = stallRiskFor(facts.ageHours);
      boardOnly.push({
        cardId: c.id,
        prId: c.prId,
        score: scoreFor(working.value, stallRisk, c.relevance, weights),
        proximity: working.value,
        proximityBase: working.base,
        adjustments: working.adjustments,
        stallRisk,
        relevance: c.relevance,
        ageHours: roundAge(facts.ageHours),
        clock: facts.clock ?? null,
      });
      continue;
    }
    // ── conflicts: SCORED FOR THE BOARD, NEVER A PLAN ROW ──────────────────────────────────
    // A conflicts card competes inside the Pending board's "Needs fixing" tab, so it needs a score
    // on the same scale as the red builds beside it. It still never becomes a work-plan ROW — see
    // the note below — so it is scored straight into `boardOnly` and never pushed.
    if (card.kind === 'conflicts') {
      const c = card as ConflictsCard;
      const facts: WorkPlanFacts = {
        ...sharedFacts(c.prId),
        ciStatus: c.ciStatus,
        changedFiles: c.changedFiles,
        // The card carries no head-commit time, so it ages from when the PR was opened — and says so.
        ageHours: hoursSince(c.openedAt, now),
        clock: 'opened',
      };
      const working = proximityWorking('merge', facts, 'conflicts');
      const stallRisk = stallRiskFor(facts.ageHours);
      boardOnly.push({
        cardId: c.id,
        prId: c.prId,
        score: scoreFor(working.value, stallRisk, c.relevance, weights),
        proximity: working.value,
        proximityBase: working.base,
        adjustments: working.adjustments,
        stallRisk,
        relevance: c.relevance,
        ageHours: roundAge(facts.ageHours),
        clock: facts.clock ?? null,
      });
      continue;
    }
    // reviewer_load / bot_signal / bot_only_review are SURVEYS of the workspace, not things one
    // person does today. They are deliberately not worklist rows.
    //
    // ⚠ AND NEITHER ARE `conflicts`, `security` OR `dependency_bump`, WHICH ARE NOT SURVEYS — so
    // their absence needs its own argument (written for conflicts; the Dependencies kinds follow it
    // for reason (2), and because their tab's strict group is its own order).
    // Two reasons, and the second is why it stays out today. (1) It is the one job on this board
    // with no in-app step to rank: the plan orders what you could do NEXT, and "go resolve a merge
    // conflict in a checkout" has no next. (2) The kind vocabulary is a TWO-REPOSITORY contract —
    // `WorkPlanKind` + BASE_PROXIMITY here, and the plugin's prompt, which enumerates the seven
    // kinds as a STRING that nothing type-checks — so adding a member host-side alone hands the
    // model a kind it was never told about. The head is an ORDERING, not a filter, so an un-named
    // card renders in the tail and no cap disclosure is harmed. Including it later is a deliberate
    // change in BOTH repositories, not a one-line addition here.
  }


  const scored: ScoredCard[] = [
    ...candidates.map((c) => ({
      cardId: c.item.cardId!,
      prId: c.item.prId,
      score: c.item.score,
      proximity: c.item.proximity,
      proximityBase: c.working.base,
      adjustments: c.working.adjustments,
      stallRisk: c.item.stallRisk,
      relevance: c.item.relevance,
      ageHours: roundAge(c.item.facts.ageHours),
      clock: c.item.facts.clock ?? null,
    })),
    ...boardOnly,
  ];
  return { candidates, scored };
}

/** One decimal is plenty for "3 days" and keeps float noise off the wire. */
function roundAge(hours: number | undefined): number | null {
  return hours == null ? null : Math.round(hours * 10) / 10;
}

function myTurnReason(reason: ClassicMyTurnReason): string {
  switch (reason) {
    case 'review_request':
      return 'Review requested from you';
    case 'mention':
      return 'You were mentioned on this PR';
    case 'thread':
      return 'A reply is waiting on you in this thread';
    case 'thread_reply':
      return 'Someone replied to your comment in this thread';
    case 'comment_reply':
      return 'Someone commented after your comment';
    case 'pushed_since':
      return 'New commits since your last review or comment';
    case 'pr_approved':
      return 'Your PR is approved and waiting on you';
    case 'watched_repo_pr':
      return 'New PR you have not reviewed or commented on';
  }
}
