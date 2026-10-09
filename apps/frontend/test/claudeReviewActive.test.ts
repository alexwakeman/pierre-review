// A Claude review starting or finishing anywhere refetches that PR's review: the transitions of
// the polled active list (lib/claudeReviewActive.ts).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ActiveReview } from '@pierre-review/shared';
import {
  activeReviewSignatures,
  changedActivePrIds,
  prHasActiveReview,
} from '../src/lib/claudeReviewActive.js';

const src = (p: string): string => readFileSync(join(__dirname, '..', 'src', p), 'utf8');
const entry = (prId: number, reviewId: number | null, status: string, trigger = 'manual'): ActiveReview =>
  ({
    reviewId,
    prId,
    repoFullName: 'o/r',
    prNumber: prId,
    prTitle: 't',
    status,
    phase: null,
    trigger,
  }) as ActiveReview;
const sigs = (...r: ActiveReview[]) => activeReviewSignatures(r);

describe('changedActivePrIds', () => {
  it('reports nothing on the first poll', () => {
    expect(changedActivePrIds(null, sigs(entry(1, 10, 'running')))).toEqual([]);
  });
  it('a run that starts, and one that finishes', () => {
    const before = sigs(entry(1, 10, 'running'));
    const after = sigs(entry(2, 20, 'queued'));
    expect(changedActivePrIds(before, after)).toEqual([1, 2]);
  });
  it('a queued auto item getting its row, and queued → running', () => {
    expect(changedActivePrIds(sigs(entry(1, null, 'queued', 'auto')), sigs(entry(1, 11, 'queued', 'auto')))).toEqual([1]);
    expect(changedActivePrIds(sigs(entry(1, 11, 'queued')), sigs(entry(1, 11, 'running')))).toEqual([1]);
  });
  it('a re-review replacing a finished run between two polls', () => {
    expect(changedActivePrIds(sigs(entry(1, 11, 'running')), sigs(entry(1, 12, 'running')))).toEqual([1]);
  });
  it('nothing moved: nothing to refetch (a phase change is not a transition)', () => {
    expect(changedActivePrIds(sigs(entry(1, 11, 'running')), sigs(entry(1, 11, 'running')))).toEqual([]);
  });
  it('two entries for one PR fold into one order-free signature', () => {
    const a = sigs(entry(1, null, 'queued', 'auto'), entry(1, 9, 'running'));
    const b = sigs(entry(1, 9, 'running'), entry(1, null, 'queued', 'auto'));
    expect(changedActivePrIds(a, b)).toEqual([]);
    expect(changedActivePrIds(a, sigs(entry(1, 9, 'running')))).toEqual([1]);
  });
});

describe('prHasActiveReview', () => {
  it('reads membership, undefined before the first poll', () => {
    expect(prHasActiveReview(undefined, 1)).toBe(false);
    expect(prHasActiveReview([entry(1, null, 'queued', 'auto')], 1)).toBe(true);
    expect(prHasActiveReview([entry(2, 3, 'running')], 1)).toBe(false);
  });
});

describe('wiring', () => {
  it('the sync hook is mounted once in App and only observes (never fetches)', () => {
    expect(src('App.tsx')).toMatch(/useClaudeReviewActiveSync\(\);/);
    const hook = src('hooks/useClaudeReview.ts');
    const body = hook.slice(hook.indexOf('export function useClaudeReviewActiveSync'));
    expect(body.slice(0, body.indexOf('\n}\n'))).toMatch(/enabled: false/);
  });
  it('the PR refresh poll refetches the review when the PR changed', () => {
    expect(src('hooks/usePrLiveRefresh.ts')).toMatch(/queryKey: \['claude-review', prId\]/);
  });
});
