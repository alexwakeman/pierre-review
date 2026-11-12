import { useId, useMemo, useState } from 'react';
import { useIsMutating } from '@tanstack/react-query';
import type { StoryBuild, StoryBuildPr, StoryBuildPrPushResult, StoryBuildSession } from '@pierre-review/shared';
import { api, ApiError } from '../../api/client.js';
import { storyBuildMutationKey, useStoryBuildPrDiff, useStoryBuildPrPush } from '../../hooks/useStoryBuild.js';
import {
  PR_CHECK_WORDS,
  PR_REPORTED_WORDS,
  STORY_BUILD_PR_STATUS_WORDS,
  previousInRepo,
  prPushState,
  prsByRepo,
  prsInOrder,
  pushAllPrCount,
} from '../../lib/buildPlan.js';
import { parseGitPatch } from '../../lib/diff.js';
import { REVIEW_SUBHEAD } from '../../lib/reviewStyles.js';
import { sessionTurnRunning } from '../../lib/sandboxSession.js';
import { branchExistsFor, buildBranchNames, loopRunning, pushButtonWords, storyBuildErrorText, storyBuildRefAnchor } from '../../lib/storyBuild.js';
import { safeExternalUrl } from '../../lib/ui.js';
import { usePinnedTabs } from '../../store/pinnedTabs.js';
import { PrCardChips, PrCardFrame, PrCardMeta, PrCardTitle, CARD_NEUTRAL_CHIP, CARD_RED_CHIP, CARD_TONE_CHIP } from '../Activity/PrCardShell.js';
import { CHANGE_REPORT_CHIP } from '../AiFix/ChangeReport.js';
import { DiffWrapToggle, FileDiffView, type DiffFile } from '../diff/FileDiffView.js';
import { ChevronIcon, ExternalLinkIcon, PullRequestIcon } from '../Icons.js';
import { InfoButton } from '../InfoModal.js';
import { Button } from '../ui/Button.js';
import { CheckboxBox } from '../ui/FormControls.js';
import { RenameBranch } from './RenameBranch.js';

// THE STACK VIEW ("Implement, plan first"; docs/STORY-BUILD.md § Push, docs/FRONTEND.md § The build tab):
// after Approve the build follows the approved PR stack, so the changes are shown PER PLANNED PULL
// REQUEST, in plan order, grouped by repository. Each card: its status, the criteria it covers, what the
// agent says about it (the build report: a self-report, never a gate), the diff — fetched only when
// opened — and Push. Push shows only once the PRs it builds on are pushed (lib/buildPlan.ts
// `prPushState`; the server checks again). "Push all" pushes every ready one in plan order. Draft by
// default. A session without planned PRs (before plan first) keeps BuildSection's per-repository cards.
// After BRANCH_EXISTS, that PR's Push becomes a new branch name + Push (`RenameBranch`); the PRs stacked
// on it then build on the new branch (the host reads the pushed branch).

function errorOf(err: unknown): string | null {
  if (err == null) return null;
  return storyBuildErrorText(err instanceof ApiError ? err : { message: (err as Error).message });
}

function resultLine(r: StoryBuildPrPushResult | undefined): string | null {
  if (r == null || r.outcome === 'pushed') return null;
  return r.error ?? (r.outcome === 'skipped' ? 'Not pushed.' : 'The push failed.');
}

