// MY TURN SETTINGS — which card types count as your turn, the order My turn lists them in, and
// the Do next weights every Pending tab ranks by. PER ACCOUNT: one account is one reader, and the
// settings apply in every workspace.
//
// ⚠ STORED AS OVERRIDES, RESOLVED IN ONE PLACE. `accounts.my_turn_settings` is NULL until the
// reader changes something, and then holds only what they changed. `resolveMyTurnSettings` fills
// the rest from the product defaults below, so a later change to a default reaches everyone who
// never changed it (the blast-radius and flow-settings precedent). `getMyTurn`, the Pending ranker,
// the Settings form and the CLI all resolve through this one function.
//
// ⚠ A TYPE SWITCHED OFF IS REMOVED, NOT HIDDEN. The gate runs inside `getMyTurn`, so the list,
// every count, the daily brief and the notifications shrink together. (Relevance still narrows
// nothing — see `MyTurnRelevance`.)
//
// ⚠ `compactMyTurnSettings` IS THE ONE DEFINITION OF "AN OVERRIDE", on both sides: the SPA builds
// its request body with it and the server applies it again before storing, so a Save can never
// freeze a default into the row.

import type { MyTurnCardReason } from './types.js';
import {
  DO_NEXT_PRESETS,
  DO_NEXT_PRESET_ORDER,
  type DoNextPreset,
  type DoNextWeights,
  type DoNextWeightsPct,
} from './pending-rules.js';

/** A card type with an on/off switch. A red default branch has a three-way scope instead. */
export type MyTurnToggle = Exclude<MyTurnCardReason, 'trunk_red'>;
/** Which red default branches become My Turn cards: none, repos you maintain, or every repo in
 *  the workspace. */
export type MyTurnTrunkScope = 'off' | 'maintained' | 'all';

/** What `accounts.my_turn_settings` holds: only what the reader changed. NULL = all defaults. */
export interface MyTurnSettings {
  show?: Partial<Record<MyTurnToggle, boolean>>;
  trunkScope?: MyTurnTrunkScope;
  /** A permutation (or a prefix of one) of MyTurnCardReason. Stored normalised to all fifteen. */
  order?: MyTurnCardReason[];
  weights?: DoNextWeightsPct;
}

/** The settings in force, every field filled, with which parts are still the defaults. */
export interface ResolvedMyTurnSettings {
  show: Record<MyTurnToggle, boolean>;
  trunkScope: MyTurnTrunkScope;
  /** All fifteen types, in the reader's order. */
  order: MyTurnCardReason[];
  /** The types switched off (`trunk_red` when the scope is 'off'), in `order`. */
  off: MyTurnCardReason[];
  weightsPct: DoNextWeightsPct;
  /** `weightsPct` / 100 — what the ranker multiplies by. */
  weights: DoNextWeights;
  /** Derived from the weights, never stored. */
  preset: DoNextPreset | 'custom';
  /** True where the part equals the product default — Settings says "default" beside it. */
  defaults: { show: boolean; trunkScope: boolean; order: boolean; weights: boolean };
  /** Changes exactly when WHICH TYPES ARE SHOWN changes — never with the order or the weights.
   *  The notification watcher re-baselines on it, so switching a type on does not announce its
   *  whole existing backlog. */
  configKey: string;
}

/**
 * THE DEFAULT TYPE ORDER: people waiting on you first (asked, named, answered), then new code to
 * re-read, then your own broken things, then your own ready things, then FYI.
 */
export const MY_TURN_DEFAULT_ORDER: readonly MyTurnCardReason[] = [
  'review_request',
  'mention',
  'thread',
  'thread_reply',
  'comment_reply',
  'pushed_since',
  'own_ci_red',
  'own_conflicts',
  'trunk_red',
  'pr_approved',
  'own_ready',
  'your_pr',
  'own_thread',
  'claude_review',
  'watched_repo_pr',
];

export const MY_TURN_TOGGLES: readonly MyTurnToggle[] = MY_TURN_DEFAULT_ORDER.filter(
  (r): r is MyTurnToggle => r !== 'trunk_red',
);

export const MY_TURN_TRUNK_SCOPES: readonly MyTurnTrunkScope[] = ['off', 'maintained', 'all'];

/** What shows before the reader changes anything. Untouched PRs by others and the own-work
 *  promotions are OFF: the first is a survey of the workspace, not a summons, and the others
 *  already have a tab of their own. */
