// `anchorLineFromHunk` — reconstructing a review thread's original line from its anchor hunk.
//
// WHY IT EXISTS AT ALL. `review_threads` stores exactly ONE positional column, `line`, and that is
// GitHub's LIVE line: it goes NULL the moment the anchor drifts out of the current diff. There is
// no `original_line`, no `start_line` and no `diff_side` column, and the sync's GraphQL walk never
// selects them. Measured on the dev DB: `line` is NULL for 5,572 of 6,195 outdated threads (90%),
// while a NON-outdated thread always has one. So for the threads where "jump to the code" is
// hardest, the stored data offers nothing at all and this is the only source.
//
// The trick is GitHub's `diffHunk` convention: the hunk ENDS at the commented line. The codebase
// already relies on it — `CodeAnchor` renders `lines.at(-1)` as THE anchored line — so parsing the
// hunk and taking its last real row recovers the original line and its side.
//
// ⚠ APPROXIMATE ON PURPOSE. This is the line in the commit the comment was WRITTEN against, not in
// the PR's current head, which is why the UI hedges the label ("~") and why a non-null
// `thread.line` must always win over it. Spot-checked against 25 live non-outdated threads: 23
// matched the stored line exactly, and the 2 that did not were genuine moved anchors (177 vs 181,
// 475 vs 477) — i.e. the disagreement is the drift the hedge exists for, not a parse bug.
//
// Run from the workspace that HAS vitest:
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import { anchorLineFromHunk } from '../src/lib/diff.js';

describe('anchorLineFromHunk', () => {
  // The ordinary case, and the one that matters: a hunk ending on an ADDED line. The anchor is
  // the last line, on the RIGHT (new) side — where GitHub pins an inline thread.
  it('takes the LAST added line, on the RIGHT side', () => {
    const hunk = [
      '@@ -40,6 +40,8 @@ impl Pipeline {',
      '     fn layout(&self) {',
      '         let x = 1;',
      '+        let y = 2;',
      '+        let z = 3;',
    ].join('\n');
    // newStart 40 → the two context rows are 40 and 41, so the additions are 42 and 43.
    expect(anchorLineFromHunk(hunk)).toEqual({ line: 43, side: 'RIGHT' });
  });

  // A hunk ending on a DELETION anchors to the OLD file — a right-side line number would point at
  // an unrelated line, since deletions consume no new-side number.
  it('takes a trailing deletion on the LEFT side', () => {
    const hunk = [
      '@@ -10,4 +10,3 @@',
      '     keep_this();',
      '-    remove_this();',
    ].join('\n');
    expect(anchorLineFromHunk(hunk)).toEqual({ line: 11, side: 'LEFT' });
  });

  // A pure-context tail (a comment on an unchanged line) exists on both sides; RIGHT is the side
  // GitHub anchors to, matching `anchorIndexFor`'s preference in FileDiffView.
  it('prefers RIGHT for a context tail, which exists on both sides', () => {
    const hunk = ['@@ -5,3 +7,3 @@', '     alpha();', '     beta();'].join('\n');
    expect(anchorLineFromHunk(hunk)).toEqual({ line: 8, side: 'RIGHT' });
  });

  // GitHub emits this marker after a final line with no newline. It is an annotation, consumes no
  // line number, and must not become the anchor — otherwise the jump lands one line late, or on
  // nothing at all.
  it('skips the "\\ No newline at end of file" marker', () => {
    const hunk = [
      '@@ -1,2 +1,2 @@',
      ' const a = 1;',
      '+const b = 2;',
      '\\ No newline at end of file',
    ].join('\n');
    expect(anchorLineFromHunk(hunk)).toEqual({ line: 2, side: 'RIGHT' });
  });

  // Multi-hunk anchors resolve against the LAST header's counters, not the first — getting this
  // wrong silently returns a plausible-but-wrong line, which is the worst failure mode here
  // (a confident jump to unrelated code reads as a bug in the thread, not in the link).
  it('uses the LAST hunk header’s counters', () => {
    const hunk = [
      '@@ -1,3 +1,3 @@',
      ' a();',
      ' b();',
      '@@ -100,3 +200,4 @@',
      '     c();',
      '+    d();',
    ].join('\n');
    expect(anchorLineFromHunk(hunk)).toEqual({ line: 201, side: 'RIGHT' });
  });

  // Every "there is nothing to point at" input yields null, so the caller falls to the next rung
  // (reveal the file) rather than jumping to line 0 or NaN. `diffHunk` is null for ~97% of stored
  // rows and arrives only via hydration, so this is the common path, not an edge case.
  it('returns null when there is no usable anchor', () => {
    expect(anchorLineFromHunk(null)).toBeNull();
    expect(anchorLineFromHunk(undefined)).toBeNull();
    expect(anchorLineFromHunk('')).toBeNull();
    // A header with no body: nothing was actually pointed at.
    expect(anchorLineFromHunk('@@ -1,0 +1,0 @@')).toBeNull();
    // Not a diff at all: no `@@` header means both counters stay at 0, and 0 is never a valid
    // diff line — a confident target matching no row is worse than no target. Must also not
    // throw: there is no error boundary in this app.
    expect(anchorLineFromHunk('just some prose')).toBeNull();
  });
});
