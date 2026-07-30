// The "Check review" button's outcome line.
//
// The regression these pin: the per-item run route answers HTTP 200 for outcomes that produced
// NOTHING — the server having no AI credential (the runner's `detectAuth` early return) and the
// account's monthly AI credits being spent (`creditsExhausted`). With the SSE run path and the
// PR-wide sweep bar both deleted, `state.error` is set only by a non-2xx, so those two states
// rendered as the button flipping back to "✨ Check review" with nothing beside it.
//
// Run from the workspace that HAS vitest (see prRef.test.ts for why this file lives outside src/):
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import type { AnnotationRunResponse } from '@pierre-review/shared';
import { annotationRunMessage } from '../src/lib/annotationRun.js';

const run = (over: Partial<AnnotationRunResponse>): AnnotationRunResponse => ({
  kind: 'review',
  requested: 0,
  generated: 0,
  cached: 0,
  skipped: 0,
  failed: 0,
  truncated: false,
  creditsExhausted: false,
  ...over,
});

describe('annotationRunMessage — no 200 may be silent', () => {
  it('names exhausted credits (the flag the deleted sweep bar was the only renderer of)', () => {
    const msg = annotationRunMessage(run({ requested: 1, creditsExhausted: true }));
    expect(msg).toMatch(/credits/i);
  });

  it('still names exhausted credits when part of the run got through first', () => {
    // The runner breaks the chunk loop on `blocked`, so a partial result is the normal shape
    // for a fat thread anchor. Reporting only "3 checked" would hide why the rest never ran.
    const msg = annotationRunMessage(
      run({ requested: 8, generated: 3, creditsExhausted: true }),
    );
    expect(msg).toMatch(/credits/i);
    expect(msg).toContain('3');
  });

  it('reports the no-credential bail: work was queued, nothing generated, nothing failed', () => {
    // requested − cached − skipped > 0 means units NEEDED a billed call. generated + failed
    // both 0 means the loop never ran — the `detectAuth` early return, which the response
    // shape carries no flag for. This is THE case that produced a silent, permanently dead
    // button in paid cloud (SUMMARY_ANTHROPIC_API_KEY is invisible to detectAuth).
    const msg = annotationRunMessage(run({ requested: 2 }));
    expect(msg).not.toBeNull();
    expect(msg).toMatch(/credential/i);
  });

  it('does not cry "no credential" when the units were all cached or skipped', () => {
    // requested − cached − skipped === 0 → nothing needed a call, so a 0-generated run is
    // simply free, not broken. Getting this wrong would put a scary message on the happy path.
    expect(annotationRunMessage(run({ requested: 3, cached: 3 }))).toBe('Already up to date.');
    expect(annotationRunMessage(run({ requested: 3, skipped: 3 }))).toBe('Nothing here to check.');
  });

  it('stays quiet when judgements were generated — the panels are the feedback', () => {
    expect(annotationRunMessage(run({ requested: 2, generated: 2 }))).toBeNull();
  });

  it('reports failures', () => {
    expect(annotationRunMessage(run({ requested: 1, failed: 1 }))).toBe('1 check failed.');
    expect(annotationRunMessage(run({ requested: 3, generated: 2, failed: 1 }))).toContain(
      'failed',
    );
  });

  it('renders nothing before the first run', () => {
    expect(annotationRunMessage(null)).toBeNull();
  });
});

// The server-sent flag must WIN over the counter inference, and must not need the counters to
// agree with it: an all-cached run on a credential-less server still has `needed === 0`, so the
// fallback branch would stay silent and the user would be told "Already up to date" by a server
// that cannot check anything.
describe('annotationRunMessage — the noAuth flag', () => {
  it('names the missing credential outright rather than hedging', () => {
    const msg = annotationRunMessage(
      run({ requested: 3, cached: 0, skipped: 0, generated: 0, failed: 0, noAuth: true }),
    );
    expect(msg).toBe('No AI credential is configured on the server.');
    expect(msg).not.toMatch(/may/);
  });

  it('beats the counter inference when the counters look fully cached', () => {
    expect(
      annotationRunMessage(
        run({ requested: 3, cached: 3, skipped: 0, generated: 0, failed: 0, noAuth: true }),
      ),
    ).toMatch(/credential/i);
  });

  it('still yields to creditsExhausted, which is the more specific cause', () => {
    expect(
      annotationRunMessage(
        run({ requested: 3, cached: 0, skipped: 0, generated: 0, failed: 0, creditsExhausted: true, noAuth: true }),
      ),
    ).toMatch(/credits/i);
  });
});
