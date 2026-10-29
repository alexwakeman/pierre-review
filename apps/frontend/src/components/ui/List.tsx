import {
  useEffect,
  useRef,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { cx } from './cx.js';
import { indexAfterRemoval, nextIndex, resolveListKey } from './listNav.js';
import { shortcutBlocked } from './keys.js';

// THE ONE-LINE LIST (docs/redesign/DESIGN.md § Lists and rows).
//
// Every list in the redesign is this: one line per item, 36px (44px on touch), the selection is the
// accent-free `sel` tone, details open in a SidePanel. The parent owns the selected INDEX (so the
// URL or a store can hold it); this module owns the keys.
//
// ⚠ ROWS HOLD NO TAB STOPS. The list is ONE tab stop (`role="listbox"`, aria-activedescendant);
// a row's actions are its panel's buttons and the screen's action keys. A control that must sit on
// the row (a hover-only "open on GitHub") gets `tabIndex={-1}` and the same action is reachable
// from the panel or a key — never row-only.
//
// ⚠ NOTHING FETCHES ON SELECTION. Moving with j/k changes the selection only. A screen that opens
// its panel on selection must keep the panel's reads click-gated (the Pending rule: nothing on the
// board fetches on mount) — open on Enter / click, not on every keystroke.

export interface ListKeyboardOptions {
  /** The list element (focus inside it unlocks arrows, Enter, Home, End). */
  containerRef: RefObject<HTMLElement>;
  count: number;
  selected: number | null;
  onSelect: (index: number) => void;
  /** Enter, or a click on the selected row. */
  onOpen?: (index: number) => void;
  /** Single-letter action keys for the SELECTED row: `{ a: approve, m: merge, e: done }`. */
  actions?: Record<string, (index: number) => void>;
  /** Off while the screen is not the visible one (a hidden overlay must not answer j/k). */
  enabled?: boolean;
}

/** Window-level key handling for a list. Call once per visible list. */
export function useListKeyboard({
  containerRef,
  count,
  selected,
  onSelect,
  onOpen,
  actions,
  enabled = true,
}: ListKeyboardOptions): void {
  // Latest values without re-binding the listener on every render.
  const live = useRef({ count, selected, onSelect, onOpen, actions });
  live.current = { count, selected, onSelect, onOpen, actions };

  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent): void => {
      if (shortcutBlocked(e)) return;
      const el = containerRef.current;
      const focusInside = el != null && e.target instanceof Node && el.contains(e.target);
      const { count: n, selected: sel, onSelect: select, onOpen: open, actions: acts } = live.current;
      const res = resolveListKey(e.key, {
        focusInside,
        actionKeys: Object.keys(acts ?? {}),
        shift: e.shiftKey,
      });
      if (res == null) return;
      if (res.kind === 'move') {
        const next = nextIndex(sel, n, res.move);
        if (next != null) {
          e.preventDefault();
          select(next);
        }
        return;
      }
      if (sel == null || sel >= n) return;
      if (res.kind === 'open') {
        if (open) {
          e.preventDefault();
          open(sel);
        }
        return;
      }
      const fn = acts?.[res.key];
      if (fn) {
        e.preventDefault();
        fn(sel);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled, containerRef]);

  // Keep the selected row on screen.
  useEffect(() => {
    if (selected == null) return;
    const row = containerRef.current?.querySelector<HTMLElement>(`[data-row-index="${selected}"]`);
    row?.scrollIntoView?.({ block: 'nearest' });
  }, [selected, containerRef]);
}

export { indexAfterRemoval };

/** The id a row carries, so the listbox can point `aria-activedescendant` at it. */
export function rowDomId(listId: string, index: number): string {
  return `${listId}-row-${index}`;
}

