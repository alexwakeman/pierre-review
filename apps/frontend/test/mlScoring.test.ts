// `isMlScoring` — the predicate that decides whether any sync surface may claim a scoring phase.
//
// WHAT THIS FILE IS FOR. A sync has two halves: the GitHub walk, and the ML pass that scores the
// bot text the walk stored. The second cannot run inside the first (docs/ML-SEVERITY.md), so it
// always follows — and the indicator used to stop at the end of the walk, announcing "complete"
// while the model was still working. The fix is to keep the indicator alive through the scoring
// pass, which makes THIS predicate the thing that decides when the spinner is allowed to stop.
//
// Which means the interesting cases are not "is there backlog". They are the four situations
// where backlog exists and nothing is draining it — where a naive `pending > 0` would replace a
// premature "done" with a spinner that never stops, i.e. the same lie pointing the other way.
//
// Run from the workspace that HAS vitest:
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import type { MlEnrichmentStatus } from '@pierre-review/shared';
import { isMlScoring } from '../src/hooks/useMlLabels.js';

const status = (over: Partial<MlEnrichmentStatus> = {}): MlEnrichmentStatus => ({
  enabled: true,
  running: false,
  pending: 0,
  labelled: 0,
  scoredThisRun: 0,
  batchesThisRun: 0,
  failuresThisRun: 0,
  startedAt: null,
  finishedAt: null,
  pausedUntil: null,
  serviceHealthy: true,
  markerFallback: false,
  generatedAt: '2026-08-05T00:00:00.000Z',
  ...over,
});

describe('isMlScoring — when the indicator may claim a scoring phase', () => {
  it('is false with no status yet and when the feature is off', () => {
    expect(isMlScoring(undefined)).toBe(false);
    // `enabled:false` is the `npx pierre-review` / no-SEVERITY_API_URL case: the counts are
    // meaningless, and every one of them being zero must not be the only thing keeping the
    // indicator quiet.
    expect(isMlScoring(status({ enabled: false, running: true, pending: 500 }))).toBe(false);
  });

  it('is true while a tick is in flight, and while backlog is waiting for the next one', () => {
    expect(isMlScoring(status({ running: true }))).toBe(true);
    // Between ticks (the cron is */2) the worker is idle but the work is real — the indicator
    // must not blink off in the gap.
    expect(isMlScoring(status({ pending: 4_000 }))).toBe(true);
  });

  it('is false once the backlog is drained', () => {
    expect(isMlScoring(status({ pending: 0, scoredThisRun: 482 }))).toBe(false);
  });

  it('does not spin against a service nothing is listening on', () => {
    // The normal state of a dev machine whose sibling `pierre-ml` is not running: the URL is
    // configured, there is backlog, and nothing will ever move it.
    expect(isMlScoring(status({ pending: 17_500, serviceHealthy: false }))).toBe(false);
  });

  it('does not spin while the worker is backed off', () => {
    expect(
      isMlScoring(status({ pending: 900, pausedUntil: '2026-08-05T00:10:00.000Z' })),
    ).toBe(false);
  });

  // THE POISON-PILL CASE, and the reason `failuresThisRun` is on the wire at all. The candidate
  // query is "has no label row", so a batch the service rejects is re-selected on every tick
  // forever — four comments in this repo's own dev database reliably 500 the severity-api. The
  // service is UP (it answered), the backlog is real, and nothing will ever drain it.
  it('does not spin on a backlog the service keeps rejecting', () => {
    expect(
      isMlScoring(status({ pending: 4, failuresThisRun: 1, scoredThisRun: 0 })),
    ).toBe(false);
  });

  // ...but a partial failure is still progress. A tick that scored 300 and lost one batch is
  // draining the backlog; suppressing its indicator would reintroduce the original bug on every
  // large sync, since one bad comment anywhere in the corpus is close to certain.
  it('keeps spinning when a tick made progress despite a failed batch', () => {
    expect(
      isMlScoring(status({ pending: 4_000, failuresThisRun: 1, scoredThisRun: 300 })),
    ).toBe(true);
  });

  // A tick that is RUNNING wins over every "is it stuck" heuristic: those all describe a
  // COMPLETED tick, and the counters from the previous one are still in place while a new tick
  // is only just getting going.
  it('lets an in-flight tick override the stalled signals', () => {
    expect(
      isMlScoring(
        status({ running: true, pending: 4, failuresThisRun: 1, scoredThisRun: 0 }),
      ),
    ).toBe(true);
  });
});
