// ── FLAKY CHECKS — which failing checks are probably not the PR's fault (CORE, no AI, no GitHub) ──
//
// docs/MERGE-CI-TRUNK.md § Flaky checks. A failing check at a PR's CURRENT head is FLAKY when:
//
//   (a) `passed_and_failed` — the PR's stored CI log (`ci_status_events`) holds a row AT THAT HEAD
//       whose rollup was `success` (every check passed on this commit), and the check fails on it
//       now. ⚠ The log stores the FAILING names only, never per-check passes, so a `success` row is
//       the one stored proof that a check passed. A red row that merely omits a name is NOT one —
//       the check may be re-running (pending) or cancelled.
//   (b) `ci_review_infra` — the latest SUCCEEDED CI review AT THAT HEAD diagnosed the check
//       `flaky_or_infra`. An older head's review never counts: it explained different code.
//
// ⚠ ONE PURE FUNCTION decides (`classifyFlakyChecks`); the loader below only gathers its inputs, in
// three account-scoped reads for the whole board. Nothing fetches; nothing is stored.
// ⚠ A FLAKY CHECK IS STILL A FAILURE: no count, no CI label, no merge verdict and no card depends on
// this. It is DISPLAY ONLY — never in a `detail`, a work-plan fact, a hash or a model payload.
// ⚠ `limn/` statuses are never CI (`isLimnStatusContext`): never a failing check, never flaky.
import { and, eq, inArray } from 'drizzle-orm';
import {
  isLimnStatusContext,
  type CiStatus,
  type FlakyCheck,
  type FlakyCheckReason,
} from '@pierre-review/shared';
import { db, schema } from './client.js';
import { isRedCiStatus } from './pending-classify.js';
import { summariseFailingChecks } from './failing-checks.js';

const { ciStatusEvents, ciReviews, ciReviewItems } = schema;

/** One stored CI-log row (`ci_status_events`). */
export interface FlakyLogRow {
  headSha: string;
  status: string;
  failingChecks: readonly string[] | null;
}

/** One item of a CI review (`ci_review_items`). */
export interface FlakyReviewItem {
  checkName: string;
  status: string;
  category: string | null;
}

export interface FlakyVerdict {
  /** The flaky failing checks, alphabetical. Never empty. */
  checks: FlakyCheck[];
  /** Every failing check is flaky. */
  allFailing: boolean;
}

/** A name as the failing-check list spells it (trimmed, sliced) — one spelling for both sides. */
function normaliseNames(names: readonly (string | null | undefined)[]): string[] {
  return (summariseFailingChecks(names, Number.POSITIVE_INFINITY)?.failingChecks ?? []).filter(
    (n) => !isLimnStatusContext(n),
  );
}

/**
 * THE RULE. `failing` = every check failing at `headSha` now (uncapped); `log` = the PR's stored CI
 * log rows (any head — rows for other heads are ignored here); `ciReviewItems` = the items of the
 * latest succeeded CI review AT `headSha`, or null when there is none. null when nothing is flaky.
 */
export function classifyFlakyChecks(input: {
  headSha: string;
  failing: readonly string[];
  log: readonly FlakyLogRow[];
  ciReviewItems: readonly FlakyReviewItem[] | null;
}): FlakyVerdict | null {
  const failing = normaliseNames(input.failing);
  if (failing.length === 0) return null;
  const passedOnHead = input.log.some((r) => r.headSha === input.headSha && r.status === 'success');
  const infra = new Set(
    normaliseNames(
      (input.ciReviewItems ?? [])
        .filter((i) => i.status === 'diagnosed' && i.category === 'flaky_or_infra')
        .map((i) => i.checkName),
    ),
  );
  const checks: FlakyCheck[] = [];
  for (const name of failing) {
    const reasons: FlakyCheckReason[] = [];
    if (passedOnHead) reasons.push('passed_and_failed');
    if (infra.has(name)) reasons.push('ci_review_infra');
    if (reasons.length > 0) checks.push({ name, reasons });
  }
  if (checks.length === 0) return null;
  return { checks, allFailing: checks.length === failing.length };
}

