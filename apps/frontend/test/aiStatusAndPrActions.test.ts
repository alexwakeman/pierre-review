// The ONE agentic status line (components/AiStatusLine), Check threads' stage words, the This
// Sprint header's pass, and the PR actions reveal + Withdraw approval.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/aiStatusAndPrActions.test.ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { aiStatusText, formatElapsed } from '../src/components/AiStatusLine.js';
import { threadCheckStage } from '../src/components/CheckThreadsButton.js';
import { sprintAiPass, ticketChecksNote } from '../src/components/Activity/SprintView.js';
import { PR_ACTIONS_OPEN_KEY, readPrActionsOpen } from '../src/components/pr/PrActionsRow.js';
import { threadCheckActive } from '../src/hooks/useThreadCheck.js';

const src = (p: string) => readFileSync(join(__dirname, '../src', p), 'utf8');

describe('AiStatusLine', () => {
  it('prints the stage once, with one ellipsis, and a count when there is one', () => {
    expect(aiStatusText('Checking threads')).toBe('Checking threads…');
    expect(aiStatusText('Starting…')).toBe('Starting…');
    expect(aiStatusText('Summarising tickets', { done: 4, total: 12 })).toBe('Summarising tickets: 4 of 12…');
    expect(aiStatusText('Summarising tickets', { done: 0, total: 0 })).toBe('Summarising tickets…');
    expect(aiStatusText('X', { done: 9, total: 3 })).toBe('X: 3 of 3…');
  });
  it('formats the clock', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(7_400)).toBe('0:07');
    expect(formatElapsed(135_000)).toBe('2:15');
    expect(formatElapsed(3_723_000)).toBe('1:02:03');
    expect(formatElapsed(-5)).toBe('0:00');
  });
  it('every agentic surface uses it', () => {
    for (const p of [
      'components/ClaudeReviewTab.tsx',
      'components/CheckThreadsButton.tsx',
      'components/Activity/BlastImpactNote.tsx',
      'components/Activity/AttentionView.tsx',
      'components/Activity/SprintView.tsx',
      'components/Activity/SprintAskPanel.tsx',
      'components/Activity/StoryDocsAlignment.tsx',
    ]) {
      expect(src(p), p).toContain('<AiStatusLine');
    }
  });
});

describe('Check threads', () => {
  it('names each stage in words', () => {
    const run = { status: 'running' as const, threadsSent: null };
    expect(threadCheckStage({ status: 'queued', threadsSent: null }, null)).toBe('Waiting for a free slot');
    expect(threadCheckStage(run, { phase: 'preparing' })).toBe('Reading the threads');
    expect(threadCheckStage(run, { phase: 'checking', threadsSent: 1 })).toBe('Checking 1 thread');
    expect(threadCheckStage(run, { phase: 'checking', threadsSent: 4 })).toBe('Checking 4 threads');
    expect(threadCheckStage(run, null)).toBe('Checking threads');
    expect(threadCheckStage(run, { phase: 'saving' })).toBe('Saving');
  });
  it('polls only while queued or running', () => {
    expect(threadCheckActive('queued')).toBe(true);
    expect(threadCheckActive('running')).toBe(true);
    for (const s of ['succeeded', 'failed', 'cancelled', null] as const) expect(threadCheckActive(s)).toBe(false);
  });
  it('sits on the Threads tab and beside the Claude Review tab\'s Review threads section', () => {
    expect(src('components/PrDetail.tsx')).toContain('<CheckThreadsButton prId={pr.id} />');
    expect(src('components/ClaudeReviewTab.tsx')).toContain('<CheckThreadsButton prId={checkThreadsPrId} />');
    // Gated like Claude Review.
    expect(src('components/CheckThreadsButton.tsx')).toContain('<AiRunGate kind="thread_check">');
  });
  it('the Claude Review tab renders its threads from the current judgements', () => {
    expect(src('components/ClaudeReviewTab.tsx')).toContain('data.currentThreadAssessments');
  });
});

describe('This Sprint header pass', () => {
  const base = {
    aiEnabled: true,
    briefs: { current: 4, pending: 8 },
    passes: { briefsRunning: true, themesRunning: false },
    pathsStatus: null,
  } as unknown as Parameters<typeof sprintAiPass>[0];
  it('summaries first, with N of M', () => {
    expect(sprintAiPass(base)).toEqual({ stage: 'Summarising tickets', count: { done: 4, total: 12 } });
  });
  it('then themes', () => {
    expect(
      sprintAiPass({ ...base, briefs: { current: 12, pending: 0 }, passes: { briefsRunning: false, themesRunning: true } }),
    ).toEqual({ stage: 'Grouping tickets into themes', count: null });
  });
  it('says nothing when AI is off or nothing runs', () => {
    expect(sprintAiPass({ ...base, aiEnabled: false })).toBeNull();
    expect(
      sprintAiPass({ ...base, briefs: { current: 4, pending: 8 }, passes: { briefsRunning: false, themesRunning: false } }),
    ).toBeNull();
  });
});

describe('This Sprint refresh: the ticket-checks note', () => {
  it('says how many started, or why none could, and nothing otherwise', () => {
    expect(ticketChecksNote(undefined)).toBeNull();
    expect(ticketChecksNote({ started: 0, skipped: null })).toBeNull();
    expect(ticketChecksNote({ started: 1, skipped: null })).toBe('Checking 1 ticket against its pull requests.');
    expect(ticketChecksNote({ started: 3, skipped: null })).toBe('Checking 3 tickets against their pull requests.');
    expect(ticketChecksNote({ started: 0, skipped: 'no_credential' })).toBe('Ticket checks need Claude set up first.');
  });
});

describe('PR actions are hidden by default', () => {
  it('starts closed with no stored choice, a blocked store, or a closed choice', () => {
    expect(readPrActionsOpen(null)).toBe(false);
    expect(readPrActionsOpen({ getItem: () => null })).toBe(false);
    expect(readPrActionsOpen({ getItem: () => '0' })).toBe(false);
    expect(
      readPrActionsOpen({
        getItem: () => {
          throw new Error('blocked');
        },
      }),
    ).toBe(false);
  });
  it('opens only when this session opened it', () => {
    expect(readPrActionsOpen({ getItem: (k) => (k === PR_ACTIONS_OPEN_KEY ? '1' : null) })).toBe(true);
  });
  it('both places share the one control', () => {
    expect(src('components/ChecksTab.tsx')).toContain('<PrActionControls');
    expect(src('components/ClaudeReviewTab.tsx')).toContain('<PrActionControls');
    const row = src('components/pr/PrActionsRow.tsx');
    expect(row).toContain("{open ? 'Hide actions' : 'Show actions'}");
    expect(row).toContain('if (!open) {');
  });
});

describe('Withdraw approval', () => {
  it('asks first, then calls the route through the post-write helper', () => {
    const c = src('components/ApproveControl.tsx');
    expect(c).toContain('Withdraw approval');
    expect(c).toContain('Withdraw your approval?');
    expect(c).toContain("effective === 'approved'");
    const w = src('hooks/usePrWrites.ts');
    expect(w).toMatch(/useWithdrawApproval[\s\S]*?api\.withdrawApproval\(prId\)[\s\S]*?invalidateAfterPrWrite\(qc, prId\)/);
  });
});
