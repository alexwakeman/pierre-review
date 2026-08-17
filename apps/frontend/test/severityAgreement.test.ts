// The "what the bots are flagging" drill-down's pure layer: the ours-vs-vendor comparison, and the
// cache key the tiles open it with.
//
// Every assertion below pins a decision that compiles either way and is only visible as a screen
// that quietly means something else:
//   • "the bot disagrees" firing on a NULL vendor claim, which is most rows — and, the other half
//     of the same rule, a null claim failing to match the matrix's own `'none'` column, which
//     renders its biggest cell as an empty list
//   • a direction read the wrong way round, so "the bot called it worse than we did" selects the
//     rows where it called it milder
//   • an absent dense cell answering `undefined` instead of the zero it means
//   • a selector key built in click order, so `['major','critical']` and `['critical','major']`
//     become two React Query entries for one population — two requests, two scroll positions
//   • two arms sharing a key, so the Findings tile and a category chip page each other's list
//   • a severity dropdown whose value cannot be read back OUT of the selector, so the control
//     shows nothing selected for the very tile the page is rendering
//   • praise treated as a topic rather than as the severity picker's last option, which makes the
//     page swap its own dropdown out from under the cursor the instant praise is chosen
//
// ⚠ THIS DIRECTORY IS NOT WIRED INTO CI. `apps/frontend`'s `test` script is `echo "no tests"`, so
// `pnpm test` never reaches these files; the command below is how they get exercised. Run it from
// the workspace that HAS vitest (see prRef.test.ts for why the file lives outside src/):
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import type {
  BotFlaggingSelector,
  MlCategory,
  MlLabel,
  MlSeverity,
  SeverityAgreementMatrix,
  VendorSeverityAxis,
} from '@pierre-review/shared';
import { ML_CATEGORIES, ML_SEVERITIES, ML_SEVERITY_ORD } from '@pierre-review/shared';
import {
  SEVERITY_PICKS,
  TOPIC_PICKS,
  disagreeDirection,
  isCategoryFamily,
  isSeverityFamily,
  matchesCell,
  matrixCell,
  refineQueryKey,
  selectorLabel,
  selectorQueryKey,
  severityPickOf,
  severityPickToSelector,
  vendorAxisOf,
} from '../src/lib/severityAgreement.js';

