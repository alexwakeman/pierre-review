// THE ONE MAP from an AI Fix session's phase to `ai_fixes.status` (shared `aiFixStatusForPhase`): every
// older reader of the status (the banner, the Open PRs pill, the auto-fix caps, dependency automation's
// poll, `pushFix`) depends on it, so every phase is pinned.
import { describe, expect, it } from 'vitest';
import { SANDBOX_SESSION_PHASES, aiFixStatusForPhase } from '@pierre-review/shared';

describe('aiFixStatusForPhase', () => {
  it('maps every phase', () => {
    const got = Object.fromEntries(SANDBOX_SESSION_PHASES.map((p) => [p, [aiFixStatusForPhase(p, { pushed: false }), aiFixStatusForPhase(p, { pushed: true })]]));
    expect(got).toEqual({
      booting: ['running', 'running'],
      ready: ['planned', 'planned'],
      chatting: ['planned', 'planned'],
      // A story session's plan stage (an AI Fix never enters it): mapped like its neighbours.
      planning: ['running', 'running'],
      plan_ready: ['planned', 'planned'],
      revising: ['running', 'running'],
      building: ['running', 'running'],
      built: ['succeeded', 'succeeded'],
      pushed: ['succeeded', 'succeeded'],
      // A person's discard cancels an unpushed fix (deps automation's poll reads "Cancelled.").
      discarded: ['cancelled', 'succeeded'],
      failed: ['failed', 'failed'],
    });
  });
});
