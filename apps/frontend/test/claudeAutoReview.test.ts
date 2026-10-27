// Auto review's quiet states (lib/claudeAutoReview.ts): the header's "waiting" words, the one line
// about the auto fix, and the Open PRs strip's AI Fix pill.
import { describe, expect, it } from 'vitest';
import { AUTO_FIX_DAILY_CAP, type ClaudeReviewPrState } from '@pierre-review/shared';
import {
  AUTO_REVIEW_WAITING_LABEL,
  anyFixRunning,
  autoFixOutcomeLine,
  autoSweepResultLine,
  fixPillLabel,
} from '../src/lib/claudeAutoReview.js';

describe('"Run auto reviews now" / Retry — the one result line', () => {
  const base = {
    workspaceId: 1,
    queued: 0,
    retried: 0,
    checksQueued: 0,
    capped: false,
    laneFull: false,
    aiNotReady: false,
    busy: false,
    off: false,
  };
  it('says what was queued', () => {
    expect(autoSweepResultLine({ ...base, queued: 3, retried: 1 })).toBe('Queued 3 reviews.');
    expect(autoSweepResultLine({ ...base, queued: 1 })).toBe('Queued 1 review.');
    expect(autoSweepResultLine({ ...base, queued: 2, checksQueued: 1 })).toBe('Queued 2 reviews and 1 thread check.');
    expect(autoSweepResultLine({ ...base, queued: 2, capped: true })).toBe(
      'Queued 2 reviews. Daily limit reached for the rest.',
    );
  });
  it('says why nothing was queued', () => {
    expect(autoSweepResultLine(base)).toBe('Nothing to review.');
    expect(autoSweepResultLine({ ...base, capped: true })).toBe('Daily limit reached — 0 queued.');
    expect(autoSweepResultLine({ ...base, busy: true })).toMatch(/already being checked/);
    expect(autoSweepResultLine({ ...base, off: true })).toBe('Auto review is off for this workspace.');
    expect(autoSweepResultLine({ ...base, aiNotReady: true })).toMatch(/not set up/);
  });
  it('words the one-PR Retry', () => {
    expect(autoSweepResultLine({ ...base, queued: 1, retried: 1 }, true)).toBe('Retry queued.');
    expect(autoSweepResultLine(base, true)).toMatch(/^Nothing to retry/);
  });
});

describe('auto review waiting', () => {
  it('names what it waits for', () => {
    expect(AUTO_REVIEW_WAITING_LABEL.ci).toBe('Auto review waiting for CI');
    expect(AUTO_REVIEW_WAITING_LABEL.comments).toBe('Auto review waiting for comments to settle');
    expect(AUTO_REVIEW_WAITING_LABEL.commits).toBe('Auto review waiting for pushes to settle');
  });
});

describe('autoFixOutcomeLine', () => {
  it('nothing recorded ⇒ no line', () => {
    expect(autoFixOutcomeLine(null)).toBeNull();
    expect(autoFixOutcomeLine(undefined)).toBeNull();
  });
  it('a started fix points at the AI Fix tab', () => {
    expect(autoFixOutcomeLine({ reviewId: 1, status: 'started', fixId: 2 })).toBe(
      'Auto fix started. See the AI Fix tab.',
    );
  });
  it('a skip says why, with the cap the server counts to', () => {
    expect(autoFixOutcomeLine({ reviewId: 1, status: 'skipped', reason: 'cap' })).toBe(
      `No auto fix: ${AUTO_FIX_DAILY_CAP} auto fixes already ran on this PR in the last 24 hours.`,
    );
    expect(autoFixOutcomeLine({ reviewId: 1, status: 'skipped', reason: 'fix_waiting' })).toBe(
      'No auto fix: a finished fix is waiting to be pushed.',
    );
    expect(autoFixOutcomeLine({ reviewId: 1, status: 'skipped', reason: 'nothing_to_fix' })).toBe(
      'No auto fix: the review found nothing to fix.',
    );
    expect(autoFixOutcomeLine({ reviewId: 1, status: 'skipped', reason: 'off' })).toBe(
      'No auto fix: auto AI Fix is off for this workspace.',
    );
  });
});

describe('the AI Fix pill', () => {
  it('labels running and ready; nothing otherwise', () => {
    expect(fixPillLabel('running')).toBe('Fixing…');
    expect(fixPillLabel('ready')).toBe('Fix ready');
    expect(fixPillLabel(undefined)).toBeNull();
  });
  it('the column polls only while a fix runs', () => {
    const s = (fix?: 'running' | 'ready') => ({ prId: 1, fix }) as unknown as ClaudeReviewPrState;
    expect(anyFixRunning([s('ready'), s()])).toBe(false);
    expect(anyFixRunning([s('ready'), s('running')])).toBe(true);
    expect(anyFixRunning(undefined)).toBe(false);
  });
});
