// PrDetail's `placement` prop. The full-screen tab must not offer "open full-screen" (the ↗ button
// or a clickable title) — it already IS that tab — while the bottom pane (shared Timeline and a
// Focus tab) keeps both. Every icon button right of the title wears one class, except Refresh's
// amber stale state. Source-level: PrDetail needs a live PR payload and a dozen hooks to render.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), 'utf8');

const detail = read('components/PrDetail.tsx');

describe('PrDetail placement', () => {
  it('is a required prop, passed by both mounts', () => {
    expect(detail).toMatch(/placement: 'pane' \| 'fullscreen';/);
    expect(read('components/DetailPane.tsx')).toContain('placement="pane"');
    expect(read('App.tsx')).toContain('placement="fullscreen"');
  });

  it('only the pane renders the full-screen button and the clickable title', () => {
    const start = detail.indexOf("{placement === 'pane' ? (");
    expect(start).toBeGreaterThan(0);
    const [paneArm, fullArm] = detail.slice(start).split(') : (');
    expect(paneArm).toContain('<ExternalLinkIcon');
    expect(paneArm).toContain('openPrDetailTab');
    const full = (fullArm ?? '').slice(0, (fullArm ?? '').indexOf(')}'));
    expect(full).not.toContain('onClick');
    expect(full).not.toContain('ExternalLinkIcon');
    // The ↗ icon appears nowhere else in the header.
    expect(detail.match(/<ExternalLinkIcon size=\{13\}/g)?.length).toBe(1);
  });

  it('header icon buttons share one ink class', () => {
    expect(detail.match(/className=\{PR_HEADER_ICON_BTN\}/g)?.length).toBe(5);
    expect(detail).toContain('`${PR_HEADER_ICON_BTN} disabled:opacity-60`');
    expect(detail).toMatch(
      /PR_HEADER_ICON_BTN =\s*'[^']*text-gray-900[^']*dark:text-gray-100[^']*'/,
    );
  });
});
