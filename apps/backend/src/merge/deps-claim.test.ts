// TEAM CLAIMS FOR DEPENDENCY WORK (merge/deps-claim.ts): the pure fold over a head's `limn/deps`
// lines, the lines' words, and the read → post → re-read lifecycle against a fake GitHub.
//
// Pinned: a teammate's FRESH pending line holds the head for every action; a STALE one (past the
// 30-minute TTL) holds nothing; a teammate's finished line holds only the SAME family of action (and
// a line whose family can't be read holds them all); the reader's own lines hold only the SAME action
// (another of their machines did it); an AI-pushed head holds the merge until CI is green; a
// race goes to the claimant whose pending run started first, and the loser stands down.
// 2026-11-14: an ARMED merge holds on a lease from its poster's newest armed line and is freed by their
// release line; a rebase ask "open to teammates" holds only the ask; a teammate's expired pending line
// is found (`staleTeammateDepsLine`); and the lifecycle writes the LEDGER before every line and keeps
// a line GitHub did not take for the reconciler (the final line, the armed line, the AI-pushed line).
import { afterEach, describe, expect, it } from 'vitest';
import { isLimnStatusContext, DEPENDENCY_CLAIM_CONTEXT } from '@pierre-review/shared';
import type { TeamClaimGithub, TeamClaimLine } from '../review/claude-review/team-claim.js';
import {
  DEPS_ARMED_LEASE_MS,
  DEPS_CLAIM_TTL_MS,
  actionOfLine,
  armedReleaseLine,
  depsClaimLive,
  markAiPushedHead,
  rebaseOpenLine,
  staleTeammateDepsLine,
  type DepsClaimLedger,
  type DepsLedgerPatch,
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

describe('an armed merge holds on a lease (gap c)', () => {
  it('holds the merge family while its newest armed line is inside the lease; a renewal extends it', () => {
    const armed = (ago: number) => line('robin', 'success', doneLine('robin', 'arm_merge'), ago);
    expect(decideDepsClaim([armed(10 * MIN)], 'alex', NOW, 'merge')).toMatchObject({ kind: 'handled', login: 'robin' });
    // A machine that went away: its line expires and a teammate may arm.
    expect(decideDepsClaim([armed(DEPS_ARMED_LEASE_MS + MIN)], 'alex', NOW, 'merge')).toEqual({ kind: 'free' });
    // Renewed: the newest armed line decides, so an old one does not matter.
    expect(decideDepsClaim([armed(DEPS_ARMED_LEASE_MS + 60 * MIN), armed(5 * MIN)], 'alex', NOW, 'merge').kind).toBe('handled');
    // It never held another family.
    expect(decideDepsClaim([armed(MIN)], 'alex', NOW, 'approve')).toEqual({ kind: 'free' });
  });

  it('the release line ("merge not armed any more") frees the poster’s armed line at once', () => {
    const lines = [
      line('robin', 'success', doneLine('robin', 'arm_merge'), 20 * MIN),
      line('robin', 'success', armedReleaseLine('robin'), MIN),
    ];
    expect(armedReleaseLine('robin')).toBe('Cleared by robin: merge not armed any more · free to claim');
    expect(decideDepsClaim(lines, 'alex', NOW, 'merge')).toEqual({ kind: 'free' });
    // A re-arm after the release holds again.
    lines.push(line('robin', 'success', doneLine('robin', 'arm_merge'), 0));
    expect(decideDepsClaim(lines, 'alex', NOW, 'merge').kind).toBe('handled');
    // The reader's other machine: its own armed line is held on the same lease.
    const own = [line('alex', 'success', doneLine('alex', 'arm_merge'), DEPS_ARMED_LEASE_MS + MIN)];
    expect(decideDepsClaim(own, 'alex', NOW, 'merge', { action: 'arm_merge' })).toEqual({ kind: 'free' });
  });
});

describe('a rebase ask open to teammates (gap d)', () => {
  it('holds the ask only; the AI conflict step is free for a teammate', () => {
    expect(rebaseOpenLine('robin')).toBe('robin asked the bot to rebase · AI step open to teammates');
    expect(actionOfLine(rebaseOpenLine('robin'), 'robin')).toBe('rebase_request');
    const open = [line('robin', 'success', rebaseOpenLine('robin'), 40 * MIN)];
    expect(decideDepsClaim(open, 'alex', NOW, 'conflicts', { action: 'rebase_request' })).toMatchObject({
      kind: 'handled',
      login: 'robin',
      onlyAction: 'rebase_request',
    });
    expect(decideDepsClaim(open, 'alex', NOW, 'conflicts', { action: 'ai_resolve' })).toEqual({ kind: 'free' });
    // The plain ask (the asker will run the AI step) still holds the whole family.
    const plain = [line('robin', 'success', doneLine('robin', 'rebase_request'), 40 * MIN)];
    expect(decideDepsClaim(plain, 'alex', NOW, 'conflicts', { action: 'ai_resolve' }).kind).toBe('handled');
    // Re-posted as open later: the NEWER line of the same action decides.
    expect(decideDepsClaim([...plain, line('robin', 'success', rebaseOpenLine('robin'), MIN)], 'alex', NOW, 'conflicts', { action: 'ai_resolve' })).toEqual({
      kind: 'free',
    });
  });

  it('an action-only hold is remembered for that action alone', () => {
    const at = { accountId: 1, prId: 9, headSha: 'h1', action: 'rebase_request' as const };
    rememberDepsHold(at, { kind: 'handled', login: 'robin', atMs: NOW, description: null, onlyAction: 'rebase_request' }, NOW);
    expect(depsHeldNow(1, 9, 'h1', 'conflicts', NOW, 'rebase_request')).toBe(true);
    expect(depsHeldNow(1, 9, 'h1', 'conflicts', NOW, 'ai_resolve')).toBe(false);
    expect(depsHeldNow(1, 9, 'h1', 'conflicts', NOW)).toBe(false);
    _resetDepsClaimsForTest();
  });
});

describe('a teammate’s expired pending line (gap b)', () => {
  it('is the newest line, theirs, pending and past the TTL', () => {
    const stale = [line('robin', 'pending', handlingLine('robin', 'ai_fix'), DEPS_CLAIM_TTL_MS + MIN)];
    expect(staleTeammateDepsLine(stale, 'alex', NOW)).toEqual({ login: 'robin' });
    expect(staleTeammateDepsLine([line('robin', 'pending', handlingLine('robin', 'ai_fix'), 5 * MIN)], 'alex', NOW)).toBeNull();
    expect(staleTeammateDepsLine([line('alex', 'pending', handlingLine('alex', 'ai_fix'), 60 * MIN)], 'alex', NOW)).toBeNull();
    // Settled since (any newer line): nothing to release.
    expect(staleTeammateDepsLine([...stale, line('robin', 'success', failedLine('robin', 'ai_fix'), MIN)], 'alex', NOW)).toBeNull();
  });
});

describe('the ledger (fake GitHub, fake ledger)', () => {
  afterEach(() => _resetDepsClaimsForTest());
  const log = { info: () => {}, warn: () => {} };
  const target = { accountId: 1, prId: 7, owner: 'o', name: 'w', headSha: 'h1', action: 'arm_merge' as const };

  function fakes(opts: { failPostsFrom?: number } = {}) {
    const events: string[] = [];
    const rows = new Map<number, DepsLedgerPatch & { action: string; headSha: string }>();
    let posts = 0;
    let id = 0;
    const ledger: DepsClaimLedger = {
      async intent(t, login) {
        id += 1;
        rows.set(id, { action: t.action, headSha: t.headSha, state: 'claiming' });
        events.push(`intent ${t.action} ${login}`);
        return id;
      },
      async update(rowId, patch) {
        Object.assign(rows.get(rowId)!, patch);
        events.push(`update ${patch.state ?? '-'}`);
      },
    };
    const g: TeamClaimGithub = {
      async listLines() {
        return [];
      },
      async postLine(_a, _o, _n, _sha, _c, post) {
        posts += 1;
        if (opts.failPostsFrom != null && posts >= opts.failPostsFrom) throw new Error('boom');
        events.push(`post ${post.state} ${post.description}`);
      },
      async login() {
        return 'alex';
      },
    };
    return { events, rows, ledger, g };
  }

  it('writes the intent BEFORE the pending line; an armed merge ends "armed" (renewed later)', async () => {
    const f = fakes();
    setDepsClaimGithubForTest(f.g);
    const { handle } = await postDepsClaim('alex', target, log, Date.now, f.ledger);
    expect(f.events.slice(0, 2)).toEqual(['intent arm_merge alex', 'post pending alex handling · arming the merge']);
    expect(depsClaimLive(handle.ledgerId ?? null, 1, 7, 'h1')).toBe(true);
    await endDepsClaim(handle, { outcome: 'done' }, log);
    expect(f.rows.get(1)).toMatchObject({ state: 'armed', finalDescription: null, lastDescription: doneLine('alex', 'arm_merge') });
    expect(depsClaimLive(1, 1, 7, 'h1')).toBe(false);
  });

  it('a final line GitHub did not take is KEPT for the reconciler (gap a)', async () => {
    const f = fakes({ failPostsFrom: 2 });
    setDepsClaimGithubForTest(f.g);
    const { handle } = await postDepsClaim('alex', { ...target, action: 'approve' }, log, Date.now, f.ledger);
    await endDepsClaim(handle, { outcome: 'done' }, log);
    expect(f.rows.get(1)).toMatchObject({ state: 'pending', finalDescription: 'alex approved' });
    // An armed merge whose line failed stays 'armed' with no post time: renewed at once.
    const g = fakes({ failPostsFrom: 2 });
    setDepsClaimGithubForTest(g.g);
    const armed = await postDepsClaim('alex', target, log, Date.now, g.ledger);
    await endDepsClaim(armed.handle, { outcome: 'done' }, log);
    expect(g.rows.get(1)).toMatchObject({ state: 'armed', lastPostedAt: null });
  });

  it('an AI-pushed line GitHub did not take is ledgered on the PUSHED commit and kept (gap h)', async () => {
    const f = fakes({ failPostsFrom: 3 });
    setDepsClaimGithubForTest(f.g);
    const { handle } = await postDepsClaim('alex', { ...target, action: 'ai_fix' }, log, Date.now, f.ledger);
    await endDepsClaim(handle, { outcome: 'done', pushedSha: 'p0sh' }, log);
    await markAiPushedHead(handle, 'p0sh', log);
    expect(f.rows.get(2)).toMatchObject({ action: 'ai_pushed', headSha: 'p0sh', state: 'claiming', finalDescription: aiPushedLine('alex') });
  });
});
