import type { ReactNode } from 'react';
import { CaretIcon } from '../Icons.js';
import { Button, type ButtonProps, type ButtonSize, type ButtonVariant } from './Button.js';
import { cx } from './cx.js';
import { Menu, type MenuEntry } from './Menu.js';

// THE SPLIT BUTTON (docs/FRONTEND.md § The build tab): a primary action joined to a caret that opens
// the app's one `Menu` with the other ways to do it ("Implement" + "Implement with docs"). The caret is
// its own tab stop (`aria-haspopup="menu"`; ↓ opens the menu). With no other item it is a plain Button.
// The menu's items RUN; never put a billed press in one (an over-budget confirm guards only a button
// on the page) — a split button opens tabs, it does not start model runs.

export function SplitButton({
  children,
  onPrimary,
  items,
  menuLabel,
  menuTestId,
  variant = 'primary',
  size = 'sm',
  icon,
  className,
  ...rest
}: {
  children: ReactNode;
  onPrimary: () => void;
  /** Every way to do it, the primary one included (the menu lists them all). */
  items: readonly MenuEntry[];
  /** The menu's accessible name and the caret's ("More ways to implement"). */
  menuLabel: string;
  /** The caret's `data-testid`. */
  menuTestId?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
  className?: string;
} & Omit<ButtonProps, 'onClick' | 'variant' | 'size' | 'icon' | 'children' | 'className'>): JSX.Element {
  const actions = items.filter((i) => 'onSelect' in i);
  if (actions.length <= 1) {
    return (
      <Button variant={variant} size={size} icon={icon} className={className} onClick={onPrimary} {...rest}>
        {children}
      </Button>
    );
  }
  return (
    <span className={cx('inline-flex items-stretch', className)} data-split-button="">
      <Button variant={variant} size={size} icon={icon} className="rounded-r-none" onClick={onPrimary} {...rest}>
        {children}
      </Button>
      <Menu
        label={menuLabel}
        align="end"
        items={items}
        trigger={(t) => (
          <Button
            {...t}
            variant={variant}
            size={size}
            aria-label={menuLabel}
            title={menuLabel}
            data-testid={menuTestId}
            className={cx('rounded-l-none border-l border-ui-bg/40 px-1.5 touch:px-2')}
            disabled={rest.disabled}
          >
            <CaretIcon size={9} />
          </Button>
        )}
      />
    </span>
  );
}
