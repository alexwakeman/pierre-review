// THE "?" BUTTON (lib/docsLink.ts): it opens the public docs at limn-review.com, on the page for
// where the reader is. The SPA does not import the landing, so the page keys are hard-coded; this
// test lists them, and apps/landing/test/docs.test.ts checks each one is a real docs page.
//
// Run: ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DESTINATIONS } from '../src/components/shell/nav.js';
import { allDocsKeys, DESTINATION_DOCS, DOCS_SITE, docsUrlFor, docsUrlForView } from '../src/lib/docsLink.js';

describe('docs links', () => {
  it('links to exactly these docs pages', () => {
    expect(allDocsKeys().sort()).toEqual(
      [
        'bots-monitoring/overview',
        'docs-library/overview',
        'feed/overview',
        'getting-started/repository-pages',
        'implement-story/overview',
        'open-pull-requests/overview',
        'pending/overview',
        'pull-request/overview',
        'reports/overview',
        'this-sprint/overview',
        'timeline/focus-a-pull-request',
        'timeline/overview',
      ].sort(),
    );
  });

  it('maps every sidebar destination', () => {
    for (const d of DESTINATIONS) expect(DESTINATION_DOCS[d.id], d.id).toMatch(/^[a-z-]+\/[a-z-]+$/);
  });

  it('opens the page for where the reader is', () => {
    expect(docsUrlFor('attention', null)).toBe(`${DOCS_SITE}/pending/overview`);
    expect(docsUrlFor(42, null)).toBe(`${DOCS_SITE}/getting-started/repository-pages`);
    expect(docsUrlFor(null, 'pr-detail')).toBe(`${DOCS_SITE}/pull-request/overview`);
    // A tab with no page of its own opens the docs home.
    expect(docsUrlFor(null, 'bot-volume')).toBe(DOCS_SITE);
    expect(docsUrlFor(null, null)).toBe(DOCS_SITE);
  });

  it('reads the view from the store values', () => {
    expect(docsUrlForView('activity', [], 'attention')).toBe(`${DOCS_SITE}/pending/overview`);
    expect(docsUrlForView('activity', [], null)).toBe(`${DOCS_SITE}/open-pull-requests/overview`);
    expect(docsUrlForView('sprint', [], 'open-prs')).toBe(`${DOCS_SITE}/this-sprint/overview`);
    expect(docsUrlForView('pr-detail:7', [{ key: 'pr-detail:7', kind: 'pr-detail' }], 'open-prs')).toBe(
      `${DOCS_SITE}/pull-request/overview`,
    );
  });

  it('the sidebar "?" is a new-tab link to the docs, not the help sheet', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'components', 'shell', 'Sidebar.tsx'), 'utf8');
    const i = src.indexOf('aria-label="Open the Limn docs"');
    expect(i).toBeGreaterThan(-1);
    const tag = src.slice(src.lastIndexOf('<a', i), src.indexOf('>', i));
    expect(tag).toContain('href={docsHref}');
    expect(tag).toContain('target="_blank"');
    expect(tag).toContain('rel="noopener noreferrer"');
    expect(src).not.toContain('setHelpOpen');
  });
});
