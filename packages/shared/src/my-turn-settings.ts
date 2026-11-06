// MY TURN SETTINGS — ONE switch: "Also show new PRs nobody asked you about". PER ACCOUNT: one
// account is one reader, and the setting applies in every workspace.
//
// Everything else about My Turn is FIXED in code (docs/BACKEND.md § My Turn): which card types
// exist, the three groups and their order (`MY_TURN_ORDER`, `MY_TURN_GROUP_OF` in pending-rules.ts)
// and the Do next weights every Pending tab ranks by (`DO_NEXT_RULES.weights`). Type switches, a
// type order and ranking weights once lived here; a stored `show`, `order` or `weights` from that
// time is IGNORED on read (never migrated — the column keeps it), except `show.watched_repo_pr`,
// which is this switch.
//
// ⚠ STORED AS `{ show: { watched_repo_pr: true } }` when on and NULL when off, so a row written
// before the redesign and a row written after it are read by one rule.

import type { MyTurnCardReason } from './types.js';
import { MY_TURN_ORDER } from './pending-rules.js';

/** The reader's My Turn settings — what `MeResponse.myTurnSettings` carries and
 *  `PUT /api/me/my-turn-settings` takes. */
export interface MyTurnSettings {
  /** "Also show new PRs nobody asked you about" — the `watched_repo_pr` survey. Off by default. */
  showNewPrs: boolean;
}

/** The settings in force, as the server folds read them. */
export interface ResolvedMyTurnSettings extends MyTurnSettings {
  /** Every card type, in the fixed order (`MY_TURN_ORDER`). */
  order: MyTurnCardReason[];
  /** The types not shown: the survey while it is off. */
  off: MyTurnCardReason[];
  /** Changes exactly when WHICH TYPES ARE SHOWN changes. The notification watcher re-baselines on
   *  it, so switching the survey on does not announce its whole existing backlog. */
  configKey: string;
}

/** What `accounts.my_turn_settings` may hold: the current `{ show: { watched_repo_pr: true } }`,
 *  or an older blob with more keys, which are ignored. Read only through `resolveMyTurnSettings`. */
export type StoredMyTurnSettings = Record<string, unknown>;

/** The stored value for these settings: the legacy-compatible override, or null for the default. */
export function storedMyTurnSettings(s: MyTurnSettings): StoredMyTurnSettings | null {
  return s.showNewPrs ? { show: { watched_repo_pr: true } } : null;
}

/**
 * Resolve whatever `accounts.my_turn_settings` holds. Defensive: any shape — NULL, the current
 * one, one written before the redesign with type switches, an order and weights, or garbage —
 * resolves without throwing. Only `show.watched_repo_pr === true` turns the survey on.
 */
export function resolveMyTurnSettings(raw: unknown): ResolvedMyTurnSettings {
  const show = isRecord(raw) && isRecord(raw.show) ? raw.show : {};
  const showNewPrs = show.watched_repo_pr === true;
  const off: MyTurnCardReason[] = showNewPrs ? [] : ['watched_repo_pr'];
  return {
    showNewPrs,
    order: [...MY_TURN_ORDER],
    off,
    configKey: off.join(','),
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
