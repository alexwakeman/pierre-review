// The My Turn settings RULES — resolve, validate, compact — pure, no database.
//
// They live in packages/shared (my-turn-settings.ts) because the Settings form and the server must
// answer every one of these questions identically: the form builds its body with
// `compactMyTurnSettings` and shows `validateMyTurnSettings`' sentence before it sends, and the
// server applies both again before it stores. The shared package has no test runner of its own, so
// the rules are pinned here, beside the backend reader that resolves them.
//
// WHAT EACH PIN GUARDS, and why it would fail silently otherwise:
//   1. A STORED ROW DEGRADES PART BY PART. A malformed part (a bad scope, an unknown or repeated
//      order entry, weights that do not sum to 100) falls back to its default ALONE — a resolver
//      that threw, or discarded the whole row, would reset a reader's other choices with no error.
//   2. OVERRIDES ONLY. A save of the defaults stores NULL, so a later change to a default reaches
//      everyone who never changed it; a compaction that kept a default would freeze it forever.
//   3. `configKey` CHANGES WITH WHAT IS SHOWN, NEVER WITH ORDER OR WEIGHTS. The notification watcher
//      re-baselines on it; one that moved on a re-order would swallow a real notification, and one
//      that did not move on a switch would fire the whole backlog of a type just switched on.
import { describe, expect, it } from 'vitest';
import {
  DO_NEXT_PRESETS,
  DO_NEXT_PRESET_ORDER,
  DO_NEXT_RULES,
  MY_TURN_DEFAULT_ORDER,
  compactMyTurnSettings,
  presetOf,
  resolveMyTurnSettings,
  validateMyTurnSettings,
  type MyTurnCardReason,
  type MyTurnSettings,
} from '@pierre-review/shared';

/** The six types that are off before anyone changes anything, in the default order. */
const DEFAULT_OFF: MyTurnCardReason[] = [
  'own_ci_red',
  'own_conflicts',
  'trunk_red',
  'own_ready',
  'own_thread',
  'watched_repo_pr',
];

/** A stored value that did not come through the validator (an old row, a hand edit). */
const stored = (v: unknown): MyTurnSettings => v as MyTurnSettings;

describe('resolveMyTurnSettings', () => {
  it('resolves NULL to the product defaults', () => {
    const r = resolveMyTurnSettings(null);
    expect(r.order).toEqual([...MY_TURN_DEFAULT_ORDER]);
    expect(r.off).toEqual(DEFAULT_OFF);
    expect(r.trunkScope).toBe('off');
    expect(r.preset).toBe('balanced');
    expect(r.weightsPct).toEqual(DO_NEXT_PRESETS.balanced);
    expect(r.weights).toEqual({ proximity: 0.5, stall: 0.3, relevance: 0.2 });
    expect(r.defaults).toEqual({ show: true, trunkScope: true, order: true, weights: true });
    // The summonses are on; the survey and the promotions are off.
    expect(r.show.review_request).toBe(true);
    expect(r.show.mention).toBe(true);
    expect(r.show.pushed_since).toBe(true);
    expect(r.show.watched_repo_pr).toBe(false);
    expect(r.show.own_ci_red).toBe(false);
  });

  it('degrades each malformed part ALONE, keeping the others', () => {
    const r = resolveMyTurnSettings(
      stored({
        show: { mention: false, watched_repo_pr: 'yes', nonsense: true },
        trunkScope: 'everywhere',
        order: ['your_pr', 'nonsense', 'your_pr', 'mention'],
        weights: { proximity: 50, stall: 30, relevance: 10 },
      }),
    );
    // A valid toggle survives beside an invalid one, which falls back to its default.
    expect(r.show.mention).toBe(false);
    expect(r.show.watched_repo_pr).toBe(false);
    expect(r.trunkScope).toBe('off');
    // Unknown and repeated entries are dropped; the rest keep their stored order.
    expect(r.order.slice(0, 2)).toEqual(['your_pr', 'mention']);
    expect(new Set(r.order).size).toBe(15);
    // 50 + 30 + 10 = 90: the weights fall back, and nothing else does.
    expect(r.weightsPct).toEqual(DO_NEXT_PRESETS.balanced);
    expect(r.off).toContain('mention');
  });

  it('completes a partial order in the default order', () => {
    const r = resolveMyTurnSettings({ order: ['watched_repo_pr', 'claude_review'] });
    expect(r.order).toEqual([
      'watched_repo_pr',
      'claude_review',
      ...MY_TURN_DEFAULT_ORDER.filter((x) => x !== 'watched_repo_pr' && x !== 'claude_review'),
    ]);
    expect(r.defaults.order).toBe(false);
  });

  it('reads trunk_red as off exactly when its scope is off', () => {
    expect(resolveMyTurnSettings({ trunkScope: 'maintained' }).off).not.toContain('trunk_red');
    expect(resolveMyTurnSettings({ trunkScope: 'all' }).off).not.toContain('trunk_red');
    expect(resolveMyTurnSettings({ trunkScope: 'off' }).off).toContain('trunk_red');
  });

  it('derives the preset from the weights — an exact match, else custom', () => {
    for (const p of DO_NEXT_PRESET_ORDER) {
      expect(resolveMyTurnSettings({ weights: DO_NEXT_PRESETS[p] }).preset).toBe(p);
      expect(presetOf(DO_NEXT_PRESETS[p])).toBe(p);
    }
    expect(presetOf({ proximity: 40, stall: 30, relevance: 30 })).toBe('custom');
    expect(resolveMyTurnSettings({ weights: { proximity: 30, stall: 10, relevance: 60 } }).weights).toEqual(
      { proximity: 0.3, stall: 0.1, relevance: 0.6 },
    );
  });
});

