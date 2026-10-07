// THE CI LOG PRE-SCAN (ci-failures.ts `extractFailureExcerpt`) over realistic job logs
// (__fixtures__/ci-logs/), each buried in thousands of lines of install / test noise. What this pins:
//   1. npm audit: the offending package AND its advisory survive, though they sit in the MIDDLE of a
//      long log (a tail window never reached them) — and the moderate one too, budget allowing.
//   2. A TypeScript compile error and a jest failure: the error lines, the failing step's header and
//      the log's last lines.
//   3. Several culprits far apart each get a window; errors beat warnings for the budget; a repeated
//      warning is anchored once; a "0 failed" summary is not a culprit.
//   4. Every excerpt stays inside the per-check cap.
//
//   pnpm --filter @pierre-review/backend test claude-review/ci-failures-excerpt
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CI_EXCERPT_CHARS, confidenceOf, culpritClass, extractFailureExcerpt } from './ci-failures.js';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'ci-logs');
const ts = '2026-10-01T10:00:30.0000000Z ';

function installNoise(n: number): string {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    // A few distinct deprecation warnings, each repeated many times, and plain progress lines —
    // including a package whose NAME contains "error", which is not a failure.
    if (i % 50 === 0) out.push(`${ts}npm warn deprecated pkg-${i % 7}@1.0.0: This module is not supported`);
    else if (i % 333 === 0) out.push(`${ts}added node_modules/error-ex ${i}`);
    else out.push(`${ts}progress resolved ${i} reused ${i} downloaded 0 added ${i}`);
  }
  return out.join('\n');
}
const testNoise = (n: number): string =>
  Array.from({ length: n }, (_, i) => `${ts}PASS src/module-${i}/index.test.ts (${(i % 9) + 1}.1 s)`).join('\n');
const postNoise = (n: number): string => Array.from({ length: n }, (_, i) => `${ts}Post job cleanup step ${i}`).join('\n');

function fixture(name: string, noise: { install?: number; test?: number; post?: number }): string {
  return readFileSync(join(DIR, name), 'utf8')
    .replace('@@INSTALL_NOISE@@', installNoise(noise.install ?? 0))
    .replace(/@@TEST_NOISE@@/g, testNoise(noise.test ?? 0))
    .replace('@@POST_NOISE@@', postNoise(noise.post ?? 0));
}

describe('npm audit — the offending package in the middle of a long log', () => {
  const raw = fixture('npm-audit.log', { install: 40_000, post: 200 });
  const ex = extractFailureExcerpt(raw);

  it('keeps the package, its severity and its advisory', () => {
    expect(ex.text).toContain('braces  <3.0.3');
    expect(ex.text).toContain('Severity: high');
    expect(ex.text).toContain('GHSA-grv7-fg5c-xmjg');
    expect(ex.text).toContain('semver  7.0.0 - 7.5.1');
    expect(ex.text).toContain('2 vulnerabilities (1 moderate, 1 high)');
  });

  it('keeps the failing step header and the last lines', () => {
    expect(ex.text).toContain('##[group]Run npm audit --audit-level=high');
    expect(ex.text).toContain('Post job cleanup step 199');
    expect(ex.text).toMatch(/… \d+ lines not shown …/);
  });

  it('stays inside the cap and never shows a progress line', () => {
    expect(ex.text.length).toBeLessThanOrEqual(CI_EXCERPT_CHARS);
    expect(ex.windowLines).toBeGreaterThan(40_000);
    expect(ex.text).not.toMatch(/progress resolved 2\d{4}/);
  });
});

describe('TypeScript compile error', () => {
  const ex = extractFailureExcerpt(fixture('tsc.log', { install: 3_000, post: 100 }));
  it('keeps both errors and the step', () => {
    expect(ex.text).toContain("src/billing/invoice.ts(42,7): error TS2322: Type 'string' is not assignable to type 'number'.");
    expect(ex.text).toContain("error TS2339: Property 'totalCents' does not exist on type 'Invoice'.");
    expect(ex.text).toContain('##[group]Run pnpm typecheck');
    expect(ex.text.length).toBeLessThanOrEqual(CI_EXCERPT_CHARS);
  });
});

