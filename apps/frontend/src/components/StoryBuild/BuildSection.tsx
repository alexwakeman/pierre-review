import { useId, useMemo, useState } from 'react';
import { useIsMutating } from '@tanstack/react-query';
import {
  aiRunProviderName,
  type StoryBuild,
  type StoryBuildRepo,
  type StoryBuildRepoPushResult,
} from '@pierre-review/shared';
import { api, ApiError } from '../../api/client.js';
import { useRunCostText } from '../../hooks/useAiBudget.js';
import { storyBuildMutationKey, useStoryBuildDiff, useStoryBuildPush } from '../../hooks/useStoryBuild.js';
import { parseGitPatch } from '../../lib/diff.js';
import { branchExistsFor, buildBranchNames, canPushRepo, loopRunning, pushButtonWords, STORY_BUILD_REPO_STATUS_WORDS, storyBuildErrorText, storyBuildRefAnchor } from '../../lib/storyBuild.js';
import { safeExternalUrl } from '../../lib/ui.js';
import { usePinnedTabs } from '../../store/pinnedTabs.js';
import { PrCardChips, PrCardFrame, PrCardMeta, PrCardTitle, CARD_NEUTRAL_CHIP, CARD_RED_CHIP, CARD_TONE_CHIP } from '../Activity/PrCardShell.js';
import { ChangeReportSections, CHANGE_REPORT_CHIP } from '../AiFix/ChangeReport.js';
import { ChecksReport, ChecksStatus } from '../AiFix/RunTests.js';
import { AiRunLabel } from '../AiRunLabel.js';
import { DiffWrapToggle, FileDiffView, type DiffFile } from '../diff/FileDiffView.js';
import { ChevronIcon, ExternalLinkIcon, PullRequestIcon, WarningIcon } from '../Icons.js';
import { InfoButton } from '../InfoModal.js';
import { Button } from '../ui/Button.js';
import { RenameBranch } from './RenameBranch.js';
import { HOTFIX_DIFF_LABEL, hotfixDiffTargets, hotfixMovedLine, hotfixPortView, hotfixPushWords } from '../../lib/hotfix.js';

// THE CHANGES: one card per repository with stored work, in build order (the One PR card shell look).
// Each card: its status, what the agent says it changed (`ChangeReportSections`; the refs jump to the
// criterion in the Ticket panel), the diff — fetched only when opened, drawn exactly as AI Fix draws one —
// and Push. Pushed: the new pull request, which opens its PR tab. Nothing here pushes without the reader
// pressing Push (the opt-in automatic push runs on the host: auto-push.ts). After BRANCH_EXISTS (the
// press's code, or the row's stored one after a reload or an automatic push) Push becomes a new branch
// name + Push (`RenameBranch`). A row of the removed plan/build flow (no `session`) shows the same card, plus the test
// run it stored (`ChecksReport`) and "Not built or tested here." when it ran none.

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
  draft,
}: {
  build: StoryBuild;
  /** Open new pull requests as drafts (owner decision 2: the default). */
  draft: boolean;
}): JSX.Element {
  // A WORKSPACE SESSION's repositories (docs/SANDBOX.md § Sessions): the agent ran the tests itself in
  // the sandbox, so no "Not built or tested here".
  const session = build.session != null;
  const push = useStoryBuildPush(build.workspaceId, build.ident);
  const results = new Map((push.data?.results ?? []).map((r) => [r.repoId, r] as const));
  const repos = build.repos.filter((r) => r.include || r.status === 'pushed').sort((a, b) => a.order - b.order);
  // The names the rename avoids: the build's own branches and every name this tab already tried.
  const tried = push.variables?.branch;
  const taken = [...buildBranchNames(build), ...(tried != null ? [tried] : [])];
  return (
    <ul data-testid="story-build-repos" className="space-y-2">
      {repos.map((r) => (
        <BuildRepoCard
          key={r.repoId}
          build={build}
          repo={r}
          draft={draft}
          session={session}
          taken={taken}
          branchExists={
            // A refused NEW name (git's rules, a protected branch) keeps the field: Push would retry the old one.
            (tried != null && push.variables?.repoId === r.repoId && results.get(r.repoId)?.outcome !== 'pushed') ||
            branchExistsFor(results.get(r.repoId)?.code, r.pushErrorCode)
          }
          onPush={(branch) => push.mutate({ id: build.id, repoId: r.repoId, draft, ...(branch != null ? { branch } : {}) })}
          pushError={pushFailure(results.get(r.repoId)) ?? (push.variables?.repoId === r.repoId ? errorOf(push.error) : null)}
        />
      ))}
    </ul>
  );
}