function label(over: Partial<MlLabel> = {}): MlLabel {
  const severity: MlSeverity = over.severity ?? 'minor';
  return {
    targetKind: 'review_comment',
    targetId: 1,
    severity,
    severityOrd: ML_SEVERITY_ORD[severity],
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

const VENDOR_AXIS: VendorSeverityAxis[] = [...ML_SEVERITIES, 'none'];

/** A dense 5×4 grid with every cell zero except the ones named. */
function matrix(
  filled: Array<{ vendor: VendorSeverityAxis; ours: MlSeverity; count: number }> = [],
): SeverityAgreementMatrix {
  const cells = VENDOR_AXIS.flatMap((vendor) =>
    ML_SEVERITIES.map((ours) => ({
      vendor,
      ours,
      count: filled.find((f) => f.vendor === vendor && f.ours === ours)?.count ?? 0,
    })),
  );
  const total = filled.reduce((n, f) => n + f.count, 0);
  const undeclared = filled.reduce((n, f) => (f.vendor === 'none' ? n + f.count : n), 0);
  return {
    cells,
    declared: total - undeclared,
    undeclared,
    agree: 0,
    overCall: 0,
    underCall: 0,
    total,
  };
}

// ── vendorAxisOf ────────────────────────────────────────────────────────────────────────────

describe('vendorAxisOf — the matrix column a row sits in', () => {
  it('a declared badge is its own column', () => {
    expect(vendorAxisOf(label({ vendorSeverity: 'major' }))).toBe('major');
  });

  // Not a placeholder and not a dropped row: "the bot declared nothing" is the common case (and
  // what an older severity-api reports for EVERY row), so it owns a column of its own.
  it('no claim at all is the `none` column', () => {
    expect(vendorAxisOf(label({ vendorSeverity: null }))).toBe('none');
  });
});

// ── disagreeDirection ───────────────────────────────────────────────────────────────────────

describe('disagreeDirection — which way, and only on a real claim', () => {
  it('over = the BOT called it worse than we did', () => {
    expect(disagreeDirection(label({ severity: 'nit', vendorSeverity: 'critical' }))).toBe('over');
    expect(disagreeDirection(label({ severity: 'minor', vendorSeverity: 'major' }))).toBe('over');
  });

  it('under = the bot called it milder', () => {
    expect(disagreeDirection(label({ severity: 'critical', vendorSeverity: 'nit' }))).toBe('under');
    expect(disagreeDirection(label({ severity: 'major', vendorSeverity: 'minor' }))).toBe('under');
  });

  it('agreement is not a direction', () => {
    expect(disagreeDirection(label({ severity: 'major', vendorSeverity: 'major' }))).toBeNull();
  });

  // The common case by a distance, and the one a truthiness test gets wrong: no claim is not a
  // contradiction, so it can never be "over" or "under" either. The matrix reports the two apart
  // (`agree` vs `undeclared`); the FILTER does not need to.
  it('NO vendor claim is null, exactly like agreement', () => {
    expect(disagreeDirection(label({ severity: 'critical', vendorSeverity: null }))).toBeNull();
    expect(disagreeDirection(label({ severity: 'nit', vendorSeverity: null }))).toBeNull();
  });

  // Direction is the two ORDINALS, never a confidence. A low-confidence read of a `critical`
  // badge against our `nit` is still the bot calling it worse than we did.
  it('neither confidence number moves the direction', () => {
    const l = label({
      severity: 'nit',
      vendorSeverity: 'critical',
      vendorSeverityConfidence: 'low',
      severityProb: 0.99,
    });
    expect(disagreeDirection(l)).toBe('over');
  });

  it('every ordered pair of distinct classes has a direction, and it is antisymmetric', () => {
    for (const ours of ML_SEVERITIES) {
      for (const vendor of ML_SEVERITIES) {
        const d = disagreeDirection(label({ severity: ours, vendorSeverity: vendor }));
        if (ours === vendor) {
          expect(d).toBeNull();
        } else {
          expect(d).toBe(ML_SEVERITY_ORD[vendor] > ML_SEVERITY_ORD[ours] ? 'over' : 'under');
          expect(disagreeDirection(label({ severity: vendor, vendorSeverity: ours }))).toBe(
            d === 'over' ? 'under' : 'over',
          );
        }
      }
    }
  });
});

// ── matchesCell ─────────────────────────────────────────────────────────────────────────────

describe('matchesCell — clicking one cell of the matrix', () => {
  it('matches on BOTH axes', () => {
    const l = label({ severity: 'nit', vendorSeverity: 'critical' });
    expect(matchesCell(l, { vendor: 'critical', ours: 'nit' })).toBe(true);
    expect(matchesCell(l, { vendor: 'critical', ours: 'major' })).toBe(false);
    expect(matchesCell(l, { vendor: 'major', ours: 'nit' })).toBe(false);
  });

  // ⚠ THE LOAD-BEARING ONE. `l.vendorSeverity === cell.vendor` compiles and is wrong for the
  // matrix's biggest column: the `none` cell would select nothing at all.
  it('a null claim matches the `none` column', () => {
    const l = label({ severity: 'minor', vendorSeverity: null });
    expect(matchesCell(l, { vendor: 'none', ours: 'minor' })).toBe(true);
    expect(matchesCell(l, { vendor: 'none', ours: 'nit' })).toBe(false);
  });

  it('a declared claim never matches the `none` column', () => {
    const l = label({ severity: 'minor', vendorSeverity: 'minor' });
    expect(matchesCell(l, { vendor: 'none', ours: 'minor' })).toBe(false);
  });

  // Our severity is ours whatever the vendor said — the cell narrows the population, it does not
  // reassign a row's class.
  it('the vendor axis never moves the row off its own severity', () => {
    const l = label({ severity: 'nit', vendorSeverity: 'critical' });
    expect(matchesCell(l, { vendor: 'critical', ours: 'critical' })).toBe(false);
  });
});

// ── matrixCell ──────────────────────────────────────────────────────────────────────────────

describe('matrixCell', () => {
  const m = matrix([
    { vendor: 'critical', ours: 'nit', count: 4 },
    { vendor: 'none', ours: 'major', count: 11 },
  ]);

  it('reads a filled cell', () => {
    expect(matrixCell(m, 'critical', 'nit')).toBe(4);
    expect(matrixCell(m, 'none', 'major')).toBe(11);
  });

  it('reads a present zero as zero', () => {
    expect(matrixCell(m, 'major', 'major')).toBe(0);
  });

  // The grid is dense on the wire, so a miss means the shape changed — 0, never `undefined`
  // reaching a `.toLocaleString()` or a cell width.
  it('answers 0, not undefined, for a cell the payload omitted', () => {
    const sparse: SeverityAgreementMatrix = { ...m, cells: [] };
    expect(matrixCell(sparse, 'nit', 'nit')).toBe(0);
    expect(matrixCell(sparse, 'nit', 'nit')).not.toBeUndefined();
  });

  it('covers the whole 5×4 grid without a lookup miss', () => {
    for (const vendor of VENDOR_AXIS) {
      for (const ours of ML_SEVERITIES) expect(typeof matrixCell(m, vendor, ours)).toBe('number');
    }
  });
});

// ── selectorQueryKey ────────────────────────────────────────────────────────────────────────

describe('selectorQueryKey — the cache slot a tile opens', () => {
  // ⚠ THE OTHER LOAD-BEARING ONE. The two spellings name ONE population; an unsorted key makes
  // them two entries, two requests, and a "Load more" that pages the one that is not on screen.
  it('is order-insensitive for the severities array', () => {
    const a: BotFlaggingSelector = { kind: 'severity', severities: ['major', 'critical'] };
    const b: BotFlaggingSelector = { kind: 'severity', severities: ['critical', 'major'] };
    expect(selectorQueryKey(a)).toBe(selectorQueryKey(b));
  });

  it('a repeated class names the same population as one', () => {
    expect(selectorQueryKey({ kind: 'severity', severities: ['nit', 'nit'] })).toBe(
      selectorQueryKey({ kind: 'severity', severities: ['nit'] }),
    );
  });

  it('different severity SETS are different slots', () => {
    expect(selectorQueryKey({ kind: 'severity', severities: ['nit'] })).not.toBe(
      selectorQueryKey({ kind: 'severity', severities: ['major', 'critical'] }),
    );
    expect(selectorQueryKey({ kind: 'severity', severities: ['major'] })).not.toBe(
      selectorQueryKey({ kind: 'severity', severities: ['major', 'critical'] }),
    );
  });

  it('every arm gets its own slot', () => {
    const keys = [
      selectorQueryKey({ kind: 'findings' }),
      selectorQueryKey({ kind: 'summaries' }),
      selectorQueryKey({ kind: 'severity', severities: ['nit'] }),
      selectorQueryKey({ kind: 'category', category: 'nitpick' }),
      selectorQueryKey({ kind: 'overlap' }),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('two categories are two slots', () => {
    const cats: MlCategory[] = ['correctness_bug', 'security', 'praise'];
    const keys = cats.map((category) => selectorQueryKey({ kind: 'category', category }));
    expect(new Set(keys).size).toBe(cats.length);
  });

  it('is stable across calls — the key is not derived from anything mutable', () => {
    const s: BotFlaggingSelector = { kind: 'severity', severities: ['critical', 'nit'] };
    expect(selectorQueryKey(s)).toBe(selectorQueryKey(s));
  });

  it('does not mutate the selector it was handed', () => {
    const severities: MlSeverity[] = ['major', 'critical'];
    selectorQueryKey({ kind: 'severity', severities });
    expect(severities).toEqual(['major', 'critical']);
  });
});

// ── refineQueryKey ──────────────────────────────────────────────────────────────────────────

describe('refineQueryKey — the refinement is server-side, so it is part of the key', () => {
  // The empty refine is the mount case: it has to produce ONE fixed string or every fresh mount
  // misses the cache.
  it('an empty refine is one fixed string', () => {
    expect(refineQueryKey({ cell: null, disagree: null })).toBe(
      refineQueryKey({ cell: null, disagree: null }),
    );
  });

  it('each half moves the key independently', () => {
    const empty = refineQueryKey({ cell: null, disagree: null });
    const celled = refineQueryKey({ cell: { vendor: 'none', ours: 'nit' }, disagree: null });
    const dis = refineQueryKey({ cell: null, disagree: 'over' });
    const both = refineQueryKey({ cell: { vendor: 'none', ours: 'nit' }, disagree: 'over' });
    expect(new Set([empty, celled, dis, both]).size).toBe(4);
  });

  it('the three directions are three slots', () => {
    const keys = (['any', 'over', 'under'] as const).map((disagree) =>
      refineQueryKey({ cell: null, disagree }),
    );
    expect(new Set(keys).size).toBe(3);
    expect(keys).not.toContain(refineQueryKey({ cell: null, disagree: null }));
  });

  // The two axes carry the same four class names, so a key that joined them without a separator
  // would let {vendor:'major', ours:'nit'} and {vendor:'majorn', ours:'it'} — or, really, any
  // transposition — collide.
  it('a transposed cell is a different slot', () => {
    expect(refineQueryKey({ cell: { vendor: 'nit', ours: 'critical' }, disagree: null })).not.toBe(
      refineQueryKey({ cell: { vendor: 'critical', ours: 'nit' }, disagree: null }),
    );
  });
});

// ── selectorLabel ───────────────────────────────────────────────────────────────────────────

describe('selectorLabel — the tab chip and the drill-down heading', () => {
  it('names the two severity sets the strip actually emits', () => {
    expect(selectorLabel({ kind: 'severity', severities: ['major', 'critical'] }).title).toBe(
      'High severity',
    );
    // …whichever order the caller built it in.
    expect(selectorLabel({ kind: 'severity', severities: ['critical', 'major'] }).title).toBe(
      'High severity',
    );
    expect(selectorLabel({ kind: 'severity', severities: ['nit'] }).title).toBe('Nits');
  });

  it('falls back to listing the classes for a set the strip never emits', () => {
    const t = selectorLabel({ kind: 'severity', severities: ['minor', 'nit'] }).title;
    expect(t).toContain('Minor');
    expect(t).toContain('Nit');
    expect(t).not.toBe('High severity');
  });

  it('a category is its human label, not its snake_case key', () => {
    expect(selectorLabel({ kind: 'category', category: 'correctness_bug' }).title).toBe(
      'Correctness',
    );
  });

  // Every arm renders a chip, so none of them may be blank — an empty title is a tab with no name.
  it('every arm has a non-empty title and subtitle', () => {
    const selectors: BotFlaggingSelector[] = [
      { kind: 'findings' },
      { kind: 'summaries' },
      { kind: 'severity', severities: ['nit'] },
      { kind: 'severity', severities: [] },
      { kind: 'category', category: 'security' },
      { kind: 'overlap' },
    ];
    for (const s of selectors) {
      const { title, subtitle } = selectorLabel(s);
      expect(title.length).toBeGreaterThan(0);
      expect(subtitle.length).toBeGreaterThan(0);
    }
  });

  it('the five arms have five distinct titles', () => {
    const titles = [
      selectorLabel({ kind: 'findings' }).title,
      selectorLabel({ kind: 'summaries' }).title,
      selectorLabel({ kind: 'severity', severities: ['nit'] }).title,
      selectorLabel({ kind: 'category', category: 'nitpick' }).title,
      selectorLabel({ kind: 'overlap' }).title,
    ];
    expect(new Set(titles).size).toBe(titles.length);
  });
});

// ── the on-page pickers ─────────────────────────────────────────────────────────────────────

describe('severityPick — the severity dropdown, both directions', () => {
  // ⚠ THE ONE THAT MATTERS. The dropdown's value is DERIVED from the selector on every render, so
  // a mapping that is not a true inverse renders a control showing nothing selected for the very
  // population the page is displaying — and the reader's next pick then reads as a no-op.
  it('round-trips every option', () => {
    for (const p of SEVERITY_PICKS) {
      expect(severityPickOf(severityPickToSelector(p))).toBe(p);
    }
  });

  it('offers all four classes, the high pair, and praise — worst-first, praise last', () => {
    expect(SEVERITY_PICKS).toEqual(['high', 'critical', 'major', 'minor', 'nit', 'praise']);
    for (const sev of ML_SEVERITIES) expect(SEVERITY_PICKS).toContain(sev);
  });

  it('high is the major+critical PAIR, whichever order the selector spells it in', () => {
    expect(severityPickToSelector('high')).toEqual({
      kind: 'severity',
      severities: ['major', 'critical'],
    });
    expect(severityPickOf({ kind: 'severity', severities: ['major', 'critical'] })).toBe('high');
    expect(severityPickOf({ kind: 'severity', severities: ['critical', 'major'] })).toBe('high');
  });

  // A picker that read `severities[0]` would show "Major" for the list whose own caption says
  // High severity — the set is the identity, not the array.
  it('a single class is itself, and a repeat is still that single class', () => {
    expect(severityPickOf({ kind: 'severity', severities: ['nit'] })).toBe('nit');
    expect(severityPickOf({ kind: 'severity', severities: ['nit', 'nit'] })).toBe('nit');
  });

  // Praise is a CATEGORY on the wire (there is no `severities: ['praise']` for the server to
  // match) — the picker hides the arm change, it does not invent a class.
  it('praise crosses arms into the category selector', () => {
    expect(severityPickToSelector('praise')).toEqual({ kind: 'category', category: 'praise' });
  });

  it('answers null for anything the picker cannot name', () => {
    expect(severityPickOf({ kind: 'findings' })).toBeNull();
    expect(severityPickOf({ kind: 'summaries' })).toBeNull();
    expect(severityPickOf({ kind: 'overlap' })).toBeNull();
    expect(severityPickOf({ kind: 'category', category: 'security' })).toBeNull();
    // A set with no option of its own — reachable from a URL, and it must not masquerade as one.
    expect(severityPickOf({ kind: 'severity', severities: ['minor', 'nit'] })).toBeNull();
    expect(severityPickOf({ kind: 'severity', severities: [] })).toBeNull();
  });

  it('does not mutate the selector it reads', () => {
    const severities: MlSeverity[] = ['critical', 'major'];
    severityPickOf({ kind: 'severity', severities });
    expect(severities).toEqual(['critical', 'major']);
  });
});

describe('isSeverityFamily / isCategoryFamily — which dropdown the page shows', () => {
  // ⚠ THE LOAD-BEARING ONE. Praise is a `category` arm but the SEVERITY picker's last option, so a
  // plain `kind === 'category'` test would flip the page's own dropdown the moment praise is
  // chosen: the control the reader just used vanishes and an unselected topic select replaces it.
  it('praise is severity-family and NOT category-family', () => {
    const praise: BotFlaggingSelector = { kind: 'category', category: 'praise' };
    expect(isSeverityFamily(praise)).toBe(true);
    expect(isCategoryFamily(praise)).toBe(false);
  });

  it('a real topic is category-family and not severity-family', () => {
    const topic: BotFlaggingSelector = { kind: 'category', category: 'security' };
    expect(isCategoryFamily(topic)).toBe(true);
    expect(isSeverityFamily(topic)).toBe(false);
  });

  it('every severity pick lands in the severity family and nowhere else', () => {
    for (const p of SEVERITY_PICKS) {
      const s = severityPickToSelector(p);
      expect(isSeverityFamily(s)).toBe(true);
      expect(isCategoryFamily(s)).toBe(false);
    }
  });

  // The three remaining arms belong to NEITHER picker — they render no dropdown at all rather than
  // an empty one.
  it('findings, summaries and overlap are in neither family', () => {
    for (const s of [
      { kind: 'findings' },
      { kind: 'summaries' },
      { kind: 'overlap' },
    ] as BotFlaggingSelector[]) {
      expect(isSeverityFamily(s)).toBe(false);
      expect(isCategoryFamily(s)).toBe(false);
    }
  });
});

describe('TOPIC_PICKS — the topic dropdown', () => {
  // Praise is the severity picker's option, and the strip's byCategory is folded ONLY in the
  // finding branch, so a Praise topic would advertise a count the strip can never show.
  it('excludes praise', () => {
    expect(TOPIC_PICKS).not.toContain('praise');
  });

  it('offers every other ML category, in the wire order', () => {
    expect(TOPIC_PICKS).toEqual(ML_CATEGORIES.filter((c) => c !== 'praise'));
    expect(TOPIC_PICKS).toHaveLength(ML_CATEGORIES.length - 1);
  });

  // Each option is what the dropdown WRITES, so each has to be category-family — otherwise picking
  // it would switch the page to the other dropdown.
  it('every option is category-family', () => {
    for (const category of TOPIC_PICKS) {
      expect(isCategoryFamily({ kind: 'category', category })).toBe(true);
    }
  });
});
