// THE PLAN PANEL'S LINE DIFF (lib/textDiff.ts): "What changes" under each ticket box.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/textDiff.test.ts
import { describe, expect, it } from 'vitest';
import { changedRanges, lineDiff, lineDiffSummary } from '../src/lib/textDiff.js';

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

describe('changedRanges (the washed words in a ticket box)', () => {
  const marked = (before: string, after: string): string[] => changedRanges(before, after).map((r) => after.slice(r.start, r.end));

  it('marks nothing when nothing changed', () => {
    expect(changedRanges('a\nb', 'a\nb')).toEqual([]);
  });

  it('marks only the changed words of a changed line, as one phrase', () => {
    expect(marked('Intro\nThe user can log in.\nEnd', 'Intro\nThe user can log in with SSO today.\nEnd')).toEqual([
      'in with SSO today.',
    ]);
  });

  it('marks a new line whole, at the right offset', () => {
    const after = 'A\nB\nC new line\nD';
    expect(marked('A\nB\nD', after)).toEqual(['C new line']);
  });

  it('a removal marks nothing; a later change is still found at its offset', () => {
    expect(marked('one\ntwo\nthree\nfour', 'one\nthree\nfour!')).toEqual(['four!']);
  });

  it('joins changed words across an unchanged space into one wash', () => {
    expect(marked('GIVEN a report with rows', 'GIVEN a report with more than 500 rows')).toEqual(['more than 500']);
  });

  it('a new list of lines is marked line by line, never the newline', () => {
    expect(marked('', '- a b\n- c')).toEqual(['- a b', '- c']);
  });
});
