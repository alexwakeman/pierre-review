import { createHash } from 'node:crypto';
import type {
  CiReviewCounts,
  CiReviewItem,
  CiReviewRefusal,
  CiReviewState,
  CiReviewStatus,
} from '@pierre-review/shared';

// THE CI REVIEW'S KEY AND CURRENCY — pure.
//
// A run is keyed by (PR, head commit, the SORTED set of failing check names). The set's key is a
// short sha256 over the version and the names (`failingKey`). Two sets are stored per run:
//
//   failing_key  the names the run READ live from GitHub (what it actually judged)
//   trigger_key  the SYNCED names that started it (sync/upsert.ts `ci_status_events`)
//
// They differ only while the sync lags the live read. "Is it current?" and "is it due?" accept
// EITHER, so a lagging sync can never make the sweeper run the same failures twice, nor make a
// fresh run read as stale.
//
// ⚠ A FAILING CHECK IS FINAL. Nothing here waits for the rest of the head's checks: a set that
// grows (another check fails later) is a NEW key, and the next run carries the diagnoses it already
// has (prepare.ts) and reads only the new failures.

export const CI_REVIEW_VERSION = 1;
// The longest check name kept (the trunk writer's slice; db/failing-checks.ts).
const NAME_CHARS = 200;

/** Trimmed, sliced, de-duplicated and sorted (code-unit order — stable on every host). */
export function normaliseFailingNames(names: Iterable<string | null | undefined>): string[] {
  const set = new Set<string>();
  for (const n of names) {
    const t = (n ?? '').trim().slice(0, NAME_CHARS);
    if (t) set.add(t);
  }
  return [...set].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The key of a failing set; null when nothing is failing. */
export function failingKey(names: Iterable<string | null | undefined>): string | null {
  const sorted = normaliseFailingNames(names);
  if (sorted.length === 0) return null;
  return createHash('sha256').update(`ci-review-v${CI_REVIEW_VERSION}\n${sorted.join('\n')}`).digest('hex').slice(0, 32);
}

/** Counts over a run's items. */
export function countItems(items: ReadonlyArray<Pick<CiReviewItem, 'status' | 'fixableInPr'>>): CiReviewCounts {
  let explained = 0;
  let fixable = 0;
  for (const i of items) {
    if (i.status !== 'diagnosed') continue;
    explained += 1;
    if (i.fixableInPr === true) fixable += 1;
  }
  return { failing: items.length, explained, fixableInPr: fixable, notChecked: items.length - explained };
}

export interface KeyedRun {
  id: number;
  headSha: string;
  failingKey: string | null;
  triggerKey: string | null;
}

/** Did this run judge exactly this head and failing set? (Either of its keys.) */
export function runCovers(run: KeyedRun, headSha: string, key: string | null): boolean {
  if (run.headSha !== headSha || key == null) return false;
  return run.failingKey === key || run.triggerKey === key;
}

/** What the state fold needs per PR, minus the synced half. */
export interface CiStateInputs {
  latest: (KeyedRun & { counts: CiReviewCounts; completedAt: Date | null }) | null;
  runningRunId: number | null;
  // The newest run of ANY status (a refusal or a failure after the last success included).
  latestAttempt: (KeyedRun & { status: CiReviewStatus; refused: string | null; completedAt?: Date | null }) | null;
}

/** The PR's CI as last synced. `failingKey` null ⇒ nothing known to be failing. */
export interface SyncedCi {
  headSha: string | null;
  failingKey: string | null;
  failingChecks: string[];
  // The synced rollup is green.
  passing: boolean;
  // When the sync observed this head's failing set (absent/null = not known).
  observedAtMs?: number | null;
}

/**
 * A `no_failures` refusal at this head that is still the newest word: the live read found nothing
 * failing AFTER the sync last observed the failure. Once the sync observes the failure again (a
 * re-run failed under the same name), the refusal is old news. Unknown times count as not newer.
 */
function noFailuresStillStands(
  attempt: CiStateInputs['latestAttempt'],
  latestId: number,
  synced: SyncedCi | undefined,
): boolean {
  if (attempt == null || attempt.refused !== 'no_failures' || attempt.id <= latestId) return false;
  if (synced?.headSha == null || attempt.headSha !== synced.headSha) return false;
  if (synced.failingKey == null) return true;
  const refusedAt = attempt.completedAt ? attempt.completedAt.getTime() : null;
  if (synced.observedAtMs == null || refusedAt == null) return true;
  return synced.observedAtMs <= refusedAt;
}

const REFUSALS: readonly CiReviewRefusal[] = [
  'no_failures',
  'no_logs',
  'logs_unavailable',
  'checks_unreadable',
  'head_unreadable',
];
export const asRefusal = (v: unknown): CiReviewRefusal | null =>
  typeof v === 'string' && (REFUSALS as readonly string[]).includes(v) ? (v as CiReviewRefusal) : null;

/** Server-computed currency. Pure. */
export function deriveCiReviewState(prId: number, inp: CiStateInputs | undefined, synced: SyncedCi | undefined): CiReviewState {
  const latest = inp?.latest ?? null;
  const attempt = inp?.latestAttempt ?? null;
  const head = synced?.headSha ?? null;
  // A refusal AT THE CURRENT HEAD newer than the last success: why there is nothing (newer) to show.
  const refused =
    attempt != null &&
    head != null &&
    attempt.headSha === head &&
    attempt.status === 'failed' &&
    attempt.id > (latest?.id ?? 0) &&
    // "Nothing is failing" is withdrawn once the sync has seen the failure again since.
    (attempt.refused !== 'no_failures' || noFailuresStillStands(attempt, latest?.id ?? 0, synced))
      ? asRefusal(attempt.refused)
      : null;
  const base: CiReviewState = {
    prId,
    status: 'none',
    staleBecause: null,
    latestRunId: latest?.id ?? null,
    runningRunId: inp?.runningRunId ?? null,
    headSha: latest?.headSha ?? null,
    counts: latest?.counts ?? null,
    refused,
    checkedAt: latest?.completedAt ? latest.completedAt.toISOString() : null,
  };
  if (inp?.runningRunId != null) return { ...base, status: 'running' };
  if (latest == null) return base;
  // No synced head: nothing shows the run moved.
  if (head == null) return { ...base, status: 'current' };
  if (latest.headSha !== head) return { ...base, status: 'stale', staleBecause: 'pushed' };
  if (synced?.failingKey == null) {
    return synced?.passing ? { ...base, status: 'stale', staleBecause: 'now_passing' } : { ...base, status: 'current' };
  }
  return runCovers(latest, head, synced.failingKey)
    ? { ...base, status: 'current' }
    : { ...base, status: 'stale', staleBecause: 'checks_changed' };
}

/**
 * Is an AUTOMATIC run due for this PR? Something is failing on the synced head, nothing is in
 * flight, and no run — succeeded, refused, failed with an answer, or cancelled — already took
 * exactly this head and failing set. (A run that THREW clears both keys, so it stays retryable.)
 */
export function ciReviewDue(inp: CiStateInputs | undefined, synced: SyncedCi | undefined): boolean {
  if (!synced?.headSha || synced.failingKey == null) return false;
  if (inp?.runningRunId != null) return false;
  if (inp?.latest && runCovers(inp.latest, synced.headSha, synced.failingKey)) return false;
  if (inp?.latestAttempt && runCovers(inp.latestAttempt, synced.headSha, synced.failingKey)) return false;
  // A `no_failures` refusal covers no set (its trigger key is cleared) but waits for the sync to
  // observe the failure again, or every tick would re-queue the same refusal.
  if (noFailuresStillStands(inp?.latestAttempt ?? null, inp?.latest?.id ?? 0, synced)) return false;
  return true;
}
