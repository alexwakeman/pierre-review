import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CATEGORY_ORDER,
  coerceVendor,
  declaredConfidence,
  dropLoneSurrogates,
  extractMarkers,
  stripVendorChrome,
  type Kind,
  type MarkerResult,
} from './markers.js';
import { COERCION, HAVE_FIXTURES, loadRows, type FixtureRow } from './parity-fixtures.test-support.js';

/** A MarkerResult in the exporter's `marker_dict` shape. */
function asFixture(m: MarkerResult): Record<string, unknown> {
  return {
    vendor: m.vendor,
    severity: m.severity,
    categories: CATEGORY_ORDER.filter((c) => m.categories.has(c)),
    confidence: m.confidence,
    is_summary: m.isSummary,
    native_tag: m.nativeTag,
    escalated: m.escalated,
    matched: [...m.matched],
    declared_severity: m.declaredSeverity,
    declared_confidence: declaredConfidence(m),
  };
}

/** Every row's mismatch, so one run reports the whole picture rather than the first failure. */
function mismatches<T>(rows: FixtureRow[], got: (r: FixtureRow) => T, want: (r: FixtureRow) => T) {
  const out: { id: string; got: T; want: T }[] = [];
  for (const r of rows) {
    const g = got(r);
    const w = want(r);
    if (JSON.stringify(g) !== JSON.stringify(w)) out.push({ id: r.id, got: g, want: w });
  }
  return out;
}

describe.skipIf(!HAVE_FIXTURES)('markers parity with the Python service', () => {
  const rows = HAVE_FIXTURES ? loadRows() : [];

  it('has the fixture rows', () => {
    expect(rows.length).toBeGreaterThan(1000);
  });

  it('strips lone surrogates exactly as the HTTP boundary does', () => {
    const bad = mismatches(
      rows,
      (r) => [
        dropLoneSurrogates(r.input.body),
        r.input.diff_hunk === null ? null : dropLoneSurrogates(r.input.diff_hunk),
        r.input.path === null ? null : dropLoneSurrogates(r.input.path),
      ],
      (r) => [r.sanitized.body, r.sanitized.diff_hunk, r.sanitized.path],
    );
    expect(bad.slice(0, 5)).toEqual([]);
  });

  it('coerces every vendor string the backend can send', () => {
    const table = JSON.parse(readFileSync(COERCION, 'utf8')) as Record<string, Kind>;
    const wrong = Object.entries(table).filter(([v, k]) => coerceVendor(v === '' ? null : v) !== k);
    expect(wrong).toEqual([]);
    expect(mismatches(rows, (r) => coerceVendor(r.input.vendor), (r) => r.vendor_kind)).toEqual([]);
  });

  it('extracts the same markers', () => {
    const bad = mismatches(
      rows,
      (r) => asFixture(extractMarkers(r.vendor_kind, r.sanitized.body)),
      (r) => r.markers,
    );
    expect(bad.slice(0, 5)).toEqual([]);
  });

  it('strips the same vendor chrome (the model input)', () => {
    const bad = mismatches(rows, (r) => stripVendorChrome(r.sanitized.body), (r) => r.stripped);
    expect(bad.slice(0, 5)).toEqual([]);
  });
});

// Python-semantics traps the real corpus barely exercises. Every expectation below is Python's
// own answer (extract_markers / strip_vendor_chrome on the same input), not a hand guess.
describe('markers keep Python regex semantics', () => {
  const brief = (vendor: Kind, body: string) => {
    const m = extractMarkers(vendor, body);
    return [m.severity, CATEGORY_ORDER.filter((c) => m.categories.has(c)).sort(), [...m.matched]];
  };

  it('\\s is Python whitespace: U+FEFF is not, \\x1c is', () => {
    expect(brief('coderabbit', '🔴\ufeffCritical bug here')).toEqual([null, ['correctness_bug'], []]);
    expect(brief('coderabbit', '🔴\x1cCritical bug here')).toEqual([
      'CRITICAL',
      ['correctness_bug'],
      ['🔴\\s*Critical'],
    ]);
  });

  it('a MULTILINE ^ starts a line after \\n only, never after \\r', () => {
    expect(brief('sourcery', 'Context line\rissue (security): token leak')).toEqual([
      null,
      ['security'],
      [],
    ]);
    expect(brief('sourcery', 'Context line\nissue (security): token leak')).toEqual([
      'CRITICAL',
      ['security'],
      ['issue(security)'],
    ]);
    expect(stripVendorChrome('intro\rissue: the bug')).toBe('intro\rissue: the bug');
  });

  it('\\b and \\w are Unicode: "naïvetest" holds no word "test"', () => {
    expect(brief('unknown', 'naïvetest of the bug')).toEqual(['MAJOR', ['correctness_bug'], []]);
  });

  it('\\d is any decimal digit, read as its value', () => {
    expect(brief('qodo', 'importance: \u0669 something')).toEqual(['MAJOR', [], ['importance=9']]);
  });

  it('strip() and NFC behave as Python', () => {
    expect(stripVendorChrome('keep me\x1c\x85')).toBe('keep me');
    expect(stripVendorChrome('\ufeffkeep me')).toBe('\ufeffkeep me');
    expect(stripVendorChrome('cafe\u0301 is broken')).toBe('caf\u00e9 is broken');
  });

  it('drops only unpaired surrogates', () => {
    expect(dropLoneSurrogates('a\ud800b\udc00c😀')).toBe('abc😀');
  });
});
