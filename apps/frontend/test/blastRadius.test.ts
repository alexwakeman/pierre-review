import { describe, expect, it } from 'vitest';
import type { BlastSignals, BlastSurface } from '@pierre-review/shared';
import {
  blastRadius,
  resolveBlastConfig,
  type BlastPrFields,
} from '../src/lib/ui.js';

// ── The blast-radius LEVEL rules ──────────────────────────────────────────────────────────────
//
// The backend's `blast-radius.test.ts` pins the SIGNALS; this pins what they mean. The two
// halves are deliberately separate — the signal vector is a fact about a pull request and the
// level is a reading of it, and the reading is the half a user can reconfigure.
//
// ⚠ THIS SUITE DOES NOT RUN IN CI, AND IS NOT TYPECHECKED EITHER (`pnpm test` is recursive vitest
// and the frontend's `test` script is a no-op; its tsconfig includes only `src`). Run it by hand:
//     ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
// That is a repo-wide condition, not a property of this file — but it bit during this feature's
// own build: renaming `hubP90` to `hubBar` left a stale key in the factory below, which no
// compiler saw, and the hub arm silently stopped firing in every test that used it. A field name
// in this file is not checked against the type it claims to build; only running it finds that.

const DEFAULTS = resolveBlastConfig(null);

const signals = (over: Partial<BlastSignals> = {}): BlastSignals => ({
  codeFiles: 2,
  testFiles: 0,
  nonCodeFiles: 0,
  dirs: 1,
  subsystems: 1,
  surfaces: [],
  allNew: false,
  hubDegree: null,
  hubBar: null,
  hubPath: null,
  truncated: false,
  contentKind: null,
  ...over,
});

const pr = (s: Partial<BlastSignals> | null, codeLoc: number | null = 40): BlastPrFields => ({
  blast: s == null ? null : signals(s),
  codeLoc,
});

describe('blastRadius — the two rules that end in silence', () => {
  it('renders NOTHING when there are no signals — unknown is not low', () => {
    // ~10% of open pull requests on real data. A chip here would tell a maintainer that a pull
    // request nobody measured is safe to wave through.
    expect(blastRadius(pr(null), DEFAULTS)).toBeNull();
    expect(blastRadius({}, DEFAULTS)).toBeNull();
    expect(blastRadius({ blast: undefined }, DEFAULTS)).toBeNull();
  });

  it('refuses to call a TRUNCATED pull request low, or even medium', () => {
    // THE SAFETY RULE. files(first:100) truncates exactly the biggest PRs, so every count is a
    // floor — a containment claim built on one is not honest in either direction.
    expect(blastRadius(pr({ codeFiles: 1, truncated: true }, 10), DEFAULTS)).toBeNull();
    expect(blastRadius(pr({ codeFiles: 5, dirs: 3, truncated: true }, 300), DEFAULTS)).toBeNull();
  });

  it('still asserts HIGH on a truncated list, because a missing file can only add reach', () => {
    const v = blastRadius(pr({ codeFiles: 40, dirs: 12, truncated: true }, 5000), DEFAULTS);
    expect(v?.level).toBe('high');
  });
});

describe('blastRadius — a surface outranks every size arm', () => {
  it.each<BlastSurface>([
    'db_migration',
    'db_schema',
    'sql',
    'public_types',
    'idl',
    'openapi',
    'infra',
    'auth',
  ])('a four-line change touching %s is HIGH', (surface) => {
    // The whole reason blast radius is not a restatement of the large-PR flag.
    const v = blastRadius(pr({ codeFiles: 1, surfaces: [surface] }, 4), DEFAULTS);
    expect(v?.level).toBe('high');
    expect(v?.reasons[0]?.kind).toBe('surface');
  });

  it.each<BlastSurface>(['ci', 'deps'])('%s alone does NOT force high', (surface) => {
    // `deps` is the most common surface on real data (222 of 1,405) and a dependency bump is the
    // archetypal LOW-blast change; `ci` can break every build but ships nothing to users.
    const v = blastRadius(pr({ codeFiles: 1, surfaces: [surface] }, 20), DEFAULTS);
    expect(v?.level).not.toBe('high');
  });

  it('honours surfacesOff — the escape hatch for a repo whose domain IS the surface', () => {
    const config = resolveBlastConfig({ sensitivity: 'balanced', surfacesOff: ['db_schema'] });
    const p = pr({ codeFiles: 1, surfaces: ['db_schema'] }, 30);
    expect(blastRadius(p, DEFAULTS)?.level).toBe('high');
    expect(blastRadius(p, config)?.level).toBe('low');
  });
});

