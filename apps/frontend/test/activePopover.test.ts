// The one open board popover (a chart's figures, a Pending "i"), and what a modal does to it — plus
// where focus goes when Settings closes.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/activePopover.test.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { claimActivePopover, closeActivePopover } from '../src/lib/activePopover.js';
import { focusReturner } from '../src/lib/focusReturn.js';

describe('the one open board popover', () => {
  it('opening a second closes the first — a chart popover and a Pending "i" share the slot', () => {
    const chart = vi.fn();
    const info = vi.fn();
    const releaseChart = claimActivePopover(chart);
    const releaseInfo = claimActivePopover(info);
    expect(chart).toHaveBeenCalledTimes(1);
    expect(info).not.toHaveBeenCalled();
    releaseChart(); // the first one's late cleanup must not free the second one's slot
    closeActivePopover();
    expect(info).toHaveBeenCalledTimes(1);
    releaseInfo();
  });

  it('a modal opening closes whatever is open — the keyboard makes no outside press', () => {
    const info = vi.fn();
    const release = claimActivePopover(info);
    closeActivePopover(); // SettingsModal / HelpModal / InfoModal / the Pending guide, on mount
    expect(info).toHaveBeenCalledTimes(1);
    release();
  });

  it('a released slot closes nothing', () => {
    const info = vi.fn();
    claimActivePopover(info)();
    closeActivePopover();
    expect(info).not.toHaveBeenCalled();
  });

  it('re-claiming with the same closer does not close itself', () => {
    const info = vi.fn();
    const release = claimActivePopover(info);
    claimActivePopover(info);
    expect(info).not.toHaveBeenCalled();
    release();
  });
});

describe('focusReturner — Settings hands focus back to what opened it', () => {
  const body = { tag: 'body' };
  it('refocuses the opener (Customise) on close, without scrolling', () => {
    const focus = vi.fn();
    focusReturner({ focus, isConnected: true }, body)();
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it('does nothing when the opener has left the page (the avatar menu unmounts)', () => {
    const focus = vi.fn();
    focusReturner({ focus, isConnected: false }, body)();
    expect(focus).not.toHaveBeenCalled();
  });

  it('does nothing when nothing, or <body>, had focus', () => {
    expect(() => focusReturner(null, body)()).not.toThrow();
    const bodyEl = { focus: vi.fn(), isConnected: true };
    focusReturner(bodyEl, bodyEl)();
    expect(bodyEl.focus).not.toHaveBeenCalled();
  });
});

// ── The wiring ────────────────────────────────────────────────────────────────────────────────
//
// Structural, because nothing under test/ renders (the chronologyModel.test.ts precedent). Each is a
// path only the KEYBOARD takes: with a mouse, the click that opens a modal is an outside press and
// the popover closes itself.

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/components/${rel}`, import.meta.url)), 'utf8');
const MOUNT_CLOSE = /useEffect\(\(\) => \{\s*closeActivePopover\(\);/;

describe('every page-level modal closes the open board popover as it opens', () => {
  for (const rel of ['settings/SettingsModal.tsx', 'HelpModal.tsx', 'InfoModal.tsx']) {
    it(rel, () => expect(read(rel)).toMatch(MOUNT_CLOSE));
  }
  it('the Pending guide', () => {
    const src = read('Activity/PendingInfo.tsx');
    const guide = src.slice(src.indexOf('export function PendingGuideModal'));
    expect(guide).toMatch(MOUNT_CLOSE);
  });
});

describe('every board popover holds the one slot while open', () => {
  it('the Pending "i" popover', () => {
    const src = read('Activity/PendingInfo.tsx');
    const pop = src.slice(src.indexOf('function InfoPopover'), src.indexOf('function GuideLink'));
    expect(pop).toContain('claimActivePopover(() => setOpen(false))');
  });
  it('the chart popover', () => {
    expect(read('charts/ChartPopover.tsx')).toContain('return claimActivePopover(');
  });
});

describe('Settings hands focus back on close', () => {
  it('captures the opener on mount and returns focus in the cleanup', () => {
    const src = read('settings/SettingsModal.tsx');
    expect(src).toContain('focusReturner(document.activeElement, document.body)');
    expect(src).toMatch(/return \(\) => \{[^}]*returnFocus\(\);/);
  });
});
