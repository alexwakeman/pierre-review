import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { APP_COVERAGE, PAGES, PAGE_FILES, pageForKey, pageForPath } from '../src/docs/manifest';
import { SIDEBAR_LABELS } from '../src/docs/kit';
import { tocFor } from '../src/docs/toc';
import { CHANGELOG, newestRelease, parseChangelog } from '../src/docs/changelog';
import { LIMN_VERSION } from '../src/docs/version';

// ---------------------------------------------------------------------------
// KEEPING THE DOCS CURRENT (apps/landing/src/docs/CONTRIBUTING.md). This file fails when:
//  - the app gains a sidebar destination, a pull request tab, a Settings tab, a Pending tab, a
//    Reports tab or a Bots Monitoring tab with no docs page (it reads the ids from the app's source);
//  - a page is still a stub, or is nearly empty;
//  - a page shows an image (the docs never show screenshots; pictures are HTML mocks);
//  - a DocLink points at a page or an anchor that does not exist;
//  - CHANGELOG.md does not parse, or its newest release is not the npm package's version.
// ---------------------------------------------------------------------------

const app = (rel: string): string => readFileSync(new URL(`../../frontend/src/${rel}`, import.meta.url), 'utf8');

/** The text between `start` and the next `end`, or a failure naming what moved. */
function block(src: string, start: string, end: string, file: string): string {
  const a = src.indexOf(start);
  if (a === -1) throw new Error(`${file}: "${start}" not found — the docs test must follow the app's source`);
  const b = src.indexOf(end, a);
  return src.slice(a, b === -1 ? undefined : b);
}

function all(re: RegExp, text: string): string[] {
  return [...text.matchAll(re)].map((m) => m[1]!);
}

