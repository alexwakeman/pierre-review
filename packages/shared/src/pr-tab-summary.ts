import type { CiStatus, Mergeable, MergeStateStatus, PrReviewDecision, PrState, ThreadStateCounts } from './types.js';

// THE OPEN-TABS HOVER CARD'S ONE READ (docs/API.md § POST /api/prs/tab-summaries; docs/FRONTEND.md
// § The tab hover card). The sidebar's open PR tabs, in ONE batch, the first time a hover card opens:
//
//   POST /api/prs/tab-summaries  { prIds }  →  PrTabSummariesResponse
//
// DB-only (`read` tier): the stored PR row, its repo's name, its author and its thread counts by
// derived state. NO GitHub call, NO model — the card must paint from the database, never hydrate.
// Account-scoped: an id the account does not own is ABSENT (no existence oracle). Over
// `PR_TAB_SUMMARIES_MAX` ids is a 400, never a silent truncation.

/** Over this many ids the route answers 400 (a reader with more open tabs than this is not reading them). */
export const PR_TAB_SUMMARIES_MAX = 100;

export interface PrTabSummariesBody {
  prIds: number[];
}

export interface PrTabSummary {
  id: number;
  repoFullName: string;
  number: number;
  title: string;
  authorLogin: string | null;
  authorDisplayName: string | null;
  state: PrState;
  isDraft: boolean;
  /** As synced. ⚠ Frozen at the merge instant: present tense only on an OPEN PR (`prHeaderCi`). */
  ciStatus: CiStatus;
  mergeable: Mergeable;
  mergeStateStatus: MergeStateStatus;
  /** GitHub's review decision; null = no rule requires a review, or not synced yet. */
  reviewDecision: PrReviewDecision | null;
  /** A POSITIVE observation of GitHub's merge queue holding it (null "not observed" reads false). */
  inMergeQueue: boolean;
  threadCounts: ThreadStateCounts;
}

export interface PrTabSummariesResponse {
  prs: PrTabSummary[];
}
