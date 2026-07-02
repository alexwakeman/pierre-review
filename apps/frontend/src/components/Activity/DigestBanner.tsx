import { useProCapabilities } from '../../hooks/useTriage.js';
import { useRepoDigest, useRefreshRepoDigests } from '../../hooks/useRepoDigest.js';
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
  const collapsed = useDigestCollapse((s) => s.collapsed.has(repoId));
  const toggle = useDigestCollapse((s) => s.toggle);
  const regenerating = refresh.isPending && refresh.variables === repoId;

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
        onRegenerate={() => refresh.mutate(repoId)}
        regenerating={regenerating}
        onOpenPr={openPr}
      />
      {/* Progress while THIS repo's own Regenerate runs (hides itself when done). */}
      <RegenProgressBar active={regenerating} />
    </div>
  );
}
