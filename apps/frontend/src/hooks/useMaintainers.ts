import { useMemo } from 'react';
import { useMergers } from './useTimeline.js';

/**
 * repoId → set of userIds with merge rights there (have merged a PR). Mirrors
 * the `mergersByRepo` memo in `Timeline/index.tsx`, but exposed as a hook so any
 * React render site can badge maintainers. Reuses the shared `['mergers']`
 * query (React Query dedupes it), so this adds no extra fetch.
 */
export function useMaintainersByRepo(): Map<number, Set<number>> {
  const { data: mergers } = useMergers();
  return useMemo(() => {
    const m = new Map<number, Set<number>>();
    for (const e of mergers ?? []) m.set(e.repoId, new Set(e.userIds));
    return m;
  }, [mergers]);
}
