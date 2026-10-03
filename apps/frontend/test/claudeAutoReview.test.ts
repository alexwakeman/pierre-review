// Auto review's quiet states (lib/claudeAutoReview.ts): the header's "waiting" words, the one line
// about the auto fix, and the Open PRs strip's AI Fix pill.
import { describe, expect, it } from 'vitest';
import { AUTO_FIX_DAILY_CAP, type ClaudeReviewPrState } from '@pierre-review/shared';
import {
  AUTO_REVIEW_WAITING_LABEL,
  anyFixRunning,
  autoFixOutcomeLine,
  fixPillLabel,
} from '../src/lib/claudeAutoReview.js';

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
