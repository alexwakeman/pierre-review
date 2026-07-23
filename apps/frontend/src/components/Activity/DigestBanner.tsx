import { useProCapabilities } from '../../hooks/useTriage.js';
import { useAiUsage } from '../../hooks/useAiUsage.js';
import {
  useRepoDigest,
  useRefreshRepoDigests,
  digestProgressProps,
} from '../../hooks/useRepoDigest.js';
import { useOpenPrTab } from '../../hooks/useOpenPrTab.js';
import { useDigestCollapse } from '../../store/digestCollapse.js';
import { RepoDigestCard } from './RepoDigestCard.js';
import { RegenProgressBar } from './RegenProgressBar.js';

// The per-repo LLM "headlines" digest — the ONLY Pro/flagged surface inside a repo's own
// Activity console. Renders nothing at all unless pro.activityDigest is true (no greyed stub,
// no layout shift). Lazily fetches its own per-repo query so a slow Haiku call never blocks
// the core grid; collapse state is shared with the Feed collection (per-repo, persisted).
export function DigestBanner({ repoId }: { repoId: number }): JSX.Element | null {
  const { activityDigest } = useProCapabilities();
  // Hooks run unconditionally (rules of hooks); the query self-gates on `enabled`.
  const { data: digest, isLoading } = useRepoDigest(repoId, activityDigest);
  const refresh = useRefreshRepoDigests();
  const openPr = useOpenPrTab();
  // Metered-plan credit status (paid cloud) → disable the Generate/Regenerate button when
  // spent. Unmetered (local) → allowanceCredits null → never out of credits.
  const usage = useAiUsage(activityDigest);
  const outOfCredits =
    usage.data?.summaryTurnLimit != null && (usage.data.summaryTurnsRemaining ?? 0) <= 0;
  const collapsed = useDigestCollapse((s) => s.collapsed.has(repoId));
  const toggle = useDigestCollapse((s) => s.toggle);
  // Refresh (below) streams ONLY this repo (`mutate(repoId)`), so the status bar +
  // skeleton live inside the card and clear the moment its fresh digest lands.
  const regenerating = refresh.refreshingRepoIds.has(repoId);

  // Absent Pro → render nothing. This is the load-bearing gate.
  if (!activityDigest) return null;

  return (
    <div className="space-y-1.5">
      <RepoDigestCard
        digest={digest}
        isLoading={isLoading}
        title="Digest"
        collapsed={collapsed}
        onToggle={() => toggle(repoId)}
        // Offer the action whenever it's generatable: "Generate" when this repo has no
        // digest yet, "Regenerate" once one exists AND it's stale (a real delta). Hidden
        // only when a fresh digest is already current — so a never-generated repo is never
        // stranded (RepoDigestCard's empty state points at this very button).
        onRegenerate={digest == null || digest.stale ? () => refresh.mutate(repoId) : undefined}
        regenerating={regenerating}
        onOpenPr={openPr}
        outOfCredits={outOfCredits}
      />
      {/* Only shown once the plan confirms this repo actually changed. */}
      <RegenProgressBar
        active={refresh.isPending && (refresh.progress?.total ?? 0) > 0}
        label="Regenerating digest"
        {...digestProgressProps(refresh.progress)}
      />
      {refresh.notice != null && (
        <p className="px-0.5 text-[11px] text-gray-400" aria-live="polite">
          {refresh.notice}
        </p>
      )}
    </div>
  );
}
