// THE PLAN PANEL'S LINE DIFF (lib/textDiff.ts): "What changes" under each ticket box.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/textDiff.test.ts
import { describe, expect, it } from 'vitest';
import { lineDiff, lineDiffSummary } from '../src/lib/textDiff.js';

describe('lineDiff', () => {
  it('equal texts are all "same", and summarise to null', () => {
    const d = lineDiff('a\nb', 'a\nb');
    expect(d.every((l) => l.kind === 'same')).toBe(true);
    expect(lineDiffSummary(d)).toBeNull();
  });

  it('keeps the common lines and marks what went and what came, in order', () => {
    expect(lineDiff('one\ntwo\nthree', 'one\n2\nthree\nfour')).toEqual([
      { kind: 'same', text: 'one' },
      { kind: 'del', text: 'two' },
      { kind: 'add', text: '2' },
      { kind: 'same', text: 'three' },
      { kind: 'add', text: 'four' },
    ]);
    expect(lineDiffSummary(lineDiff('one\ntwo\nthree', 'one\n2\nthree\nfour'))).toBe('2 lines added, 1 removed');
  });

  it('an empty current text: every line is added', () => {
    expect(lineDiffSummary(lineDiff('', 'a\nb'))).toBe('2 lines added');
    expect(lineDiff('x', '').map((l) => l.kind)).toEqual(['del']);
  });
});
