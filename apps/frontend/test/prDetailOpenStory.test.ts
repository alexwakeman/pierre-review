// PrDetail's "Open story" — the "…" menu item (and its ⌘K twin) that opens the PR's linked story.
// Shown only for a ticket Limn can open as a story (an `ident`), and opened only through
// `useOpenStory`, the one way the story view opens. Source-level: PrDetail needs a live PR payload
// and a dozen hooks to render. And the impact note it sat beside is gone, for good.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/prDetailOpenStory.test.ts
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const path = (rel: string): string => fileURLToPath(new URL(`../src/${rel}`, import.meta.url));
const read = (rel: string): string => readFileSync(path(rel), 'utf8');

const detail = read('components/PrDetail.tsx');

describe('PrDetail "Open story"', () => {
  it('lists only tickets with an ident, and opens them through useOpenStory', () => {
    expect(detail).toContain("import { useOpenStory } from '../lib/ticketTab.js';");
    expect(detail).toMatch(/t\.ident != null \? \[\{ ident: t\.ident, key: t\.key \}\] : \[\]/);
    expect(detail).not.toContain('openTicketTab');
  });

  it('is a menu item with the ticket icon, and a ⌘K command', () => {
    const menu = detail.slice(detail.indexOf('const menuItems: MenuEntry[]'));
    expect(menu).toMatch(/label: 'Open story',\s+hint: t\.key,\s+icon: <TicketIcon size=\{14\} \/>/);
    expect(detail).toContain('id: `pr:story:${t.ident}`');
  });
});

describe('the impact note is removed', () => {
  it('has no component, hook or client method left', () => {
    expect(existsSync(path('components/Activity/BlastImpactNote.tsx'))).toBe(false);
    expect(existsSync(path('hooks/useAnnotations.ts'))).toBe(false);
    expect(read('api/client.ts')).not.toMatch(/annotations/);
    expect(detail).not.toMatch(/ImpactNote/);
    expect(read('components/settings/BlastRadiusSection.tsx')).not.toMatch(/impact note/i);
  });
});
