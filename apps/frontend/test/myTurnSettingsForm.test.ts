// What one Save on Settings → My Turn sends, and how the form's controls behave.
//
// WHAT THIS PINS, and why each is worth a test:
//
//   1. OVERRIDES ONLY. The server stores what the reader changed and resolves the rest from the
//      product defaults, so a later change to a default reaches everyone who never changed it. A
//      form that sent every field on Save would freeze today's defaults into the account of anyone
//      who merely opened Settings — so an untouched form sends `null`, and one switch sends one key.
//   2. THE WEIGHTS STAY WHOLE TENS THAT ADD UP TO 100, whichever slider moves and wherever it
//      lands. That is what keeps every card's printed score working exact (pendingExplain.test.ts),
//      and the server refuses anything else. And a slider taken out and back leaves the other two
//      where they were: re-sharing each step's already-rounded weights drifted them, so Balanced
//      turned into Custom with one slider touched.
//   3. A MOVE ALWAYS VISIBLY MOVES THE ROW. A type the reader cannot see (Claude reviews, where the
//      capability is off) keeps its place and is stepped over. A screen reader is told where the row
//      went, counted over the rows on screen.
//   4. EVERY SWITCH HAS A ROW. A type added to the shared vocabulary with no row here would be a
//      setting nobody can reach.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/myTurnSettingsForm.test.ts
import { describe, expect, it } from 'vitest';
import {
  DO_NEXT_PRESET_ORDER,
  DO_NEXT_PRESETS,
  MY_TURN_DEFAULT_ORDER,
  MY_TURN_SHOW_DEFAULTS,
  MY_TURN_TOGGLES,
  presetOf,
  type DoNextWeightsPct,
  type MyTurnCardReason,
} from '@pierre-review/shared';
import {
  ADD_ROWS,
  buildMyTurnSettingsBody,
  isOff,
  movedTypeAnnouncement,
  moveType,
  myTurnFormDirty,
  myTurnFormProblem,
  presetWeights,
  rebalanceWeights,
  resetOrderAndWeights,
  seedMyTurnForm,
  SHOW_ROWS,
  slideWeight,
  PRESET_DESC,
  WEIGHT_KEYS,
  WEIGHT_LABEL,
  type WeightKey,
  type WeightSlide,
} from '../src/components/settings/myTurnSettingsForm.js';

describe('overrides only', () => {
  it('opens on the product defaults when nothing is stored', () => {
    const f = seedMyTurnForm(null);
    expect(f.show).toEqual(MY_TURN_SHOW_DEFAULTS);
    expect(f.trunkScope).toBe('off');
    expect(f.order).toEqual(MY_TURN_DEFAULT_ORDER);
    expect(f.weights).toEqual(DO_NEXT_PRESETS.balanced);
  });

  it('sends nothing — null — for an untouched form', () => {
    expect(buildMyTurnSettingsBody(seedMyTurnForm(null))).toBeNull();
    expect(buildMyTurnSettingsBody(seedMyTurnForm(undefined))).toBeNull();
  });

  it('sends one key for one switch', () => {
    const f = seedMyTurnForm(null);
    f.show.watched_repo_pr = true;
    expect(buildMyTurnSettingsBody(f)).toEqual({ show: { watched_repo_pr: true } });
  });

  it('drops a switch put back to its default', () => {
    const f = seedMyTurnForm({ show: { mention: false } });
    f.show.mention = true;
    expect(buildMyTurnSettingsBody(f)).toBeNull();
  });

  it('round-trips what is stored, and nothing more', () => {
    const stored = {
      show: { own_ci_red: true },
      trunkScope: 'maintained' as const,
      weights: DO_NEXT_PRESETS.mine_first,
    };
    expect(buildMyTurnSettingsBody(seedMyTurnForm(stored))).toEqual(stored);
  });

  it('sends a changed order as all fifteen types, and the default order as nothing', () => {
    const f = seedMyTurnForm(null);
    f.order = moveType(f.order, 'mention', -1);
    const body = buildMyTurnSettingsBody(f);
    expect(body?.order).toHaveLength(MY_TURN_DEFAULT_ORDER.length);
    expect(body?.order?.slice(0, 2)).toEqual(['mention', 'review_request']);
    f.order = moveType(f.order, 'mention', 1);
    expect(buildMyTurnSettingsBody(f)).toBeNull();
  });

  it('sends no weights for Balanced, however it was reached', () => {
    const f = seedMyTurnForm({ weights: DO_NEXT_PRESETS.quick_wins });
    f.weights = presetWeights('balanced');
    expect(buildMyTurnSettingsBody(f)).toBeNull();
    // …and by hand, slider by slider.
    const g = seedMyTurnForm({ weights: DO_NEXT_PRESETS.mine_first });
    g.weights = rebalanceWeights(g.weights, 'relevance', 20); // 30/10/60 → 60/20/20
    g.weights = rebalanceWeights(g.weights, 'proximity', 50); // → 50/30/20
    expect(g.weights).toEqual(DO_NEXT_PRESETS.balanced);
    expect(buildMyTurnSettingsBody(g)).toBeNull();
  });

  it('is dirty only when the OVERRIDES differ from what is stored', () => {
    const stored = { show: { own_thread: true } };
    const f = seedMyTurnForm(stored);
    expect(myTurnFormDirty(f, stored)).toBe(false);
    f.show.own_thread = false;
    expect(myTurnFormDirty(f, stored)).toBe(true);
    // Nothing stored and nothing changed — not a change, even though `null` and `{}` differ.
    expect(myTurnFormDirty(seedMyTurnForm(null), null)).toBe(false);
  });
});

