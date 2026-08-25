// The Changes tab's navigation rail is built from `buildFileTree`, and its "reveal this
// line" jump from `lineRowIndex`. Both are pure so they can be pinned here; the components
// over them are not testable in this suite (vitest.config pins `test/**/*.test.ts`, no JSX).
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import { buildFileTree, lineRowIndex, parsePatch, type FileTreeEntry } from '../src/lib/diff.js';

function entry(path: string, additions = 1, deletions = 0): FileTreeEntry {
  return { path, additions, deletions, status: 'modified' };
}

describe('buildFileTree', () => {
  it('collapses single-child directory chains into one row', () => {
    const tree = buildFileTree([entry('apps/frontend/src/main.tsx')]);
    expect(tree).toHaveLength(1);
    expect(tree[0]?.kind).toBe('dir');
    expect(tree[0]?.name).toBe('apps/frontend/src');
    expect(tree[0]?.path).toBe('apps/frontend/src');
    expect(tree[0]?.children.map((c) => c.name)).toEqual(['main.tsx']);
  });

  it('stops collapsing at the first branch', () => {
    const tree = buildFileTree([
      entry('src/api/routes/prs.ts'),
      entry('src/db/queries.ts'),
    ]);
    expect(tree.map((n) => n.name)).toEqual(['src']);
    const src = tree[0];
    expect(src?.children.map((c) => c.name)).toEqual(['api/routes', 'db']);
    expect(src?.children[0]?.children.map((c) => c.name)).toEqual(['prs.ts']);
  });

  it('puts directories before files and sorts each level', () => {
    const tree = buildFileTree([
      entry('zeta.ts'),
      entry('README.md'),
      entry('src/a.ts'),
      entry('lib/b.ts'),
    ]);
    expect(tree.map((n) => `${n.kind}:${n.name}`)).toEqual([
      'dir:lib',
      'dir:src',
      'file:README.md',
      'file:zeta.ts',
    ]);
  });

  it('handles a path with no slash', () => {
    const tree = buildFileTree([entry('package.json')]);
    expect(tree).toHaveLength(1);
    expect(tree[0]?.kind).toBe('file');
    expect(tree[0]?.path).toBe('package.json');
  });

  it('rolls up file counts and line counts onto directories', () => {
    const tree = buildFileTree([
      entry('src/a.ts', 3, 1),
      entry('src/nested/b.ts', 5, 2),
    ]);
    const src = tree[0];
    expect(src?.fileCount).toBe(2);
    expect(src?.additions).toBe(8);
    expect(src?.deletions).toBe(3);
  });

  it('keys a renamed file on its NEW path (previousPath is display-only)', () => {
    const tree = buildFileTree([
      { path: 'src/new.ts', previousPath: 'src/old.ts', additions: 0, deletions: 0, status: 'renamed' },
    ]);
    expect(tree[0]?.children.map((c) => c.path)).toEqual(['src/new.ts']);
    expect(tree[0]?.children[0]?.entry?.previousPath).toBe('src/old.ts');
  });

  it('rolls up per-state thread counts onto directories; entries without counts read as zero', () => {
    const counts = (untouched: number, resolved: number) => ({
      untouched,
      replied_unresolved: 0,
      likely_addressed: 0,
      resolved,
    });
    const tree = buildFileTree([
      { ...entry('src/a.ts'), threadCounts: counts(2, 1) },
      { ...entry('src/nested/b.ts'), threadCounts: counts(0, 3) },
      // No threadCounts at all (the AI-Fix changeset / metadata fallback shape) — must
      // contribute zeros, not poison the rollup.
      entry('src/c.ts'),
    ]);
    const src = tree[0];
    expect(src?.threadCounts).toEqual(counts(2, 4));
    // The nested dir carries only its own subtree.
    const nested = src?.children.find((c) => c.kind === 'dir');
    expect(nested?.threadCounts).toEqual(counts(0, 3));
    // File nodes carry their entry's counts; a count-less entry reads all-zero.
    const a = src?.children.find((n) => n.path === 'src/a.ts');
    expect(a?.threadCounts).toEqual(counts(2, 1));
    const countless = src?.children.find((n) => n.path === 'src/c.ts');
    expect(countless?.threadCounts).toEqual(counts(0, 0));
  });

  it('is empty for an empty file list', () => {
    expect(buildFileTree([])).toEqual([]);
  });
});

const PATCH = [
  '@@ -10,4 +10,5 @@',
  ' context-a',
  '-removed-line',
  '+added-one',
  '+added-two',
  ' context-b',
].join('\n');

describe('lineRowIndex', () => {
  const rows = parsePatch(PATCH);

  it('matches an added line on the RIGHT side', () => {
    const i = lineRowIndex(rows, 12, 'RIGHT');
    expect(i).not.toBeNull();
    expect(rows[i as number]?.text).toBe('+added-two');
  });

  it('matches a removed line on the LEFT side', () => {
    const i = lineRowIndex(rows, 11, 'LEFT');
    expect(i).not.toBeNull();
    expect(rows[i as number]?.text).toBe('-removed-line');
  });

  it('matches a CONTEXT line on the LEFT side — the case commentTarget cannot serve', () => {
    // Context row `context-a` is old line 10 and new line 10. commentTarget() maps every
    // context row to RIGHT, so reusing it here would lose every LEFT-side target.
    const i = lineRowIndex(rows, 10, 'LEFT');
    expect(i).not.toBeNull();
    expect(rows[i as number]?.text).toBe(' context-a');
  });

  it('returns null when the line is not in the patch', () => {
    expect(lineRowIndex(rows, 999, 'RIGHT')).toBeNull();
    expect(lineRowIndex([], 1, 'RIGHT')).toBeNull();
  });
});
