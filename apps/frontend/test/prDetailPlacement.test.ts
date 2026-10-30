// PrDetail's `placement` prop. The full-screen tab must not offer "open full-screen" (a clickable
// title) — it already IS that tab — while the bottom pane (shared Timeline and a Focus tab) keeps
// it. The header carries no icon row: the "…" menu says every action in words. Source-level:
// PrDetail needs a live PR payload and a dozen hooks to render.
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

  it('only the pane renders the clickable title', () => {
    const start = detail.indexOf("{placement === 'pane' ? (");
    expect(start).toBeGreaterThan(0);
    const [paneArm, fullArm] = detail.slice(start).split(') : (');
    expect(paneArm).toContain('openPrDetailTab');
    const full = (fullArm ?? '').slice(0, (fullArm ?? '').indexOf(')}'));
    expect(full).not.toContain('onClick');
  });

  it('the header has no icon row — the … menu carries every action, in words', () => {
    expect(detail).not.toContain('PR_HEADER_ICON_BTN');
    expect(detail).toContain('label="More actions for this pull request"');
    const menu = detail.slice(detail.indexOf('const menuItems: MenuEntry[]'), detail.indexOf('return (', detail.indexOf('const menuItems: MenuEntry[]')));
    for (const id of ['full', 'timeline', 'focus', 'feed', 'refresh', 'copy', 'gh']) {
      expect(menu).toContain(`id: '${id}'`);
    }
    // ⌘K keeps the same set.
    for (const id of ['pr:full', 'pr:timeline', 'pr:focus', 'pr:feed', 'pr:refresh', 'pr:copy', 'pr:github']) {
      expect(detail).toContain(`id: '${id}'`);
    }
  });
});