describe('the weights', () => {
  const sum = (w: DoNextWeightsPct): number => w.proximity + w.stall + w.relevance;

  it('re-shares the rest in proportion: 50/30/20 with the first at 60 is 60/20/20', () => {
    expect(rebalanceWeights(DO_NEXT_PRESETS.balanced, 'proximity', 60)).toEqual({
      proximity: 60,
      stall: 20,
      relevance: 20,
    });
  });

  it('gives the other two nothing when one takes 100', () => {
    expect(rebalanceWeights(DO_NEXT_PRESETS.balanced, 'stall', 100)).toEqual({
      proximity: 0,
      stall: 100,
      relevance: 0,
    });
  });

  it('shares everything in proportion when one drops to 0', () => {
    expect(rebalanceWeights(DO_NEXT_PRESETS.balanced, 'proximity', 0)).toEqual({
      proximity: 0,
      stall: 60,
      relevance: 40,
    });
  });

  it('splits evenly when the other two held nothing', () => {
    const allIn: DoNextWeightsPct = { proximity: 100, stall: 0, relevance: 0 };
    expect(rebalanceWeights(allIn, 'proximity', 40)).toEqual({ proximity: 40, stall: 30, relevance: 30 });
  });

  it('snaps a value between steps, and clamps one outside 0..100', () => {
    expect(rebalanceWeights(DO_NEXT_PRESETS.balanced, 'relevance', 57).relevance).toBe(60);
    expect(rebalanceWeights(DO_NEXT_PRESETS.balanced, 'relevance', 140).relevance).toBe(100);
    expect(rebalanceWeights(DO_NEXT_PRESETS.balanced, 'relevance', -20).relevance).toBe(0);
  });

  it('always lands on whole tens that add up to 100 — every preset, every slider, every stop', () => {
    let checked = 0;
    for (const p of DO_NEXT_PRESET_ORDER) {
      for (const key of WEIGHT_KEYS) {
        for (let v = 0; v <= 100; v += 10) {
          const w = rebalanceWeights(DO_NEXT_PRESETS[p], key, v);
          expect(sum(w)).toBe(100);
          expect(w[key]).toBe(v);
          for (const k of WEIGHT_KEYS) {
            expect(w[k] % 10).toBe(0);
            expect(w[k]).toBeGreaterThanOrEqual(0);
          }
          // …which is exactly what the server's validator accepts.
          expect(myTurnFormProblem({ ...seedMyTurnForm(null), weights: w })).toBeNull();
          checked += 1;
        }
      }
    }
    expect(checked).toBe(DO_NEXT_PRESET_ORDER.length * WEIGHT_KEYS.length * 11);
  });

  /** Drag one slider through `stops`, one change event per stop, as the section does. */
  const drag = (
    start: DoNextWeightsPct,
    key: WeightKey,
    stops: readonly number[],
    slide: WeightSlide | null = null,
  ): WeightSlide => {
    let s = slide;
    let w = start;
    for (const v of stops) {
      s = slideWeight(s, w, key, v);
      w = s.to;
    }
    return s!;
  };

  it('comes back to where it started when one slider goes out and back', () => {
    // The reported case, a key at a time: Balanced, "How close to done" to 80 and back to 50.
    const out = drag(DO_NEXT_PRESETS.balanced, 'proximity', [60, 70, 80]);
    expect(out.to).toEqual({ proximity: 80, stall: 10, relevance: 10 });
    const back = drag(out.to, 'proximity', [70, 60, 50], out);
    expect(back.to).toEqual(DO_NEXT_PRESETS.balanced);
    expect(presetOf(back.to)).toBe('balanced');
  });

  it('comes back for every preset, every slider and every stop, one step of ten at a time', () => {
    for (const p of DO_NEXT_PRESET_ORDER) {
      const start = DO_NEXT_PRESETS[p];
      for (const key of WEIGHT_KEYS) {
        for (let target = 0; target <= 100; target += 10) {
          if (target === start[key]) continue;
          const dir = target > start[key] ? 10 : -10;
          const there: number[] = [];
          for (let v = start[key] + dir; dir > 0 ? v <= target : v >= target; v += dir) there.push(v);
          const home = [...there].reverse().slice(1).concat(start[key]);
          const out = drag(start, key, there);
          expect(drag(out.to, key, home, out).to, `${p} ${key} → ${target} → back`).toEqual(start);
        }
      }
    }
  });

  it('starts a new slide from the weights as they stand once another slider moves', () => {
    const out = drag(DO_NEXT_PRESETS.balanced, 'proximity', [80]); // 80/10/10
    // "How long it has waited" to 30 re-shares 70 between 80 and 10, not between Balanced's 50 and 20.
    expect(drag(out.to, 'stall', [30], out).to).toEqual({ proximity: 60, stall: 30, relevance: 10 });
  });

  it('starts a new slide once a preset changes the weights', () => {
    const out = drag(DO_NEXT_PRESETS.balanced, 'proximity', [80]);
    const oldest = presetWeights('oldest_first'); // 20/70/10
    expect(drag(oldest, 'proximity', [30], out).to).toEqual({ proximity: 30, stall: 60, relevance: 10 });
  });

  it('names the preset the sliders landed on', () => {
    expect(presetOf(presetWeights('oldest_first'))).toBe('oldest_first');
    expect(presetOf(rebalanceWeights(DO_NEXT_PRESETS.balanced, 'proximity', 60))).toBe('custom');
  });

  it('shows the server’s sentence for weights that do not add up', () => {
    expect(
      myTurnFormProblem({ ...seedMyTurnForm(null), weights: { proximity: 50, stall: 30, relevance: 10 } }),
    ).toBe('The three weights must add up to 100%.');
  });
});

