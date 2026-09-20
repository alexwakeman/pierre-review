import { useMemo } from 'react';
import type { ConflictHunkSuggestion } from '@pierre-review/shared';
import { highlightLines } from '../../lib/hljsLines.js';
import { CodeCell, type CellRow } from './CodeCell.js';
import type { HunkAskState } from './useHunkSuggestion.js';

// ── A PENDING SUGGESTION, INLINE IN THE CENTRE PANE ──────────────────────────────────────────
//
// ⚠ NOT A MODAL, NOT A FOURTH PANE, AND NOT A SIDE-BY-SIDE AGAINST THE DETERMINISTIC MERGE. The
// reader is already parsing three panes, and on the common case the deterministic merge gives
// NOTHING — that is why the button was pressed — so one side of that comparison would be empty. A
// pending suggestion is a sixth state of the same cell, compared against the left and right panes
// already on screen and already aligned to it, which is the comparison the reader actually wants.
// Both side panes stay visible while it is pending; do not collapse them.
//
// ⚠ ONE CODE-DERIVED LINE ABOVE IT, AND NO MODEL-DERIVED FIGURE AT ALL. "12 lines. Keeps 4 lines
// both versions had." are both counted from the text; the model contributes no number to that
// row. That is how "label model-derived and code-derived figures apart" is satisfied here —
// structurally, by there being nothing to label.
//
// ⚠ A REFUSAL IS A NORMAL OUTCOME. The server's own sentence renders where the buttons would be,
// with no error styling and no retry affordance. Refusals are common by design: the validators
// refuse anything they cannot vouch for rather than landing it with a warning.

export function HunkSuggestionPanel({
  state,
  language,
  onUse,
  onDiscard,
}: {
  state: HunkAskState;
  language: string | null;
  onUse: (suggestion: ConflictHunkSuggestion) => void;
  onDiscard: () => void;
}): JSX.Element {
  const suggestion = state.status === 'ready' ? state.suggestion : null;
  const rows = useMemo<CellRow[]>(() => {
    if (suggestion == null) return [];
    const html = highlightLines(suggestion.lines, language);
    return suggestion.lines.map((text, i) => ({
      kind: 'line',
      n: null,
      text,
      html: html?.[i] ?? null,
    }));
  }, [suggestion, language]);

  if (state.status === 'asking') {
    return <Note>Asking Claude…</Note>;
  }
  if (state.status === 'refused') {
    // Verbatim. The server already wrote the shortest honest sentence for this outcome, and a
    // second one composed here would be a second vocabulary for the same fact.
    return <Note>{state.message}</Note>;
  }
  if (suggestion == null) return <Note>Asking Claude…</Note>;

  return (
    <div className="border-l-2 border-ai-signal-fill bg-ai-surface-2">
      <div className="px-2 py-1 text-[11px] text-gray-700 dark:text-gray-200">
        {countLine(suggestion)}
      </div>
      {/* No paint: the panel's own `--ai-*` surface already says whose text this is, and a
          resolver wash here would claim a state the region has not reached. */}
      <CodeCell rows={rows} />
      <div className="flex flex-wrap items-center gap-2 px-2 py-1">
        <button
          type="button"
          onClick={() => onUse(suggestion)}
          className="rounded border border-gray-500 px-1.5 py-0.5 text-[11px] font-medium text-gray-900 hover:bg-gray-100 dark:border-gray-400 dark:text-gray-50 dark:hover:bg-gray-800"
        >
          Use this
        </button>
        <button
          type="button"
          onClick={onDiscard}
          className="rounded border border-gray-300 px-1.5 py-0.5 text-[11px] text-gray-700 hover:border-gray-400 dark:border-gray-700 dark:text-gray-200"
        >
          Discard
        </button>
      </div>
    </div>
  );
}

/** `12 lines. Keeps 4 lines both versions had.` Both counted from the text; the second sentence
 *  is dropped rather than printed as a zero, because "keeps 0 lines both versions had" reads as a
 *  warning about an answer that may be perfectly correct. */
function countLine(s: ConflictHunkSuggestion): string {
  const lines = `${s.lines.length} line${s.lines.length === 1 ? '' : 's'}.`;
  if (s.keptCommonLines === 0) return lines;
  const kept = s.keptCommonLines === 1 ? '1 line' : `${s.keptCommonLines} lines`;
  return `${lines} Keeps ${kept} both versions had.`;
}

function Note({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div className="border-l-2 border-ai-signal-fill bg-ai-surface-2 px-2 py-1 text-[12px] text-gray-700 dark:text-gray-200">
      {children}
    </div>
  );
}