export const MY_TURN_SHOW_DEFAULTS: Readonly<Record<MyTurnToggle, boolean>> = {
  review_request: true,
  mention: true,
  thread: true,
  thread_reply: true,
  comment_reply: true,
  pushed_since: true,
  own_ci_red: false,
  own_conflicts: false,
  pr_approved: true,
  own_ready: false,
  your_pr: true,
  own_thread: false,
  claude_review: true,
  watched_repo_pr: false,
};

/** The promotions — My Turn cards that MOVE out of another tab when switched on. The Pro sprint
 *  report skips these for the same reason it skips their home kinds. */
export const MY_TURN_OWN_WORK_REASONS: ReadonlySet<MyTurnCardReason> = new Set<MyTurnCardReason>([
  'own_ci_red',
  'own_conflicts',
  'own_ready',
  'own_thread',
  'trunk_red',
]);

/** The ONE spelling of each type's name in Settings, the CLI footer and the guide. */
export const MY_TURN_SETTING_LABEL: Readonly<Record<MyTurnCardReason, string>> = {
  review_request: 'Review requests',
  mention: '@mentions of you',
  thread: 'Replies in threads you started',
  thread_reply: 'Replies to your comments in other threads',
  comment_reply: 'Comments after yours on a PR',
  pushed_since: 'New commits since you reviewed',
  own_ci_red: 'Failing builds on your PRs',
  own_conflicts: 'Merge conflicts on your PRs',
  trunk_red: 'Red default branch',
  pr_approved: 'Your PRs that are approved',
  own_ready: 'Your PRs ready to land',
  your_pr: 'New activity on your PRs',
  own_thread: 'Unanswered threads on your PRs',
  claude_review: 'Finished Claude reviews',
  watched_repo_pr: 'New PRs nobody asked you about',
};

const WEIGHT_KEYS = ['proximity', 'stall', 'relevance'] as const;

/** The named preset these weights are, or 'custom' — an exact match on all three. */
export function presetOf(w: DoNextWeightsPct): DoNextPreset | 'custom' {
  for (const p of DO_NEXT_PRESET_ORDER) {
    const q = DO_NEXT_PRESETS[p];
    if (WEIGHT_KEYS.every((k) => q[k] === w[k])) return p;
  }
  return 'custom';
}

/**
 * Resolve stored overrides against the defaults.
 *
 * Defensive against a malformed stored value: each part that would not pass
 * `validateMyTurnSettings` falls back to its default ALONE, so a bad row degrades rather than
 * throwing or producing nonsense (the `resolveFlowSettings` rule). An order that omits some types
 * (a prefix, or one stored before a type existed) is completed in default order.
 */
export function resolveMyTurnSettings(
  raw: MyTurnSettings | null | undefined,
): ResolvedMyTurnSettings {
  const s: MyTurnSettings = isRecord(raw) ? raw : {};
  const storedShow: Record<string, unknown> = isRecord(s.show) ? s.show : {};
  const show = {} as Record<MyTurnToggle, boolean>;
  for (const k of MY_TURN_TOGGLES) {
    const v = storedShow[k];
    show[k] = typeof v === 'boolean' ? v : MY_TURN_SHOW_DEFAULTS[k];
  }
  const trunkScope: MyTurnTrunkScope = isTrunkScope(s.trunkScope) ? s.trunkScope : 'off';
  const order = completeOrder(s.order);
  const weightsPct: DoNextWeightsPct =
    s.weights !== undefined && weightsProblem(s.weights) === null
      ? { proximity: s.weights.proximity, stall: s.weights.stall, relevance: s.weights.relevance }
      : { ...DO_NEXT_PRESETS.balanced };
  const preset = presetOf(weightsPct);
  const off = order.filter((r) => (r === 'trunk_red' ? trunkScope === 'off' : !show[r]));
  return {
    show,
    trunkScope,
    order,
    off,
    weightsPct,
    weights: {
      proximity: weightsPct.proximity / 100,
      stall: weightsPct.stall / 100,
      relevance: weightsPct.relevance / 100,
    },
    preset,
    defaults: {
      show: MY_TURN_TOGGLES.every((k) => show[k] === MY_TURN_SHOW_DEFAULTS[k]),
      trunkScope: trunkScope === 'off',
      order: order.every((r, i) => r === MY_TURN_DEFAULT_ORDER[i]),
      weights: preset === 'balanced',
    },
    configKey: `${[...off].sort().join(',')}|${trunkScope}`,
  };
}

