import { useCallback, useEffect, useRef, useState } from 'react';
import { copyRich } from '../../lib/copy.js';
import { CheckIcon, CopyIcon } from '../Icons.js';

// The This sprint tab's Copy button: Markdown + HTML through `copyRich` (lib/copy.ts), a visible word
// ("Copy" / "Copy all") because these blocks exist to be pasted elsewhere, and "Copied" for ~1.6 s.
// A real <button> that stops propagation, like CopyButton — it sits inside clickable card headers.

type CopyState = 'idle' | 'copied' | 'failed';
const FEEDBACK_MS = 1600;

export function SprintCopyButton({
  markdown,
  label = 'Copy',
  what,
  className = '',
}: {
  /** The Markdown to copy. Empty → no button. */
  markdown: string;
  /** The visible word at rest. */
  label?: string;
  /** Names the block for assistive tech ("Copy the fixes"). */
  what: string;
  className?: string;
}): JSX.Element | null {
  const [state, setState] = useState<CopyState>('idle');
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
      void copyRich(markdown).then((ok) => {
        setState(ok ? 'copied' : 'failed');
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setState('idle'), FEEDBACK_MS);
      });
    },
    [markdown],
  );
  if (markdown.trim() === '') return null;
  const text = state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : label;
  return (
    <button
      type="button"
      onClick={onCopy}
      aria-label={state === 'idle' ? `Copy ${what}` : text}
      title={state === 'idle' ? `Copy ${what}` : text}
      className={`inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] font-medium transition-colors ${
        state === 'copied'
          ? 'border-emerald-300 text-emerald-700 dark:border-emerald-800 dark:text-emerald-300'
          : state === 'failed'
            ? 'border-amber-300 text-amber-700 dark:border-amber-800 dark:text-amber-300'
            : 'border-gray-300 text-gray-600 hover:border-gray-400 hover:text-gray-800 dark:border-gray-700 dark:text-gray-300 dark:hover:border-gray-500 dark:hover:text-gray-100'
      } ${className}`}
    >
      {state === 'copied' ? <CheckIcon size={11} /> : <CopyIcon size={11} />}
      <span aria-live="polite">{text}</span>
    </button>
  );
}
