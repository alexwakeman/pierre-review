import { useCallback, useState } from 'react';
import type { CommentAnnotation } from '@pierre-review/shared';
import { ChevronIcon, SparkleIcon, WarningIcon } from '../Icons.js';
import {
  annotationKey,
  useAnnotationIndex,
  useRunAnnotations,
} from '../../hooks/useAnnotations.js';
import { useBlastConfig } from '../../hooks/useBlastRadius.js';
import { useProCapabilities } from '../../hooks/useTriage.js';

// ── THE IMPACT NOTE — blast radius's Pro half ────────────────────────────────────────────────
//
// THE CODE DECIDES THE LEVEL, FREE; THE MODEL EXPLAINS THE CONSEQUENCE, PAID. Exactly the split
// the work plan and Chronology live by. The chip beside this says Low / Medium / High and lists
// the signals that decided it; this adds the one thing file paths cannot answer — what could
// break, and what to read first.
//
// ⚠ IT MAY NEVER LOWER THE LEVEL. The model's only verdicts are `concern` (raise a
// separately-labelled flag BESIDE the chip) and `none` (add a sentence, change nothing). There is
// no value it can return that makes a pull request look safer, because a model that can say
// "actually this is fine" is a model that can talk a maintainer out of reviewing a migration.
// Escalation is safe precisely because its only effect is making someone look harder.
//
// ⚠ PR DETAIL ONLY, AND CLICK-GATED. It is a billed call, so it may not appear on a Pending card
// or in the timeline — the board may not fetch on mount, and a board that billed on mount would
// be worse still. Nothing here requests anything until the button is pressed; the stored note is
// read from the ONE shared per-PR annotation query every other annotation surface uses.
//
// ⚠ A PR WITH NOTHING STORED RENDERS THE BUTTON AND NOTHING ELSE — no placeholder box, no
// "not generated yet" chrome. Same rule as `CommentAnnotations`, and for the same reason.

// WHERE THE COLLAPSED STATE LIVES BETWEEN PAGE LOADS.
//
// localStorage, per this codebase's stated rule for a lightweight per-viewer convenience: whether
// this browser currently shows a panel folded is a fact about this browser. Wrapped in try/catch
// and correct when it comes back empty (an empty read means EXPANDED, which is the default).
//
// ⚠ IT IS NOT `showImpactNote`, AND THE TWO ARE DIFFERENT QUESTIONS. That one is a server field
// meaning "never offer this feature at all" — it removes the button, stops the query, and syncs
// across devices because it is a real preference. This one is a disclosure: the note is still
// offered, it is just folded right now, and one click unfolds it. Collapsing used to write the
// server field, which made "hide" a one-way trip to Settings — the defect this replaces.
//
// ⚠ NOT the Zustand filter store either: that persists and RESETS from one shared list, so
// "Clear filters" would silently unfold every note — the same trap `workspaceId` is kept out of
// FilterDefaults to avoid.
const COLLAPSE_KEY = 'limn.blastImpactNote.collapsed.v1';

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === '1';
  } catch {
    // A browser with site data blocked still gets a working, expanded note.
    return false;
  }
}

function writeCollapsed(v: boolean): void {
  try {
    if (v) localStorage.setItem(COLLAPSE_KEY, '1');
    else localStorage.removeItem(COLLAPSE_KEY);
  } catch {
    /* per-viewer convenience only — a failed write costs nothing but the memory of the choice */
  }
}

/** Read the stored impact note for this PR, if one exists. Never fetches on its own — it looks
 *  into the shared `['pr-annotations', prId]` index. */
function useImpactNote(prId: number, enabled: boolean): CommentAnnotation | undefined {
  const index = useAnnotationIndex(prId, enabled);
  return index?.get(annotationKey('impact', 'pull_request', prId));
}

