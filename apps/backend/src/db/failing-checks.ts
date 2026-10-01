// ── WHICH CHECKS ARE FAILING — the Pending cards' names line (CORE, no AI, no GitHub call) ─────
//
// A red CI label on a Pending card says THAT the build failed; these readers say WHICH checks. Both
// read rows the sync already stores, so the board still fetches nothing on mount:
//
//   • A PR — the NEWEST `ci_status_events` row whose `head_sha` is the PR's CURRENT head. That log
//     is written in the same transaction as `pull_requests.ci_status` (sync/upsert.ts, not
//     lean-gated), so the dot and the names come from one observation. ⚠ IT IS A TRANSITION LOG,
//     NOT A SNAPSHOT: a row for an older head describes code that is no longer the PR, and a newer
//     non-red row means the red set it once named is gone — both give NO names.
//   • A default branch — the head commit's `branch_commits` row, through THE ONE READER
//     `/api/branch-status` uses (`trunkHeadFailingChecks`, db/branch-queries.ts).
//
// ⚠ BARE NAMES, never workflow-prefixed: the PR side stores no workflow name, and one card
// vocabulary for both sides beats a richer trunk line (the Feed's CI items made the same call).
// ⚠ "NO NAMES" IS NOT "NOTHING FAILED". A cancelled-only failure is recorded as neutral
// (`checkContextState`), and a tolerant GitHub response that nulled the contexts writes `[]` — the
// card then shows its CI label alone, never "0 failing".
// ⚠ DISPLAY ONLY. These names must never reach a card's `detail`, a work-plan fact, or any hashed
// or model payload — they are third-party text and they move on every push.
import { and, eq, inArray } from 'drizzle-orm';
import { FAILING_CHECKS_SHOWN, type CiStatus } from '@pierre-review/shared';
import { db, schema } from './client.js';
import { isRedCiStatus } from './pending-classify.js';
import { trunkHeadFailingChecks, trunkHeadKey } from './branch-queries.js';

const { ciStatusEvents } = schema;

/** The longest check name a card carries — the trunk writer's own slice (sync/branch-status.ts).
 *  Check names are chosen by CI vendors; the PR-side log stores them uncapped. */
export const MAX_CHECK_NAME_CHARS = 200;

/** What a card carries: at most `FAILING_CHECKS_SHOWN` names, and the count of every name the
 *  stored row holds. ⚠ That is not always every check that failed: a trunk commit's row keeps at
 *  most `MAX_FAILING_CHECKS_PER_COMMIT` (20, sync/branch-status.ts) and a PR's sync reads at most
 *  100 contexts, so a total AT a bound is a floor. */
export interface FailingChecksSummary {
  failingChecks: string[];
  failingCheckTotal: number;
}

/**
 * Names → the card's pair: each sliced to `MAX_CHECK_NAME_CHARS`, blanks dropped, deduped,
 * alphabetical, the first `cap` kept, the total counted over ALL of them. null when nothing
 * remains — an empty list is "no names", which the card renders as nothing.
 */
export function summariseFailingChecks(
  names: readonly (string | null | undefined)[],
  cap: number = FAILING_CHECKS_SHOWN,
): FailingChecksSummary | null {
  const unique = [
    ...new Set(
      names.flatMap((n) => {
        const t = (n ?? '').trim().slice(0, MAX_CHECK_NAME_CHARS);
        return t.length > 0 ? [t] : [];
      }),
    ),
  ].sort((a, b) => a.localeCompare(b, 'en') || (a < b ? -1 : a > b ? 1 : 0));
  if (unique.length === 0) return null;
  return { failingChecks: unique.slice(0, cap), failingCheckTotal: unique.length };
}

/** One PR's names, with the head they were read at — `prRef` uses them only while that head is
 *  still the card's own. */
export interface PrFailingChecks extends FailingChecksSummary {
  headSha: string;
}

/**
 * The failing checks of each RED PR's CURRENT head, keyed by PR id.
 *
 * Only PRs whose `ciStatus` is red and whose `headSha` is known are asked about. One account-scoped
 * select; the `prId IN × headSha IN` predicate over-matches (PR 1's row for a sha only PR 2 asked
 * about), so rows are kept only for a REQUESTED `(prId, headSha)` pair. The newest row per PR wins
 * by `observedAt`, then `id` (the CI-history backfill synthesizes rows at commit time, so two rows
 * can share a second). That row is used only when ITS status is red.
 */
export async function prFailingChecks(
  accountId: number,
  prs: readonly { id: number; headSha: string | null; ciStatus: CiStatus | string | null }[],
): Promise<Map<number, PrFailingChecks>> {
  const out = new Map<number, PrFailingChecks>();
  const asked = new Map<number, string>();
  for (const p of prs) {
    if (p.headSha != null && isRedCiStatus(p.ciStatus)) asked.set(p.id, p.headSha);
  }
  if (asked.size === 0) return out;
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
        inArray(ciStatusEvents.prId, [...asked.keys()]),
        inArray(ciStatusEvents.headSha, [...new Set(asked.values())]),
      ),
    )
    .execute();
  const newest = new Map<number, (typeof rows)[number]>();
  for (const r of rows) {
    if (asked.get(r.prId) !== r.headSha) continue;
    const cur = newest.get(r.prId);
    if (
      cur == null ||
      r.observedAt.getTime() > cur.observedAt.getTime() ||
      (r.observedAt.getTime() === cur.observedAt.getTime() && r.id > cur.id)
    ) {
      newest.set(r.prId, r);
    }
  }
  for (const [prId, r] of newest) {
    if (!isRedCiStatus(r.status)) continue;
    const summary = summariseFailingChecks(r.failingChecks ?? []);
    if (summary != null) out.set(prId, { headSha: r.headSha, ...summary });
  }
  return out;
}

/**
 * The failing checks of each red default-branch HEAD, keyed by `trunkHeadKey(repoId, sha)` —
 * through the one reader `/api/branch-status` uses, mapped to bare names. Independent of whether a
 * landing PR resolved: a direct push to trunk has failing checks too.
 */
export async function trunkFailingChecks(
  accountId: number,
  heads: readonly { repoId: number; sha: string | null }[],
): Promise<Map<string, FailingChecksSummary>> {
  const out = new Map<string, FailingChecksSummary>();
  const pairs = heads.flatMap((h) => (h.sha != null ? [{ repoId: h.repoId, sha: h.sha }] : []));
  if (pairs.length === 0) return out;
  for (const [key, runs] of await trunkHeadFailingChecks(accountId, pairs)) {
    const summary = summariseFailingChecks(runs.map((r) => r.name));
    if (summary != null) out.set(key, summary);
  }
  return out;
}

/** The REQUIRED pair on `CiFailingCard` / `MyTurnTrunkCard`: the names, or null for both when
 *  none are known (never an empty list, never a 0). */
export function failingChecksFields(s: FailingChecksSummary | undefined): {
  failingChecks: string[] | null;
  failingCheckTotal: number | null;
} {
  return s != null
    ? { failingChecks: s.failingChecks, failingCheckTotal: s.failingCheckTotal }
    : { failingChecks: null, failingCheckTotal: null };
}

/** The trunk map's lookup for one head — the `trunkHeadKey` spelling, never re-typed. */
export function trunkFailingFor(
  map: ReadonlyMap<string, FailingChecksSummary>,
  repoId: number,
  sha: string | null,
): FailingChecksSummary | undefined {
  return sha != null ? map.get(trunkHeadKey(repoId, sha)) : undefined;
}