describe('the order', () => {
  const order = [...MY_TURN_DEFAULT_ORDER];

  it('moves a type one place up or down', () => {
    expect(moveType(order, 'thread', -1).slice(0, 3)).toEqual(['review_request', 'thread', 'mention']);
    expect(moveType(order, 'thread', 1).slice(2, 4)).toEqual(['thread_reply', 'thread']);
  });

  it('leaves the order alone past either end', () => {
    expect(moveType(order, 'review_request', -1)).toEqual(order);
    expect(moveType(order, 'watched_repo_pr', 1)).toEqual(order);
  });

  it('steps over a type the reader cannot see, which keeps its place', () => {
    const hidden = new Set<MyTurnCardReason>(['claude_review']);
    const i = order.indexOf('claude_review');
    const before = order[i - 1]!;
    const after = order[i + 1]!;
    const down = moveType(order, before, 1, hidden);
    expect(down.indexOf('claude_review')).toBe(i);
    expect(down[i + 1]).toBe(before);
    expect(down[i - 1]).toBe(after);
    // …and a hidden type at the very end cannot be passed, so the last visible row stays put.
    const tail = [...order.filter((r) => r !== 'claude_review'), 'claude_review' as const];
    expect(moveType(tail, 'watched_repo_pr', 1, hidden)).toEqual(tail);
  });

  it('says where a moved row went, counted over the rows on screen', () => {
    const moved = moveType(order, 'mention', -1);
    expect(movedTypeAnnouncement(moved, 'mention', '@mentions of you')).toBe(
      `“@mentions of you” moved to 1 of ${order.length}.`,
    );
    // Claude reviews off: one row fewer on screen, and a row past it counts without it.
    const hidden = new Set<MyTurnCardReason>(['claude_review']);
    const i = order.indexOf('claude_review');
    const after = order[i + 1]!;
    const up = moveType(order, after, -1, hidden);
    expect(movedTypeAnnouncement(up, after, 'x', hidden)).toBe(`“x” moved to ${i} of ${order.length - 1}.`);
  });

  it('marks a red default branch off by its scope, and every other type by its switch', () => {
    const f = seedMyTurnForm(null);
    expect(isOff(f, 'trunk_red')).toBe(true);
    expect(isOff({ ...f, trunkScope: 'all' }, 'trunk_red')).toBe(false);
    expect(isOff(f, 'mention')).toBe(false);
    expect(isOff(f, 'watched_repo_pr')).toBe(true);
  });

  it('“Reset” puts back the order and the weights, and leaves the switches alone', () => {
    const f = seedMyTurnForm({
      show: { watched_repo_pr: true },
      order: ['watched_repo_pr'],
      weights: DO_NEXT_PRESETS.quick_wins,
    });
    const r = resetOrderAndWeights(f);
    expect(r.order).toEqual(MY_TURN_DEFAULT_ORDER);
    expect(r.weights).toEqual(DO_NEXT_PRESETS.balanced);
    expect(r.show.watched_repo_pr).toBe(true);
    expect(buildMyTurnSettingsBody(r)).toEqual({ show: { watched_repo_pr: true } });
  });
});

