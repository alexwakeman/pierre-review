// The bot drill-down's Comments filter/sort: the rules whose wrong version renders a plausible
// list.
//
// Every assertion below pins a decision that compiles either way and is only visible as a list
// that quietly means something else:
//   • a summary or a praise row selected by the "Major" pill — the phantom-severity trap the
//     backend rollups spell out (a walkthrough scored `major` outranking real findings)
//   • an empty pill set read as "nothing matches" instead of "no filter"
//   • unlabelled rows surviving an active severity pill, so "Critical" returns unscored comments
//   • "the bot disagrees" firing on a NULL vendor claim, which is most rows
//   • an "oldest" order built with `.reverse()`, which also flips rows that share a timestamp
//   • facet counts computed post-filter, which zeroes every other pill the moment one is pressed
//
// Run from the workspace that HAS vitest (see prRef.test.ts for why this file lives outside src/):
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import type { BotVendorComment, MlCategory, MlLabel, MlSeverity } from '@pierre-review/shared';
import {
  commentFacetCounts,
  filterComments,
  pillOf,
  selectComments,
  SEVERITY_PILLS,
  sortComments,
  vendorDisagrees,
  type SeverityPillKey,
} from '../src/lib/botComments.js';

const SEVERITY_ORD: Record<MlSeverity, number> = { nit: 0, minor: 1, major: 2, critical: 3 };

function label(over: Partial<MlLabel> = {}): MlLabel {
  const severity: MlSeverity = over.severity ?? 'minor';
  return {
    targetKind: 'review_comment',
    targetId: 1,
    severity,
    severityOrd: SEVERITY_ORD[severity],
    severityProb: 0.62,
    vendorSeverity: null,
    vendorSeverityConfidence: null,
    categories: ['correctness_bug'],
    isSummary: false,
    backend: 'severity:modernbert-onnx,category:modernbert-onnx',
    modelVersion: 'severity-v2',
    createdAt: '2026-08-05T00:00:00.000Z',
    ...over,
  };
}

let seq = 0;
/** A comment row. `at` is a bare ISO instant; `ml` null means "not scored". */
function comment(at: string, ml: MlLabel | null, over: Partial<BotVendorComment> = {}): BotVendorComment {
  seq += 1;
  return {
    targetKind: 'review_comment',
    targetId: seq,
    prId: 1,
    prNumber: 7,
    prTitle: 'A PR',
    prAuthorId: 2,
    repoId: 3,
    repoFullName: 'acme/web',
    path: 'src/a.ts',
    threadId: null,
    derivedState: null,
    body: 'text',
    createdAt: at,
    mlLabel: ml,
    ...over,
  };
}

const ids = (rows: BotVendorComment[]): number[] => rows.map((r) => r.targetId);

// ── pillOf ──────────────────────────────────────────────────────────────────────────────────

describe('pillOf — which pill can select a row', () => {
  it('a plain finding is its own severity', () => {
    expect(pillOf(comment('2026-08-01T00:00:00.000Z', label({ severity: 'critical' })))).toBe(
      'critical',
    );
  });

  it('an unscored row belongs to no pill', () => {
    expect(pillOf(comment('2026-08-01T00:00:00.000Z', null))).toBeNull();
  });

  // The trap: a walkthrough still carries a severity. Selecting it with the Major pill is exactly
  // the worstSeverity failure the backend rollups exclude summaries to avoid.
  it('a SUMMARY belongs to no severity pill, however it was scored', () => {
    expect(pillOf(comment('2026-08-01T00:00:00.000Z', label({ severity: 'major', isSummary: true })))).toBeNull();
  });

  it('a praise row is Praise, not its severity', () => {
    const c = comment(
      '2026-08-01T00:00:00.000Z',
      label({ severity: 'major', categories: ['praise'] }),
    );
    expect(pillOf(c)).toBe('praise');
  });

  it('praise mixed with other categories is still Praise', () => {
    const c = comment(
      '2026-08-01T00:00:00.000Z',
      label({ severity: 'nit', categories: ['style_readability', 'praise'] as MlCategory[] }),
    );
    expect(pillOf(c)).toBe('praise');
  });

  // The ONE deliberate divergence from the backend rollup (which buckets summary-first). A
  // walkthrough that is pure praise is a row the Praise pill promises to find.
  it('praise wins over isSummary — the pill is a reader promise, not a rollup bucket', () => {
    const c = comment(
      '2026-08-01T00:00:00.000Z',
      label({ severity: 'minor', isSummary: true, categories: ['praise'] }),
    );
    expect(pillOf(c)).toBe('praise');
  });

  it('every pill key is reachable', () => {
    const reached = new Set<SeverityPillKey | null>([
      pillOf(comment('a', label({ severity: 'critical' }))),
      pillOf(comment('a', label({ severity: 'major' }))),
      pillOf(comment('a', label({ severity: 'minor' }))),
      pillOf(comment('a', label({ severity: 'nit' }))),
      pillOf(comment('a', label({ categories: ['praise'] }))),
    ]);
    for (const k of SEVERITY_PILLS) expect(reached.has(k)).toBe(true);
  });
});

