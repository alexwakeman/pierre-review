import { describe, expect, it } from 'vitest';
import type { ClaudeFinding } from '@pierre-review/shared';
import {
  buildAnchorIndex,
  buildReview,
  extractHunk,
  fallbackAnchor,
  findingCommentBody,
  isFindingAnchored,
  splitDiffByFile,
  stripNoiseFromDiff,
} from './post-review.js';

// A small but realistic single-file unified diff. The hunk header
// `@@ -10,3 +10,4 @@` means: old file starts at line 10 (3 lines), new file
// starts at line 10 (4 lines). Walking the body:
//   line 10 ` const a = 1;`  context → old 10, new 10
//   line 11 `+const added = 2;` added  → new 11
//   line 11 `-const removed = 3;` removed → old 11
//   line 12 ` const b = 4;`  context → old 12, new 12
const FOO_DIFF = [
  'diff --git a/src/foo.ts b/src/foo.ts',
  'index 1111111..2222222 100644',
  '--- a/src/foo.ts',
  '+++ b/src/foo.ts',
  '@@ -10,3 +10,4 @@',
  ' const a = 1;',
  '+const added = 2;',
  '-const removed = 3;',
  ' const b = 4;',
].join('\n');

// A two-file diff: a kept source file and a lockfile that a noise predicate
// should strip.
const TWO_FILE_DIFF = [
  'diff --git a/src/foo.ts b/src/foo.ts',
  'index 1111111..2222222 100644',
  '--- a/src/foo.ts',
  '+++ b/src/foo.ts',
  '@@ -10,3 +10,4 @@',
  ' const a = 1;',
  '+const added = 2;',
  '-const removed = 3;',
  ' const b = 4;',
  'diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml',
  'index 3333333..4444444 100644',
  '--- a/pnpm-lock.yaml',
  '+++ b/pnpm-lock.yaml',
  '@@ -1,2 +1,3 @@',
  ' lockfileVersion: 9.0',
  '+  newdep: 1.0.0',
].join('\n');

// A minimal ClaudeFinding factory. Only the fields buildReview actually reads
// (id, path, line, side, title, body, suggestion) need to be meaningful; the
// rest are filled with inert defaults and the whole thing is cast.
function makeFinding(overrides: Partial<ClaudeFinding>): ClaudeFinding {
  return {
    id: 1,
    reviewId: 1,
    path: 'src/foo.ts',
    line: null,
    side: 'RIGHT',
    diffAnchorId: 'deadbeef',
    severity: 'warning',
    title: 'A finding',
    body: 'finding body',
    editedBody: null,
    suggestion: null,
    diffHunk: null,
    anchored: false,
    included: true,
    postedAt: null,
    githubCommentId: null,
    createdAt: '2026-06-04T00:00:00.000Z',
    ...overrides,
  } as ClaudeFinding;
}

describe('buildAnchorIndex', () => {
  it('records new-side line numbers in .right and old-side in .left', () => {
    const index = buildAnchorIndex(FOO_DIFF);
    const anchors = index.get('src/foo.ts');
    expect(anchors).toBeDefined();
    if (!anchors) return;

    // RIGHT (new file): context 10, added 11, context 12.
    expect([...anchors.right].sort((a, b) => a - b)).toEqual([10, 11, 12]);
    // LEFT (old file): context 10, removed 11, context 12.
    expect([...anchors.left].sort((a, b) => a - b)).toEqual([10, 11, 12]);
  });

  it('puts a purely-added line only on the right side', () => {
    // A pure addition (no deletion sharing the number): new-line 11 has no
    // counterpart in the old file, so it lands on the right only.
    const diff = [
      'diff --git a/src/foo.ts b/src/foo.ts',
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -10,1 +10,2 @@',
      ' const a = 1;',
      '+const added = 2;',
    ].join('\n');
    const anchors = buildAnchorIndex(diff).get('src/foo.ts');
    expect(anchors?.right.has(11)).toBe(true); // the `+const added` line
    expect(anchors?.left.has(11)).toBe(false); // old file has no line 11
  });

  it('puts deleted lines only on the left side', () => {
    const anchors = buildAnchorIndex(FOO_DIFF).get('src/foo.ts');
    expect(anchors?.left.has(11)).toBe(true); // the `-const removed` line
    // line 11 also exists on the right, but as the *added* line, not the removed.
    // The removed line's old-file number (11) is left-only addressable on left.
    expect(anchors?.right.has(11)).toBe(true); // (it's the added line)
  });

  it('puts context lines on both sides', () => {
    const anchors = buildAnchorIndex(FOO_DIFF).get('src/foo.ts');
    // Leading context line is line 10 on both sides.
    expect(anchors?.right.has(10)).toBe(true);
    expect(anchors?.left.has(10)).toBe(true);
    // Trailing context line is line 12 on both sides.
    expect(anchors?.right.has(12)).toBe(true);
    expect(anchors?.left.has(12)).toBe(true);
  });

  it('records the file first added (RIGHT) and removed (LEFT) line', () => {
    const anchors = buildAnchorIndex(FOO_DIFF).get('src/foo.ts');
    expect(anchors?.firstAdded).toBe(11); // `+const added = 2;` at new-line 11
    expect(anchors?.firstRemoved).toBe(11); // `-const removed = 3;` at old-line 11
  });
});