export function BlastImpactNote({
  prId,
  /** True when the blast-radius chip beside this is rendering something. With no chip there is
   *  nothing to explain, so there is no button either — the same "we never measured this pull
   *  request" population the chip stays silent for. */
  hasBlast,
}: {
  prId: number;
  hasBlast: boolean;
}): JSX.Element | null {
  // ⚠ THE CAPABILITY IS ANDed INTO THE HOOK'S OWN `enabled`, not just used to hide a button —
  // otherwise the SPA polls a route that 402s. Server-enforced too; a client gate is not a
  // monetisation gate.
  const canAsk = useProCapabilities().prSummary;
  // The reader's own preference, account-grained beside the sensitivity dial. ⚠ ANDed into
  // `enabled` for the same reason the capability is: hiding the note must stop the QUERY too, or
  // "hidden" still costs a request on every PR open.
  const wanted = useBlastConfig().showImpactNote;
  const [collapsed, setCollapsed] = useState(readCollapsed);
  // ⚠ THE WRITE IS IN THE HANDLER, NOT INSIDE THE STATE UPDATER — and that is a correctness rule,
  // not style. A `setCollapsed((v) => { writeCollapsed(!v); return !v; })` looks equivalent and is
  // not: React invokes updaters TWICE under StrictMode, the second pass against the already-
  // toggled state, so the effect ran as write(true) then write(false) and the `removeItem` half
  // won. The note collapsed on screen and was expanded again on the next load, every time.
  // Updater functions must be pure; this one now is.
  const toggle = useCallback(() => {
    setCollapsed((v) => !v);
    writeCollapsed(!collapsed);
  }, [collapsed]);
  const note = useImpactNote(prId, canAsk && hasBlast && wanted);
  const { state, run } = useRunAnnotations(prId);

  if (!canAsk || !hasBlast || !wanted) return null;

  const concern = note?.verdict === 'concern';

  return (
    <div className="mt-1.5 flex flex-col items-start gap-1">
      {note == null && (
        <button
          type="button"
          onClick={() => run('impact')}
          disabled={state.running}
          className="inline-flex items-center gap-1 rounded text-[11px] text-gray-500 hover:text-gray-700 disabled:opacity-60 dark:text-gray-400 dark:hover:text-gray-200"
        >
          <SparkleIcon size={11} />
          {state.running ? 'Reading the change…' : 'What could this break?'}
        </button>
      )}

      {/* COLLAPSED: a one-line stub that says what is folded away and unfolds on a click. It is
          rendered only when there IS a note — collapsing must never hide the "What could this
          break?" button, or a reader who once folded a note could not ask for one again. */}
      {note != null && collapsed && (
        <button
          type="button"
          onClick={toggle}
          className="inline-flex items-center gap-1 text-[11px] text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
          aria-expanded={false}
        >
          <ChevronIcon size={11} dir="right" />
          Impact note
          {/* The escalation survives the fold. Hiding the fact that something was flagged is the
              one thing a collapse may not do. */}
          {concern && <span className="text-amber-600 dark:text-amber-500">· flagged</span>}
        </button>
      )}

      {note != null && !collapsed && (
        <div className="flex flex-col items-start gap-0.5">
          <button
            type="button"
            onClick={toggle}
            className="inline-flex items-center gap-1 text-[11px] text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
            aria-expanded
          >
            <ChevronIcon size={11} dir="down" />
            Impact note
          </button>
          {/* The ESCALATION, as its own labelled line — beside the deterministic chip, never
              instead of it. A reader must be able to tell which half of the screen is computed
              and which half a model wrote; a panel that mixes them without labelling them apart
              is the defect the AI-surface rules name. */}
          {concern && (
            <span className="inline-flex items-center gap-1 text-[11px] text-amber-600 dark:text-amber-500">
              <WarningIcon size={11} className="inline-block align-[-0.1em]" />
              Flagged on a closer read
            </span>
          )}
          <p className="max-w-prose text-[12px] leading-snug text-gray-600 dark:text-gray-300">
            {note.body}
          </p>
          <div className="flex items-center gap-2 text-[11px] text-gray-400 dark:text-gray-500">
            {/* Says who wrote it. Two sentences of prose beside a computed chip must not be
                mistaken for another computed fact. */}
            <span>Written by {note.model}</span>
            {/* ⚠ NO "hide for good" LINK HERE ANY MORE. It wrote the server preference, which made
                one click a one-way trip that could only be undone in Settings. The caret above is
                the reversible control; Settings keeps the permanent switch. */}
            {note.stale && (
              // The pull request has changed since this was written. ⚠ The re-run is the SAME
              // billed path; it is offered, never taken automatically.
              <button
                type="button"
                onClick={() => run('impact')}
                disabled={state.running}
                className="underline hover:text-gray-600 disabled:opacity-60 dark:hover:text-gray-300"
              >
                {state.running ? 'Re-reading…' : 'Out of date — read again'}
              </button>
            )}
          </div>
        </div>
      )}

      {state.error != null && (
        <span className="text-[11px] text-red-500">{state.error}</span>
      )}
      {state.result?.creditsExhausted === true && (
        <span className="text-[11px] text-gray-500 dark:text-gray-400">
          Out of AI credits for this month.
        </span>
      )}
    </div>
  );
}
