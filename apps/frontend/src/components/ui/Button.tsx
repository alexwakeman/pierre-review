import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cx, FOCUS_RING } from './cx.js';
import { Kbd } from './Kbd.js';

// THE BUTTON (docs/redesign/DESIGN.md § Controls).
//
// Four variants, and the colour rule decides which: `primary` is the ONE accent action on a
// surface (the selection's main action — at most one per panel); `secondary` is every other
// action; `ghost` is a quiet action inside a row or a toolbar; `danger` is a destructive action
// (close a PR, remove a doc) — text in danger ink, never a red ground. `success` does not exist:
// green is a status colour, never a button. An AI run button is a Button inside `AiRunGate`.

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

const VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-ui-accent-fill text-ui-on-accent hover:brightness-110 disabled:hover:brightness-100',
  secondary: 'bg-ui-raise text-ui-ink hover:bg-ui-hover',
  ghost: 'bg-transparent text-ui-mute hover:bg-ui-hover hover:text-ui-ink',
  danger: 'bg-ui-raise text-ui-danger hover:bg-ui-hover',
};

const SIZE: Record<ButtonSize, string> = {
  // 28px desktop; a touch screen gets the 40px target.
  sm: 'h-7 px-2 text-meta gap-1.5 touch:h-10 touch:px-3',
  md: 'h-8 px-3 text-body gap-2 touch:h-11 touch:px-4',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** An icon from Icons.tsx, drawn before the label. */
  icon?: ReactNode;
  /** The shortcut that does the same thing, shown as a key after the label ("M"). */
  kbd?: string;
  /** Busy: shows `busyLabel` (or the label) and blocks clicks, keeping the width stable. */
  busy?: boolean;
  busyLabel?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon, kbd, busy = false, busyLabel, className, children, disabled, type, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={cx(
        'inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap rounded-ui font-medium',
        'motion-safe:transition-colors motion-safe:duration-ui-fast',
        'disabled:cursor-not-allowed disabled:opacity-50',
        VARIANT[variant],
        SIZE[size],
        FOCUS_RING,
        className,
      )}
      {...rest}
    >
      {icon != null && <span className="flex shrink-0 items-center">{icon}</span>}
      {busy && busyLabel != null ? busyLabel : children}
      {kbd != null && !busy && (
        <Kbd onAccent={variant === 'primary'} className="ml-0.5">
          {kbd}
        </Kbd>
      )}
    </button>
  );
});

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** REQUIRED: the accessible name and the tooltip. An icon-only button says what it does. */
  label: string;
  icon: ReactNode;
  size?: ButtonSize;
  /** A toggle's state (the bell, Threads only). */
  pressed?: boolean;
}

/** A square icon-only button. Its `label` is both `aria-label` and `title`. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, size = 'md', pressed, className, type, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      className={cx(
        'inline-flex shrink-0 items-center justify-center rounded-ui text-ui-mute hover:bg-ui-hover hover:text-ui-ink',
        'motion-safe:transition-colors motion-safe:duration-ui-fast disabled:cursor-not-allowed disabled:opacity-50',
        pressed && 'bg-ui-sel text-ui-ink',
        size === 'sm' ? 'h-7 w-7' : 'h-8 w-8',
        'touch:h-10 touch:w-10',
        FOCUS_RING,
        className,
      )}
      {...rest}
    >
      {icon}
    </button>
  );
});
