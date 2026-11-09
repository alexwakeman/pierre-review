import type { ClaudeTicketCriterionStatus } from './types.js';

// "IS THIS CRITERION DONE?" — THE ONE PREDICATE (docs/CLAUDE-REVIEW.md § Met outside code changes).
// Every reader that asks "is it done" or "is it a gap" goes through `criterionDone`: the chips, the
// sprint cards, the Fill gaps fold and offer, the story counts, auto-posting and the SPA. Two statuses
// are done:
//   met               a pull request delivers it
//   met_outside_code  no pull request delivers it, but a person's ticket comment says the work was
//                     done outside the code (the story check only; the server checks the citation)
// Everything else — partly_met, not_met, unclear, not_checked, and any status an older or newer
// server sends that this build does not know — is NOT done, so it is a gap.
//
// Done is not the same as "met": every total names the two apart ("4 met + 1 outside code of 6"),
// because one rests on code and the other on what someone wrote.

/** Done: met by a pull request, or met outside code changes. */
export function criterionDone(status: ClaudeTicketCriterionStatus | string | null | undefined): boolean {
  return status === 'met' || status === 'met_outside_code';
}

/** A gap a build should close (the complement of `criterionDone`). */
export function criterionIsGap(status: ClaudeTicketCriterionStatus | string | null | undefined): boolean {
  return !criterionDone(status);
}

/** The verdict counts of a criteria list. `unsettled` = unclear + not checked + anything unknown. */
export interface CriterionCounts {
  met: number;
  metOutsideCode: number;
  partlyMet: number;
  notMet: number;
  unclear: number;
  notChecked: number;
  unsettled: number;
  total: number;
}

/** Count a criteria list the one way. Pure. */
export function criterionCounts(criteria: ReadonlyArray<{ status: ClaudeTicketCriterionStatus | string }>): CriterionCounts {
  const c: CriterionCounts = { met: 0, metOutsideCode: 0, partlyMet: 0, notMet: 0, unclear: 0, notChecked: 0, unsettled: 0, total: criteria.length };
  for (const x of criteria) {
    if (x.status === 'met') c.met += 1;
    else if (x.status === 'met_outside_code') c.metOutsideCode += 1;
    else if (x.status === 'partly_met') c.partlyMet += 1;
    else if (x.status === 'not_met') c.notMet += 1;
    else {
      c.unsettled += 1;
      if (x.status === 'unclear') c.unclear += 1;
      else c.notChecked += 1;
    }
  }
  return c;
}

/**
 * "4 met + 1 outside code of 6" — the done part of a count, outside-code named apart. Without any
 * outside-code criterion: "4 of 6". Pure.
 */
export function criteriaDoneWords(c: { met: number; metOutsideCode?: number; total: number }): string {
  const outside = c.metOutsideCode ?? 0;
  return outside > 0 ? `${c.met} met + ${outside} outside code of ${c.total}` : `${c.met} of ${c.total}`;
}
