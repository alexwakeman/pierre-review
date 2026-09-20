import { useEffect, useRef, useState } from 'react';
import {
  EDIT_CANCEL,
  EDIT_HINT,
  EDIT_PANEL_TITLE,
  EDIT_SAVE,
  EDIT_SAVING,
  editFieldLabel,
} from './copy.js';
import type { RegionEditState } from './useRegionEdit.js';

// ── THE ONE TEXT BOX IN THE RESOLVER ─────────────────────────────────────────────────────────
//
// ⚠ A PANEL UNDER THE CENTRE CELL — NOT A `contenteditable`, AND NOT A TEXTAREA REPLACING THE
// CELL. It mounts in the same slot `HunkSuggestionPanel` uses, and the placement is three
// decisions at once:
//
//   1. `data-mr-cell` STAYS ON A CONTENT-SIZED BOX. The ribbon overlay measures that rectangle
//      (`CodeCell`'s ⚠), and it is deliberately not the stretched grid cell. Putting an editor
//      inside it would make the hunk's rect the editor's height and every ribbon in the file
//      would point at the wrong place.
//   2. `CodeCell` STAYS A PURE MEMO WITH NO LOCAL STATE. It re-renders on a shallow prop compare
//      across every row of a four-hundred-region file; a caret in it would put a keystroke's
//      state there.
//   3. HIGHLIGHT.JS OUTPUT NEVER GOES UNDER A CARET. `hljsLines.ts` is explicit that only hljs
//      output may reach `dangerouslySetInnerHTML`, and an editable element whose innerHTML is
//      generated markup is how that rule gets broken by accident. So the box is plain text, in
//      the same monospace metrics as the pane above it, and the highlighted render comes back
//      the moment it is saved.
//
// The grid already tolerates a taller centre cell: `RegionRibbons`' `ResizeObserver` names the
// suggestion panel mounting as a height change it re-measures through, and this is that same
// change.
//
// ⚠ THE DRAFT IS RENDERED HERE AND REMEMBERED IN THE HOOK, AND THAT SPLIT IS THE POINT. The
// keystroke state is local, because a keystroke must not re-render the file's other regions; a
// copy is mirrored into `useRegionEdit`'s ref by `onDraft`, which costs no render at all. It has
// to be, because this panel UNMOUNTS on a file switch while its editor state stays open: only the
// active file's rows exist, so the box used to come back open, in place, with the seed in it and
// the reader's sentence gone — no message, no confirm, nothing on screen changed. The draft still
// never reaches `store/conflictResolver.ts`, which holds CHOICES only, and nothing is sent until
// Save.
//
// ⚠ NO NEW DEPENDENCY, AND NO CODE EDITOR. A textarea in the resolver's own metrics is the whole
// feature: the reader is fixing a brace or a comma against three panes of context they can
// already see. An editor component would bring highlighting under the caret (see 3), its own key
// bindings to fight `ResolverPanes`' single-key verbs, and a bundle.

