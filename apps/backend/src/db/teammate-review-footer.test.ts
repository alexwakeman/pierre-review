// A teammate's posted summary is shown without Limn's auto-post footer (db/teammate-reviews.ts).
import { describe, expect, it } from 'vitest';
import { AUTO_POST_FOOTER, PAIR_AUTO_POST_FOOTER, autoPostFooter } from '@pierre-review/shared';
import { withoutAutoPostFooter } from './teammate-reviews.js';

describe('withoutAutoPostFooter', () => {
  it('drops each footer Limn writes, and only at the end', () => {
    for (const footer of [AUTO_POST_FOOTER, PAIR_AUTO_POST_FOOTER, autoPostFooter('Codex')]) {
      expect(withoutAutoPostFooter(`Looks fine.\n\n${footer}`)).toBe('Looks fine.');
      expect(withoutAutoPostFooter(`Looks fine.\n\n${footer}\n`)).toBe('Looks fine.');
    }
    expect(withoutAutoPostFooter(AUTO_POST_FOOTER)).toBe('');
    expect(withoutAutoPostFooter(`${AUTO_POST_FOOTER}\n\nMore text.`)).toBe(`${AUTO_POST_FOOTER}\n\nMore text.`);
    expect(withoutAutoPostFooter('_A note in italics._')).toBe('_A note in italics._');
  });
});