describe('fallbackAnchor', () => {
  it('prefers the file first added line (RIGHT)', () => {
    const index = buildAnchorIndex(FOO_DIFF);
    expect(fallbackAnchor(index, 'src/foo.ts')).toEqual({ line: 11, side: 'RIGHT' });
  });

  it('uses the first removed line (LEFT) for a pure-deletion file', () => {
    const diff = [
      'diff --git a/src/del.ts b/src/del.ts',
      '--- a/src/del.ts',
      '+++ b/src/del.ts',
      '@@ -20,2 +20,1 @@',
      ' const keep = 1;',
      '-const gone = 2;',
    ].join('\n');
    expect(fallbackAnchor(buildAnchorIndex(diff), 'src/del.ts')).toEqual({
      line: 21,
      side: 'LEFT',
    });
  });

  it('returns null when the file is not in the diff', () => {
    expect(fallbackAnchor(buildAnchorIndex(FOO_DIFF), 'src/absent.ts')).toBeNull();
  });
});

describe('isFindingAnchored', () => {
  const index = buildAnchorIndex(FOO_DIFF);

  it('is true for a line present on the relevant side', () => {
    expect(isFindingAnchored(index, 'src/foo.ts', 11, 'RIGHT')).toBe(true); // added
    expect(isFindingAnchored(index, 'src/foo.ts', 11, 'LEFT')).toBe(true); // removed
    expect(isFindingAnchored(index, 'src/foo.ts', 10, 'RIGHT')).toBe(true); // context
    expect(isFindingAnchored(index, 'src/foo.ts', 10, 'LEFT')).toBe(true); // context
  });

  it('is false when the line is null', () => {
    expect(isFindingAnchored(index, 'src/foo.ts', null, 'RIGHT')).toBe(false);
  });

  it('is false when the path is unknown', () => {
    expect(isFindingAnchored(index, 'src/unknown.ts', 10, 'RIGHT')).toBe(false);
  });

  it('is false when the line is not addable on that side', () => {
    // A line well outside the hunk is on neither side.
    expect(isFindingAnchored(index, 'src/foo.ts', 999, 'RIGHT')).toBe(false);
    expect(isFindingAnchored(index, 'src/foo.ts', 999, 'LEFT')).toBe(false);
  });
});

describe('stripNoiseFromDiff', () => {
  it('drops files matched by the predicate and reports their paths', () => {
    const { diff, excluded } = stripNoiseFromDiff(TWO_FILE_DIFF, (p) =>
      p.endsWith('.lock') || p.endsWith('lock.yaml'),
    );
    expect(excluded).toEqual(['pnpm-lock.yaml']);
    // Kept segment still contains the source file...
    expect(diff).toContain('diff --git a/src/foo.ts b/src/foo.ts');
    expect(diff).toContain('+const added = 2;');
    // ...and the lockfile is gone.
    expect(diff).not.toContain('pnpm-lock.yaml');
    expect(diff).not.toContain('newdep: 1.0.0');
  });

  it('keeps everything when nothing matches', () => {
    const { diff, excluded } = stripNoiseFromDiff(TWO_FILE_DIFF, (p) =>
      p.endsWith('.never'),
    );
    expect(excluded).toEqual([]);
    expect(diff).toContain('src/foo.ts');
    expect(diff).toContain('pnpm-lock.yaml');
  });
});

describe('splitDiffByFile', () => {
  it('returns one segment per file with the new-side path', () => {
    const segments = splitDiffByFile(TWO_FILE_DIFF);
    expect(segments.map((s) => s.path)).toEqual(['src/foo.ts', 'pnpm-lock.yaml']);
    // Each segment starts at its own `diff --git` header and carries its body.
    expect(segments[0]?.text.startsWith('diff --git a/src/foo.ts')).toBe(true);
    expect(segments[0]?.text).toContain('+const added = 2;');
    expect(segments[1]?.text.startsWith('diff --git a/pnpm-lock.yaml')).toBe(true);
    expect(segments[1]?.text).toContain('newdep: 1.0.0');
  });
});

