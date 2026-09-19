import {
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type InputHTMLAttributes,
  type KeyboardEvent,
} from 'react';
import {
  FloatingPortal,
  autoUpdate,
  flip,
  offset,
  size,
  useFloating,
  useInteractions,
  useListNavigation,
} from '@floating-ui/react';
import { CheckIcon } from '../Icons.js';
import { ESCAPE_OWNER_ATTR } from '../../lib/escapeOwner.js';
import { inputCls } from './ui.js';
import { findZone, modernZoneName, zoneOptions, zoneRows, type ZoneOption } from './timeZones.js';

/**
 * THE TIME-ZONE PICKER for Settings → Working hours and budgets: an editable combobox (the APG
 * "list autocomplete" pattern) over every zone this browser knows, each with today's UTC offset.
 *
 * ⚠ VALUES ARE LIMITED TO THE LIST. Typing only filters; a zone is set by Enter or a click on an
 * option, and leaving the box any other way (blur, Tab, Escape) puts back what it showed. So
 * `onChange` only ever receives a listed name, or '' for the "Default (<zone>)" entry — the blank
 * setting that follows the deployment's zone.
 *
 * ⚠ IT PORTALS INTO THE SETTINGS DIALOG, NOT `body`. The list is `position: fixed`, so it escapes the
 * dialog's scrolling body without leaving the dialog element — which keeps its options inside
 * `aria-modal`, where a screen reader can reach them.
 *
 * ⚠ WHILE OPEN IT OWNS ESCAPE (`data-owns-escape`): Escape closes the list and the Settings modal
 * stays. See lib/escapeOwner.ts.
 */