// ── vendorDisagrees ─────────────────────────────────────────────────────────────────────────

describe('vendorDisagrees — severity only, and only on a real claim', () => {
  it('a differing vendor badge is a disagreement', () => {
    const c = comment(
      '2026-08-01T00:00:00.000Z',
      label({ severity: 'minor', vendorSeverity: 'major' }),
    );
    expect(vendorDisagrees(c)).toBe(true);
  });

  it('an agreeing vendor badge is not', () => {
    const c = comment(
      '2026-08-01T00:00:00.000Z',
      label({ severity: 'major', vendorSeverity: 'major' }),
    );
    expect(vendorDisagrees(c)).toBe(false);
  });

  // The common case by a distance, and the one a truthiness test gets wrong: no claim is not a
  // contradiction. It is also what an older severity-api reports for every row.
  it('NO vendor claim is not a disagreement', () => {
    expect(vendorDisagrees(comment('2026-08-01T00:00:00.000Z', label({ vendorSeverity: null })))).toBe(
      false,
    );
  });

  it('an unscored row is not a disagreement', () => {
    expect(vendorDisagrees(comment('2026-08-01T00:00:00.000Z', null))).toBe(false);
  });

  // Vendors declare no machine-readable category, so there is nothing to disagree with there —
  // a category mismatch must never count.
  it('categories never enter into it', () => {
    const c = comment(
      '2026-08-01T00:00:00.000Z',
      label({ severity: 'major', vendorSeverity: 'major', categories: ['security'] }),
    );
    expect(vendorDisagrees(c)).toBe(false);
  });
});

// ── facet counts ────────────────────────────────────────────────────────────────────────────

describe('commentFacetCounts — over the FULL list, pre-filter', () => {
  const rows = [
    comment('2026-08-05T00:00:00.000Z', label({ severity: 'critical' })),
    comment('2026-08-04T00:00:00.000Z', label({ severity: 'major', vendorSeverity: 'nit' })),
    comment('2026-08-03T00:00:00.000Z', label({ severity: 'minor' })),
    comment('2026-08-02T00:00:00.000Z', label({ severity: 'nit' })),
    comment('2026-08-01T00:00:00.000Z', label({ categories: ['praise'] })),
    comment('2026-07-31T00:00:00.000Z', label({ severity: 'major', isSummary: true })),
    comment('2026-07-30T00:00:00.000Z', null),
  ];

  it('counts each pill once, excluding summaries and unscored rows', () => {
    const f = commentFacetCounts(rows);
    expect(f.counts).toEqual({ critical: 1, major: 1, minor: 1, nit: 1, praise: 1 });
  });

  it('counts disagreements and labelled rows separately', () => {
    const f = commentFacetCounts(rows);
    expect(f.disagreements).toBe(1);
    // Six labelled (the summary and the praise row included), one unscored.
    expect(f.labelled).toBe(6);
  });

  it('reports every key on an empty list, so no pill renders undefined', () => {
    const f = commentFacetCounts([]);
    expect(f).toEqual({
      counts: { critical: 0, major: 0, minor: 0, nit: 0, praise: 0 },
      disagreements: 0,
      labelled: 0,
    });
  });
});

// ── filterComments ──────────────────────────────────────────────────────────────────────────

describe('filterComments', () => {
  const crit = comment('2026-08-05T00:00:00.000Z', label({ severity: 'critical' }));
  const major = comment('2026-08-04T00:00:00.000Z', label({ severity: 'major', vendorSeverity: 'nit' }));
  const praise = comment('2026-08-03T00:00:00.000Z', label({ categories: ['praise'] }));
  const summary = comment('2026-08-02T00:00:00.000Z', label({ severity: 'major', isSummary: true }));
  const unscored = comment('2026-08-01T00:00:00.000Z', null);
  const rows = [crit, major, praise, summary, unscored];
  const none = new Set<SeverityPillKey>();

  // Empty means "no filter", not "nothing matches" — the list opens showing everything.
  it('an empty selection filters nothing at all', () => {
    expect(ids(filterComments(rows, { severities: none, disagreesOnly: false }))).toEqual(ids(rows));
  });

  it('a pill selects only its own rows', () => {
    const out = filterComments(rows, { severities: new Set(['critical']), disagreesOnly: false });
    expect(ids(out)).toEqual([crit.targetId]);
  });

  it('pills OR with each other', () => {
    const out = filterComments(rows, {
      severities: new Set(['critical', 'praise']),
      disagreesOnly: false,
    });
    expect(ids(out)).toEqual([crit.targetId, praise.targetId]);
  });

  // With any pill on, a row the model never judged cannot satisfy the claim being made.
  it('ANY active pill hides unscored rows and summaries', () => {
    const out = filterComments(rows, { severities: new Set(['major']), disagreesOnly: false });
    expect(ids(out)).toEqual([major.targetId]);
    expect(ids(out)).not.toContain(summary.targetId);
    expect(ids(out)).not.toContain(unscored.targetId);
  });

  it('the disagreement toggle keeps only contradicted rows', () => {
    const out = filterComments(rows, { severities: none, disagreesOnly: true });
    expect(ids(out)).toEqual([major.targetId]);
  });

  it('the disagreement toggle ANDs with the pills', () => {
    expect(
      ids(filterComments(rows, { severities: new Set(['major']), disagreesOnly: true })),
    ).toEqual([major.targetId]);
    // Same toggle, a pill that excludes the only disagreeing row → empty, not "either".
    expect(
      ids(filterComments(rows, { severities: new Set(['critical']), disagreesOnly: true })),
    ).toEqual([]);
  });

  it('preserves the incoming order and does not mutate the input', () => {
    const before = ids(rows);
    filterComments(rows, { severities: new Set(['praise']), disagreesOnly: false });
    expect(ids(rows)).toEqual(before);
  });
});

