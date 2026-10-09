import { useState } from 'react';
import { undoAllClaudeChoices, useClaudeLiveCount } from '../../store/conflictClaude.js';
import { ChevronIcon, SparkleIcon, UndoIcon } from '../Icons.js';

/**
 * One line above the panes when the resolver was pre-filled by "Resolve with Claude": how many of
 * the changes are still Claude's choice, and the one control that clears them all.
 *
 * ⚠ RENDERS NOTHING WITHOUT A RUN. The resolver opened by hand looks exactly as it did.
 * ⚠ IT COUNTS LIVE CHOICES, not the run's total: a choice the reader replaced is theirs now.
 */
export function ClaudeResolutionBanner(): JSX.Element | null {
  const { live, run } = useClaudeLiveCount();
  const [notesOpen, setNotesOpen] = useState(false);
  if (run == null) return null;
  const total = Object.keys(run.marks).length;

  const sentence =
    total === 0
      ? 'Claude left every change for you.'
      : live === 0
        ? 'None of Claude’s choices are left.'
        : `Claude decided ${live} of ${run.decidableTotal} change${run.decidableTotal === 1 ? '' : 's'}. Check each one before you commit.`;

  return (
    <div className="shrink-0 border-b border-gray-200 px-4 py-1.5 text-[12px] text-gray-700 dark:border-gray-800 dark:text-gray-200">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="inline-flex items-center gap-1">
          <SparkleIcon size={12} className="text-ai-signal" />
          {sentence}
        </span>
        {live > 0 && (
          <button
            type="button"
            onClick={undoAllClaudeChoices}
            className="inline-flex items-center gap-1 rounded border border-gray-300 px-1.5 py-0.5 text-[11px] hover:border-gray-400 dark:border-gray-700 dark:hover:border-gray-500"
          >
            <UndoIcon size={12} />
            Undo all Claude’s choices
          </button>
        )}
        {run.summary != null && run.summary !== '' && (
          <button
            type="button"
            aria-expanded={notesOpen}
            onClick={() => setNotesOpen((o) => !o)}
            className="inline-flex items-center gap-1 text-[11px] text-gray-600 underline-offset-2 hover:underline dark:text-gray-300"
          >
            <ChevronIcon dir={notesOpen ? 'down' : 'right'} size={11} />
            Claude’s notes
          </button>
        )}
      </div>
      {notesOpen && run.summary != null && (
        <p className="mt-1 max-w-3xl whitespace-pre-wrap text-[12px] text-gray-600 dark:text-gray-300">
          {run.summary}
        </p>
      )}
    </div>
  );
}
