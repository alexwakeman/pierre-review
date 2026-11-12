// THE REVIEW LOOP'S TARGETS (docs/STORY-BUILD.md § The review loop). A TARGET is one branch that becomes one
// pull request: a planned PR of a plan-first build (`story_build_prs`, in plan order — a stack in its
// repository), else an included repository of a one-patch build (`story_build_repos`, in build order).
import type { StoryBuildLoopTargetKind } from '@pierre-review/shared';
import type { AgentContext } from '../../../review/agent-context.js';
import { listStoryBuildRepoRows, storyBuildRepoNames, type StoryBuildRepoRow } from '../persist.js';
import { listPlannedPrRows, type StoryBuildPrRow } from '../plan-persist.js';
import { previousInRepo } from '../push-stack.js';

export interface LoopTarget {
  kind: StoryBuildLoopTargetKind;
  id: number;
  repoId: number;
  owner: string;
  name: string;
  fullName: string;
  /** A planned PR's key ('PR2'); null for a repository. */
  key: string | null;
  title: string | null;
  /** The branch the first push uses (the ticket key, or the plan's `-2`, `-3`). */
  plannedBranch: string;
  loopBranch: string | null;
  loopPushedSha: string | null;
  loopPushedTree: string | null;
  loopPushedAt: Date | null;
  loopEnded: 'pr_opened' | 'manual_push' | 'stopped' | null;
  /** The repository's base (PR 1 of a stack and a repository target start there). */
  baseRef: string;
  baseSha: string;
  /** The stored patch (a repository: on its base; a planned PR: on the PR before it). */
  patch: string | null;
  /** A planned PR's host-verified tree; null for a repository (computed from the patch). */
  treeSha: string | null;
  /** A planned PR: the one before it in its repository (it stacks on that PR's branch). */
  prevId: number | null;
  stackedOnPrId: number | null;
  summary: string | null;
  commitMessage: string | null;
  contains: string | null;
  status: string;
  pushedPrNumber: number | null;
  pushedPrUrl: string | null;
  pushError: string | null;
  pushErrorCode: string | null;
  repoRow: StoryBuildRepoRow | null;
  prRow: StoryBuildPrRow | null;
}

/** A target still in the loop: not ended (opened, pushed by hand, or stopped). */
export const isLive = (t: Pick<LoopTarget, 'loopEnded'>): boolean => t.loopEnded == null;

/**
 * The build's targets, ordered (plan order / build order). A target with nothing to push is left out —
 * a planned PR with no changes, a repository that is not included or has no patch and was never pushed by
 * the loop.
 */
export async function loopTargets(ctx: AgentContext, accountId: number, buildId: number): Promise<LoopTarget[]> {
  const repos = await listStoryBuildRepoRows(ctx, accountId, buildId);
  const prs = await listPlannedPrRows(ctx, accountId, buildId);
  const names = await storyBuildRepoNames(ctx, accountId, [...repos.map((r) => r.repoId), ...prs.map((p) => p.repoId)]);
  const split = (repoId: number): { owner: string; name: string; fullName: string } => {
    const fullName = names.get(repoId) ?? `#${repoId}`;
    const [owner, name] = fullName.split('/');
    return { owner: owner ?? '', name: name ?? '', fullName };
  };
  if (prs.length > 0) {
    const out: LoopTarget[] = [];
    for (const p of prs) {
      if (p.status === 'empty') continue;
      if (!p.loopBranch && (p.status !== 'ready' || !p.patch)) continue;
      const repo = repos.find((r) => r.repoId === p.repoId) ?? null;
      const prev = previousInRepo(prs, p);
      out.push({
        kind: 'pr',
        id: p.id,
        repoId: p.repoId,
        ...split(p.repoId),
        key: p.prKey,
        title: p.title,
        plannedBranch: p.branch,
        loopBranch: p.loopBranch ?? null,
        loopPushedSha: p.loopPushedSha ?? null,
        loopPushedTree: p.loopPushedTree ?? null,
        loopPushedAt: p.loopPushedAt ?? null,
        loopEnded: (p.loopEnded as LoopTarget['loopEnded']) ?? null,
        baseRef: repo?.baseRef ?? 'HEAD',
        baseSha: repo?.baseSha ?? '',
        patch: p.patch ?? null,
        treeSha: p.treeSha ?? null,
        prevId: prev?.id ?? null,
        stackedOnPrId: repo?.stackedOnPrId ?? null,
        summary: p.summary ?? null,
        commitMessage: p.commitMessage ?? null,
        contains: p.contains,
        status: p.status,
        pushedPrNumber: p.pushedPrNumber ?? null,
        pushedPrUrl: p.pushedPrUrl ?? null,
        pushError: p.pushError ?? null,
        pushErrorCode: p.pushErrorCode ?? null,
        repoRow: repo,
        prRow: p,
      });
    }
    return out;
  }
  return repos
    .filter((r) => r.include && (r.loopBranch != null || (r.status === 'ready' && Boolean(r.patch))))
    .map((r) => ({
      kind: 'repo' as const,
      id: r.id,
      repoId: r.repoId,
      ...split(r.repoId),
      key: null,
      title: null,
      plannedBranch: (r.branch ?? '').trim(),
      loopBranch: r.loopBranch ?? null,
      loopPushedSha: r.loopPushedSha ?? null,
      loopPushedTree: r.loopPushedTree ?? null,
      loopPushedAt: r.loopPushedAt ?? null,
      loopEnded: (r.loopEnded as LoopTarget['loopEnded']) ?? null,
      baseRef: r.baseRef,
      baseSha: r.baseSha,
      patch: r.patch ?? null,
      treeSha: null,
      prevId: null,
      stackedOnPrId: r.stackedOnPrId ?? null,
      summary: r.summary ?? null,
      commitMessage: r.commitMessage ?? null,
      contains: null,
      status: r.status,
      pushedPrNumber: r.pushedPrNumber ?? null,
      pushedPrUrl: r.pushedPrUrl ?? null,
      pushError: r.pushError ?? null,
      pushErrorCode: r.pushErrorCode ?? null,
      repoRow: r,
      prRow: null,
    }));
}

/** The diff base of a target's review: the repository base, or (a stacked PR) the PR before it's pushed head. */
export function reviewBaseOf(t: LoopTarget, all: readonly LoopTarget[]): string {
  if (t.prevId != null) {
    const prev = all.find((x) => x.kind === 'pr' && x.id === t.prevId);
    if (prev?.loopPushedSha) return prev.loopPushedSha;
  }
  return t.baseSha;
}
