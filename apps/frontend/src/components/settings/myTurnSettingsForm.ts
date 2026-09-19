import {
  compactMyTurnSettings,
  DO_NEXT_PRESETS,
  MY_TURN_DEFAULT_ORDER,
  resolveMyTurnSettings,
  validateMyTurnSettings,
  type DoNextPreset,
  type DoNextWeightsPct,
  type MyTurnCardReason,
  type MyTurnSettings,
  type MyTurnToggle,
  type MyTurnTrunkScope,
} from '@pierre-review/shared';

// The Settings → My Turn form, as pure functions so `test/myTurnSettingsForm.test.ts` can pin them
// without a renderer (the `flowSettingsForm.ts` precedent).
//
// ⚠ THE SERVER STORES OVERRIDES ONLY, AND "ONLY" IS DECIDED BY THE SHARED `compactMyTurnSettings`
// — on this side to build the body and on the server again before it stores. A form that sent
// every field would freeze today's defaults into the account of everyone who merely opened
// Settings and pressed Save, and a later change to a default would never reach them.
//
// ⚠ THE WEIGHTS ARE WHOLE TENS THAT ADD UP TO 100, AND THE SLIDERS KEEP THEM THAT WAY. Every
// Do next part is a multiple of 0.05, so a part × weight is exact at one decimal only when the
// weight is a multiple of 0.1 — which is what lets a card's info popover print working that adds
// up to its score. Moving one slider re-shares the rest between the other two (`rebalanceWeights`),
// so the three can never be saved out of balance — always from where that slide began
// (`slideWeight`), so a slider taken out and back leaves the other two as they were.

export interface MyTurnForm {
  show: Record<MyTurnToggle, boolean>;
  trunkScope: MyTurnTrunkScope;
  /** All fifteen types, in the reader's order. */
  order: MyTurnCardReason[];
  weights: DoNextWeightsPct;
}

export type WeightKey = keyof DoNextWeightsPct;

/** The three weights in the one fixed order the sliders and the re-share use. */
export const WEIGHT_KEYS: readonly WeightKey[] = ['proximity', 'stall', 'relevance'];

/** Each weight's name — the ONE spelling, read by the Settings sliders AND by the board's
 *  explanations (a card's score rows, the guide's table, the header popover, Help), so the rows a
 *  reader sees on the board are the sliders they move here. */
export const WEIGHT_LABEL: Record<WeightKey, string> = {
  proximity: 'How close to done',
  stall: 'How long it has waited',
  relevance: 'How much it is about you',
};

/** A weight's name mid-sentence: its slider label, lower-cased ("how long it has waited"). */
export function weightPhrase(k: WeightKey): string {
  return WEIGHT_LABEL[k].charAt(0).toLowerCase() + WEIGHT_LABEL[k].slice(1);
}

/** Each preset's name — the ONE spelling, read by Settings and by the board's explanations. */
export const PRESET_LABEL: Record<DoNextPreset, string> = {
  balanced: 'Balanced',
  mine_first: 'Mine first',
  oldest_first: 'Oldest first',
  quick_wins: 'Quick wins',
};

/** One line under the preset pills, for the selected preset only.
 *  ⚠ A WEIGHTING, NEVER AN ORDER. A preset leans the score toward one part; it does not sort by it
 *  (an approved PR in a repo you maintain outscores your own unapproved one under Mine first), so
 *  "X comes first" would be false on the board it describes. Each names the slider it leans on. */
export const PRESET_DESC: Record<DoNextPreset, string> = {
  balanced: 'The default.',
  mine_first: `Most weight on “${WEIGHT_LABEL.relevance}”.`,
  oldest_first: `Most weight on “${WEIGHT_LABEL.stall}”.`,
  quick_wins: `Most weight on “${WEIGHT_LABEL.proximity}”.`,
};

/** "Show in My Turn" — the types that are summonses, each with the one line that says when. */
export const SHOW_ROWS: readonly { reason: MyTurnToggle; hint: string }[] = [
  { reason: 'review_request', hint: 'Someone asked you to review.' },
  { reason: 'mention', hint: 'Someone mentioned you on an open PR.' },
  { reason: 'thread', hint: 'A reply, or a new commit, on your review thread.' },
  { reason: 'thread_reply', hint: 'Someone answered your comment in a review thread.' },
  { reason: 'comment_reply', hint: 'Someone commented after your last comment on a PR.' },
  { reason: 'pushed_since', hint: 'Someone pushed after your review or comment.' },
  // ⚠ NOT "ready to merge": the type checks the approval, never the merge state (most approved PRs
  // conflict or are blocked), and with "Your PRs ready to land" on, the mergeable ones move there.
  { reason: 'pr_approved', hint: 'Your PR has an approval and no “changes requested”.' },
  { reason: 'your_pr', hint: 'Since you last opened them here.' },
  { reason: 'claude_review', hint: 'Findings you have not posted.' },
  { reason: 'watched_repo_pr', hint: 'Open PRs in your repos you have not touched.' },
];

/** "Add to My Turn" — your own work that otherwise sits in another tab. Off by default. */
export const ADD_ROWS: readonly MyTurnToggle[] = [
  'own_ci_red',
  'own_conflicts',
  'own_ready',
  'own_thread',
];

/** The red-default-branch scope, as the radio group names it. */
export const TRUNK_SCOPE_LABEL: Record<MyTurnTrunkScope, string> = {
  off: 'Off',
  maintained: 'Repos you maintain',
  all: 'Every repo in the workspace',
};

/** The form as it opens: whatever is stored, and the defaults everywhere else. */
export function seedMyTurnForm(stored: MyTurnSettings | null | undefined): MyTurnForm {
  const r = resolveMyTurnSettings(stored);
  return {
    show: { ...r.show },
    trunkScope: r.trunkScope,
    order: [...r.order],
    weights: { ...r.weightsPct },
  };
}

