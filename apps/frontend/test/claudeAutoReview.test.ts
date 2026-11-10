// Auto review's quiet states (lib/claudeAutoReview.ts): the header's "waiting" words, the one line
// about the auto fix, and the Open PRs strip's AI Fix pill.
import { describe, expect, it } from 'vitest';
import type { ClaudeReviewPrState } from '@pierre-review/shared';
import {
  AUTO_REVIEW_WAITING_LABEL,
  anyFixRunning,
  autoFixOutcomeLine,
  autoReviewWhyLine,
  autoSweepResultLine,
  failedAutoReviewLine,
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
    // A press that queued only a replies pass is not "Nothing to review".
    expect(autoSweepResultLine({ ...base, repliesQueued: 1 })).toBe('Queued 1 reply check.');
    expect(autoSweepResultLine({ ...base, queued: 1, checksQueued: 2, repliesQueued: 2 })).toBe(
      'Queued 1 review, 2 thread checks and 2 reply checks.',
    );
    expect(autoSweepResultLine({ ...base, queued: 1, retried: 1, repliesQueued: 1 }, true)).toBe(
      'Queued 1 review and 1 reply check.',
    );
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
  it('a skip shows only a fault the reader can fix here', () => {
    expect(autoFixOutcomeLine({ reviewId: 1, status: 'skipped', reason: 'no_sandbox' })).toBe(
      'No auto fix: no container runtime is running on this computer.',
    );
    expect(autoFixOutcomeLine({ reviewId: 1, status: 'skipped', reason: 'over_budget' })).toBe(
      'No auto fix: your AI spend budget is reached.',
    );
    for (const reason of ['off', 'cap', 'fix_waiting', 'nothing_to_fix', 'head_moved'] as const) {
      expect(autoFixOutcomeLine({ reviewId: 1, status: 'skipped', reason })).toBeNull();
    }
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

describe('the AI Review tab’s failed-auto line (`failedAutoReviewLine`)', () => {
  const USAGE = 'Codex could not finish: You’ve hit your usage limit.';
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const run = (o: { status: string; trigger: 'auto' | 'manual'; error?: string | null; outdated?: boolean | null }) =>
    ({
      status: o.status,
      trigger: o.trigger,
      error: o.error ?? null,
      head: o.outdated == null ? null : { currentHeadSha: 'h', outdated: o.outdated, commitsSince: 0 },
    }) as any;

  it('the live PRs (auto failed → manual succeeded → manual failed): the auto failure, with Retry', () => {
    // Latest run 593 is a MANUAL failure; the server names 583 as the failed auto run at the head.
    expect(
      failedAutoReviewLine({
        review: run({ status: 'failed', trigger: 'manual', error: USAGE, outdated: false }),
        failedAutoAtHead: { reviewId: 583, error: USAGE },
      }),
    ).toEqual({ error: USAGE, retry: true });
    // Same while the latest manual run SUCCEEDED (588, before 593 existed).
    expect(
      failedAutoReviewLine({
        review: run({ status: 'succeeded', trigger: 'manual', outdated: false }),
        failedAutoAtHead: { reviewId: 583, error: USAGE },
      }),
    ).toEqual({ error: USAGE, retry: true });
  });

  it('a failed auto run at an older head: Retry (it reviews the new head)', () => {
    expect(
      failedAutoReviewLine({ review: run({ status: 'failed', trigger: 'auto', error: 'x', outdated: true }), failedAutoAtHead: null }),
    ).toEqual({ error: 'x', retry: true });
  });

  it('a failed auto run at a head an AUTO run already reviewed: the error, no Retry', () => {
    expect(
      failedAutoReviewLine({ review: run({ status: 'failed', trigger: 'auto', error: 'x', outdated: false }), failedAutoAtHead: null }),
    ).toEqual({ error: 'x', retry: false });
  });

  it('an older server (no `failedAutoAtHead`) keeps the old rule: the latest run is a failed auto run', () => {
    expect(failedAutoReviewLine({ review: run({ status: 'failed', trigger: 'auto', error: 'x', outdated: false }) })).toEqual({
      error: 'x',
      retry: true,
    });
    expect(failedAutoReviewLine({ review: run({ status: 'failed', trigger: 'manual', error: 'x', outdated: false }) })).toBeNull();
  });

  it('nothing failed automatically: no line', () => {
    expect(
      failedAutoReviewLine({ review: run({ status: 'succeeded', trigger: 'auto', outdated: false }), failedAutoAtHead: null }),
    ).toBeNull();
    expect(failedAutoReviewLine({ review: null, failedAutoAtHead: null })).toBeNull();
    expect(failedAutoReviewLine(undefined)).toBeNull();
  });
});

describe("why a queued auto review went first (a teammate's verdict)", () => {
  const why = (o: Record<string, unknown>) =>
    ({ kind: 'teammate_verdict', reason: 'author_review', authorLogin: 'alex', authorVerdict: null, ...o }) as never;
  it('names the author and what their own review said', () => {
    expect(autoReviewWhyLine(why({ authorVerdict: 'APPROVE' }))).toBe('Queued: needs a verdict (alex’s own review approved)');
    expect(autoReviewWhyLine(why({ authorVerdict: 'REQUEST_CHANGES' }))).toBe(
      'Queued: needs a verdict (alex’s own review asked for changes)',
    );
    expect(autoReviewWhyLine(why({}))).toBe('Queued: needs a verdict (alex’s own review)');
    expect(autoReviewWhyLine(why({ authorLogin: null }))).toBe('Queued: needs a verdict (the author’s own review)');
    expect(autoReviewWhyLine(why({ reason: 'moved' }))).toBe('Queued: needs a verdict (new commits since the last Limn review)');
    expect(autoReviewWhyLine(null)).toBeNull();
  });
});
