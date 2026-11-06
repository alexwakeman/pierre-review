// The My Turn settings RULES — resolve, store, group — pure, no database.
//
// They live in packages/shared (my-turn-settings.ts, pending-rules.ts) because the Settings section,
// the board and the server must answer every one of these questions identically. The shared
// package has no test runner of its own, so the rules are pinned here.
//
// WHAT EACH PIN GUARDS, and why it would fail silently otherwise:
//   1. ONE SWITCH, READ FROM ANY STORED SHAPE. Only `show.watched_repo_pr === true` turns the
//      survey on; an older blob's other type switches, its order and its weights are IGNORED, and
//      garbage resolves to the default instead of throwing.
//   2. `configKey` CHANGES WITH WHAT IS SHOWN. The notification watcher re-baselines on it; one that
//      did not move on the switch would fire the survey's whole backlog.
//   3. THE ORDER AND GROUPS ARE FIXED: Waiting on you, Re-review, Your PRs, then the survey.
import { describe, expect, it } from 'vitest';
import {
  DO_NEXT_RULES,
  MY_TURN_GROUP_LABEL,
  MY_TURN_GROUP_OF,
  MY_TURN_GROUPS,
  MY_TURN_OLDER_DAYS,
  MY_TURN_ORDER,
  myTurnGroupOf,
  resolveMyTurnSettings,
  storedMyTurnSettings,
} from '@pierre-review/shared';

describe('resolveMyTurnSettings', () => {
  it('resolves NULL to the default: the survey off', () => {
    const r = resolveMyTurnSettings(null);
    expect(r.showNewPrs).toBe(false);
    expect(r.order).toEqual([...MY_TURN_ORDER]);
    expect(r.off).toEqual(['watched_repo_pr']);
  });

  it('reads the survey from `show.watched_repo_pr`', () => {
    const r = resolveMyTurnSettings({ show: { watched_repo_pr: true } });
    expect(r.showNewPrs).toBe(true);
    expect(r.off).toEqual([]);
  });

  it('ignores an older blob’s other switches, its order and its weights', () => {
    const r = resolveMyTurnSettings({
      show: { review_request: false, own_ci_red: true, your_pr: false, watched_repo_pr: false },
      order: ['watched_repo_pr', 'claude_review', 'mention'],
      weights: { proximity: 30, stall: 10, relevance: 60 },
    });
    expect(r.showNewPrs).toBe(false);
    expect(r.order).toEqual([...MY_TURN_ORDER]);
    expect(r.off).toEqual(['watched_repo_pr']);
    // Nothing the resolver returns carries weights: the ranker reads the fixed ones.
    expect(r).not.toHaveProperty('weights');
    expect(DO_NEXT_RULES.weights).toEqual({ proximity: 0.5, stall: 0.3, relevance: 0.2 });
  });

  it('never throws on garbage, and never reads a truthy non-boolean as on', () => {
    for (const raw of [undefined, 'yes', 42, [], { show: 'all' }, { show: { watched_repo_pr: 'true' } }, { show: null }]) {
      expect(resolveMyTurnSettings(raw).showNewPrs).toBe(false);
    }
  });

  it('changes `configKey` exactly with the switch', () => {
    const off = resolveMyTurnSettings(null).configKey;
    expect(resolveMyTurnSettings({ show: { watched_repo_pr: true } }).configKey).not.toBe(off);
    expect(resolveMyTurnSettings({ weights: { proximity: 80, stall: 10, relevance: 10 } }).configKey).toBe(off);
  });
});

describe('storedMyTurnSettings', () => {
  it('stores the switch in the shape the resolver reads, and NULL for the default', () => {
    expect(storedMyTurnSettings({ showNewPrs: false })).toBeNull();
    const on = storedMyTurnSettings({ showNewPrs: true });
    expect(resolveMyTurnSettings(on).showNewPrs).toBe(true);
  });
});

describe('the fixed order and groups', () => {
  it('lists every type once, groups in order: Waiting on you, Re-review, Your PRs, then the survey', () => {
    expect(new Set(MY_TURN_ORDER).size).toBe(MY_TURN_ORDER.length);
    expect(Object.keys(MY_TURN_GROUP_OF).sort()).toEqual([...MY_TURN_ORDER].sort());
    const groupIdx = MY_TURN_ORDER.map((r) => MY_TURN_GROUPS.indexOf(MY_TURN_GROUP_OF[r]));
    for (let i = 1; i < groupIdx.length; i++) expect(groupIdx[i - 1]!).toBeLessThanOrEqual(groupIdx[i]!);
    expect(MY_TURN_GROUPS[MY_TURN_GROUPS.length - 1]).toBe('older');
    expect(MY_TURN_GROUP_LABEL).toMatchObject({
      waiting: 'Waiting on you',
      rereview: 'Re-review',
      yours: 'Your PRs',
      older: 'Older',
    });
  });

  it('holds no removed type', () => {
    for (const gone of ['your_pr', 'claude_review', 'ai_approved_merged']) {
      expect((MY_TURN_ORDER as readonly string[]).includes(gone)).toBe(false);
    }
  });

  it('puts a card older than MY_TURN_OLDER_DAYS under Older, and one with no clock in its group', () => {
    const now = Date.UTC(2026, 10, 6);
    const days = (d: number) => new Date(now - d * 86_400_000).toISOString();
    expect(MY_TURN_OLDER_DAYS).toBe(14);
    expect(myTurnGroupOf({ reason: 'mention', since: days(14) }, now)).toBe('waiting');
    expect(myTurnGroupOf({ reason: 'mention', since: days(15) }, now)).toBe('older');
    expect(myTurnGroupOf({ reason: 'own_ready', since: null }, now)).toBe('yours');
    expect(myTurnGroupOf({ reason: 'watched_repo_pr', since: days(1) }, now)).toBe('new_prs');
  });
});
