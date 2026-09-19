import { useCallback, useEffect, useMemo, useState } from 'react';
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
import { blastRadius, resolveBlastConfig } from '../lib/ui.js';
import { useFilters } from '../store/filters.js';
import { useRepos } from './useTimeline.js';
import { useMe, useWorkspaceOpenPrs } from './useTriage.js';

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

// ── THE WORKSPACE'S OPEN PULL REQUESTS, BY REACH AND BY REPOSITORY ────────────────────────────
//
// The per-repository half of the Reports → Flow metrics "Where the work is happening" section.
// Everything here is a CLIENT-SIDE FOLD over a list the SPA already holds, and that is the design,
// not an economy:
//
//  • THE LEVEL STAYS DECIDED IN ONE PLACE. It calls `blastRadius()` — the same function the chip
//    calls, on the same rows, with the same config — so a bar and a chip can never disagree about
//    a pull request. A per-repo `{low, medium, high}` on the wire would be the product's first
//    server-decided level and would freeze the sensitivity dial for this one card.
//  • THE DIAL STAYS RENDER-TIME. `useSetBlastConfig` invalidates `['me']` and nothing else, so
//    moving the dial in Settings re-runs this fold over rows already in memory. No refetch, no
//    query-key change, no cache invalidation — exactly what a chip repainting costs.
//
// ⚠ IT READS `useWorkspaceOpenPrs`, NEVER `useSearchOpenPrs`. The latter narrows by
// `filters.repoIds`, which is the TIMELINE BOARD's picker — not mounted on Reports, so a card
// scoped by it would be silently short with no visible control to widen it. Reports covers every
// repository in the workspace. (The same landmine is written up in `useTriage.ts`.)
//
// It costs no extra request when the Feed has been opened: its open-PR panel holds this exact
// cache entry. Opening Reports first pays one `/api/open-prs`.

/** One repository's currently-open pull requests, split by reach. */
export interface RepoReach {
  repoId: number;
  repoFullName: string;
  low: number;
  medium: number;
  high: number;
  /** `low + medium + high` — the pull requests this repository's bar is drawn from. */
  read: number;
  /** ⚠ OPEN PULL REQUESTS WITH NO READING, AND THEY ARE NOT DRAWN. `blastRadius()` returns null
   *  for BOTH "never measured" and "GitHub truncated the file list and no high arm fired", which
   *  are deliberately the same answer on screen. Measured at 10.0% of open PRs on the dev corpus
   *  before the file backfill. `read + unread === openPrs`, so the bars do NOT total the count the
   *  list is ranked by — which is why this number is carried out to be said in words. */
  unread: number;
  /** ⚠ DRAFTS ARE IN, AND THAT DISAGREES WITH THE TILE FOUR INCHES ABOVE. The "Open PRs" flow
   *  tile counts `state === 'open' && !isDraft`; `/api/open-prs` applies no draft filter, and a
   *  draft touching a migration is reach sitting in the repository whatever its state. So the
   *  population stays whole and the difference is stated in words — MEASURED at 210 here against
   *  the tile's 204, which is exactly the unexplained pair of numbers that sentence reconciles.
   *  Counted PER REPOSITORY so the card's printed total can cover the drawn rows alone. */
  drafts: number;
  openPrs: number;
}

export interface WorkspaceReach {
  /** Repositories holding at least one open pull request, DESC by that count, capped. */
  repos: RepoReach[];
  /** Repositories holding at least one open pull request, BEFORE the cap. */
  repoCount: number;
  /** The active workspace's WHOLE membership, active or not — the denominator for "N of the M
   *  repositories in this workspace have nothing open right now". A repository holding nothing gets
   *  no row here at all, which on its own reads as "this workspace has N repositories"; the card
   *  beside this one carries `workspaceRepos` for exactly the same reason. */
  workspaceRepos: number;
  /** ⚠ EVERY FIGURE BELOW IS FOLDED OVER THE SHOWN ROWS, NOT THE WHOLE WORKSPACE — one row must
   *  never mix the headline and the subset populations. Once the workspace crosses the cap, a total
   *  taken over every repository would print an unread count and a draft count covering
   *  repositories whose bars are not on screen, beside bars that are. What the cap cut travels
   *  SEPARATELY in `omitted`, is said in its own sentence, and is never subtracted against these. */
  openPrs: number;
  read: number;
  unread: number;
  drafts: number;
  /** What the cap cut. ⚠ `high` is here because THE LIST IS RANKED BY TOTAL OPEN PULL REQUESTS
   *  while the DRAWN measure is the Low/Medium/High split, so the repository holding the most
   *  high-reach pull requests can sit below the fold — naming the cut on the drawn measure is the
   *  only way a reader can see that happened. (`omitted.linesChanged` on the card beside this one
   *  exists for the identical reason.) */
  omitted: { repos: number; openPrs: number; high: number };
}