/**
 * The ONE validator for a settings write — the route rejects with the first problem, and the
 * Settings form shows the same sentence before it ever sends. Returns null when the value is fine.
 */
export function validateMyTurnSettings(s: MyTurnSettings): string | null {
  if (s.show !== undefined) {
    if (!isRecord(s.show)) return 'Each card type must be on or off.';
    for (const [k, v] of Object.entries(s.show)) {
      if (!isToggle(k)) return `“${k}” is not a My Turn card type.`;
      if (v !== undefined && typeof v !== 'boolean') return 'Each card type must be on or off.';
    }
  }
  if (s.trunkScope !== undefined && !isTrunkScope(s.trunkScope)) {
    return 'Red default branch must be Off, Repos you maintain or Every repo.';
  }
  if (s.order !== undefined) {
    if (!Array.isArray(s.order)) return 'The order must be a list of card types.';
    const seen = new Set<string>();
    for (const r of s.order as unknown[]) {
      if (!isReason(r)) return `“${String(r)}” is not a My Turn card type.`;
      if (seen.has(r)) return 'Each card type can appear in the order once.';
      seen.add(r);
    }
  }
  if (s.weights !== undefined) return weightsProblem(s.weights);
  return null;
}

/**
 * Overrides only: what differs from the product default, and nothing else — `null` when nothing
 * does. A `show` entry equal to its default is dropped, a trunk scope of 'off' is dropped, the
 * order is stored as the resolved full order (all fifteen) or dropped when it is the default, and
 * Balanced weights are dropped. Keys come out in one fixed order, so two compactions of the same
 * settings serialise identically (the Settings form's "unsaved changes" test compares them).
 *
 * Validate first: a part `validateMyTurnSettings` would reject resolves to its default here, so it
 * is dropped — never stored.
 */
export function compactMyTurnSettings(s: MyTurnSettings | null | undefined): MyTurnSettings | null {
  const r = resolveMyTurnSettings(s);
  const out: MyTurnSettings = {};
  const show: Partial<Record<MyTurnToggle, boolean>> = {};
  for (const k of MY_TURN_TOGGLES) if (r.show[k] !== MY_TURN_SHOW_DEFAULTS[k]) show[k] = r.show[k];
  if (Object.keys(show).length > 0) out.show = show;
  if (!r.defaults.trunkScope) out.trunkScope = r.trunkScope;
  if (!r.defaults.order) out.order = r.order;
  if (!r.defaults.weights) out.weights = r.weightsPct;
  return Object.keys(out).length > 0 ? out : null;
}

function weightsProblem(w: unknown): string | null {
  if (!isRecord(w) || WEIGHT_KEYS.some((k) => w[k] === undefined)) return 'Set all three weights.';
  if (!WEIGHT_KEYS.every((k) => isWeightStep(w[k]))) {
    return 'Each weight must be 0 to 100%, in steps of 10.';
  }
  const sum = WEIGHT_KEYS.reduce((acc, k) => acc + (w[k] as number), 0);
  return sum === 100 ? null : 'The three weights must add up to 100%.';
}

function isWeightStep(v: unknown): boolean {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 100 && v % 10 === 0;
}

function completeOrder(stored: unknown): MyTurnCardReason[] {
  const order: MyTurnCardReason[] = [];
  if (Array.isArray(stored)) {
    for (const r of stored as unknown[]) if (isReason(r) && !order.includes(r)) order.push(r);
  }
  for (const r of MY_TURN_DEFAULT_ORDER) if (!order.includes(r)) order.push(r);
  return order;
}

function isReason(v: unknown): v is MyTurnCardReason {
  return typeof v === 'string' && (MY_TURN_DEFAULT_ORDER as readonly string[]).includes(v);
}

function isToggle(v: unknown): v is MyTurnToggle {
  return typeof v === 'string' && (MY_TURN_TOGGLES as readonly string[]).includes(v);
}

function isTrunkScope(v: unknown): v is MyTurnTrunkScope {
  return typeof v === 'string' && (MY_TURN_TRUNK_SCOPES as readonly string[]).includes(v);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