export function RegionEditPanel({
  state,
  seed,
  path,
  ordinal,
  total,
  onDraft,
  onSave,
  onCancel,
}: {
  state: RegionEditState;
  /** What the box opens with: the reader's remembered draft if there is one, else the region's
   *  CURRENT folded centre lines, joined. Editing starts from what is on screen — including a
   *  previous edit, so a second pass picks up where the first left off. */
  seed: string;
  path: string;
  ordinal: number;
  total: number;
  /** Mirror each keystroke into `useRegionEdit`'s draft ref, so a file switch does not lose it. */
  onDraft: (text: string) => void;
  onSave: (text: string) => void;
  onCancel: () => void;
}): JSX.Element {
  const [text, setText] = useState(seed);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // ⚠ SEEDED ONCE PER MOUNT, NEVER SYNCED. `seed` is derived from the slot, and the slot changes
  // the instant a save lands — a `useEffect` mirroring it into state would overwrite whatever the
  // reader had typed since. Every route back into this box is a fresh mount (the panel is keyed
  // by `${fileIndex}:${regionId}` two levels up, so even a file switch remounts rather than
  // reconciling), and the seed it is given already carries the remembered draft.
  //
  // ⚠ AND FOCUS GOES BACK WHERE IT CAME FROM. Nothing else restores it: Save unmounts this panel
  // outright, so focus fell to `document.body` — which is OUTSIDE `#root`, where React's listener
  // lives, so every single-key verb in the panes (`n`/`p`/`←`/`→`/`w`/`u`/Enter) silently stopped
  // working and Escape started offering to close the whole resolver. The element that opened the
  // box is the strip's Edit button, which stays mounted throughout.
  // ⚠ THE CLEANUP TEST IS "IS FOCUS ABOUT TO BE DESTROYED", NOT "HAS IT ALREADY FALLEN TO BODY".
  // This read `if (now !== document.body) return;`, which looks equivalent and is the opposite of
  // what happens: on Save the caret is STILL IN THE TEXTAREA when the cleanup runs — React has not
  // detached the node yet — so `now` was the textarea, the guard bailed as if the reader had moved
  // on, and focus fell to `<body>` a moment later with nothing left to restore it. Verified in the
  // browser: the Edit button was genuinely focused before opening and focus still ended on `body`.
  // So the question is whether focus is inside the box that is disappearing; `panel.contains(now)`
  // is that question, and it still stands aside when the reader really did click elsewhere first.
  useEffect(() => {
    const cameFrom = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    ref.current?.focus();
    return () => {
      const now = document.activeElement;
      const losingIt = now == null || now === document.body || panel?.contains(now) === true;
      if (!losingIt) return;
      if (cameFrom?.isConnected === true) cameFrom.focus();
    };
  }, []);

  // ⚠ `readOnly`, NOT `disabled`. A browser BLURS a disabled element, so pressing Save took the
  // caret away — and on a refusal the box stays open with the server's sentence above it and the
  // reader's text in it, which is precisely the moment they need the caret to fix it.
  const busy = state.status === 'saving';
  return (
    // ⚠ NO RESOLVER COLOUR AND NO `--ai-*` SURFACE. The four `mr-*` roles mean change, conflict,
    // applied and ignored — states of a REGION — and an open box has reached none of them: the
    // region is exactly as decided as it was before the reader pressed Edit. The suggestion
    // panel's violet says "a model wrote this", which is the opposite claim to the one here. So:
    // a neutral tray, and the region's own encodings above it go on saying what they said.
    <div
      ref={panelRef}
      className="border-l-2 border-gray-300 bg-gray-50 dark:border-gray-700 dark:bg-gray-900"
    >
      <div className="px-2 py-1 text-[11px] font-medium text-gray-700 dark:text-gray-200">
        {EDIT_PANEL_TITLE}
      </div>
      {state.status === 'refused' && (
        // Verbatim, and above the box rather than replacing it: the reader's text is still there
        // and this says what to change about it.
        <div className="px-2 pb-1 text-[12px] text-gray-800 dark:text-gray-100">
          {state.message}
        </div>
      )}
      <textarea
        ref={ref}
        value={text}
        readOnly={busy}
        aria-busy={busy || undefined}
        onChange={(e) => {
          setText(e.target.value);
          onDraft(e.target.value);
        }}
        aria-label={editFieldLabel(path, ordinal, total)}
        spellCheck={false}
        // ⚠ THE PANE'S OWN METRICS — 12px / 18px line height, monospace, wrapping rather than
        // scrolling sideways. Anything else and the reader is editing text that does not line up
        // with the three panes they are editing it against. `rows` tracks the draft's own line
        // count so a short hunk gets a short box, capped at 60vh and at 24 rows, after which it
        // scrolls inside itself rather than pushing the panes off screen.
        className="block max-h-[60vh] w-full resize-y border-0 bg-transparent px-2 py-1 font-mono text-[12px] leading-[18px] text-gray-900 outline-none read-only:opacity-60 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-sky-600 dark:text-gray-100 dark:focus-visible:ring-sky-400"
        rows={Math.min(24, Math.max(3, text.split('\n').length + 1))}
      />
      <div className="flex flex-wrap items-center gap-2 px-2 py-1">
        <button
          type="button"
          disabled={busy}
          onClick={() => onSave(text)}
          className="rounded border border-gray-500 px-1.5 py-0.5 text-[11px] font-medium text-gray-900 hover:bg-gray-100 disabled:opacity-60 dark:border-gray-400 dark:text-gray-50 dark:hover:bg-gray-800"
        >
          {busy ? EDIT_SAVING : EDIT_SAVE}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded border border-gray-300 px-1.5 py-0.5 text-[11px] text-gray-700 hover:border-gray-400 dark:border-gray-700 dark:text-gray-200"
        >
          {EDIT_CANCEL}
        </button>
        {/* 12px, not 11: it is a sentence, and 11 is the floor for a LABEL. */}
        <span className="text-[12px] text-gray-600 dark:text-gray-300">{EDIT_HINT}</span>
      </div>
    </div>
  );
}
