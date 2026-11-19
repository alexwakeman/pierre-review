// THE AI FIX TAB ON THE WORKSPACE SESSION (lib/aiFixSession.ts): when the session view shows, the status
// line, the Repositories rows (only the PR's repository is pushed) and how a row's `error` reads.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/aiFixSession.test.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { SandboxSessionPhase } from '@pierre-review/shared';
import type { AiFixLoop, AiFixLoopRound } from '@pierre-review/shared';
import {
  fixErrorTone,
  fixMergeBlockedLine,
  fixMergeLine,
  fixPushable,
  fixLoopCannotMeetLines,
  fixLoopStatusLine,
  fixLoopStrip,
  fixPushFooter,
  fixRepoStatus,
  fixSessionHoldsPr,
  fixSessionShown,
  fixSessionStatusLine,
  leftOutLine,
} from '../src/lib/aiFixSession.js';

const s = (phase: SandboxSessionPhase, live: boolean, resumable = false) => ({ phase, live, resumable, mode: 'build' as const });

describe('fixSessionShown', () => {
  it('shows a live session in every phase but the ended ones', () => {
    for (const p of ['booting', 'ready', 'chatting', 'building', 'built'] as const) expect(fixSessionShown(s(p, true))).toBe(true);
  });
  it('shows a closed session only when it can be resumed', () => {
    expect(fixSessionShown(s('built', false, true))).toBe(true);
    expect(fixSessionShown(s('built', false, false))).toBe(false);
    expect(fixSessionShown(s('pushed', false))).toBe(false);
    expect(fixSessionShown(s('discarded', false))).toBe(false);
    expect(fixSessionShown(s('failed', false))).toBe(false);
  });
  it('a row of the removed fixer has no session', () => {
    expect(fixSessionShown(null)).toBe(false);
    expect(fixSessionHoldsPr(null)).toBe(false);
  });
  it('only a live session holds the PR (the picker waits)', () => {
    expect(fixSessionHoldsPr(s('built', true))).toBe(true);
    expect(fixSessionHoldsPr(s('built', false, true))).toBe(false);
  });
});

describe('fixSessionStatusLine', () => {
  it('Plan first waits for Start fix', () => {
    expect(fixSessionStatusLine({ phase: 'ready', live: true, mode: 'chat' }, false)).toBe('The plan is ready. Talk to the agent, then press Start fix.');
    expect(fixSessionStatusLine({ phase: 'chatting', live: true, mode: 'chat' }, false)).toBe('The agent is making a plan.');
  });
  it('a closed automatic fix says so', () => {
    expect(fixSessionStatusLine({ phase: 'built', live: false, mode: 'build' }, true)).toMatch(/^An automatic fix\. The sandbox is closed/);
    expect(fixSessionStatusLine({ phase: 'built', live: true, mode: 'build' }, false)).toBe('Fixed. Review the changes and push them, or ask for more.');
  });
});

describe('fixRepoStatus', () => {
  const base = { prRepoId: 10, headRef: 'feature/x', filesChanged: 2, pushed: false, leftOut: [{ repoId: 11, fullName: 'acme/api', files: ['a.ts'] }] };
  it('the PR repository is pushed to the PR branch', () => {
    expect(fixRepoStatus({ repoId: 10 }, base)).toEqual({ status: '2 files changed', note: 'Pushes to feature/x' });
    expect(fixRepoStatus({ repoId: 10 }, { ...base, filesChanged: 0 }).status).toBe('No changes yet');
    expect(fixRepoStatus({ repoId: 10 }, { ...base, pushed: true }).status).toBe('Pushed');
    expect(fixRepoStatus({ repoId: 10 }, { ...base, headRef: null }).note).toBe('Pushes to the PR branch');
  });
  it('every other repository is read only, its edits left out', () => {
    expect(fixRepoStatus({ repoId: 11 }, base)).toEqual({ status: '1 file left out', note: 'Read only. Edits here are left out.' });
    expect(fixRepoStatus({ repoId: 12 }, base)).toEqual({ status: 'Read only', note: null });
  });
  it('the left-out line names both repositories', () => {
    expect(leftOutLine({ fullName: 'acme/api' }, 'acme/web')).toBe('Edits in acme/api are left out. AI Fix pushes only acme/web.');
  });
});

