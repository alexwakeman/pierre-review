// `LimnSeverityChip` — the severity on a thread / PR-level comment that is one of Limn's own posted
// findings (PR details pane). Pins: the review's own words, nothing without a severity (praise is
// never posted), the 11px floor, and text that clears AA on both page grounds.
//
// No JSX here (plain `.ts`), so the component is instantiated with `createElement`.
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { LimnSeverity } from '@pierre-review/shared';
import { LIMN_SEVERITY_COLOR, LimnSeverityChip } from '../src/components/LimnSeverityChip.js';
import { contrastRatio, vendorInk } from '../src/lib/ui.js';

const render = (severity: LimnSeverity | null | undefined): string =>
  renderToStaticMarkup(createElement(LimnSeverityChip, { severity }));

describe('LimnSeverityChip', () => {
  it('says the review’s own word for every severity', () => {
    const words: Record<LimnSeverity, string> = { blocker: 'Blocker', warning: 'Warning', nit: 'Nit', question: 'Question' };
    for (const [sev, word] of Object.entries(words) as Array<[LimnSeverity, string]>) {
      const html = render(sev);
      expect(html).toContain(`>${word}</span>`);
      expect(html).toContain(`data-limn-severity="${sev}"`);
      // The 11px label floor.
      expect(html).toContain('text-[11px]');
    }
  });

  it('renders nothing without a severity, or for praise', () => {
    expect(render(null)).toBe('');
    expect(render(undefined)).toBe('');
    expect(render('praise' as unknown as LimnSeverity)).toBe('');
  });

  it('every severity’s ink clears AA on both page grounds', () => {
    const failures: string[] = [];
    for (const [sev, color] of Object.entries(LIMN_SEVERITY_COLOR)) {
      const ink = vendorInk(color);
      const light = contrastRatio(ink['--ink-light']!, '#ffffff');
      const dark = contrastRatio(ink['--ink-dark']!, '#030712');
      if (light < 4.5) failures.push(`${sev} light ${light.toFixed(2)}`);
      if (dark < 4.5) failures.push(`${sev} dark ${dark.toFixed(2)}`);
    }
    expect(failures).toEqual([]);
  });
});
