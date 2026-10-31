// `createLazyMounter` — the Changes tab's lazy mounting must never leave code blank. Two ways it did:
// the observer was rooted on a scroll pane that was later REPLACED (it never fired again), or the
// observer simply never reported a block that was on screen. Each observe now re-checks the pane, and
// a watchdog mounts any pending block within reach of the window by its own measured position.
//
// Run from the workspace that HAS vitest:
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLazyMounter } from '../src/components/diff/lazyMount.js';

type Rect = { top: number; bottom: number; width: number; height: number };

class FakeIO {
  static all: FakeIO[] = [];
  observed = new Set<unknown>();
  disconnected = false;
  constructor(
    public cb: (entries: { isIntersecting: boolean; target: unknown }[]) => void,
    public opts: { root: unknown },
  ) {
    FakeIO.all.push(this);
  }
  observe(el: unknown): void {
    this.observed.add(el);
  }
  unobserve(el: unknown): void {
    this.observed.delete(el);
  }
  disconnect(): void {
    this.disconnected = true;
    this.observed.clear();
  }
}

function pane(): { isConnected: boolean; style: string } {
  return { isConnected: true, style: 'auto' };
}

function block(parent: { style: string }, rect: Rect): Element {
  return {
    isConnected: true,
    parentElement: parent,
    getBoundingClientRect: () => rect,
  } as unknown as Element;
}

let frames: (() => void)[] = [];
const flush = (): void => {
  const f = frames;
  frames = [];
  for (const cb of f) cb();
};

beforeEach(() => {
  FakeIO.all = [];
  frames = [];
  vi.stubGlobal('IntersectionObserver', FakeIO);
  vi.stubGlobal('getComputedStyle', (p: { style: string }) => ({ overflowY: p.style }));
  vi.stubGlobal('window', { innerHeight: 800, addEventListener: () => undefined, removeEventListener: () => undefined });
  vi.stubGlobal('document', { addEventListener: () => undefined, removeEventListener: () => undefined });
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
    frames.push(cb);
    return frames.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createLazyMounter', () => {
  it('the watchdog mounts an on-screen block the observer never reported', () => {
    const m = createLazyMounter();
    const onNear = vi.fn();
    m.observe(block(pane(), { top: 100, bottom: 400, width: 600, height: 300 }), onNear);
    flush();
    expect(onNear).toHaveBeenCalledTimes(1);
    m.disconnect();
  });

  it('leaves a far-off block for later, and a hidden one (Threads only) alone', () => {
    const m = createLazyMounter();
    const far = vi.fn();
    const hidden = vi.fn();
    m.observe(block(pane(), { top: 9000, bottom: 9300, width: 600, height: 300 }), far);
    m.observe(block(pane(), { top: 0, bottom: 0, width: 0, height: 0 }), hidden);
    flush();
    expect(far).not.toHaveBeenCalled();
    expect(hidden).not.toHaveBeenCalled();
    m.disconnect();
  });

  it('rebuilds the observer on the NEW pane when the old one was replaced', () => {
    const m = createLazyMounter();
    const old = pane();
    m.observe(block(old, { top: 9000, bottom: 9300, width: 1, height: 1 }), () => undefined);
    expect(FakeIO.all).toHaveLength(1);
    expect(FakeIO.all[0]!.opts.root).toBe(old);
    old.isConnected = false;
    const fresh = pane();
    m.observe(block(fresh, { top: 9000, bottom: 9300, width: 1, height: 1 }), () => undefined);
    expect(FakeIO.all).toHaveLength(2);
    expect(FakeIO.all[0]!.disconnected).toBe(true);
    expect(FakeIO.all[1]!.opts.root).toBe(fresh);
    // Both pending blocks moved to the new observer.
    expect(FakeIO.all[1]!.observed.size).toBe(2);
    m.disconnect();
  });

  it('an observer report mounts once and stops watching', () => {
    const m = createLazyMounter();
    const onNear = vi.fn();
    const el = block(pane(), { top: 9000, bottom: 9300, width: 1, height: 1 });
    m.observe(el, onNear);
    FakeIO.all[0]!.cb([{ isIntersecting: true, target: el }]);
    flush();
    expect(onNear).toHaveBeenCalledTimes(1);
    expect(FakeIO.all[0]!.observed.has(el)).toBe(false);
    m.disconnect();
  });
});
