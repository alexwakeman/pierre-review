import type { DiffPart } from '../../lib/wordDiff.js';

// Reports → This sprint: a word diff (lib/wordDiff.ts) as text — the finding thread's Suggested, the
// proposals, the confirm dialog.

const MUTED = 'text-gray-500 dark:text-gray-400';

/** A word diff: added words marked yellow, removed ones struck through and muted. */
export function DiffText({ parts }: { parts: readonly DiffPart[] }): JSX.Element {
  return (
    <>
      {parts.map((p, i) =>
        p.kind === 'same' ? (
          <span key={i}>{p.text}</span>
        ) : p.kind === 'added' ? (
          // Trailing whitespace (a line break) stays outside the mark, or it paints an empty sliver.
          <span key={i}>
            <mark className="story-mark">{p.text.trimEnd()}</mark>
            {p.text.slice(p.text.trimEnd().length)}
          </span>
        ) : (
          <del key={i} className={`line-through ${MUTED}`}>
            {p.text}
          </del>
        ),
      )}
    </>
  );
}
