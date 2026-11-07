// THE AI FIX TAB ON THE WORKSPACE SESSION (lib/aiFixSession.ts): when the session view shows, the status
// line, the Repositories rows (only the PR's repository is pushed) and how a row's `error` reads.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/aiFixSession.test.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { SandboxSessionPhase } from '@pierre-review/shared';
import { fixErrorTone, fixRepoStatus, fixSessionHoldsPr, fixSessionShown, fixSessionStatusLine, leftOutLine } from '../src/lib/aiFixSession.js';

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
});
