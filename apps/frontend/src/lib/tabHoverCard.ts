import type {
  CiStatus,
  DerivedState,
  Mergeable,
  MergeStateStatus,
  PrDetail,
  PrReviewDecision,
  PrState,
  PrTabSummary,
  ThreadStateCounts,
  TimelinePr,
} from '@pierre-review/shared';
import type { Tab, TabMeta } from '../store/pinnedTabs.js';
import { DERIVED_STATE_META } from './ui.js';

// THE OPEN-TABS HOVER CARD'S FACTS (docs/FRONTEND.md § The tab hover card). Pure, so the merge of
// the card's sources is pinned in test/tabHoverCard.test.ts.
//
// ⚠ NO SOURCE IS FETCHED FOR ONE CARD. A PR card paints from what the app already holds, newest read
// first: the batched DB-only summary (`POST /api/prs/tab-summaries`, ONE request for every PR tab,
// made the first time any card opens) and the PR's own detail (`['pr', id]`, cached when the tab was
// opened), then a row of an Open PRs list, then the tab's own label meta. A fact no source holds is
// UNKNOWN and its row is left out, never drawn as a zero.

/** The PR tabs' ids, sorted and unique: ONE key for the shared summary read, whichever card asks. */
export function prTabIds(tabs: readonly Pick<Tab, 'kind' | 'prId'>[]): number[] {
  const ids = new Set<number>();
  for (const t of tabs) if ((t.kind === 'pr-detail' || t.kind === 'pr-focus') && t.prId > 0) ids.add(t.prId);
  return [...ids].sort((a, b) => a - b);
}

export interface PrTabFacts {
  repoFullName: string | null;
  number: number | null;
  title: string | null;
  authorLogin: string | null;
  authorDisplayName: string | null;
  /** null = no source has the row yet (the card shows the label meta only). */
  state: PrState | null;
  isDraft: boolean;
  ciStatus: CiStatus | null;
  mergeable: Mergeable | null;
  mergeStateStatus: MergeStateStatus | null;
  /** `undefined` = not known (only an Open PRs row was cached, and it carries no decision);
   *  `null` = known: GitHub has no decision (no rule requires a review). */
  reviewDecision: PrReviewDecision | null | undefined;
  inMergeQueue: boolean;
  threadCounts: ThreadStateCounts | null;
}

export interface PrTabSources {
  meta: TabMeta | null;
  summary?: { data: PrTabSummary; at: number } | null;
  detail?: { data: PrDetail; at: number } | null;
  openPr?: TimelinePr | null;
}

function countsOf(threads: PrDetail['threads']): ThreadStateCounts {
  const c: ThreadStateCounts = { resolved: 0, likely_addressed: 0, replied_unresolved: 0, untouched: 0 };
  for (const t of threads) c[t.derivedState] += 1;
  return c;
}

/** One card's facts from whatever is held. Between the summary and the detail the NEWER read wins. */
export function prTabFacts(src: PrTabSources): PrTabFacts {
  const m = src.meta;
  const base: PrTabFacts = {
    repoFullName: m?.repoFullName ?? null,
    number: m?.number ?? null,
    title: m?.title ?? null,
    authorLogin: m?.authorLogin ?? null,
    authorDisplayName: m?.authorDisplayName ?? null,
    state: null,
    isDraft: false,
    ciStatus: null,
    mergeable: null,
    mergeStateStatus: null,
    reviewDecision: undefined,
    inMergeQueue: false,
    threadCounts: null,
  };
  const s = src.summary;
  const d = src.detail;
  if (s != null && (d == null || s.at >= d.at)) {
    const p = s.data;
    return {
      ...base,
      repoFullName: p.repoFullName,
      number: p.number,
      title: p.title,
      authorLogin: p.authorLogin ?? base.authorLogin,
      authorDisplayName: p.authorDisplayName ?? base.authorDisplayName,
      state: p.state,
      isDraft: p.isDraft,
      ciStatus: p.ciStatus,
      mergeable: p.mergeable,
      mergeStateStatus: p.mergeStateStatus,
      reviewDecision: p.reviewDecision,
      inMergeQueue: p.inMergeQueue,
      threadCounts: p.threadCounts,
    };
  }
  if (d != null) {
    const p = d.data;
    const author = p.authorId != null ? p.users.find((u) => u.id === p.authorId) : undefined;
    return {
      ...base,
      repoFullName: p.repoFullName,
      number: p.number,
      title: p.title,
      authorLogin: author?.githubLogin ?? base.authorLogin,
      authorDisplayName: author?.displayName ?? base.authorDisplayName,
      state: p.state,
      isDraft: p.isDraft,
      ciStatus: p.ciStatus,
      mergeable: p.mergeable,
      mergeStateStatus: p.mergeStateStatus,
      reviewDecision: p.reviewDecision ?? null,
      inMergeQueue: p.inMergeQueue === true,
      threadCounts: countsOf(p.threads),
    };
  }
  const o = src.openPr;
  if (o != null) {
    return {
      ...base,
      number: o.number,
      title: o.title,
      state: o.state,
      isDraft: o.isDraft,
      ciStatus: o.ciStatus,
      mergeable: o.mergeable,
      mergeStateStatus: o.mergeStateStatus,
      // A lean row says approved / changes requested, but not "review required" from "no rule":
      // anything else is unknown, and its row is left out.
      reviewDecision: o.isChangesRequested ? 'changes_requested' : o.isApproved ? 'approved' : undefined,
      threadCounts: o.threadCounts,
    };
  }
  return base;
}

/** GitHub's review decision in the PR header's words (components/pr/ReviewDecisionPill.tsx). */
export function reviewDecisionWords(decision: PrReviewDecision | null): string {
  switch (decision) {
    case 'approved':
      return 'Approved';
    case 'changes_requested':
      return 'Changes requested';
    case 'review_required':
      return 'Review required';
    default:
      return 'Reviews optional';
  }
}

/** The thread states that have threads, most urgent first, in the Threads tab's words and colours. */
const THREAD_ORDER: readonly DerivedState[] = ['untouched', 'replied_unresolved', 'likely_addressed', 'resolved'];
export function threadStateParts(
  c: ThreadStateCounts,
): Array<{ state: DerivedState; count: number; label: string; color: string }> {
  return THREAD_ORDER.filter((s) => c[s] > 0).map((s) => ({
    state: s,
    count: c[s],
    label: DERIVED_STATE_META[s].label,
    color: DERIVED_STATE_META[s].color,
  }));
}
