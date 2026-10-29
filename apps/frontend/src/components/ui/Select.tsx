import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { claimActivePopover } from '../../lib/activePopover.js';
import { CaretIcon, CheckIcon } from '../Icons.js';
import { cx, FOCUS_RING } from './cx.js';
import { useIsPhone } from './media.js';

// THE SELECT (docs/redesign/DESIGN.md § Controls) — the "select-only combobox" pattern.
//
// Focus stays on the button; the open list is pointed at with aria-activedescendant. Keys: ↓/↑/Enter/
// Space open; in the list ↓/↑ move, Home/End, a letter jumps, Enter/Space pick, Escape closes
// without picking (and never reaches the app's global Esc), Tab closes. Holds the one popover slot
// while open. On a phone the list opens as a bottom sheet with 44px options.
//
// ⚠ It is NOT a native <select>: `page.selectOption()` in a script does not work on it. When you
// swap a native select pinned by scripts/verify-demo.mjs or e2e (the "Model" picker, `#ai-effort`),
// update the script in the same commit to click the button, then the option by name.

export interface SelectOption<T extends string> {
  value: T;
  label: ReactNode;
  /** Plain text for type-ahead and the button when `label` is not a string. */
  text?: string;
  hint?: ReactNode;
  disabled?: boolean;
}

export function Select<T extends string>({
  value,
  onChange,
  options,
  label,
  labelledBy,
  id,
  name,
  disabled = false,
  placeholder = 'Pick one',
  size = 'md',
  className,
}: {
  value: T | null;
  onChange: (value: T) => void;
  options: readonly SelectOption<T>[];
  /** Accessible name when no visible <label> points at `id`. */
  label?: string;
  labelledBy?: string;
  id?: string;
  /** Submits the value with a surrounding <form> (a hidden input). */
  name?: string;
  disabled?: boolean;
  placeholder?: string;
  size?: 'sm' | 'md';
  className?: string;
}): JSX.Element {
  const autoId = useId();
  const buttonId = id ?? `${autoId}-button`;
  const listId = `${autoId}-list`;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const phone = useIsPhone();
  const current = options.find((o) => o.value === value) ?? null;

  const textOf = (o: SelectOption<T>): string => o.text ?? (typeof o.label === 'string' ? o.label : String(o.value));

  const close = useCallback(() => setOpen(false), []);

  const openList = (): void => {
    if (disabled) return;
    const at = options.findIndex((o) => o.value === value);
    setActive(at >= 0 ? at : Math.max(0, options.findIndex((o) => !o.disabled)));
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const release = claimActivePopover(close);
    const onDown = (e: PointerEvent): void => {
      const t = e.target as Node;
      if (listRef.current?.contains(t) || buttonRef.current?.contains(t)) return;
      close();
    };
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.preventDefault();
      close();
      buttonRef.current?.focus();
    };
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onEsc, true);
    return () => {
      release();
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onEsc, true);
    };
  }, [open, close]);

  useEffect(() => {
    if (open) listRef.current?.querySelector(`[data-opt-index="${active}"]`)?.scrollIntoView?.({ block: 'nearest' });
  }, [open, active]);

  const step = (delta: 1 | -1): void => {
    for (let i = 1; i <= options.length; i++) {
      const j = (active + delta * i + options.length) % options.length;
      if (!options[j]?.disabled) {
        setActive(j);
        return;
      }
    }
  };

  const pick = (i: number): void => {
    const o = options[i];
    if (!o || o.disabled) return;
    onChange(o.value);
    close();
    buttonRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
        e.preventDefault();
        openList();
      }
      return;
    }
    if (e.key === 'ArrowDown') step(1);
    else if (e.key === 'ArrowUp') step(-1);
    else if (e.key === 'Home') setActive(options.findIndex((o) => !o.disabled));
    else if (e.key === 'End') {
      for (let j = options.length - 1; j >= 0; j--) if (!options[j]?.disabled) { setActive(j); break; }
    } else if (e.key === 'Enter' || e.key === ' ') pick(active);
    else if (e.key === 'Tab') {
      close();
      return;
    } else if (e.key.length === 1 && /\S/.test(e.key)) {
      const ch = e.key.toLowerCase();
      const order = [...options.keys()].map((k) => (active + 1 + k) % options.length);
      const hit = order.find((j) => !options[j]?.disabled && textOf(options[j]!).toLowerCase().startsWith(ch));
      if (hit == null) return;
      setActive(hit);
    } else return;
    e.preventDefault();
  };

  return (
    <div className={cx('relative inline-flex min-w-0', className)}>
      <button
        ref={buttonRef}
        id={buttonId}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        aria-label={label}
        aria-labelledby={labelledBy}
        disabled={disabled}
        onClick={() => (open ? close() : openList())}
        onKeyDown={onKeyDown}
        className={cx(
          'inline-flex min-w-0 max-w-full items-center justify-between gap-2 rounded-ui bg-ui-raise px-2.5 text-left text-ui-ink hover:bg-ui-hover',
          size === 'sm' ? 'h-7 text-meta touch:h-10' : 'h-8 text-body touch:h-11',
          'disabled:cursor-not-allowed disabled:opacity-50',
          FOCUS_RING,
        )}
      >
        <span className={cx('min-w-0 truncate', current == null && 'text-ui-faint')}>
          {current != null ? current.label : placeholder}
        </span>
        <CaretIcon size={9} className="shrink-0 text-ui-faint" />
      </button>
      {name != null && <input type="hidden" name={name} value={value ?? ''} />}
      {open && (
        <>
          {phone && <div className="fixed inset-0 z-50 bg-ui-scrim/40" aria-hidden />}
          <ul
            ref={listRef}
            id={listId}
            role="listbox"
            aria-labelledby={labelledBy ?? buttonId}
            className={cx(
              'z-50 m-0 list-none overflow-y-auto overscroll-contain bg-ui-raise p-1 shadow-xl shadow-black/20',
              phone
                ? 'fixed inset-x-0 bottom-0 max-h-[70vh] rounded-t-xl pb-[max(8px,env(safe-area-inset-bottom))] motion-safe:animate-ui-sheet-up'
                : 'absolute left-0 top-full mt-1 max-h-72 min-w-full rounded-ui motion-safe:animate-ui-pop',
            )}
          >
            {options.map((o, i) => {
              const sel = o.value === value;
              return (
                <li
                  key={o.value}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={sel}
                  aria-disabled={o.disabled || undefined}
                  data-opt-index={i}
                  onMouseMove={() => !o.disabled && setActive(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(i)}
                  className={cx(
                    'flex cursor-default items-center gap-2 whitespace-nowrap rounded-ui px-2 text-body',
                    phone ? 'h-11' : 'h-8',
                    o.disabled ? 'text-ui-faint' : 'text-ui-ink',
                    i === active && !o.disabled && 'bg-ui-hover',
                  )}
                >
                  <span className="flex w-4 shrink-0 items-center text-ui-accent">{sel && <CheckIcon size={12} />}</span>
                  <span className="min-w-0 flex-1 truncate">{o.label}</span>
                  {o.hint != null && <span className="shrink-0 text-meta text-ui-faint">{o.hint}</span>}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
