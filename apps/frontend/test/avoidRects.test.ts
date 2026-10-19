import { describe, expect, it } from 'vitest';
import { avoidRects } from '../src/lib/avoidRects.js';

// The hover popovers' placement (lib/avoidRects.ts): the side of the trigger covering the fewest cards.

const box = (x: number, y: number, w: number, h: number) => ({ left: x, top: y, right: x + w, bottom: y + h });
type Fn = (s: unknown) => { x?: number; y?: number; data?: { side: string } };
const place = (cards: ReturnType<typeof box>[], order?: Array<'right' | 'left' | 'bottom' | 'top'>) =>
  (avoidRects(() => cards, { order }).fn as unknown as Fn)({
    // A 16px trigger at (500, 500) and a 200 × 60 panel.
    rects: { reference: { x: 500, y: 500, width: 16, height: 16 }, floating: { x: 0, y: 0, width: 200, height: 60 } },
  });

describe('avoidRects', () => {
  it('no cards: the first side in the order, centred', () => {
    expect(place([])).toMatchObject({ x: 524, y: 478, data: { side: 'right' } });
    expect(place([], ['bottom'])).toMatchObject({ x: 408, y: 524, data: { side: 'bottom' } });
  });
  it('a card to the right: it goes left; cards right and left: above or below', () => {
    expect(place([box(520, 400, 300, 300)]).data!.side).toBe('left');
    const r = place([box(520, 400, 300, 300), box(200, 400, 296, 300)]);
    expect(['top', 'bottom']).toContain(r.data!.side);
  });
  it('covered everywhere: the least covered side wins', () => {
    // A big card below and a thin one on every other side.
    const r = place([box(0, 520, 2000, 400), box(520, 300, 400, 30), box(0, 300, 490, 30), box(0, 440, 2000, 20)]);
    expect(r.data!.side).not.toBe('bottom');
  });
});
