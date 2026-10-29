import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cx, FOCUS_RING } from './cx.js';
import { shortcutBlocked } from './keys.js';

// TABS WITH COUNTS (docs/redesign/DESIGN.md § Tabs).
//
// One tablist per page header. A count is a FACT about a population, so its three states stay
// apart: a number (0 included — a zero tab stays visible, dimmed, so "0" reads as a fact), the
// string 'loading' (drawn "…", never "0"), and `null` / absent (unknown: nothing is drawn — unknown
// is never zero). The tab on screen is the parent's DERIVED value; this component never writes
// back a correction (`onChange` fires only on a reader's action).
//
// `numberKeys`: 1–9 pick the first nine visible tabs from anywhere on the page (not while typing,
// in a popover or under a modal). Only ONE tablist per screen may claim them — the page's own.

export interface TabItem<T extends string> {
  id: T;
  label: ReactNode;
  /** A number, 'loading' ("…"), or null/undefined (draw nothing). */
  count?: number | 'loading' | null;
  icon?: ReactNode;
  /** Explains the tab (tooltip). */
  title?: string;
  /** Kept out of the strip (e.g. an AI-only tab with AI off). */
  hidden?: boolean;
}

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
  numberKeys = false,
  idPrefix,
  className,
}: {
  tabs: readonly TabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  /** The tablist's accessible name ("Pending tabs"). */
  label: string;
  numberKeys?: boolean;
  /** Prefix for tab / panel ids, so a panel can say `aria-labelledby={tabId(prefix, id)}`. */
  idPrefix?: string;
  className?: string;
}): JSX.Element {
  const shown = tabs.filter((t) => !t.hidden);
  const refs = useRef(new Map<T, HTMLButtonElement>());
  const live = useRef({ shown, onChange });
  live.current = { shown, onChange };

  useEffect(() => {
    if (!numberKeys) return;
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (shortcutBlocked(e) || !/^[1-9]$/.test(e.key)) return;
      const t = live.current.shown[Number(e.key) - 1];
      if (!t) return;
      e.preventDefault();
      live.current.onChange(t.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [numberKeys]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const i = shown.findIndex((t) => t.id === value);
    let next: number | null = null;
    if (e.key === 'ArrowRight') next = (i + 1) % shown.length;
    else if (e.key === 'ArrowLeft') next = (i - 1 + shown.length) % shown.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = shown.length - 1;
    if (next == null) return;
    e.preventDefault();
    const t = shown[next];
    if (!t) return;
    onChange(t.id);
    refs.current.get(t.id)?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={cx('flex min-w-0 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]', className)}
    >
      {shown.map((t, i) => {
        const on = t.id === value;
        const zero = t.count === 0;
        return (
          <button
            key={t.id}
            ref={(el) => {
              if (el) refs.current.set(t.id, el);
              else refs.current.delete(t.id);
            }}
            id={idPrefix ? tabId(idPrefix, t.id) : undefined}
            type="button"
            role="tab"
            aria-selected={on}
            aria-controls={idPrefix ? panelId(idPrefix, t.id) : undefined}
            tabIndex={on ? 0 : -1}
            title={t.title}
            // The shortcut is announced through aria-keyshortcuts, never folded into the name (e2e
            // tests and screen readers find a tab by its exact label).
            aria-keyshortcuts={numberKeys && i < 9 ? String(i + 1) : undefined}
            onClick={() => onChange(t.id)}
            className={cx(
              'inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-ui px-2 text-body touch:h-10 touch:px-3',
              'motion-safe:transition-colors motion-safe:duration-ui-fast',
              on ? 'bg-ui-sel text-ui-ink' : 'text-ui-mute hover:bg-ui-hover hover:text-ui-ink',
              zero && !on && 'text-ui-faint',
              FOCUS_RING,
            )}
          >
            {t.icon != null && <span className="flex shrink-0 items-center">{t.icon}</span>}
            <span>{t.label}</span>
            {t.count != null && (
              <span className={cx('text-meta tabular-nums', on ? 'text-ui-mute' : 'text-ui-faint')}>
                {t.count === 'loading' ? '…' : t.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export function tabId(prefix: string, id: string): string {
  return `${prefix}-tab-${id}`;
}
export function panelId(prefix: string, id: string): string {
  return `${prefix}-panel-${id}`;
}
