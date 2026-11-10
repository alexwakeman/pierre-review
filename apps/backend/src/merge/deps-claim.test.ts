// TEAM CLAIMS FOR DEPENDENCY WORK (merge/deps-claim.ts): the pure fold over a head's `limn/deps`
// lines, the lines' words, and the read → post → re-read lifecycle against a fake GitHub.
//
// Pinned: a teammate's FRESH pending line holds the head for every action; a STALE one (past the
// 30-minute TTL) holds nothing; a teammate's finished line holds only the SAME family of action (and
// a line whose family can't be read holds them all); the reader's own lines hold only the SAME action
// (another of their machines did it); an AI-pushed head holds the merge until CI is green; a
// race goes to the claimant whose pending run started first, and the loser stands down.
import { afterEach, describe, expect, it } from 'vitest';
import { isLimnStatusContext, DEPENDENCY_CLAIM_CONTEXT } from '@pierre-review/shared';
import type { TeamClaimGithub, TeamClaimLine } from '../review/claude-review/team-claim.js';
import {
  DEPS_CLAIM_TTL_MS,
  actionOfLine,
  aiPushedLine,
  _resetDepsClaimsForTest,
  decideDepsClaim,
  depsHeldNow,
  doneLine,
  endDepsClaim,
  failedLine,
  familyOfAction,
  familyOfLine,
  handlingLine,
  lostLine,
  postDepsClaim,
  readDepsClaim,
  releaseLine,
  rememberDepsHold,
  setDepsClaimGithubForTest,
} from './deps-claim.js';

const NOW = 1_800_000_000_000;
let nextId = 1;
const line = (login: string | null, state: string, description: string, agoMs: number): TeamClaimLine => ({
  id: nextId++,
  state,
  description,
  createdAtMs: NOW - agoMs,
  login,
});
const MIN = 60_000;

describe('the lines', () => {
  it('reads as plain English and names its family', () => {
    expect(handlingLine('alex', 'ai_fix')).toBe('alex handling · fixing CI');
    expect(doneLine('alex', 'ai_fix', '1a2b3c4d5e')).toBe('alex fixed CI · pushed 1a2b3c4');
    expect(doneLine('alex', 'approve')).toBe('alex approved');
    expect(doneLine('alex', 'arm_merge')).toBe('alex armed the merge · lands when checks pass');
    expect(failedLine('alex', 'ai_resolve')).toBe("alex couldn't resolve conflicts");
    for (const a of ['approve', 'rebase_request', 'ai_resolve', 'ai_fix', 'arm_merge'] as const) {
      expect(familyOfLine(handlingLine('alex', a))).toBe(familyOfAction(a));
      expect(familyOfLine(doneLine('alex', a, 'abcdef1'))).toBe(familyOfAction(a));
      expect(familyOfLine(failedLine('alex', a))).toBe(familyOfAction(a));
    }
    expect(familyOfLine('something else')).toBeNull();
  });

  it('is never CI: the context is a Limn line', () => {
    expect(DEPENDENCY_CLAIM_CONTEXT).toBe('limn/deps');
    expect(isLimnStatusContext(DEPENDENCY_CLAIM_CONTEXT)).toBe(true);
  });
});

describe('a login holding a family word', () => {
  it('reads the family AFTER the poster’s login', () => {
    // "approver-x armed the merge" is a merge, not an approval.
    expect(familyOfLine(doneLine('approver-x', 'arm_merge'), 'approver-x')).toBe('merge');
    expect(familyOfLine(doneLine('rebase-bot-fan', 'approve'), 'rebase-bot-fan')).toBe('approve');
    expect(familyOfLine(failedLine('fix-ci-sam', 'arm_merge'), 'fix-ci-sam')).toBe('merge');
    const armed = [line('approver-x', 'success', doneLine('approver-x', 'arm_merge'), MIN)];
    expect(decideDepsClaim(armed, 'alex', NOW, 'merge')).toMatchObject({ kind: 'handled', login: 'approver-x' });
    expect(decideDepsClaim(armed, 'alex', NOW, 'approve').kind).toBe('free');
  });
});

