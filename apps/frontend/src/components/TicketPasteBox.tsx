import { useEffect, useId, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import {
  TICKET_REFS_MAX,
  parseTicketRef,
  refDedupeKey,
  splitTicketRefs,
  type TicketRefResult,
} from '@pierre-review/shared';
import { useLinkAndCheckTickets, usePreviewTicketRefs } from '../hooks/useTicketRefs.js';
import { refusalSentence } from '../lib/ticketReview.js';
import { safeExternalUrl } from '../lib/ui.js';
import { AiRunGate } from './AiSetup.js';
import { CheckIcon, CloseIcon, PlusIcon, WarningIcon } from './Icons.js';

// THE STORY CHECK'S PASTE BOX — the default way to add a ticket (docs/TRACKERS.md § Adding a ticket
// by hand). One input takes one or more ticket links or keys; each becomes a removable chip that
// reads its ticket from the PR's workspace tracker (`link: false`, nothing stored) and says what it
// found. Check adds the readable ones to the PR and starts ONE ticket review per ticket. "Input
// manually" reveals the typed-story form (ClaudeReviewTicketPanel), unchanged.

const MUTED = 'text-gray-500 dark:text-gray-400';
const ERROR_TEXT = 'text-red-600 dark:text-red-400';
const BTN =
  'whitespace-nowrap rounded border border-gray-300 px-2 py-0.5 text-xs hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:hover:border-gray-500';
const BTN_PRIMARY =
  'whitespace-nowrap rounded border border-blue-400 px-2 py-0.5 text-xs text-blue-600 hover:bg-blue-50 disabled:opacity-50 dark:border-blue-600 dark:text-blue-400 dark:hover:bg-blue-900/30';
const LINK_BTN = 'text-xs text-blue-700 hover:underline disabled:opacity-50 dark:text-blue-300';
const SPINNER =
  'inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-gray-300 border-t-blue-500 dark:border-gray-600 dark:border-t-blue-400';

interface Chip {
  ref: string;
  // undefined = reading.
  result?: TicketRefResult;
  // The ticket was added but its review did not start (Check again retries it).
  startError?: string;
}

const READABLE = new Set(['found', 'linked', 'already']);
const isReadable = (c: Chip): boolean => c.result != null && READABLE.has(c.result.status);

/** A reference the shared parser cannot read is answered here, with no request. */
function localResult(ref: string): TicketRefResult | undefined {
  if (parseTicketRef(ref).kind !== 'invalid') return undefined;
  return { ref, status: 'invalid', key: null, ident: null, title: null, url: null, message: 'Not a ticket link or key.' };
}

export function TicketPasteBox({
  prId,
  startOpen,
  manualShown,
  onInputManually,
}: {
  prId: number;
  // Open on mount (the PR has no ticket yet); else a "+ Add ticket" link opens it.
  startOpen: boolean;
  // The typed-story form is already on screen: no "Input manually" button.
  manualShown: boolean;
  onInputManually: () => void;
}): JSX.Element {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [open, setOpen] = useState(startOpen);
  const [text, setText] = useState('');
  const [chips, setChipsState] = useState<Chip[]>([]);
  const chipsRef = useRef(chips);
  const setChips = (next: Chip[]): void => {
    chipsRef.current = next;
    setChipsState(next);
  };
  const [note, setNote] = useState<string | null>(null);
  const preview = usePreviewTicketRefs(prId);
  const check = useLinkAndCheckTickets(prId);
  // An answer that lands after the reader opened another PR is dropped.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const fold = (results: readonly TicketRefResult[]): void => {
    const byRef = new Map(results.map((r) => [refDedupeKey(r.ref), r]));
    setChips(
      chipsRef.current.map((c) => {
        const r = byRef.get(refDedupeKey(c.ref));
        return r != null ? { ...c, result: r } : c;
      }),
    );
  };

  const add = (raw: string): void => {
    const have = new Set(chipsRef.current.map((c) => refDedupeKey(c.ref)));
    const fresh = splitTicketRefs(raw).filter((r) => !have.has(refDedupeKey(r)));
    if (fresh.length === 0) return;
    const room = TICKET_REFS_MAX - chipsRef.current.length;
    const taken = fresh.slice(0, Math.max(0, room));
    setNote(fresh.length > taken.length ? `Up to ${TICKET_REFS_MAX} tickets at a time.` : null);
    if (taken.length === 0) return;
    const added: Chip[] = taken.map((ref) => ({ ref, result: localResult(ref) }));
    setChips([...chipsRef.current, ...added]);
    const toRead = added.filter((c) => c.result == null).map((c) => c.ref);
    if (toRead.length === 0) return;
    preview.mutate(toRead, {
      onSuccess: (results) => {
        if (alive.current) fold(results);
      },
      onError: (e) => {
        if (!alive.current) return;
        // The whole request was refused (no tracker, no token): every chip it carried says so.
        const message = e.message || 'Could not read the tickets.';
        fold(toRead.map((ref) => ({ ref, status: 'failed', key: null, ident: null, title: null, url: null, message })));
      },
    });
  };

  const commit = (): void => {
    if (text.trim() === '') return;
    add(text);
    setText('');
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Backspace' && text === '' && chipsRef.current.length > 0) {
      setChips(chipsRef.current.slice(0, -1));
    }
  };
  const onPaste = (e: ClipboardEvent<HTMLInputElement>): void => {
    const pasted = e.clipboardData.getData('text');
    if (!/[\s,;]/.test(pasted.trim())) return; // one reference: let it land, Enter adds it
    e.preventDefault();
    add(`${text} ${pasted}`);
    setText('');
  };
  const remove = (i: number): void => {
    setChips(chipsRef.current.filter((_, j) => j !== i));
    inputRef.current?.focus();
  };

  const readable = chips.filter(isReadable);
  const reading = chips.some((c) => c.result == null);
  const n = readable.length;
  const refusals = (check.data?.runs ?? []).filter((r) => r.refused != null && r.ticketReviewId == null);

  const runCheck = (): void => {
    const refs = readable.map((c) => c.ref);
    check.mutate(refs, {
      onSuccess: ({ results, startFailed }) => {
        if (!alive.current) return;
        // Added and started: those chips go. Anything that failed — the link, or the start of its
        // review — keeps its chip and says why, so Check again retries only those.
        const startError = (r: TicketRefResult): string | undefined =>
          r.ident != null ? startFailed[r.ident] : undefined;
        const done = new Set(
          results
            .filter((r) => (r.status === 'linked' || r.status === 'already') && startError(r) == null)
            .map((r) => refDedupeKey(r.ref)),
        );
        const byRef = new Map(results.map((r) => [refDedupeKey(r.ref), r]));
        setChips(
          chipsRef.current
            .filter((c) => !done.has(refDedupeKey(c.ref)))
            .map((c) => {
              const r = byRef.get(refDedupeKey(c.ref));
              const err = r != null ? startError(r) : undefined;
              return { ...c, result: r ?? c.result, startError: err };
            }),
        );
      },
    });
  };

  if (!open) {
    return (
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => {
            setOpen(true);
            requestAnimationFrame(() => inputRef.current?.focus());
          }}
          className={`inline-flex items-center gap-1 ${LINK_BTN}`}
        >
          <PlusIcon size={11} />
          Add ticket
        </button>
        {!manualShown && (
          <button type="button" onClick={onInputManually} className={LINK_BTN}>
            Input manually
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="mt-2 space-y-2">
      <label htmlFor={inputId} className="block text-xs font-medium text-gray-700 dark:text-gray-200">
        Add tickets
      </label>
      <div className="flex flex-wrap items-center gap-1.5 rounded border border-gray-300 px-2 py-1.5 focus-within:border-blue-500 dark:border-gray-700">
        {chips.length > 0 && (
          <ul className="contents" aria-label="Tickets to add">
            {chips.map((c, i) => (
              <ChipView key={refDedupeKey(c.ref)} chip={c} onRemove={() => remove(i)} />
            ))}
          </ul>
        )}
        <input
          id={inputId}
          ref={inputRef}
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onBlur={commit}
          disabled={check.isPending}
          placeholder={chips.length === 0 ? 'Paste ticket links or keys, like PROJ-123' : 'Add another'}
          className="min-w-[12rem] flex-1 bg-transparent py-0.5 text-xs text-gray-900 outline-none placeholder:text-gray-500 dark:text-gray-100 dark:placeholder:text-gray-400"
        />
      </div>
      {note != null && <p className={`text-xs ${MUTED}`}>{note}</p>}
      <div className="flex flex-wrap items-center gap-2">
        {n > 0 && (
          <AiRunGate>
            <button
              type="button"
              disabled={reading || check.isPending}
              onClick={runCheck}
              className={BTN_PRIMARY}
            >
              {check.isPending ? 'Starting…' : n === 1 ? 'Check this ticket' : `Check ${n} tickets`}
            </button>
          </AiRunGate>
        )}
        {reading && (
          <span role="status" className={`inline-flex items-center gap-1.5 text-xs ${MUTED}`}>
            <span className={SPINNER} aria-hidden="true" />
            Reading…
          </span>
        )}
        {!manualShown && (
          <button type="button" onClick={onInputManually} className={BTN}>
            Input manually
          </button>
        )}
        {check.isError && (
          <span className={`text-xs ${ERROR_TEXT}`}>{check.error.message || 'Could not start the check.'}</span>
        )}
      </div>
      {refusals.map((r) => (
        <p key={r.ident} className={`text-xs ${ERROR_TEXT}`}>
          {refusalSentence(r.refused!)}
        </p>
      ))}
    </div>
  );
}

function ChipView({ chip, onRemove }: { chip: Chip; onRemove: () => void }): JSX.Element {
  const r = chip.result;
  const ok = r != null && READABLE.has(r.status);
  const label = r?.key ?? chip.ref;
  const href = ok ? safeExternalUrl(r.url) : undefined;
  return (
    <li
      className={`inline-flex max-w-full items-start gap-1 rounded-full border px-2 py-0.5 text-xs ${
        r == null
          ? 'border-gray-300 text-gray-700 dark:border-gray-700 dark:text-gray-200'
          : ok
            ? 'border-green-300 text-gray-800 dark:border-green-800 dark:text-gray-100'
            : 'border-red-300 text-gray-800 dark:border-red-800 dark:text-gray-100'
      }`}
    >
      <span className="mt-px shrink-0" aria-hidden="true">
        {r == null ? (
          <span className={SPINNER} />
        ) : ok ? (
          <CheckIcon size={12} className="text-green-600 dark:text-green-400" />
        ) : (
          <WarningIcon size={12} className="text-red-600 dark:text-red-400" />
        )}
      </span>
      <span className="min-w-0 break-words">
        {href != null ? (
          <a href={href} target="_blank" rel="noreferrer noopener" className="font-mono hover:underline">
            {label}
          </a>
        ) : (
          <span className="font-mono">{label}</span>
        )}
        {r == null && <span className={MUTED}> reading…</span>}
        {ok && r.title != null && r.title !== '' && <span> {r.title}</span>}
        {r?.status === 'already' && <span className={MUTED}> (already on this PR)</span>}
        {r != null && !ok && r.message != null && <span className={ERROR_TEXT}> {r.message}</span>}
        {chip.startError != null && (
          <span className={ERROR_TEXT}> Added, but the check did not start: {chip.startError}</span>
        )}
      </span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${label}`}
        className="mt-px shrink-0 rounded-full p-0.5 text-gray-500 hover:bg-gray-200 hover:text-gray-800 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-100"
      >
        <CloseIcon size={10} />
      </button>
    </li>
  );
}
