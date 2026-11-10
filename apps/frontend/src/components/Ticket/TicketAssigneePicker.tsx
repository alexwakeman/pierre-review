import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useClickOutside } from '../../hooks/useClickOutside.js';
import { useSetTicketAssignee, useTicketAssignables } from '../../hooks/useTicketPrs.js';
import { useFilters } from '../../store/filters.js';
import { initialsOf } from '../../lib/openPrsStacks.js';
import { UNASSIGNED_LABEL, assigneeChoices } from '../../lib/ticketAssignees.js';
import { CaretIcon, CheckIcon } from '../Icons.js';

// THE STORY VIEW'S ASSIGNEE PICKER (docs/TRACKERS.md § The assignee change) — Jira, GitHub Issues and
// Linear (shared `canAssignTickets`); a Notion ticket shows its assignee as before. The assignee IS the
// trigger. Opening it asks the tracker who may be assigned (`GET /api/ticket-assignees`, never on
// mount); picking one assigns the ticket AT ONCE (`POST /api/ticket-assignee`) — the header shows the
// pick straight away and goes back if the tracker refuses. A refusal stays as one line beside it.
//
// Mounted by the story view's ONE stack header (OpenPrsCards `TicketPeopleAndStatus`, `single`), so the
// story tab and This Sprint's story tray share it.

export function TicketAssigneePicker({
  ident,
  assignee,
  trackerLabel,
}: {
  ident: string;
  /** The assignee as shown now; null = nobody. */
  assignee: { name: string } | null;
  /** "Jira", "GitHub", "Linear" — for the trigger's title. */
  trackerLabel: string;
}): JSX.Element {
  const workspaceId = useFilters((s) => s.workspaceId);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuId = useId();
  const list = useTicketAssignables(workspaceId, ident, open);
  const change = useSetTicketAssignee(workspaceId, ident);
  const close = (): void => {
    setOpen(false);
    setQuery('');
  };
  useClickOutside(rootRef, close, open);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
    if (items.length === 0) return;
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = i < 0 ? (e.key === 'ArrowDown' ? 0 : items.length - 1) : (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };

  const currentName = assignee?.name ?? null;
  const { choices, hidden } = assigneeChoices(list.data?.users ?? [], query, currentName);
  const pending = change.isPending;
  const pick = (user: Parameters<typeof change.mutate>[0]): void => {
    close();
    change.mutate(user);
  };

  return (
    <div ref={rootRef} className="relative inline-flex flex-wrap items-center gap-1.5">
      <button
        type="button"
        disabled={pending || workspaceId == null}
        onClick={() => (open ? close() : setOpen(true))}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`Assignee: ${currentName ?? UNASSIGNED_LABEL}. Change assignee`}
        title={`Change assignee in ${trackerLabel}`}
        className="inline-flex items-center gap-1.5 rounded-ui px-1 text-ui-ink touch:min-h-10 touch:px-2 hover:bg-ui-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent disabled:opacity-60"
      >
        {currentName != null ? (
          <>
            <span
              aria-hidden
              className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-ui-hover text-meta font-semibold text-ui-ink"
            >
              {initialsOf(currentName)}
            </span>
            <span>{currentName}</span>
          </>
        ) : (
          <span className="text-ui-mute">{UNASSIGNED_LABEL}</span>
        )}
        {pending && <span className="text-meta text-ui-mute">Saving…</span>}
        <CaretIcon dir="down" />
      </button>
      {change.isError && (
        <span role="alert" className="text-meta text-ui-danger">
          {change.error.message}
        </span>
      )}
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label="Change assignee"
          onKeyDown={onMenuKey}
          className="absolute left-0 top-full z-[60] mt-1 w-64 rounded-ui bg-ui-surface p-1 shadow-lg"
        >
          <input
            ref={inputRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && choices.length > 0) {
                e.preventDefault();
                const first = choices.find((c) => !c.current) ?? choices[0];
                if (first != null && !first.current) pick(first.kind === 'person' ? first.user : null);
              }
            }}
            placeholder="Find a person"
            aria-label="Find a person"
            className="mb-1 h-7 w-full rounded-ui border border-ui-line bg-ui-surface px-2 text-meta text-ui-ink placeholder:text-ui-mute focus:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent touch:h-10"
          />
          {list.isLoading ? (
            <p aria-busy="true" className="px-2 py-1 text-meta text-ui-mute">
              Asking {trackerLabel}…
            </p>
          ) : list.isError ? (
            <p className="px-2 py-1 text-meta text-ui-danger">{list.error.message}</p>
          ) : (
            <div className="max-h-72 overflow-y-auto">
              {choices.length === 0 && <p className="px-2 py-1 text-meta text-ui-mute">Nobody matches.</p>}
              {choices.map((c) => (
                <button
                  key={c.kind === 'person' ? c.user.id : 'unassigned'}
                  type="button"
                  role="menuitemradio"
                  aria-checked={c.current}
                  onClick={() => (c.current ? close() : pick(c.kind === 'person' ? c.user : null))}
                  className="flex w-full items-center gap-2 rounded-ui px-2 py-1 text-left text-meta text-ui-ink touch:min-h-10 hover:bg-ui-hover focus:bg-ui-hover focus:outline-none"
                >
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className={`truncate ${c.kind === 'unassigned' ? 'text-ui-mute' : ''}`}>
                      {c.kind === 'person' ? c.user.name : UNASSIGNED_LABEL}
                    </span>
                    {c.kind === 'person' && c.user.detail != null && <span className="truncate text-meta text-ui-mute">{c.user.detail}</span>}
                  </span>
                  {c.current && <CheckIcon />}
                </button>
              ))}
              {hidden > 0 && <p className="px-2 py-1 text-meta text-ui-mute">Type a name to find more people.</p>}
              {list.data?.truncated === true && (
                <p className="px-2 py-1 text-meta text-ui-mute">{trackerLabel} has more people than Limn lists.</p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