describe('blastRadius — the hub arm', () => {
  it('fires when the degree meets the repo\'s own bar', () => {
    const v = blastRadius(
      pr({ codeFiles: 2, hubDegree: 417, hubBar: 195, hubPath: 'src/lib.rs' }, 60),
      DEFAULTS,
    );
    expect(v?.level).toBe('high');
    expect(v?.reasons.some((r) => r.kind === 'hub')).toBe(true);
    // The number is the evidence — a bare "this is a hub" is not reviewable information.
    expect(v?.reasons.find((r) => r.kind === 'hub')?.text).toContain('417');
  });

  it('is SILENT on a null reading rather than treating it as "not a hub"', () => {
    // Only 9 of 22 real repositories clear the index's coverage floor, so null is the COMMON
    // case. A `hubDegree ?? 0` in the resolver would convert every one of those silences into a
    // clean bill of health.
    const v = blastRadius(pr({ codeFiles: 1, hubDegree: null, hubBar: null }, 30), DEFAULTS);
    expect(v?.level).toBe('low');
    expect(v?.reasons.some((r) => r.kind === 'hub')).toBe(false);
  });

  it('does not fire below the repo bar', () => {
    const v = blastRadius(pr({ codeFiles: 1, hubDegree: 12, hubBar: 195 }, 30), DEFAULTS);
    expect(v?.level).toBe('low');
  });
});

describe('blastRadius — LOW', () => {
  it('a one-file fix with its test', () => {
    const v = blastRadius(pr({ codeFiles: 1, testFiles: 1 }, 58), DEFAULTS);
    expect(v?.level).toBe('low');
    expect(v?.reasons[0]?.text).toContain('with tests');
  });

  it('a docs/config/deps-only change', () => {
    const v = blastRadius(pr({ codeFiles: 0, nonCodeFiles: 3, surfaces: ['deps'] }, 0), DEFAULTS);
    expect(v?.level).toBe('low');
    expect(v?.reasons[0]?.text).toContain('no code changed');
  });

  it('a tests-only change says TESTS, not "no code"', () => {
    // "No code changed" about a pull request that rewrote the test suite is not what a reviewer
    // means by it.
    const v = blastRadius(pr({ codeFiles: 0, testFiles: 4 }, 0), DEFAULTS);
    expect(v?.level).toBe('low');
    expect(v?.reasons[0]?.text).toContain('Tests only');
  });

  it('needs a KNOWN code line count — a null codeLoc cannot earn containment', () => {
    // The large-PR flag's trap 1, reaching this resolver: we know which files were touched but
    // not how much of them. That is not enough to say "quick eyeball".
    expect(blastRadius(pr({ codeFiles: 1 }, null), DEFAULTS)?.level).toBe('medium');
  });

  it('stops being low once the change spans two subsystems', () => {
    expect(blastRadius(pr({ codeFiles: 2, subsystems: 2 }, 40), DEFAULTS)?.level).toBe('medium');
  });
});

describe('blastRadius — the sensitivity dial', () => {
  const p = pr({ codeFiles: 3, dirs: 3, subsystems: 1 }, 150);

  it('moves the same pull request across levels without touching the arms', () => {
    expect(blastRadius(p, resolveBlastConfig({ sensitivity: 'relaxed', surfacesOff: [] }))?.level).toBe('low');
    expect(blastRadius(p, DEFAULTS)?.level).toBe('medium');
    // cautious: highDirs is 4 and highCodeFiles 10, so 3 dirs is still not high — but the LOW
    // bar tightens to 50 lines / 2 files, so it can no longer be contained either.
    expect(blastRadius(p, resolveBlastConfig({ sensitivity: 'cautious', surfacesOff: [] }))?.level).toBe('medium');
  });

  it('applies a numeric override ON TOP of the dial, leaving the rest at their defaults', () => {
    const config = resolveBlastConfig({
      sensitivity: 'balanced',
      surfacesOff: [],
      overrides: { highDirs: 2 },
    });
    expect(config.thresholds.highDirs).toBe(2);
    expect(config.thresholds.highCodeLoc).toBe(DEFAULTS.thresholds.highCodeLoc);
    expect(blastRadius(p, config)?.level).toBe('high');
  });

  it('reports isDefault only when nothing is stored', () => {
    expect(resolveBlastConfig(null).isDefault).toBe(true);
    expect(resolveBlastConfig({ sensitivity: 'balanced', surfacesOff: [] }).isDefault).toBe(false);
  });
});

