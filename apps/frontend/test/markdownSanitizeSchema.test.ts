// `Markdown.tsx`'s `sanitizeSchema` — the ONE choke point where a comment body's raw HTML
// attributes are allowlisted before react-markdown spreads them onto real DOM nodes.
//
// The defect this pins: `rehype-sanitize`'s `defaultSchema.attributes['*']` is written in HAST
// property names (camelCase) and still carries the legacy presentational attributes — `hSpace`,
// `vAlign`, `charOff`, `noWrap`, `noShade`, `noHref`, `isMap` (+ `<img longDesc>`). Anything that
// survives the sanitizer reaches React under that camelCase name, React has never heard of it,
// and every `<img hspace>` in a PR body cost a runtime warning:
//   "React does not recognize the `hSpace` prop on a DOM element … spell it as lowercase `hspace`"
// It was never an `<img>` problem — `<td valign>` and `<hr noshade>` warned identically — which
// is why the fix subtracts the names from the schema rather than patching the `img` renderer.
//
// No JSX: this directory is plain `.ts` (see vitest.config.ts), so the component is instantiated
// with `createElement` and rendered to static markup. Run from the workspace that HAS vitest:
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown, sanitizeSchema } from '../src/components/Markdown.js';

/**
 * Render a markdown body, capturing the React dev warnings that mean "I don't know this prop".
 *
 * Two message shapes, both from the same cause — a HAST property name React has no entry for:
 *   • "React does not recognize the `hSpace` prop on a DOM element…"  (the reported one)
 *   • "Received `true` for a non-boolean attribute `compact`…"        (its boolean sibling)
 *
 * `console.error` is swallowed rather than forwarded so the sweep below (which deliberately puts
 * every allowlisted attribute on one `<div>`) can't spray unrelated noise over the run.
 *
 * ⚠ React dedupes these per prop NAME per process, so the markup assertions — not the warning
 * list — are the primary contract; a warning an earlier test already emitted won't fire twice.
 */
function render(body: string): { html: string; unknownProps: string[] } {
  const unknownProps: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    const message = args.map((a) => String(a)).join(' ');
    if (message.includes('does not recognize') || message.includes('for a non-boolean attribute')) {
      unknownProps.push(message);
    }
  };
  try {
    return {
      html: renderToStaticMarkup(createElement(Markdown, null, body)),
      unknownProps,
    };
  } finally {
    console.error = original;
  }
}

describe('Markdown sanitize schema — legacy presentational attributes', () => {
  it('drops hspace from an <img> inside a <picture> while keeping src/alt/width/height', () => {
    // The reported reproduction, verbatim: `at img … at picture … at Markdown`.
    const { html, unknownProps } = render(
      '<picture><img src="https://example.com/a.png" hspace="10" align="left" alt="a" width="200" height="100"></picture>',
    );

    expect(html).not.toMatch(/hspace/i);
    expect(unknownProps).toEqual([]);

    expect(html).toContain('src="https://example.com/a.png"');
    expect(html).toContain('alt="a"');
    expect(html).toContain('width="200"');
    expect(html).toContain('height="100"');
    // The renderer's own additions survive the same spread.
    expect(html).toContain('loading="lazy"');
  });

  it('is not img-specific — <td valign>, <td nowrap> and <hr noshade> are dropped too', () => {
    const { html, unknownProps } = render(
      '<table><tbody><tr><td valign="top" nowrap="nowrap" colspan="2">x</td></tr></tbody></table>\n\n<hr noshade="noshade">',
    );

    expect(html).not.toMatch(/valign/i);
    expect(html).not.toMatch(/nowrap/i);
    expect(html).not.toMatch(/noshade/i);
    expect(unknownProps).toEqual([]);

    // …while the table attribute React DOES understand still lands on the node. (Matched
    // case-insensitively: React writes the prop name it was given — `colSpan` — and HTML
    // attribute names are case-insensitive, so the browser reads it as `colspan` either way.)
    expect(html).toMatch(/colspan="2"/i);
  });

  it('keeps aria-*: react-markdown emits the dashed name, so those are never the warning', () => {
    // The default schema lists `ariaLabel` & co. under several tags. They are NOT in the drop
    // set on purpose: property-information gives aria properties no `space`, so
    // hast-util-to-jsx-runtime hands React `aria-label`, not `ariaLabel`.
    const { html, unknownProps } = render('<table aria-label="totals"><tbody><tr><td>x</td></tr></tbody></table>');

    expect(html).toContain('aria-label="totals"');
    expect(unknownProps).toEqual([]);
  });

  it('every attribute left on the global allowlist is one React accepts', () => {
    // The future-bump guard: a rehype-sanitize release that adds another legacy name to
    // `attributes['*']` fails HERE rather than warning in production. Names whose HTML spelling
    // is not simply the lowercased property (`acceptCharset` → `accept-charset`, `htmlFor` →
    // `for`) don't round-trip through this construction and are skipped by it — both are
    // React-known, so nothing is lost.
    const kept = sanitizeSchema.attributes['*'] ?? [];
    const names = kept
      .map((definition) => (Array.isArray(definition) ? definition[0] : definition))
      .filter((name): name is string => typeof name === 'string');

    // The kept list is FILTERED from the inherited one, never retyped: the ~54 survivors stay.
    expect(names.length).toBeGreaterThan(40);
    expect(names).toContain('colSpan');
    expect(names).toContain('width');
    expect(names).toContain('align'); // lowercase legacy: React passes it through, so it stays
    for (const dropped of ['hSpace', 'vAlign', 'charOff', 'noWrap', 'noShade', 'noHref', 'isMap', 'compact']) {
      expect(names).not.toContain(dropped);
    }

    // Both value forms: `foo="1"` and the bare `foo` (which becomes a boolean in hast, the
    // shape that produces the second warning wording).
    const withValues = names.map((name) => `${name.toLowerCase()}="1"`).join(' ');
    expect(render(`<div ${withValues}>x</div>`).unknownProps).toEqual([]);

    const bare = names.map((name) => name.toLowerCase()).join(' ');
    expect(render(`<div ${bare}>x</div>`).unknownProps).toEqual([]);
  });
});