export function StackView({ build, session, draft, setDraft }: { build: StoryBuild; session: StoryBuildSession; draft: boolean; setDraft: (v: boolean) => void }): JSX.Element {
  const prs = useMemo(() => prsInOrder(build.prs ?? []), [build.prs]);
  const push = useStoryBuildPrPush(build.workspaceId, build.ident);
  const busy = useIsMutating({ mutationKey: storyBuildMutationKey(build.ident) }) > 0;
  // THE REVIEW LOOP pushes by itself while it runs: Push and Push all hide until it pauses or ends.
  const running = sessionTurnRunning(session);
  const loopBusy = loopRunning(build);
  const results = new Map((push.data?.prs ?? []).map((r) => [r.prId, r] as const));
  const ready = pushAllPrCount(prs);
  const groups = prsByRepo(prs);
  const anyReady = ready > 0;
  const allErr = push.variables?.prId == null ? errorOf(push.error) : null;
  const tried = push.variables?.branch;
  const taken = [...buildBranchNames(build), ...(tried != null ? [tried] : [])];
  return (
    <div data-testid="story-build-stack">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-meta text-ui-mute">
          {prs.length} pull request{prs.length === 1 ? '' : 's'}, in order
        </span>
        <InfoButton title="Pushing a stack">
          <p>Push opens each pull request on GitHub. In one repository, each one is based on the branch of the one before it, so push them in order.</p>
          <p className="mt-2">Each description names the stack, the criteria it covers and your answers on the story.</p>
        </InfoButton>
        {anyReady && !loopBusy && (
          <span className="ml-auto flex flex-wrap items-center gap-2" data-noactivate>
            <label className="flex cursor-pointer items-center gap-1.5 text-meta text-ui-ink" title="Open each new pull request as a draft">
              <CheckboxBox checked={draft} onChange={(e) => setDraft(e.target.checked)} />
              Draft
            </label>
            {ready >= 2 && (
              <Button
                variant="primary"
                size="sm"
                icon={<PullRequestIcon size={12} />}
                disabled={busy || running}
                data-story-build-action="push-all"
                onClick={() => push.mutate({ id: build.id, prId: null, draft })}
              >
                Push all ({ready})
              </Button>
            )}
          </span>
        )}
      </div>
      {allErr != null && <p className="mb-2 text-meta text-ui-danger">{allErr}</p>}
      <div className="space-y-3">
        {groups.map((g) => (
          <div key={g.repoId} data-testid="story-build-stack-repo" data-repo={g.fullName}>
            <h4 className={`${REVIEW_SUBHEAD} mb-1 break-all font-mono`}>{g.fullName}</h4>
            <ul className="space-y-2">
              {g.prs.map((p) => (
                <PrCard
                  key={p.id}
                  build={build}
                  pr={p}
                  prs={prs}
                  total={prs.length}
                  draft={draft}
                  disabled={busy || running}
                  hidePush={loopBusy}
                  taken={taken}
                  branchExists={
                    // A refused NEW name keeps the field: Push would retry the old one.
                    (tried != null && push.variables?.prId === p.id && results.get(p.id)?.outcome !== 'pushed') ||
                    branchExistsFor(results.get(p.id)?.code, p.pushErrorCode)
                  }
                  onPush={(branch) => push.mutate({ id: build.id, prId: p.id, draft, ...(branch != null ? { branch } : {}) })}
                  pushError={resultLine(results.get(p.id)) ?? (push.variables?.prId === p.id ? errorOf(push.error) : null)}
                />
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

function PrCard({
  build,
  pr,
  prs,
  total,
  draft,
  disabled,
  hidePush = false,
  taken,
  branchExists,
  onPush,
  pushError,
}: {
  build: StoryBuild;
  pr: StoryBuildPr;
  /** The review loop is running: no Push (it pushes by itself). */
  hidePush?: boolean;
  prs: readonly StoryBuildPr[];
  total: number;
  draft: boolean;
  disabled: boolean;
  taken: readonly string[];
  /** The last push said the branch exists on GitHub: offer a new name instead of Push. */
  branchExists: boolean;
  /** `branch`: the new name (the rename); absent, the planned branch. */
  onPush: (branch?: string) => void;
  pushError: string | null;
}): JSX.Element {
  const titleId = useId();
  const [diffOpen, setDiffOpen] = useState(false);
  const prev = previousInRepo(pr, prs);
  const state = prPushState(pr, prs);
  const pushedUrl = safeExternalUrl(pr.pushedPrUrl) ?? null;
  const tone = pr.status === 'failed' ? CARD_RED_CHIP : pr.status === 'ready' || pr.status === 'pushed' ? `${CARD_TONE_CHIP} bg-ui-raise text-ui-ink` : CARD_NEUTRAL_CHIP;
  const prevWords =
    prev == null ? null : prev.pushedPrNumber != null ? `Builds on #${prev.pushedPrNumber} (${prev.key})` : `Builds on ${prev.key}`;
  return (
    <PrCardFrame labelledBy={titleId}>
      <div data-testid="story-build-pr" data-key={pr.key} data-status={pr.status}>
        <PrCardTitle id={titleId} end={pr.status === 'pushed' ? <PushedLink pr={pr} url={pushedUrl} /> : null}>
          <span className="font-mono text-ui-mute">{pr.key}</span> · {pr.title}
        </PrCardTitle>
        <PrCardChips>
          <span className={tone}>{STORY_BUILD_PR_STATUS_WORDS[pr.status]}</span>
          {pr.criteria.map((c) => (
            <button
              key={c}
              type="button"
              className={`${CHANGE_REPORT_CHIP} hover:bg-ui-hover`}
              onClick={() => document.getElementById(storyBuildRefAnchor(c))?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
            >
              {c}
            </button>
          ))}
        </PrCardChips>
        <PrCardMeta
          parts={[
            `${pr.position + 1} of ${total}`,
            <span key="b" className="font-mono">
              {pr.pushedBranch ?? pr.branch}
            </span>,
            prevWords,
            pr.stat != null ? `${pr.stat.files} file${pr.stat.files === 1 ? '' : 's'} · +${pr.stat.insertions} −${pr.stat.deletions}` : null,
          ]}
        />
        {pr.contains !== '' && <p className="mt-1.5 max-w-3xl break-words text-body text-ui-ink">{pr.contains}</p>}
        {pr.error != null && (pr.status === 'failed' || pr.status === 'empty') && (
          <p className={`mt-2 rounded-ui bg-ui-raise p-2 text-meta ${pr.status === 'failed' ? 'text-ui-danger' : 'text-ui-mute'}`}>{pr.error}</p>
        )}
        <AgentSays pr={pr} />
        {pr.stat != null && pr.status !== 'empty' && (
          <div className="mt-2">
            <button
              type="button"
              data-testid="story-build-pr-diff-toggle"
              className="hit inline-flex items-center gap-1 text-meta text-ui-mute hover:text-ui-ink"
              aria-expanded={diffOpen}
              onClick={() => setDiffOpen((v) => !v)}
            >
              <ChevronIcon dir={diffOpen ? 'down' : 'right'} />
              Diff
            </button>
            {diffOpen && <PrDiff build={build} pr={pr} />}
          </div>
        )}
        {pr.status === 'ready' && !hidePush && state.canPush && branchExists && (
          <RenameBranch branch={pr.branch} taken={taken} draft={draft} disabled={disabled} actionId={`push-pr-renamed-${pr.id}`} onPush={(b) => onPush(b)} />
        )}
        {pr.status === 'ready' && !hidePush && !(state.canPush && branchExists) && (
          <div className="mt-3 flex flex-wrap items-center gap-2" data-noactivate>
            {state.canPush ? (
              <Button variant="primary" size="sm" icon={<PullRequestIcon size={12} />} disabled={disabled} data-story-build-action={`push-pr-${pr.id}`} onClick={() => onPush()}>
                {pushButtonWords(build, 'pr', pr.id, draft)}
              </Button>
            ) : (
              <span data-testid="story-build-pr-wait" className="text-meta text-ui-mute">
                {state.reason}
              </span>
            )}
          </div>
        )}
        {(pushError ?? pr.pushError) != null && <p className="mt-1 text-meta text-ui-danger">{pushError ?? pr.pushError}</p>}
      </div>
    </PrCardFrame>
  );
}

/** The build report's words for this PR: "The agent says" (a self-report; Push never waits on it). */
function AgentSays({ pr }: { pr: StoryBuildPr }): JSX.Element | null {
  if (pr.summary == null && pr.checks == null && pr.reported == null) return null;
  return (
    <div data-testid="story-build-pr-report" className="mt-2 rounded-ui bg-ui-raise px-2.5 py-2 text-meta text-ui-ink">
      <div className="flex items-center gap-1.5">
        <span className="font-medium">The agent says</span>
        {pr.reported != null && <span className="text-ui-mute">· {PR_REPORTED_WORDS[pr.reported]}</span>}
      </div>
      {pr.summary != null && <p className="mt-1 whitespace-pre-wrap break-words text-body">{pr.summary}</p>}
      {pr.checks != null && pr.checks.length > 0 && (
        <ul className="mt-1.5 space-y-0.5">
          {pr.checks.map((c, i) => (
            <li key={i} className="flex flex-wrap items-baseline gap-x-2">
              <span className={c.result === 'failed' ? 'text-ui-danger' : c.result === 'passed' ? 'text-ui-success' : 'text-ui-mute'}>{PR_CHECK_WORDS[c.result]}</span>
              <span className="break-all font-mono">{c.command}</span>
              {c.note != null && <span className="text-ui-mute">{c.note}</span>}
            </li>
          ))}
        </ul>
      )}
      {pr.checks == null && <p className="mt-1 text-ui-mute">It did not say which checks it ran.</p>}
    </div>
  );
}

/** The planned PR's own patch (against the PR before it), read when the reader opens it. */
function PrDiff({ build, pr }: { build: StoryBuild; pr: StoryBuildPr }): JSX.Element {
  const key = pr.stat == null ? '' : `${pr.stat.commits}:${pr.stat.files}:${pr.stat.insertions}:${pr.stat.deletions}`;
  const diff = useStoryBuildPrDiff(build.id, pr.id, true, key);
  const files = useMemo<DiffFile[]>(() => parseGitPatch(diff.data?.patch ?? null), [diff.data?.patch]);
  if (diff.isLoading) return <p className="mt-1 text-meta text-ui-mute">Loading the diff…</p>;
  if (diff.isError) return <p className="mt-1 text-meta text-ui-danger">Could not load the diff.</p>;
  if (files.length === 0) return <p className="mt-1 text-meta text-ui-mute">No files changed.</p>;
  return (
    <div data-testid="story-build-pr-diff">
      <div className="mb-1 mt-2 flex items-center justify-between gap-3 text-meta text-ui-mute">
        <span>
          {files.length} file{files.length === 1 ? '' : 's'} changed
        </span>
        <DiffWrapToggle />
      </div>
      <div className="overflow-hidden rounded-ui bg-ui-surface text-ui-ink">
        <FileDiffView files={files} />
      </div>
    </div>
  );
}

/** The pushed pull request: opens its PR tab when Limn has synced it, else GitHub. Read on click only. */
function PushedLink({ pr, url }: { pr: StoryBuildPr; url: string | null }): JSX.Element | null {
  const openPrDetailTab = usePinnedTabs((s) => s.openPrDetailTab);
  const [looking, setLooking] = useState(false);
  if (pr.pushedPrNumber == null) return null;
  const n = pr.pushedPrNumber;
  const open = async (): Promise<void> => {
    setLooking(true);
    try {
      const hit = (await api.resolvePrRefs([{ repo: pr.fullName, number: n }])).refs[0];
      if (hit?.prId != null) {
        openPrDetailTab({
          id: hit.prId,
          number: n,
          title: hit.title ?? pr.title,
          repoFullName: hit.repoFullName ?? pr.fullName,
          authorLogin: null,
          authorDisplayName: null,
          authorAvatarUrl: null,
        });
        return;
      }
      if (url != null) window.open(url, '_blank', 'noopener,noreferrer');
    } catch {
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
