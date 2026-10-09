// The fallback tile a bot card shows when it has no avatar (or the image fails to load): the
// bot's initial(s) on its vendor colour. Pure, so the contrast decision is testable.
import { contrastRatio } from './ui.js';

const LIGHT = '#ffffff';
const DARK = '#111827';

/**
 * The text colour for a monogram on `bg`: white or near-black, whichever contrasts more.
 *
 * The tile's ground is the raw vendor hex — a NON-TEXT use, which is allowed — so the text on it
 * must be picked against that ground, never be the brand colour itself. A value that is not a
 * plain hex (nothing we can measure) gets white, the answer for the dark brand colours that
 * dominate `BOT_VENDOR_META`.
 */
export function monogramInk(bg: string): string {
  if (!/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(bg)) return LIGHT;
  return contrastRatio(LIGHT, bg) >= contrastRatio(DARK, bg) ? LIGHT : DARK;
}

/** One or two letters for the tile: the first letters of the first two words, else the first. */
export function monogramFor(name: string): string {
  const words = name
    .replace(/\[bot\]$/i, '')
    .split(/[\s_\-./]+/)
    .filter((w) => /[a-z0-9]/i.test(w));
  if (words.length === 0) return '?';
  const first = words[0]!.match(/[a-z0-9]/i)![0];
  const second = words[1]?.match(/[a-z0-9]/i)?.[0] ?? '';
  return `${first}${second}`.toUpperCase();
}
