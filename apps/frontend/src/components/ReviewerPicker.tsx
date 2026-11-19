import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { AskablePerson, PrDetail } from '@pierre-review/shared';
import { useAskablePeople } from '../hooks/usePr.js';
import { useMutationState } from '@tanstack/react-query';
import {
  requestReviewersMutationKey,
  useRequestReviewers,
  useReviewerRequestState,
} from '../hooks/usePrWrites.js';
import { pickKey, pickRoom, pickerOptions, REVIEW_REQUEST_LIMIT } from '../lib/reviewerPicker.js';
import { Avatar } from './CommentCard.js';
import { MaintainerShield } from './MaintainerShield.js';
import { CheckIcon, CloseIcon } from './Icons.js';

// THE "SOMEONE ELSE" PICKER (docs/FRONTEND.md § The "Someone else" picker; docs/TEAM-REVIEW.md §
// Asking anyone in the workspace). The PR pane's People section: a link that opens a box where the
// reader picks one or more workspace people (chips) and asks them all for a review on GitHub.
//
// ⚠ NOTHING FETCHES ON MOUNT: the people list (`GET /api/prs/:id/askable-people`, DB only) loads
//   when the link is opened.
// ⚠ ONE PERSON, ONE REQUEST: each chip sends through the shared request-reviewers mutation under its
//   OWN key (`pick:<login>`), so GitHub refusing one person (a 422 — usually "no access") lands on
//   THAT chip and never sinks the others. A chip that was sent is never sent again: no retry button.
// ⚠ ASKING ONLY: no one already requested is removed from here.

const LINK =
  'inline-flex h-6 items-center rounded-ui px-1 text-meta font-medium text-ui-accent underline-offset-2 hover:underline touch:h-10';
const SMALL_BUTTON =
  'inline-flex h-6 items-center justify-center gap-1 rounded-ui bg-ui-raise px-2 text-meta font-medium text-ui-ink hover:bg-ui-hover disabled:opacity-50 touch:h-10 touch:px-3';
const QUIET_BUTTON =
  'inline-flex h-6 items-center rounded-ui px-2 text-meta text-ui-mute hover:bg-ui-hover hover:text-ui-ink touch:h-10';

type Sender = () => void;

/** One picked person: their request state off the shared key, and the send the parent's button runs. */
function PickedChip({
  prId,
  person,
  senders,
  onRemove,
}: {
  prId: number;
  person: AskablePerson;
  senders: Map<string, Sender>;
  onRemove: () => void;
}): JSX.Element {
  const key = pickKey(person.githubLogin);
  const request = useRequestReviewers(prId, key);
  const state = useReviewerRequestState(prId, key);
  const { mutate } = request;
  // The parent's "Request review" runs this; it sends only chips never sent (`tried`).
  useEffect(() => {
    senders.set(key, () => mutate({ userIds: [person.id] }));
    return () => {
      senders.delete(key);
    };
  }, [senders, key, mutate, person.id]);

  const who = `@${person.githubLogin}`;
  return (
    <li className="flex flex-col gap-0.5" data-testid="picked-reviewer">
      <span className="inline-flex items-center gap-1 self-start rounded-ui bg-ui-raise px-1.5 py-0.5 text-meta">
        <Avatar user={person} size={14} />
        <span className="font-medium text-ui-ink">{who}</span>
        {state.status === 'pending' && <span className="text-ui-mute">Asking…</span>}
        {state.status === 'success' && (
          <span role="status" className="inline-flex items-center gap-0.5 text-ui-success">
            <CheckIcon size={11} /> Asked
          </span>
        )}
        {state.status !== 'pending' && state.status !== 'success' && (
          <button
            type="button"
            onClick={onRemove}
            aria-label={`Remove ${who}`}
            title={`Remove ${who}`}
            className="inline-flex h-4 w-4 items-center justify-center rounded-ui text-ui-mute hover:bg-ui-hover hover:text-ui-ink touch:h-8 touch:w-8"
          >
            <CloseIcon size={10} />
          </button>
        )}
      </span>
      {state.status === 'error' && (
        <span role="alert" className="text-meta text-ui-danger">
          {state.error}
        </span>
      )}
    </li>
  );
}

/** The link, and once opened the chips, the box and its dropdown. The caller shows it only on an
 *  open PR where the reader can push, with a resolved workspace (hide, never disable). */
