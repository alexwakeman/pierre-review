import { describe, expect, it } from 'vitest';
import { SPRINT_WRITE_TEXT_MAX } from '@pierre-review/shared';
import { validateWriteText } from './validate.js';

describe('validateWriteText', () => {
  it('trims and accepts ordinary text, including a valid surrogate pair', () => {
    expect(validateWriteText('  hello 😀 \n')).toEqual({ ok: true, text: 'hello 😀' });
  });
  it.each([[undefined], [42], [''], ['   \n ']])('refuses %j', (v) => {
    expect(validateWriteText(v).ok).toBe(false);
  });
  it('refuses NUL', () => {
    expect(validateWriteText('a\u0000b').ok).toBe(false);
  });
  it('refuses a lone high surrogate and a lone low surrogate', () => {
    expect(validateWriteText('a\uD83Db').ok).toBe(false);
    expect(validateWriteText('a\uDE00b').ok).toBe(false);
    expect(validateWriteText('end\uD83D').ok).toBe(false);
    expect(validateWriteText('\uDE00start').ok).toBe(false);
  });
  it('the cap counts after trimming', () => {
    expect(validateWriteText('x'.repeat(SPRINT_WRITE_TEXT_MAX)).ok).toBe(true);
    expect(validateWriteText(` ${'x'.repeat(SPRINT_WRITE_TEXT_MAX)} `).ok).toBe(true);
    expect(validateWriteText('x'.repeat(SPRINT_WRITE_TEXT_MAX + 1)).ok).toBe(false);
  });
});
