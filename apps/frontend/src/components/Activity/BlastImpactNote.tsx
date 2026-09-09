import type { CommentAnnotation } from '@pierre-review/shared';
import { SparkleIcon, WarningIcon } from '../Icons.js';
import {
  annotationKey,
  useAnnotationIndex,
  useRunAnnotations,
} from '../../hooks/useAnnotations.js';
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
  const note = useImpactNote(prId, canAsk && hasBlast);
  const { state, run } = useRunAnnotations(prId);

  if (!canAsk || !hasBlast) return null;

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

      {note != null && (
        <div className="flex flex-col items-start gap-0.5">
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