// ── sortComments ────────────────────────────────────────────────────────────────────────────

describe('sortComments', () => {
  const a = comment('2026-08-05T00:00:00.000Z', label({ severity: 'nit' }));
  const b = comment('2026-08-04T00:00:00.000Z', label({ severity: 'critical' }));
  const c = comment('2026-08-03T00:00:00.000Z', label({ severity: 'major', isSummary: true }));
  const d = comment('2026-08-02T00:00:00.000Z', null);
  const e = comment('2026-08-01T00:00:00.000Z', label({ severity: 'major' }));
  const rows = [a, b, c, d, e]; // the server's own order: newest first

  it('newest returns the server order untouched', () => {
    expect(ids(sortComments(rows, 'newest'))).toEqual(ids(rows));
  });

  it('oldest is the exact opposite when every timestamp differs', () => {
    expect(ids(sortComments(rows, 'oldest'))).toEqual([...ids(rows)].reverse());
  });

  // `.reverse()` would flip these two as well; a stable ascending sort keeps the server's
  // relative order for rows posted in the same instant (a review body and its inline comments).
  it('oldest is STABLE on ties, not a reversal', () => {
    const t = '2026-08-04T12:00:00.000Z';
    const first = comment(t, label());
    const second = comment(t, label());
    const older = comment('2026-08-01T00:00:00.000Z', label());
    const out = sortComments([first, second, older], 'oldest');
    expect(ids(out)).toEqual([older.targetId, first.targetId, second.targetId]);
  });

  it('severity is worst-first', () => {
    const out = sortComments(rows, 'severity');
    expect(ids(out).slice(0, 2)).toEqual([b.targetId, e.targetId]);
  });

  it('severity SINKS summaries and unscored rows below every finding', () => {
    const out = ids(sortComments(rows, 'severity'));
    const lastTwo = out.slice(-2);
    expect(lastTwo).toContain(c.targetId);
    expect(lastTwo).toContain(d.targetId);
  });

  it('severity breaks ties newest-first', () => {
    const older = comment('2026-01-01T00:00:00.000Z', label({ severity: 'critical' }));
    const newer = comment('2026-06-01T00:00:00.000Z', label({ severity: 'critical' }));
    expect(ids(sortComments([older, newer], 'severity'))).toEqual([newer.targetId, older.targetId]);
  });

  it('never mutates the input array', () => {
    const before = ids(rows);
    sortComments(rows, 'severity');
    sortComments(rows, 'oldest');
    expect(ids(rows)).toEqual(before);
  });
});

// ── selectComments ──────────────────────────────────────────────────────────────────────────

describe('selectComments — filter then sort, composed', () => {
  const rows = [
    comment('2026-08-05T00:00:00.000Z', label({ severity: 'nit', vendorSeverity: 'critical' })),
    comment('2026-08-04T00:00:00.000Z', label({ severity: 'critical' })),
    comment('2026-08-03T00:00:00.000Z', label({ severity: 'major', vendorSeverity: 'major' })),
    comment('2026-08-02T00:00:00.000Z', null),
  ];

  it('applies both, in that order', () => {
    const out = selectComments(
      rows,
      { severities: new Set(['nit', 'critical']), disagreesOnly: false },
      'severity',
    );
    // critical (ord 3) then nit (ord 0) — the unscored and the major row are gone.
    expect(ids(out)).toEqual([rows[1]!.targetId, rows[0]!.targetId]);
  });

  it('a disagreement filter composes with an oldest sort', () => {
    const out = selectComments(rows, { severities: new Set(), disagreesOnly: true }, 'oldest');
    expect(ids(out)).toEqual([rows[0]!.targetId]);
  });

  it('no filter and newest is the identity on the server order', () => {
    const out = selectComments(rows, { severities: new Set(), disagreesOnly: false }, 'newest');
    expect(ids(out)).toEqual(ids(rows));
  });
});