describe('blastRadius — the trivial-change cap', () => {
  // The case: golang/go#80721, "crypto/hpke: document sequence counter size" — one file, +4 −2,
  // every changed line a `//` doc comment, HIGH because `crypto/` is a contract surface. The path
  // was right about the file and wrong about the change.
  const cryptoDoc = (over: Partial<BlastSignals> = {}) =>
    pr({ codeFiles: 1, surfaces: ['auth'], ...over }, 6);

  it('caps a comments-only change at MEDIUM, not at low', () => {
    // ⚠ MEDIUM IS THE POINT. A comment in a crypto file is still a change to a file that matters;
    // demoting to low would make the file's consequence disappear, which is the opposite error.
    expect(blastRadius(cryptoDoc(), DEFAULTS)?.level).toBe('high');
    expect(blastRadius(cryptoDoc({ contentKind: 'comments' }), DEFAULTS)?.level).toBe('medium');
  });

  it('caps a formatting-only change the same way', () => {
    expect(blastRadius(cryptoDoc({ contentKind: 'formatting' }), DEFAULTS)?.level).toBe('medium');
  });

  it('does NOT cap when the diff says the change is real code', () => {
    expect(blastRadius(cryptoDoc({ contentKind: 'code' }), DEFAULTS)?.level).toBe('high');
  });

  it('does NOT cap on an absent reading — null is "we did not look", never trivial', () => {
    // ~98% of pull requests never have their diff fetched. If null demoted, the cap would apply
    // to almost everything.
    expect(blastRadius(cryptoDoc({ contentKind: null }), DEFAULTS)?.level).toBe('high');
    expect(blastRadius(cryptoDoc(), DEFAULTS)?.level).toBe('high');
  });

  it('caps a change that was high on SPREAD or VOLUME too, not just on a surface', () => {
    expect(
      blastRadius(pr({ codeFiles: 20, dirs: 9, contentKind: 'comments' }, 3000), DEFAULTS)?.level,
    ).toBe('medium');
  });

  it('KEEPS the capped-from reasons, below the explanation', () => {
    // The file still matters and the reader is entitled to see what would have made it high.
    const v = blastRadius(cryptoDoc({ contentKind: 'comments' }), DEFAULTS);
    expect(v?.reasons[0]?.text).toContain('Comments only');
    expect(v?.reasons.some((r) => r.kind === 'surface')).toBe(true);
  });

  it('leaves an already-low pull request alone', () => {
    // The cap only ever moves downward FROM high; it must not promote anything.
    const v = blastRadius(pr({ codeFiles: 1, contentKind: 'comments' }, 6), DEFAULTS);
    expect(v?.level).toBe('low');
  });
});

describe('blastRadius — the anti-double-count rule', () => {
  it('flags volumeOnly when SIZE is the sole reason, so the chip need not repeat the number', () => {
    // A 2,000-line PR would otherwise carry an amber "2,000 code lines" from `largePrFlag` AND a
    // High chip whose only reason is those same 2,000 lines.
    const v = blastRadius(pr({ codeFiles: 4, dirs: 2, subsystems: 1 }, 2400), DEFAULTS);
    expect(v?.level).toBe('high');
    expect(v?.volumeOnly).toBe(true);
  });

  it('does NOT flag volumeOnly when a surface or spread is also in play', () => {
    const v = blastRadius(pr({ codeFiles: 4, surfaces: ['db_migration'] }, 2400), DEFAULTS);
    expect(v?.volumeOnly).toBe(false);
    // And the surface leads the list — the non-obvious reason is the one worth screen space.
    expect(v?.reasons[0]?.kind).toBe('surface');
  });

  it('reads the SAME codeLoc the large-PR flag reads, never a second count', () => {
    // One fact, one grain. If `codeLoc` ever gets duplicated into BlastSignals, this is the test
    // that should stop it: the resolver has no other source for the number.
    const v = blastRadius({ blast: signals({ codeFiles: 2 }), codeLoc: 5000 }, DEFAULTS);
    expect(v?.reasons.some((r) => r.text.includes('5,000'))).toBe(true);
  });

  it('marks a lower-bound line count with a + rather than asserting it exactly', () => {
    const v = blastRadius(
      { blast: signals({ codeFiles: 2, truncated: true }), codeLoc: 5000, codeLocIsLowerBound: true },
      DEFAULTS,
    );
    expect(v?.reasons.find((r) => r.kind === 'volume')?.text).toContain('5,000+');
  });
});