describe('buildReview', () => {
  // line 11 RIGHT is the added line → anchorable.
  const anchorable = makeFinding({
    id: 101,
    path: 'src/foo.ts',
    line: 11,
    side: 'RIGHT',
    title: 'Anchorable finding',
    body: 'This added line is wrong.',
    suggestion: 'const added = 22;',
  });
  // line 500 RIGHT isn't in the diff, but the FILE is → re-anchored to the file's
  // first added line (11, RIGHT) rather than skipped.
  const offDiffLine = makeFinding({
    id: 202,
    path: 'src/foo.ts',
    line: 500,
    side: 'RIGHT',
    title: 'Off-diff-line finding',
    body: 'This line is not in the diff.',
    suggestion: null,
  });
  // A finding whose FILE isn't in the diff at all → nothing to anchor onto → skip.
  const fileNotInDiff = makeFinding({
    id: 303,
    path: 'src/absent.ts',
    line: 7,
    side: 'RIGHT',
    title: 'File-not-in-diff finding',
    body: 'This whole file is untouched by the PR.',
    suggestion: null,
  });

  const built = buildReview({
    commitId: 'abcdef0',
    body: 'Overall review body.',
    event: 'COMMENT',
    includedFindings: [anchorable, offDiffLine, fileNotInDiff],
    diff: FOO_DIFF,
  });

  it('posts the directly-anchorable finding on its own line', () => {
    const comment = built.preview.comments.find((c) => c.body.includes('wrong.'));
    expect(comment?.path).toBe('src/foo.ts');
    expect(comment?.line).toBe(11);
    expect(comment?.side).toBe('RIGHT');
  });

  it('appends the suggestion as a fenced ```suggestion block', () => {
    const body = built.preview.comments.find((c) => c.body.includes('wrong.'))?.body ?? '';
    expect(body).toContain('This added line is wrong.');
    expect(body).toContain('```suggestion\nconst added = 22;\n```');
  });

  it('re-anchors an off-diff-line finding to the file first change + notes it', () => {
    const comment = built.preview.comments.find((c) =>
      c.body.includes('not in the diff'),
    );
    expect(comment).toBeDefined();
    // First added line of src/foo.ts is 11, RIGHT.
    expect(comment?.line).toBe(11);
    expect(comment?.side).toBe('RIGHT');
    expect(comment?.body).toContain('first change');
  });

  it('posts a finding whose file is not in the diff as a PR-level comment', () => {
    expect(built.preview.prComments).toHaveLength(1);
    const pc = built.preview.prComments[0];
    expect(pc?.findingId).toBe(303);
    expect(pc?.path).toBe('src/absent.ts');
    // The PR-level body carries the file ref + the outside-the-diff note.
    expect(pc?.body).toContain('src/absent.ts');
    expect(pc?.body).toContain('This whole file is untouched');
    expect(pc?.body).toContain('part of this PR');
  });

  it('returns inlineFindingIds for the directly + fallback anchored findings', () => {
    expect(built.inlineFindingIds).toEqual([101, 202]);
  });

  it('prefers the first added line, falling back to the first removed line', () => {
    // A pure-deletion file: no added lines, so the fallback is the first `-` line.
    const deletionDiff = [
      'diff --git a/src/del.ts b/src/del.ts',
      '--- a/src/del.ts',
      '+++ b/src/del.ts',
      '@@ -20,2 +20,1 @@',
      ' const keep = 1;',
      '-const gone = 2;',
    ].join('\n');
    const f = makeFinding({ id: 909, path: 'src/del.ts', line: 999, side: 'RIGHT' });
    const result = buildReview({
      commitId: 'abcdef0',
      body: 'b',
      event: 'COMMENT',
      includedFindings: [f],
      diff: deletionDiff,
    });
    // First removed line of src/del.ts is old-line 21, LEFT.
    expect(result.preview.comments[0]?.line).toBe(21);
    expect(result.preview.comments[0]?.side).toBe('LEFT');
  });

  it('renders a fallback finding suggestion as a plain (non-applyable) block', () => {
    const f = makeFinding({
      id: 910,
      path: 'src/foo.ts',
      line: 777,
      side: 'RIGHT',
      body: 'Off-diff with a suggestion.',
      suggestion: 'const fixed = 1;',
    });
    const result = buildReview({
      commitId: 'abcdef0',
      body: 'b',
      event: 'COMMENT',
      includedFindings: [f],
      diff: FOO_DIFF,
    });
    const body = result.preview.comments[0]?.body ?? '';
    // Plain ``` fence, NOT an applyable ```suggestion on the wrong line.
    expect(body).toContain('```\nconst fixed = 1;\n```');
    expect(body).not.toContain('```suggestion');
  });

  it('carries the authored body/event/commitId onto the preview', () => {
    expect(built.preview.commitId).toBe('abcdef0');
    expect(built.preview.body).toBe('Overall review body.');
    expect(built.preview.event).toBe('COMMENT');
  });

  it('omits the suggestion block when a finding has no suggestion', () => {
    const noSuggestion = makeFinding({
      id: 303,
      path: 'src/foo.ts',
      line: 10,
      side: 'RIGHT',
      body: 'Plain body, no suggestion.',
      suggestion: null,
    });
    const result = buildReview({
      commitId: 'abcdef0',
      body: 'b',
      event: 'COMMENT',
      includedFindings: [noSuggestion],
      diff: FOO_DIFF,
    });
    expect(result.preview.comments[0]?.body).toBe('Plain body, no suggestion.');
    expect(result.preview.comments[0]?.body).not.toContain('```suggestion');
  });

  it('posts the reworded editedBody instead of Claude body when present', () => {
    const reworded = makeFinding({
      id: 404,
      path: 'src/foo.ts',
      line: 11,
      side: 'RIGHT',
      body: "Claude's original wording.",
      editedBody: 'My reworded comment.',
      suggestion: null,
    });
    const result = buildReview({
      commitId: 'abcdef0',
      body: 'b',
      event: 'COMMENT',
      includedFindings: [reworded],
      diff: FOO_DIFF,
    });
    expect(result.preview.comments[0]?.body).toBe('My reworded comment.');
    expect(result.preview.comments[0]?.body).not.toContain('original wording');
  });

  it('falls back to Claude body when editedBody is empty/whitespace', () => {
    const blank = makeFinding({
      id: 505,
      path: 'src/foo.ts',
      line: 11,
      side: 'RIGHT',
      body: 'Claude body.',
      editedBody: '   ',
      suggestion: null,
    });
    const result = buildReview({
      commitId: 'abcdef0',
      body: 'b',
      event: 'COMMENT',
      includedFindings: [blank],
      diff: FOO_DIFF,
    });
    expect(result.preview.comments[0]?.body).toBe('Claude body.');
  });
});

