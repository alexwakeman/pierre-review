import { useId, useMemo, useState } from 'react';
import { useIsMutating } from '@tanstack/react-query';
import {
  aiRunProviderName,
  type StoryBuild,
  type StoryBuildProgress,
  type StoryBuildRepo,
  type StoryBuildRepoPushResult,
} from '@pierre-review/shared';
import { api, ApiError } from '../../api/client.js';
import { useFollowUpProvider } from '../../hooks/useModelPick.js';
import { useRunCostText } from '../../hooks/useAiBudget.js';
import { storyBuildMutationKey, useStoryBuildDiff, useStoryBuildPush, useStoryBuildRetry } from '../../hooks/useStoryBuild.js';
import { STORY_BUILD_PHASE_LABEL, storyBuildProgressPct } from '../../lib/aiFixProgress.js';
import { parseGitPatch } from '../../lib/diff.js';
import { canPushRepo, canRetryRepo, repoIsRunning, STORY_BUILD_REPO_STATUS_WORDS, storyBuildErrorText } from '../../lib/storyBuild.js';
import { safeExternalUrl } from '../../lib/ui.js';
import { usePinnedTabs } from '../../store/pinnedTabs.js';
import { RegenProgressBar } from '../Activity/RegenProgressBar.js';
import { PrCardChips, PrCardFrame, PrCardMeta, PrCardTitle, CARD_NEUTRAL_CHIP, CARD_RED_CHIP, CARD_TONE_CHIP } from '../Activity/PrCardShell.js';
import { ChangeReportSections, CHANGE_REPORT_CHIP } from '../AiFix/ChangeReport.js';
import { ChecksReport, ChecksStatus } from '../AiFix/RunTests.js';
import { AiRunGate } from '../AiSetup.js';
import { AiRunLabel } from '../AiRunLabel.js';
import { DiffWrapToggle, FileDiffView, type DiffFile } from '../diff/FileDiffView.js';
import { ChevronIcon, ExternalLinkIcon, PullRequestIcon } from '../Icons.js';
import { Button } from '../ui/Button.js';
import { storyBuildRefAnchor } from './CoverageSection.js';

// THE BUILD: one card per included repository, in build order (the One PR card shell look). Each card:
// its status (and the live step while it runs, the AI Fix banner's bar), what the AI says it changed
// (`ChangeReportSections`, the refs jump to "Already done"), Limn's own test run (`ChecksReport`), the
// diff — fetched only when opened, drawn exactly as AI Fix draws one — and, at the foot, the tests'
// one-line status BESIDE Push (`ChecksStatus`). Retry on a failed repository. Pushed: the new pull
// request, which opens its PR tab. Nothing here pushes without the reader pressing Push.

function errorOf(err: unknown): string | null {
  if (err == null) return null;
  return storyBuildErrorText(err instanceof ApiError ? err : { message: (err as Error).message });
}

/** The answer of the last push that named this repository, in words; null when it pushed. */
function pushFailure(r: StoryBuildRepoPushResult | undefined): string | null {
  if (r == null || r.outcome === 'pushed') return null;
  return r.error ?? (r.outcome === 'skipped' ? 'Not pushed.' : 'The push failed.');
}

export function BuildSection({
  build,
  progress,
  draft,
}: {
  build: StoryBuild;
  progress: StoryBuildProgress | null;
  /** Open new pull requests as drafts (owner decision 2: the default). */
  draft: boolean;
}): JSX.Element {
  const push = useStoryBuildPush(build.workspaceId, build.ident);
  const results = new Map((push.data?.results ?? []).map((r) => [r.repoId, r] as const));
  const repos = build.repos.filter((r) => r.include || r.status === 'pushed').sort((a, b) => a.order - b.order);
  return (
    <ul data-testid="story-build-repos" className="space-y-2">
      {repos.map((r) => (
        <BuildRepoCard
          key={r.repoId}
          build={build}
          repo={r}
          progress={progress != null && progress.repoId === r.repoId ? progress : null}
          draft={draft}
          onPush={() => push.mutate({ id: build.id, repoId: r.repoId, draft })}
          pushError={pushFailure(results.get(r.repoId)) ?? (push.variables?.repoId === r.repoId ? errorOf(push.error) : null)}
        />
      ))}
    </ul>
  );
}