/**
 * Each RED PR's flaky checks at its CURRENT head, keyed by PR id (absent = none flaky, or not red).
 * The failing set is the NEWEST log row at the head — the row `prFailingChecks` names — and only
 * while that row is red. Three reads: the log rows, the succeeded CI reviews at those heads, their
 * items. Every `IN × IN` predicate over-matches, so rows are kept only for a requested PAIR.
 */
export async function prFlakyChecks(
  accountId: number,
  prs: readonly { id: number; headSha: string | null; ciStatus: CiStatus | string | null }[],
): Promise<Map<number, FlakyVerdict & { headSha: string }>> {
  const out = new Map<number, FlakyVerdict & { headSha: string }>();
  const asked = new Map<number, string>();
  for (const p of prs) {
    if (p.headSha != null && isRedCiStatus(p.ciStatus)) asked.set(p.id, p.headSha);
  }
  if (asked.size === 0) return out;
  const prIds = [...asked.keys()];
  const shas = [...new Set(asked.values())];

  const rows = await db
    .select({
      id: ciStatusEvents.id,
      prId: ciStatusEvents.prId,
      headSha: ciStatusEvents.headSha,
      status: ciStatusEvents.status,
      failingChecks: ciStatusEvents.failingChecks,
      observedAt: ciStatusEvents.observedAt,
    })
    .from(ciStatusEvents)
    .where(
      and(
        eq(ciStatusEvents.accountId, accountId),
        inArray(ciStatusEvents.prId, prIds),
        inArray(ciStatusEvents.headSha, shas),
      ),
    )
    .execute();
  const logByPr = new Map<number, (typeof rows)[number][]>();
  for (const r of rows) {
    if (asked.get(r.prId) !== r.headSha) continue;
    const list = logByPr.get(r.prId) ?? [];
    list.push(r);
    logByPr.set(r.prId, list);
  }

  // The latest SUCCEEDED CI review at each asked head (highest id wins, the persist layer's rule).
  const runs = await db
    .select({ id: ciReviews.id, prId: ciReviews.prId, headSha: ciReviews.headSha })
    .from(ciReviews)
    .where(
      and(
        eq(ciReviews.accountId, accountId),
        inArray(ciReviews.prId, prIds),
        inArray(ciReviews.headSha, shas),
        eq(ciReviews.status, 'succeeded'),
      ),
    )
    .execute();
  const latestRun = new Map<number, number>();
  for (const r of runs) {
    if (asked.get(r.prId) !== r.headSha) continue;
    if ((latestRun.get(r.prId) ?? 0) < r.id) latestRun.set(r.prId, r.id);
  }
  const itemsByRun = new Map<number, FlakyReviewItem[]>();
  if (latestRun.size > 0) {
    const items = await db
      .select({
        ciReviewId: ciReviewItems.ciReviewId,
        checkName: ciReviewItems.checkName,
        status: ciReviewItems.status,
        category: ciReviewItems.category,
      })
      .from(ciReviewItems)
      .where(
        and(
          eq(ciReviewItems.accountId, accountId),
          inArray(ciReviewItems.ciReviewId, [...latestRun.values()]),
        ),
      )
      .execute();
    for (const i of items) {
      const list = itemsByRun.get(i.ciReviewId) ?? [];
      list.push(i);
      itemsByRun.set(i.ciReviewId, list);
    }
  }

  for (const [prId, headSha] of asked) {
    const log = logByPr.get(prId) ?? [];
    // The newest row at the head (observedAt, then id) — the failing set the card names.
    let newest: (typeof log)[number] | undefined;
    for (const r of log) {
      if (
        newest == null ||
        r.observedAt.getTime() > newest.observedAt.getTime() ||
        (r.observedAt.getTime() === newest.observedAt.getTime() && r.id > newest.id)
      ) {
        newest = r;
      }
    }
    if (newest == null || !isRedCiStatus(newest.status)) continue;
    const runId = latestRun.get(prId);
    const verdict = classifyFlakyChecks({
      headSha,
      failing: newest.failingChecks ?? [],
      log,
      ciReviewItems: runId != null ? (itemsByRun.get(runId) ?? []) : null,
    });
    if (verdict != null) out.set(prId, { headSha, ...verdict });
  }
  return out;
}
