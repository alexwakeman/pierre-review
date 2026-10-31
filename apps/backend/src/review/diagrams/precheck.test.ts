// THE PRE-CHECK: a change with no data path gets no diagram, decided from the diff with no model.
import { describe, expect, it } from 'vitest';
import { codeSkeleton, diagramPrecheck } from './precheck.js';

const file = (path: string, removed: string[], added: string[]): string =>
  [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -1,3 +1,3 @@',
    ' context();',
    ...removed.map((l) => `-${l}`),
    ...added.map((l) => `+${l}`),
  ].join('\n');

const run = (files: Array<[string, string[], string[]]>, manual = false) =>
  diagramPrecheck({ changedFiles: files.map((f) => f[0]), diff: files.map((f) => file(...f)).join('\n') }, { manual });

describe('diagramPrecheck', () => {
  it('no code: docs, config and lockfiles only', () => {
    expect(diagramPrecheck({ changedFiles: ['README.md', 'pnpm-lock.yaml'], diff: null })).toBe('no_code');
    // ⚠ no_code holds on a reader's own Draw too.
    expect(diagramPrecheck({ changedFiles: ['docs/a.md'], diff: null }, { manual: true })).toBe('no_code');
  });

  it('tests only', () => {
    expect(run([['src/rates.test.ts', ['expect(a).toBe(1);'], ['expect(a).toBe(2);']]])).toBe('tests_only');
  });

  it('copy only: string literals and JSX text, line for line', () => {
    expect(
      run([
        ['src/Page.tsx', ['  <p className="x">Open the pull request</p>', "  const title = 'Old words';", '  Click a card to open it.'], ['  <p className="x">Open this pull request</p>', "  const title = 'New words';", '  Click a step to open its file.']],
      ]),
    ).toBe('copy_only');
  });

  it('a changed query or route string is data access, not copy', () => {
    expect(
      run([
        ['src/db.ts', ['  db.prepare("SELECT id FROM orders WHERE x = 1");', '  a();', '  b();', '  c();'], ['  db.prepare("SELECT id FROM refunds WHERE x = 1");', '  a();', '  b();', '  c();']],
      ]),
    ).toBeNull();
  });

  it('an expression continuation or a multi-line query line is code, not prose', () => {
    expect(codeSkeleton('  price * qty')).toBe('price * qty');
    expect(codeSkeleton('  isOpen && hasRows')).toBe('isOpen && hasRows');
    expect(codeSkeleton('  FROM orders o')).toBe('FROM orders o');
    expect(codeSkeleton('  from refunds r')).toBe('from refunds r');
    // Still prose: JSX text on its own line.
    expect(codeSkeleton('  Open the pull request to see its steps.')).toBe('');
    const lines = ['  a();', '  b();', '  c();'];
    expect(run([['src/q.ts', ['    FROM orders o', ...lines], ['    FROM refunds o', ...lines]]])).toBeNull();
    expect(run([['src/q.ts', ['    price * qty', ...lines], ['    price * qty * rate', ...lines]]])).toBeNull();
  });

  it('too small: fewer than four changed code lines (comments and blanks aside)', () => {
    expect(run([['src/a.ts', ['  return a + 1;'], ['  return a + 2;', '  // why', '']]])).toBe('too_small');
    expect(run([['src/a.ts', ['// old comment'], ['// new comment']]])).toBe('too_small');
  });

  it('a real change is drawn; a manual Draw skips the soft checks', () => {
    const real: Array<[string, string[], string[]]> = [
      ['src/orders.ts', ['  const rows = await read();'], ['  const rows = await read(account);', '  if (rows.length === 0) return [];', '  await write(rows);', '  emit(rows);']],
    ];
    expect(run(real)).toBeNull();
    expect(run([['src/rates.test.ts', ['a();'], ['b();']]], true)).toBeNull();
    expect(run([['src/a.ts', ["const t = 'a';"], ["const t = 'b';"]]], true)).toBeNull();
  });

  it('an unreadable diff runs only the file-list checks', () => {
    expect(diagramPrecheck({ changedFiles: ['src/a.ts'], diff: null })).toBeNull();
  });

  it('codeSkeleton keeps code and template holes, drops words', () => {
    expect(codeSkeleton('const x = `Hello ${name}!`;')).toBe('const x = `${name}`;');
    expect(codeSkeleton('Some words on their own line')).toBe('');
    expect(codeSkeleton('return total')).toBe('return total');
  });
});