describe('every switch has a row', () => {
  it('“Show in My Turn” and “Add to My Turn” together list every switch exactly once', () => {
    const listed = [...SHOW_ROWS.map((r) => r.reason), ...ADD_ROWS];
    expect(new Set(listed).size).toBe(listed.length);
    expect([...listed].sort()).toEqual([...MY_TURN_TOGGLES].sort());
  });

  it('puts the off-by-default promotions under “Add to My Turn”, and nothing else there', () => {
    for (const r of ADD_ROWS) expect(MY_TURN_SHOW_DEFAULTS[r]).toBe(false);
  });
});

describe('what the presets and rows say', () => {
  it('a preset is described as a WEIGHTING, naming the slider it leans on — never an order', () => {
    // A preset leans the score; it does not sort. Under Mine first an approved PR in a repo you
    // maintain outscores your own unapproved one, so "comes first" was false on the board.
    for (const p of DO_NEXT_PRESET_ORDER) {
      expect(PRESET_DESC[p]).not.toMatch(/first/i);
      if (p === 'balanced') continue;
      const w = DO_NEXT_PRESETS[p];
      const heaviest = WEIGHT_KEYS.reduce((a, b) => (w[b] > w[a] ? b : a));
      expect(PRESET_DESC[p]).toContain(WEIGHT_LABEL[heaviest]);
    }
  });

  it('an approved PR is not called ready — the type never looks at the merge state', () => {
    const approved = SHOW_ROWS.find((r) => r.reason === 'pr_approved')!;
    expect(approved.hint).not.toMatch(/ready|merge/i);
  });
});