const APP_IDS = {
  destinations: all(/\{ id: '([^']+)', label: '/g, block(app('components/shell/nav.ts'), 'export const DESTINATIONS', '];', 'nav.ts')),
  prTabs: all(/^\s*(\w+): '/gm, block(app('components/PrDetail.tsx'), 'const TAB_LABELS: Record<Tab, string> = {', '};', 'PrDetail.tsx')),
  settingsTabs: all(/\bid: '([^']+)'/g, block(app('components/settings/settingsTabs.ts'), 'export const SETTINGS_TABS', '];', 'settingsTabs.ts')),
  pendingTabs: all(/^\s*(\w+): '/gm, block(app('components/Activity/pendingTabs.ts'), 'export const TAB_LABEL', '};', 'pendingTabs.ts')),
  reportsTabs: all(/\{ id: '([a-z-]+)', label: '/g, app('components/Activity/InsightsView.tsx')),
  botsTabs: all(/\{ id: '([a-z-]+)', label: '/g, app('components/Activity/BotsView.tsx')),
} satisfies Record<keyof typeof APP_COVERAGE, string[]>;

const html = new Map(PAGES.map((p) => [p.key, renderToStaticMarkup(createElement(p.Body))]));
const textOf = (h: string): string => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

describe('the docs cover the app', () => {
  for (const [kind, ids] of Object.entries(APP_IDS) as Array<[keyof typeof APP_COVERAGE, string[]]>) {
    it(`every ${kind} id in the app has a docs page`, () => {
      expect(ids.length, `read no ${kind} ids from the app's source`).toBeGreaterThan(1);
      const coverage: Record<string, string> = APP_COVERAGE[kind];
      const missing = ids.filter((id) => !(id in coverage));
      expect(missing, `add these to APP_COVERAGE.${kind} in docs/manifest.ts, with a page`).toEqual([]);
      const gone = Object.keys(coverage).filter((id) => !ids.includes(id));
      expect(gone, `the app no longer has these ${kind}; remove their docs (CONTRIBUTING.md § Removing)`).toEqual([]);
      for (const key of Object.values(coverage)) expect(pageForKey(key), `APP_COVERAGE.${kind} → ${key}`).not.toBeNull();
    });
  }

  it("the mock sidebar's words are the app's", () => {
    const labels = all(/\{ id: '[^']+', label: '([^']+)'/g, block(app('components/shell/nav.ts'), 'export const DESTINATIONS', '];', 'nav.ts'));
    expect([...SIDEBAR_LABELS]).toEqual(labels);
  });
});

describe('the manifest', () => {
  it('lists every page file, and every listed page has a file', () => {
    const listed = PAGES.map((p) => p.key).sort();
    expect([...PAGE_FILES].sort()).toEqual(listed);
  });

  it('gives each page a unique route and a unique title', () => {
    const routes = PAGES.map((p) => p.route);
    expect(new Set(routes).size).toBe(routes.length);
    for (const p of PAGES) expect(pageForPath(p.route)?.key).toBe(p.key);
    const titles = PAGES.map((p) => p.meta.title);
    expect(titles.filter((t, i) => titles.indexOf(t) !== i)).toEqual([]);
  });

  it('gives each page a title and a one- or two-sentence summary', () => {
    for (const p of PAGES) {
      expect(p.meta.title.trim().length, p.key).toBeGreaterThan(1);
      expect(p.meta.summary.trim().length, p.key).toBeGreaterThan(20);
      expect(p.meta.summary.length, `${p.key}: keep the summary under 300 characters`).toBeLessThanOrEqual(300);
    }
  });
});

describe('every page', () => {
  it('is written (no stubs, no near-empty pages)', () => {
    const stubs = PAGES.filter((p) => p.meta.stub === true || textOf(html.get(p.key)!).length < 400).map(
      (p) => `${p.key} (${p.writer})`,
    );
    expect(stubs, 'these pages are stubs or nearly empty').toEqual([]);
  });

  it('shows no image: pictures are HTML mocks, never screenshots', () => {
    for (const p of PAGES) {
      const h = html.get(p.key)!;
      expect(h, p.key).not.toMatch(/<img\b|<picture\b|<video\b|background-image/i);
      expect(h, p.key).not.toMatch(/\.(png|jpe?g|gif|webp|avif)\b/i);
      const src = readFileSync(new URL(`../src/docs/pages/${p.key}.tsx`, import.meta.url), 'utf8');
      expect(src, `${p.key}: no image imports`).not.toMatch(/from\s+'[^']+\.(png|jpe?g|gif|webp|avif|svg)'/i);
    }
  });

  it('links only to docs pages and anchors that exist', () => {
    const idsOf = (key: string): Set<string> => new Set(all(/\bid="([^"]+)"/g, html.get(key)!));
    const broken: string[] = [];
    for (const p of PAGES) {
      for (const href of all(/href="([^"]+)"/g, html.get(p.key)!)) {
        const [path = '', hash] = href.split('#');
        if (path === '' && hash) {
          if (!idsOf(p.key).has(hash)) broken.push(`${p.key} → #${hash}`);
          continue;
        }
        if (!path.startsWith('/docs')) continue;
        const target = pageForPath(path.replace(/\/+$/, ''));
        if (!target) broken.push(`${p.key} → ${href}`);
        else if (hash && !idsOf(target.key).has(hash)) broken.push(`${p.key} → ${href} (no such anchor)`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('has unique section anchors', () => {
    for (const p of PAGES) {
      const ids = tocFor(p.Body).map((t) => t.id);
      expect(ids.filter((id, i) => ids.indexOf(id) !== i), p.key).toEqual([]);
    }
  });

  it('uses none of the retired pricing words', () => {
    for (const p of PAGES) {
      const words = `${p.meta.title} ${p.meta.summary} ${textOf(html.get(p.key)!)}`;
      expect(words, p.key).not.toMatch(/\bLimn Pro\b|\bcredits?\b|\bupgrade to\b|\bpaid tier\b/i);
    }
  });
});

describe('the changelog', () => {
  it('parses, starts with Unreleased, and its newest release is the npm package version', () => {
    expect(CHANGELOG[0]?.version).toBe('Unreleased');
    const backend = JSON.parse(readFileSync(new URL('../../backend/package.json', import.meta.url), 'utf8')) as { version: string };
    expect(LIMN_VERSION).toBe(backend.version);
    expect(newestRelease()?.version, 'CHANGELOG.md newest release vs apps/backend/package.json').toBe(backend.version);
  });

  it('lists releases newest first, each with a date', () => {
    const released = CHANGELOG.filter((r) => r.version !== 'Unreleased');
    for (const r of released) expect(r.date, r.version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const ver = (v: string): number[] => v.split('.').map(Number);
    for (let i = 1; i < released.length; i++) {
      const [a, b] = [ver(released[i - 1]!.version), ver(released[i]!.version)];
      const cmp = a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!;
      expect(cmp, `${released[i - 1]!.version} before ${released[i]!.version}`).toBeGreaterThan(0);
    }
  });

  it('reads wrapped items and refuses a release with no date', () => {
    const r = parseChangelog('# x\n\n## [Unreleased]\n\n## [1.2.3] - 2026-01-02\n\n### Fixed\n\n- one\n  two\n- three\n');
    expect(r[1]).toEqual({ version: '1.2.3', date: '2026-01-02', groups: [{ heading: 'Fixed', items: ['one two', 'three'] }] });
    expect(() => parseChangelog('## [1.2.3]\n')).toThrow(/no date/);
  });
});