function BuildRepoCard({
  build,
  repo,
  progress,
  draft,
  onPush,
  pushError,
}: {
  build: StoryBuild;
  repo: StoryBuildRepo;
  progress: StoryBuildProgress | null;
  draft: boolean;
  onPush: () => void;
  pushError: string | null;
}): JSX.Element {
  const titleId = useId();
  const busy = useIsMutating({ mutationKey: storyBuildMutationKey(build.ident) }) > 0;
  const retry = useStoryBuildRetry(build.workspaceId, build.ident);
  const retryProvider = useFollowUpProvider(build.provider ?? null, 'story_build');
  const costText = useRunCostText();
  const [diffOpen, setDiffOpen] = useState(false);
  const running = repoIsRunning(repo);
  const by = aiRunProviderName(repo.model != null ? repo : build);
  const cost = costText(repo.costUsd, repo.provider ?? build.provider ?? null);
  const pushedUrl = safeExternalUrl(repo.pushedPrUrl) ?? null;
  const statusTone =
    repo.status === 'failed' ? CARD_RED_CHIP : repo.status === 'ready' || repo.status === 'pushed' ? `${CARD_TONE_CHIP} bg-ui-raise text-ui-ink` : CARD_NEUTRAL_CHIP;
  return (
    <PrCardFrame labelledBy={titleId}>
      <div data-testid="story-build-repo" data-repo={repo.fullName} data-status={repo.status}>
        <PrCardTitle id={titleId} end={repo.status === 'pushed' ? <PushedPrLink repo={repo} url={pushedUrl} /> : null}>
          {repo.fullName}
        </PrCardTitle>
        <PrCardChips>
          <span className={statusTone}>{STORY_BUILD_REPO_STATUS_WORDS[repo.status]}</span>
        </PrCardChips>
        <PrCardMeta
          parts={[
            repo.branch != null ? <span key="b" className="font-mono">{repo.pushedBranch ?? repo.branch}</span> : null,
            <span key="base">
              from <span className="font-mono">{repo.baseRef}</span>
            </span>,
            repo.filesChanged.length > 0 ? `${repo.filesChanged.length} file${repo.filesChanged.length === 1 ? '' : 's'} changed` : null,
            repo.model != null ? <AiRunLabel key="m" provider={repo.provider} model={repo.model} /> : null,
            cost,
          ]}
        />
        {repo.baseNote != null && <p className="mt-1 text-meta text-ui-mute">{repo.baseNote}</p>}
        {running && (
          <div className="mt-2">
            <RegenProgressBar active label={`Building ${repo.fullName}`} value={storyBuildProgressPct(progress)} timeConstantSec={90} />
            <p className="mt-1 text-meta text-ui-mute">{progress != null ? STORY_BUILD_PHASE_LABEL[progress.phase] : STORY_BUILD_REPO_STATUS_WORDS[repo.status]}</p>
            {progress?.recentActivity != null && progress.recentActivity.length > 0 && (
              <pre className="mt-1 max-h-32 overflow-auto rounded-ui bg-ui-raise p-2 text-meta leading-relaxed text-ui-mute">
                {progress.recentActivity.slice(-8).join('\n')}
              </pre>
            )}
          </div>
        )}
        {repo.status === 'queued' && <p className="mt-1 text-meta text-ui-mute">Waits for the repositories before it.</p>}
        {repo.error != null && (repo.status === 'failed' || repo.status === 'cancelled') && (
          <p className="mt-2 rounded-ui bg-ui-raise p-2 text-meta text-ui-danger">{repo.error}</p>
        )}
        {repo.summary != null && <p className="mt-2 max-w-3xl text-body text-ui-ink">{repo.summary}</p>}
        {(repo.status === 'ready' || repo.status === 'pushed' || repo.changeReport != null) && (
          <div className="text-meta">
            <ChangeReportSections
              report={repo.changeReport}
              filesChanged={repo.filesChanged}
              by={by}
              refsInfo={<p>Each tag is a criterion or ask from the story. It scrolls to it under Already done.</p>}
              renderRef={(r) => (
                <button
                  key={r}
                  type="button"
                  className={`${CHANGE_REPORT_CHIP} hover:bg-ui-hover`}
                  onClick={() => document.getElementById(storyBuildRefAnchor(r))?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
                >
                  {r}
                </button>
              )}
            />
          </div>
        )}
        <ChecksReport checks={repo.checks} />
        {repo.hasPatch && (
          <div className="mt-2">
            <button
              type="button"
              data-testid="story-build-diff-toggle"
              className="hit inline-flex items-center gap-1 text-meta text-ui-mute hover:text-ui-ink"
              aria-expanded={diffOpen}
              onClick={() => setDiffOpen((v) => !v)}
            >
              <ChevronIcon dir={diffOpen ? 'down' : 'right'} />
              Diff
            </button>
            {diffOpen && <RepoDiff build={build} repo={repo} />}
          </div>
        )}
        {(canPushRepo(repo) || canRetryRepo(build, repo)) && (
          <div className="mt-3 flex flex-wrap items-center gap-2" data-noactivate>
            {canPushRepo(repo) && (
              <Button
                variant="primary"
                size="sm"
                icon={<PullRequestIcon size={12} />}
                disabled={busy}
                data-story-build-action={`push-${repo.repoId}`}
                onClick={onPush}
              >
                {draft ? 'Push as draft' : 'Push'}
              </Button>
            )}
            {canPushRepo(repo) && <ChecksStatus checks={repo.checks} />}
            {canPushRepo(repo) && !repo.checks?.ran && <span className="text-meta text-ui-mute">Not built or tested here.</span>}
            {canRetryRepo(build, repo) && (
              <AiRunGate kind="story_build" meter={false} followUp provider={retryProvider}>
                <Button size="sm" data-ai-run disabled={busy} onClick={() => retry.mutate({ id: build.id, repoId: repo.repoId })}>
                  Retry
                </Button>
              </AiRunGate>
            )}
          </div>
        )}
        {(pushError ?? repo.pushError) != null && <p className="mt-1 text-meta text-ui-danger">{pushError ?? repo.pushError}</p>}
        {retry.error != null && <p className="mt-1 text-meta text-ui-danger">{errorOf(retry.error)}</p>}
      </div>
    </PrCardFrame>
  );
}

/** The pushed pull request: opens its PR tab when Limn has synced it, else GitHub. Read on click only. */
function PushedPrLink({ repo, url }: { repo: StoryBuildRepo; url: string | null }): JSX.Element | null {
  const openPrDetailTab = usePinnedTabs((s) => s.openPrDetailTab);
  const [looking, setLooking] = useState(false);
  if (repo.pushedPrNumber == null) return null;
  const n = repo.pushedPrNumber;
  const open = async (): Promise<void> => {
    setLooking(true);
    try {
      const res = await api.resolvePrRefs([{ repo: repo.fullName, number: n }]);
      const hit = res.refs[0];
      if (hit?.prId != null) {
        openPrDetailTab({
          id: hit.prId,
          number: n,
          title: hit.title ?? repo.prTitle ?? `#${n}`,
          repoFullName: hit.repoFullName ?? repo.fullName,
          authorLogin: null,
          authorDisplayName: null,
          authorAvatarUrl: null,
        });
        return;
      }
      if (url != null) window.open(url, '_blank', 'noopener,noreferrer');
    } finally {
      setLooking(false);
    }
  };
  return (
    <span className="flex items-center gap-1.5">
      <button
        type="button"
        data-testid="story-build-pushed-pr"
        className={`${CARD_TONE_CHIP} bg-ui-raise text-ui-ink hover:bg-ui-hover`}
        aria-busy={looking || undefined}
        onClick={() => void open()}
      >
        <PullRequestIcon size={11} />#{n}
      </button>
      {url != null && (
        <a href={url} target="_blank" rel="noreferrer noopener" className="hit text-ui-mute hover:text-ui-ink" aria-label={`Open #${n} on GitHub`}>
          <ExternalLinkIcon size={11} />
        </a>
      )}
    </span>
  );
}

/** The stored patch, read when the reader opens it, drawn as AI Fix draws its changeset. */
function RepoDiff({ build, repo }: { build: StoryBuild; repo: StoryBuildRepo }): JSX.Element {
  const diff = useStoryBuildDiff(build.id, repo.repoId, true, repo.completedAt ?? '');
  const files = useMemo<DiffFile[]>(() => parseGitPatch(diff.data?.patch ?? null), [diff.data?.patch]);
  if (diff.isLoading) return <p className="mt-1 text-meta text-ui-mute">Loading the diff…</p>;
  if (diff.isError) return <p className="mt-1 text-meta text-ui-danger">Could not load the diff.</p>;
  if (files.length === 0) return <p className="mt-1 text-meta text-ui-mute">No files changed.</p>;
  return (
    <div data-testid="story-build-diff">
      <div className="mb-1 mt-2 flex items-center justify-between gap-3 text-meta text-ui-mute">
        <span>
          {files.length} file{files.length === 1 ? '' : 's'} changed
          {!repo.checks?.ran && ' · Not built or tested here.'}
        </span>
        <DiffWrapToggle />
      </div>
      <div className="overflow-hidden rounded-ui bg-ui-surface text-ui-ink">
        <FileDiffView files={files} />
      </div>
    </div>
  );
}
