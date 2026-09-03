import { useCallback, useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  LARGE_PR_CODE_LOC_DEFAULT,
  type LargePrThresholdResponse,
  type OpenPrsResponse,
  type TimelineResponse,
} from '@pierre-review/shared';
import { api } from '../api/client.js';
import { useMe } from './useTriage.js';

// ── The LARGE-PR FLAG, client side ────────────────────────────────────────────────────────────
//
// The verdict itself lives in `lib/ui.ts`'s `largePrFlag()` — the ONE comparison every surface
// makes. This file owns the two things a component needs to call it: the account's threshold, and
// (for the PR-detail header only) the PR's measured code churn.

/**
 * The account's large-PR threshold in lines of code churn.
 *
 * ACCOUNT-GRAINED, so it rides `/api/me` and its query key (`['me']`) carries no `ws:<id>`
 * segment — the same treatment `mlSeverity` and `benchmarkOptIn` get, and for the same reason:
 * nothing about it varies by workspace. Falls back to the product default while /api/me is in
 * flight, which is exactly what the server would resolve for an account that never set one.
 */
export function useLargePrThreshold(): number {
  return useMe().data?.largePrCodeLocThreshold ?? LARGE_PR_CODE_LOC_DEFAULT;
}

/** Write the account's threshold. `null` resets to the product default. Invalidates `['me']`,
 *  which is what every renderer reads the number through — no other cache is touched, because
 *  the wire carries a NUMBER per PR and the comparison is render-time. */
export function useSetLargePrThreshold() {
  const qc = useQueryClient();
  return useMutation<LargePrThresholdResponse, Error, number | null>({
    mutationFn: (threshold) => api.setLargePrThreshold(threshold),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['me'] });
    },
  });
}

/** The two wire fields `largePrFlag()` reads. Both absent = "we have no measurement", which is
 *  the honest state for a PR that isn't in either lean feed's cache. */
export interface PrCodeLocFields {
  codeLoc?: number | null;
  codeLocIsLowerBound?: boolean;
}

const NO_MEASUREMENT: PrCodeLocFields = {};

/**
 * The code-only churn for ONE pull request, read out of the lean feeds already in cache.
 *
 * ⚠ WHY A CACHE READ AND NOT A FIELD ON /api/prs/:id. `codeLoc` is enriched onto the three LIST
 * payloads (`TimelinePr`, `InsightPrRef`, `ConsolidatedFeedItem`) and deliberately not onto
 * `PrDetail`. The detail pane could in principle sum `pr.files` itself, but the classifier that
 * decides what counts as code lives in `db/code-loc.ts` and re-implementing it here would be a
 * SECOND classifier that can disagree with every other surface — precisely the failure the "one
 * grain" rule exists to prevent. So the header borrows the number the boards already have.
 *
 * This scans exactly the two caches `useDetailCacheReconciler` scans (`['timeline']` and
 * `['open-prs']`), for the same reason it does: they are the lean feeds that refetch on the sync
 * cadence and carry every synced PR the SPA has looked at. A PR in neither — a pinned tab opened
 * cold, say — resolves to no measurement and therefore NO FLAG, which is the correct rendering
 * for "we don't know" and identical to trap 1.
 */
export function usePrCodeLoc(prId: number | null | undefined): PrCodeLocFields {
  const qc = useQueryClient();

  const read = useCallback((): PrCodeLocFields => {
    if (prId == null) return NO_MEASUREMENT;
    const scan = (prs: readonly { id: number; codeLoc?: number | null; codeLocIsLowerBound?: boolean }[] | undefined): PrCodeLocFields | null => {
      for (const p of prs ?? []) {
        // ⚠ A cached row whose `codeLoc` is null is NOT an answer — it is the same "unknown" a
        // missing row is, so keep looking: another cached feed may have measured it.
        if (p.id === prId && p.codeLoc != null) {
          return { codeLoc: p.codeLoc, codeLocIsLowerBound: p.codeLocIsLowerBound };
        }
      }
      return null;
    };
    for (const [, data] of qc.getQueriesData<TimelineResponse>({ queryKey: ['timeline'] })) {
      const hit = scan(data?.prs);
      if (hit) return hit;
    }
    for (const [, data] of qc.getQueriesData<OpenPrsResponse>({ queryKey: ['open-prs'] })) {
      const hit = scan(data?.prs);
      if (hit) return hit;
    }
    return NO_MEASUREMENT;
  }, [qc, prId]);

  const [value, setValue] = useState<PrCodeLocFields>(read);

  useEffect(() => {
    const apply = (): void => {
      const next = read();
      setValue((prev) =>
        prev.codeLoc === next.codeLoc && prev.codeLocIsLowerBound === next.codeLocIsLowerBound
          ? prev
          : next,
      );
    };
    apply();
    // Re-read only when a lean feed lands; a `['pr', id]` invalidation must not re-trigger.
    return qc.getQueryCache().subscribe((event) => {
      const k = event.query.queryKey[0];
      if (k === 'timeline' || k === 'open-prs') apply();
    });
  }, [qc, read]);

  return value;
}
