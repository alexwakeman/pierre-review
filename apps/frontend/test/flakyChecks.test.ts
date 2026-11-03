// Flaky checks in the SPA (docs/MERGE-CI-TRUNK.md § Flaky checks). The server decides; these pin
// the words, the chip on the Checks summary, the Pending card's line, and when the card's re-run
// is offered (every failing check flaky AND the reader can push — hidden otherwise).
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CiFlakySummary } from '@pierre-review/shared';
import {
  flakyCountLabel,
  flakyReasonText,
  flakyRerunOffered,
  flakyTitle,
} from '../src/components/FlakyChecks.js';
import { ChecksSummary, checksSummaryCounts, flakyFailingCount } from '../src/components/ChecksTab.js';
import { PendingFlakyLine } from '../src/components/Activity/PendingFlaky.js';

const src = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), 'utf8');
const textOf = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

const summary = (over: Partial<CiFlakySummary> = {}): CiFlakySummary => ({
  checks: [{ name: 'e2e', reasons: ['passed_and_failed'] }],
  allFailing: true,
  viewerCanPush: true,
  ...over,
});

describe('the words', () => {
  it('names each reason in plain English', () => {
    expect(flakyReasonText('passed_and_failed')).toBe('Passed and failed on this commit');
    expect(flakyReasonText('ci_review_infra')).toBe('The CI review says: network or infrastructure');
    expect(flakyTitle(['passed_and_failed', 'ci_review_infra'])).toBe(
      'Passed and failed on this commit. The CI review says: network or infrastructure',
    );
  });

  it('"Flaky" for one, "N flaky" for several', () => {
    expect(flakyCountLabel(1)).toBe('Flaky');
    expect(flakyCountLabel(2)).toBe('2 flaky');
  });
});

describe('the Pending card', () => {
  it('offers the re-run only when every failing check is flaky and the reader can push', () => {
    expect(flakyRerunOffered(summary())).toBe(true);
    expect(flakyRerunOffered(summary({ allFailing: false }))).toBe(false);
    expect(flakyRerunOffered(summary({ viewerCanPush: false }))).toBe(false);
    expect(flakyRerunOffered(undefined)).toBe(false);
  });

  it('the line carries the chip, the names and the reasons in its tooltip', () => {
    const html = renderToStaticMarkup(
      createElement(PendingFlakyLine, {
        flaky: summary({
          checks: [
            { name: 'e2e', reasons: ['passed_and_failed'] },
            { name: 'deploy-preview', reasons: ['ci_review_infra'] },
          ],
        }),
      }),
    );
    expect(textOf(html)).toContain('2 flaky');
    expect(textOf(html)).toContain('e2e, deploy-preview');
    expect(html).toContain('e2e: Passed and failed on this commit');
    expect(html).toContain('deploy-preview: The CI review says: network or infrastructure');
  });

  it('keeps the card’s other actions — the re-run is added, never a replacement', () => {
    const s = src('components/Activity/AttentionCards.tsx');
    const yourPr = s.slice(s.indexOf('} else if (landing != null) {'), s.indexOf("key=\"fix\""));
    expect(yourPr).toContain('flakyRerunOffered(trunk.ciFlaky)');
    expect(yourPr).toContain("primaryLink('Open checks'");
  });
});

describe('the Checks row', () => {
  const checks = [
    { name: 'e2e', state: 'failure' },
    { name: 'build', state: 'failure' },
    { name: 'lint', state: 'success' },
    { name: 'limn/review-claude', state: 'failure', limnOwned: true as const },
  ];
  const flaky = [
    { name: 'e2e', reasons: ['passed_and_failed' as const] },
    { name: 'lint', reasons: ['passed_and_failed' as const] },
    { name: 'limn/review-claude', reasons: ['passed_and_failed' as const] },
  ];

  it('counts only FAILING CI rows the server called flaky', () => {
    expect(flakyFailingCount(checks, flaky)).toEqual({
      count: 1,
      title: 'e2e: Passed and failed on this commit',
    });
    expect(flakyFailingCount(checks, undefined).count).toBe(0);
  });

  it('adds "1 flaky" beside the failing count, which does not change', () => {
    const html = renderToStaticMarkup(createElement(ChecksSummary, { checks, flakyChecks: flaky }));
    expect(textOf(html)).toContain('2 failing');
    expect(textOf(html)).toContain('1 flaky');
    expect(checksSummaryCounts(checks).failing).toBe(2);
  });

  it('says nothing about flakiness when none is flaky', () => {
    const html = renderToStaticMarkup(createElement(ChecksSummary, { checks }));
    expect(textOf(html)).not.toContain('flaky');
  });
});