describe('findingCommentBody', () => {
  it('uses Claude body, appending a suggestion block when present', () => {
    expect(
      findingCommentBody({ body: 'B', editedBody: null, suggestion: 'S' }),
    ).toBe('B\n\n```suggestion\nS\n```');
    expect(
      findingCommentBody({ body: 'B', editedBody: null, suggestion: null }),
    ).toBe('B');
  });

  it('prefers a non-empty editedBody over Claude body', () => {
    expect(
      findingCommentBody({ body: 'B', editedBody: 'Mine', suggestion: null }),
    ).toBe('Mine');
    expect(
      findingCommentBody({ body: 'B', editedBody: '   ', suggestion: null }),
    ).toBe('B');
  });

  it('appends the fallback note and plainly fences a suggestion on a fallback', () => {
    const out = findingCommentBody(
      { body: 'B', editedBody: null, suggestion: 'S' },
      { fallbackNote: true },
    );
    expect(out).toContain('B');
    // Plain fence, not an applyable ```suggestion (it would target the wrong line).
    expect(out).toContain('```\nS\n```');
    expect(out).not.toContain('```suggestion');
    expect(out).toContain('first change'); // FALLBACK_ANCHOR_NOTE
  });

  it('appends the fallback note even without a suggestion', () => {
    const out = findingCommentBody(
      { body: 'B', editedBody: null, suggestion: null },
      { fallbackNote: true },
    );
    expect(out.startsWith('B')).toBe(true);
    expect(out).toContain('first change');
  });
});

describe('extractHunk', () => {
  it('returns a window of diff lines around the target line with the hunk header', () => {
    const hunk = extractHunk(FOO_DIFF, 'src/foo.ts', 11, 'RIGHT');
    expect(hunk).not.toBeNull();
    expect(hunk).toContain('@@ -10,3 +10,4 @@');
    expect(hunk).toContain('+const added = 2;');
  });

  it('returns null for a line not in the diff', () => {
    expect(extractHunk(FOO_DIFF, 'src/foo.ts', 999, 'RIGHT')).toBeNull();
  });

  it('returns null for a null line or unknown path', () => {
    expect(extractHunk(FOO_DIFF, 'src/foo.ts', null, 'RIGHT')).toBeNull();
    expect(extractHunk(FOO_DIFF, 'src/nope.ts', 11, 'RIGHT')).toBeNull();
  });
});
