import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckIcon, CopyIcon } from './Icons.js';

// Copy one comment's text to the clipboard, VERBATIM.
//
// "Verbatim" is the whole contract: it copies the stored markdown SOURCE, not the rendered
// DOM. A reader copying a bot's finding wants the ``` fences, the `- [ ]` boxes, the link
// syntax and the suggestion block intact so it can be pasted into an editor, an issue or a
// prompt — a DOM read (innerText) silently flattens all of that, and drops the parts the
// renderer collapses (the `<details>` bodies CodeRabbit and Cursor both use heavily). Every
// call site already holds the source string it handed to <Markdown>, so it passes that.
//
// ⚠ IT MUST BE A REAL <button> AND IT MUST STOP PROPAGATION. These render inside cards that
// are themselves clickable in several surfaces — ThreadCard's header opens the thread in its
// PR, and its guard is `closest('a,button,input,textarea,[data-noactivate]')`. A <span> here
// would copy AND navigate away; the explicit stopPropagation covers the mounts that don't use
// that guard at all.

type CopyState = 'idle' | 'copied' | 'failed';

/** How long the confirmation sits before reverting to the idle icon. */
const FEEDBACK_MS = 1600;

/**
 * Write to the clipboard, with a fallback for the contexts the async API refuses.
 *
 * `navigator.clipboard` needs a SECURE CONTEXT. That covers this app in practice (cloud is
 * HTTPS, and `localhost` counts as secure), but not a dev server reached over the LAN by IP —
 * `http://192.168.x.x:5173`, which is exactly how someone demos this on a phone — where the
 * API is simply `undefined`. The textarea + `execCommand` path is deprecated and still the
 * only thing that works there, so it stays as a fallback rather than the primary.
 */
async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Rejected (permission denied, or the document wasn't focused) — fall through and retry
    // the legacy path rather than reporting failure on the strength of one API.
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    // Off-screen but still focusable: `display:none` or `hidden` makes the selection fail.
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export function CopyButton({
  text,
  what = 'comment',
  className = '',
}: {
  /** The exact string to place on the clipboard — the markdown source, not rendered text. */
  text: string;
  /** Names the target in the tooltip and the accessible name ("Copy comment"). */
  what?: string;
  className?: string;
}): JSX.Element | null {
  const [state, setState] = useState<CopyState>('idle');
  // The pending revert, cleared on unmount: these buttons live in virtualised/paged lists
  // (the feed, the flagging drill-down), so a card can unmount well inside the feedback window.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const onCopy = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      void writeClipboard(text).then((ok) => {
        setState(ok ? 'copied' : 'failed');
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setState('idle'), FEEDBACK_MS);
      });
    },
    [text],
  );

  // Nothing to copy is not a disabled button, it is no button — an empty body (an approval with
  // no text) should not grow a dead control.
  if (text.trim() === '') return null;

  const label =
    state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : `Copy ${what}`;
  return (
    <button
      type="button"
      onClick={onCopy}
      title={
        state === 'idle'
          ? `Copy this ${what}'s text to the clipboard, exactly as written`
          : label
      }
      aria-label={label}
      className={`inline-flex shrink-0 items-center gap-1 rounded px-1 py-0.5 text-[10px] font-medium transition-colors ${
        state === 'copied'
          ? 'text-emerald-600 dark:text-emerald-400'
          : state === 'failed'
            ? 'text-amber-600 dark:text-amber-400'
            : 'text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800 dark:hover:text-gray-200'
      } ${className}`}
    >
      {state === 'copied' ? <CheckIcon /> : <CopyIcon />}
      {/* The word only appears once something has happened. At rest this is a bare icon, so it
          can sit in a dense comment header without competing with the author and timestamp;
          `aria-label` carries the full name for assistive tech either way. */}
      {state !== 'idle' && <span>{label}</span>}
    </button>
  );
}
