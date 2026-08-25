// The ThemeCard comment-count badge — exact vs ≈ (the revived Bot Themes panel's merge with the
// deterministic layer).
//
// The contract under test: when the server computed `commentCount` (bot reports — Σ of the cited
// clusters' code-computed counts, D4) the card renders it EXACT, with no ≈ glyph and the
// "computed from the clusters" title; when it is absent (human reports, stored pre-count bot
// rows) the legacy `≈occurrences` fallback renders — and a 0-occurrence theme without a count
// renders NO badge at all. The fallback must survive because stored rows generated before the
// count existed must still render totally.
//
// No JSX: this directory is plain `.ts` (see vitest.config.ts), so the body is instantiated with
// `createElement` and rendered to static markup. Run from the workspace that HAS vitest:
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BotTheme } from '@pierre-review/shared';
import { ThemesReportBody } from '../src/components/Activity/ThemesReportView.js';

function theme(over: Partial<BotTheme>): BotTheme {
  return {
    title: 'Unchecked error paths',
    category: 'error_handling',
    severity: 'major',
    summary: '',
    occurrences: 12,
    bots: [],
    areas: [],
    prs: [],
    threads: [],
    ...over,
  };
}

function render(themes: BotTheme[]): string {
  return renderToStaticMarkup(
    createElement(ThemesReportBody, {
      narrative: '',
      themes,
      bySeverity: [],
      byArea: [],
      actorEmoji: '🤖',
      emptyThemesLabel: 'none',
      coverageLine: createElement('div'),
      onOpenPr: () => {},
      onOpenTheme: () => {},
    }),
  );
}

describe('ThemeCard comment count', () => {
  it('renders the exact server-computed count with its unit, without the ≈ glyph', () => {
    const html = render([theme({ commentCount: 7 })]);
    expect(html).toContain('7 comments');
    expect(html).not.toContain('≈');
    expect(html).toContain('computed from the clusters, not the model');
  });

  it('falls back to the model’s ≈occurrences when no count is stored', () => {
    const html = render([theme({})]);
    expect(html).toContain('≈12');
    expect(html).toContain('Approximate number of comments');
  });

  it('renders exact 0 over a nonzero ≈estimate — the code fold wins', () => {
    // A model that cited only out-of-payload clusters sums to 0; showing its ≈12 instead would
    // be the model authoring a number (D4).
    const html = render([theme({ commentCount: 0 })]);
    expect(html).toContain('0 comments');
    expect(html).not.toContain('≈');
  });

  it('renders no badge for a count-less theme with zero occurrences', () => {
    const html = render([theme({ occurrences: 0 })]);
    expect(html).not.toContain('≈');
    expect(html).not.toContain('Approximate number of comments');
    expect(html).not.toContain('computed from the clusters');
  });
});
