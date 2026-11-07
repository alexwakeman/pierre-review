import { type StoryBuildCandidate } from '@pierre-review/shared';
import type { AgentContext } from '../../review/agent-context.js';
import type { StoryBuildTicketPr } from './inputs.js';

// THE BASE OF EACH REPOSITORY in a workspace session ("Implement story", docs/STORY-BUILD.md § Bases and
// stacking; owner decision 1). The session clones EVERY workspace repository; this decides where each
// one starts:
//
//   an OPEN ticket PR in that repository that is the READER'S OWN ⇒ stack on it (base = its head branch at
//   its head; the new PR targets that branch) — unless GitHub says it was opened from a FORK (one live
//   read, `unstackablePrs`): its branch is not in this repository, so the default branch, said in one
//   line. Someone else's open PR ⇒ the default branch, said in one line (`baseNote`). Otherwise the
//   default branch. The default branch's sha is resolved when the clone is prepared, so `baseSha` is ''
//   until then.

/**
 * The base of one candidate (pure; owner decision 1). `defaultBranch` null ⇒ the remote's HEAD.
 * `unstackable` names the reader's open PRs that must NOT be stacked on, with the one-line reason: a PR
 * opened from a FORK (its head branch exists only on the fork, so a new PR here could not target it), or
 * one whose head repository could not be checked (`unstackablePrs` reads GitHub once per such PR).
 */
export function baseFor(
  repo: { id: number; defaultBranch: string | null },
  prs: readonly StoryBuildTicketPr[],
  unstackable: ReadonlyMap<number, 'fork' | 'unknown'> = new Map(),
): Pick<StoryBuildCandidate, 'baseRef' | 'baseSha' | 'stackedOnPrId' | 'stackedOnPrNumber' | 'baseNote'> {
  const open = prs.filter((p) => p.repoId === repo.id && p.state === 'open');
  const stackable = (p: StoryBuildTicketPr): boolean => p.byReader && p.headRefName != null && p.headRefName !== '' && p.headSha !== '';
  const mine = open.filter((p) => stackable(p) && !unstackable.has(p.prId)).sort((a, b) => b.number - a.number)[0];
  const defaultRef = repo.defaultBranch ?? 'HEAD';
  const defaultName = repo.defaultBranch ?? 'the default branch';
  if (mine != null) {
    return {
      baseRef: mine.headRefName!,
      baseSha: mine.headSha,
      stackedOnPrId: mine.prId,
      stackedOnPrNumber: mine.number,
      baseNote: `Builds on your open PR #${mine.number}; the new PR targets its branch.`,
    };
  }
  const skipped = open.filter((p) => stackable(p) && unstackable.has(p.prId)).sort((a, b) => b.number - a.number)[0];
  const other = [...open].sort((a, b) => b.number - a.number)[0];
  const note =
    skipped != null
      ? unstackable.get(skipped.prId) === 'fork'
        ? `Your #${skipped.number} is from a fork, so this builds from ${defaultName}.`
        : `Couldn't check your #${skipped.number} on GitHub, so this builds from ${defaultName}.`
      : other != null
        ? `#${other.number} on this ticket is someone else's, so this builds from ${defaultName}.`
        : null;
  return { baseRef: defaultRef, baseSha: '', stackedOnPrId: null, stackedOnPrNumber: null, baseNote: note };
}

/**
 * The reader's open PRs a candidate would stack on that must not be: ONE live read per PR (the PR's head
 * repository is not synced), through the existing `fetchPrHeadInfo`. A fork ⇒ 'fork'; a failed read ⇒
 * 'unknown' (the default branch is the safe base). No GitHub seam (a test context) ⇒ nothing is checked.
 */
export async function unstackablePrs(
  ctx: AgentContext,
  accountId: number,
  repos: ReadonlyArray<{ id: number; owner: string; name: string; defaultBranch: string | null }>,
  prs: readonly StoryBuildTicketPr[],
): Promise<Map<number, 'fork' | 'unknown'>> {
  const out = new Map<number, 'fork' | 'unknown'>();
  const fetch = ctx.github?.fetchPrHeadInfo;
  if (typeof fetch !== 'function') return out;
  for (const repo of repos) {
    // Each candidate's stacked PR, re-picked until it is one GitHub says is not a fork.
    for (;;) {
      const base = baseFor(repo, prs, out);
      if (base.stackedOnPrId == null || base.stackedOnPrNumber == null) break;
      try {
        const info = await fetch.call(ctx.github, accountId, repo.owner, repo.name, base.stackedOnPrNumber);
        if (!info.isFork) break;
        out.set(base.stackedOnPrId, 'fork');
      } catch (err) {
        ctx.log.warn({ err }, 'story build: checking a stacked PR failed');
        out.set(base.stackedOnPrId, 'unknown');
      }
    }
  }
  return out;
}
