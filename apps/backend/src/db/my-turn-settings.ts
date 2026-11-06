// ── MY TURN SETTINGS, READ SERVER-SIDE (CORE, free, no AI) ─────────────────────────────────
//
// The account's stored value (`accounts.my_turn_settings`), resolved through the ONE shared
// resolver (`resolveMyTurnSettings`, packages/shared/src/my-turn-settings.ts). One switch is left —
// "Also show new PRs nobody asked you about" — and `getMyTurn` is its only reader. The ranking
// weights and the My Turn type order are fixed in code (`DO_NEXT_RULES.weights`, `MY_TURN_ORDER`);
// an old stored `weights` / `order` / type switch is ignored.
//
// ⚠ READ STRAIGHT FROM `accounts`, NEVER FROM THE LOCAL-ACCOUNT CACHE. The cache is the per-request
// hook's copy (auth/account.ts); a server fold that read it would see a save only if the setter
// remembered to refresh it. One indexed read by primary key costs nothing beside the folds it gates.
import { eq } from 'drizzle-orm';
import {
  DO_NEXT_RULES,
  resolveMyTurnSettings,
  type PendingRankRules,
  type ResolvedMyTurnSettings,
} from '@pierre-review/shared';
import { db, schema } from './client.js';

/** The account's My Turn settings, resolved (the product default where nothing is stored). */
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
 *  prints. The weights are fixed; only `myTurnOff` follows the reader's one switch. */
export function rankRulesOf(s: ResolvedMyTurnSettings): PendingRankRules {
  return {
    weights: { ...DO_NEXT_RULES.weights },
    myTurnOrder: [...s.order],
    myTurnOff: [...s.off],
  };
}
