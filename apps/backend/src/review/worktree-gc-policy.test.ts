import { describe, expect, it } from 'vitest';
import {
  decideLedgered,
  decideOrphan,
  fixRowStates,
  isCacheWorktreePath,
  type LedgeredFacts,
} from './worktree-gc-policy.js';

// THE WORKTREE SWEEP'S RULES (docs/BACKEND.md § Worktree cleanup). Each test names the rule it pins;
// the order of the rules is the policy, so several tests put two rules in conflict on purpose.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = 1_800_000_000_000;
const POLICY = { idleMs: 3 * DAY, pinMaxMs: 14 * DAY };

/** A tree a crashed run in another (dead) process left an hour ago, naming nothing. */
function facts(over: Partial<LedgeredFacts> = {}): LedgeredFacts {
  return {
    exists: true,
    liveHere: false,
    ownedHere: false,
    ownerAlive: false,
    pinReason: null,
    releasedAt: null,
    runState: 'unknown',
    workState: 'none',
    prState: null,
    createdAt: NOW - HOUR,
    lastUsedAt: NOW - HOUR,
    ...over,
  };
}

describe('decideLedgered', () => {
  it('forgets a row whose directory is already gone', () => {
    expect(decideLedgered(facts({ exists: false, liveHere: true }), NOW, POLICY)).toEqual({ action: 'forget', reason: 'missing' });
  });

  it('keeps a tree a job in this process is using — even on a merged PR, even when ancient', () => {
    const v = decideLedgered(
      facts({ liveHere: true, ownedHere: true, ownerAlive: true, prState: 'merged', runState: 'finished', lastUsedAt: NOW - 90 * DAY }),
      NOW,
      POLICY,
    );
    expect(v).toEqual({ action: 'keep', reason: 'in_use' });
  });

  it('keeps a tree another LIVE Limn process made, until it is idle past the TTL', () => {
    expect(decideLedgered(facts({ ownerAlive: true, prState: 'closed' }), NOW, POLICY)).toEqual({
      action: 'keep',
      reason: 'other_process',
    });
    expect(decideLedgered(facts({ ownerAlive: true, lastUsedAt: NOW - 4 * DAY }), NOW, POLICY)).toEqual({
      action: 'remove',
      reason: 'idle',
    });
  });

  it('keeps unpushed work over a closed PR and a dead owner, until the pin TTL', () => {
    const held = facts({ workState: 'unpushed', runState: 'finished', prState: 'closed', lastUsedAt: NOW - 13 * DAY });
    expect(decideLedgered(held, NOW, POLICY)).toEqual({ action: 'keep', reason: 'unpushed' });
    expect(decideLedgered({ ...held, lastUsedAt: NOW - 15 * DAY }, NOW, POLICY)).toEqual({
      action: 'remove',
      reason: 'pin_expired',
    });
  });

  it('honours an explicit unpushed pin when the run row says nothing', () => {
    expect(decideLedgered(facts({ pinReason: 'unpushed' }), NOW, POLICY)).toEqual({ action: 'keep', reason: 'unpushed' });
  });

  it('a stale "running" pin from a dead process does not hold the tree', () => {
    expect(decideLedgered(facts({ pinReason: 'running', runState: 'running' }), NOW, POLICY)).toEqual({
      action: 'remove',
      reason: 'owner_exited',
    });
  });

  it('removes once the work is pushed or discarded', () => {
    expect(decideLedgered(facts({ workState: 'pushed', ownedHere: true, ownerAlive: true }), NOW, POLICY).action).toBe('remove');
    expect(decideLedgered(facts({ workState: 'discarded' }), NOW, POLICY).action).toBe('remove');
  });

  it('removes a tree whose PR merged, closed or left Limn', () => {
    for (const prState of ['merged', 'closed', 'gone'] as const) {
      expect(decideLedgered(facts({ prState }), NOW, POLICY)).toEqual({ action: 'remove', reason: 'pr_closed' });
    }
  });

  it('removes a tree its run let go of (the run\'s own removal failed)', () => {
    expect(decideLedgered(facts({ prState: 'open', releasedAt: NOW - 1000 }), NOW, POLICY)).toEqual({
      action: 'remove',
      reason: 'released',
    });
  });

  it('removes a tree made here that no job here holds', () => {
    expect(decideLedgered(facts({ ownedHere: true, ownerAlive: true, prState: 'open' }), NOW, POLICY)).toEqual({
      action: 'remove',
      reason: 'released',
    });
  });

  it('removes a tree whose run finished', () => {
    expect(decideLedgered(facts({ runState: 'finished', prState: 'open', ownerAlive: false }), NOW, POLICY)).toEqual({
      action: 'remove',
      reason: 'run_finished',
    });
  });

  it('removes a crashed run\'s tree on an open PR (its process exited)', () => {
    expect(decideLedgered(facts({ prState: 'open', runState: 'running' }), NOW, POLICY)).toEqual({
      action: 'remove',
      reason: 'owner_exited',
    });
  });
});

describe('decideOrphan', () => {
  const TTL = 6 * HOUR;
  it('keeps one in use here regardless of age', () => {
    expect(decideOrphan({ liveHere: true, mtimeMs: NOW - 10 * DAY }, NOW, TTL).action).toBe('keep');
  });
  it('keeps a young one, removes an old one', () => {
    expect(decideOrphan({ liveHere: false, mtimeMs: NOW - HOUR }, NOW, TTL)).toEqual({ action: 'keep', reason: 'recent' });
    expect(decideOrphan({ liveHere: false, mtimeMs: NOW - 7 * HOUR }, NOW, TTL)).toEqual({ action: 'remove', reason: 'orphan' });
  });
});

describe('fixRowStates', () => {
  it('reads an AI Fix row', () => {
    expect(fixRowStates(null)).toEqual({ runState: 'unknown', workState: 'none' });
    expect(fixRowStates({ status: 'running', pushedAt: null, hasPatch: false }).runState).toBe('running');
    expect(fixRowStates({ status: 'succeeded', pushedAt: null, hasPatch: true }).workState).toBe('unpushed');
    expect(fixRowStates({ status: 'succeeded', pushedAt: 1, hasPatch: true }).workState).toBe('pushed');
    expect(fixRowStates({ status: 'succeeded', pushedAt: null, hasPatch: false }).workState).toBe('none');
    expect(fixRowStates({ status: 'cancelled', pushedAt: null, hasPatch: false }).workState).toBe('discarded');
  });
});

describe('isCacheWorktreePath — nothing outside the clone cache', () => {
  const ROOT = '/home/u/.limn/clones';
  it('accepts exactly <root>/<clone>/.worktrees/<entry>', () => {
    expect(isCacheWorktreePath(`${ROOT}/acme__api/.worktrees/abc-1-2`, ROOT)).toBe(true);
  });
  it('refuses everything else', () => {
    for (const p of [
      ROOT,
      `${ROOT}/acme__api`,
      `${ROOT}/acme__api/.worktrees`,
      `${ROOT}/acme__api/.git/abc`,
      `${ROOT}/acme__api/.worktrees/abc/deeper`,
      `${ROOT}/acme__api/.worktrees/..`,
      `${ROOT}/../clones-evil/x/.worktrees/y`,
      `${ROOT}-sibling/acme__api/.worktrees/y`,
      '/home/u/Projects/repo/.worktrees/y',
    ]) {
      expect(isCacheWorktreePath(p, ROOT), p).toBe(false);
    }
  });
});
