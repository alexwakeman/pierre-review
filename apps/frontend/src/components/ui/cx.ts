/** Join class names, dropping falsy parts. The one helper every primitive uses. */
export function cx(...parts: Array<string | false | null | undefined | 0>): string {
  return parts.filter(Boolean).join(' ');
}

/** The one focus ring: the accent, 2px, offset from the surface. Visible on keyboard focus only. */
export const FOCUS_RING =
  'outline-none focus-visible:ring-2 focus-visible:ring-ui-accent focus-visible:ring-offset-1 focus-visible:ring-offset-ui-bg';

/** A touch target: at least 40px tall on a coarse pointer, whatever the desktop size is. */
export const TOUCH_TARGET = 'touch:min-h-10 touch:min-w-10';

/**
 * A TEXTUAL LINK (docs/FRONTEND.md § Text links). Two strengths of ONE look — a thin underline in
 * the text's own colour at half strength, 2px below the baseline (index.css `.text-link`):
 * - `TEXT_LINK`: underlined at every width. For a panel that is mostly facts, where a link must
 *   read as one at a glance (the Open PRs drawer).
 * - `TEXT_LINK_PHONE`: underlined below `md` only (a phone has no hover to reveal it); on a desktop
 *   the element keeps its own `hover:underline`.
 * Text only — never on a chip, an icon, a tab, a nav item, a Button or a whole-row target.
 */
export const TEXT_LINK = 'text-link';
export const TEXT_LINK_PHONE = 'text-link-phone';
