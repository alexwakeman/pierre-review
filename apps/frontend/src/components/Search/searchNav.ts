import type { ComponentType } from 'react';
import type { SearchHit, SearchHitKind } from '@pierre-review/shared';
import type { TabMeta } from '../../store/pinnedTabs.js';
import { usePinnedTabs } from '../../store/pinnedTabs.js';
import { useFilters } from '../../store/filters.js';
import { CommentIcon, PullRequestIcon, ReviewIcon, ThreadsIcon } from '../Icons.js';

// Shared open-a-hit behaviour for the search dropdown + results tab. A review-comment hit deep-links
// straight to its review thread (the "link directly to the thread" requirement); every other kind
// opens the PR's detail tab. `fromActivity` is inferred by openTab (openable from any view).
export function hitToMeta(hit: SearchHit): TabMeta {
  return {
    id: hit.prId,
    number: hit.prNumber,
    title: hit.prTitle,
    repoFullName: hit.repoFullName,
    authorLogin: hit.authorLogin,
    authorDisplayName: null,
    authorAvatarUrl: hit.authorAvatarUrl,
  };
}

export function openSearchHit(hit: SearchHit): void {
  usePinnedTabs.getState().openPrDetailTab(hitToMeta(hit));
  if (hit.kind === 'review_comment' && hit.threadId != null) {
    // selectThread sets selectedPrId + selectedThreadId (and clears any stale state-pill preset);
    // PrDetail's effect then forces the Threads tab and scrolls the thread into view.
    useFilters.getState().selectThread(hit.prId, hit.threadId);
  } else {
    // Clean selection on the target PR (clears a stale threadStateFilter preset) so the detail tab
    // opens on its Overview.
    useFilters.getState().selectPr(hit.prId);
  }
}

// Open a hit's PR on its Overview (the "#N" reference link), regardless of hit kind — so a thread
// hit's PR reference lands on the PR itself, not the specific thread (that's the thread-header
// affordance). Clean selection clears any stale state-pill preset.
export function openHitPr(hit: SearchHit): void {
  usePinnedTabs.getState().openPrDetailTab(hitToMeta(hit));
  useFilters.getState().selectPr(hit.prId);
}

export const KIND_LABEL: Record<SearchHitKind, string> = {
  pr: 'PR',
  review: 'Review',
  review_comment: 'Thread',
  pr_comment: 'Comment',
};

// A compact mark per hit kind (matches the drill-down chip style). COMPONENTS, not glyph strings:
// every consumer renders this straight into JSX, so the mark inherits the row's colour and size
// instead of painting its own. Both consumers live in this directory (GlobalSearch's dropdown and
// SearchResultsTab's HitHeader) — neither concatenates it into a string.
export const KIND_ICON: Record<
  SearchHitKind,
  ComponentType<{ size?: number; className?: string }>
> = {
  pr: PullRequestIcon,
  review: ReviewIcon,
  review_comment: ThreadsIcon,
  pr_comment: CommentIcon,
};
