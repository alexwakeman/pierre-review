// The Changes tab's reveal scroll is held while lazily-mounted code around the target settles
// (`lib/settleScroll.ts`). The DOM loop needs a browser (the e2e spec `changes-lazy.spec.ts` drives
// it); these pin its two decisions: how a frame moved, and when a jump is smooth.
//
// Run from the workspace that HAS vitest:
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import { classifySettleFrame, revealBehavior } from '../src/lib/settleScroll.js';

describe('classifySettleFrame', () => {
  it('is still when the target did not move on screen', () => {
    expect(classifySettleFrame(0, 0)).toBe('still');
    // Scroll anchoring absorbed a height change above: the pane moved, the target did not.
    expect(classifySettleFrame(340, 0.4)).toBe('still');
  });

  it('is the reader when the pane scrolled and the target moved with it', () => {
    expect(classifySettleFrame(120, -120)).toBe('reader');
    expect(classifySettleFrame(-80, 79.5)).toBe('reader');
  });

  it('is a layout shift when the target moved and the pane did not', () => {
    expect(classifySettleFrame(0, 214)).toBe('shift');
    expect(classifySettleFrame(0, -60)).toBe('shift');
    // The pane moved, but not by what the target moved: content changed height too.
    expect(classifySettleFrame(100, 50)).toBe('shift');
  });
});

describe('revealBehavior', () => {
  it('is smooth for a short hop and instant for a long jump', () => {
    expect(revealBehavior(300, 800)).toBe('smooth');
    expect(revealBehavior(-1200, 800)).toBe('smooth');
    expect(revealBehavior(1201, 800)).toBe('auto');
    expect(revealBehavior(-30_000, 800)).toBe('auto');
  });
});
