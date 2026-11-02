// The merge-when-ready rows in the header toast panel: ONE status per arming, in plain words.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend mergeRowStatus
import { describe, expect, it } from 'vitest';
import type { ArmedMergePhase, ArmedMergeRequest } from '@pierre-review/shared';
import {
  foldArmedPoll,
  liveMergeStatus,
  outcomeMergeStatus,
  shortMergeReason,
} from '../src/components/AutoMergeBanner.js';

function armed(over: Partial<ArmedMergeRequest> = {}): ArmedMergeRequest {
  return {
    prId: 7,
    repoOwner: 'acme',
    repoName: 'api',
    prNumber: 12,
    prTitle: 'Bump',
    mergeMethod: 'squash',
    updateStrategy: 'none',
    viaMergeQueue: false,
    enqueuedAt: null,
    armedAt: '2026-11-02T10:00:00.000Z',
    expectedHeadOid: 'aaa',
    state: 'armed',
    lastCheckedAt: null,
    lastReason: null,
    phase: 'awaiting_checks',
    expiresAt: '2026-11-05T10:00:00.000Z',
    ...over,
  } as ArmedMergeRequest;
}

describe('liveMergeStatus', () => {
  it('names the wait in plain words, one status only', () => {
    expect(liveMergeStatus(armed()).text).toBe('Waiting for CI');
    expect(liveMergeStatus(armed({ phase: 'awaiting_review' }))).toEqual({
      text: 'Blocked: needs approval',
      tone: 'blocked',
    });
    expect(liveMergeStatus(armed({ phase: 'merging' })).tone).toBe('working');
  });

  it('has a status for every phase, and null reads as a plain wait', () => {
    const phases: ArmedMergePhase[] = [
      'pending_first_check', 'waiting_conflicts', 'waiting_behind', 'updating_rebase',
      'updating_merge', 'awaiting_checks', 'awaiting_review', 'blocked_protection', 'enqueuing',
      'queued', 'queued_local', 'merging', 'retrying', 'checks_failed',
    ];
    for (const phase of phases) expect(liveMergeStatus(armed({ phase })).text).not.toBe('Waiting');
    expect(liveMergeStatus(armed({ phase: null })).text).toBe('Waiting');
  });

  it('never words the head of a one-PR queue as a wait', () => {
    expect(liveMergeStatus(armed({ phase: 'queued_local', queuePosition: 1, queueDepth: 1 })).text).toBe('Next up');
    expect(liveMergeStatus(armed({ phase: 'queued_local', queuePosition: 2, queueDepth: 3 })).text).toBe(
      'Waiting its turn (2 of 3)',
    );
    expect(liveMergeStatus(armed({ phase: 'queued_local', yieldedForFailedChecks: true })).tone).toBe('blocked');
  });

  it('never repeats the watcher prose under the status', () => {
    const s = liveMergeStatus(armed({ phase: 'checks_failed', lastReason: 'checks failed — waiting for them to pass' }));
    expect(s.text).toBe('Blocked: checks failed');
  });
});

describe('outcomeMergeStatus', () => {
  it('reads Merged off the state even though the reason is null', () => {
    expect(outcomeMergeStatus('merged', null)).toEqual({ text: 'Merged', tone: 'good' });
  });
  it('puts a short reason after Failed / Stopped', () => {
    expect(outcomeMergeStatus('failed', 'github: Base branch was modified').text).toBe(
      'Failed: Base branch was modified',
    );
    expect(outcomeMergeStatus('disarmed_blocked', 'the PR was closed outside auto-merge').text).toBe(
      'Stopped: the PR was closed outside auto-merge',
    );
    expect(outcomeMergeStatus('failed', null).text).toBe('Failed');
    expect(outcomeMergeStatus('expired', 'the 72-hour window passed').text).toBe('Expired');
  });
});

describe('shortMergeReason', () => {
  it('drops the machine prefix and keeps the first clause', () => {
    expect(shortMergeReason('waiting: conflicts with main — 2nd of 3')).toBe('conflicts with main');
    expect(shortMergeReason('   ')).toBeNull();
    expect(shortMergeReason(null)).toBeNull();
  });
  it('caps a long reason with an ellipsis', () => {
    const r = shortMergeReason('x'.repeat(100), 20)!;
    expect(r.length).toBe(20);
    expect(r.endsWith('…')).toBe(true);
  });
});

describe('foldArmedPoll stamps the outcome time', () => {
  it('uses the watcher\'s terminal write, not when this tab saw it (a reload must not read "just now")', () => {
    const now = Date.parse('2026-11-02T12:00:00.000Z');
    const fold = foldArmedPoll(
      new Map([[7, 'armed']]),
      [armed({ state: 'merged', phase: null, lastCheckedAt: '2026-11-02T09:15:00.000Z' })],
      now,
    );
    expect(fold.fresh[0]?.at).toBe('2026-11-02T09:15:00.000Z');
  });
  it('falls back to the poll time when the row carries no check time', () => {
    const now = Date.parse('2026-11-02T12:00:00.000Z');
    const fold = foldArmedPoll(new Map([[7, 'armed']]), [armed({ state: 'merged', phase: null })], now);
    expect(fold.fresh[0]?.at).toBe('2026-11-02T12:00:00.000Z');
  });
});
