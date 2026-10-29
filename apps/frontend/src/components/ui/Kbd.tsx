import type { ReactNode } from 'react';
import { cx } from './cx.js';

/**
 * A key name, drawn as a key: `<Kbd>J</Kbd>`, `<Kbd>⌘K</Kbd>`. Key glyphs (⌘ ↵ ↑) are the names of
 * physical keys, not icons, so they stay characters (Icons.tsx § What is deliberately not an icon).
 * Hidden on a touch screen (`touch:hidden`): there is no keyboard to press. Pass `keep` to show it
 * anyway (the Help modal's key list).
 */
export function Kbd({
  children,
  className,
  keep = false,
  onAccent = false,
}: {
  children: ReactNode;
  className?: string;
  /** Show on touch screens too. */
  keep?: boolean;
  /** Sitting on an accent-filled button: a translucent key instead of the raised one. */
  onAccent?: boolean;
}): JSX.Element {
  return (
    <kbd
      className={cx(
        'inline-flex min-w-[18px] items-center justify-center rounded px-1 font-sans text-meta font-medium leading-[18px]',
        onAccent ? 'bg-white/20 text-ui-on-accent' : 'bg-ui-hover text-ui-mute',
        !keep && 'touch:hidden',
        className,
      )}
    >
      {children}
    </kbd>
  );
}

/** A shortcut of several keys in sequence ("1 – 7", "J K"). */
export function KbdGroup({ keys, className }: { keys: string[]; className?: string }): JSX.Element {
  return (
    <span className={cx('inline-flex items-center gap-0.5 touch:hidden', className)}>
      {keys.map((k) => (
        <Kbd key={k}>{k}</Kbd>
      ))}
    </span>
  );
}
