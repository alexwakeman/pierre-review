import { useCallback, useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  BlastRadiusConfig,
  BlastRadiusConfigResponse,
  BlastSignals,
  OpenPrsResponse,
  ResolvedBlastConfig,
  TimelineResponse,
} from '@pierre-review/shared';
import { api } from '../api/client.js';
import { resolveBlastConfig } from '../lib/ui.js';
import { useMe } from './useTriage.js';

// ── BLAST RADIUS, client side ─────────────────────────────────────────────────────────────────
//
// The verdict itself lives in `lib/ui.ts`'s `blastRadius()` — the ONE decision every surface
// makes. This file owns the two things a component needs to call it: the account's resolved
// config, and (for the PR-detail header only) the pull request's own signal vector.
//
// Deliberately the same shape as `useLargePr.ts` next door, because the two features are twins:
// an account-grained setting off /api/me, and a per-PR measurement read out of the lean feeds.

/**
 * The account's resolved blast-radius settings.
 *
 * ACCOUNT-GRAINED, so it rides `/api/me` and its query key (`['me']`) carries no `ws:<id>`
 * segment — the same treatment `mlSeverity`, `benchmarkOptIn` and the large-PR threshold get,
 * and for the same reason: nothing about it varies by workspace.
 *
 * ⚠ THE RESOLUTION HAPPENS HERE, NOT ON THE SERVER. `/api/me` sends the RAW stored config
 * (nullable); `resolveBlastConfig` applies the dial and merges any overrides. See
 * `MeResponse.blastRadius` for why: the defaults are an 18-number table in `packages/shared`,
 * which the backend may only `import type` from, so resolving server-side would mean mirroring
 * that table by hand forever.
 */
export function useBlastConfig(): ResolvedBlastConfig {
  return resolveBlastConfig(useMe().data?.blastRadius ?? null);
}

/** Write the account's config. `null` resets to the product defaults. Invalidates `['me']`,
 *  which is what every renderer reads through — no other cache is touched, because the wire
 *  carries SIGNALS per PR and the comparison is render-time. */
export function useSetBlastConfig() {
  const qc = useQueryClient();
  return useMutation<BlastRadiusConfigResponse, Error, BlastRadiusConfig | null>({
    mutationFn: (config) => api.setBlastRadiusConfig(config),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['me'] });
    },
  });
}

const NO_MEASUREMENT: { blast: BlastSignals | null } = { blast: null };

/**
 * The blast signals for ONE pull request, read out of the lean feeds already in cache.
 *
 * ⚠ WHY A CACHE READ AND NOT A FIELD ON /api/prs/:id — the identical argument `usePrCodeLoc`
 * makes one file over, and it is worth restating because the temptation here is stronger: the
 * detail pane HAS `pr.files`, so it could classify them itself. Doing that would put a SECOND
 * path classifier in the SPA, one that can disagree with the backend's `db/blast-radius.ts` on
 * any file either list does not share — precisely the failure the "one grain" rule exists to
 * prevent, and it would disagree silently, on screen, per pull request.
 *
 * Scans exactly the two caches `usePrCodeLoc` and `useDetailCacheReconciler` scan (`['timeline']`
 * and `['open-prs']`): the lean feeds that refetch on the sync cadence and carry every synced PR
 * the SPA has looked at. A PR in neither — a pinned tab opened cold — resolves to no measurement
 * and therefore NO CHIP, which is the correct rendering for "we don't know".
 */
export function usePrBlast(prId: number | null | undefined): { blast: BlastSignals | null } {
  const qc = useQueryClient();

  const read = useCallback((): { blast: BlastSignals | null } => {
    if (prId == null) return NO_MEASUREMENT;
    const scan = (
      prs: readonly { id: number; blast?: BlastSignals | null }[] | undefined,
    ): { blast: BlastSignals } | null => {
      for (const p of prs ?? []) {
        // ⚠ A cached row whose `blast` is null is NOT an answer — it is the same "unknown" a
        // missing row is, so keep looking: another cached feed may have measured it.
        if (p.id === prId && p.blast != null) return { blast: p.blast };
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

  const [value, setValue] = useState<{ blast: BlastSignals | null }>(read);

  useEffect(() => {
    const apply = (): void => {
      const next = read();
      setValue((prev) => (prev.blast === next.blast ? prev : next));
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
