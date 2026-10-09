// The monogram tile a bot card falls back to when it has no avatar.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import { monogramFor, monogramInk } from '../src/lib/botAvatar.js';
import { BOT_VENDOR_META, contrastRatio } from '../src/lib/ui.js';

describe('monogramInk', () => {
  it('picks white on dark and near-black on light', () => {
    expect(monogramInk('#000000')).toBe('#ffffff');
    expect(monogramInk('#ffffff')).toBe('#111827');
    expect(monogramInk('#fde047')).toBe('#111827');
  });

  it('falls back to white for a value it cannot measure', () => {
    expect(monogramInk('rgb(0 0 0)')).toBe('#ffffff');
  });

  // The better of white and near-black clears 3:1 (large-text AA, the monogram is bold) on every
  // vendor colour we ship.
  it('is legible on every vendor colour', () => {
    for (const meta of Object.values(BOT_VENDOR_META)) {
      const c = (meta as { color: string }).color;
      if (!/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c)) continue;
      expect(contrastRatio(monogramInk(c), c)).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('monogramFor', () => {
  it('takes the first letters of the first two words', () => {
    expect(monogramFor('CodeRabbit')).toBe('C');
    expect(monogramFor('copilot-pull-request-reviewer')).toBe('CP');
    expect(monogramFor('dependabot[bot]')).toBe('D');
    expect(monogramFor('Sonar Cloud')).toBe('SC');
    expect(monogramFor('')).toBe('?');
  });
});