export function TimeZoneCombobox({
  id,
  value,
  onChange,
  defaultZone,
}: {
  /** For `<label htmlFor>`. */
  id: string;
  /** '' = the deployment default. */
  value: string;
  /** Only ever a listed value, or ''. */
  onChange: (next: string) => void;
  /** me.workTimeZone ?? the browser's zone ?? 'UTC'. */
  defaultZone: string;
}): JSX.Element {
  const listId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<Array<HTMLElement | null>>([]);
  const [open, setOpen] = useState(false);
  // Built on first open (~50ms for ~420 offsets), then kept.
  const [options, setOptions] = useState<ZoneOption[] | null>(null);
  // What the input holds while open, and the part of it that filters (empty on open, so the whole
  // list shows under the selected current text).
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [active, setActive] = useState<number | null>(null);
  const [portalRoot, setPortalRoot] = useState<HTMLElement | null>(null);

  // A stored old name ("Europe/Kiev") shows as its modern one, and is not rewritten.
  const closedText = value === '' ? `Default (${modernZoneName(defaultZone)})` : modernZoneName(value);
  const rows = useMemo(
    () => (options == null ? [] : zoneRows(options, query, defaultZone)),
    [options, query, defaultZone],
  );
  // Unmounted rows leave nulls behind; the navigation must not count them.
  listRef.current.length = rows.length;
  /** The row value the stored setting names — its modern name, '' for the default. */
  const currentIn = (opts: readonly ZoneOption[]): string =>
    value === '' ? '' : (findZone(opts, value)?.value ?? value);
  const current = options == null ? value : currentIn(options);

  const openList = (): void => {
    if (open) return;
    const opts = options ?? zoneOptions();
    setOptions(opts);
    setText(closedText);
    setQuery('');
    // The active row starts on the current setting, so Enter keeps it and the arrows move from it.
    const start = zoneRows(opts, '', defaultZone).findIndex((r) => r.value === currentIn(opts));
    setActive(start === -1 ? null : start);
    setPortalRoot(inputRef.current?.closest<HTMLElement>('[role="dialog"]') ?? null);
    setOpen(true);
  };
  const close = (): void => {
    setOpen(false);
    setQuery('');
    setActive(null);
  };
  const pick = (next: string): void => {
    onChange(next);
    close();
  };

  const { refs, floatingStyles, context, isPositioned } = useFloating({
    open,
    onOpenChange: (next) => (next ? openList() : close()),
    strategy: 'fixed',
    placement: 'bottom-start',
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(4),
      flip({ padding: 8 }),
      size({
        padding: 8,
        apply({ availableHeight, rects, elements }) {
          Object.assign(elements.floating.style, {
            maxHeight: `${Math.min(288, availableHeight)}px`,
            width: `${rects.reference.width}px`,
          });
        },
      }),
    ],
  });
  const listNav = useListNavigation(context, {
    listRef,
    activeIndex: active,
    onNavigate: setActive,
    virtual: true,
    loop: true,
  });
  const { getReferenceProps, getFloatingProps, getItemProps } = useInteractions([listNav]);

  // Brings the row the list opens on (the current setting) into view, once the list has its height.
  // floating-ui scrolls an active row only for the keyboard, and a click or a focus opens by
  // pointer; and its scroll runs a frame after mount, which on a reopen lands before `size` has
  // capped the list, when there is nothing to scroll. Either way the ticked row sat hundreds of
  // rows below the part of the list on screen.
  useLayoutEffect(() => {
    if (!isPositioned || active == null) return;
    listRef.current[active]?.scrollIntoView({ block: 'nearest' });
    // Once per open: `isPositioned` turns true once, and later moves of `active` scroll themselves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPositioned]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Escape' && open) {
      // The Settings modal's capture handler has already stepped aside (the input carries
      // `data-owns-escape`); stopping here keeps the key from the app's window shortcuts too,
      // which would blur the input.
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key === 'Enter' && open) {
      e.preventDefault();
      const row = active == null ? undefined : rows[active];
      if (row != null) pick(row.value);
      return;
    }
    // The first character typed into a closed box starts a fresh search rather than editing the
    // name it shows.
    if (!open && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      openList();
      e.currentTarget.select();
    }
  };

  return (
    <>
      <input
        {...getReferenceProps({
          ref: (el: HTMLInputElement | null) => {
            inputRef.current = el;
            refs.setReference(el);
          },
          id,
          role: 'combobox',
          type: 'text',
          autoComplete: 'off',
          spellCheck: false,
          'aria-expanded': open,
          'aria-controls': listId,
          'aria-autocomplete': 'list',
          'aria-activedescendant': open && active != null ? `${listId}-opt-${active}` : undefined,
          [ESCAPE_OWNER_ATTR]: open ? '' : undefined,
          className: inputCls,
          value: open ? text : closedText,
          onFocus: (e) => {
            openList();
            e.currentTarget.select();
          },
          // Selected again on click: a mouse focus selects the text and the mouseup that follows
          // drops the selection. Once something is typed, a click only moves the caret.
          onClick: (e) => {
            if (!open) openList();
            if (query === '') e.currentTarget.select();
          },
          onChange: (e) => {
            const next = e.currentTarget.value;
            if (!open) openList();
            setText(next);
            setQuery(next);
            setActive(zoneRows(options ?? zoneOptions(), next, defaultZone).length > 0 ? 0 : null);
          },
          onBlur: close,
          onKeyDown,
        } as InputHTMLAttributes<HTMLInputElement>)}
      />
      {open && (
        <FloatingPortal root={portalRoot ?? undefined}>
          <div
            ref={refs.setFloating}
            style={floatingStyles}
            // Keeps focus in the input for a click anywhere in the list, the scrollbar included —
            // a blur would close the list before the click landed.
            onMouseDown={(e) => e.preventDefault()}
            className="z-[70] overflow-auto rounded-md border border-gray-200 bg-white py-1 shadow-lg dark:border-gray-700 dark:bg-gray-900"
          >
            {/* The floating props go on the LISTBOX, not the box around it: they carry
                `aria-orientation`, which a role-less element may not have. The box also holds the
                no-match line, which may not sit inside a listbox. */}
            <div
              {...getFloatingProps({ role: 'listbox', id: listId, 'aria-label': 'Time zones' })}
            >
              {rows.map((row, i) => (
                <div
                  key={row.value === '' ? '(default)' : row.value}
                  {...getItemProps({ onClick: () => pick(row.value) })}
                  ref={(el) => {
                    listRef.current[i] = el;
                  }}
                  role="option"
                  id={`${listId}-opt-${i}`}
                  aria-selected={i === active}
                  className={`flex cursor-pointer items-center justify-between gap-3 px-2 py-1 text-xs ${
                    i === active ? 'bg-sky-50 dark:bg-sky-950/40' : ''
                  }`}
                >
                  <span className="flex min-w-0 items-center gap-1 text-gray-800 dark:text-gray-100">
                    <span className="truncate">{row.label}</span>
                    {row.value === current && <CheckIcon size={11} className="shrink-0" />}
                  </span>
                  {row.offset !== '' && (
                    <span className="shrink-0 tabular-nums text-gray-500 dark:text-gray-400">
                      {row.offset}
                    </span>
                  )}
                </div>
              ))}
            </div>
            {rows.length === 0 && (
              <p className="px-2 py-1 text-xs text-gray-500 dark:text-gray-400">
                No time zone matches “{query.trim()}”.
              </p>
            )}
          </div>
        </FloatingPortal>
      )}
    </>
  );
}
