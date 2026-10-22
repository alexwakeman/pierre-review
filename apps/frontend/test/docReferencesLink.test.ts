// A review's reference-library links (lib/docReferences.ts): the deep link a reference's href carries,
// and the parse the Docs pane runs on load. Both hold to the library's strict path grammar.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend docReferencesLink
import { describe, expect, it } from 'vitest';
import { docsDeepLink, parseDocsDeepLink } from '../src/lib/docReferences.js';

describe('docsDeepLink', () => {
  it('names the workspace, the rail line, the document, the section and the anchor', () => {
    const href = docsDeepLink('/app/', 4, { path: 'billing-handbook/sections/04-refunds.md', anchor: 'partial-refunds' });
    expect(href).toBe('/app/?workspace=4&activityRepo=docs&doc=billing-handbook&section=04-refunds.md&anchor=partial-refunds');
  });

  it('round-trips through the parse', () => {
    const href = docsDeepLink('/app', null, { path: 'billing-handbook/sections/04-refunds.md', anchor: null });
    expect(href.startsWith('/app/?activityRepo=docs')).toBe(true);
    expect(parseDocsDeepLink(href.slice(href.indexOf('?')))).toEqual({
      path: 'billing-handbook/sections/04-refunds.md',
      kind: 'section',
      slug: 'billing-handbook',
      anchor: null,
      quote: null,
    });
  });

  it('carries the quote, as plain text, and round-trips it', () => {
    const quote = 'Refunds are paid “within fourteen days” & never <b>twice</b>';
    const href = docsDeepLink('/app/', 4, { path: 'billing-handbook/sections/04-refunds.md', anchor: 'refunds', quote });
    expect(href).toContain('&quote=');
    expect(parseDocsDeepLink(href.slice(href.indexOf('?')))?.quote).toBe(quote);
  });

  it('omits an empty quote', () => {
    expect(docsDeepLink('/app/', 4, { path: 'a/sections/01-x.md', anchor: null, quote: '  ' })).not.toContain('quote=');
  });
});

describe('parseDocsDeepLink', () => {
  it('doc alone opens its contents', () => {
    expect(parseDocsDeepLink('?activityRepo=docs&doc=billing-handbook')?.path).toBe('billing-handbook/CONTENTS.md');
  });

  it('caps a quote and drops an empty one', () => {
    const long = 'x'.repeat(1000);
    expect(parseDocsDeepLink(`?activityRepo=docs&doc=a&section=01-x.md&quote=${long}`)?.quote?.length).toBe(300);
    expect(parseDocsDeepLink('?activityRepo=docs&doc=a&section=01-x.md&quote=')?.quote).toBeNull();
    expect(parseDocsDeepLink('?activityRepo=docs&doc=a&section=01-x.md')?.quote).toBeNull();
  });

  it('a quote never rescues a bad path', () => {
    expect(parseDocsDeepLink('?activityRepo=docs&doc=../etc&section=01-x.md&quote=hello')).toBeNull();
  });

  it('keeps a valid anchor', () => {
    expect(parseDocsDeepLink('?activityRepo=docs&doc=a&section=01-x.md&anchor=h-1')?.anchor).toBe('h-1');
  });

  it('refuses anything outside the grammar, and any other rail line', () => {
    for (const q of [
      '?activityRepo=feed&doc=a&section=01-x.md',
      '?activityRepo=docs',
      '?activityRepo=docs&doc=../etc&section=01-x.md',
      '?activityRepo=docs&doc=a&section=../../passwd',
      '?activityRepo=docs&doc=a&section=01-x.md%2F..',
      '?activityRepo=docs&doc=A&section=01-x.md',
      '?activityRepo=docs&doc=a&section=x.txt',
    ]) {
      expect(parseDocsDeepLink(q)).toBeNull();
    }
  });
});
