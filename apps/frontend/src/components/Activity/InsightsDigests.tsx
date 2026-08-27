import { useMemo } from 'react';
import type { RepoDigest } from '@pierre-review/shared';
import { useProCapabilities } from '../../hooks/useTriage.js';
import { useRepos } from '../../hooks/useTimeline.js';
import { useWorkspaces, workspaceRepoIds } from '../../hooks/useWorkspaces.js';
import { useFilters } from '../../store/filters.js';
import { useOpenPrTab } from '../../hooks/useOpenPrTab.js';
import { useInsightsDigestExpand } from '../../store/digestCollapse.js';
import { SparkleIcon } from '../Icons.js';
import { RepoDigestCard } from './RepoDigestCard.js';

// The per-repo AI "branch summaries" moved into the Insights panel (they used to live atop
// the Feed). One card per repo IN THE ACTIVE WORKSPACE (not just already-generated ones), so a
// repo with no digest yet still shows a card whose action reads "Generate". Each card's action is
// delta-gated via `onRegenerateRepo`: "Generate" when this repo has no digest, "Regenerate"
// once one exists AND it's stale, hidden when a fresh digest is already current. COLLAPSED BY
// DEFAULT (they sit under the sprint report as reference) via the Insights-scoped expand store.
//
// ⚠ THE SET WIDENED — it used to be the WATCHED repos, and "watched" no longer exists: the
// workspace IS the scope, so every repo in it is fully live. NOTE THE COST SHAPE before reading
// that as new spend. A digest is ONE Haiku call per repo, and generation happens only on an
// explicit `POST …/digests/refresh` — nothing generates on open, on mount or on a cron. It is
// payload-hash cached, so a repo whose inputs have not moved costs $0 even when refresh is
// pressed, and the plugin holds a per-account min-interval plus a USD-per-repo cap on top. So
// widening the set widens a user-triggered, cached, capped operation — not a background spend.
export function InsightsDigests({
  digests,
  isLoading,
  refreshingRepoIds,
  onRegenerateRepo,
  outOfCredits = false,
  embedded = false,
}: {
  digests: RepoDigest[];
  isLoading: boolean;
  refreshingRepoIds: Set<number>;
  // Per-repo (re)generate, delta-gated per card (offered when the repo has no digest, or its
  // digest is stale).
  onRegenerateRepo?: (repoId: number) => void;
  // The account's metered AI allowance is spent → each card's Generate/Regenerate disables.
  outOfCredits?: boolean;
  // When nested inside the sprint report card, the card's collapsible section header is the
  // label, so suppress this component's own "Repo summaries" header to avoid a double title.
  embedded?: boolean;
}): JSX.Element | null {
  const { activityDigest } = useProCapabilities();
  const { data: repos } = useRepos();
  const { data: workspaces } = useWorkspaces();
  const workspaceId = useFilters((s) => s.workspaceId);
  const expanded = useInsightsDigestExpand((s) => s.expanded);
  const toggle = useInsightsDigestExpand((s) => s.toggle);
  const openPr = useOpenPrTab();

  // The ACTIVE WORKSPACE's repos are the digest set. `useRepos()` is account-wide, so it is
  // narrowed by the membership the workspace row carries (the same derivation FilterBar uses for
  // RepoSelectPanel) — an account-wide list would fan the collection out across every workspace.
  // Iterating the repos (not the returned digests) means a never-generated repo still gets a card
  // + Generate button — the endpoint only returns rows for repos that already have a digest.
  const scopedRepos = useMemo(() => {
    if (workspaces == null || workspaceId == null) return [];
    const member = new Set(workspaceRepoIds(workspaceId, workspaces));
    return (repos ?? []).filter((r) => member.has(r.id));
  }, [repos, workspaces, workspaceId]);
  const digestByRepo = useMemo(
    () => new Map(digests.map((d) => [d.repoId, d] as const)),
    [digests],
  );

  // Gated on the AI-digest capability (independent of workspaceInsights — a user could have one
  // without the other), exactly like the old Feed mount.
  if (!activityDigest) return null;

  return (
    <div className="space-y-2">
      {!embedded && (
        <div className="flex items-center gap-2 px-0.5">
          <span className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-ai-ink">
            <SparkleIcon className="text-ai-signal" />
            Repo summaries
          </span>
        </div>
      )}
      {scopedRepos.length === 0 ? (
        <p className="px-0.5 text-xs text-gray-400">
          No repos in this workspace — move some in from Manage repos &amp; workspaces to get a
          summary here.
        </p>
      ) : isLoading && digests.length === 0 ? (
        <div className="h-12 animate-pulse rounded-md border border-ai-border bg-ai-surface" />
      ) : (
        <div className="space-y-2">
          {scopedRepos.map((repo) => {
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
                outOfCredits={outOfCredits}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
