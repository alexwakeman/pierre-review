// LIMN'S ACTIONS ARE BOTS (docs/CLAUDE-REVIEW.md § Limn's actions are bots; owner rule 2026-11-08:
// "Everything Limn does on my behalf is not me"). Limn writes to GitHub under a person's account;
// every such write is recorded in the provenance ledger (`limn_actions`) and the row it produced is
// stored under the poster's `limn:<login>` bot. This module holds the shared vocabulary.

/** What Limn did on GitHub — one `limn_actions.kind`. */
export type LimnActionKind =
  /** A review it submitted (a summary, an approval, a request for changes, a Sonar review). */
  | 'review'
  /** The empty COMMENTED review GitHub creates around an inline comment or a thread reply. */
  | 'review_wrapper'
  /** A PR-level (issue) comment: a finding off the diff, a story check, a CI review, a rebase request. */
  | 'pr_comment'
  /** A standalone inline review comment (a finding posted on its own). */
  | 'review_comment'
  /** A reply on a review thread (pushback, acknowledgement, "Still open:", a posted draft). */
  | 'reply'
  /** Commits it pushed (AI Fix, the conflict resolver, Implement). One row per pushed commit. */
  | 'push'
  /** A merge it made (an auto-merge landing, a Dependencies merge). */
  | 'merge'
  /** A merge-queue enqueue (the queue merges later, as the person). */
  | 'enqueue'
  | 'dequeue'
  /** A pull request it opened. */
  | 'open_pr'
  /** A thread it resolved or reopened. */
  | 'resolve'
  | 'reaction'
  | 'request_reviewers'
  /** GitHub's "update branch" (a merge commit of the base into the head). */
  | 'branch_update'
  /** A review of its own it dismissed. */
  | 'dismiss'
  /** A `limn/` commit status (a team claim). */
  | 'status'
  /** A PR description it edited (Renovate's rebase checkbox). */
  | 'pr_body'
  | 'close'
  | 'reopen'
  | 'rerun';

export const LIMN_ACTION_KINDS: readonly LimnActionKind[] = [
  'review',
  'review_wrapper',
  'pr_comment',
  'review_comment',
  'reply',
  'push',
  'merge',
  'enqueue',
  'dequeue',
  'open_pr',
  'resolve',
  'reaction',
  'request_reviewers',
  'branch_update',
  'dismiss',
  'status',
  'pr_body',
  'close',
  'reopen',
  'rerun',
];

/** Why Limn wrote: a run nobody pressed (`auto`), the Dependencies policy (`policy`), or a button the
 *  reader pressed that posts Limn's words or lands Limn's work (`reader_pressed`). A plain button the
 *  reader presses with their OWN words (Approve, Merge now, a typed reply) is the reader, not Limn,
 *  and is never recorded. */
export type LimnActionOrigin = 'auto' | 'policy' | 'reader_pressed';

// ── THE COMMIT TRAILER ────────────────────────────────────────────────────────────────────────────
// Every commit Limn creates carries a `Limn-Run: <ref>` git trailer, so any install (a teammate's
// too) recognises the commit as Limn's from its message alone. `<ref>` names the run, e.g.
// `ai-fix/123`, `conflict/45`, `story-build/6`.

export const LIMN_RUN_TRAILER_KEY = 'Limn-Run';

const LIMN_RUN_TRAILER_RE = /^Limn-Run:[ \t]*\S+[ \t]*$/im;

/** The trailer line for one run. The run ref is reduced to `[A-Za-z0-9._/-]`. */
export function limnRunTrailer(runRef: string): string {
  const ref = runRef.replace(/[^A-Za-z0-9._/-]/g, '-').slice(0, 80) || 'run';
  return `${LIMN_RUN_TRAILER_KEY}: ${ref}`;
}

/** A commit message with the trailer appended (once). Pure. */
export function withLimnRunTrailer(message: string, runRef: string): string {
  if (hasLimnRunTrailer(message)) return message;
  const body = message.replace(/\s+$/, '');
  return `${body}\n\n${limnRunTrailer(runRef)}\n`;
}

/** Does this commit message carry a `Limn-Run:` trailer on a line of its own? Pure. */
export function hasLimnRunTrailer(message: string | null | undefined): boolean {
  return typeof message === 'string' && LIMN_RUN_TRAILER_RE.test(message);
}
