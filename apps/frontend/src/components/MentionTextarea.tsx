import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { FocusEvent as ReactFocusEvent, KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { User } from '@pierre-review/shared';
import { useMentionCandidates } from '../hooks/usePr.js';
import { Avatar } from './CommentCard.js';

// A drop-in replacement for a plain <textarea> that adds a GitHub-style "@mention"
// autocomplete. Candidates are fetched per-PR (proximity-ranked, self + bots
// excluded — see useMentionCandidates); the picker fires when the caret sits inside
// an "@handle" token. Selecting a candidate inserts "@login " as plain text —
// GitHub resolves the mention on post, so there's no Markdown-render change.
//
// Everything else behaves like the textarea it replaces: value/onChange are
// controlled, and the usual textarea props (rows/placeholder/className/…) pass
// through. An optional onKeyDown is forwarded ONLY when the picker isn't consuming
// the key, so a host's Cmd/Ctrl+Enter submit still works.

const MAX_SUGGESTIONS = 8;

// The active "@mention" token immediately before the caret, or null. A trigger '@'
// counts only at the start of the text or right after whitespace / '(' (so `a@b`
// and emails never fire), and the token so far must be handle-legal (alphanumerics +
// hyphen, matching GitHub logins) — anything else closes the picker.
function activeMention(text: string, caret: number): { query: string; start: number } | null {
  let i = caret - 1;
  while (i >= 0) {
    const ch = text[i] as string;
    if (ch === '@') {
      const prev = i > 0 ? (text[i - 1] as string) : '';
      if (i === 0 || /[\s(]/.test(prev)) {
        const query = text.slice(i + 1, caret);
        if (/^[A-Za-z0-9-]*$/.test(query)) return { query, start: i };
      }
      return null;
    }
    if (/\s/.test(ch)) return null;
    i -= 1;
  }
  return null;
}

function matchesQuery(user: User, query: string): boolean {
  if (query === '') return true;
  const q = query.toLowerCase();
  return (
    user.githubLogin.toLowerCase().includes(q) ||
    (user.displayName?.toLowerCase().includes(q) ?? false)
  );
}

// Keys the picker owns while it's open (so they don't newline / submit / blur).
const PICKER_KEYS = new Set(['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape']);

export function MentionTextarea({
  prId,
  candidates: candidatesProp,
  value,
  onChange,
  rows = 3,
  placeholder,
  autoFocus,
  disabled,
  className,
  ariaLabel,
  onKeyDown,
  onBlur,
}: {
  // The candidate SOURCE is either a PR (proximity-ranked via the hook) OR an explicit roster
  // (`candidates`, e.g. a team/repo scope for the ad-hoc Insights box). Exactly one is expected;
  // `candidates` wins when both are given. Both optional so a scope-less consumer just gets no
  // suggestions.
  prId?: number;
  candidates?: User[];
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  placeholder?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
  onKeyDown?: (e: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
  // Forwarded to the underlying textarea (e.g. a host's save-on-blur). Runs in
  // addition to the picker's own close-on-blur.
  onBlur?: (e: ReactFocusEvent<HTMLTextAreaElement>) => void;
}): JSX.Element {
  const taRef = useRef<HTMLTextAreaElement>(null);
  // Keep the hook call unconditional (hooks-order rule); it's a no-op (disabled) when prId is
  // absent, and an explicit `candidates` roster overrides it.
  const { data: fetched } = useMentionCandidates(prId ?? null);
  const candidates = candidatesProp ?? fetched;
  const [caret, setCaret] = useState(0);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  // Caret position to restore AFTER we programmatically rewrite `value` on accept.
  const pendingCaret = useRef<number | null>(null);

  useLayoutEffect(() => {
    if (pendingCaret.current != null && taRef.current) {
      const pos = pendingCaret.current;
      taRef.current.setSelectionRange(pos, pos);
      pendingCaret.current = null;
    }
  });

  const mention = open ? activeMention(value, caret) : null;
  const suggestions = useMemo(() => {
    if (mention == null || !candidates) return [];
    return candidates.filter((u) => matchesQuery(u, mention.query)).slice(0, MAX_SUGGESTIONS);
  }, [mention, candidates]);

  // Keep the highlighted index in range as the filtered list changes.
  useEffect(() => {
    setActive((a) => (a >= suggestions.length ? 0 : a));
  }, [suggestions.length]);

  const showPicker = open && mention != null && suggestions.length > 0;

  const syncCaret = (): void => {
    const el = taRef.current;
    if (el) setCaret(el.selectionStart ?? 0);
  };

  const accept = (user: User): void => {
    const m = activeMention(value, caret);
    if (!m) return;
    // Replace the WHOLE token, not just the part before the caret: if the caret
    // sits inside a contiguous handle (placed by click/arrow), advance past the
    // remaining handle-legal chars so we don't orphan a suffix ("@login nny").
    let end = caret;
    while (end < value.length && /[A-Za-z0-9-]/.test(value[end] as string)) end += 1;
    const before = value.slice(0, m.start);
    const after = value.slice(end);
    const insert = `@${user.githubLogin} `;
    pendingCaret.current = before.length + insert.length;
    setCaret(before.length + insert.length);
    setOpen(false);
    onChange(before + insert + after);
  };

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    if (showPicker && PICKER_KEYS.has(e.key)) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((a) => (a + 1) % suggestions.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((a) => (a - 1 + suggestions.length) % suggestions.length);
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const pick = suggestions[active] ?? suggestions[0];
        if (pick) accept(pick);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
      }
      return;
    }
    onKeyDown?.(e);
  };

  return (
    <div className="relative">
      <textarea
        ref={taRef}
        value={value}
        rows={rows}
        placeholder={placeholder}
        autoFocus={autoFocus}
        disabled={disabled}
        aria-label={ariaLabel}
        className={className}
        onChange={(e) => {
          onChange(e.target.value);
          setCaret(e.target.selectionStart ?? e.target.value.length);
          setOpen(true);
        }}
        onKeyDown={handleKeyDown}
        onKeyUp={syncCaret}
        onClick={() => {
          syncCaret();
          setOpen(true);
        }}
        // Delay the close so a mousedown-select on a suggestion lands first, then
        // run the host's onBlur (e.g. save-on-blur).
        onBlur={(e) => {
          window.setTimeout(() => setOpen(false), 120);
          onBlur?.(e);
        }}
      />
      {showPicker && (
        <ul
          role="listbox"
          className="absolute left-0 right-0 z-30 mt-0.5 max-h-56 overflow-auto rounded-md border border-gray-200 bg-white py-1 shadow-lg dark:border-gray-700 dark:bg-gray-900"
        >
          {suggestions.map((u, i) => (
            <li key={u.id}>
              <button
                type="button"
                role="option"
                aria-selected={i === active}
                // onMouseDown (not onClick) so it fires before the textarea's blur.
                onMouseDown={(e) => {
                  e.preventDefault();
                  accept(u);
                }}
                onMouseEnter={() => setActive(i)}
                className={`flex w-full items-center gap-2 px-2 py-1 text-left text-xs ${
                  i === active
                    ? 'bg-sky-50 dark:bg-sky-950/40'
                    : 'hover:bg-gray-50 dark:hover:bg-gray-800/60'
                }`}
              >
                <Avatar user={u} size={18} />
                <span className="font-medium text-gray-800 dark:text-gray-100">
                  @{u.githubLogin}
                </span>
                {u.displayName && <span className="truncate text-gray-400">{u.displayName}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
