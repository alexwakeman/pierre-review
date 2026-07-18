import type { FastifyBaseLogger } from 'fastify';
import { config } from '../config.js';
import {
  getAccountContributorCount,
  getBenchmarkContributions,
  getBenchmarkOptedInAccountIds,
  isoWeekStartUtc,
  orgSizeBucket,
  upsertBenchmarkContributions,
} from '../db/queries.js';

// Cross-org benchmark rollup (CORE, CLOUD-ONLY, Phase 0). For each account that has CONSENTED
// (accounts.benchmark_opt_in; local accounts never contribute) it computes de-identified,
// AGGREGATE-ONLY weekly review-bot outcome stats over the last N complete ISO weeks and upserts
// them into benchmark_contributions. Idempotent + self-healing: re-processing the same weeks
// overwrites (so a missed run just backfills on the next). Each iteration reads only that
// account's OWN data — collection stays accountId-scoped; the cross-account read is the future
// serving job (Phase 1). Errors are caught per-account so one bad tenant can't abort the sweep.
const ROLLUP_WEEKS = 12;

async function rollupAccounts(accountIds: number[], log: FastifyBaseLogger): Promise<void> {
  if (accountIds.length === 0) return;
  // Upper bound = start of the CURRENT (in-progress) week, so we only ever contribute COMPLETE
  // weeks (an in-progress week's counts would keep changing).
  const to = isoWeekStartUtc(new Date());
  const from = new Date(to.getTime() - ROLLUP_WEEKS * 7 * 86_400_000);
  for (const accountId of accountIds) {
    try {
      const rows = await getBenchmarkContributions(accountId, from, to);
      if (rows.length === 0) continue;
      const size = orgSizeBucket(await getAccountContributorCount(accountId));
      await upsertBenchmarkContributions(accountId, size, rows);
      log.info({ accountId, weeks: ROLLUP_WEEKS, rows: rows.length }, 'benchmark contributions rolled up');
    } catch (err) {
      log.error({ err, accountId }, 'benchmark rollup failed for account');
    }
  }
}

// The scheduled sweep: all opted-in cloud accounts. Inert (returns early) in local mode, when
// scheduling is disabled, or when nobody has opted in.
export async function runBenchmarkRollup(log: FastifyBaseLogger): Promise<void> {
  if (!config.isCloud || config.disableScheduler) return;
  await rollupAccounts(await getBenchmarkOptedInAccountIds(), log);
}

// Immediate per-account seeding, fired (best-effort) right after an account opts in so the
// benchmark reflects them without waiting for the weekly cron. Re-checks opt-in (from the
// consent roster) so it can't contribute for an account that isn't opted in.
export async function runBenchmarkRollupForAccount(
  accountId: number,
  log: FastifyBaseLogger,
): Promise<void> {
  if (!config.isCloud) return;
  const optedIn = await getBenchmarkOptedInAccountIds();
  if (!optedIn.includes(accountId)) return;
  await rollupAccounts([accountId], log);
}
