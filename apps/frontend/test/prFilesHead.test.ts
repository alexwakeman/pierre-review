// The Changes tab's diff FOLLOWS THE PR'S HEAD.
//
// `['pr-files', id]` is `staleTime: Infinity` and persisted to IndexedDB, and nothing else ever
// refetches it — so after the conflict resolver, AI Fix or Update branch pushed, the tab showed the
// pre-push patches for the whole session while the header moved on. The server now says which
// stored head a diff was read at (`PrFilesResponse.headSha`), and `usePrFiles` refetches the diff
// when a PR detail read AFTER it names a different head. What is pinned here:
//
//   • `prFilesOutdated` — the decision, including the time test that makes it settle (the diff's
//     head is the DATABASE's at its read, and GitHub can be a push ahead of it, so comparing heads
//     alone would refetch forever).
//   • A source guard that `usePrFiles` really applies it, to its own key, once per detail read.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { prFilesOutdated } from '../src/hooks/usePr.js';

describe('prFilesOutdated', () => {
  it('refetches when a NEWER detail names another head (the push case)', () => {
    expect(prFilesOutdated({ headSha: 'old', at: 100 }, { headSha: 'new', at: 200 })).toBe(true);
  });

  it('leaves the diff alone when the heads agree', () => {
    expect(prFilesOutdated({ headSha: 'same', at: 100 }, { headSha: 'same', at: 200 })).toBe(false);
  });

  it('never fires while the diff is the newer read — which is what makes it settle', () => {
    // The diff was refetched after the detail (or GitHub was a push ahead of the database): the
    // heads may differ, but only a later detail read can say the diff is old.
    expect(prFilesOutdated({ headSha: 'a', at: 300 }, { headSha: 'b', at: 200 })).toBe(false);
    expect(prFilesOutdated({ headSha: 'a', at: 200 }, { headSha: 'b', at: 200 })).toBe(false);
  });

  it('converges: one refetch per detail read, then quiet until the detail moves again', () => {
    let files = { headSha: 'h1', at: 10 };
    const detail = { headSha: 'h2', at: 20 };
    let refetches = 0;
    for (let tick = 0; tick < 5; tick++) {
      if (prFilesOutdated(files, detail)) {
        refetches += 1;
        // The refetch answers with whatever the database holds now — here still a head behind
        // GitHub's, the worst case for a heads-only rule.
        files = { headSha: 'h1-db-lag', at: 30 + tick };
      }
    }
    expect(refetches).toBe(1);
  });

  it('refetches a diff with no head once a newer detail has one (failed read, or cached before the field)', () => {
    expect(prFilesOutdated({ headSha: null, at: 100 }, { headSha: 'h', at: 200 })).toBe(true);
    expect(prFilesOutdated({ at: 100 }, { headSha: 'h', at: 200 })).toBe(true);
  });

  it('says nothing when the detail has no head', () => {
    expect(prFilesOutdated({ headSha: 'h', at: 100 }, { headSha: null, at: 200 })).toBe(false);
    expect(prFilesOutdated({ headSha: null, at: 100 }, { headSha: null, at: 200 })).toBe(false);
  });
});

describe('usePrFiles applies it (source guard)', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../src/hooks/usePr.ts', import.meta.url)),
    'utf8',
  );
  // The hook's own body, up to the next top-level declaration.
  const start = src.indexOf('export function usePrFiles(');
  const end = src.indexOf('\nexport ', start + 1);
  const body = src.slice(start, end === -1 ? undefined : end);

  it('decides with prFilesOutdated over the detail it observes', () => {
    expect(start).toBeGreaterThan(-1);
    expect(body).toMatch(/prFilesOutdated\(/);
    expect(body).toMatch(/usePr\(id\)/);
  });

  it('refetches ITS OWN key, exactly', () => {
    expect(body).toMatch(/invalidateQueries\(\{\s*queryKey:\s*\['pr-files',\s*id\],\s*exact:\s*true\s*\}\)/);
  });

  it('fires once per detail read, so a failing refetch cannot loop', () => {
    expect(body).toMatch(/firedFor\.current === detailAt/);
    expect(body).toMatch(/firedFor\.current = detailAt/);
  });
});
