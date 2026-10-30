// AI Fix "Run tests": what a start sends, the one-line status beside Push, and the copy rule that
// "Not built or tested here." shows only when no check ran.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/runTests.test.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { AiFixCheckResult, AiFixChecks, AiFixChecksPreview } from '@pierre-review/shared';
import { checksStatusLine, formatDuration, pickedCheckNames } from '../src/components/AiFix/RunTests.js';
import { PHASE_LABEL, fixProgressPct } from '../src/lib/aiFixProgress.js';

const preview: AiFixChecksPreview = {
  sandbox: 'seatbelt',
  unavailable: null,
  unsandboxed: false,
  checks: [
    { name: 'lint', kind: 'lint', command: 'pnpm run lint', source: '', defaultOn: true, needsDocker: false, refused: null },
    { name: 'test', kind: 'test', command: 'pnpm run test', source: '', defaultOn: true, needsDocker: false, refused: null },
    { name: 'test:e2e', kind: 'test', command: 'pnpm run test:e2e', source: '', defaultOn: false, needsDocker: false, refused: null },
    { name: 'release', kind: 'check', command: 'pnpm run release', source: '', defaultOn: false, needsDocker: false, refused: 'It publishes a package.' },
  ],
};

describe('pickedCheckNames', () => {
  it('sends the defaults, the reader’s ticks on top, never a refused check', () => {
    expect(pickedCheckNames(preview, true, {})).toEqual(['lint', 'test']);
    expect(pickedCheckNames(preview, true, { lint: false, 'test:e2e': true, release: true })).toEqual(['test', 'test:e2e']);
  });
  it('sends nothing when off, still loading, or unavailable here', () => {
    expect(pickedCheckNames(preview, false, {})).toEqual([]);
    expect(pickedCheckNames(undefined, true, {})).toEqual([]);
    expect(pickedCheckNames({ ...preview, unavailable: 'Tests can’t run here.' }, true, {})).toEqual([]);
  });
});

const r = (name: string, status: AiFixCheckResult['status']): AiFixCheckResult => ({
  name,
  kind: 'test',
  command: name,
  status,
  exitCode: status === 'passed' ? 0 : 1,
  durationMs: 1200,
  output: '',
  truncated: false,
  note: null,
});
const checks = (over: Partial<AiFixChecks>): AiFixChecks => ({
  requested: ['test'],
  ran: true,
  note: null,
  sandbox: 'seatbelt',
  install: [],
  results: [],
  hook: null,
  hookAttempts: 0,
  agentRuns: 0,
  ...over,
});

describe('checksStatusLine (beside Push)', () => {
  it('none when tests were not asked for', () => {
    expect(checksStatusLine(null)).toBeNull();
    expect(checksStatusLine(undefined)).toBeNull();
  });
  it('counts passed and failed, the hook included, skipped left out', () => {
    expect(checksStatusLine(checks({ results: [r('lint', 'passed'), r('test', 'passed')] }))).toEqual({ text: 'Tests: 2 passed', tone: 'ready' });
    expect(checksStatusLine(checks({ results: [r('lint', 'passed'), r('test', 'failed'), r('e2e', 'skipped')], hook: r('pre-commit hook', 'timed_out') }))).toEqual({
      text: 'Tests: 1 passed, 2 failed',
      tone: 'blocked',
    });
  });
  it('says plainly when they did not run', () => {
    expect(checksStatusLine(checks({ ran: false, note: 'No sandbox.' }))).toEqual({ text: 'Tests did not run.', tone: 'neutral' });
  });
});

describe('the copy and the progress ladder', () => {
  it('"Not built or tested here." shows only when no check ran', () => {
    const src = readFileSync(fileURLToPath(new URL('../src/components/AiFixTab.tsx', import.meta.url)), 'utf8');
    expect(src).toContain("{!fix.checks?.ran && ' · Not built or tested here.'}");
  });
  it('the two new phases have words and a place on the ladder', () => {
    expect(PHASE_LABEL.preparing_checks).toBe('Installing dependencies');
    expect(PHASE_LABEL.running_checks).toBe('Running the tests');
    const at = (phase: string) => fixProgressPct({ status: 'running', fixId: 1, progress: { phase: phase as never } });
    expect(at('preparing_checks')!).toBeGreaterThan(at('cloning')!);
    expect(at('running_checks')!).toBeLessThan(at('capturing')!);
  });
  it('durations read plainly', () => {
    expect(formatDuration(420)).toBe('420 ms');
    expect(formatDuration(2140)).toBe('2.1 s');
    expect(formatDuration(14_820)).toBe('15 s');
    expect(formatDuration(125_000)).toBe('2 min 5 s');
  });
});
