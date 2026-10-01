// WHICH CHECKS ARE FAILING, as a red Pending card writes them — "CI failing: build, lint and 2
// more". The words are pinned on what SHIPS: the two components both card bodies render
// (`CiStatusWithChecks` in the meta row, `FailingChecksLine` in the ci_failing body), rendered to
// static markup, plus the pure `failingChecksParts` they share.
//
// WHAT THIS PINS:
//
//   1. NO NAMES IS NOT "0 FAILING". An empty or absent list renders the CI label alone (the meta row)
//      or nothing at all (the ci_failing line) — a red head whose only failure was a cancelled job
//      records no names, and "0 failing" beside "CI failing" would be a false claim.
//   2. "AND N MORE" IS WORDS, and its N is the SERVER's total minus what was shown — never a
//      tooltip, and never a count the client invented.
//   3. THE TWO HALVES ARE APART, so the renderer can truncate the names and never the "and N more".
//   4. Comma-joined, no "and" between names: a check is often called "Build and test".
//   5. REAL SPACES BETWEEN THE RUNS. The spans sit in a flex row whose `gap` is paint, not text, so
//      without a text node the copied text and a screen reader read "CI failing:build" and
//      "lintand 2 more". textContent is the pin.
//   6. Names are THIRD-PARTY text: escaped text nodes, never markup.
//
// No JSX: this directory is plain `.ts` (see vitest.config.ts), so the components are instantiated
// with `createElement` and rendered to static markup.
//
// Run from the workspace that HAS vitest:
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CiStatus } from '@pierre-review/shared';
import {
  CiStatusWithChecks,
  FailingChecksLine,
  failingChecksParts,
} from '../src/components/Activity/AttentionCards.js';

/** What a reader copies or a screen reader joins: the markup's text, tags and comments stripped. */
const textOf = (html: string): string =>
  html
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, '&');

const metaHtml = (
  ciStatus: CiStatus | null,
  failingChecks?: string[],
  failingCheckTotal?: number,
): string =>
  renderToStaticMarkup(
    createElement(CiStatusWithChecks, { pr: { ciStatus, failingChecks, failingCheckTotal } }),
  );
const meta = (...args: Parameters<typeof metaHtml>): string => textOf(metaHtml(...args));

const lineHtml = (
  ciStatus: CiStatus,
  failingChecks: string[] | null,
  failingCheckTotal: number | null,
): string =>
  renderToStaticMarkup(
    createElement(FailingChecksLine, { card: { ciStatus, failingChecks, failingCheckTotal } }),
  );

describe('the meta row — "CI failing: …"', () => {
  it('says the label alone when there are no names — never "0 failing"', () => {
    expect(meta('failure')).toBe('CI failing');
    expect(meta('failure', [], 0)).toBe('CI failing');
    // A total with no names is still no names: there is nothing to print a remainder against.
    expect(meta('failure', [], 4)).toBe('CI failing');
  });

  it('names one check alone', () => {
    expect(meta('failure', ['build (ubuntu-latest)'], 1)).toBe('CI failing: build (ubuntu-latest)');
  });

  it('names exactly three with no remainder', () => {
    expect(meta('failure', ['build', 'clippy', 'lint'], 3)).toBe('CI failing: build, clippy, lint');
  });

  it('adds "and N more" in words, with real spaces between the runs', () => {
    expect(meta('failure', ['build (ubuntu-latest)', 'clippy', 'lint'], 5)).toBe(
      'CI failing: build (ubuntu-latest), clippy, lint and 2 more',
    );
  });

  it('writes the singular remainder plainly', () => {
    expect(meta('error', ['build', 'clippy', 'lint'], 4)).toBe('CI error: build, clippy, lint and 1 more');
  });

  it('keeps "and N more" out of the truncating span', () => {
    const html = metaHtml('failure', ['a', 'b', 'c'], 7);
    expect(html).toContain('<span class="min-w-0 truncate" title="a, b, c">a, b, c</span>');
    expect(html).toContain('<span class="shrink-0">and 4 more</span>');
  });

  it('names nothing beside a label that is not red', () => {
    expect(meta('pending', ['build'], 1)).toBe('CI running');
    expect(meta('success', ['build'], 1)).toBe('CI passing');
    expect(meta(null, ['build'], 1)).toBe('no checks');
  });

  it('keeps no "and" between names — a check is often called "Build and test"', () => {
    expect(meta('failure', ['Build and test', 'lint'], 2)).toBe('CI failing: Build and test, lint');
  });

  it('renders a name as escaped text, never markup', () => {
    const html = metaHtml('failure', ['<img src=x onerror=alert(1)>'], 1);
    expect(html).not.toContain('<img');
    expect(textOf(html)).toBe('CI failing: <img src=x onerror=alert(1)>');
  });
});

describe('the ci_failing body’s names line', () => {
  it('names the checks after an accessible "Failing checks:" label, with real spaces', () => {
    expect(textOf(lineHtml('failure', ['a', 'b', 'c'], 7))).toBe('Failing checks: a, b, c and 4 more');
    expect(textOf(lineHtml('error', ['smoke'], 1))).toBe('Failing checks: smoke');
  });

  it('is red ink at 12px, with the failure mark hidden from assistive technology', () => {
    const html = lineHtml('failure', ['smoke'], 1);
    expect(html).toContain('text-xs text-red-600 dark:text-red-400');
    expect(html).toMatch(/<svg[^>]*aria-hidden="true"/);
  });

  it('renders nothing when no names are known — null, never "0 failing"', () => {
    expect(lineHtml('failure', null, null)).toBe('');
    expect(lineHtml('failure', [], 0)).toBe('');
  });
});

describe('failingChecksParts', () => {
  it('keeps the remainder apart from the names, so only the names truncate', () => {
    expect(failingChecksParts(['a', 'b', 'c'], 7)).toEqual({ names: 'a, b, c', more: 'and 4 more' });
    expect(failingChecksParts(['a'], 1)).toEqual({ names: 'a', more: null });
  });

  it('never prints a negative or zero remainder, and trusts the list when the total is absent', () => {
    expect(failingChecksParts(['build', 'lint'], 1)).toEqual({ names: 'build, lint', more: null });
    expect(failingChecksParts(['build', 'lint'], null)).toEqual({ names: 'build, lint', more: null });
    expect(failingChecksParts(null, null)).toBeNull();
    expect(failingChecksParts(undefined, 3)).toBeNull();
  });
});