function BuildRepoCard({
  build,
  repo,
  draft,
  session,
  taken,
  branchExists,
  onPush,
  pushError,
}: {
  build: StoryBuild;
  repo: StoryBuildRepo;
  draft: boolean;
  session: boolean;
  taken: readonly string[];
  /** The last push said the branch exists on GitHub: offer a new name instead of Push. */
  branchExists: boolean;
  /** `branch`: the new name (the rename); absent, the row's branch. */
  onPush: (branch?: string) => void;
  pushError: string | null;
}): JSX.Element {
  const titleId = useId();
  const busy = useIsMutating({ mutationKey: storyBuildMutationKey(build.ident) }) > 0;
  // A HOTFIX build (docs/STORY-BUILD.md § Hotfix builds): two diffs, two pull requests, no rename.
  const hf = repo.hotfix ?? null;
  const [mainDiffOpen, setMainDiffOpen] = useState(false);
  const movedLine = hotfixMovedLine(hf?.branch);
  const port = hotfixPortView(repo);
  const mainUrl = safeExternalUrl(hf?.mainPushedPrUrl) ?? null;
  // THE REVIEW LOOP pushes by itself while it runs: Push hides (never disabled) until it pauses or ends.
  const loopBusy = loopRunning(build);
  const costText = useRunCostText();
  const [diffOpen, setDiffOpen] = useState(false);
  const by = aiRunProviderName(repo.model != null ? repo : build);
  const cost = costText(repo.costUsd, repo.provider ?? build.provider ?? null);
  const pushedUrl = safeExternalUrl(repo.pushedPrUrl) ?? null;
  const statusTone =
    repo.status === 'failed' ? CARD_RED_CHIP : repo.status === 'ready' || repo.status === 'pushed' ? `${CARD_TONE_CHIP} bg-ui-raise text-ui-ink` : CARD_NEUTRAL_CHIP;
  return (
    <PrCardFrame labelledBy={titleId}>
      <div data-testid="story-build-repo" data-repo={repo.fullName} data-status={repo.status}>
        <PrCardTitle
          id={titleId}
          end={
            hf != null ? (
              <span className="flex items-center gap-2">
                {repo.pushedPrNumber != null && <PushedPrLink repo={repo} url={pushedUrl} />}
                {hf.mainPushedPrNumber != null && <PushedPrLink repo={repo} number={hf.mainPushedPrNumber} url={mainUrl} />}
              </span>
            ) : repo.status === 'pushed' ? (
              <PushedPrLink repo={repo} url={pushedUrl} />
            ) : null
          }
        >
          {repo.fullName}
        </PrCardTitle>
        <PrCardChips>
          <span className={statusTone}>{STORY_BUILD_REPO_STATUS_WORDS[repo.status]}</span>
        </PrCardChips>
        <PrCardMeta
          parts={[
            repo.branch != null ? <span key="b" className="font-mono">{repo.pushedBranch ?? repo.branch}</span> : null,
            hf != null && hf.readOnly ? (
              <span key="base">read only: no release yet</span>
            ) : hf != null && hf.tagName != null ? (
              <span key="base">
                from the release <span className="font-mono">{hf.tagName}</span> and <span className="font-mono">{hf.mainBaseRef ?? 'the default branch'}</span>
              </span>
            ) : (
              <span key="base">
                from <span className="font-mono">{repo.baseRef}</span>
              </span>
            ),
            repo.filesChanged.length > 0 ? `${repo.filesChanged.length} file${repo.filesChanged.length === 1 ? '' : 's'} changed` : null,
            repo.model != null ? <AiRunLabel key="m" provider={repo.provider} model={repo.model} /> : null,
            cost,
          ]}
        />
        {repo.baseNote != null && <p className="mt-1 text-meta text-ui-mute">{repo.baseNote}</p>}
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
              refsInfo={<p>Each tag is a criterion from the story. It scrolls to it in the Ticket panel.</p>}
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
        {hf == null && repo.hasPatch && (
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
            {diffOpen && <RepoDiff build={build} repo={repo} session={session} />}
          </div>
        )}
        {hf != null &&
          hotfixDiffTargets(repo).map((t) => {
            const open = t === 'main' ? mainDiffOpen : diffOpen;
            return (
              <div key={t} className="mt-2" data-testid={`story-build-hotfix-diff-${t}`}>
                <button
                  type="button"
                  data-testid="story-build-diff-toggle"
                  className="hit inline-flex items-center gap-1 text-meta text-ui-mute hover:text-ui-ink"
                  aria-expanded={open}
                  onClick={() => (t === 'main' ? setMainDiffOpen((v) => !v) : setDiffOpen((v) => !v))}
                >
                  <ChevronIcon dir={open ? 'down' : 'right'} />
                  {HOTFIX_DIFF_LABEL[t]}
                  {t === 'release' && hf.tagName != null && <span className="font-mono">({hf.tagName})</span>}
                  {t === 'main' && <span className="font-mono">({hf.mainBaseRef ?? 'default branch'})</span>}
                </button>
                {open && <RepoDiff build={build} repo={repo} session={session} target={t} />}
              </div>
            );
          })}
        {hf?.mainError != null && <p className="mt-1 text-meta text-ui-danger">{hf.mainError}</p>}
        {port != null && (
          <div data-testid="story-build-hotfix-port" data-outcome={port.outcome ?? 'none'} className="mt-2 text-meta">
            <div className="flex items-start gap-1.5">
              <span className={port.outcome == null ? 'text-ui-mute' : 'text-ui-ink'}>{port.line}</span>
              <InfoButton title="The port to main">
                <p>The agent says, for each repository, whether the fix on the release was applied to main as it is, adapted for main, or not needed on main.</p>
                <p className="mt-2">This is the agent's own report. Ensemble checks it against the two diffs and says when they disagree. It does not use test results: tests may not apply to both.</p>
                <p className="mt-2">When main does not need the fix, Push opens only the pull request into the hotfix branch.</p>
              </InfoButton>
            </div>
            {port.files != null && <p className="mt-0.5 text-ui-mute">{port.files}</p>}
            {/* Beside Push while it shows (below); here once it does not. */}
            {port.flag != null && !(canPushRepo(repo) && !loopBusy) && (
              <p className="mt-0.5 inline-flex items-center gap-1 text-ui-warn">
                <WarningIcon size={12} />
                {port.flag}
              </p>
            )}
          </div>
        )}
        {movedLine != null && (
          <p data-testid="story-build-hotfix-moved" className="mt-2 text-meta text-ui-mute">
            {movedLine}
          </p>
        )}
        {hf == null && canPushRepo(repo) && !loopBusy && branchExists && (
          <RenameBranch
            branch={repo.branch ?? ''}
            taken={taken}
            draft={draft}
            disabled={busy}
            actionId={`push-renamed-${repo.repoId}`}
            onPush={(branch) => onPush(branch)}
          />
        )}
        {canPushRepo(repo) && !loopBusy && (hf != null || !branchExists) && (
          <div className="mt-3 flex flex-wrap items-center gap-2" data-noactivate>
            <Button
              variant="primary"
              size="sm"
              icon={<PullRequestIcon size={12} />}
              disabled={busy}
              data-story-build-action={`push-${repo.repoId}`}
              onClick={() => onPush()}
            >
              {hf != null ? hotfixPushWords(repo, draft) : pushButtonWords(build, 'repo', repo.id, draft)}
            </Button>
            {port?.flag != null && (
              <span data-testid="story-build-hotfix-port-flag" className="inline-flex items-center gap-1 text-meta text-ui-warn">
                <WarningIcon size={12} />
                {port.flag}
              </span>
            )}
            <ChecksStatus checks={repo.checks} />
            {!session && !repo.checks?.ran && <span className="text-meta text-ui-mute">Not built or tested here.</span>}
          </div>
        )}
        {(pushError ?? repo.pushError) != null && <p className="mt-1 text-meta text-ui-danger">{pushError ?? repo.pushError}</p>}
        {hf?.mainPushError != null && pushError == null && <p className="mt-1 text-meta text-ui-danger">{hf.mainPushError}</p>}
      </div>
    </PrCardFrame>
  );
}

