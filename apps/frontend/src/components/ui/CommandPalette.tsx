import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { closeActivePopover } from '../../lib/activePopover.js';
import { MagnifierIcon } from '../Icons.js';
import { collectCommands, rankCommands, useCommandRegistry, type Command } from './commands.js';
import { cx } from './cx.js';
import { isPaletteChord } from './keys.js';
import { Kbd } from './Kbd.js';

// THE COMMAND PALETTE (⌘K / Ctrl+K), mounted ONCE in App.tsx. It renders whatever the registry holds
// (components/ui/commands.ts). A modal dialog: the input keeps focus, ↑/↓ move, Enter runs, Escape
// closes (capture phase — the app's global Esc never also fires). Full screen on a phone.

export function CommandPalette(): JSX.Element | null {
  const open = useCommandRegistry((s) => s.open);
  const toggle = useCommandRegistry((s) => s.togglePalette);

  // The chord works everywhere, including inside a text field (that is what a chord is for).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!isPaletteChord(e)) return;
      e.preventDefault();
      e.stopPropagation();
      toggle();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [toggle]);

  if (!open) return null;
  return <PaletteDialog />;
}

function PaletteDialog(): JSX.Element {
  const initialQuery = useCommandRegistry((s) => s.initialQuery);
  const sources = useCommandRegistry((s) => s.sources);
  const providers = useCommandRegistry((s) => s.providers);
  const close = useCommandRegistry((s) => s.closePalette);
  const [query, setQuery] = useState(initialQuery);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const listId = useId();

  const results = useMemo(
    () => rankCommands(collectCommands(sources, providers, query), query),
    [sources, providers, query],
  );

  useEffect(() => {
    opener.current = document.activeElement as HTMLElement | null;
    closeActivePopover();
    inputRef.current?.focus();
    return () => opener.current?.focus?.();
  }, []);

  useEffect(() => setActive(0), [query]);

  useEffect(() => {
    listRef.current?.querySelector(`[data-cmd-index="${active}"]`)?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);

  useEffect(() => {
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    window.addEventListener('keydown', onEsc, true);
    return () => window.removeEventListener('keydown', onEsc, true);
  }, [close]);

  const run = (c: Command | undefined): void => {
    if (!c) return;
    // Close first, so focus is returned before the command moves it somewhere new.
    opener.current = null;
    close();
    c.run();
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') setActive((i) => Math.min(results.length - 1, i + 1));
    else if (e.key === 'ArrowUp') setActive((i) => Math.max(0, i - 1));
    else if (e.key === 'Home' && e.ctrlKey) setActive(0);
    else if (e.key === 'End' && e.ctrlKey) setActive(results.length - 1);
    else if (e.key === 'Enter') run(results[active]);
    else return;
    e.preventDefault();
  };

  const grouped = query.trim() === '';
  let lastGroup: string | null = null;

  return (
    <div className="fixed inset-0 z-[70] flex justify-center md:items-start md:pt-[14vh]">
      <div className="absolute inset-0 bg-ui-scrim/50 motion-safe:animate-ui-fade" onClick={close} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command menu"
        className={cx(
          'relative flex flex-col overflow-hidden bg-ui-raise shadow-2xl shadow-black/40',
          'max-md:h-full max-md:w-full max-md:pt-[env(safe-area-inset-top)]',
          'md:max-h-[70vh] md:w-[min(640px,92vw)] md:rounded-[10px] motion-safe:animate-ui-pop',
        )}
      >
        <div className="flex shrink-0 items-center gap-3 px-4">
          <MagnifierIcon size={16} className="shrink-0 text-ui-faint" />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={results[active] ? `${listId}-${active}` : undefined}
            aria-autocomplete="list"
            aria-label="Type a command or search"
            placeholder="Type a command, a page or a pull request"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            className="h-14 min-w-0 flex-1 bg-transparent text-title font-normal text-ui-ink outline-none placeholder:text-ui-faint"
          />
          <button
            type="button"
            onClick={close}
            className="shrink-0 rounded-ui px-2 py-1 text-meta text-ui-mute hover:bg-ui-hover md:hidden"
          >
            Cancel
          </button>
          <Kbd className="max-md:hidden">Esc</Kbd>
        </div>
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label="Results"
          className="m-0 min-h-0 flex-1 list-none overflow-y-auto overscroll-contain bg-ui-surface p-1.5"
        >
          {results.length === 0 && (
            <li role="presentation" className="px-3 py-6 text-body text-ui-mute">
              Nothing matches “{query.trim()}”.
            </li>
          )}
          {results.map((c, i) => {
            const heading = grouped && c.group !== lastGroup ? c.group : null;
            lastGroup = c.group;
            return (
              <li key={`${c.group}:${c.id}:${i}`} role="presentation">
                {heading != null && (
                  <div role="presentation" className="px-3 pb-1 pt-3 text-meta text-ui-faint first:pt-1">
                    {heading}
                  </div>
                )}
                <div
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === active}
                  data-cmd-index={i}
                  onMouseMove={() => setActive(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => run(c)}
                  className={cx(
                    'flex h-9 cursor-default items-center gap-3 rounded-ui px-3 text-body touch:h-11',
                    i === active ? 'bg-ui-sel text-ui-ink' : 'text-ui-mute',
                  )}
                >
                  {c.icon != null && <span className="flex w-4 shrink-0 items-center text-ui-faint">{c.icon}</span>}
                  <span className="min-w-0 flex-1 truncate">{c.title}</span>
                  {(c.hint ?? (!grouped ? c.group : null)) != null && (
                    <span className="max-w-[45%] shrink-0 truncate text-meta text-ui-faint">{c.hint ?? c.group}</span>
                  )}
                  {c.shortcut != null && <Kbd>{c.shortcut}</Kbd>}
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
