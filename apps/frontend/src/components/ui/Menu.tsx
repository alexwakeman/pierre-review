import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { claimActivePopover } from '../../lib/activePopover.js';
import { cx, FOCUS_RING } from './cx.js';
import { Kbd } from './Kbd.js';
import { useIsPhone } from './media.js';

// THE MENU (docs/redesign/DESIGN.md § Menus).
//
// A button that opens a list of actions (`role="menu"`). It holds the app's ONE popover slot while
// open (lib/activePopover.ts), so opening it closes any other popover and the page's single-letter
// shortcuts stand down. Keys: ↓/↑ move (wrapping), Home/End, a letter jumps to the next item
// starting with it, Enter/Space run, Escape and Tab close and return focus to the trigger. On a
// phone it opens as a bottom sheet with 44px items.

export type MenuEntry =
  | {
      id: string;
      label: ReactNode;
      /** Plain text for type-ahead when `label` is not a string. */
      text?: string;
      icon?: ReactNode;
      kbd?: string;
      hint?: ReactNode;
      danger?: boolean;
      disabled?: boolean;
      onSelect: () => void;
    }
  | { separator: true; id: string }
  | { heading: string; id: string };

type ActionEntry = Extract<MenuEntry, { onSelect: () => void }>;

function isAction(e: MenuEntry): e is ActionEntry {
  return 'onSelect' in e;
}

export function Menu({
  trigger,
  items,
  label,
  align = 'start',
  className,
}: {
  /** Render the trigger; spread `props` onto a <button> (Button / IconButton accept them). */
  trigger: (props: {
    ref: (el: HTMLButtonElement | null) => void;
    onClick: () => void;
    onKeyDown: (e: React.KeyboardEvent) => void;
    'aria-haspopup': 'menu';
    'aria-expanded': boolean;
    'aria-controls': string | undefined;
  }) => ReactNode;
  items: readonly MenuEntry[];
  /** The menu's accessible name. */
  label: string;
  align?: 'start' | 'end';
  className?: string;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const menuId = useId();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const phone = useIsPhone();
  const actions = items.filter(isAction);
  const enabled = actions.map((a, i) => (a.disabled ? -1 : i)).filter((i) => i >= 0);

  const close = useCallback((refocus = true) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const release = claimActivePopover(() => setOpen(false));
    const onDown = (e: PointerEvent): void => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => {
      release();
      document.removeEventListener('pointerdown', onDown, true);
    };
  }, [open]);

  useEffect(() => {
    if (open) menuRef.current?.querySelector<HTMLElement>(`[data-menu-index="${active}"]`)?.focus();
  }, [open, active]);

  const openAt = (where: 'first' | 'last'): void => {
    setActive(where === 'first' ? (enabled[0] ?? 0) : (enabled[enabled.length - 1] ?? 0));
    setOpen(true);
  };

  const move = (delta: 1 | -1): void => {
    if (enabled.length === 0) return;
    const pos = enabled.indexOf(active);
    const next = enabled[(pos + delta + enabled.length) % enabled.length];
    if (next != null) setActive(next);
  };

  const run = (i: number): void => {
    const a = actions[i];
    if (!a || a.disabled) return;
    close();
    a.onSelect();
  };

  const onMenuKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') move(1);
    else if (e.key === 'ArrowUp') move(-1);
    else if (e.key === 'Home') setActive(enabled[0] ?? 0);
    else if (e.key === 'End') setActive(enabled[enabled.length - 1] ?? 0);
    else if (e.key === 'Enter' || e.key === ' ') run(active);
    else if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    } else if (e.key === 'Tab') close(false);
    else if (e.key.length === 1 && /\S/.test(e.key)) {
      const ch = e.key.toLowerCase();
      const order = [...enabled.filter((i) => i > active), ...enabled.filter((i) => i <= active)];
      const hit = order.find((i) => {
        const a = actions[i];
        const text = a?.text ?? (typeof a?.label === 'string' ? a.label : '');
        return text.toLowerCase().startsWith(ch);
      });
      if (hit != null) setActive(hit);
      else return;
    } else return;
    e.preventDefault();
  };

  // A capture-phase Escape so the app's global Esc (useKeyboard) never also fires.
  useEffect(() => {
    if (!open) return;
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.preventDefault();
      close();
    };
    window.addEventListener('keydown', onEsc, true);
    return () => window.removeEventListener('keydown', onEsc, true);
  }, [open, close]);

  let actionIndex = -1;
  return (
    <div className={cx('relative inline-flex', className)}>
      {trigger({
        ref: (el) => {
          triggerRef.current = el;
        },
        onClick: () => (open ? close() : openAt('first')),
        onKeyDown: (e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            openAt('first');
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            openAt('last');
          }
        },
        'aria-haspopup': 'menu',
        'aria-expanded': open,
        'aria-controls': open ? menuId : undefined,
      })}
      {open && (
        <>
          {phone && <div className="fixed inset-0 z-50 bg-ui-scrim/40 motion-safe:animate-ui-fade" aria-hidden />}
          <div
            ref={menuRef}
            id={menuId}
            role="menu"
            aria-label={label}
            onKeyDown={onMenuKey}
            className={cx(
              'z-50 overflow-y-auto overscroll-contain bg-ui-raise p-1 shadow-xl shadow-black/20',
              phone
                ? 'fixed inset-x-0 bottom-0 max-h-[70vh] rounded-t-xl pb-[max(8px,env(safe-area-inset-bottom))] motion-safe:animate-ui-sheet-up'
                : cx(
                    'absolute top-full mt-1 max-h-80 min-w-[200px] rounded-ui motion-safe:animate-ui-pop',
                    align === 'end' ? 'right-0' : 'left-0',
                  ),
            )}
          >
            {items.map((it) => {
              if ('separator' in it) return <div key={it.id} role="separator" className="my-1 h-px bg-ui-line" />;
              if ('heading' in it)
                return (
                  <div key={it.id} role="presentation" className="px-2 pb-1 pt-2 text-meta text-ui-faint">
                    {it.heading}
                  </div>
                );
              actionIndex += 1;
              const i = actionIndex;
              return (
                <button
                  key={it.id}
                  type="button"
                  role="menuitem"
                  data-menu-index={i}
                  tabIndex={i === active ? 0 : -1}
                  aria-disabled={it.disabled || undefined}
                  onClick={() => run(i)}
                  onMouseMove={() => !it.disabled && setActive(i)}
                  className={cx(
                    'flex w-full items-center gap-2 rounded-ui px-2 text-left text-body',
                    phone ? 'h-11' : 'h-8',
                    it.disabled ? 'cursor-not-allowed text-ui-faint' : it.danger ? 'text-ui-danger' : 'text-ui-ink',
                    i === active && !it.disabled && 'bg-ui-hover',
                    FOCUS_RING,
                    'focus-visible:ring-inset focus-visible:ring-offset-0',
                  )}
                >
                  {it.icon != null && <span className="flex w-4 shrink-0 items-center text-ui-mute">{it.icon}</span>}
                  <span className="min-w-0 flex-1 truncate">{it.label}</span>
                  {it.hint != null && <span className="shrink-0 text-meta text-ui-faint">{it.hint}</span>}
                  {it.kbd != null && <Kbd>{it.kbd}</Kbd>}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
