import { describe, expect, it } from 'vitest';
import { splitDiffByFile } from '../review/post-review.js';
import { filesToUnifiedDiff } from './mutations.js';

// filesToUnifiedDiff is the fallback that rebuilds a unified diff from GitHub's per-file
// /files endpoint when the whole-PR .diff media type 406s (>20,000 lines). The output must
// stay splittable by the same per-file logic capDiff uses, so a huge PR still yields a
// grounded (non-empty) AI summary instead of "the diff is empty".

describe('filesToUnifiedDiff', () => {
  it('emits a diff --git header + hunks for a file WITH a patch', () => {
    const out = filesToUnifiedDiff([
      {
        filename: 'app/routes.js',
        status: 'modified',
        additions: 2,
        deletions: 0,
        patch: "@@ -1,3 +1,5 @@\n a\n+b\n+c\n d",
      },
    ]);
    expect(out).toContain('diff --git a/app/routes.js b/app/routes.js');
    expect(out).toContain('--- a/app/routes.js');
    expect(out).toContain('+++ b/app/routes.js');
    expect(out).toContain('+b');
  });

  it('NAMES a file whose patch is omitted (binary / too large) with its churn', () => {
    const out = filesToUnifiedDiff([
      {
        filename: 'tools/styles/Habitats.qml',
        status: 'added',
        additions: 8431,
        deletions: 0,
        // no patch — GitHub omits it for a single file that is itself too large
      },
    ]);
    expect(out).toContain('diff --git a/tools/styles/Habitats.qml b/tools/styles/Habitats.qml');
    expect(out).toContain('diff not shown');
    expect(out).toContain('+8431/-0');
  });

  it('uses previous_filename for the a/ side of a rename', () => {
    const out = filesToUnifiedDiff([
      {
        filename: 'app/routes/ukhab.js',
        previous_filename: 'app/routes/old.js',
        status: 'renamed',
        additions: 1,
        deletions: 1,
        patch: '@@ -1 +1 @@\n-old\n+new',
      },
    ]);
    expect(out).toContain('diff --git a/app/routes/old.js b/app/routes/ukhab.js');
  });

  it('produces output splittable per-file (capDiff can attribute/omit whole files)', () => {
    const out = filesToUnifiedDiff([
      { filename: 'a.js', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1 +1,2 @@\n x\n+y' },
      { filename: 'data/big.json', status: 'added', additions: 90000, deletions: 0 },
      { filename: 'b.ts', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1 +1,2 @@\n p\n+q' },
    ]);
    const files = splitDiffByFile(out);
    expect(files.map((f) => f.path)).toEqual(['a.js', 'data/big.json', 'b.ts']);
  });

  it('is empty for no files (a genuinely empty change)', () => {
    expect(filesToUnifiedDiff([])).toBe('');
  });
});
