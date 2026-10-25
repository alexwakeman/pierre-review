import { describe, expect, it } from 'vitest';
import { compileGlob, compileLinearRegex, PatternError, workBudget } from './linear-regex.js';

const big = () => workBudget(1e9);
const t = (pattern: string, text: string, ignoreCase = false) => compileLinearRegex(pattern, { ignoreCase }).test(text, big());

describe('compileLinearRegex', () => {
  it('agrees with RegExp on the supported subset', () => {
    const cases: Array<[string, string[]]> = [
      ['foo', ['foo', 'a foo b', 'fo', '']],
      ['^foo$', ['foo', 'foo ', ' foo']],
      ['a.c', ['abc', 'ac', 'a\nc']],
      ['colou?r', ['color', 'colour', 'colouur']],
      ['ab*c', ['ac', 'abbbc', 'abd']],
      ['ab+c', ['ac', 'abc']],
      ['x{2,3}y', ['xy', 'xxy', 'xxxy', 'xxxxy']],
      ['x{2}', ['x', 'xx']],
      ['x{2,}$', ['x', 'xxxxx']],
      ['(cat|dog)s?', ['cats', 'dog', 'cow']],
      ['(?:ab)+$', ['ababab', 'ababa']],
      ['(?<name>q)z', ['qz', 'q']],
      ['[a-c]+\\d', ['abc1', 'abd', 'z9']],
      ['[^0-9]', ['123', '12a']],
      ['\\bword\\b', ['a word here', 'swordfish']],
      ['\\Bor\\B', ['word', 'or']],
      ['\\w+@\\w+\\.com', ['me@x.com', 'me@x.org']],
      ['\\s\\S', [' a', '  ']],
      ['a\\.b', ['a.b', 'axb']],
      ['[\\]x]', [']', 'x', 'y']],
      ['[a\\-z]', ['-', 'b']],
      ['\\x41\\u0042', ['AB', 'ab']],
      ['a{,2}', ['a{,2}', 'aa']],
      ['TODO|FIXME', ['// FIXME later', 'done']],
      ['', ['', 'x']],
    ];
    for (const [p, texts] of cases) {
      const re = new RegExp(p);
      for (const s of texts) expect(t(p, s), `${p} on ${JSON.stringify(s)}`).toBe(re.test(s));
    }
  });

  it('ignore_case', () => {
    expect(t('hello', 'HeLLo world', true)).toBe(true);
    expect(t('[a-c]x', 'BX', true)).toBe(true);
    expect(t('hello', 'HeLLo')).toBe(false);
  });

  it('runs catastrophic patterns in linear time', () => {
    const line = `${'a'.repeat(50_000)}b`;
    for (const p of ['(a+)+$', '(a|a)*c', '(a*)*$', '^(a|aa)+$', '(.*a){20}x']) {
      const started = Date.now();
      const r = compileLinearRegex(p).test(line, workBudget(1e9));
      expect(r).toBe(new RegExp(p).test('ab')); // shape check only on a tiny input
      expect(Date.now() - started).toBeLessThan(5000);
    }
  });

  it('stops when the work budget runs out', () => {
    const b = workBudget(1000);
    expect(compileLinearRegex('(.*a){20}x').test('a'.repeat(10_000), b)).toBe(false);
    expect(b.exhausted).toBe(true);
    expect(compileLinearRegex('a').test('a', b)).toBe(false); // an exhausted budget answers nothing
  });

  it('refuses what cannot run in linear time, in a sentence', () => {
    for (const p of ['(a)\\1', '(?=a)', '(?!a)', '(?<=a)b', '(?<!a)b', '\\k<n>']) {
      expect(() => compileLinearRegex(p), p).toThrow(PatternError);
    }
    for (const p of ['*a', '(a', 'a)', '[abc', 'a{5,2}', 'a{2000}', '\\', 'x'.repeat(1001)]) {
      expect(() => compileLinearRegex(p), p).toThrow(PatternError);
    }
  });

  it('caps the program size', () => {
    expect(() => compileLinearRegex('(((a{1000}){1000}){1000})')).toThrow(/too complex/);
  });
});

describe('compileGlob', () => {
  const g = (glob: string, path: string) => compileGlob(glob).test(path, big());
  it('matches like a shell glob', () => {
    expect(g('*.ts', 'a.ts')).toBe(true);
    expect(g('*.ts', 'src/a.ts')).toBe(false); // * never crosses /
    expect(g('src/**/*.ts', 'src/a.ts')).toBe(true); // **/ may match no directory
    expect(g('src/**/*.ts', 'src/x/y/a.ts')).toBe(true);
    expect(g('src/**/*.ts', 'lib/a.ts')).toBe(false);
    expect(g('**/*.test.ts', 'a/b/c.test.ts')).toBe(true);
    expect(g('**', 'a/b/c')).toBe(true);
    expect(g('?.md', 'a.md')).toBe(true);
    expect(g('?.md', 'ab.md')).toBe(false);
    expect(g('{src,lib}/*.js', 'lib/x.js')).toBe(true);
    expect(g('{src,lib}/*.js', 'test/x.js')).toBe(false);
    expect(g('*.{ts,tsx}', 'x.tsx')).toBe(true);
    expect(g('[!a]*.ts', 'b.ts')).toBe(true);
    expect(g('[!a]*.ts', 'a.ts')).toBe(false);
    expect(g('a+b(c).ts', 'a+b(c).ts')).toBe(true); // regex characters are literal
    expect(g('a.ts', 'abts')).toBe(false);
  });
  it('is linear on hostile globs', () => {
    const started = Date.now();
    expect(g('*a*a*a*a*a*a*a*a*a*b', 'a'.repeat(5000))).toBe(false);
    expect(Date.now() - started).toBeLessThan(5000);
  });
  it('refuses an unclosed brace', () => {
    expect(() => compileGlob('{a,b')).toThrow(PatternError);
  });
});