/** Mirrors `REPO_ACTIVITY_MAX_REPOS` in the backend's repo-activity fold, so the two cards in one
 *  section cut at the same place. NO SILENT CAPS: what it cut is disclosed. */
const REACH_MAX_REPOS = 12;

/**
 * Every open pull request in the active workspace, grouped by repository and levelled.
 *
 * `null` means "draw nothing": the list has not arrived, or no open pull request in the workspace
 * has a reading at all. An empty card would assert that the workspace has no reach; silence does
 * not.
 */
export function useWorkspaceReach(): WorkspaceReach | null {
  const { data } = useWorkspaceOpenPrs();
  const { data: repos } = useRepos();
  // The workspace's membership count comes from the account-wide `/api/repos` narrowed by
  // `Repo.workspaceId` — the client's ONE repo→workspace mapping. ⚠ `null` is "not resolved yet",
  // never "every workspace": nothing here may render workspace-scoped data while it is null (and
  // `useWorkspaceOpenPrs` is disabled then anyway, so the list would be missing too).
  const workspaceId = useFilters((s) => s.workspaceId);
  // The same resolution `useBlastConfig()` performs, memoised on the STORED dial: that hook mints a
  // fresh object per call, and a fold over every open pull request must not re-run on every render.
  const stored = useMe().data?.blastRadius ?? null;
  const config = useMemo(() => resolveBlastConfig(stored), [stored]);

  return useMemo((): WorkspaceReach | null => {
    const prs = data?.prs;
    if (prs == null || repos == null || workspaceId == null) return null;
    const names = new Map(repos.map((r) => [r.id, r.fullName]));
    const byRepo = new Map<number, RepoReach>();
    for (const pr of prs) {
      let row = byRepo.get(pr.repoId);
      if (row == null) {
        row = {
          repoId: pr.repoId,
          // `/api/repos` is account-wide, so a workspace repo is always in it; the id is a
          // last resort rather than a dropped row, because dropping one would move a count.
          repoFullName: names.get(pr.repoId) ?? `Repository ${pr.repoId}`,
          low: 0,
          medium: 0,
          high: 0,
          read: 0,
          unread: 0,
          drafts: 0,
          openPrs: 0,
        };
        byRepo.set(pr.repoId, row);
      }
      row.openPrs += 1;
      if (pr.isDraft) row.drafts += 1;
      const verdict = blastRadius(pr, config);
      if (verdict == null) {
        row.unread += 1;
        continue;
      }
      row.read += 1;
      if (verdict.level === 'low') row.low += 1;
      else if (verdict.level === 'medium') row.medium += 1;
      else row.high += 1;
    }
    const all = [...byRepo.values()].sort(
      (a, b) => b.openPrs - a.openPrs || a.repoFullName.localeCompare(b.repoFullName),
    );
    // "Nothing in this workspace has a reading at all" is judged over EVERY repository, cut ones
    // included: the card draws nothing in that case, and a reading below the fold is still a
    // reading. Every PRINTED figure below is folded over the shown rows alone.
    if (all.reduce((n, r) => n + r.read, 0) === 0) return null;
    const shown = all.slice(0, REACH_MAX_REPOS);
    const cut = all.slice(REACH_MAX_REPOS);
    const total = (rows: RepoReach[], pick: (r: RepoReach) => number): number =>
      rows.reduce((n, r) => n + pick(r), 0);
    return {
      repos: shown,
      repoCount: all.length,
      workspaceRepos: repos.reduce((n, r) => n + (r.workspaceId === workspaceId ? 1 : 0), 0),
      openPrs: total(shown, (r) => r.openPrs),
      read: total(shown, (r) => r.read),
      unread: total(shown, (r) => r.unread),
      drafts: total(shown, (r) => r.drafts),
      omitted: {
        repos: cut.length,
        openPrs: total(cut, (r) => r.openPrs),
        high: total(cut, (r) => r.high),
      },
    };
  }, [data, repos, config, workspaceId]);
}
