// The Overview's branch: head branch (monospace), "→ base" muted, and a copy button that copies
// the HEAD name only. Omitted when the head branch is not synced yet (never shown empty), and it
// sits on the Ticket row, after the ticket chips.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PrBranchLine } from '../src/components/ChecksTab.js';

const textOf = (html: string): string => html.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&');

describe('PrBranchLine', () => {
  it('shows head → base with a copy button for the branch name', () => {
    const html = renderToStaticMarkup(
      createElement(PrBranchLine, { headRefName: 'feature/PROJ-1-foo', baseRefName: 'main' }),
    );
    expect(textOf(html)).toContain('feature/PROJ-1-foo → main');
    expect(html).toMatch(/font-mono[^>]*>feature\/PROJ-1-foo</);
    expect(html).toContain('break-all');
    expect(html).toMatch(/<button[^>]*aria-label="[^"]*branch name/i);
  });

  it('omits the arrow when the base is unknown', () => {
    const html = renderToStaticMarkup(
      createElement(PrBranchLine, { headRefName: 'fix/x', baseRefName: null }),
    );
    expect(textOf(html)).not.toContain('→');
  });

  it('shares one row with the ticket, the branch after the ticket chips', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../src/components/ChecksTab.tsx', import.meta.url)),
      'utf8',
    );
    const fn = src.slice(src.indexOf('export function PrTicketBranchLine'));
    expect(fn.indexOf('<PrTicketChip')).toBeGreaterThan(0);
    expect(fn.indexOf('<PrTicketChip')).toBeLessThan(fn.indexOf('<PrBranchLine'));
    expect(fn).toContain('pr.headRefName != null &&');
  });
});
