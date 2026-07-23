import type { SearchHit, SearchHitKind } from '@pierre-review/shared';
import type { TabMeta } from '../../store/pinnedTabs.js';
import { usePinnedTabs } from '../../store/pinnedTabs.js';
import { useFilters } from '../../store/filters.js';

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

export const KIND_LABEL: Record<SearchHitKind, string> = {
  pr: 'PR',
  review: 'Review',
  review_comment: 'Thread',
  pr_comment: 'Comment',
};

// A compact glyph per hit kind (emoji — no new icon deps; matches the drill-down chip style).
export const KIND_GLYPH: Record<SearchHitKind, string> = {
  pr: '🔀',
  review: '✅',
  review_comment: '🧵',
  pr_comment: '💬',
};
