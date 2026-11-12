// THE AUTO FIX QUEUE's words in the AI Review tab and the toast (components/AutoFixQueuePanel.tsx, shared
// auto-fix-queue.ts). Pure.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/autoFixQueue.test.ts
import { describe, expect, it } from 'vitest';
import { AUTO_FIX_QUEUE_LINE, autoFixRowLine, type AutoFixHistoryRow, type AutoFixQueueState } from '@pierre-review/shared';
import { autoFixHistoryWords, autoFixQueueText, waitLeftText } from '../src/components/AutoFixQueuePanel.js';

const NOW = Date.parse('2026-11-12T10:00:00.000Z');
const q = (o: Partial<AutoFixQueueState>): AutoFixQueueState => ({
  prId: 1,
  headSha: 'h',
  status: 'waiting',
  reason: 'ci_running',
  line: AUTO_FIX_QUEUE_LINE.ci_running,
  until: null,
  fixId: null,
  source: null,
  at: new Date(NOW).toISOString(),
  ...o,
});
const h = (o: Partial<AutoFixHistoryRow>): AutoFixHistoryRow => ({
  id: 1,
  status: 'succeeded',
  sourceReviewId: 5,
  items: 3,
  addressed: 2,
  unaddressed: 1,
  commitMessage: 'Fix it',
  pushedAt: null,
  pushedBranch: null,
  error: null,
  createdAt: new Date(NOW).toISOString(),
  finishedAt: null,
  ...o,
});

describe('the queue line', () => {
  it('says how long a wait may last, rounded up to the minute', () => {
    expect(waitLeftText(null, NOW)).toBeNull();
    expect(waitLeftText(new Date(NOW + 30_000).toISOString(), NOW)).toBe('less than a minute');
    expect(waitLeftText(new Date(NOW + 9.2 * 60_000).toISOString(), NOW)).toBe('up to 10 min');
    expect(autoFixQueueText(q({ until: new Date(NOW + 12 * 60_000).toISOString() }), NOW)).toBe('Waiting for the CI jobs to finish (up to 12 min).');
    expect(autoFixQueueText(q({ reason: 'fix_running', line: AUTO_FIX_QUEUE_LINE.fix_running }), NOW)).toBe(AUTO_FIX_QUEUE_LINE.fix_running);
    // Not a wait: the line as it is.
    expect(autoFixQueueText(q({ status: 'idle', reason: 'cap', line: AUTO_FIX_QUEUE_LINE.cap, until: new Date(NOW + 60 * 60_000).toISOString() }), NOW)).toBe(AUTO_FIX_QUEUE_LINE.cap);
  });
});

describe('a history row', () => {
  it('names the status, the source and the outcome', () => {
    expect(autoFixHistoryWords(h({}))).toEqual({ status: 'Done', source: 'From the AI review', outcome: '2 of 3 points addressed' });
    expect(autoFixHistoryWords(h({ sourceReviewId: null, pushedAt: '2026-11-12T10:05:00.000Z' })).status).toBe('Pushed');
    expect(autoFixHistoryWords(h({ sourceReviewId: null })).source).toBe('From the CI review');
    expect(autoFixHistoryWords(h({ error: 'Automatic push failed: GitHub refused the push.' })).status).toBe('Push failed');
    expect(autoFixHistoryWords(h({ status: 'running', addressed: null, items: 1 }))).toMatchObject({ status: 'Fixing', outcome: '1 point' });
  });
});

describe('the toast row', () => {
  it('reads running, failed, pushed, ready', () => {
    expect(autoFixRowLine({ status: 'running', failed: false, pushedAt: null })).toBe('Fixing…');
    expect(autoFixRowLine({ status: 'succeeded', failed: true, pushedAt: null })).toBe('Failed');
    expect(autoFixRowLine({ status: 'succeeded', failed: false, pushedAt: 'x' })).toBe('Pushed');
    expect(autoFixRowLine({ status: 'succeeded', failed: false, pushedAt: null })).toBe('Ready to push');
  });
});