describe("the reader's other machines and AI-pushed heads", () => {
  it('an own FINISHED line of the same action holds it; another action of the family does not', () => {
    for (const a of ['approve', 'rebase_request', 'ai_resolve', 'ai_fix', 'arm_merge'] as const) {
      expect(actionOfLine(doneLine('alex', a, 'abcdef1'), 'alex')).toBe(a);
      expect(actionOfLine(failedLine('alex', a), 'alex')).toBe(a);
    }
    expect(actionOfLine(handlingLine('alex', 'ai_fix'), 'alex')).toBeNull();
    const tried = [line('alex', 'success', failedLine('alex', 'ai_fix'), MIN)];
    expect(decideDepsClaim(tried, 'alex', NOW, 'ai_fix', { action: 'ai_fix' })).toMatchObject({ kind: 'handled', login: 'alex' });
    // The conflicts ladder: an own rebase ask never holds the AI conflict run that follows it.
    const asked = [line('alex', 'success', doneLine('alex', 'rebase_request'), MIN)];
    expect(decideDepsClaim(asked, 'alex', NOW, 'conflicts', { action: 'ai_resolve' }).kind).toBe('free');
    expect(decideDepsClaim(asked, 'alex', NOW, 'conflicts', { action: 'rebase_request' }).kind).toBe('handled');
  });

  it('an AI-pushed head (anyone’s) holds the merge until CI is green, and nothing else', () => {
    const pushed = [line('robin', 'success', aiPushedLine('robin'), MIN)];
    expect(decideDepsClaim(pushed, 'alex', NOW, 'merge')).toEqual({ kind: 'awaiting_ci' });
    expect(decideDepsClaim(pushed, 'alex', NOW, 'merge', { ciGreen: true })).toEqual({ kind: 'free' });
    expect(decideDepsClaim(pushed, 'alex', NOW, 'approve')).toEqual({ kind: 'free' });
    expect(decideDepsClaim([line('alex', 'success', aiPushedLine('alex'), MIN)], 'alex', NOW, 'merge').kind).toBe('awaiting_ci');
  });
});

describe('decideDepsClaim', () => {
  it('no lines, or only the reader’s own, is free', () => {
    expect(decideDepsClaim([], 'alex', NOW, 'ai_fix')).toEqual({ kind: 'free' });
    expect(decideDepsClaim([line('alex', 'success', doneLine('alex', 'ai_fix'), MIN)], 'alex', NOW, 'ai_fix').kind).toBe(
      'free',
    );
    expect(decideDepsClaim([line('Alex', 'pending', handlingLine('alex', 'ai_fix'), MIN)], 'alex', NOW, 'merge').kind).toBe(
      'mine',
    );
  });

  it('a teammate’s FRESH pending line holds every action; a STALE one holds nothing', () => {
    const fresh = [line('robin', 'pending', handlingLine('robin', 'ai_fix'), 5 * MIN)];
    for (const f of ['approve', 'conflicts', 'ai_fix', 'merge'] as const) {
      expect(decideDepsClaim(fresh, 'alex', NOW, f)).toMatchObject({
        kind: 'handling',
        login: 'robin',
        leaseEndsAtMs: NOW - 5 * MIN + DEPS_CLAIM_TTL_MS,
      });
    }
    const stale = [line('robin', 'pending', handlingLine('robin', 'ai_fix'), DEPS_CLAIM_TTL_MS + MIN)];
    expect(decideDepsClaim(stale, 'alex', NOW, 'ai_fix')).toEqual({ kind: 'free' });
    // A renewal keeps it fresh: the lease runs from the NEWEST line.
    const renewed = [
      line('robin', 'pending', handlingLine('robin', 'ai_fix'), 40 * MIN),
      line('robin', 'pending', handlingLine('robin', 'ai_fix'), 10 * MIN),
    ];
    expect(decideDepsClaim(renewed, 'alex', NOW, 'ai_fix').kind).toBe('handling');
  });

  it('a teammate’s FINISHED line holds the same family only (done or failed — the attempt is theirs)', () => {
    const fixed = [line('robin', 'success', failedLine('robin', 'ai_fix'), 2 * 60 * MIN)];
    expect(decideDepsClaim(fixed, 'alex', NOW, 'ai_fix')).toMatchObject({ kind: 'handled', login: 'robin' });
    const approved = [line('robin', 'success', doneLine('robin', 'approve'), MIN)];
    expect(decideDepsClaim(approved, 'alex', NOW, 'approve').kind).toBe('handled');
    expect(decideDepsClaim(approved, 'alex', NOW, 'merge').kind).toBe('free');
    // An older teammate line still counts after the reader's own newer one.
    const armed = [
      line('robin', 'success', doneLine('robin', 'arm_merge'), 10 * MIN),
      line('alex', 'success', doneLine('alex', 'approve'), MIN),
    ];
    expect(decideDepsClaim(armed, 'alex', NOW, 'merge')).toMatchObject({ kind: 'handled', login: 'robin' });
    // Words we can't read hold every family.
    expect(decideDepsClaim([line('robin', 'success', 'robin did a thing', MIN)], 'alex', NOW, 'approve').kind).toBe(
      'handled',
    );
  });

  it('free lines ("Cleared by …") hold nothing and end the claimant’s pending run', () => {
    const released = [
      line('robin', 'pending', handlingLine('robin', 'ai_fix'), 3 * MIN),
      line('robin', 'success', releaseLine('robin', "didn't start"), 2 * MIN),
    ];
    expect(decideDepsClaim(released, 'alex', NOW, 'ai_fix')).toEqual({ kind: 'free' });
  });

  it('a race goes to the pending run that STARTED first; the loser reads it as held', () => {
    const race = [
      line('robin', 'pending', handlingLine('robin', 'ai_fix'), 2 * MIN),
      line('alex', 'pending', handlingLine('alex', 'ai_fix'), MIN),
    ];
    expect(decideDepsClaim(race, 'alex', NOW, 'ai_fix')).toMatchObject({ kind: 'handling', login: 'robin' });
    expect(decideDepsClaim(race, 'robin', NOW, 'ai_fix').kind).toBe('mine');
    // Same second: the lower id wins.
    const tie = [line('robin', 'pending', 'robin handling · approving', MIN), line('alex', 'pending', 'alex handling · approving', MIN)];
    expect(decideDepsClaim(tie, 'alex', NOW, 'approve')).toMatchObject({ kind: 'handling', login: 'robin' });
  });
});

