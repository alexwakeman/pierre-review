/** Join class names, dropping falsy parts. The one helper every primitive uses. */
export function cx(...parts: Array<string | false | null | undefined | 0>): string {
  return parts.filter(Boolean).join(' ');
}

/** The one focus ring: the accent, 2px, offset from the surface. Visible on keyboard focus only. */
export const FOCUS_RING =
  'outline-none focus-visible:ring-2 focus-visible:ring-ui-accent focus-visible:ring-offset-1 focus-visible:ring-offset-ui-bg';

/** A touch target: at least 40px tall on a coarse pointer, whatever the desktop size is. */
export const TOUCH_TARGET = 'touch:min-h-10 touch:min-w-10';