describe('the merge (the "Resolve merge conflicts" item)', () => {
  const m = (status: 'pending' | 'valid' | 'invalid' | 'missing', reason: string | null = null) => ({
    baseRef: 'main',
    baseSha: 'e'.repeat(40),
    conflictedFiles: ['a.ts', 'b.ts'],
    status,
    reason,
    resolutionDiff: null,
    resolutionFiles: [],
  });
  it('Push sends only a valid merge; without one, only a patch', () => {
    expect(fixPushable({ patch: null, filesChanged: [], merge: m('valid') })).toBe(true);
    for (const st of ['pending', 'invalid', 'missing'] as const) expect(fixPushable({ patch: 'diff', filesChanged: ['x'], merge: m(st) })).toBe(false);
    expect(fixPushable({ patch: 'diff', filesChanged: ['x'], merge: null })).toBe(true);
    expect(fixPushable({ patch: null, filesChanged: [], merge: null })).toBe(false);
  });
  it('the check line names both parents, or why nothing is pushed', () => {
    expect(fixMergeLine(m('valid'), 'd'.repeat(40))).toEqual({
      tone: 'ok',
      text: 'Ensemble checked the merge commit. Its parents are the PR head (ddddddd) and main (eeeeeee). No conflict markers are left in the 2 files that were in conflict.',
    });
    expect(fixMergeLine(m('invalid', 'the merge has the wrong parents.'), null)).toEqual({ tone: 'bad', text: 'Nothing will be pushed: the merge has the wrong parents.' });
    expect(fixMergeLine(m('missing'), null).tone).toBe('bad');
    expect(fixMergeLine(m('pending'), null)).toEqual({ tone: 'pending', text: 'The merge of main is not finished.' });
  });
  it('a built session with a refused merge says nothing can be pushed', () => {
    expect(fixMergeBlockedLine(m('invalid'), { phase: 'built' })).toMatch(/nothing can be pushed/);
    expect(fixMergeBlockedLine(m('valid'), { phase: 'built' })).toBeNull();
    expect(fixMergeBlockedLine(m('missing'), { phase: 'building' })).toBeNull();
    expect(fixMergeBlockedLine(null, { phase: 'built' })).toBeNull();
  });
  it('the PR repository row says the base is merged', () => {
    const base = { prRepoId: 10, headRef: 'feature/x', filesChanged: 1, pushed: false, leftOut: [] };
    expect(fixRepoStatus({ repoId: 10 }, { ...base, merge: m('valid') }).status).toBe('main merged · 1 file changed');
    expect(fixRepoStatus({ repoId: 10 }, { ...base, filesChanged: 0, merge: m('valid') }).status).toBe('main merged');
    expect(fixRepoStatus({ repoId: 10 }, { ...base, merge: m('invalid') }).status).toBe('Merge not valid');
    expect(fixRepoStatus({ repoId: 10 }, { ...base, merge: m('pending') }).status).toBe('1 file changed');
  });
});

describe('fixErrorTone', () => {
  const session = { phase: 'built' } as never;
  it('an automatic push that failed is a warning', () => {
    expect(fixErrorTone({ error: 'Automatic push failed: the branch moved since the fix was made.', session })).toBe('warn');
  });
  it('a closed session’s line on a kept fix is a note', () => {
    expect(fixErrorTone({ error: 'Closed after 60 minutes with nothing happening. Your changes are kept: push them, or resume to keep working.', session })).toBe('note');
  });
  it('an older row keeps its warning; no error, no line', () => {
    expect(fixErrorTone({ error: 'Automatic push failed: x', session: null })).toBe('warn');
    expect(fixErrorTone({ error: 'something', session: null })).toBe('warn');
    expect(fixErrorTone({ error: null, session })).toBeNull();
  });
});