/** The pushed pull request: opens its PR tab when Limn has synced it, else GitHub. Read on click only. */
function PushedPrLink({ repo, url, number }: { repo: StoryBuildRepo; url: string | null; number?: number }): JSX.Element | null {
  const openPrDetailTab = usePinnedTabs((s) => s.openPrDetailTab);
  const [looking, setLooking] = useState(false);
  const n = number ?? repo.pushedPrNumber;
  if (n == null) return null;
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
    } catch {
      // The lookup failed: GitHub still has the pull request.
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
function RepoDiff({ build, repo, session, target = 'release' }: { build: StoryBuild; repo: StoryBuildRepo; session: boolean; target?: 'release' | 'main' }): JSX.Element {
  const diff = useStoryBuildDiff(build.id, repo.repoId, true, repo.completedAt ?? '', target);
  const files = useMemo<DiffFile[]>(() => parseGitPatch(diff.data?.patch ?? null), [diff.data?.patch]);
  if (diff.isLoading) return <p className="mt-1 text-meta text-ui-mute">Loading the diff…</p>;
  if (diff.isError) return <p className="mt-1 text-meta text-ui-danger">Could not load the diff.</p>;
  if (files.length === 0) return <p className="mt-1 text-meta text-ui-mute">No files changed.</p>;
  return (
    <div data-testid="story-build-diff">
      <div className="mb-1 mt-2 flex items-center justify-between gap-3 text-meta text-ui-mute">
        <span>
          {files.length} file{files.length === 1 ? '' : 's'} changed
          {!session && !repo.checks?.ran && ' · Not built or tested here.'}
        </span>
        <DiffWrapToggle />
      </div>
      <div className="overflow-hidden rounded-ui bg-ui-surface text-ui-ink">
        <FileDiffView files={files} />
      </div>
    </div>
  );
}
