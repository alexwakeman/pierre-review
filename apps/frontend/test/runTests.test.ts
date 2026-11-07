// "Run tests" results on older rows (read-only): the one-line status beside Push, the durations, and
// the copy rule that the sandboxed fix no longer says "Not built or tested here." (the agent ran the
// repository's checks itself and says so).
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/runTests.test.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { AiFixCheckResult, AiFixChecks } from '@pierre-review/shared';
import { checksStatusLine, formatDuration } from '../src/components/AiFix/RunTests.js';
import { PHASE_LABEL, fixProgressPct } from '../src/lib/aiFixProgress.js';

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
  it('"Not built or tested here." is gone, and the Run tests option with it', () => {
    const src = readFileSync(fileURLToPath(new URL('../src/components/AiFixTab.tsx', import.meta.url)), 'utf8');
    expect(src).not.toContain('Not built or tested here.');
    expect(src).not.toMatch(/RunTestsOption|useRunTests/);
  });
  it('the removed checks phases are gone from the ladder; a fix session reads cloning → fixing', () => {
    expect(PHASE_LABEL).not.toHaveProperty('preparing_checks');
    expect(PHASE_LABEL).not.toHaveProperty('running_checks');
    const at = (phase: string) => fixProgressPct({ status: 'running', fixId: 1, progress: { phase: phase as never } });
    expect(at('fixing')!).toBeGreaterThan(at('cloning')!);
    expect(PHASE_LABEL.planning).toBe('Making the plan');
  });
  it('durations read plainly', () => {
    expect(formatDuration(420)).toBe('420 ms');
    expect(formatDuration(2140)).toBe('2.1 s');
    expect(formatDuration(14_820)).toBe('15 s');
    expect(formatDuration(125_000)).toBe('2 min 5 s');
  });
});