/** What one Save sends: the overrides, or `null` when the form is the product default. */
export function buildMyTurnSettingsBody(form: MyTurnForm): MyTurnSettings | null {
  return compactMyTurnSettings({
    show: form.show,
    trunkScope: form.trunkScope,
    order: form.order,
    weights: form.weights,
  });
}

/** Does the form differ from what is stored? Compares the two OVERRIDE sets, so reopening Settings
 *  and saving an untouched form is never a change. (`compactMyTurnSettings` emits its keys in one
 *  fixed order, which is what makes the string comparison sound.) */
export function myTurnFormDirty(
  form: MyTurnForm,
  stored: MyTurnSettings | null | undefined,
): boolean {
  return (
    JSON.stringify(buildMyTurnSettingsBody(form)) !== JSON.stringify(compactMyTurnSettings(stored))
  );
}

/** The server's own sentence for what is wrong with the form, or null. The controls cannot
 *  normally produce a bad value; this is the same check the route runs, shown before it sends. */
export function myTurnFormProblem(form: MyTurnForm): string | null {
  return validateMyTurnSettings({
    show: form.show,
    trunkScope: form.trunkScope,
    order: form.order,
    weights: form.weights,
  });
}

/** Is this type switched off in the form? A red default branch is off when its scope is. */
export function isOff(form: MyTurnForm, reason: MyTurnCardReason): boolean {
  return reason === 'trunk_red' ? form.trunkScope === 'off' : !form.show[reason];
}

/**
 * Move one type a place up (-1) or down (+1) in the order.
 *
 * `hidden` holds types the reader cannot see in the list (Claude reviews on an install without
 * them): the move steps OVER them to the next visible neighbour, so every press visibly moves the
 * row, and a hidden type keeps its place. A move past either end returns the order unchanged.
 */
export function moveType(
  order: readonly MyTurnCardReason[],
  reason: MyTurnCardReason,
  dir: -1 | 1,
  hidden: ReadonlySet<MyTurnCardReason> = new Set(),
): MyTurnCardReason[] {
  const out = [...order];
  const i = out.indexOf(reason);
  if (i < 0) return out;
  let j = i + dir;
  while (j >= 0 && j < out.length && hidden.has(out[j]!)) j += dir;
  if (j < 0 || j >= out.length) return out;
  out[i] = out[j]!;
  out[j] = reason;
  return out;
}

/**
 * Set one weight and re-share what is left between the other two, in proportion to what they held
 * (evenly when both held nothing). The result is whole tens that add up to 100.
 *
 * 50/30/20 with the first moved to 60 → 60/20/20; any weight moved to 100 → the others 0/0.
 */
export function rebalanceWeights(
  w: DoNextWeightsPct,
  key: WeightKey,
  value: number,
): DoNextWeightsPct {
  const v = Math.min(100, Math.max(0, Math.round(value / 10) * 10));
  const [a, b] = WEIGHT_KEYS.filter((k) => k !== key) as [WeightKey, WeightKey];
  const rest = 100 - v;
  const held = w[a] + w[b];
  const raw = held === 0 ? Math.round(rest / 20) * 10 : Math.round((rest * w[a]) / held / 10) * 10;
  const na = Math.min(rest, Math.max(0, raw));
  return { ...w, [key]: v, [a]: na, [b]: rest - na } as DoNextWeightsPct;
}

/** One slider's slide: which slider, the weights it started from, and what it last produced. */
export interface WeightSlide {
  key: WeightKey;
  from: DoNextWeightsPct;
  to: DoNextWeightsPct;
}

/**
 * A weight slider moved. Re-share from the weights the SLIDE STARTED FROM, never from the last
 * step's: every step rounds to tens, and re-sharing weights that were already rounded compounds it.
 * Chained, 50/30/20 dragged to 80 and back landed on 50/40/10 — the preset flipped to Custom and a
 * Save would have stored weights on two sliders nobody touched.
 *
 * The slide carries on while the weights are still what it last produced for the same slider.
 * Anything else — another slider, a preset, Reset, a re-seed — starts a new one from the weights as
 * they stand.
 */
export function slideWeight(
  slide: WeightSlide | null,
  current: DoNextWeightsPct,
  key: WeightKey,
  value: number,
): WeightSlide {
  const carryOn =
    slide != null && slide.key === key && WEIGHT_KEYS.every((k) => slide.to[k] === current[k]);
  const from = carryOn ? slide.from : current;
  return { key, from, to: rebalanceWeights(from, key, value) };
}

/** What a screen reader hears after a move: where the row went, counted over the rows on screen. */
export function movedTypeAnnouncement(
  order: readonly MyTurnCardReason[],
  reason: MyTurnCardReason,
  label: string,
  hidden: ReadonlySet<MyTurnCardReason> = new Set(),
): string {
  const visible = order.filter((r) => !hidden.has(r));
  return `“${label}” moved to ${visible.indexOf(reason) + 1} of ${visible.length}.`;
}

/** A preset's weights, as the form holds them. */
export function presetWeights(p: DoNextPreset): DoNextWeightsPct {
  return { ...DO_NEXT_PRESETS[p] };
}

/** "Reset": the order and the weights go back to the product default. The switches are left
 *  alone — each has its own obvious undo, and a reset that also re-enabled a type the reader had
 *  switched off would be a surprise. */
export function resetOrderAndWeights(form: MyTurnForm): MyTurnForm {
  return { ...form, order: [...MY_TURN_DEFAULT_ORDER], weights: presetWeights('balanced') };
}
