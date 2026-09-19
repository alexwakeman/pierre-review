// ── MY TURN SETTINGS, READ SERVER-SIDE (CORE, free, no AI) ─────────────────────────────────
//
// The account's stored overrides (`accounts.my_turn_settings`), resolved through the ONE shared
// resolver (`resolveMyTurnSettings`, packages/shared/src/my-turn-settings.ts). Every server reader
// comes through here: `getMyTurn` (which types are shown), the Pending ranker (the type order and
// the Do next weights) and the Pro work plan's scorer (the weights).
//
// ⚠ READ STRAIGHT FROM `accounts`, NEVER FROM THE LOCAL-ACCOUNT CACHE. The cache is the per-request
// hook's copy (auth/account.ts); a server fold that read it would see a save only if the setter
// remembered to refresh it. One indexed read by primary key costs nothing beside the folds it gates.
import { eq } from 'drizzle-orm';
import {
  resolveMyTurnSettings,
  type PendingRankRules,
  type ResolvedMyTurnSettings,
} from '@pierre-review/shared';
import { db, schema } from './client.js';

/** The account's My Turn settings, resolved (the product defaults where nothing is stored). */
export async function getMyTurnSettings(accountId: number): Promise<ResolvedMyTurnSettings> {
  const rows = await db
    .select({ settings: schema.accounts.myTurnSettings })
    .from(schema.accounts)
    .where(eq(schema.accounts.id, accountId))
    .limit(1)
    .execute();
  return resolveMyTurnSettings(rows[0]?.settings ?? null);
}

/** The ranking an `/api/attention` response was built with — what every explanation on the board
 *  must print, rather than the product constants. */
export function rankRulesOf(s: ResolvedMyTurnSettings): PendingRankRules {
  return {
    weights: s.weights,
    preset: s.preset,
    myTurnOrder: [...s.order],
    myTurnOff: [...s.off],
  };
}
