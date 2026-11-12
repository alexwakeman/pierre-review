// THE BUILDS TOAST'S FOLD (shared story-build-activity.ts): which builds the toast lists, its ring, its gates.
import { describe, expect, it } from 'vitest';
import { storyBuildActivityOf, storyBuildGateCount, storyBuildRingProgress, type StoryBuildActivityFacts } from '@pierre-review/shared';

const f = (o: Partial<StoryBuildActivityFacts> = {}): StoryBuildActivityFacts => ({
  phase: 'building',
  live: true,
  loopOn: false,
  loopState: null,
  loopRound: 0,
  loopRounds: 3,
  ticketWaiting: false,
  ...o,
});

describe('storyBuildActivityOf', () => {
  it('a live agent turn is running, with no gate', () => {
    expect(storyBuildActivityOf(f())).toEqual({ running: true, progress: 45, step: 'Building', gate: null });
    expect(storyBuildActivityOf(f({ phase: 'planning' }))).toMatchObject({ running: true, step: 'Planning', gate: null });
  });

  it('a plan waiting, a build to push, a failure: gates', () => {
    expect(storyBuildActivityOf(f({ phase: 'plan_ready' }))).toMatchObject({ running: false, gate: 'plan' });
    expect(storyBuildActivityOf(f({ phase: 'built' }))).toMatchObject({ running: false, gate: 'push' });
    expect(storyBuildActivityOf(f({ phase: 'failed', live: false }))).toMatchObject({ gate: 'failed' });
  });

  it('the review loop: its round words and a rising bar; a pause is a gate', () => {
    const r1 = storyBuildActivityOf(f({ phase: 'built', loopOn: true, loopState: 'reviewing', loopRound: 1 }))!;
    const fix = storyBuildActivityOf(f({ phase: 'building', loopOn: true, loopState: 'fixing', loopRound: 1 }))!;
    const r2 = storyBuildActivityOf(f({ phase: 'built', loopOn: true, loopState: 'reviewing', loopRound: 2 }))!;
    expect(r1).toMatchObject({ running: true, step: 'Review round 1 of 3', gate: null });
    expect(fix.step).toBe("Fixing round 1's findings");
    expect(r1.progress).toBeLessThan(fix.progress);
    expect(fix.progress).toBeLessThan(r2.progress);
    expect(storyBuildActivityOf(f({ phase: 'built', loopOn: true, loopState: 'reviewing', loopRound: 4 }))!.step).toBe('Final review');
    expect(storyBuildActivityOf(f({ phase: 'built', live: false, loopOn: true, loopState: 'paused', loopRound: 2 }))).toMatchObject({ running: false, gate: 'paused' });
    // A built build with the loop on is not a Push gate (the loop pushes).
    expect(storyBuildActivityOf(f({ phase: 'built', live: false, loopOn: true, loopState: null }))).toBeNull();
  });

  it('done: listed only while the ticket changes wait for the reader', () => {
    expect(storyBuildActivityOf(f({ phase: 'built', live: false, loopOn: true, loopState: 'done', loopRound: 4 }))).toBeNull();
    expect(storyBuildActivityOf(f({ phase: 'built', live: false, loopOn: true, loopState: 'done', ticketWaiting: true }))).toEqual({
      running: false,
      progress: 100,
      step: 'Pull request open: check the ticket changes',
      gate: 'ticket',
    });
    expect(storyBuildActivityOf(f({ phase: 'pushed', live: false, ticketWaiting: true }))).toMatchObject({ gate: 'ticket' });
    expect(storyBuildActivityOf(f({ phase: 'pushed', live: false }))).toBeNull();
  });

  it('a closed session in a running phase is not running; a discarded one is never listed', () => {
    expect(storyBuildActivityOf(f({ live: false }))).toBeNull();
    expect(storyBuildActivityOf(f({ phase: 'discarded' }))).toBeNull();
  });
});

describe('the circle', () => {
  it('counts the gates, and the ring follows the least advanced running build', () => {
    expect(storyBuildGateCount([{ gate: 'plan' }, { gate: null }, { gate: 'ticket' }])).toBe(2);
    expect(storyBuildRingProgress([{ running: true, progress: 45 }, { running: true, progress: 15 }, { running: false, progress: 5 }])).toBe(15);
    expect(storyBuildRingProgress([{ running: false, progress: 60 }])).toBeNull();
  });
});