export function List({
  id,
  label,
  selected,
  listRef,
  children,
  className,
  empty,
}: {
  /** Stable id; rows derive theirs from it. */
  id: string;
  /** The accessible name ("Pending items"). */
  label: string;
  selected: number | null;
  listRef: RefObject<HTMLUListElement>;
  children: ReactNode;
  className?: string;
  /** Shown (as a plain line) when there are no rows. */
  empty?: ReactNode;
}): JSX.Element {
  return (
    <ul
      ref={listRef}
      id={id}
      role="listbox"
      aria-label={label}
      tabIndex={0}
      aria-activedescendant={selected != null ? rowDomId(id, selected) : undefined}
      // No ring around the whole list: the selected row is where focus "is" (aria-activedescendant).
      className={cx('m-0 list-none p-0 outline-none', className)}
    >
      {children}
      {empty != null && (
        <li role="presentation" className="px-3 py-10 text-body text-ui-mute">
          {empty}
        </li>
      )}
    </ul>
  );
}

/** A labelled run of rows inside a List ("Do next", "Everything else"). */
export function ListGroup({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }): JSX.Element {
  return (
    <li role="presentation">
      <div role="group" aria-label={label}>
        <div role="presentation" className="flex items-baseline gap-2 px-3 pb-1 pt-4 text-meta text-ui-faint">
          <span className="font-medium text-ui-mute">{label}</span>
          {hint}
        </div>
        <ul role="presentation" className="m-0 list-none p-0">
          {children}
        </ul>
      </div>
    </li>
  );
}

export function Row({
  listId,
  index,
  selected,
  onSelect,
  onOpen,
  leaving = false,
  flash = false,
  children,
  className,
  title,
}: {
  listId: string;
  index: number;
  selected: boolean;
  onSelect: (index: number) => void;
  /** Clicking the already-selected row (or any row, if `openOnClick`) opens it. */
  onOpen?: (index: number) => void;
  /** The row is sliding out (an optimistic removal): fades and shifts left, then the parent drops it. */
  leaving?: boolean;
  /** Back-navigation landed here: a one-off highlight (the Back-flash rule). */
  flash?: boolean;
  children: ReactNode;
  className?: string;
  title?: string;
}): JSX.Element {
  const onClick = (e: MouseEvent): void => {
    // A link or button inside the row does its own thing.
    if ((e.target as HTMLElement).closest('a,button,input,label')) return;
    onSelect(index);
    onOpen?.(index);
  };
  return (
    <li
      id={rowDomId(listId, index)}
      role="option"
      aria-selected={selected}
      data-row-index={index}
      title={title}
      onClick={onClick}
      className={cx(
        'group/row flex h-row cursor-default items-center gap-3 rounded-ui px-3 text-body text-ui-ink touch:h-row-touch',
        'motion-safe:transition-[background-color,opacity,transform] motion-safe:duration-ui motion-safe:ease-ui',
        selected ? 'bg-ui-sel' : 'hover:bg-ui-hover',
        leaving && 'pointer-events-none -translate-x-3 opacity-0',
        flash && 'ring-2 ring-inset ring-ui-accent',
        className,
      )}
    >
      {children}
    </li>
  );
}

/** The row's leading status icon column (16px). Use a StatusIcon with `iconOnly`, or an avatar. */
export function RowLead({ children }: { children: ReactNode }): JSX.Element {
  return <span className="flex w-4 shrink-0 items-center justify-center">{children}</span>;
}

/** The row's main text: never wraps, takes the free width, `ref` dimmed after it. */
export function RowTitle({ children, sub }: { children: ReactNode; sub?: ReactNode }): JSX.Element {
  return (
    <span className="min-w-0 flex-1 truncate">
      {children}
      {sub != null && <span className="ml-2 text-ui-faint">{sub}</span>}
    </span>
  );
}

/**
 * A secondary cell (size, author, reason). `hideBelow` drops it on narrow screens so the row stays
 * ONE line on a phone — what it said must still be in the side panel.
 */
export function RowMeta({
  children,
  hideBelow,
  className,
  width,
}: {
  children: ReactNode;
  hideBelow?: 'sm' | 'md' | 'lg';
  className?: string;
  /** Fixed width in px so columns line up across rows. */
  width?: number;
}): JSX.Element {
  const hide = hideBelow === 'sm' ? 'max-sm:hidden' : hideBelow === 'md' ? 'max-md:hidden' : hideBelow === 'lg' ? 'max-lg:hidden' : '';
  return (
    <span
      className={cx('shrink-0 truncate text-meta tabular-nums text-ui-faint', hide, className)}
      style={width != null ? { width } : undefined}
    >
      {children}
    </span>
  );
}
