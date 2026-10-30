import { cx } from '../ui/cx.js';

/**
 * A small mark on a shell button (the menu button, the phone's "More") that says something inside
 * the drawer wants a look. Decorative: the button's accessible name carries the words.
 */
export function AlertDot({ tone, onIcon = false }: { tone: 'danger' | 'warn' | 'accent'; onIcon?: boolean }): JSX.Element {
  return (
    <span
      aria-hidden
      data-testid="shell-alert-dot"
      className={cx(
        onIcon ? 'absolute -right-1 -top-0.5 h-2 w-2 rounded-full ring-2 ring-ui-surface' : 'absolute right-1 top-1 h-2 w-2 rounded-full ring-2 ring-ui-bg',
        tone === 'danger' ? 'bg-ui-danger' : tone === 'warn' ? 'bg-ui-warn' : 'bg-ui-accent',
      )}
    />
  );
}
