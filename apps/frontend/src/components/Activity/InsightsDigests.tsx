import { useMemo } from 'react';
import type { RepoDigest } from '@pierre-review/shared';
import { useProCapabilities } from '../../hooks/useTriage.js';
import { useRepos } from '../../hooks/useTimeline.js';
import { useOpenPrTab } from '../../hooks/useOpenPrTab.js';
import { useInsightsDigestExpand } from '../../store/digestCollapse.js';
import { RepoDigestCard } from './RepoDigestCard.js';

// The per-repo AI "branch summaries" moved into the Insights panel (they used to live atop
// the Feed). One card per WATCHED repo (not just already-generated ones), so a repo with no
// digest yet still shows a card whose action reads "Generate". Each card's action is
// delta-gated via `onRegenerateRepo`: "Generate" when this repo has no digest, "Regenerate"
// once one exists AND it's stale, hidden when a fresh digest is already current. COLLAPSED BY
// DEFAULT (they sit under the sprint report as reference) via the Insights-scoped expand store.
export function InsightsDigests({
  digests,
  isLoading,
  anyWatched,
  refreshingRepoIds,
  onRegenerateRepo,
  embedded = false,
}: {
  digests: RepoDigest[];
  isLoading: boolean;
  anyWatched: boolean;
  refreshingRepoIds: Set<number>;
  // Per-repo (re)generate, delta-gated per card (offered when the repo has no digest, or its
  // digest is stale).
  onRegenerateRepo?: (repoId: number) => void;
  // When nested inside the sprint report card, the card's collapsible section header is the
  // label, so suppress this component's own "Repo summaries" header to avoid a double title.
  embedded?: boolean;
}): JSX.Element | null {
  const { activityDigest } = useProCapabilities();
  const { data: repos } = useRepos();
  const expanded = useInsightsDigestExpand((s) => s.expanded);
  const toggle = useInsightsDigestExpand((s) => s.toggle);
  const openPr = useOpenPrTab();

  // The watched repos are the digest set (matches InsightsView's watchedIds). Iterating the
  // repos (not the returned digests) means a never-generated repo still gets a card + Generate
  // button — the endpoint only returns rows for repos that already have a digest.
  const watchedRepos = useMemo(
    () => (repos ?? []).filter((r) => r.inboxWatch),
    [repos],
  );
  const digestByRepo = useMemo(
    () => new Map(digests.map((d) => [d.repoId, d] as const)),
    [digests],
  );

  // Gated on the AI-digest capability (independent of teamInsights — a user could have one
  // without the other), exactly like the old Feed mount.
  if (!activityDigest) return null;

  return (
    <div className="space-y-2">
      {!embedded && (
        <div className="flex items-center gap-2 px-0.5">
          <span className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-violet-600 dark:text-violet-300">
            <span aria-hidden="true">✨</span> Repo summaries · watched repos
          </span>
        </div>
      )}
      {!anyWatched || watchedRepos.length === 0 ? (
        <p className="px-0.5 text-xs text-gray-400">
          No watched repos in view — Watch a repo (the eye toggle) to get a summary here.
        </p>
      ) : isLoading && digests.length === 0 ? (
        <div className="h-12 animate-pulse rounded-md border border-violet-200 bg-violet-50/40 dark:border-violet-900/40 dark:bg-violet-950/10" />
      ) : (
        <div className="space-y-2">
          {watchedRepos.map((repo) => {
            const d = digestByRepo.get(repo.id);
            return (
              <RepoDigestCard
                key={repo.id}
                digest={d}
                isLoading={false}
                title={repo.fullName}
                collapsed={!expanded.has(repo.id)}
                onToggle={() => toggle(repo.id)}
                // Generatable = no digest yet, or a stale one (a real delta). Fresh → hidden.
                onRegenerate={
                  (d == null || d.stale) && onRegenerateRepo
                    ? () => onRegenerateRepo(repo.id)
                    : undefined
                }
                regenerating={refreshingRepoIds.has(repo.id)}
                onOpenPr={openPr}
                showProBadge={false}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
