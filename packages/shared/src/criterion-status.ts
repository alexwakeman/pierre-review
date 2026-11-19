import type { ClaudeTicketCriterionStatus, TicketCriterionOutside } from './types.js';

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
//
// A `met` delivered ONLY by code outside the ticket's PRs (`outside`, docs/CLAUDE-REVIEW.md § Ticket
// review → Outside the ticket) IS met and counts in `met`, but is named apart too:
// `metOutsideTicket` ("4 of 6, 1 already outside the ticket").

/** Done: met by a pull request, or met outside code changes. */
export function criterionDone(status: ClaudeTicketCriterionStatus | string | null | undefined): boolean {
  return status === 'met' || status === 'met_outside_code';
}

/**
 * DONE FOR A LOOP OR A BUILD (docs/STORY-BUILD.md § The review loop → Code outside the ticket): the
 * review loops (Implement's, AI Fix's, the local branch review's) and Fill gaps keep working on a criterion
 * met ONLY by an UNLINKED same-branch PR — nothing on the ticket delivers it yet. One met by another
 * repository's DEFAULT BRANCH is done. The ticket review itself counts both as met (labelled apart). Pure.
 */
export function criterionDoneForBuild(
  status: ClaudeTicketCriterionStatus | string | null | undefined,
  outside?: Pick<TicketCriterionOutside, 'kind'> | null,
): boolean {
  return criterionDone(status) && !(status === 'met' && outside?.kind === 'unlinked_pr');
}

/** A gap a build should close (the complement of `criterionDone`). */
export function criterionIsGap(status: ClaudeTicketCriterionStatus | string | null | undefined): boolean {
  return !criterionDone(status);
}

/** The verdict counts of a criteria list. `unsettled` = unclear + not checked + anything unknown. */
export interface CriterionCounts {
  met: number;
  // Of `met`: only code outside the ticket's PRs delivers it (`TicketCriterion.outside`).
  metOutsideTicket: number;
  metOutsideCode: number;
  partlyMet: number;
  notMet: number;
  unclear: number;
  notChecked: number;
  unsettled: number;
  total: number;
}

/** Count a criteria list the one way. Pure. */
export function criterionCounts(
  criteria: ReadonlyArray<{ status: ClaudeTicketCriterionStatus | string; outside?: TicketCriterionOutside | null }>,
): CriterionCounts {
  const c: CriterionCounts = { met: 0, metOutsideTicket: 0, metOutsideCode: 0, partlyMet: 0, notMet: 0, unclear: 0, notChecked: 0, unsettled: 0, total: criteria.length };
  for (const x of criteria) {
    if (x.status === 'met') {
      c.met += 1;
      if (x.outside != null) c.metOutsideTicket += 1;
    }
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

/** ", 1 already outside the ticket" — of the met criteria, those only code outside the ticket delivers
 *  (still met, named apart); '' for none. Appended after a count's noun by every count that names it. */
export function outsideTicketWords(c: { metOutsideTicket?: number }): string {
  const n = c.metOutsideTicket ?? 0;
  return n > 0 ? `, ${n} already outside the ticket` : '';
}

/**
 * Where work with no PR on the ticket belongs, in words: "No PR yet in acme/api", or — a related repository
 * with an open PR on the same branch that is not linked — "acme/web#88 is on the same branch but not linked
 * to the ticket". Pure.
 */
export function noPrWords(repo: string, unlinked: { number: number } | null | undefined): string {
  return unlinked != null ? `${repo}#${unlinked.number} is on the same branch but not linked to the ticket` : `No PR yet in ${repo}`;
}

/**
 * A criterion met only by code outside the ticket, in words: "Already in acme/api (no PR on this ticket)"
 * or "In api#88 (same branch, not linked to the ticket)". Pure.
 */
export function criterionOutsideWords(o: Pick<TicketCriterionOutside, 'kind' | 'repo' | 'number'>): string {
  if (o.kind === 'unlinked_pr' && o.number != null) {
    const name = o.repo.includes('/') ? o.repo.slice(o.repo.indexOf('/') + 1) : o.repo;
    return `In ${name}#${o.number} (same branch, not linked to the ticket)`;
  }
  return `Already in ${o.repo} (no PR on this ticket)`;
}
