// WHICH FAILED AUTO RUN AT A PR'S CURRENT HEAD MAY BE RETRIED — the ONE pure fold, read by the
// candidate read (db/queries.ts `getAutoReviewCandidates`), the lane's start-time re-check
// (review/claude-review/persist.ts `isAutoRetryStillDue`) and the AI Review tab's Retry line
// (`ClaudeReviewResponse.failedAutoAtHead`). Two rules, decided 2026-10-27:
//
//   • AUTOMATIC (the sweeper's own ticks): the LATEST row at the head is a FAILED AUTO run and
//     nothing at that head SUCCEEDED — manual or auto. A reader who reviewed the head by hand made it
//     final, so background quota is never spent re-reviewing it.
//   • A READER'S PRESS ("Run auto reviews now", or "Retry" on one PR): the head is done only when an
//     AUTO run SUCCEEDED at it. MANUAL rows at the head are ignored for this decision: the latest
//     AUTO row at the head must be a failure, even when manual runs (succeeded or failed) came after
//     it. A row in flight at the head still blocks.
//
// `rows` are the PR's `claude_reviews` rows AT THE CURRENT HEAD (any order). Returns the failed auto
// run to retry, or null.

export interface RunAtHead {
  id: number;
  status: string;
  trigger: string | null;
}

const latestOf = <T extends RunAtHead>(rows: readonly T[]): T | null =>
  rows.length === 0 ? null : rows.reduce((a, b) => (b.id > a.id ? b : a));

/** The sweeper's own tick: the latest row at the head is a failed AUTO run, nothing there succeeded. */
export function automaticRetryTarget<T extends RunAtHead>(rows: readonly T[]): T | null {
  const last = latestOf(rows);
  if (!last || last.trigger !== 'auto' || last.status !== 'failed') return null;
  if (rows.some((r) => r.status === 'succeeded')) return null;
  return last;
}

/** A reader's press: the latest AUTO row at the head failed and no AUTO row there succeeded; manual
 *  rows are ignored, except that nothing at the head may be queued or running. */
export function pressRetryTarget<T extends RunAtHead>(rows: readonly T[]): T | null {
  if (rows.some((r) => r.status === 'queued' || r.status === 'running')) return null;
  const auto = rows.filter((r) => r.trigger === 'auto');
  const last = latestOf(auto);
  if (!last || last.status !== 'failed') return null;
  if (auto.some((r) => r.status === 'succeeded')) return null;
  return last;
}
