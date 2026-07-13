import { useCallback, useEffect, useRef, useState } from 'react';
import {
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import type {
  DigestRefreshEvent,
  RepoDigest,
  RepoDigestsResponse,
} from '@pierre-review/shared';
import { api } from '../api/client.js';
import { sseStream } from '../api/sse.js';

/** Build the digest query string from the active repo filter. */
function digestSearch(repoIds: number[] | null): string {
  return repoIds && repoIds.length > 0 ? `repoIds=${repoIds.join(',')}` : '';
}

// Bulk per-repo digests for the watched repos. Only fetched when `enabled`
// (pro.activityDigest) — absent the @pierre/pro plugin the route 404s. Cached snapshot;
// regeneration is explicit (the refresh stream / per-banner regenerate).
export function useRepoDigests(
  repoIds: number[] | null,
  enabled: boolean,
  scope?: string,
) {
  const search = digestSearch(repoIds);
  return useQuery<RepoDigestsResponse>({
    queryKey: ['repo-digests', search, scope ?? 'all'],
    queryFn: () => api.repoDigests(search, scope),
    enabled,
    staleTime: Infinity,
  });
}

// A single repo's digest, fetched lazily (only when its banner is in view + Pro on)
// so a slow Haiku call never blocks the core grid. Keyed per repo.
export function useRepoDigest(repoId: number | null, enabled: boolean) {
  return useQuery<RepoDigest>({
    queryKey: ['repo-digest', repoId],
    queryFn: () => api.repoDigest(repoId as number),
    enabled: enabled && repoId != null,
    staleTime: Infinity,
  });
}

// Splice a freshly-streamed digest into every cached ['repo-digests', *] list that
// already contains that repo, so the card refreshes the instant its digest lands
// (rather than only after the terminal invalidate refetch). A repo absent from a
// (scoped) list is left alone; the done-invalidate reconciles first-time additions.
function patchDigestLists(qc: QueryClient, digest: RepoDigest): void {
  qc.setQueriesData<RepoDigestsResponse>({ queryKey: ['repo-digests'] }, (old) => {
    if (!old) return old;
    const idx = old.digests.findIndex((d) => d.repoId === digest.repoId);
    if (idx === -1) return old;
    const digests = old.digests.slice();
    digests[idx] = digest;
    return { ...old, digests };
  });
}

const NOTICE_MS = 5000;

export interface DigestRefreshProgress {
  completed: number;
  total: number;
}

// Map the real regen progress to determinate <RegenProgressBar> props — an honest
// "N of K repos". Null value (no repos regenerating) → the bar renders nothing.
export function digestProgressProps(progress: DigestRefreshProgress | null): {
  value: number | null;
  sub?: string;
} {
  if (!progress || progress.total <= 0) return { value: null };
  return {
    value: (progress.completed / progress.total) * 100,
    sub: `${progress.completed}/${progress.total}`,
  };
}

// (Re)generate digests over an SSE stream. A cheap server-side payload-hash PLAN pass
// runs first and tells us the ONLY repos whose content actually changed — everything
// else is left untouched (no LLM, no skeleton). So:
//   • `refreshingRepoIds` holds just the repos genuinely regenerating (a card shimmers
//     iff its id is in it, and drops out the instant its fresh digest lands);
//   • `progress` is the honest N-of-K reading for the determinate bar (K = repos that
//     really changed), not an animated guess.
// Pass a single repo id (per-repo console), an array (Feed "Regenerate all"), or omit
// for the backend's watched-repos default.
export function useRefreshRepoDigests() {
  const qc = useQueryClient();
  const [isPending, setIsPending] = useState(false);
  const [refreshingRepoIds, setRefreshingRepoIds] = useState<Set<number>>(
    () => new Set(),
  );
  const [progress, setProgress] = useState<DigestRefreshProgress | null>(null);
  // A transient explanation when a refresh had nothing to do (all up to date, or
  // throttled), so it doesn't read as a silent failure. Auto-clears.
  const [notice, setNotice] = useState<string | null>(null);
  const acRef = useRef<AbortController | null>(null);

  useEffect(() => () => acRef.current?.abort(), []);

  // Auto-dismiss the notice.
  useEffect(() => {
    if (notice == null) return;
    const t = window.setTimeout(() => setNotice(null), NOTICE_MS);
    return () => window.clearTimeout(t);
  }, [notice]);

  const mutate = useCallback(
    (arg?: number | number[]) => {
      acRef.current?.abort();
      const ac = new AbortController();
      acRef.current = ac;
      setIsPending(true);
      setNotice(null);
      setRefreshingRepoIds(new Set());
      setProgress(null);

      const drop = (repoId: number): void =>
        setRefreshingRepoIds((prev) => {
          if (!prev.has(repoId)) return prev;
          const next = new Set(prev);
          next.delete(repoId);
          return next;
        });

      const search =
        arg == null
          ? undefined
          : Array.isArray(arg)
            ? arg.length > 0
              ? `repoIds=${arg.join(',')}`
              : undefined
            : `repoIds=${arg}`;
      const url = `/api/pro/activity/digests/refresh/stream${search ? `?${search}` : ''}`;

      let throttled = false;
      let creditsExhausted = false;
      let planIds: number[] = [];
      let total = 0;
      let completed = 0;
      void sseStream<DigestRefreshEvent>(url, {
        method: 'POST',
        signal: ac.signal,
        onEvent: (e) => {
          switch (e.type) {
            case 'start':
              if (e.throttled) throttled = true;
              if (e.creditsExhausted) creditsExhausted = true;
              break;
            case 'plan':
              // The repos that genuinely changed — skeleton + progress cover only these.
              planIds = e.toRegenerate;
              total = planIds.length;
              setRefreshingRepoIds(new Set(planIds));
              setProgress({ completed: 0, total });
              break;
            case 'repo':
              completed += 1;
              setProgress({ completed, total });
              // Fresh digest → caches, then un-dim THIS card (skeleton → content).
              qc.setQueryData<RepoDigest>(
                ['repo-digest', e.digest.repoId],
                e.digest,
              );
              patchDigestLists(qc, e.digest);
              drop(e.digest.repoId);
              break;
            case 'error':
              // Generation failed for this repo — stop its skeleton, keep old text.
              completed += 1;
              setProgress({ completed, total });
              drop(e.repoId);
              break;
            case 'done':
              break;
          }
        },
      })
        .catch(() => {
          /* aborted or network error — the caches keep whatever streamed so far */
        })
        .finally(() => {
          // Ignore the teardown of a superseded stream (a newer mutate ran).
          if (acRef.current !== ac) return;
          acRef.current = null;
          setIsPending(false);
          setRefreshingRepoIds(new Set());
          setProgress(null);
          // Explain a no-op refresh so it doesn't read as broken.
          if (creditsExhausted) {
            setNotice('Out of AI credits this month — summaries resume on the 1st.');
          } else if (throttled) {
            setNotice('Refreshed moments ago — showing the latest. Try again shortly.');
          } else if (total === 0) {
            setNotice('Already up to date — no new activity since the last digest.');
          } else {
            setNotice(null);
          }
          // A generation may have spent credits → refresh the meter + the out-of-credits gate.
          void qc.invalidateQueries({ queryKey: ['ai-usage'] });
          // Reconcile ONLY the repos that actually regenerated — leave every other
          // card's cached digest untouched.
          for (const id of planIds) {
            void qc.invalidateQueries({ queryKey: ['repo-digest', id] });
          }
          if (planIds.length > 0) {
            void qc.invalidateQueries({ queryKey: ['repo-digests'] });
          }
        });
    },
    [qc],
  );

  return { mutate, isPending, refreshingRepoIds, progress, notice };
}
