// The blast-radius chip says the LEVEL and stops: icon + "High"/"Medium"/"Low", never a file name or
// a reason beside it (nor in a hover title). The reasons — the flagged file among them — live in
// the popover a click opens (`BlastReasons`).
//
// No JSX here (plain `.ts`), so components are instantiated with `createElement`.
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { BlastPrFields, BlastVerdict } from '../src/lib/ui.js';
import { WarningIcon } from '../src/components/Icons.js';
import { BlastRadiusChipView, BlastReasons } from '../src/components/Activity/BlastRadiusChip.js';

const pr = {
  blast: {
    codeFiles: 4,
    testFiles: 1,
    nonCodeFiles: 0,
    dirs: 3,
    subsystems: 2,
    truncated: false,
    contentKind: null,
  },
  codeLoc: 220,
  codeLocIsLowerBound: false,
} as unknown as BlastPrFields;

const high: BlastVerdict = {
  level: 'high',
  reasons: [
    { kind: 'hub', text: 'Touches `src/db/schema.ts`, which usually changes alongside 12 others' },
    { kind: 'surface', text: 'Touches a database migration' },
  ],
  short: 'High',
  label: 'Wide reach — Touches `src/db/schema.ts`, which usually changes alongside 12 others; Touches a database migration.',
  volumeOnly: false,
} as BlastVerdict;

const chip = (props: Record<string, unknown> = {}): string =>
  renderToStaticMarkup(createElement(BlastRadiusChipView, { verdict: high, pr, ...props }));

/** The text a reader sees: markup without tags. */
const visible = (html: string): string => html.replace(/<[^>]+>/g, '');

describe('BlastRadiusChip', () => {
  it('shows the icon and the level word only — no file name, no reason, no title', () => {
    const html = chip();
    expect(visible(html)).toBe('High');
    expect(html).not.toContain('schema.ts');
    expect(html).not.toContain('migration');
    expect(html).not.toContain('title=');
    expect(html).toContain('<svg');
  });

  it('is a button that opens a dialog popover, closed until clicked', () => {
    const html = chip();
    expect(html).toMatch(/^<button[^>]*type="button"/);
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-label="High reach"');
    expect(html).not.toContain('role="dialog"');
  });

  it('keeps the large-PR flag’s box, so the two share one height and centre line', () => {
    const html = chip();
    for (const cls of ['inline-flex', 'items-center', 'gap-1', 'text-meta']) expect(html).toContain(cls);
    expect(html).not.toMatch(/min-h-|py-|self-start/);
    const flag = readFileSync(
      fileURLToPath(new URL('../src/components/Activity/LargePrFlag.tsx', import.meta.url)),
      'utf8',
    );
    expect(flag).toContain('inline-flex shrink-0 items-center gap-1 text-meta');
    expect(flag).toMatch(/WarningIcon size=\{11\}/);
    // The same requested size, so the same rendered box (Icons.tsx `renderedIconSize`).
    const flagIcon = renderToStaticMarkup(createElement(WarningIcon, { size: 11 }));
    const px = /width="(\d+)"/.exec(flagIcon)![1];
    expect(html).toContain(`width="${px}" height="${px}"`);
  });

  it('icon-only drops the word; the fact-line form says "High reach"', () => {
    expect(visible(chip({ iconOnly: true }))).toBe('');
    expect(visible(chip({ wordOnly: true }))).toBe('High reach');
  });

  it('the popover body holds every reason, the flagged file set as code, and the evidence', () => {
    const html = renderToStaticMarkup(createElement(BlastReasons, { verdict: high, pr }));
    expect(html).toContain('<code');
    expect(html).toContain('src/db/schema.ts</code>');
    expect(html).not.toContain('`');
    expect(visible(html)).toContain('which usually changes alongside 12 others');
    expect(visible(html)).toContain('Touches a database migration');
    expect(visible(html)).toContain('4 code files');
    expect(visible(html)).toContain('220 code lines');
  });
});