describe('the lifecycle (fake GitHub)', () => {
  afterEach(() => _resetDepsClaimsForTest());
  const log = { info: () => {}, warn: () => {} };
  const target = { accountId: 1, prId: 7, owner: 'o', name: 'w', headSha: 'h1', action: 'ai_fix' as const };

  function fakeGithub(me: string | null, initial: TeamClaimLine[], opts: { beforeReRead?: TeamClaimLine[] } = {}) {
    const lines = [...initial];
    const posted: Array<{ state: string; description: string; context: string }> = [];
    let reads = 0;
    const g: TeamClaimGithub = {
      async listLines(_a, _o, _n, _sha, context) {
        reads += 1;
        if (reads === 2 && opts.beforeReRead) lines.push(...opts.beforeReRead);
        return lines.map((l) => ({ ...l }));
      },
      async postLine(_a, _o, _n, _sha, context, post) {
        posted.push({ state: post.state, description: post.description, context });
        lines.push({ id: nextId++, state: post.state, description: post.description, createdAtMs: Date.now(), login: me });
      },
      async login() {
        return me;
      },
    };
    return { g, posted };
  }

  it('no login: nothing is read or posted', async () => {
    const { g, posted } = fakeGithub(null, []);
    setDepsClaimGithubForTest(g);
    expect(await readDepsClaim(target, log)).toEqual({ login: null, hold: null });
    expect(posted).toEqual([]);
  });

  it('free → pending, then the done line, on limn/deps', async () => {
    const { g, posted } = fakeGithub('alex', []);
    setDepsClaimGithubForTest(g);
    const read = await readDepsClaim(target, log);
    expect(read).toEqual({ login: 'alex', hold: null });
    const { handle, hold } = await postDepsClaim(read.login, target, log);
    expect(hold).toBeNull();
    await endDepsClaim(handle, { outcome: 'done', pushedSha: 'abcdef123' }, log);
    expect(posted).toEqual([
      { state: 'pending', description: 'alex handling · fixing CI', context: 'limn/deps' },
      { state: 'success', description: 'alex fixed CI · pushed abcdef1', context: 'limn/deps' },
    ]);
  });

  it('a teammate’s fresh claim is read as a hold; nothing is posted', async () => {
    const { g, posted } = fakeGithub('alex', [line('robin', 'pending', handlingLine('robin', 'approve'), -1)]);
    setDepsClaimGithubForTest(g);
    const read = await readDepsClaim(target, log, Date.now());
    expect(read.hold).toMatchObject({ kind: 'handling', login: 'robin' });
    expect(posted).toEqual([]);
  });

  it('losing the race: our line stands down naming the winner', async () => {
    const { g, posted } = fakeGithub('alex', [], {
      beforeReRead: [{ id: 0, state: 'pending', description: handlingLine('robin', 'ai_fix'), createdAtMs: Date.now() - 1000, login: 'robin' }],
    });
    setDepsClaimGithubForTest(g);
    expect((await readDepsClaim(target, log)).hold).toBeNull(); // read 1: free
    const out = await postDepsClaim('alex', target, log); // read 2: robin raced in first
    expect(out.hold).toMatchObject({ kind: 'handling', login: 'robin' });
    expect(out.handle.login).toBeNull(); // nothing more is posted for this claim
    expect(posted.map((p) => p.description)).toEqual(['alex handling · fixing CI', lostLine('alex', 'robin')]);
  });

  it('a hold is remembered: a live claim until its lease ends, a finished action for its family only', () => {
    const lease = NOW + 10 * MIN;
    const at = { accountId: 1, prId: 7, headSha: 'h1', action: 'ai_fix' as const };
    rememberDepsHold(at, { kind: 'handling', login: 'robin', leaseEndsAtMs: lease, description: null }, NOW);
    expect(depsHeldNow(1, 7, 'h1', null, NOW)).toBe(true);
    expect(depsHeldNow(1, 7, 'h1', 'merge', NOW)).toBe(true);
    expect(depsHeldNow(1, 7, 'h2', null, NOW)).toBe(false); // a new head is a new commit
    expect(depsHeldNow(1, 7, 'h1', 'merge', lease + 31_000)).toBe(false);
    rememberDepsHold({ ...at, prId: 8, action: 'approve' }, { kind: 'handled', login: 'robin', atMs: NOW, description: null }, NOW);
    expect(depsHeldNow(1, 8, 'h1', 'approve', NOW)).toBe(true);
    expect(depsHeldNow(1, 8, 'h1', 'merge', NOW)).toBe(false);
    expect(depsHeldNow(1, 8, 'h1', null, NOW)).toBe(false);
  });
});