describe('the tab', () => {
  const src = readFileSync(fileURLToPath(new URL('../src/components/AiFixTab.tsx', import.meta.url)), 'utf8');
  it('runs every fix in the shared session view, with the no-runtime line Implement uses', () => {
    expect(src).toMatch(/<SharedSessionView\b/);
    expect(src).toMatch(/<SandboxRuntimeLine status=\{runtime\.data\}/);
    // HIDE, never disable: with no runtime there is no Start fix button at all.
    expect(src).toMatch(/!noRuntime && \(/);
  });
  it('the shell-less fixer’s progress bar and Run tests option are gone', () => {
    expect(src).not.toMatch(/RegenProgressBar|useAiFixStream|RunTestsOption|<PlanPanel\b/);
  });
  it('has no separate conflict run: no ConflictAiCard, no "Also resolve" box', () => {
    expect(src).not.toMatch(/ConflictAiCard|useConflictAiResolve|startConflictAiRun|Also resolve merge conflicts/);
    expect(src).toMatch(/<MergeResult\b/);
  });
});

describe('fixPushFooter — THE PUSH FOOTER', () => {
  const base = {
    pushedAt: null,
    pushedBranch: null,
    pushedCommitSha: null,
    pushedAutomatically: false,
    pushing: false,
    pushHold: null,
    error: null,
  };
  const o = { headRef: 'feature/x', repoFullName: 'acme/app' };

  it('a pushed fix is a record: the branch and the commit, linked; "Pushed automatically" when not a press', () => {
    expect(fixPushFooter({ ...base, pushedAt: '2026-11-18T10:00:00Z', pushedBranch: 'feature/x', pushedCommitSha: 'c0ffee1234', pushedAutomatically: true }, o)).toEqual({
      kind: 'pushed',
      branch: 'feature/x',
      sha: 'c0ffee1234',
      shortSha: 'c0ffee1',
      commitUrl: 'https://github.com/acme/app/commit/c0ffee1234',
      automatic: true,
    });
  });

  it('a fix pushed before the commit was stored shows the branch only', () => {
    expect(fixPushFooter({ ...base, pushedAt: '2026-11-18T10:00:00Z', pushedBranch: 'feature/x' }, o)).toMatchObject({ kind: 'pushed', sha: null, commitUrl: null, automatic: false });
  });

  it('⚠ pushed wins over everything: a stale pushing flag, an old failure or hold never bring Push back', () => {
    const f = { ...base, pushedAt: '2026-11-18T10:00:00Z', pushedBranch: 'b', pushing: true, error: 'Automatic push failed: x', pushHold: { line: 'h' } };
    expect(fixPushFooter(f, o).kind).toBe('pushed');
  });

  it('⚠ an automatic push on its way: no button, the branch named', () => {
    expect(fixPushFooter({ ...base, pushing: true, pushHold: { line: 'h' } }, o)).toEqual({ kind: 'pushing', branch: 'feature/x' });
    expect(fixPushFooter({ ...base, pushing: true }, { ...o, headRef: null })).toEqual({ kind: 'pushing', branch: null });
  });

  it('a failed automatic push keeps Push, with the reason above it', () => {
    expect(fixPushFooter({ ...base, error: 'Automatic push failed: the branch moved since the fix was made.' }, o)).toEqual({
      kind: 'failed',
      line: 'Automatic push failed: the branch moved since the fix was made.',
    });
  });

  it('"Push when done" held: the session line above Push; any other row error is not the footer\'s', () => {
    expect(fixPushFooter({ ...base, pushHold: { line: 'Not pushed: this is not your pull request. Press Push to push to its branch.' } }, o)).toMatchObject({ kind: 'held' });
    expect(fixPushFooter({ ...base, error: 'The sandbox was closed after 30 minutes idle.' }, o)).toEqual({ kind: 'plain' });
    // STALE (AiFix.stale): ONE line above Push; a push hold for it wins (it says the same, as a hold).
    expect(fixPushFooter({ ...base, stale: { line: '#12 changed after this fix was built.' } }, o)).toEqual({ kind: 'held', line: '#12 changed after this fix was built.' });
    expect(fixPushFooter({ ...base, stale: { line: '#12 changed after this fix was built.' }, pushHold: { line: 'Not pushed: #12 changed after this fix was built. Check it, then press Push.' } }, o)).toEqual({
      kind: 'held',
      line: 'Not pushed: #12 changed after this fix was built. Check it, then press Push.',
    });
    expect(fixPushFooter({ ...base, pushedAt: '2026-11-18T10:00:00Z', stale: { line: 'x' } }, o).kind).toBe('pushed');
  });

  it('an older server (no push fields) reads as plain Push', () => {
    expect(fixPushFooter({ pushedAt: null, pushedBranch: null, error: null }, o)).toEqual({ kind: 'plain' });
  });
});

describe('THE REVIEW LOOP — the footer, the status line, the rounds strip', () => {
  const round = (n: number, over: Partial<AiFixLoopRound> = {}): AiFixLoopRound => ({
    round: n,
    step: n,
    closing: false,
    headSha: null,
    review: 'succeeded',
    providers: ['claude'],
    verdict: 'COMMENT',
    summary: null,
    storyCheck: null,
    open: { findings: 0, criteria: 0 },
    counts: { found: 0, fixed: 0, answered: 0, pushedBack: 0, cannotMeet: 0 },
    findings: [],
    criteria: [],
    fix: 'none',
    ...over,
  });
  const loop = (over: Partial<AiFixLoop> = {}): AiFixLoop => ({
    state: 'reviewing',
    round: 2,
    firstRound: 1,
    rounds: 5,
    stop: null,
    stopLine: null,
    running: true,
    history: [],
    cannotMeet: [],
    importedReviewId: null,
    ...over,
  });
  const o = { headRef: 'feature/x', repoFullName: 'acme/app' };
  const base = { pushedAt: null, pushedBranch: null, pushedCommitSha: null, pushedAutomatically: false, pushing: false, pushHold: null, error: null };

  it('⚠ while the loop works there is no Push: "Reviewing, round 2 of 5."; pushed still wins', () => {
    expect(fixPushFooter({ ...base, loop: loop() }, o)).toEqual({ kind: 'reviewing', line: 'Reviewing, round 2 of 5.' });
    expect(fixPushFooter({ ...base, loop: loop({ state: 'fixing' }) }, o)).toEqual({ kind: 'reviewing', line: 'Fixing, round 2 of 5.' });
    expect(fixPushFooter({ ...base, loop: loop({ round: 6 }) }, o)).toEqual({ kind: 'reviewing', line: 'Reviewing, the closing round.' });
    expect(fixPushFooter({ ...base, pushedAt: '2026-11-18T10:00:00Z', pushedBranch: 'b', loop: loop() }, o).kind).toBe('pushed');
    // Ended: the usual footer.
    expect(fixPushFooter({ ...base, loop: loop({ state: 'done', stop: 'clean' }) }, o)).toEqual({ kind: 'plain' });
  });

  it('the status line says the loop works and nothing is pushed; null once it ended', () => {
    expect(fixLoopStatusLine(loop())).toBe('Reviewing, round 2 of 5. Nothing is pushed until the review ends.');
    expect(fixLoopStatusLine(loop({ state: 'fixing' }))).toBe('Fixing, round 2 of 5. The agent is answering the review.');
    expect(fixLoopStatusLine(loop({ state: 'stopped', stop: 'budget' }))).toBeNull();
    expect(fixLoopStatusLine(null)).toBeNull();
  });

  it('the strip: round k found / fixed / answered / pushed back / cannot meet, zeros left out, no counts before a review succeeded; the closing review named', () => {
    const rows = fixLoopStrip({
      history: [
        round(1, { fix: 'done', counts: { found: 4, fixed: 2, answered: 1, pushedBack: 0, cannotMeet: 1 } }),
        round(2, { review: 'running' }),
        round(6, { step: 6, closing: true, counts: { found: 0, fixed: 0, answered: 0, pushedBack: 0, cannotMeet: 0 } }),
        round(7, { step: 1, review: 'failed' }),
      ],
    });
    expect(rows.map((r) => `${r.title}|${r.status}|${r.tone}|${r.cells.map((c) => `${c.n} ${c.label}`).join(', ')}`)).toEqual([
      'Round 1|Reviewed|open|4 found, 2 fixed, 1 answered, 1 cannot meet',
      // ⚠ unknown is never zero: a review not succeeded shows no counts.
      'Round 2|Reviewing|running|',
      'Closing review|Reviewed|ok|0 found',
      'Round 1|Review failed|bad|',
    ]);
    expect(fixLoopStrip({ history: [round(3, { fix: 'running', counts: { found: 2, fixed: 0, answered: 0, pushedBack: 0, cannotMeet: 0 } })] })[0]).toMatchObject({ status: 'Fixing', tone: 'running' });
  });

  it('a criterion the agent cannot meet stays NOT MET, with its reason', () => {
    expect(fixLoopCannotMeetLines({ cannotMeet: [{ ref: 'AC2', text: 'Export to PDF', reason: 'No PDF library here.' }] })).toEqual([
      { ref: 'AC2', text: 'Export to PDF', line: 'Not met: the agent says this cannot be done: No PDF library here.' },
    ]);
  });
});