describe('validateMyTurnSettings — one plain sentence per problem', () => {
  const cases: [string, unknown, string][] = [
    ['an unknown type in show', { show: { nonsense: true } }, '“nonsense” is not a My Turn card type.'],
    [
      'trunk_red in show (it has a scope, not a switch)',
      { show: { trunk_red: true } },
      '“trunk_red” is not a My Turn card type.',
    ],
    ['a non-boolean switch', { show: { mention: 'on' } }, 'Each card type must be on or off.'],
    [
      'an unknown scope',
      { trunkScope: 'everywhere' },
      'Red default branch must be Off, Repos you maintain or Every repo.',
    ],
    ['an order that is not a list', { order: 'mention' }, 'The order must be a list of card types.'],
    ['an unknown order entry', { order: ['mention', 'nope'] }, '“nope” is not a My Turn card type.'],
    [
      'a repeated order entry',
      { order: ['mention', 'mention'] },
      'Each card type can appear in the order once.',
    ],
    ['a missing weight', { weights: { proximity: 50, stall: 50 } }, 'Set all three weights.'],
    [
      'a weight off the 10% steps',
      { weights: { proximity: 55, stall: 25, relevance: 20 } },
      'Each weight must be 0 to 100%, in steps of 10.',
    ],
    [
      'a weight out of range',
      { weights: { proximity: 110, stall: -10, relevance: 0 } },
      'Each weight must be 0 to 100%, in steps of 10.',
    ],
    [
      'weights that do not add up',
      { weights: { proximity: 50, stall: 30, relevance: 10 } },
      'The three weights must add up to 100%.',
    ],
  ];
  for (const [name, value, sentence] of cases) {
    it(`rejects ${name}`, () => {
      expect(validateMyTurnSettings(stored(value))).toBe(sentence);
    });
  }

  it('accepts every valid part, and the empty object', () => {
    expect(validateMyTurnSettings({})).toBeNull();
    expect(
      validateMyTurnSettings({
        show: { watched_repo_pr: true, mention: false },
        trunkScope: 'maintained',
        order: ['mention', 'review_request'],
        weights: DO_NEXT_PRESETS.mine_first,
      }),
    ).toBeNull();
  });
});

describe('compactMyTurnSettings — overrides only', () => {
  it('stores nothing for the defaults, however they are spelled', () => {
    expect(compactMyTurnSettings(null)).toBeNull();
    expect(compactMyTurnSettings({})).toBeNull();
    expect(
      compactMyTurnSettings({
        show: { mention: true, watched_repo_pr: false },
        trunkScope: 'off',
        order: [...MY_TURN_DEFAULT_ORDER],
        weights: DO_NEXT_PRESETS.balanced,
      }),
    ).toBeNull();
  });

  it('keeps one changed switch and nothing else', () => {
    expect(compactMyTurnSettings({ show: { watched_repo_pr: true, mention: true } })).toEqual({
      show: { watched_repo_pr: true },
    });
  });

  it('stores a changed order as all fifteen types', () => {
    const out = compactMyTurnSettings({ order: ['your_pr'] });
    expect(out?.order).toHaveLength(15);
    expect(out?.order?.[0]).toBe('your_pr');
  });

  it('keeps a non-default scope and non-Balanced weights', () => {
    expect(
      compactMyTurnSettings({ trunkScope: 'all', weights: DO_NEXT_PRESETS.quick_wins }),
    ).toEqual({ trunkScope: 'all', weights: DO_NEXT_PRESETS.quick_wins });
  });

  it('serialises two equal settings identically, whatever order their keys arrived in', () => {
    const a = compactMyTurnSettings({ weights: DO_NEXT_PRESETS.mine_first, trunkScope: 'all' });
    const b = compactMyTurnSettings({ trunkScope: 'all', weights: DO_NEXT_PRESETS.mine_first });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('the weights', () => {
  it('keeps the product default and the Balanced preset one number', () => {
    const w = DO_NEXT_RULES.weights;
    expect({
      proximity: Math.round(w.proximity * 100),
      stall: Math.round(w.stall * 100),
      relevance: Math.round(w.relevance * 100),
    }).toEqual(DO_NEXT_PRESETS.balanced);
  });

  it('gives every preset whole 10% steps that add up to 100%', () => {
    for (const p of DO_NEXT_PRESET_ORDER) {
      expect(validateMyTurnSettings({ weights: DO_NEXT_PRESETS[p] })).toBeNull();
    }
  });
});

describe('configKey', () => {
  const key = (s: MyTurnSettings | null) => resolveMyTurnSettings(s).configKey;

  it('changes when a type is switched, or the trunk scope moves', () => {
    expect(key({ show: { watched_repo_pr: true } })).not.toBe(key(null));
    expect(key({ show: { mention: false } })).not.toBe(key(null));
    expect(key({ trunkScope: 'maintained' })).not.toBe(key(null));
    expect(key({ trunkScope: 'maintained' })).not.toBe(key({ trunkScope: 'all' }));
  });

  it('does NOT change with the order or the weights', () => {
    expect(key({ order: ['watched_repo_pr', 'mention'] })).toBe(key(null));
    expect(key({ weights: DO_NEXT_PRESETS.oldest_first })).toBe(key(null));
  });
});
