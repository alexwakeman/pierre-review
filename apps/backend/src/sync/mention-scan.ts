// Background derivation of "@you was mentioned on this PR" (CORE, free tier, no LLM, no GitHub
// quota). Feeds the MENTION arm of My Turn's personal-relevance flag; contract + storage
// rationale in db/pr-mentions.ts and docs/DATA-MODEL.md.
//
// WHY THIS IS A WORKER AND NOT A READ. The natural-looking implementation is a full-text
// predicate inside `getMyTurn` — and it is the wrong shape by an order of magnitude. `getMyTurn`
// runs inside `getWorkspaceInsights`, which runs on EVERY Feed landing, and the predicate is a
// substring scan over every comment and review body in scope (65k rows / ~0.19s on this repo's
// own dev account). Paying that per request to answer a question whose answer changes a few times
// a week is the definition of a misplaced fold. So the scan runs here, on a multi-minute cron,
// and the request path does one indexed existence lookup against a table with a dozen rows in it.
//
// IT IS A PULL, NOT A PUSH — the sync/ml-enrichment.ts precedent, for the same three reasons:
//   • nothing enqueues, so webhook-delivered comments, a just-posted reply and a 90-day backfill
//     are all simply "the corpus" on the next tick — no write path needs a hook of its own,
//   • a restart loses nothing: there is no in-memory queue to drop,
//   • the tick re-derives the FULL set and diffs it (db/pr-mentions.ts § syncAccountMentions), so
//     it converges rather than accumulating — an edited-away mention, a deleted comment and a
//     renamed account all self-heal without a migration or a backfill trigger.
//
// STALENESS IS BOUNDED BY ONE TICK, in one direction each:
//   • NEW mention → personal within one tick (≤ MENTION_SCAN_CRON).
//   • REMOVED mention / RENAMED account → stops being personal within one tick, and the READ is
//     additionally login-scoped (viewerMentionedPrIds), so a rename narrows IMMEDIATELY and only
//     widens again once the scan has actually re-derived under the new login. Absence never
//     widens anything: with no rows at all, `personal` degrades exactly to the maintainer test.
// The one case NOT bounded by a tick is a mention typed into a comment we never re-read: comment
// bodies are re-upserted by every sync of the PR, so this is bounded by the sync cadence, not by
// this worker.
import type { FastifyBaseLogger } from 'fastify';
import { gte } from 'drizzle-orm';
import { config } from '../config.js';
import { db, schema } from '../db/client.js';
import { deriveMentionedPrs, syncAccountMentions } from '../db/pr-mentions.js';

const { accounts } = schema;

// Five minutes. Slower than the ML worker's two because the work is rarer (a mention arrives a
// few times a week, not a few times a minute) and each tick's cost is a corpus scan rather than a
// bounded batch. A module constant rather than a config knob, mirroring AUTO_MERGE_CRON: there is
// no deployment-specific decision to make here, and a knob nobody turns is a knob that rots.
export const MENTION_SCAN_CRON = '*/5 * * * *';

// Re-entrancy guard. Ticks are far shorter than the cron period, but a very large corpus on a
// slow disk could overrun one — and two ticks racing would have both compute the same diff and
// both try to insert it (harmless, thanks to ON CONFLICT DO NOTHING, but pointless work).
let running = false;

// Where the next tick starts in the account list. A tick has a wall-clock budget, so a fixed
// order would let a large tenant at the front starve everyone behind it on EVERY tick, not just
// one — the ml-enrichment / auto-merge rotation, for the same reason.
let rotationCursor = 0;

// Wall-clock budget, checked between accounts, so a tick can never run into the next one.
const TICK_BUDGET_MS = 60_000;

export interface MentionScanStats {
  accounts: number;
  added: number;
  removed: number;
  failures: number;
}

/** Which accounts are worth scanning this tick. Mirrors the sync loop's activity gate. */
async function activeAccountIds(): Promise<Array<{ id: number; login: string }>> {
  const rows = config.isCloud
    ? await db
        .select({ id: accounts.id, login: accounts.githubLogin })
        .from(accounts)
        .where(
          gte(
            accounts.lastActiveAt,
            new Date(Date.now() - config.syncActiveWindowMinutes * 60_000),
          ),
        )
        .execute()
    : await db.select({ id: accounts.id, login: accounts.githubLogin }).from(accounts).execute();
  return rows;
}

/**
 * One scan pass. NEVER THROWS — a failure here must not be able to take down the cron, and a
 * single bad tenant must not stop the rest.
 */
export async function runMentionScanTick(log: FastifyBaseLogger): Promise<MentionScanStats> {
  const stats: MentionScanStats = { accounts: 0, added: 0, removed: 0, failures: 0 };
  if (running) return stats;
  running = true;
  const deadline = Date.now() + TICK_BUDGET_MS;

  try {
    const all = await activeAccountIds();
    if (all.length > 0) rotationCursor %= all.length;
    const rotated = [...all.slice(rotationCursor), ...all.slice(0, rotationCursor)];
    rotationCursor = all.length > 0 ? (rotationCursor + 1) % all.length : 0;

    for (const account of rotated) {
      if (Date.now() >= deadline) break;
      // An account with no login resolved yet (local mode before `gh api user` has answered)
      // has no viewer to match, and scanning for the empty string would match nothing anyway.
      // ⚠ It must NOT fall through to `syncAccountMentions`: that would derive an EMPTY set and
      // delete every row the account already has, i.e. a transient `gh` outage would silently
      // un-personalise the whole inbox.
      if (!account.login) continue;
      try {
        const derived = await deriveMentionedPrs(account.id, account.login);
        const res = await syncAccountMentions(account.id, account.login, derived);
        stats.accounts += 1;
        stats.added += res.added;
        stats.removed += res.removed;
      } catch (err) {
        stats.failures += 1;
        log.warn({ err, accountId: account.id }, 'mention scan: account failed');
      }
    }

    if (stats.added > 0 || stats.removed > 0) {
      log.info(
        `mention scan: +${stats.added} / -${stats.removed} mentioned PR(s) across ${stats.accounts} account(s)`,
      );
    }
  } catch (err) {
    stats.failures += 1;
    log.warn({ err }, 'mention scan tick failed');
  } finally {
    running = false;
  }
  return stats;
}

/** Test seam: reset the process-local re-entrancy/rotation state between cases. */
export function __resetMentionScanState(): void {
  running = false;
  rotationCursor = 0;
}
