// PLACE A POPOVER CLEAR OF THE CARDS (test/avoidRects.test.ts). A floating-ui middleware: try each side
// of the trigger at three alignments, clamp each try inside the viewport, and keep the one covering
// the least of `obstacles()` (viewport rects — the board's cards). Covering the trigger itself, and
// being pushed back on screen, cost extra; the order breaks ties. Used by components/HoverPopover.tsx
// and the lane board's arrow numbers (components/LaneBoard.tsx).
import type { Middleware } from '@floating-ui/react';

export type Side = 'right' | 'left' | 'bottom' | 'top';

type Box = Pick<DOMRect, 'left' | 'top' | 'right' | 'bottom'>;

const area = (ax: number, ay: number, aw: number, ah: number, b: Box): number => {
  const w = Math.min(ax + aw, b.right) - Math.max(ax, b.left);
  const h = Math.min(ay + ah, b.bottom) - Math.max(ay, b.top);
  return w > 0 && h > 0 ? w * h : 0;
};

/**
 * Place the floating panel on the side of its reference that covers the least of `obstacles()` (viewport
 * rects), clamped inside the viewport. Use with `strategy: 'fixed'` and no flip/shift. `order` is the
 * preference when two sides tie.
 */
export function avoidRects(obstacles: () => readonly Box[], o: { gap?: number; padding?: number; order?: readonly Side[] } = {}): Middleware {
  const gap = o.gap ?? 8;
  const pad = o.padding ?? 8;
  const order = o.order ?? (['right', 'left', 'bottom', 'top'] as const);
  return {
    name: 'avoidRects',
    fn({ rects }) {
      const r = rects.reference;
      const f = rects.floating;
      const vw = typeof window === 'undefined' ? Infinity : window.innerWidth;
      const vh = typeof window === 'undefined' ? Infinity : window.innerHeight;
      const boxes = obstacles();
      let best: { x: number; y: number; score: number; side: Side } | null = null;
      // Each side at three alignments (centred, then flush with either end of the trigger).
      const tries = order.flatMap((side) => (['center', 'start', 'end'] as const).map((align) => ({ side, align })));
      tries.forEach(({ side, align }, i) => {
        const across = side === 'top' || side === 'bottom';
        const cx = across
          ? align === 'center'
            ? r.x + r.width / 2 - f.width / 2
            : align === 'start'
              ? r.x
              : r.x + r.width - f.width
          : side === 'right'
            ? r.x + r.width + gap
            : r.x - gap - f.width;
        const cy = !across
          ? align === 'center'
            ? r.y + r.height / 2 - f.height / 2
            : align === 'start'
              ? r.y
              : r.y + r.height - f.height
          : side === 'bottom'
            ? r.y + r.height + gap
            : r.y - gap - f.height;
        const x = Math.max(pad, Math.min(cx, vw - f.width - pad));
        const y = Math.max(pad, Math.min(cy, vh - f.height - pad));
        // Pushed back inside the screen: it may now sit on its own trigger, so a shift costs too.
        const shifted = Math.abs(cx - x) + Math.abs(cy - y);
        const onTrigger = area(x, y, f.width, f.height, { left: r.x, top: r.y, right: r.x + r.width, bottom: r.y + r.height });
        const covered = boxes.reduce((s, b) => s + area(x, y, f.width, f.height, b), 0);
        const score = covered + onTrigger * 4 + shifted * 20 + i;
        if (best == null || score < best.score) best = { x, y, score, side };
      });
      const b = best as { x: number; y: number; side: Side } | null;
      return b == null ? {} : { x: b.x, y: b.y, data: { side: b.side } };
    },
  };
}

