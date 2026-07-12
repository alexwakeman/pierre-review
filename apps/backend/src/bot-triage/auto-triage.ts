import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { config } from '../config.js';
import { db, schema } from '../db/client.js';
import { getAutoResolveCandidates, getResolvableBotThreads } from '../db/queries.js';
import { resolveThreadsOnGitHub } from './resolve.js';

const { botMuteRules } = schema;

// Accounts that have at least one standing `auto_resolve` rule. The sweep only touches
// these — with zero rules the whole feature is inert (this returns []). Distinct, portable.
async function accountsWithAutoResolveRules(): Promise<number[]> {
  const rows = await db
    .select({ accountId: botMuteRules.accountId })
    .from(botMuteRules)
    .where(eq(botMuteRules.action, 'auto_resolve'))
    .groupBy(botMuteRules.accountId)
    .execute();
  return rows.map((r) => r.accountId);
}

// Standing bot auto-triage sweep (CORE, deterministic, rule-gated). Registered on a cron by
// the scheduler; runs local + cloud. For each account with an `auto_resolve` rule it asks the
// engine for the candidate threads (rule-gated by vendor/path/severity AND age > rule.days,
// only `likely_addressed` + unresolved), RE-DERIVES eligibility exactly as the manual route
// does (`getResolvableBotThreads` → owned + automated-originated + `likely_addressed` +
// unresolved + node id, mapped to node ids), then resolves each via the SHARED helper.
//
// Guardrails (all load-bearing): opt-in (inert with zero rules); only `likely_addressed`;
// age-gated; NEVER a merge (resolve only); a structured pino line per resolved thread; errors
// caught per-account so one bad token doesn't abort the sweep, and per-thread inside the
// shared helper so one bad thread doesn't abort the account. Undoable = unresolve on GitHub
// (no local hard state beyond the derivedState the next sync recomputes).
export async function runAutoTriageSweep(log: FastifyBaseLogger): Promise<void> {
  // Defensive: the scheduler only schedules this when scheduling is enabled, but honour the
  // gate directly too so a stray caller can never bypass it.
  if (config.disableScheduler) return;

  const accountIds = await accountsWithAutoResolveRules();
  if (accountIds.length === 0) return;

  for (const accountId of accountIds) {
    try {
      const candidates = await getAutoResolveCandidates(accountId);
      for (const { prId, threadIds } of candidates) {
        // Re-derive from scratch — the candidate set is rule/age-gated; this maps thread ids to
        // GitHub node ids AND re-confirms the (owned + automated + likely_addressed + unresolved)
        // predicate, so a thread whose state changed since the candidate query is dropped.
        const eligible = await getResolvableBotThreads(prId, accountId, threadIds);
        if (eligible.length === 0) continue;
        const result = await resolveThreadsOnGitHub(accountId, eligible);
        for (const r of result.results) {
          if (r.ok) log.info({ accountId, prId, threadId: r.threadId }, 'bot auto-resolved');
          else log.warn({ accountId, prId, threadId: r.threadId }, 'bot auto-resolve failed');
        }
      }
    } catch (err) {
      // One account's failure (e.g. an expired/absent token) must not abort the others.
      log.error({ err, accountId }, 'bot auto-triage sweep failed for account');
    }
  }
}