describe('jest failure', () => {
  const ex = extractFailureExcerpt(fixture('jest.log', { test: 1_500, post: 50 }));
  it('keeps the failing test, the expectation and the summary', () => {
    expect(ex.text).toContain('FAIL src/cart/total.test.ts');
    expect(ex.text).toContain('Expected: 90');
    expect(ex.text).toContain('Received: 81');
    expect(ex.text).toContain('Tests:       1 failed, 1840 passed, 1841 total');
    expect(ex.text).toContain('##[group]Run npm test -- --ci');
    expect(ex.text.length).toBeLessThanOrEqual(CI_EXCERPT_CHARS);
  });
});

describe('several culprits, one budget', () => {
  const pad = (tag: string, n: number): string[] => Array.from({ length: n }, (_, i) => `${tag} ${i}`);
  const lines = [
    ...pad('a', 500),
    'Error: first failure in module A',
    ...pad('b', 3_000),
    'warning: something minor',
    ...pad('c', 3_000),
    'Error: second failure in module B',
    ...pad('d', 500),
  ];

  it('anchors a window on each distant error', () => {
    const ex = extractFailureExcerpt(lines.join('\n'));
    expect(ex.text).toContain('first failure in module A');
    expect(ex.text).toContain('second failure in module B');
    expect(ex.text).toContain('warning: something minor');
    expect(ex.anchors).toBe(3);
  });

  it('errors win the budget over warnings', () => {
    // Just too small for every window: the one left out is the warning's (it is tried last).
    const all = extractFailureExcerpt(lines.join('\n')).text.length;
    const ex = extractFailureExcerpt(lines.join('\n'), { maxChars: all - 5 });
    expect(ex.text).toContain('first failure in module A');
    expect(ex.text).toContain('second failure in module B');
    expect(ex.text).not.toContain('warning: something minor');
    expect(ex.text.length).toBeLessThanOrEqual(all - 5);
  });

  it('a repeated warning is anchored once', () => {
    const many = [...pad('x', 100), ...Array.from({ length: 300 }, () => 'warning: same thing'), ...pad('y', 100)];
    const ex = extractFailureExcerpt(many.join('\n'));
    expect(ex.anchors).toBe(1);
  });
});

describe('culpritClass', () => {
  it('classes lines', () => {
    expect(culpritClass('npm ERR! code ELIFECYCLE')).toBe(0);
    expect(culpritClass('Severity: critical')).toBe(0);
    expect(culpritClass('found 3 vulnerabilities (2 high, 1 critical)')).toBe(0);
    expect(culpritClass('thread main panicked at src/lib.rs:4')).toBe(0);
    expect(culpritClass('Traceback (most recent call last):')).toBe(0);
    expect(culpritClass('  ✕ adds numbers (3 ms)')).toBe(0);
    expect(culpritClass('Error: boom')).toBe(1);
    expect(culpritClass('Build FAILED.')).toBe(1);
    expect(culpritClass('npm warn deprecated x')).toBe(2);
    expect(culpritClass('Severity: moderate')).toBe(2);
    expect(culpritClass('found 0 vulnerabilities')).toBe(-1);
    expect(culpritClass('Tests: 0 failed, 12 passed')).toBe(-1);
    expect(culpritClass('##[error]Process completed with exit code 1.')).toBe(-1);
    expect(culpritClass('##[error]Unable to resolve action')).toBe(0);
    expect(culpritClass('compiling module 4')).toBe(-1);
  });
});

describe('confidenceOf', () => {
  it('rounds and clamps; anything else is null', () => {
    expect(confidenceOf(80)).toBe(80);
    expect(confidenceOf(72.6)).toBe(73);
    expect(confidenceOf(140)).toBe(100);
    expect(confidenceOf(-3)).toBe(0);
    expect(confidenceOf('90')).toBeNull();
    expect(confidenceOf(undefined)).toBeNull();
    expect(confidenceOf(Number.NaN)).toBeNull();
  });
});