export function ReviewerPicker({
  pr,
  workspaceId,
}: {
  pr: PrDetail;
  workspaceId: number;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<AskablePerson[]>([]);
  const [listOpen, setListOpen] = useState(false);
  const [active, setActive] = useState(0);
  const senders = useRef(new Map<string, Sender>()).current;
  const inputRef = useRef<HTMLInputElement>(null);
  const { data, isLoading, isError } = useAskablePeople(pr.id, workspaceId, open);
  // Which chips were ever sent on this PR (any outcome), off the shared mutation cache — so a sent
  // chip is never sent again, even after a remount.
  const tried = new Set(
    useMutationState({
      filters: { mutationKey: requestReviewersMutationKey(pr.id) },
      select: (m) => m.options.mutationKey?.[2],
    }).filter((k): k is string => typeof k === 'string'),
  );

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className={LINK} data-testid="someone-else">
        Someone else
      </button>
    );
  }

  const pickedIds = new Set(picked.map((p) => p.id));
  const options = pickerOptions(data?.people ?? [], pickedIds, query);
  const room = pickRoom(pr.requestedReviewers.length, picked.length);
  const listId = `someone-else-${pr.id}`;
  const showList = listOpen && room > 0 && options.length > 0;

  const pick = (p: AskablePerson): void => {
    setPicked((prev) => (prev.some((x) => x.id === p.id) ? prev : [...prev, p]));
    setQuery('');
    setActive(0);
    inputRef.current?.focus();
  };
  const remove = (id: number): void => setPicked((prev) => prev.filter((p) => p.id !== id));
  const close = (): void => {
    setOpen(false);
    setPicked([]);
    setQuery('');
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown' && options.length > 0) {
      e.preventDefault();
      setListOpen(true);
      setActive((a) => (a + 1) % options.length);
    } else if (e.key === 'ArrowUp' && options.length > 0) {
      e.preventDefault();
      setActive((a) => (a - 1 + options.length) % options.length);
    } else if (e.key === 'Enter' && showList) {
      e.preventDefault();
      const p = options[active] ?? options[0];
      if (p) pick(p);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (showList) setListOpen(false);
      else close();
    } else if (e.key === 'Backspace' && query === '' && picked.length > 0) {
      const last = picked[picked.length - 1]!;
      if (!tried.has(pickKey(last.githubLogin))) remove(last.id);
    }
  };

  const sendable = picked.filter((p) => !tried.has(pickKey(p.githubLogin)));
  const send = (): void => {
    for (const p of sendable) senders.get(pickKey(p.githubLogin))?.();
  };

  return (
    <div className="flex flex-col gap-1.5 text-meta" data-testid="someone-else-picker">
      {picked.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="People to ask">
          {picked.map((p) => (
            <PickedChip key={p.id} prId={pr.id} person={p} senders={senders} onRemove={() => remove(p.id)} />
          ))}
        </ul>
      )}
      {room > 0 ? (
        <div className="relative max-w-xs">
          <input
            ref={inputRef}
            type="text"
            value={query}
            autoFocus
            placeholder="Type a name"
            aria-label="Find someone to ask for a review"
            role="combobox"
            aria-expanded={showList}
            aria-controls={listId}
            aria-autocomplete="list"
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
              setListOpen(true);
            }}
            onFocus={() => setListOpen(true)}
            onBlur={() => window.setTimeout(() => setListOpen(false), 120)}
            onKeyDown={onKeyDown}
            className="h-7 w-full rounded-ui border border-ui-line bg-ui-surface px-2 text-meta text-ui-ink placeholder:text-ui-mute focus:outline-none focus:ring-1 focus:ring-ui-accent touch:h-10"
          />
          {showList && (
            <ul
              id={listId}
              role="listbox"
              className="absolute left-0 right-0 z-30 mt-0.5 max-h-56 overflow-auto rounded-ui bg-ui-surface py-1 shadow-lg"
            >
              {options.map((p, i) => (
                <li key={p.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={i === active}
                    // onMouseDown (not onClick) so it lands before the input's blur.
                    onMouseDown={(e) => {
                      e.preventDefault();
                      pick(p);
                    }}
                    onMouseEnter={() => setActive(i)}
                    className={`flex w-full items-center gap-2 px-2 py-1 text-left text-meta ${
                      i === active ? 'bg-ui-sel' : 'hover:bg-ui-hover'
                    }`}
                  >
                    <Avatar user={p} size={18} />
                    <span className="font-medium text-ui-ink">@{p.githubLogin}</span>
                    {p.isMaintainer && <MaintainerShield title="Has merged a PR in this repo" />}
                    {p.displayName && <span className="truncate text-ui-mute">{p.displayName}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <span className="text-ui-mute">GitHub allows {REVIEW_REQUEST_LIMIT} reviewers on a PR.</span>
      )}
      {isLoading && <span className="text-ui-mute">Loading people…</span>}
      {isError && <span className="text-ui-danger">Couldn’t load people.</span>}
      {data != null && data.people.length === 0 && (
        <span className="text-ui-mute">No one else in this workspace to suggest.</span>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        {sendable.length > 0 && (
          <button type="button" onClick={send} className={SMALL_BUTTON}>
            Request review
          </button>
        )}
        <button type="button" onClick={close} className={QUIET_BUTTON}>
          {picked.length > 0 && sendable.length < picked.length ? 'Done' : 'Cancel'}
        </button>
      </div>
    </div>
  );
}
