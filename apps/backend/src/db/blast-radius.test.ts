import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BlastSignals, StoredPrFile } from '@pierre-review/shared';
import { blastSignalsFor, isTestFile, surfacesForPath } from './blast-radius.js';
import { PR_FILES_PAGE_CAP } from './code-loc.js';

interface Fixture {
  name: string;
  why: string;
  pr: {
    additions: number;
    deletions: number;
    changedFiles: number;
    files?: StoredPrFile[] | null;
  };
  /** Generates a synthetic file list too long to write out by hand (the page-cap case). */
  generate?: { codeFiles: number; eachAdditions: number; eachDeletions: number };
  /** `null` asserts the fold returns null (UNKNOWN). Otherwise a PARTIAL vector: only the keys
   *  present are asserted, so a case can pin one rule without restating the whole thing. */
  expected: Partial<BlastSignals> | null;
}

const fixturesDir = resolve(import.meta.dirname, '__fixtures__/blast');

function loadFixtures(): Fixture[] {
  return readdirSync(fixturesDir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(resolve(fixturesDir, f), 'utf-8')) as Fixture);
}

describe('blastSignalsFor — fixtures', () => {
  for (const fx of loadFixtures()) {
    it(fx.name, () => {
      let files = fx.pr.files;
      if (fx.generate) {
        files = Array.from({ length: fx.generate.codeFiles }, (_, i) => ({
          path: `src/pkg/file-${i}.ts`,
          additions: fx.generate!.eachAdditions,
          deletions: fx.generate!.eachDeletions,
        }));
      }
      const got = blastSignalsFor({ ...fx.pr, files });

      if (fx.expected === null) {
        // ⚠ THE ASSERTION THAT MATTERS MOST. `null` is UNKNOWN and every surface draws nothing
        // for it. It is NOT "low" — a fold that started returning a zeroed vector here would
        // silently tell a maintainer that an unmeasured pull request is safe to wave through.
        expect(got).toBeNull();
        return;
      }

      expect(got).not.toBeNull();
      for (const [key, want] of Object.entries(fx.expected)) {
        expect({ [key]: got![key as keyof BlastSignals] }).toEqual({ [key]: want });
      }
    });
  }

  it('every fixture states what it defends', () => {
    // A fixture whose `why` is missing is a case nobody can safely change later.
    for (const fx of loadFixtures()) expect(fx.why?.length ?? 0).toBeGreaterThan(20);
  });
});

describe('blastSignalsFor — the rules the fixtures cannot express', () => {
  const pr = (files: StoredPrFile[]): Parameters<typeof blastSignalsFor>[0] => ({
    files,
    additions: files.reduce((s, f) => s + f.additions, 0),
    deletions: files.reduce((s, f) => s + f.deletions, 0),
    changedFiles: files.length,
  });

  it('sets truncated exactly at the page cap, and the cap is the one in code-loc', () => {
    const at = Array.from({ length: PR_FILES_PAGE_CAP }, (_, i) => ({
      path: `src/f${i}.ts`,
      additions: 1,
      deletions: 1,
    }));
    expect(blastSignalsFor(pr(at))!.truncated).toBe(true);
    expect(blastSignalsFor(pr(at.slice(0, PR_FILES_PAGE_CAP - 1)))!.truncated).toBe(false);
  });

  it('marks truncated when changedFiles exceeds the stored list, below the cap', () => {
    // The other half of the lower-bound test: GitHub told us 40 files changed and stored 3.
    const got = blastSignalsFor({
      files: [{ path: 'src/a.ts', additions: 5, deletions: 5 }],
      additions: 900,
      deletions: 100,
      changedFiles: 40,
    });
    expect(got!.truncated).toBe(true);
  });

  it('orders surfaces most-consequential first, not by file order', () => {
    // `deps` comes last in BLAST_SURFACES and first in the file list. The chip's sentence must
    // lead with the migration.
    const got = blastSignalsFor(
      pr([
        { path: 'package.json', additions: 2, deletions: 2 },
        { path: 'db/migrations/0001_x.sql', additions: 10, deletions: 0 },
      ]),
    );
    expect(got!.surfaces).toEqual(['db_migration', 'sql', 'deps']);
  });

  it('never reports allNew for a pull request with no code files', () => {
    // A docs-only PR has nothing that can break, but claiming "all new" about it would put a
    // reassurance on screen that describes an empty set.
    const got = blastSignalsFor(pr([{ path: 'README.md', additions: 10, deletions: 0 }]));
    expect(got!.codeFiles).toBe(0);
    expect(got!.allNew).toBe(false);
  });

  it('leaves every hub field null when no reading is supplied', () => {
    // P1 ships with no index. ⚠ null, never 0 — a 0 degree reads as "measured, not a hub".
    const got = blastSignalsFor(pr([{ path: 'src/a.ts', additions: 1, deletions: 1 }]));
    expect(got!.hubDegree).toBeNull();
    expect(got!.hubBar).toBeNull();
    expect(got!.hubPath).toBeNull();
  });

  it('carries a supplied hub reading through untouched', () => {
    const got = blastSignalsFor(pr([{ path: 'src/a.ts', additions: 1, deletions: 1 }]), {
      degree: 417,
      bar: 195,
      path: 'src/a.ts',
    });
    expect(got!.hubDegree).toBe(417);
    expect(got!.hubBar).toBe(195);
    expect(got!.hubPath).toBe('src/a.ts');
  });
});

describe('isTestFile', () => {
  it.each([
    'src/foo.test.ts',
    'src/foo.spec.tsx',
    'pkg/handler_test.go',
    'tests/integration/api.py',
    'src/__tests__/thing.ts',
    'e2e/checkout.ts',
    'app/test_views.py',
    'Tests/Unit/Thing.cs',
  ])('%s is a test', (p) => expect(isTestFile(p)).toBe(true));

  it.each([
    // ⚠ A BASENAME IS NOT A DIRECTORY — `scripts/test` is an executable, and `latest.ts` and
    // `contest.ts` merely contain the letters. Matching loosely here silently uncounts real code,
    // which LOWERS a pull request's blast radius. Same trap isNonCodeFile documents.
    'scripts/test',
    'src/latest.ts',
    'src/contest.ts',
    'src/protest/handler.ts',
    'src/testament.ts',
  ])('%s is not a test', (p) => expect(isTestFile(p)).toBe(false));
});

describe('surfacesForPath', () => {
  it('matches case-insensitively, unlike the agent diff budget', () => {
    expect(surfacesForPath('DB/Migrations/0001_x.sql')).toContain('db_migration');
  });

  it('does not treat an ordinary source file as a contract', () => {
    expect(surfacesForPath('src/components/Button.tsx')).toEqual([]);
  });

  it('recognises the known false-positive shape so it can be switched off, not silently dropped', () => {
    // A repo whose PRODUCT is an ORM trips this on its own source tree. It is reported, and
    // `surfacesOff` is how an account silences it — deliberately not a special case in the
    // matcher, which would make the behaviour invisible to the reader on screen.
    expect(surfacesForPath('drizzle-orm/src/pg-core/schema/index.ts')).toContain('db_schema');
  });
});
